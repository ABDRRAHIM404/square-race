/* =============================================================
 * SQUARE RACE — game.js
 * Pure HTML5 Canvas + Vanilla JS. No external libraries, no image files.
 *
 * Contents:
 *   • Core engine: canvas/resize, mulberry32 PRNG, state machine,
 *     requestAnimationFrame loop (deltaTime), pointer input, camera
 *   • Web Audio engine (synth SFX + background hum, mute)
 *   • Track generation (seeded, snaking, connected segments)
 *   • Squares & movement (physics, wall/square collisions, boost/slow)
 *   • Obstacles (knife, gap, ball, boost pad, mud)
 *   • AI opponents (per-color personalities)
 *   • Screens: Title, Select (w/ personalities), Countdown, Race HUD, Results
 * ============================================================= */

(function () {
  'use strict';

  /* ---------------------------------------------------------
   * Canvas Setup
   * ------------------------------------------------------- */
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');

  // Logical pixel size (CSS pixels). We keep drawing in CSS pixels and
  // scale the backing store by devicePixelRatio for crispness.
  let viewW = window.innerWidth;
  let viewH = window.innerHeight;

  function resizeCanvas() {
    viewW = window.innerWidth;
    viewH = window.innerHeight;

    const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap DPR for perf
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = viewW + 'px';
    canvas.style.height = viewH + 'px';

    // Reset transform then scale so all drawing uses CSS-pixel coordinates.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', resizeCanvas);

  // Expose CSS-pixel dimensions through a tiny helper so the rest of the
  // code can use `view.w` / `view.h` instead of canvas.width (backing store).
  const view = {
    get w() { return viewW; },
    get h() { return viewH; }
  };

  // Small helper: trace a rounded rectangle path (caller does fill/stroke).
  // Falls back gracefully if the platform lacks ctx.roundRect.
  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, r);
      return;
    }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------------------------------------------------
   * Seeded PRNG — mulberry32
   * ------------------------------------------------------- */
  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Global seeded random — (re)initialized when a race starts.
  let rand = mulberry32(Date.now());

  /* ---------------------------------------------------------
   * Game State Machine
   * ------------------------------------------------------- */
  const STATE = {
    current: 'TITLE',        // TITLE | SELECT | COUNTDOWN | RACE | RESULTS
    selectedColor: null,     // 'yellow' | 'blue' | 'green' | 'red'
    winner: null,
    placements: [],          // finishing order e.g. ['red','blue','yellow','green']
    eliminatedOrder: [],     // colors in the order they were eliminated (earliest first)
    raceStartTime: 0,
    boostUsed: false
  };

  /* ---------------------------------------------------------
   * Unified Pointer Input (mouse + touch)
   * ------------------------------------------------------- */
  const Input = {
    tapX: 0,
    tapY: 0,
    tapped: false,

    init() {
      const onDown = (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect();
        this.tapX = clientX - rect.left;
        this.tapY = clientY - rect.top;
        this.tapped = true;
      };

      // Prefer Pointer Events; they cover mouse + touch + pen uniformly.
      if (window.PointerEvent) {
        canvas.addEventListener('pointerdown', (e) => {
          onDown(e.clientX, e.clientY);
        });
      } else {
        canvas.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY));
        canvas.addEventListener('touchstart', (e) => {
          if (e.touches && e.touches.length) {
            onDown(e.touches[0].clientX, e.touches[0].clientY);
          }
        }, { passive: false });
      }

      // Block context menu / gesture zoom on the canvas.
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    },

    consume() {
      this.tapped = false;
    }
  };
  Input.init();

  /* ---------------------------------------------------------
   * Camera
   * ------------------------------------------------------- */
  const Camera = {
    x: 0,
    y: 0,
    targetY: 0,

    reset() {
      this.x = 0;
      this.y = 0;
      this.targetY = 0;
    },

    update(deltaTime) {
      // Smoothly approach the target Y. Frame-rate independent lerp.
      const t = 1 - Math.pow(0.0001, deltaTime); // ~smooth follow
      this.y += (this.targetY - this.y) * t;
    },

    worldToScreen(wx, wy) {
      return {
        x: wx - this.x + view.w / 2,
        y: wy - this.y + view.h / 2
      };
    }
  };

  /* ---------------------------------------------------------
   * Audio — Web Audio API (Phase 9)
   * All sounds are synthesized; no audio files. A light background
   * "engine hum" plays during the race; SFX are short oscillator blips.
   * ------------------------------------------------------- */
  const GameAudio = {
    ctx: null,
    muted: false,
    master: null,
    bg: null,        // { osc, lfo, gain } while race music is running

    init() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          this.ctx = new AC();
          this.master = this.ctx.createGain();
          this.master.gain.value = 0.9;
          this.master.connect(this.ctx.destination);
        }
      } catch (e) {
        console.warn('Audio context unavailable:', e);
      }
    },

    unlock() {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },

    toggleMute() {
      this.muted = !this.muted;
      if (this.master) {
        this.master.gain.value = this.muted ? 0 : 0.9;
      }
    },

    // --- One-shot blip helper ---
    beep(freq, duration, type, vol, whenOffset) {
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime + (whenOffset || 0);
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(vol == null ? 0.12 : vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + duration);
      osc.connect(gain);
      gain.connect(this.master || this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    },

    // --- SFX ---
    playHit()   { this.beep(110, 0.16, 'sawtooth', 0.16); },
    playBoost() { this.beep(740, 0.10, 'square', 0.12); this.beep(1040, 0.14, 'square', 0.12, 0.06); },
    playElim()  { this.beep(240, 0.05, 'square', 0.13); this.beep(90, 0.32, 'sawtooth', 0.16, 0.05); },
    playFinish() {
      [523, 659, 784, 1047].forEach((f, i) => this.beep(f, 0.22, 'square', 0.13, i * 0.11));
    },
    playCountBeep(high) { this.beep(high ? 880 : 440, 0.14, 'square', 0.14); },
    playSelect() { this.beep(620, 0.08, 'triangle', 0.10); },

    // --- Background race hum (subtle, looping via LFO-modulated osc) ---
    startMusic() {
      if (!this.ctx || this.bg) return;
      const osc = this.ctx.createOscillator();
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.value = 70;            // low engine drone
      lfo.type = 'sine';
      lfo.frequency.value = 6;             // wobble
      lfoGain.gain.value = 8;              // wobble depth (Hz)
      gain.gain.value = 0.0;

      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      osc.connect(gain);
      gain.connect(this.master || this.ctx.destination);

      const now = this.ctx.currentTime;
      gain.gain.setValueAtTime(0.0, now);
      gain.gain.linearRampToValueAtTime(0.05, now + 0.6); // fade in quietly

      osc.start();
      lfo.start();
      this.bg = { osc, lfo, gain };
    },

    stopMusic() {
      if (!this.ctx || !this.bg) return;
      const { osc, lfo, gain } = this.bg;
      const now = this.ctx.currentTime;
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0.0001, now + 0.25);
        osc.stop(now + 0.3);
        lfo.stop(now + 0.3);
      } catch (e) { /* ignore */ }
      this.bg = null;
    }
  };
  GameAudio.init();

  /* =========================================================
   * SHARED CONSTANTS
   * ========================================================= */
  const TRACK_WIDTH = 180;
  const SQUARE_SIZE = 32;
  const COLORS = {
    yellow: '#FFD700',
    blue:   '#4169E1',
    green:  '#228B22',
    red:    '#CC0000'
  };
  const COLOR_ORDER = ['yellow', 'blue', 'green', 'red'];

  /* =========================================================
   * PHASE 4 — TRACK GENERATION
   *
   * The track is a sequence of axis-aligned rectangular segments in
   * world space that snake left/right down a tall world. Two kinds:
   *   • 'straight'  — a tall vertical corridor (travel: down)
   *   • 'connector' — a horizontal corridor joining two straights
   * Connectors overlap the straights they join so there are no gaps.
   * ========================================================= */
  const TRACK = { segments: [], straights: [], totalLength: 0, finishY: 0, startX: 0, startY: 0 };

  function generateTrack(seed) {
    rand = mulberry32(seed);
    TRACK.segments = [];
    TRACK.straights = [];

    const margin = 16;
    // A straight's left edge must stay within [minX, maxX] so that the
    // straight itself (left..left+TRACK_WIDTH) never crosses the margins.
    const minX = margin;
    const maxX = Math.max(minX, view.w - margin - TRACK_WIDTH);

    // Start near the top-center of the world.
    let curX = Math.round((minX + maxX) / 2);
    let curY = 120;
    TRACK.startX = curX;
    TRACK.startY = curY;

    const SEG_COUNT = 14;

    for (let i = 0; i < SEG_COUNT; i++) {
      const segHeight = 280 + rand() * 220;

      const straight = {
        x: curX,
        y: curY,
        width: TRACK_WIDTH,
        height: segHeight,
        type: 'straight'
      };
      TRACK.segments.push(straight);
      TRACK.straights.push(straight);

      curY += segHeight;

      // Add a horizontal connector between this straight and the next,
      // except after the final straight.
      if (i < SEG_COUNT - 1) {
        // Choose a horizontal travel direction that keeps us on-screen.
        // Bias toward whichever side has more room so turns stay meaningful.
        const roomRight = maxX - curX;
        const roomLeft = curX - minX;
        let goRight;
        if (roomRight < 80) goRight = false;
        else if (roomLeft < 80) goRight = true;
        else goRight = rand() < (roomRight / (roomRight + roomLeft));

        // How far we *could* shift before hitting a margin.
        const room = goRight ? (maxX - curX) : (curX - minX);
        const desired = 120 + rand() * 160;
        // Never exceed the available room; minimum a modest turn if possible.
        const shift = Math.min(desired, room);

        const nextX = goRight ? curX + shift : curX - shift;

        // Connector spans from the left straight's left edge to the right
        // straight's right edge, so both corners overlap (no gaps).
        const connLeft = Math.min(curX, nextX);
        const connRight = Math.max(curX, nextX) + TRACK_WIDTH;
        const connector = {
          x: connLeft,
          y: curY,
          width: connRight - connLeft,
          height: TRACK_WIDTH,
          type: goRight ? 'turn-right' : 'turn-left'
        };
        TRACK.segments.push(connector);

        curX = nextX;
        curY += TRACK_WIDTH;
      }
    }

    // Finish line sits at the bottom of the last straight.
    const last = TRACK.straights[TRACK.straights.length - 1];
    TRACK.finishX = last.x;
    TRACK.finishY = last.y + last.height - 60;
    TRACK.totalLength = TRACK.finishY;
  }

  // Returns the segment a world point currently sits in, preferring the
  // segment whose vertical span contains worldY (straights take priority).
  function getCurrentSegment(worldX, worldY) {
    let fallback = null;
    for (const seg of TRACK.segments) {
      if (worldY >= seg.y && worldY <= seg.y + seg.height) {
        if (worldX >= seg.x && worldX <= seg.x + seg.width) {
          if (seg.type === 'straight') return seg;
          fallback = seg;
        }
      }
    }
    return fallback;
  }

  function isOnTrack(worldX, worldY) {
    for (const seg of TRACK.segments) {
      if (worldX >= seg.x && worldX <= seg.x + seg.width &&
          worldY >= seg.y && worldY <= seg.y + seg.height) {
        return true;
      }
    }
    return false;
  }

  // Returns the horizontal bounds {left,right} of all track at a given
  // world Y (union of every segment that spans that Y). This makes wall
  // collision correct even where a connector widens the corridor.
  function getTrackBoundsAtY(worldY) {
    let left = Infinity;
    let right = -Infinity;
    for (const seg of TRACK.segments) {
      if (worldY >= seg.y && worldY <= seg.y + seg.height) {
        if (seg.x < left) left = seg.x;
        if (seg.x + seg.width > right) right = seg.x + seg.width;
      }
    }
    if (left === Infinity) return null;
    return { left, right };
  }

  function drawTrack() {
    for (const seg of TRACK.segments) {
      const s = Camera.worldToScreen(seg.x, seg.y);

      // Cull off-screen segments.
      if (s.y + seg.height < -20 || s.y > view.h + 20) continue;
      if (s.x + seg.width < -20 || s.x > view.w + 20) continue;

      // Floor.
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(s.x, s.y, seg.width, seg.height);

      // Subtle tile texture.
      ctx.fillStyle = 'rgba(0,0,0,0.04)';
      const tile = 30;
      for (let ty = 0; ty < seg.height; ty += tile) {
        for (let tx = 0; tx < seg.width; tx += tile) {
          if (((tx / tile) + (ty / tile)) % 2 === 0) {
            ctx.fillRect(s.x + tx, s.y + ty, tile, tile);
          }
        }
      }
    }

    // Walls are drawn as the *gaps* between track and background: outline
    // each segment. Because connectors overlap straights, we draw borders
    // last so seams are covered by the floor of neighbors first.
    for (const seg of TRACK.segments) {
      const s = Camera.worldToScreen(seg.x, seg.y);
      if (s.y + seg.height < -20 || s.y > view.h + 20) continue;
      if (s.x + seg.width < -20 || s.x > view.w + 20) continue;

      ctx.strokeStyle = '#2b2b3d';
      ctx.lineWidth = 4;
      ctx.strokeRect(s.x, s.y, seg.width, seg.height);
    }

    drawFinishLine();
  }

  function drawFinishLine() {
    const sq = 18;
    const last = TRACK.straights[TRACK.straights.length - 1];
    const topScreen = Camera.worldToScreen(last.x, TRACK.finishY);
    if (topScreen.y < -40 || topScreen.y > view.h + 40) return;

    const cols = Math.floor(TRACK_WIDTH / sq);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < cols; col++) {
        ctx.fillStyle = (col + row) % 2 === 0 ? '#111' : '#fff';
        ctx.fillRect(topScreen.x + col * sq, topScreen.y + row * sq, sq, sq);
      }
    }
  }

  /* =========================================================
   * PHASE 5 — SQUARES & MOVEMENT
   * ========================================================= */
  let SQUARES = [];

  function createSquare(color, startX, startY) {
    return {
      color,
      x: startX,
      y: startY,
      vx: 0,
      vy: 0,
      baseSpeed: 130 + rand() * 50, // px/sec, seeded per race
      angle: 0,
      alive: true,
      finished: false,
      finishTime: null,
      eliminationTimer: 0,
      opacity: 1,
      isPlayer: false,
      boostTimer: 0,
      slowTimer: 0
    };
  }

  function spawnSquares() {
    SQUARES = [];
    const seg = TRACK.straights[0];
    const startY = seg.y + 50;
    const spacing = TRACK_WIDTH / 4;

    SQUARES = COLOR_ORDER.map((color, i) => {
      const sx = seg.x + spacing * i + spacing / 2;
      const sq = createSquare(color, sx, startY);
      sq.isPlayer = color === STATE.selectedColor;
      return sq;
    });
  }

  function updateSquares(deltaTime) {
    for (const sq of SQUARES) {
      if (!sq.alive) { updateEliminatedSquare(sq, deltaTime); continue; }
      if (sq.finished) continue;

      // Baseline survival instinct: every square steers toward the safe lane
      // when a gap lies just ahead (player included). AI personalities add
      // extra reaction on top of this in updateAI().
      avoidGapsAhead(sq, deltaTime, 1.0);

      // AI steering (no-op for the player square).
      updateAI(sq, deltaTime);

      // Current speed with boost / slow modifiers.
      let speed = sq.baseSpeed;
      if (sq.boostTimer > 0) { speed *= 2; sq.boostTimer -= deltaTime; }
      if (sq.slowTimer > 0)  { speed *= 0.5; sq.slowTimer -= deltaTime; }

      const seg = getCurrentSegment(sq.x, sq.y);

      // Drive along the corridor. On straights, push down. On connectors,
      // push horizontally toward the next straight, then resume downward.
      if (!seg || seg.type === 'straight') {
        sq.vy += speed * deltaTime;
      } else if (seg.type === 'turn-right') {
        sq.vx += speed * 0.9 * deltaTime;
        sq.vy += speed * 0.35 * deltaTime;
      } else if (seg.type === 'turn-left') {
        sq.vx -= speed * 0.9 * deltaTime;
        sq.vy += speed * 0.35 * deltaTime;
      }

      // Damping (acts like terminal velocity / inertia).
      sq.vx *= 0.86;
      sq.vy *= 0.86;

      sq.x += sq.vx;
      sq.y += sq.vy;

      // Face the direction of travel (visual nose).
      if (Math.abs(sq.vx) + Math.abs(sq.vy) > 0.1) {
        sq.angle = Math.atan2(sq.vy, sq.vx) - Math.PI / 2;
      }

      resolveWallCollision(sq);
      resolveSquareCollisions(sq);

      // Finish check.
      if (!sq.finished && sq.y >= TRACK.finishY) {
        sq.finished = true;
        sq.finishTime = performance.now();
        if (!STATE.placements.includes(sq.color)) STATE.placements.push(sq.color);
      }
    }

    // Camera follows the furthest-along racer still in play.
    const contenders = SQUARES.filter(s => s.alive && !s.finished);
    const leader = contenders.sort((a, b) => b.y - a.y)[0];
    if (leader) Camera.targetY = leader.y - view.h * 0.42;
  }

  function resolveWallCollision(sq) {
    const half = SQUARE_SIZE / 2;
    const bounds = getTrackBoundsAtY(sq.y);
    if (!bounds) return;

    if (sq.x - half < bounds.left) {
      sq.x = bounds.left + half;
      sq.vx = Math.abs(sq.vx) * 0.4;
    }
    if (sq.x + half > bounds.right) {
      sq.x = bounds.right - half;
      sq.vx = -Math.abs(sq.vx) * 0.4;
    }
  }

  function resolveSquareCollisions(sq) {
    for (const other of SQUARES) {
      if (other === sq || !other.alive || other.finished) continue;
      const dx = sq.x - other.x;
      const dy = sq.y - other.y;
      const dist = Math.hypot(dx, dy);
      const minDist = SQUARE_SIZE;
      if (dist < minDist && dist > 0.0001) {
        const overlap = minDist - dist;
        const nx = dx / dist;
        const ny = dy / dist;
        sq.x += nx * overlap * 0.5;
        sq.y += ny * overlap * 0.5;
        sq.vx += nx * 0.8;
        sq.vy += ny * 0.8;
      }
    }
  }

  function updateEliminatedSquare(sq, deltaTime) {
    sq.eliminationTimer -= deltaTime;
    sq.angle += 12 * deltaTime;
    sq.opacity = Math.max(0, sq.eliminationTimer / 1.0);
  }

  function drawSquare(sq) {
    if (sq.opacity <= 0) return;
    const s = Camera.worldToScreen(sq.x, sq.y);
    const half = SQUARE_SIZE / 2;

    // Cull.
    if (s.y < -60 || s.y > view.h + 60) return;

    ctx.save();
    ctx.globalAlpha = sq.opacity;
    ctx.translate(s.x, s.y);
    ctx.rotate(sq.angle);

    if (sq.isPlayer && sq.alive && !sq.finished) {
      ctx.shadowColor = COLORS[sq.color];
      ctx.shadowBlur = 16;
    }

    // Body.
    ctx.fillStyle = COLORS[sq.color];
    ctx.fillRect(-half, -half, SQUARE_SIZE, SQUARE_SIZE);
    ctx.shadowBlur = 0;

    // Subtle bevel.
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-half, -half, SQUARE_SIZE, SQUARE_SIZE);

    // Direction nose (points "up" in local space = direction of travel).
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(0, -half - 7);
    ctx.lineTo(-6, -half + 2);
    ctx.lineTo(6, -half + 2);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function drawSquares() {
    // Draw eliminated/finished first so live racers render on top.
    for (const sq of SQUARES) if (!sq.alive) drawSquare(sq);
    for (const sq of SQUARES) if (sq.alive) drawSquare(sq);
  }

  /* =========================================================
   * PHASE 6 — OBSTACLES
   *
   * Types: 'knife' | 'gap' | 'ball' | 'boost' | 'mud'
   *   knife — slides horizontally, knocks squares backward
   *   gap   — lethal pit; squares that enter are eliminated
   *   ball  — bounces around its segment, knocks squares back
   *   boost — green pad, launches squares forward (then cools down)
   *   mud   — brown patch, halves speed temporarily
   * Placement is seeded so a given track always has the same obstacles.
   * RULE: gaps never spawn in the first 2 straight segments.
   * ========================================================= */
  let OBSTACLES = [];

  function createObstacle(type, worldX, worldY, extra) {
    const base = { type, x: worldX, y: worldY, active: true };
    return Object.assign(base, obstacleDefaults(type), extra || {});
  }

  function obstacleDefaults(type) {
    switch (type) {
      case 'knife': return { vx: 90, width: 34, height: 10, bounces: 0 };
      case 'gap':   return { width: 0, height: 44 }; // width set at placement
      case 'ball':  return { vx: 70, vy: 70, radius: 16 };
      case 'boost': return { width: 54, height: 22, cooldown: 0 };
      case 'mud':   return { width: 64, height: 44 };
      default:      return {};
    }
  }

  function placeObstacles() {
    OBSTACLES = [];
    const straights = TRACK.straights;

    // Skip the very first and last straight entirely (clear start & finish run).
    for (let i = 1; i < straights.length - 1; i++) {
      const seg = straights[i];
      const cx = seg.x + TRACK_WIDTH / 2;
      const roll = rand();

      // Gaps are forbidden in the first 2 straight segments (indices 0,1).
      const gapsAllowed = i >= 2;

      if (roll < 0.28) {
        // Knife — placed at a height within the segment.
        OBSTACLES.push(createObstacle('knife', cx, seg.y + seg.height * 0.4));
      } else if (roll < 0.50 && gapsAllowed) {
        // Gap — covers ~45-55% of the corridor on one side, leaving a safe
        // lane to steer around. A full-width gap would be unavoidable.
        const gapW = TRACK_WIDTH * (0.45 + rand() * 0.10);
        const onLeft = rand() < 0.5;
        const gx = onLeft ? seg.x : seg.x + (TRACK_WIDTH - gapW);
        OBSTACLES.push(createObstacle('gap', gx, seg.y + seg.height * 0.5,
          { width: gapW }));
      } else if (roll < 0.66) {
        // Bouncing ball.
        OBSTACLES.push(createObstacle('ball', cx, seg.y + seg.height * 0.3));
      } else if (roll < 0.83) {
        // Speed boost pad.
        OBSTACLES.push(createObstacle('boost', cx - 27, seg.y + seg.height * 0.6));
      } else {
        // Mud patch.
        OBSTACLES.push(createObstacle('mud', cx - 32, seg.y + seg.height * 0.5));
      }
    }
  }

  function updateObstacles(deltaTime) {
    for (const obs of OBSTACLES) {
      if (!obs.active) continue;

      if (obs.type === 'knife') {
        obs.x += obs.vx * deltaTime;
        const bounds = getTrackBoundsAtY(obs.y);
        if (bounds) {
          if (obs.x < bounds.left + obs.width / 2)  { obs.x = bounds.left + obs.width / 2;  obs.vx = Math.abs(obs.vx); obs.bounces++; }
          if (obs.x > bounds.right - obs.width / 2) { obs.x = bounds.right - obs.width / 2; obs.vx = -Math.abs(obs.vx); obs.bounces++; }
        }
        checkObstacleHit(obs, 'knockback');

      } else if (obs.type === 'ball') {
        obs.x += obs.vx * deltaTime;
        obs.y += obs.vy * deltaTime;
        const bounds = getTrackBoundsAtY(obs.y);
        const seg = getCurrentSegment(obs.x, obs.y);
        if (bounds) {
          if (obs.x - obs.radius < bounds.left)  { obs.x = bounds.left + obs.radius;  obs.vx = Math.abs(obs.vx); }
          if (obs.x + obs.radius > bounds.right) { obs.x = bounds.right - obs.radius; obs.vx = -Math.abs(obs.vx); }
        }
        if (seg) {
          if (obs.y < seg.y + obs.radius)              { obs.y = seg.y + obs.radius;              obs.vy = Math.abs(obs.vy); }
          if (obs.y > seg.y + seg.height - obs.radius) { obs.y = seg.y + seg.height - obs.radius; obs.vy = -Math.abs(obs.vy); }
        }
        checkObstacleHit(obs, 'knockback');

      } else if (obs.type === 'boost') {
        if (obs.cooldown > 0) obs.cooldown -= deltaTime;
        if (obs.cooldown <= 0) checkObstacleHit(obs, 'boost');

      } else if (obs.type === 'gap') {
        checkObstacleHit(obs, 'eliminate');

      } else if (obs.type === 'mud') {
        checkObstacleHit(obs, 'slow');
      }
    }
  }

  function eliminateSquare(sq) {
    if (!sq.alive) return;
    sq.alive = false;
    sq.eliminationTimer = 1.0;
    sq.vx = 0; sq.vy = 0;
    if (!STATE.placements.includes(sq.color)) {
      // Eliminated racers take the worst still-open positions: record them
      // now; results will reverse-order eliminations so the last to die
      // places higher than the first to die.
      STATE.eliminatedOrder.push(sq.color);
    }
    GameAudio.playElim();
  }

  function checkObstacleHit(obs, effect) {
    const half = SQUARE_SIZE / 2;
    for (const sq of SQUARES) {
      if (!sq.alive || sq.finished) continue;

      let hit = false;
      if (obs.type === 'knife') {
        hit = Math.abs(sq.x - obs.x) < (half + obs.width / 2) &&
              Math.abs(sq.y - obs.y) < (half + obs.height / 2);
      } else if (obs.type === 'ball') {
        hit = Math.hypot(sq.x - obs.x, sq.y - obs.y) < (half + obs.radius);
      } else {
        // Axis-aligned rectangle overlap.
        hit = sq.x + half > obs.x && sq.x - half < obs.x + obs.width &&
              sq.y + half > obs.y && sq.y - half < obs.y + obs.height;
      }
      if (!hit) continue;

      if (effect === 'knockback') {
        sq.vy -= 4;                       // shove backward (up-track)
        sq.vx += (rand() - 0.5) * 5;
        if (!sq._hitCooldown || performance.now() - sq._hitCooldown > 250) {
          GameAudio.playHit();
          sq._hitCooldown = performance.now();
        }
      } else if (effect === 'eliminate') {
        // Only eliminate if the square's center is well inside the pit.
        if (sq.y > obs.y + 6 && sq.y < obs.y + obs.height - 6) {
          eliminateSquare(sq);
        }
      } else if (effect === 'boost' && obs.cooldown <= 0) {
        sq.boostTimer = Math.max(sq.boostTimer, 1.2);
        obs.cooldown = 2.5;
        GameAudio.playBoost();
      } else if (effect === 'slow') {
        sq.slowTimer = Math.max(sq.slowTimer, 1.5);
      }
    }
  }

  function drawObstacles() {
    for (const obs of OBSTACLES) {
      if (!obs.active) continue;
      const s = Camera.worldToScreen(obs.x, obs.y);
      if (s.y < -120 || s.y > view.h + 120) continue;

      ctx.save();
      switch (obs.type) {
        case 'knife': {
          ctx.translate(s.x, s.y);
          // Handle.
          ctx.fillStyle = '#8B4513';
          ctx.fillRect(-obs.width / 2 - 10, -4, 10, 8);
          // Blade.
          ctx.fillStyle = '#9fd0ff';
          ctx.fillRect(-obs.width / 2, -obs.height / 2, obs.width, obs.height);
          ctx.fillStyle = '#dff0ff';
          ctx.fillRect(-obs.width / 2, -obs.height / 2, obs.width, 3);
          ctx.strokeStyle = '#3a78c0';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(-obs.width / 2, -obs.height / 2, obs.width, obs.height);
          break;
        }
        case 'gap': {
          // Dark pit with warning stripes.
          ctx.fillStyle = '#141420';
          ctx.fillRect(s.x, s.y, obs.width, obs.height);
          ctx.fillStyle = '#FFD700';
          for (let i = 0; i < obs.width; i += 22) {
            ctx.fillRect(s.x + i, s.y, 12, 5);
            ctx.fillRect(s.x + i, s.y + obs.height - 5, 12, 5);
          }
          break;
        }
        case 'ball': {
          ctx.translate(s.x, s.y);
          const g = ctx.createRadialGradient(-4, -4, 2, 0, 0, obs.radius);
          g.addColorStop(0, '#ffae66');
          g.addColorStop(1, '#ff6600');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(0, 0, obs.radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#cc4400';
          ctx.lineWidth = 2;
          ctx.stroke();
          break;
        }
        case 'boost': {
          ctx.fillStyle = obs.cooldown > 0 ? '#5a7a5a' : '#00cc44';
          ctx.fillRect(s.x, s.y, obs.width, obs.height);
          ctx.fillStyle = '#eaffea';
          // Up-chevrons.
          for (let k = 0; k < 2; k++) {
            const yy = s.y + 6 + k * 7;
            ctx.beginPath();
            ctx.moveTo(s.x + obs.width / 2, yy);
            ctx.lineTo(s.x + obs.width / 2 - 8, yy + 6);
            ctx.lineTo(s.x + obs.width / 2 + 8, yy + 6);
            ctx.closePath();
            ctx.fill();
          }
          break;
        }
        case 'mud': {
          ctx.fillStyle = '#6e5018';
          ctx.fillRect(s.x, s.y, obs.width, obs.height);
          ctx.fillStyle = '#523c12';
          for (let i = 0; i < 6; i++) {
            const bx = s.x + 8 + (i * 9.3) % (obs.width - 10);
            const by = s.y + 8 + ((i * 13) % (obs.height - 12));
            ctx.beginPath();
            ctx.arc(bx, by, 4, 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        }
      }
      ctx.restore();
    }
  }

  /* =========================================================
   * PHASE 7 — AI OPPONENTS
   *
   * Each non-player square has a personality affecting top speed and how
   * reliably it reacts to upcoming hazards. Reactions are imperfect (and
   * delayed) so the player can realistically beat them.
   * ========================================================= */
  const AI_PROFILES = {
    yellow: { speedMult: 1.10, obstacleReact: 0.30, name: 'Reckless'  },
    blue:   { speedMult: 0.96, obstacleReact: 0.90, name: 'Cautious'  },
    green:  { speedMult: 1.00, obstacleReact: 0.60, name: 'Balanced'  },
    red:    { speedMult: 1.06, obstacleReact: 0.50, name: 'Aggressive'}
  };

  // Steer a square toward the open lane when a gap is just ahead in its path.
  // `strength` scales the steering force (AI personalities pass <1 or >1).
  function avoidGapsAhead(sq, deltaTime, strength) {
    const half = SQUARE_SIZE / 2;
    const lookAhead = 70;
    for (const obs of OBSTACLES) {
      if (!obs.active || obs.type !== 'gap') continue;
      // Is this gap in front of us (down-track) and close enough to matter?
      if (obs.y < sq.y - 10 || obs.y > sq.y + lookAhead) continue;
      // Does our current x column overlap the gap?
      const overlapsGap = sq.x + half > obs.x && sq.x - half < obs.x + obs.width;
      if (!overlapsGap) continue;

      const bounds = getTrackBoundsAtY(obs.y);
      if (!bounds) continue;
      // Safe lane is whichever side of the gap is wider.
      const leftRoom = obs.x - bounds.left;
      const rightRoom = bounds.right - (obs.x + obs.width);
      const targetX = leftRoom >= rightRoom
        ? bounds.left + half + Math.max(0, leftRoom - half) / 2
        : (obs.x + obs.width) + Math.max(0, rightRoom - half) / 2;

      // Urgency grows as the gap gets closer.
      const dist = Math.max(1, obs.y - sq.y);
      const urgency = Math.min(1, lookAhead / dist);
      sq.vx += (targetX - sq.x) * 0.10 * strength * urgency;
    }
  }

  function updateAI(sq, deltaTime) {
    if (sq.isPlayer || !sq.alive || sq.finished) return;
    const profile = AI_PROFILES[sq.color];
    if (!profile) return;

    // Scan a short distance ahead (down-track) for dangerous obstacles.
    const lookAhead = 90;
    const aheadY = sq.y + lookAhead;
    let threat = null;
    let bestDy = Infinity;
    for (const obs of OBSTACLES) {
      if (!obs.active) continue;
      if (obs.type !== 'knife' && obs.type !== 'gap' && obs.type !== 'ball') continue;
      const dy = obs.y - aheadY;
      if (Math.abs(dy) < 70 && Math.abs(obs.x - sq.x) < 60 && Math.abs(dy) < bestDy) {
        threat = obs;
        bestDy = Math.abs(dy);
      }
    }

    if (threat && rand() < profile.obstacleReact) {
      // Steer away from the threat's x toward open track.
      const bounds = getTrackBoundsAtY(sq.y);
      let steer = sq.x < threat.x ? -1 : 1;
      // Don't steer into a wall; flip if too close to that edge.
      if (bounds) {
        if (steer < 0 && sq.x - SQUARE_SIZE < bounds.left)  steer = 1;
        if (steer > 0 && sq.x + SQUARE_SIZE > bounds.right) steer = -1;
      }
      sq.vx += steer * 70 * deltaTime;
    }

    // Gentle centering so the AI doesn't hug walls.
    const bounds = getTrackBoundsAtY(sq.y);
    if (bounds) {
      const center = (bounds.left + bounds.right) / 2;
      sq.vx += (center - sq.x) * 0.6 * deltaTime;
    }
  }

  // Apply per-color speed multiplier when squares are spawned for AI racers.
  function applyAIProfiles() {
    for (const sq of SQUARES) {
      if (sq.isPlayer) continue;
      const p = AI_PROFILES[sq.color];
      if (p) sq.baseSpeed *= p.speedMult;
    }
  }

  /* =========================================================
   * RACE LIFECYCLE
   * ========================================================= */
  function startRace() {
    STATE.placements = [];
    STATE.eliminatedOrder = [];
    STATE.boostUsed = false;
    STATE.winner = null;
    STATE._finishSfxPlayed = false;
    Camera.reset();

    // Defensive: ensure no leftover background music node survives across a
    // restart (e.g. rapid "PLAY AGAIN"). startMusic is idempotent, but this
    // guarantees we never strand or stack an audio source.
    GameAudio.stopMusic();

    const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    generateTrack(seed);
    placeObstacles();
    spawnSquares();
    applyAIProfiles();

    // Place camera on the start so the first frame isn't jarring.
    Camera.y = SQUARES[0].y - view.h * 0.42;
    Camera.targetY = Camera.y;

    startCountdown();
  }

  /* =========================================================
   * STATE HANDLERS (placeholders — built out in later phases)
   * ========================================================= */

  // ---- TITLE ----
  let titleSquares = [];
  function initTitleScreen() {
    titleSquares = COLOR_ORDER.map((color) => ({
      color,
      x: Math.random() * view.w,
      y: Math.random() * view.h,
      vx: (Math.random() - 0.5) * 140,
      vy: (Math.random() - 0.5) * 140,
      size: 26 + Math.random() * 30,
      angle: Math.random() * Math.PI
    }));
  }
  function updateTitle(dt) {
    if (titleSquares.length === 0) initTitleScreen();
    for (const sq of titleSquares) {
      sq.x += sq.vx * dt;
      sq.y += sq.vy * dt;
      sq.angle += 1.4 * dt;
      const h = sq.size / 2;
      if (sq.x < h) { sq.x = h; sq.vx = Math.abs(sq.vx); }
      if (sq.x > view.w - h) { sq.x = view.w - h; sq.vx = -Math.abs(sq.vx); }
      if (sq.y < h) { sq.y = h; sq.vy = Math.abs(sq.vy); }
      if (sq.y > view.h - h) { sq.y = view.h - h; sq.vy = -Math.abs(sq.vy); }
    }
    if (Input.tapped) {
      GameAudio.unlock();
      GameAudio.playSelect();
      Input.consume();
      STATE.current = 'SELECT';
    }
  }
  function drawTitle() {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, view.w, view.h);

    // Bouncing background squares.
    for (const sq of titleSquares) {
      ctx.save();
      ctx.translate(sq.x, sq.y);
      ctx.rotate(sq.angle);
      ctx.fillStyle = COLORS[sq.color] + '99';
      ctx.fillRect(-sq.size / 2, -sq.size / 2, sq.size, sq.size);
      ctx.restore();
    }

    // Title.
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.font = 'bold 54px monospace';
    ctx.fillText('SQUARE', view.w / 2 + 2, view.h * 0.34 + 2);
    ctx.fillText('RACE', view.w / 2 + 2, view.h * 0.34 + 54);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('SQUARE', view.w / 2, view.h * 0.34);
    ctx.fillStyle = '#FFD700';
    ctx.fillText('RACE', view.w / 2, view.h * 0.34 + 52);

    // Pulsing prompt.
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 400);
    ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.55 * pulse})`;
    ctx.font = 'bold 22px monospace';
    ctx.fillText('TAP TO PLAY', view.w / 2, view.h * 0.74);
  }

  // ---- SELECT ----
  // Vertical list: each row has a color swatch + personality name + one-line
  // trait, so the choice is meaningful (per design note).
  const TRAITS = {
    yellow: 'RECKLESS \u2014 fast but risky',
    blue:   'CAUTIOUS \u2014 slow but survives',
    green:  'BALANCED \u2014 steady all-rounder',
    red:    'AGGRESSIVE \u2014 fast and pushy'
  };

  // Compute the on-screen rectangle for each selectable row + the RACE button.
  function selectLayout() {
    const rowH = 72;
    const gap = 14;
    const listW = Math.min(view.w - 36, 360);
    const x = (view.w - listW) / 2;
    const top = view.h * 0.26;
    const rows = COLOR_ORDER.map((color, i) => ({
      color,
      x,
      y: top + i * (rowH + gap),
      w: listW,
      h: rowH
    }));
    const raceBtn = {
      x: view.w / 2 - 110,
      y: top + 4 * (rowH + gap) + 10,
      w: 220,
      h: 56
    };
    return { rows, raceBtn };
  }

  function pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  function updateSelect(dt) {
    if (!Input.tapped) return;
    const { rows, raceBtn } = selectLayout();

    for (const r of rows) {
      if (pointInRect(Input.tapX, Input.tapY, r)) {
        STATE.selectedColor = r.color;
        GameAudio.playSelect();
        Input.consume();
        return;
      }
    }
    if (STATE.selectedColor && pointInRect(Input.tapX, Input.tapY, raceBtn)) {
      Input.consume();
      startRace();
      return;
    }
    Input.consume();
  }

  function drawSelect() {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, view.w, view.h);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('CHOOSE YOUR SQUARE', view.w / 2, view.h * 0.16);

    const { rows, raceBtn } = selectLayout();
    for (const r of rows) {
      const selected = STATE.selectedColor === r.color;
      const wig = selected ? Math.sin(Date.now() / 110) * 3 : 0;

      // Row background.
      ctx.fillStyle = selected ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)';
      roundRect(r.x, r.y, r.w, r.h, 12);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = COLORS[r.color];
        ctx.lineWidth = 3;
        roundRect(r.x, r.y, r.w, r.h, 12);
        ctx.stroke();
      }

      // Color swatch.
      const sw = r.h - 24;
      const sx = r.x + 14 + wig;
      const sy = r.y + 12;
      if (selected) { ctx.shadowColor = COLORS[r.color]; ctx.shadowBlur = 16; }
      ctx.fillStyle = COLORS[r.color];
      ctx.fillRect(sx, sy, sw, sw);
      ctx.shadowBlur = 0;
      // little direction nose on the swatch
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(sx + sw / 2, sy - 6);
      ctx.lineTo(sx + sw / 2 - 5, sy + 3);
      ctx.lineTo(sx + sw / 2 + 5, sy + 3);
      ctx.closePath();
      ctx.fill();

      // Name + trait text.
      const tx = r.x + 14 + sw + 16;
      const prof = AI_PROFILES[r.color];
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px monospace';
      ctx.fillText(r.color.toUpperCase() + '  \u2014  ' + (prof ? prof.name.toUpperCase() : ''), tx, r.y + 30);
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '12px monospace';
      ctx.fillText(TRAITS[r.color], tx, r.y + 50);
    }

    // RACE button (only enabled after a selection).
    const enabled = !!STATE.selectedColor;
    ctx.fillStyle = enabled ? '#FFD700' : 'rgba(255,255,255,0.12)';
    roundRect(raceBtn.x, raceBtn.y, raceBtn.w, raceBtn.h, 14);
    ctx.fill();
    ctx.fillStyle = enabled ? '#1a1a2e' : 'rgba(255,255,255,0.4)';
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(enabled ? '\u25B6  RACE!' : 'PICK A SQUARE', raceBtn.x + raceBtn.w / 2, raceBtn.y + raceBtn.h / 2 + 8);
  }

  // ---- COUNTDOWN ----
  let countdownValue = 3;
  let countdownTimer = 1.0;
  function startCountdown() {
    countdownValue = 3;
    countdownTimer = 1.0;
    STATE.current = 'COUNTDOWN';
    GameAudio.playCountBeep(false);
  }
  function updateCountdown(dt) {
    // Keep the camera settled on the start line behind the overlay.
    Camera.update(dt);
    countdownTimer -= dt;
    if (countdownTimer <= 0) {
      countdownValue--;
      countdownTimer = 1.0;
      if (countdownValue < 0) {
        STATE.current = 'RACE';
        STATE.raceStartTime = performance.now();
        GameAudio.startMusic();
      } else {
        GameAudio.playCountBeep(countdownValue === 0); // higher pitch on GO!
      }
    }
  }
  function drawCountdown() {
    drawRace();                       // show the track/squares behind
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, view.w, view.h);

    const text = countdownValue > 0 ? String(countdownValue) : 'GO!';
    const scale = 1 + (1 - countdownTimer) * 0.35;
    ctx.save();
    ctx.translate(view.w / 2, view.h / 2);
    ctx.scale(scale, scale);
    ctx.textAlign = 'center';
    ctx.fillStyle = countdownValue > 0 ? '#FFD700' : '#37e06a';
    ctx.font = 'bold 110px monospace';
    ctx.fillText(text, 0, 38);
    ctx.restore();
  }

  // ---- RACE ----
  const MUTE_BTN = { x: 0, y: 12, w: 40, h: 40 }; // x set per-frame (right side)
  function updateRace(dt) {
    if (Input.tapped) {
      MUTE_BTN.x = view.w - 52;
      if (pointInRect(Input.tapX, Input.tapY, MUTE_BTN)) {
        // Tap the mute button — toggle, don't spend the boost.
        GameAudio.toggleMute();
      } else if (!STATE.boostUsed) {
        // One-time player boost.
        const player = SQUARES.find(s => s.isPlayer && s.alive && !s.finished);
        if (player) {
          player.boostTimer = 1.5;
          STATE.boostUsed = true;
          GameAudio.playBoost();
        }
      }
      Input.consume();
    }

    updateObstacles(dt);
    updateSquares(dt);
    Camera.update(dt);

    // Fanfare when the first square crosses the line.
    if (STATE.placements.length === 1 && !STATE._finishSfxPlayed) {
      STATE._finishSfxPlayed = true;
      GameAudio.playFinish();
    }

    // End the race when everyone has finished or been eliminated.
    const stillRacing = SQUARES.some(s => s.alive && !s.finished);
    if (!stillRacing) {
      finalizePlacements();
      // A real winner exists only if at least one square actually finished.
      const anyFinished = SQUARES.some(s => s.finished);
      STATE.winner = anyFinished ? (STATE.placements[0] || null) : null;
      GameAudio.stopMusic();
      resultsAnim = 0;
      STATE.current = 'RESULTS';
    }
  }

  // Build the final 4-deep placement list: finishers (in finish order) first,
  // then eliminated racers from latest-eliminated (better) to earliest (worst).
  function finalizePlacements() {
    const finishers = STATE.placements.slice(); // already in finish order
    const eliminatedBest = STATE.eliminatedOrder.slice().reverse();
    const full = finishers.concat(eliminatedBest.filter(c => !finishers.includes(c)));
    // Safety: append any color not yet listed (shouldn't happen).
    for (const c of COLOR_ORDER) if (!full.includes(c)) full.push(c);
    STATE.placements = full;
  }
  function drawRace() {
    // Light sky behind the track.
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, view.w, view.h);

    drawTrack();
    drawObstacles();
    drawSquares();
    drawRaceHUD();
  }

  function racePosition(player) {
    // Position = (#racers strictly ahead) + 1, accounting for finishers.
    if (player.finished) {
      const p = STATE.placements.indexOf(player.color);
      if (p >= 0) return p + 1;
    }
    let ahead = 0;
    for (const s of SQUARES) {
      if (s === player) continue;
      if (s.finished) { ahead++; continue; }          // finished racers are ahead
      if (s.alive && s.y > player.y) ahead++;          // further down-track
    }
    return ahead + 1;
  }

  function drawRaceHUD() {
    const player = SQUARES.find(s => s.isPlayer);
    if (!player) return;

    // Position badge.
    const position = racePosition(player);
    const suffixes = ['ST', 'ND', 'RD', 'TH'];
    const suffix = suffixes[Math.min(position - 1, 3)];
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(12, 12, 96, 50, 10);
    ctx.fill();
    ctx.fillStyle = COLORS[STATE.selectedColor] || '#fff';
    ctx.fillRect(20, 22, 14, 14); // player color chip
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 26px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(position + suffix, 44, 46);

    // Mute button (top-right).
    MUTE_BTN.x = view.w - 52;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(MUTE_BTN.x, MUTE_BTN.y, MUTE_BTN.w, MUTE_BTN.h, 10);
    ctx.fill();
    drawSpeakerIcon(MUTE_BTN.x + MUTE_BTN.w / 2, MUTE_BTN.y + MUTE_BTN.h / 2, GameAudio.muted);

    // Progress bar.
    const progress = Math.min(player.y / TRACK.finishY, 1);
    const barW = view.w - 40;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(20, view.h - 30, barW, 14, 7);
    ctx.fill();
    ctx.fillStyle = COLORS[STATE.selectedColor] || '#fff';
    roundRect(20, view.h - 30, Math.max(14, barW * progress), 14, 7);
    ctx.fill();

    // Boost prompt (until used).
    if (!STATE.boostUsed && player.alive && !player.finished) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 250);
      ctx.fillStyle = `rgba(255,215,0,${0.5 + 0.5 * pulse})`;
      ctx.font = 'bold 15px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('TAP FOR BOOST', view.w / 2, view.h - 44);
    }
  }

  // Draw a small speaker (with an X if muted) centered at (cx, cy).
  function drawSpeakerIcon(cx, cy, muted) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    // body
    ctx.beginPath();
    ctx.moveTo(-9, -4);
    ctx.lineTo(-3, -4);
    ctx.lineTo(3, -9);
    ctx.lineTo(3, 9);
    ctx.lineTo(-3, 4);
    ctx.lineTo(-9, 4);
    ctx.closePath();
    ctx.fill();
    if (muted) {
      ctx.beginPath();
      ctx.moveTo(7, -6);
      ctx.lineTo(13, 6);
      ctx.moveTo(13, -6);
      ctx.lineTo(7, 6);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(6, 0, 4, -Math.PI / 3, Math.PI / 3);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(6, 0, 8, -Math.PI / 3, Math.PI / 3);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- RESULTS ----
  let resultsAnim = 0;

  function resultsLayout() {
    const playAgain = { x: view.w / 2 - 130, y: view.h - 150, w: 260, h: 54 };
    const changeSq  = { x: view.w / 2 - 130, y: view.h - 84,  w: 260, h: 54 };
    return { playAgain, changeSq };
  }

  function updateResults(dt) {
    resultsAnim += dt;
    if (!Input.tapped) return;
    const { playAgain, changeSq } = resultsLayout();
    if (pointInRect(Input.tapX, Input.tapY, playAgain)) {
      GameAudio.playSelect();
      Input.consume();
      startRace();                 // new track, same selected square
    } else if (pointInRect(Input.tapX, Input.tapY, changeSq)) {
      GameAudio.playSelect();
      Input.consume();
      STATE.current = 'SELECT';
    } else {
      Input.consume();
    }
  }

  function drawResults() {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, view.w, view.h);

    // A winner is only crowned if someone actually crossed the finish line.
    const winner = STATE.winner;
    ctx.textAlign = 'center';
    ctx.fillStyle = winner ? '#FFD700' : '#ff6b6b';
    ctx.font = 'bold 30px monospace';
    ctx.fillText(winner ? 'WINNER!' : 'NO SURVIVORS', view.w / 2, view.h * 0.10);

    // Winner square bounces in celebration.
    if (winner) {
      const bounce = Math.abs(Math.sin(resultsAnim * 4)) * 14;
      const size = 56;
      const wx = view.w / 2;
      const wy = view.h * 0.20 - bounce;
      ctx.save();
      ctx.shadowColor = COLORS[winner];
      ctx.shadowBlur = 24;
      ctx.fillStyle = COLORS[winner];
      ctx.fillRect(wx - size / 2, wy - size / 2, size, size);
      ctx.restore();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px monospace';
      const prof = AI_PROFILES[winner];
      ctx.fillText(winner.toUpperCase() + (prof ? '  (' + prof.name.toUpperCase() + ')' : ''),
        view.w / 2, view.h * 0.20 + 48);
    }

    // Placement list.
    const medals = ['1', '2', '3', '4'];
    const medalColors = ['#FFD700', '#C0C0C0', '#CD7F32', '#777'];
    const listTop = view.h * 0.33;
    const rowH = 50;
    const listW = Math.min(view.w - 48, 340);
    const lx = (view.w - listW) / 2;

    STATE.placements.forEach((color, i) => {
      const y = listTop + i * rowH;
      const appear = Math.min(1, Math.max(0, (resultsAnim - i * 0.15) * 4));
      ctx.globalAlpha = appear;

      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      roundRect(lx, y, listW, rowH - 8, 10);
      ctx.fill();

      // Rank medal.
      ctx.fillStyle = medalColors[i];
      ctx.beginPath();
      ctx.arc(lx + 26, y + (rowH - 8) / 2, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1a2e';
      ctx.font = 'bold 15px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(medals[i], lx + 26, y + (rowH - 8) / 2 + 5);

      // Color chip.
      ctx.fillStyle = COLORS[color];
      ctx.fillRect(lx + 50, y + (rowH - 8) / 2 - 12, 24, 24);

      // Label.
      ctx.fillStyle = color === STATE.selectedColor ? '#FFD700' : '#fff';
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'left';
      const you = color === STATE.selectedColor ? '  (YOU)' : '';
      ctx.fillText(color.toUpperCase() + you, lx + 84, y + (rowH - 8) / 2 + 6);
      ctx.globalAlpha = 1;
    });

    // Buttons.
    const { playAgain, changeSq } = resultsLayout();
    ctx.fillStyle = '#FFD700';
    roundRect(playAgain.x, playAgain.y, playAgain.w, playAgain.h, 14);
    ctx.fill();
    ctx.fillStyle = '#1a1a2e';
    ctx.font = 'bold 19px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('PLAY AGAIN', playAgain.x + playAgain.w / 2, playAgain.y + playAgain.h / 2 + 7);

    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(changeSq.x, changeSq.y, changeSq.w, changeSq.h, 14);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText('CHANGE SQUARE', changeSq.x + changeSq.w / 2, changeSq.y + changeSq.h / 2 + 7);
  }

  /* =========================================================
   * MAIN GAME LOOP
   * ========================================================= */
  let lastTime = 0;

  function gameLoop(timestamp) {
    const deltaTime = Math.min((timestamp - lastTime) / 1000, 0.05); // cap 50ms
    lastTime = timestamp;

    ctx.clearRect(0, 0, view.w, view.h);

    switch (STATE.current) {
      case 'TITLE':     updateTitle(deltaTime);     drawTitle();     break;
      case 'SELECT':    updateSelect(deltaTime);    drawSelect();    break;
      case 'COUNTDOWN': updateCountdown(deltaTime); drawCountdown(); break;
      case 'RACE':      updateRace(deltaTime);      drawRace();      break;
      case 'RESULTS':   updateResults(deltaTime);   drawResults();   break;
    }

    requestAnimationFrame(gameLoop);
  }

  requestAnimationFrame(gameLoop);
})();
