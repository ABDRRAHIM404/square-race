/* =============================================================
 * MAZE RUNNERS — Maze Stages
 * Pure HTML5 Canvas + Vanilla JS. No external libraries, no image files.
 *
 * Game design:
 *   • Full-screen grid maze (no dark background around it). Internal walls
 *     form corridors. One entry (start) and one exit per maze.
 *   • 4 colored squares move in straight lines and bounce off ALL walls
 *     (outer + internal) like billiard balls (reflection physics).
 *   • Fully passive — no player steering. Per-color speed differences
 *     (yellow fastest .. blue slowest).
 *   • Loot on the maze floor: KNIVES and SHIELDS. Run over one to carry it
 *     (one item max, shown as an icon on the square).
 *       - Touch a square carrying a KNIFE  -> you are eliminated (spin out),
 *         UNLESS you carry a SHIELD (absorbs one hit, then is consumed).
 *   • Stage ends when every surviving square has reached the exit. Exit order
 *     + eliminations give a per-stage placement (1st..4th).
 *   • Points per stage: 1st=4, 2nd=3, 3rd=2, 4th=1. After 5 stages, a final
 *     podium ranks squares by cumulative points.
 *
 * State machine: TITLE -> SELECT -> STAGE_INTRO -> RACE -> STAGE_RESULT
 *                -> (next stage) ... -> FINAL_RESULT -> (replay)
 * ============================================================= */

(function () {
  'use strict';

  /* ---------------------------------------------------------
   * Canvas Setup (DPR-aware; draw in CSS pixels)
   * ------------------------------------------------------- */
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');

  let viewW = window.innerWidth;
  let viewH = window.innerHeight;

  function resizeCanvas() {
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = viewW + 'px';
    canvas.style.height = viewH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (MAZE.grid) layoutMaze(); // recompute cell size on resize
  }

  const view = { get w() { return viewW; }, get h() { return viewH; } };

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
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
  let rand = mulberry32(Date.now());

  /* ---------------------------------------------------------
   * Game State Machine
   * ------------------------------------------------------- */
  const STATE = {
    current: 'TITLE',   // TITLE | SELECT | STAGE_INTRO | RACE | STAGE_RESULT | FINAL_RESULT
    selectedColor: null,
    stageIndex: 0,            // which maze (0-based)
    stagePlacements: [],      // FINAL per-stage order (finishers then eliminated)
    stageFinishers: [],       // colors in exit order this stage
    eliminatedOrder: [],      // colors in order they were eliminated (earliest first)
    points: {},               // cumulative points per color
    introTimer: 0,
    raceTimer: 0,             // seconds elapsed in current RACE
    _stageSettled: false
  };
  // Pure billiard physics: squares have no idea where the exit is and only
  // reach it by randomly bouncing into it. There is NO pathfinding, attraction,
  // or steering. The only fallback is a generous 2-minute safety cap so a stage
  // can't hang literally forever — after it elapses, any squares still bouncing
  // are placed by how close they happen to be to the exit.
  const STAGE_TIME_LIMIT = 120; // seconds (2-minute hard safety cap ONLY)
  const STAGE_POINTS = [4, 3, 2, 1]; // 1st..4th

  /* ---------------------------------------------------------
   * Unified Pointer Input
   * ------------------------------------------------------- */
  const Input = {
    tapX: 0, tapY: 0, tapped: false,
    init() {
      const onDown = (cx, cy) => {
        const rect = canvas.getBoundingClientRect();
        this.tapX = cx - rect.left;
        this.tapY = cy - rect.top;
        this.tapped = true;
      };
      if (window.PointerEvent) {
        canvas.addEventListener('pointerdown', (e) => onDown(e.clientX, e.clientY));
      } else {
        canvas.addEventListener('mousedown', (e) => onDown(e.clientX, e.clientY));
        canvas.addEventListener('touchstart', (e) => {
          if (e.touches && e.touches.length) onDown(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: false });
      }
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    },
    consume() { this.tapped = false; }
  };
  Input.init();

  /* ---------------------------------------------------------
   * Audio — Web Audio API (synth SFX + light hum)
   * ------------------------------------------------------- */
  const GameAudio = {
    ctx: null, muted: false, master: null, bg: null,
    init() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          this.ctx = new AC();
          this.master = this.ctx.createGain();
          this.master.gain.value = 0.9;
          this.master.connect(this.ctx.destination);
        }
      } catch (e) { console.warn('Audio unavailable:', e); }
    },
    unlock() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
    toggleMute() { this.muted = !this.muted; if (this.master) this.master.gain.value = this.muted ? 0 : 0.9; },
    beep(freq, dur, type, vol, off) {
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime + (off || 0);
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type || 'square';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(vol == null ? 0.12 : vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      osc.connect(gain); gain.connect(this.master || this.ctx.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    },
    // Oscillator that glides from f1 to f2 (for pings/sweeps).
    glide(f1, f2, dur, type, vol, off) {
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime + (off || 0);
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(f1, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t0 + dur);
      gain.gain.setValueAtTime(vol == null ? 0.12 : vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      osc.connect(gain); gain.connect(this.master || this.ctx.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    },
    // Filtered noise burst (for the explosion boom body).
    noise(dur, vol, off, lpStart, lpEnd) {
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime + (off || 0);
      const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = this.ctx.createBufferSource(); src.buffer = buf;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(vol == null ? 0.2 : vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      let node = src;
      if (typeof this.ctx.createBiquadFilter === 'function') {
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(lpStart || 1800, t0);
        lp.frequency.exponentialRampToValueAtTime(lpEnd || 300, t0 + dur);
        src.connect(lp); lp.connect(gain);
      } else {
        src.connect(gain);
      }
      gain.connect(this.master || this.ctx.destination);
      src.start(t0); src.stop(t0 + dur + 0.02);
    },
    playBounce() { this.beep(320, 0.04, 'square', 0.05); },
    playPickup() { this.beep(660, 0.08, 'triangle', 0.10); this.beep(880, 0.08, 'triangle', 0.09, 0.05); },
    // Knife kill — explosion boom: a punchy low sine drop + a filtered noise
    // burst for the "blast" body.
    playElim() {
      this.glide(180, 40, 0.34, 'sine', 0.22);          // deep boom thump
      this.noise(0.30, 0.20, 0, 2200, 250);             // blast crackle
      this.beep(70, 0.30, 'sawtooth', 0.14, 0.02);      // rumble tail
    },
    // Shield block — bright metallic ping (two detuned high glides = "ting").
    playShield() {
      this.glide(1400, 2100, 0.16, 'triangle', 0.16);
      this.glide(2000, 2950, 0.18, 'sine', 0.10, 0.01);
      this.beep(3100, 0.05, 'square', 0.05, 0.0);       // tiny metallic edge
    },
    // Reach exit — rising success chime (three-note arpeggio up).
    playExit() {
      this.beep(784, 0.12, 'triangle', 0.13, 0.00);     // G5
      this.beep(988, 0.12, 'triangle', 0.13, 0.08);     // B5
      this.beep(1319, 0.20, 'triangle', 0.14, 0.16);    // E6
    },
    playFinish() { [523, 659, 784, 1047].forEach((f, i) => this.beep(f, 0.22, 'square', 0.13, i * 0.11)); },
    playCount(h) { this.beep(h ? 880 : 440, 0.14, 'square', 0.14); },
    playSelect() { this.beep(620, 0.08, 'triangle', 0.10); },
    startMusic() {
      if (!this.ctx || this.bg) return;
      const osc = this.ctx.createOscillator();
      const lfo = this.ctx.createOscillator();
      const lfoGain = this.ctx.createGain();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth'; osc.frequency.value = 68;
      lfo.type = 'sine'; lfo.frequency.value = 5; lfoGain.gain.value = 7;
      gain.gain.value = 0;
      lfo.connect(lfoGain); lfoGain.connect(osc.frequency);
      osc.connect(gain); gain.connect(this.master || this.ctx.destination);
      const now = this.ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.045, now + 0.6);
      osc.start(); lfo.start();
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
        osc.stop(now + 0.3); lfo.stop(now + 0.3);
      } catch (e) { /* ignore */ }
      this.bg = null;
    }
  };
  GameAudio.init();

  /* =========================================================
   * SHARED CONSTANTS
   * ========================================================= */
  const SQUARE_SIZE = 22;
  const COLORS = {
    yellow: '#FFD700', blue: '#4169E1', green: '#228B22', red: '#CC0000'
  };
  const COLOR_ORDER = ['yellow', 'blue', 'green', 'red'];
  // Per-color base speed (px/sec). Yellow fastest .. blue slowest.
  // Speeds reduced 30% from the original tuning so motion is easy to follow.
  const COLOR_SPEED = { yellow: 175, red: 161, green: 150, blue: 140 };

  /* =========================================================
   * MAZE LAYOUTS (hardcoded, 5 SINGLE-PATH designs)
   *
   * Legend per cell character:
   *   '#' wall   '.' open   'S' start/entry   'E' exit
   *
   * Each maze is a SINGLE continuous corridor (one route from IN to EX with
   * NO branching). Every open cell lies on that one path — there are no
   * choices and no dead-ends except the entry and exit. The squares bounce
   * back and forth along the corridor and eventually reach the exit.
   *
   * All layouts are rectangular (equal-length rows) and the border is solid
   * wall except where the entry/exit sit. Verified single-path (no cell has
   * degree >= 3; exactly two degree-1 endpoints: S and E).
   * ========================================================= */
  const MAZE_LAYOUTS = [
    // 1 — horizontal serpentine (wide switchback corridor)
    [
      '###############',
      '#S............#',
      '#############.#',
      '#.............#',
      '#.#############',
      '#.............#',
      '#############.#',
      '#.............#',
      '#.#############',
      '#.............#',
      '#############.#',
      '#.............#',
      '#.#############',
      '#............E#',
      '###############'
    ],
    // 2 — vertical serpentine (narrow weaving lanes)
    [
      '###############',
      '#S#...#...#...#',
      '#.#.#.#.#.#.#.#',
      '#.#.#.#.#.#.#.#',
      '#.#.#.#.#.#.#.#',
      '#.#.#.#.#.#.#.#',
      '#.#.#.#.#.#.#.#',
      '#.#.#.#.#.#.#.#',
      '#.#.#.#.#.#.#.#',
      '#.#.#.#.#.#.#.#',
      '#.#.#.#.#.#.#.#',
      '#.#.#.#.#.#.#.#',
      '#.#.#.#.#.#.#.#',
      '#...#...#...#E#',
      '###############'
    ],
    // 3 — horizontal serpentine, flipped (start bottom, exit top)
    [
      '###############',
      '#............E#',
      '#.#############',
      '#.............#',
      '#############.#',
      '#.............#',
      '#.#############',
      '#.............#',
      '#############.#',
      '#.............#',
      '#.#############',
      '#.............#',
      '#############.#',
      '#S............#',
      '###############'
    ],
    // 4 — wide vertical lanes (thick pillars between lanes)
    [
      '###############',
      '#S##....##....#',
      '#.##.##.##.##.#',
      '#.##.##.##.##.#',
      '#.##.##.##.##.#',
      '#.##.##.##.##.#',
      '#.##.##.##.##.#',
      '#.##.##.##.##.#',
      '#.##.##.##.##.#',
      '#.##.##.##.##.#',
      '#.##.##.##.##.#',
      '#.##.##.##.##.#',
      '#.##.##.##.##.#',
      '#....##....##E#',
      '###############'
    ],
    // 5 — double-thick horizontal serpentine (longer winding run)
    [
      '###############',
      '#S............#',
      '#############.#',
      '#############.#',
      '#.............#',
      '#.#############',
      '#.#############',
      '#.............#',
      '#############.#',
      '#############.#',
      '#.............#',
      '#.#############',
      '#.#############',
      '#............E#',
      '###############'
    ]
  ];

  // Live maze object (geometry computed from the active layout).
  const MAZE = {
    grid: null,      // 2D array of chars
    rows: 0, cols: 0,
    cellW: 0, cellH: 0,
    offX: 0, offY: 0, // top-left pixel of the maze (fills screen, so 0,0)
    start: null,     // {x,y} pixel center of entry
    exit: null,      // {x,y} pixel center of exit + {cx,cy} cell
    exitCell: null,
    startCell: null,
    walls: []        // pixel rects [{x,y,w,h}] for internal+border walls
  };

  function loadStage(index) {
    const layout = MAZE_LAYOUTS[index % MAZE_LAYOUTS.length];
    MAZE.grid = layout.map(row => row.split(''));
    MAZE.rows = MAZE.grid.length;
    MAZE.cols = MAZE.grid[0].length;
    layoutMaze();
  }

  // Compute pixel geometry so the maze fills the whole screen.
  function layoutMaze() {
    MAZE.cellW = view.w / MAZE.cols;
    MAZE.cellH = view.h / MAZE.rows;
    MAZE.offX = 0;
    MAZE.offY = 0;

    MAZE.walls = [];
    let startCell = null, exitCell = null;
    for (let r = 0; r < MAZE.rows; r++) {
      for (let c = 0; c < MAZE.cols; c++) {
        const ch = MAZE.grid[r][c];
        if (ch === '#') {
          MAZE.walls.push({
            x: c * MAZE.cellW, y: r * MAZE.cellH,
            w: MAZE.cellW, h: MAZE.cellH
          });
        } else if (ch === 'S') {
          startCell = { c, r };
        } else if (ch === 'E') {
          exitCell = { c, r };
        }
      }
    }
    if (startCell) {
      MAZE.startCell = startCell;
      MAZE.start = cellCenter(startCell.c, startCell.r);
    }
    if (exitCell) {
      MAZE.exitCell = exitCell;
      MAZE.exit = cellCenter(exitCell.c, exitCell.r);
    }
  }

  function cellCenter(c, r) {
    return { x: c * MAZE.cellW + MAZE.cellW / 2, y: r * MAZE.cellH + MAZE.cellH / 2 };
  }

  // Is the cell containing a pixel point a wall?
  function isWallAtPixel(px, py) {
    const c = Math.floor(px / MAZE.cellW);
    const r = Math.floor(py / MAZE.cellH);
    if (r < 0 || c < 0 || r >= MAZE.rows || c >= MAZE.cols) return true;
    return MAZE.grid[r][c] === '#';
  }

  // Visual-effect tuning.
  const SHIELD_FLASH_TIME = 0.5; // seconds for the blue shield ripple

  /* =========================================================
   * PARTICLES (death explosion fragments)
   * ========================================================= */
  let PARTICLES = [];

  // Burst a cluster of small colored fragments outward from (x,y).
  function spawnExplosion(x, y, color) {
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const sp = 80 + Math.random() * 170;
      PARTICLES.push({
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        size: 3 + Math.random() * 4,
        life: 0.5 + Math.random() * 0.35,
        maxLife: 0.85,
        color,
        spin: (Math.random() - 0.5) * 16,
        angle: Math.random() * Math.PI
      });
    }
  }

  function updateParticles(dt) {
    for (let i = PARTICLES.length - 1; i >= 0; i--) {
      const p = PARTICLES[i];
      p.life -= dt;
      if (p.life <= 0) { PARTICLES.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.90;          // drag
      p.vy *= 0.90;
      p.vy += 90 * dt;       // slight gravity so fragments settle
      p.angle += p.spin * dt;
    }
  }

  function drawParticles() {
    for (const p of PARTICLES) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.maxLife));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /* =========================================================
   * SQUARES (billiard balls)
   * ========================================================= */
  let SQUARES = [];

  function createSquare(color) {
    return {
      color,
      x: 0, y: 0,
      vx: 0, vy: 0,
      speed: COLOR_SPEED[color],
      angle: 0,                 // only used for the death spin-out animation
      alive: true,
      finished: false,          // reached exit
      eliminated: false,
      eliminationTimer: 0,
      opacity: 1,
      isPlayer: false,
      item: null,               // null | 'knife' | 'shield'
      shieldFlash: 0            // >0 while the blue shield-block ripple plays
    };
  }

  function spawnSquares() {
    SQUARES = COLOR_ORDER.map((color) => {
      const sq = createSquare(color);
      sq.isPlayer = color === STATE.selectedColor;
      // Start clustered near the entry, with a randomized launch direction.
      const jitter = SQUARE_SIZE * 0.6;
      sq.x = MAZE.start.x + (rand() - 0.5) * jitter;
      sq.y = MAZE.start.y + (rand() - 0.5) * jitter;
      const a = rand() * Math.PI * 2;
      sq.vx = Math.cos(a) * sq.speed;
      sq.vy = Math.sin(a) * sq.speed;
      return sq;
    });
  }

  function updateSquares(dt) {
    for (const sq of SQUARES) {
      if (sq.eliminated) { updateEliminated(sq, dt); continue; }
      if (sq.finished) continue;

      moveAndBounce(sq, dt);
      // No self-rotation: squares do not spin on themselves. They move straight
      // and only change direction by reflecting off walls (handled above).

      // Pickup loot.
      tryPickup(sq);

      // Reached exit?
      if (reachedExit(sq)) {
        sq.finished = true;
        sq.vx = sq.vy = 0;
        STATE.stageFinishers.push(sq.color);
        GameAudio.playExit();
      }
    }

    // Square-vs-square interactions (knife / shield / push).
    resolveSquareContacts();
  }

  // PURE BILLIARD PHYSICS — reflection off walls only.
  //
  // The square moves in a straight line at constant speed. It has ZERO
  // knowledge of where the exit is: no pathfinding, no attraction, no steering.
  // Direction only ever changes when the square physically collides with a
  // wall, and then it reflects (angle of incidence = angle of reflection):
  //   - hit a VERTICAL wall   -> flip vx
  //   - hit a HORIZONTAL wall -> flip vy
  // We step the axes separately so we know which kind of wall was struck.
  function moveAndBounce(sq, dt) {
    const half = SQUARE_SIZE / 2;

    // --- X axis: move, and if we'd enter a wall, reflect vx (vertical wall) ---
    const nx = sq.x + sq.vx * dt;
    if (sq.vx > 0 && isWallAtPixel(nx + half, sq.y)) {
      sq.vx = -sq.vx; bounceFx(sq);           // reflect off vertical wall
    } else if (sq.vx < 0 && isWallAtPixel(nx - half, sq.y)) {
      sq.vx = -sq.vx; bounceFx(sq);
    } else {
      sq.x = nx;                              // no wall: advance straight
    }

    // --- Y axis: move, and if we'd enter a wall, reflect vy (horizontal wall) ---
    const ny = sq.y + sq.vy * dt;
    if (sq.vy > 0 && isWallAtPixel(sq.x, ny + half)) {
      sq.vy = -sq.vy; bounceFx(sq);           // reflect off horizontal wall
    } else if (sq.vy < 0 && isWallAtPixel(sq.x, ny - half)) {
      sq.vy = -sq.vy; bounceFx(sq);
    } else {
      sq.y = ny;                              // no wall: advance straight
    }

    // Safety clamp to keep the square on-screen (the border is solid wall, so
    // this only guards against numerical drift — it does NOT change vx/vy).
    sq.x = Math.max(half, Math.min(view.w - half, sq.x));
    sq.y = Math.max(half, Math.min(view.h - half, sq.y));
  }

  let _bounceCooldown = 0;
  function bounceFx(sq) {
    // Throttle bounce sound so it doesn't machine-gun.
    const now = performance.now();
    if (now - _bounceCooldown > 60) { GameAudio.playBounce(); _bounceCooldown = now; }
  }

  function reachedExit(sq) {
    if (!MAZE.exit) return false;
    return Math.hypot(sq.x - MAZE.exit.x, sq.y - MAZE.exit.y) < (MAZE.cellW + MAZE.cellH) / 4 + 2;
  }

  function tryPickup(sq) {
    if (sq.item) return; // one item max
    for (const loot of LOOT) {
      if (loot.taken) continue;
      if (Math.hypot(sq.x - loot.x, sq.y - loot.y) < SQUARE_SIZE * 0.8) {
        loot.taken = true;
        sq.item = loot.type;
        GameAudio.playPickup();
        break;
      }
    }
  }

  function resolveSquareContacts() {
    for (let i = 0; i < SQUARES.length; i++) {
      const a = SQUARES[i];
      if (a.eliminated || a.finished) continue;
      for (let j = i + 1; j < SQUARES.length; j++) {
        const b = SQUARES[j];
        if (b.eliminated || b.finished) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy);
        if (dist >= SQUARE_SIZE || dist < 0.0001) continue;

        // Knife combat: a knife-carrier kills the other on contact, unless the
        // victim has a shield (which is consumed).
        const aKnife = a.item === 'knife';
        const bKnife = b.item === 'knife';

        if (aKnife && !bKnife) { knifeStrike(a, b); }
        else if (bKnife && !aKnife) { knifeStrike(b, a); }
        else if (aKnife && bKnife) {
          // both carry knives: mutual — shields decide survival
          knifeStrike(a, b); knifeStrike(b, a);
        }

        // Elastic-ish separation/bounce if both still active.
        if (!a.eliminated && !b.eliminated && !a.finished && !b.finished) {
          const nx = dx / dist, ny = dy / dist;
          const overlap = SQUARE_SIZE - dist;
          a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
          b.x += nx * overlap / 2; b.y += ny * overlap / 2;
          // swap velocity components along the normal (billiard-like)
          const aDot = a.vx * nx + a.vy * ny;
          const bDot = b.vx * nx + b.vy * ny;
          a.vx += (bDot - aDot) * nx; a.vy += (bDot - aDot) * ny;
          b.vx += (aDot - bDot) * nx; b.vy += (aDot - bDot) * ny;
          renormSpeed(a); renormSpeed(b);
        }
      }
    }
  }

  function renormSpeed(sq) {
    const sp = Math.hypot(sq.vx, sq.vy);
    if (sp > 0.0001) { sq.vx = (sq.vx / sp) * sq.speed; sq.vy = (sq.vy / sp) * sq.speed; }
  }

  // attacker (knife carrier) strikes victim.
  // The knife is SINGLE USE: as soon as the attacker connects with another
  // square (whether it kills, or is blocked by the victim's shield), the
  // attacker's knife is immediately consumed. One kill (or block) per pickup.
  function knifeStrike(attacker, victim) {
    if (victim.eliminated || victim.finished) return;
    if (attacker && attacker.item !== 'knife') return; // knife already spent
    if (victim.item === 'shield') {
      victim.item = null;            // shield absorbs one hit, then gone
      victim.shieldFlash = SHIELD_FLASH_TIME; // blue ripple effect
      if (attacker) attacker.item = null;     // knife is spent on contact
      GameAudio.playShield();
      return;
    }
    if (attacker) attacker.item = null;        // knife consumed on the kill
    eliminate(victim);
  }

  function eliminate(sq) {
    if (sq.eliminated) return;
    sq.eliminated = true;
    sq.alive = false;
    sq.eliminationTimer = 0.6;
    sq.vx = sq.vy = 0;
    // Burst of colored fragments where the square died.
    spawnExplosion(sq.x, sq.y, COLORS[sq.color]);
    // Record elimination separately; eliminated squares are placed AFTER all
    // finishers (worst positions), with the last-to-die ranked higher.
    STATE.eliminatedOrder.push(sq.color);
    GameAudio.playElim();   // explosion boom
  }

  function updateEliminated(sq, dt) {
    sq.eliminationTimer -= dt;
    sq.angle += 14 * dt;
    sq.opacity = Math.max(0, sq.eliminationTimer);
  }

  function drawSquare(sq) {
    if (sq.opacity <= 0 && sq.eliminated) return;
    const half = SQUARE_SIZE / 2;
    ctx.save();
    ctx.globalAlpha = sq.opacity;
    ctx.translate(sq.x, sq.y);
    ctx.rotate(sq.angle);

    if (sq.isPlayer && !sq.eliminated) {
      ctx.shadowColor = COLORS[sq.color]; ctx.shadowBlur = 14;
    }
    ctx.fillStyle = COLORS[sq.color];
    ctx.fillRect(-half, -half, SQUARE_SIZE, SQUARE_SIZE);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 2;
    ctx.strokeRect(-half, -half, SQUARE_SIZE, SQUARE_SIZE);
    ctx.restore();

    // Carried item icon (unrotated, above the square).
    if (sq.item && !sq.eliminated && !sq.finished) {
      drawItemIcon(sq.x, sq.y - half - 9, sq.item, 12);
    }
    // Shield-block ripple: an expanding blue ring + bright flash when a shield
    // successfully absorbs a knife hit.
    if (sq.shieldFlash > 0) {
      const t = sq.shieldFlash / SHIELD_FLASH_TIME;   // 1 -> 0
      ctx.save();
      // expanding ripple ring
      const ripple = half + 4 + (1 - t) * 22;
      ctx.globalAlpha = Math.max(0, t);
      ctx.strokeStyle = '#9fe7ff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sq.x, sq.y, ripple, 0, Math.PI * 2);
      ctx.stroke();
      // inner bright flash that fades fast
      ctx.globalAlpha = Math.max(0, t) * 0.55;
      ctx.fillStyle = '#cdefff';
      ctx.beginPath();
      ctx.arc(sq.x, sq.y, half + 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  function drawSquares() {
    for (const sq of SQUARES) if (sq.eliminated) drawSquare(sq);
    for (const sq of SQUARES) if (!sq.eliminated) drawSquare(sq);
  }

  /* =========================================================
   * LOOT (knives + shields on the maze floor)
   * ========================================================= */
  let LOOT = [];

  function listOpenCells() {
    const cells = [];
    for (let r = 1; r < MAZE.rows - 1; r++) {
      for (let c = 1; c < MAZE.cols - 1; c++) {
        const ch = MAZE.grid[r][c];
        if (ch === '.' ) cells.push({ c, r });
      }
    }
    return cells;
  }

  function placeLoot() {
    LOOT = [];
    const open = listOpenCells();
    // Avoid spawning right on top of the start cluster.
    const usable = open.filter(cell => {
      const ctr = cellCenter(cell.c, cell.r);
      return Math.hypot(ctr.x - MAZE.start.x, ctr.y - MAZE.start.y) > Math.max(MAZE.cellW, MAZE.cellH) * 1.5;
    });
    // Shuffle (seeded).
    for (let i = usable.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [usable[i], usable[j]] = [usable[j], usable[i]];
    }
    const count = Math.min(usable.length, 5 + Math.floor(rand() * 3)); // 5-7 items
    for (let i = 0; i < count; i++) {
      const cell = usable[i];
      const ctr = cellCenter(cell.c, cell.r);
      // ~55% knives, ~45% shields.
      const type = rand() < 0.55 ? 'knife' : 'shield';
      LOOT.push({ x: ctr.x, y: ctr.y, type, taken: false });
    }
  }

  function drawLoot() {
    for (const loot of LOOT) {
      if (loot.taken) continue;
      drawItemIcon(loot.x, loot.y, loot.type, 13, true);
    }
  }

  // Draw a knife or shield icon centered at (x,y).
  function drawItemIcon(x, y, type, size, onFloor) {
    ctx.save();
    ctx.translate(x, y);
    if (onFloor) {
      // subtle glow disc so loot reads against the bright floor
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.beginPath(); ctx.arc(0, 0, size, 0, Math.PI * 2); ctx.fill();
    }
    if (type === 'knife') {
      // blade
      ctx.fillStyle = '#cfe6ff';
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.8);
      ctx.lineTo(size * 0.28, size * 0.2);
      ctx.lineTo(-size * 0.28, size * 0.2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#3a78c0'; ctx.lineWidth = 1; ctx.stroke();
      // handle
      ctx.fillStyle = '#8B4513';
      ctx.fillRect(-size * 0.16, size * 0.2, size * 0.32, size * 0.5);
    } else { // shield
      ctx.fillStyle = '#5fbef0';
      ctx.beginPath();
      ctx.moveTo(0, -size * 0.85);
      ctx.lineTo(size * 0.7, -size * 0.4);
      ctx.lineTo(size * 0.7, size * 0.25);
      ctx.lineTo(0, size * 0.85);
      ctx.lineTo(-size * 0.7, size * 0.25);
      ctx.lineTo(-size * 0.7, -size * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#2c6f9e'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.strokeStyle = '#eaf6ff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, -size * 0.5); ctx.lineTo(0, size * 0.4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-size * 0.4, 0); ctx.lineTo(size * 0.4, 0); ctx.stroke();
    }
    ctx.restore();
  }

  /* =========================================================
   * MAZE RENDERING (fills the whole screen)
   * ========================================================= */
  function drawMaze() {
    // Floor fills the entire screen first (no dark bg visible).
    ctx.fillStyle = '#e9edf2';
    ctx.fillRect(0, 0, view.w, view.h);

    // Floor tint checker for readability.
    ctx.fillStyle = 'rgba(60,80,110,0.05)';
    for (let r = 0; r < MAZE.rows; r++) {
      for (let c = 0; c < MAZE.cols; c++) {
        if (MAZE.grid[r][c] !== '#' && (r + c) % 2 === 0) {
          ctx.fillRect(c * MAZE.cellW, r * MAZE.cellH, MAZE.cellW, MAZE.cellH);
        }
      }
    }

    // Walls.
    for (const w of MAZE.walls) {
      ctx.fillStyle = '#2b2f44';
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(w.x, w.y, w.w, 3); // top highlight
    }

    // Entry marker.
    if (MAZE.start) {
      ctx.fillStyle = 'rgba(46,204,113,0.30)';
      ctx.fillRect(MAZE.start.x - MAZE.cellW / 2, MAZE.start.y - MAZE.cellH / 2, MAZE.cellW, MAZE.cellH);
      ctx.fillStyle = '#2ecc71';
      ctx.font = `bold ${Math.min(MAZE.cellW, MAZE.cellH) * 0.5}px monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('IN', MAZE.start.x, MAZE.start.y);
    }
    // Exit marker (pulsing).
    if (MAZE.exit) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
      ctx.fillStyle = `rgba(255,215,0,${0.25 + 0.35 * pulse})`;
      ctx.fillRect(MAZE.exit.x - MAZE.cellW / 2, MAZE.exit.y - MAZE.cellH / 2, MAZE.cellW, MAZE.cellH);
      ctx.fillStyle = '#FFB000';
      ctx.font = `bold ${Math.min(MAZE.cellW, MAZE.cellH) * 0.5}px monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('EX', MAZE.exit.x, MAZE.exit.y);
    }
    ctx.textBaseline = 'alphabetic';
  }

  /* =========================================================
   * STAGE / RACE LIFECYCLE
   * ========================================================= */
  function newGame() {
    STATE.stageIndex = 0;
    STATE.points = {}; COLOR_ORDER.forEach(c => STATE.points[c] = 0);
    startStage(0);
  }

  function startStage(index) {
    GameAudio.stopMusic();
    STATE.stageIndex = index;
    STATE.stagePlacements = [];
    STATE.stageFinishers = [];
    STATE.eliminatedOrder = [];
    STATE._stageSettled = false;
    STATE.raceTimer = 0;
    rand = mulberry32((Date.now() ^ (index * 0x9e3779b1)) >>> 0);
    PARTICLES = [];
    loadStage(index);
    spawnSquares();
    placeLoot();
    STATE.introTimer = 2.0; // countdown-ish intro
    STATE.current = 'STAGE_INTRO';
    GameAudio.playCount(false);
  }

  // Build the full per-stage placement list (finishers/eliminations already
  // pushed in event order) and award points.
  function settleStage() {
    if (STATE._stageSettled) return;
    STATE._stageSettled = true;
    // Finishers first (in exit order), then eliminated squares placed LAST
    // with the last-to-die ranked higher than the first-to-die.
    const finishers = STATE.stageFinishers.slice();
    const eliminated = STATE.eliminatedOrder.slice().reverse();
    const placed = finishers.concat(eliminated.filter(c => !finishers.includes(c)));
    for (const c of COLOR_ORDER) if (!placed.includes(c)) placed.push(c); // safety
    STATE.stagePlacements = placed;
    // Award points by placement (1st=4 .. 4th=1).
    placed.forEach((color, i) => {
      STATE.points[color] = (STATE.points[color] || 0) + (STAGE_POINTS[i] || 0);
    });
    GameAudio.stopMusic();
    GameAudio.playFinish();
  }

  function cumulativeRanking() {
    return COLOR_ORDER.slice().sort((a, b) => (STATE.points[b] - STATE.points[a]));
  }

  /* =========================================================
   * SCREENS
   * ========================================================= */

  // ---- TITLE ----
  let titleSquares = [];
  function initTitle() {
    titleSquares = COLOR_ORDER.map(color => ({
      color,
      x: Math.random() * view.w, y: Math.random() * view.h,
      vx: (Math.random() - 0.5) * 160, vy: (Math.random() - 0.5) * 160,
      size: 22 + Math.random() * 26, angle: Math.random() * Math.PI
    }));
  }
  function updateTitle(dt) {
    if (titleSquares.length === 0) initTitle();
    for (const s of titleSquares) {
      s.x += s.vx * dt; s.y += s.vy * dt; s.angle += 1.4 * dt;
      const h = s.size / 2;
      if (s.x < h) { s.x = h; s.vx = Math.abs(s.vx); }
      if (s.x > view.w - h) { s.x = view.w - h; s.vx = -Math.abs(s.vx); }
      if (s.y < h) { s.y = h; s.vy = Math.abs(s.vy); }
      if (s.y > view.h - h) { s.y = view.h - h; s.vy = -Math.abs(s.vy); }
    }
    if (Input.tapped) { GameAudio.unlock(); GameAudio.playSelect(); Input.consume(); STATE.current = 'SELECT'; }
  }
  function drawTitle() {
    ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, view.w, view.h);
    for (const s of titleSquares) {
      ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.angle);
      ctx.fillStyle = COLORS[s.color] + '99';
      ctx.fillRect(-s.size / 2, -s.size / 2, s.size, s.size);
      ctx.restore();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.font = 'bold 50px monospace';
    ctx.fillText('MAZE', view.w / 2 + 2, view.h * 0.34 + 2);
    ctx.fillText('RUNNERS', view.w / 2 + 2, view.h * 0.34 + 52);
    ctx.fillStyle = '#fff'; ctx.fillText('MAZE', view.w / 2, view.h * 0.34);
    ctx.fillStyle = '#FFD700'; ctx.fillText('RUNNERS', view.w / 2, view.h * 0.34 + 50);
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 400);
    ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.55 * pulse})`;
    ctx.font = 'bold 20px monospace';
    ctx.fillText('TAP TO PLAY', view.w / 2, view.h * 0.74);
  }

  // ---- SELECT ----
  const TRAITS = {
    yellow: 'FASTEST \u2014 hardest to control',
    red:    'QUICK \u2014 aggressive bouncer',
    green:  'STEADY \u2014 balanced pace',
    blue:   'SLOWEST \u2014 calm and careful'
  };
  function selectLayout() {
    const rowH = 70, gap = 14;
    const listW = Math.min(view.w - 36, 360);
    const x = (view.w - listW) / 2;
    const top = view.h * 0.26;
    const rows = COLOR_ORDER.map((color, i) => ({ color, x, y: top + i * (rowH + gap), w: listW, h: rowH }));
    const raceBtn = { x: view.w / 2 - 110, y: top + 4 * (rowH + gap) + 10, w: 220, h: 56 };
    return { rows, raceBtn };
  }
  function pointInRect(px, py, r) { return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h; }
  function updateSelect(dt) {
    if (!Input.tapped) return;
    const { rows, raceBtn } = selectLayout();
    for (const r of rows) {
      if (pointInRect(Input.tapX, Input.tapY, r)) { STATE.selectedColor = r.color; GameAudio.playSelect(); Input.consume(); return; }
    }
    if (STATE.selectedColor && pointInRect(Input.tapX, Input.tapY, raceBtn)) { Input.consume(); newGame(); return; }
    Input.consume();
  }
  function drawSelect() {
    ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, view.w, view.h);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center';
    ctx.fillText('CHOOSE YOUR SQUARE', view.w / 2, view.h * 0.16);
    const { rows, raceBtn } = selectLayout();
    for (const r of rows) {
      const sel = STATE.selectedColor === r.color;
      const wig = sel ? Math.sin(Date.now() / 110) * 3 : 0;
      ctx.fillStyle = sel ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)';
      roundRect(r.x, r.y, r.w, r.h, 12); ctx.fill();
      if (sel) { ctx.strokeStyle = COLORS[r.color]; ctx.lineWidth = 3; roundRect(r.x, r.y, r.w, r.h, 12); ctx.stroke(); }
      const sw = r.h - 24, sx = r.x + 14 + wig, sy = r.y + 12;
      if (sel) { ctx.shadowColor = COLORS[r.color]; ctx.shadowBlur = 16; }
      ctx.fillStyle = COLORS[r.color]; ctx.fillRect(sx, sy, sw, sw); ctx.shadowBlur = 0;
      const tx = r.x + 14 + sw + 16;
      ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.font = 'bold 16px monospace';
      ctx.fillText(r.color.toUpperCase(), tx, r.y + 30);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '12px monospace';
      ctx.fillText(TRAITS[r.color], tx, r.y + 50);
    }
    const enabled = !!STATE.selectedColor;
    ctx.fillStyle = enabled ? '#FFD700' : 'rgba(255,255,255,0.12)';
    roundRect(raceBtn.x, raceBtn.y, raceBtn.w, raceBtn.h, 14); ctx.fill();
    ctx.fillStyle = enabled ? '#1a1a2e' : 'rgba(255,255,255,0.4)';
    ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center';
    ctx.fillText(enabled ? '\u25B6  START' : 'PICK A SQUARE', raceBtn.x + raceBtn.w / 2, raceBtn.y + raceBtn.h / 2 + 8);
  }

  // ---- STAGE_INTRO ----
  function updateStageIntro(dt) {
    STATE.introTimer -= dt;
    if (STATE.introTimer <= 0) { STATE.current = 'RACE'; GameAudio.startMusic(); }
  }
  function drawStageIntro() {
    drawMaze(); drawLoot(); drawSquares();
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, view.w, view.h);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFD700'; ctx.font = 'bold 40px monospace';
    ctx.fillText('STAGE ' + (STATE.stageIndex + 1), view.w / 2, view.h / 2 - 10);
    ctx.fillStyle = '#fff'; ctx.font = '16px monospace';
    ctx.fillText('of ' + MAZE_LAYOUTS.length + '  \u2014  reach the EXIT', view.w / 2, view.h / 2 + 24);
    const go = STATE.introTimer < 0.6;
    if (go) { ctx.fillStyle = '#37e06a'; ctx.font = 'bold 30px monospace'; ctx.fillText('GO!', view.w / 2, view.h / 2 + 70); }
  }

  // ---- RACE ----
  const MUTE_BTN = { x: 0, y: 12, w: 40, h: 40 };
  function updateRace(dt) {
    if (Input.tapped) {
      MUTE_BTN.x = view.w - 52;
      if (pointInRect(Input.tapX, Input.tapY, MUTE_BTN)) GameAudio.toggleMute();
      Input.consume();
    }
    // tick shield-flash timers + explosion particles
    for (const sq of SQUARES) if (sq.shieldFlash > 0) sq.shieldFlash -= dt;
    updateParticles(dt);

    STATE.raceTimer += dt;

    updateSquares(dt);

    // 2-minute safety cap (the ONLY fallback): pure billiard motion has no
    // guarantee of bouncing into the exit, so if a stage is still going after
    // STAGE_TIME_LIMIT we place any remaining squares by how close they happen
    // to be to the exit. This is not pathfinding — squares never steer toward
    // the exit during play; this only stops a stage from running forever.
    if (STATE.raceTimer >= STAGE_TIME_LIMIT) {
      const remaining = SQUARES.filter(s => !s.finished && !s.eliminated);
      remaining.sort((a, b) => {
        const da = MAZE.exit ? Math.hypot(a.x - MAZE.exit.x, a.y - MAZE.exit.y) : 0;
        const db = MAZE.exit ? Math.hypot(b.x - MAZE.exit.x, b.y - MAZE.exit.y) : 0;
        return da - db;
      });
      for (const sq of remaining) {
        sq.finished = true;
        sq.vx = sq.vy = 0;
        if (MAZE.exit) { sq.x = MAZE.exit.x; sq.y = MAZE.exit.y; }
        STATE.stageFinishers.push(sq.color);
      }
      if (remaining.length) GameAudio.playExit();
    }

    // Stage ends when no square is still actively running.
    const active = SQUARES.some(s => !s.finished && !s.eliminated);
    if (!active) {
      settleStage();
      STATE.current = 'STAGE_RESULT';
    }
  }
  function drawRace() {
    drawMaze();
    drawLoot();
    drawSquares();
    drawParticles();
    drawRaceHUD();
  }
  function drawRaceHUD() {
    // Stage label.
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(12, 12, 132, 34, 9); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 16px monospace'; ctx.textAlign = 'left';
    ctx.fillText('STAGE ' + (STATE.stageIndex + 1) + '/' + MAZE_LAYOUTS.length, 22, 35);

    // Mute button.
    MUTE_BTN.x = view.w - 52;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; roundRect(MUTE_BTN.x, MUTE_BTN.y, MUTE_BTN.w, MUTE_BTN.h, 9); ctx.fill();
    drawSpeaker(MUTE_BTN.x + MUTE_BTN.w / 2, MUTE_BTN.y + MUTE_BTN.h / 2, GameAudio.muted);

    // Live standings chips (who has exited).
    const exited = STATE.stageFinishers.length;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(view.w / 2 - 78, 12, 156, 28, 8); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '12px monospace'; ctx.textAlign = 'center';
    ctx.fillText('FINISHED: ' + exited + '/4', view.w / 2, 31);
  }
  function drawSpeaker(cx, cy, muted) {
    ctx.save(); ctx.translate(cx, cy); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-9, -4); ctx.lineTo(-3, -4); ctx.lineTo(3, -9); ctx.lineTo(3, 9); ctx.lineTo(-3, 4); ctx.lineTo(-9, 4); ctx.closePath(); ctx.fill();
    if (muted) { ctx.beginPath(); ctx.moveTo(7, -6); ctx.lineTo(13, 6); ctx.moveTo(13, -6); ctx.lineTo(7, 6); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(6, 0, 4, -Math.PI / 3, Math.PI / 3); ctx.stroke(); ctx.beginPath(); ctx.arc(6, 0, 8, -Math.PI / 3, Math.PI / 3); ctx.stroke(); }
    ctx.restore();
  }

  // ---- STAGE_RESULT ----
  function stageResultLayout() {
    const isLast = STATE.stageIndex >= MAZE_LAYOUTS.length - 1;
    const btn = { x: view.w / 2 - 130, y: view.h - 96, w: 260, h: 56, isLast };
    return { btn };
  }
  function updateStageResult(dt) {
    if (!Input.tapped) return;
    const { btn } = stageResultLayout();
    if (pointInRect(Input.tapX, Input.tapY, btn)) {
      GameAudio.playSelect(); Input.consume();
      if (btn.isLast) { STATE.current = 'FINAL_RESULT'; }
      else { startStage(STATE.stageIndex + 1); }
    } else { Input.consume(); }
  }
  function drawStageResult(dt) {
    ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, view.w, view.h);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFD700'; ctx.font = 'bold 28px monospace';
    ctx.fillText('STAGE ' + (STATE.stageIndex + 1) + ' RESULTS', view.w / 2, view.h * 0.12);

    const medals = ['1', '2', '3', '4'];
    const mcol = ['#FFD700', '#C0C0C0', '#CD7F32', '#777'];
    const top = view.h * 0.22, rowH = 54, listW = Math.min(view.w - 48, 360), lx = (view.w - listW) / 2;
    STATE.stagePlacements.forEach((color, i) => {
      const y = top + i * rowH;
      ctx.fillStyle = 'rgba(255,255,255,0.05)'; roundRect(lx, y, listW, rowH - 8, 10); ctx.fill();
      ctx.fillStyle = mcol[i]; ctx.beginPath(); ctx.arc(lx + 26, y + (rowH - 8) / 2, 14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a1a2e'; ctx.font = 'bold 15px monospace'; ctx.textAlign = 'center';
      ctx.fillText(medals[i], lx + 26, y + (rowH - 8) / 2 + 5);
      ctx.fillStyle = COLORS[color]; ctx.fillRect(lx + 50, y + (rowH - 8) / 2 - 11, 22, 22);
      ctx.fillStyle = color === STATE.selectedColor ? '#FFD700' : '#fff';
      ctx.font = 'bold 15px monospace'; ctx.textAlign = 'left';
      const you = color === STATE.selectedColor ? ' (YOU)' : '';
      ctx.fillText(color.toUpperCase() + you, lx + 82, y + (rowH - 8) / 2 + 5);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '13px monospace'; ctx.textAlign = 'right';
      ctx.fillText('+' + STAGE_POINTS[i] + ' pts (tot ' + STATE.points[color] + ')', lx + listW - 12, y + (rowH - 8) / 2 + 5);
    });

    const { btn } = stageResultLayout();
    ctx.fillStyle = '#FFD700'; roundRect(btn.x, btn.y, btn.w, btn.h, 14); ctx.fill();
    ctx.fillStyle = '#1a1a2e'; ctx.font = 'bold 19px monospace'; ctx.textAlign = 'center';
    ctx.fillText(btn.isLast ? 'FINAL STANDINGS' : 'NEXT STAGE \u25B6', btn.x + btn.w / 2, btn.y + btn.h / 2 + 7);
  }

  // ---- FINAL_RESULT ----
  let finalAnim = 0;
  function finalLayout() {
    const playAgain = { x: view.w / 2 - 130, y: view.h - 150, w: 260, h: 54 };
    const changeSq  = { x: view.w / 2 - 130, y: view.h - 84,  w: 260, h: 54 };
    return { playAgain, changeSq };
  }
  function updateFinal(dt) {
    finalAnim += dt;
    if (!Input.tapped) return;
    const { playAgain, changeSq } = finalLayout();
    if (pointInRect(Input.tapX, Input.tapY, playAgain)) { GameAudio.playSelect(); Input.consume(); newGame(); }
    else if (pointInRect(Input.tapX, Input.tapY, changeSq)) { GameAudio.playSelect(); Input.consume(); STATE.current = 'SELECT'; }
    else Input.consume();
  }
  function drawFinal() {
    ctx.fillStyle = '#1a1a2e'; ctx.fillRect(0, 0, view.w, view.h);
    const ranking = cumulativeRanking();
    const champ = ranking[0];
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFD700'; ctx.font = 'bold 30px monospace';
    ctx.fillText('CHAMPION!', view.w / 2, view.h * 0.10);
    const bounce = Math.abs(Math.sin(finalAnim * 4)) * 14;
    ctx.save(); ctx.shadowColor = COLORS[champ]; ctx.shadowBlur = 24; ctx.fillStyle = COLORS[champ];
    ctx.fillRect(view.w / 2 - 28, view.h * 0.20 - 28 - bounce, 56, 56); ctx.restore();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 16px monospace';
    ctx.fillText(champ.toUpperCase() + (champ === STATE.selectedColor ? ' (YOU)' : ''), view.w / 2, view.h * 0.20 + 46);

    const medals = ['1', '2', '3', '4'];
    const mcol = ['#FFD700', '#C0C0C0', '#CD7F32', '#777'];
    const top = view.h * 0.33, rowH = 52, listW = Math.min(view.w - 48, 340), lx = (view.w - listW) / 2;
    ranking.forEach((color, i) => {
      const y = top + i * rowH;
      const appear = Math.min(1, Math.max(0, (finalAnim - i * 0.15) * 4));
      ctx.globalAlpha = appear;
      ctx.fillStyle = 'rgba(255,255,255,0.05)'; roundRect(lx, y, listW, rowH - 8, 10); ctx.fill();
      ctx.fillStyle = mcol[i]; ctx.beginPath(); ctx.arc(lx + 26, y + (rowH - 8) / 2, 14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a1a2e'; ctx.font = 'bold 15px monospace'; ctx.textAlign = 'center';
      ctx.fillText(medals[i], lx + 26, y + (rowH - 8) / 2 + 5);
      ctx.fillStyle = COLORS[color]; ctx.fillRect(lx + 50, y + (rowH - 8) / 2 - 12, 24, 24);
      ctx.fillStyle = color === STATE.selectedColor ? '#FFD700' : '#fff';
      ctx.font = 'bold 16px monospace'; ctx.textAlign = 'left';
      const you = color === STATE.selectedColor ? ' (YOU)' : '';
      ctx.fillText(color.toUpperCase() + you, lx + 84, y + (rowH - 8) / 2 + 6);
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = 'bold 14px monospace'; ctx.textAlign = 'right';
      ctx.fillText(STATE.points[color] + ' pts', lx + listW - 12, y + (rowH - 8) / 2 + 6);
      ctx.globalAlpha = 1;
    });

    const { playAgain, changeSq } = finalLayout();
    ctx.fillStyle = '#FFD700'; roundRect(playAgain.x, playAgain.y, playAgain.w, playAgain.h, 14); ctx.fill();
    ctx.fillStyle = '#1a1a2e'; ctx.font = 'bold 19px monospace'; ctx.textAlign = 'center';
    ctx.fillText('PLAY AGAIN', playAgain.x + playAgain.w / 2, playAgain.y + playAgain.h / 2 + 7);
    ctx.fillStyle = 'rgba(255,255,255,0.14)'; roundRect(changeSq.x, changeSq.y, changeSq.w, changeSq.h, 14); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText('CHANGE SQUARE', changeSq.x + changeSq.w / 2, changeSq.y + changeSq.h / 2 + 7);
  }

  /* =========================================================
   * MAIN LOOP
   * ========================================================= */
  let lastTime = 0;
  function gameLoop(ts) {
    const dt = Math.min((ts - lastTime) / 1000, 0.05);
    lastTime = ts;
    ctx.clearRect(0, 0, view.w, view.h);
    switch (STATE.current) {
      case 'TITLE':        updateTitle(dt);       drawTitle();        break;
      case 'SELECT':       updateSelect(dt);      drawSelect();       break;
      case 'STAGE_INTRO':  updateStageIntro(dt);  drawStageIntro();   break;
      case 'RACE':         updateRace(dt);        drawRace();         break;
      case 'STAGE_RESULT': updateStageResult(dt); drawStageResult(dt);break;
      case 'FINAL_RESULT': updateFinal(dt);       drawFinal();        break;
    }
    requestAnimationFrame(gameLoop);
  }
  requestAnimationFrame(gameLoop);

  // ---- resize: recompute maze geometry now that layoutMaze is defined ----
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', resizeCanvas);
})();
