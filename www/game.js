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

  // Lighten (amt>0) or darken (amt<0) a #rrggbb hex color by a 0..1 fraction.
  function shade(hex, amt) {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    let r = parseInt(h.slice(0, 2), 16);
    let g = parseInt(h.slice(2, 4), 16);
    let b = parseInt(h.slice(4, 6), 16);
    if (amt >= 0) {
      r = Math.round(r + (255 - r) * amt);
      g = Math.round(g + (255 - g) * amt);
      b = Math.round(b + (255 - b) * amt);
    } else {
      const k = 1 + amt; // amt negative
      r = Math.round(r * k); g = Math.round(g * k); b = Math.round(b * k);
    }
    const to2 = v => ('0' + Math.max(0, Math.min(255, v)).toString(16)).slice(-2);
    return '#' + to2(r) + to2(g) + to2(b);
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
  const SQUARE_SIZE = 18; // reduced 20% from 22
  const COLORS = {
    yellow: '#FFD700', blue: '#4169E1', green: '#228B22', red: '#CC0000'
  };
  const COLOR_ORDER = ['yellow', 'blue', 'green', 'red'];
  // Flat solid game colors — NO gradients/checker/grid so nothing reveals cells.
  const BG_COLOR = '#cdd6e3';    // letterbox background (above/below the maze)
  const FLOOR_COLOR = '#e9edf2'; // solid corridor floor
  const WALL_COLOR = '#2b2f44';  // thin wall separator lines
  const WALL_THICKNESS = 4;      // px — walls are thin lines, not full cells
  const FLOOD_COLOR = '#3b32a6'; // solid advancing flood wall
  // Per-color base speed (px/sec). Yellow fastest .. blue slowest.
  // Speeds reduced 30% from the original tuning so motion is easy to follow.
  // Per-color base speeds (already 30% reduced earlier, now a further 20% slower).
  const COLOR_SPEED = { yellow: 140, red: 129, green: 120, blue: 112 };

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
    // Maze grid is 9 wide so cells are large (wide floor). Cells are rendered as
    // PERFECT SQUARES (size = screenWidth/9) and the maze is taller now so it
    // fills most of the portrait screen; any leftover space is the centered,
    // background-colored letterbox. All 5 are validated single-path (S->E).
    // 1 — horizontal serpentine (9x17)
    [
      '#########',
      '#S......#',
      '#######.#',
      '#.......#',
      '#.#######',
      '#.......#',
      '#######.#',
      '#.......#',
      '#.#######',
      '#.......#',
      '#######.#',
      '#.......#',
      '#.#######',
      '#.......#',
      '#######.#',
      '#E......#',
      '#########'
    ],
    // 2 — vertical weaving lanes (9x17)
    [
      '#########',
      '#S#...#E#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#...#...#',
      '#########'
    ],
    // 3 — horizontal serpentine, mirrored (start top-right)
    [
      '#########',
      '#......S#',
      '#.#######',
      '#.......#',
      '#######.#',
      '#.......#',
      '#.#######',
      '#.......#',
      '#######.#',
      '#.......#',
      '#.#######',
      '#.......#',
      '#######.#',
      '#.......#',
      '#.#######',
      '#......E#',
      '#########'
    ],
    // 4 — longer horizontal serpentine (9x19)
    [
      '#########',
      '#S......#',
      '#######.#',
      '#.......#',
      '#.#######',
      '#.......#',
      '#######.#',
      '#.......#',
      '#.#######',
      '#.......#',
      '#######.#',
      '#.......#',
      '#.#######',
      '#.......#',
      '#######.#',
      '#.......#',
      '#.#######',
      '#......E#',
      '#########'
    ],
    // 5 — longer vertical weaving lanes (9x19)
    [
      '#########',
      '#S#...#E#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#.#.#.#.#',
      '#...#...#',
      '#########'
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
    path: [],        // ordered corridor cells S..E (for the advancing wall ONLY)
    walls: []        // pixel rects [{x,y,w,h}] for internal+border walls
  };

  // Walk the single corridor from S to E, returning the ordered cell list.
  // NOTE: this is used ONLY by the advancing blue wall (to know which cell to
  // seal next). The squares themselves never read this — their motion stays
  // pure billiard physics with zero knowledge of the path or the exit.
  function computePath() {
    const path = [];
    if (!MAZE.startCell || !MAZE.exitCell) return path;
    const isOpen = (c, r) => r >= 0 && c >= 0 && r < MAZE.rows && c < MAZE.cols && MAZE.grid[r][c] !== '#';
    let c = MAZE.startCell.c, r = MAZE.startCell.r;
    let pc = -1, pr = -1;
    const guard = MAZE.rows * MAZE.cols + 5;
    for (let i = 0; i < guard; i++) {
      path.push({ c, r });
      if (c === MAZE.exitCell.c && r === MAZE.exitCell.r) break;
      const nbrs = [[c, r - 1], [c, r + 1], [c - 1, r], [c + 1, r]];
      let next = null;
      for (const [nc, nr] of nbrs) {
        if (!isOpen(nc, nr)) continue;
        if (nc === pc && nr === pr) continue;
        next = [nc, nr]; break;
      }
      if (!next) break;
      pc = c; pr = r; c = next[0]; r = next[1];
    }
    return path;
  }

  function loadStage(index) {
    const layout = MAZE_LAYOUTS[index % MAZE_LAYOUTS.length];
    MAZE.grid = layout.map(row => row.split(''));
    MAZE.rows = MAZE.grid.length;
    MAZE.cols = MAZE.grid[0].length;
    layoutMaze();
  }

  // Compute pixel geometry so the maze fills the whole screen.
  function layoutMaze() {
    // PERFECT SQUARE CELLS: size = screen width / columns, used for BOTH width
    // and height. The maze will not fill the full screen height; the leftover
    // space above and below is centered and filled with the background color.
    const cell = view.w / MAZE.cols;
    MAZE.cellW = cell;
    MAZE.cellH = cell;
    MAZE.offX = 0;
    MAZE.offY = Math.max(0, (view.h - cell * MAZE.rows) / 2); // vertical centering

    MAZE.walls = [];
    let startCell = null, exitCell = null;
    for (let r = 0; r < MAZE.rows; r++) {
      for (let c = 0; c < MAZE.cols; c++) {
        const ch = MAZE.grid[r][c];
        if (ch === '#') {
          MAZE.walls.push({
            x: MAZE.offX + c * MAZE.cellW, y: MAZE.offY + r * MAZE.cellH,
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
    MAZE.path = computePath();
  }

  function cellCenter(c, r) {
    return { x: MAZE.offX + c * MAZE.cellW + MAZE.cellW / 2, y: MAZE.offY + r * MAZE.cellH + MAZE.cellH / 2 };
  }

  // Is the cell containing a pixel point a wall?
  // A cell is a wall if it's a layout wall ('#') OR it has been sealed by the
  // advancing blue flood wall behind the squares.
  function isWallAtPixel(px, py) {
    const localX = px - MAZE.offX;
    const localY = py - MAZE.offY;
    if (localX < 0 || localY < 0 || localX >= MAZE.cellW * MAZE.cols || localY >= MAZE.cellH * MAZE.rows) return true;
    if (STATE.stageIndex === 0) return !isInsideStage1Corridor(px, py, 0);
    const c = Math.floor(localX / MAZE.cellW);
    const r = Math.floor(localY / MAZE.cellH);
    if (FLOOD.sealed[r] && FLOOD.sealed[r][c]) return true;
    if (MAZE.grid[r][c] !== '#') return false;
    const inset = WALL_THICKNESS * 0.5;
    const x0 = c * MAZE.cellW;
    const y0 = r * MAZE.cellH;
    const x1 = x0 + MAZE.cellW;
    const y1 = y0 + MAZE.cellH;
    const open = (cc, rr) => rr >= 0 && cc >= 0 && rr < MAZE.rows && cc < MAZE.cols && MAZE.grid[rr][cc] !== '#';
    if ((open(c, r - 1) || r === 0) && localY >= y0 - inset && localY <= y0 + inset && localX >= x0 && localX <= x1) return true;
    if ((open(c, r + 1) || r === MAZE.rows - 1) && localY >= y1 - inset && localY <= y1 + inset && localX >= x0 && localX <= x1) return true;
    if ((open(c - 1, r) || c === 0) && localX >= x0 - inset && localX <= x0 + inset && localY >= y0 && localY <= y1) return true;
    if ((open(c + 1, r) || c === MAZE.cols - 1) && localX >= x1 - inset && localX <= x1 + inset && localY >= y0 && localY <= y1) return true;
    return false;
  }

  // Per-square wall test used by the squares' physics. Identical to
  // isWallAtPixel, but an unbroken colored brick blocks every square EXCEPT
  // the one whose color matches (that square is allowed to enter, which breaks
  // the brick). This is what makes break_match bricks act as colored gates.
  function isWallForSquare(px, py, sq) {
    const localX = px - MAZE.offX;
    const localY = py - MAZE.offY;
    if (localX < 0 || localY < 0 || localX >= MAZE.cellW * MAZE.cols || localY >= MAZE.cellH * MAZE.rows) return true;
    if (STATE.stageIndex === 0) {
      if (!isInsideStage1Corridor(px, py, SQUARE_SIZE * 0.5)) return true;
      return false;
    }
    const c = Math.floor(localX / MAZE.cellW);
    const r = Math.floor(localY / MAZE.cellH);
    if (FLOOD.sealed[r] && FLOOD.sealed[r][c]) return true;
    if (MAZE.grid[r][c] === '#') {
      const inset = WALL_THICKNESS * 0.5;
      const x0 = c * MAZE.cellW;
      const y0 = r * MAZE.cellH;
      const x1 = x0 + MAZE.cellW;
      const y1 = y0 + MAZE.cellH;
      const open = (cc, rr) => rr >= 0 && cc >= 0 && rr < MAZE.rows && cc < MAZE.cols && MAZE.grid[rr][cc] !== '#';
      if ((open(c, r - 1) || r === 0) && localY >= y0 - inset && localY <= y0 + inset && localX >= x0 && localX <= x1) return true;
      if ((open(c, r + 1) || r === MAZE.rows - 1) && localY >= y1 - inset && localY <= y1 + inset && localX >= x0 && localX <= x1) return true;
      if ((open(c - 1, r) || c === 0) && localX >= x0 - inset && localX <= x0 + inset && localY >= y0 && localY <= y1) return true;
      if ((open(c + 1, r) || c === MAZE.cols - 1) && localX >= x1 - inset && localX <= x1 + inset && localY >= y0 && localY <= y1) return true;
      return false;
    }
    const brick = brickAt(c, r);
    if (brick) return brick.color !== sq.color;
    return false;
  }

  // If the square is overlapping a brick of its OWN color, shatter it open.
  function tryBreakBrick(sq) {
    const c = Math.floor((sq.x - MAZE.offX) / MAZE.cellW);
    const r = Math.floor((sq.y - MAZE.offY) / MAZE.cellH);
    const brick = brickAt(c, r);
    if (brick && brick.color === sq.color) {
      brick.broken = true;
      brick.hitFlash = 1;
      spawnBrickShards(brick);
      GameAudio.playBounce();
    }
  }

  /* =========================================================
   * ADVANCING BLUE WALL ("flood")
   *
   * A blue wall grows cell-by-cell ALONG the single corridor from the start,
   * sealing the path behind the squares. This is what guarantees the squares
   * keep moving forward and reach the exit while their motion stays PURE
   * billiard physics (they never steer — the wall just squeezes them ahead).
   *
   * Rule: the flood only PUSHES, it never catches/eliminates. It will not seal
   * the cell that the rearmost still-active square currently occupies (or any
   * cell ahead of it), so a square is always kept just ahead of the wall front.
   * ========================================================= */
  const FLOOD = {
    sealed: [],       // sealed[r][c] = true if cell (c,r) is now a blue wall
    front: 0,         // how many path cells (from start) are sealed
    progress: 0,      // fractional progress used for smooth advance
    speedCells: 0     // path-cells sealed per second (set per stage)
  };

  /* ---------------------------------------------------------
   * COLORED BRICK WALLS (break_match)
   * Some corridor cells hold a brick tinted one square's color. ONLY the
   * matching-color square can break/pass through it; every other square (and
   * the player) treats it as a solid wall and bounces off. When the matching
   * square touches it, the brick shatters (opens) for everyone.
   * Bricks are placed ON path cells, spaced out, so they form breakable gates
   * along the single corridor. The advancing flood guarantees that even a
   * square stuck behind a brick it cannot break gets pushed onward, so no
   * square is ever permanently trapped.
   * ------------------------------------------------------- */
  let BRICKS = []; // [{ c, r, color, broken, hitFlash }]

  function brickAt(c, r) {
    for (const b of BRICKS) {
      if (!b.broken && b.c === c && b.r === r) return b;
    }
    return null;
  }

  function resetBricks() {
    BRICKS = [];
    const path = MAZE.path;
    if (!path || path.length < 8) return;
    // Place bricks on interior path cells, evenly spaced, skipping cells near
    // the start/exit so those stay clear. Rotate the four colors so each
    // square has gates only it can pass.
    const colors = COLOR_ORDER;
    const margin = 3;
    let colorIdx = 0;
    const spacing = 6;
    for (let i = margin; i < path.length - margin; i += spacing) {
      const cell = path[i];
      if (MAZE.startCell && cell.c === MAZE.startCell.c && cell.r === MAZE.startCell.r) continue;
      if (MAZE.exitCell && cell.c === MAZE.exitCell.c && cell.r === MAZE.exitCell.r) continue;
      BRICKS.push({
        c: cell.c, r: cell.r,
        color: colors[colorIdx % colors.length],
        broken: false,
        hitFlash: 0
      });
      colorIdx++;
    }
  }

  function resetFlood() {
    FLOOD.sealed = Array.from({ length: MAZE.rows }, () => new Array(MAZE.cols).fill(false));
    FLOOD.front = 0;
    FLOOD.progress = 0;
    // Tune the advance so a stage finishes in a watchable time: cover the whole
    // path over roughly the available race window.
    const pathLen = Math.max(1, MAZE.path.length);
    FLOOD.speedCells = (STATE.stageIndex === 0 ? pathLen / 68 : pathLen / 87); // Stage 1 denser layout gets a slightly faster sweep; others stay at ~87s
  }

  // Path index of the cell a square currently occupies (-1 if off-path).
  function squarePathIndex(sq) {
    const c = Math.floor((sq.x - MAZE.offX) / MAZE.cellW);
    const r = Math.floor((sq.y - MAZE.offY) / MAZE.cellH);
    for (let i = 0; i < MAZE.path.length; i++) {
      if (MAZE.path[i].c === c && MAZE.path[i].r === r) return i;
    }
    return -1;
  }

  function updateFlood(dt) {
    if (!MAZE.path.length) return;

    // The flood advances steadily regardless of where squares are — it is the
    // "piston" that drives the race. The squares still move with pure billiard
    // physics; the flood simply seals the corridor behind them.
    FLOOD.progress += FLOOD.speedCells * dt;
    const want = Math.min(MAZE.path.length, Math.floor(FLOOD.progress));
    while (FLOOD.front < want) {
      const cell = MAZE.path[FLOOD.front];
      if (cell) {
        FLOOD.sealed[cell.r][cell.c] = true;
        // A brick swallowed by the flood is gone (it becomes part of the wall).
        const b = brickAt(cell.c, cell.r);
        if (b) b.broken = true;
      }
      FLOOD.front++;
    }

    // PUSH (never catch): any active square that is in or behind the sealed
    // front gets relocated just ahead of the front and re-launched forward,
    // so the wall keeps it moving but never swallows it.
    for (const sq of SQUARES) {
      if (sq.finished || sq.eliminated) continue;
      const idx = squarePathIndex(sq);
      // If the square's cell is sealed, or it sits at/behind the front, bump it
      // forward to the first open path cell ahead of the front.
      if (idx === -1 || idx < FLOOD.front) {
        // Find the first open path cell ahead of the front that this square is
        // allowed to occupy (not blocked by an unbroken brick of another color),
        // so the push never drops it inside a gate it cannot pass.
        let aheadIdx = Math.min(FLOOD.front + 1, MAZE.path.length - 1);
        while (aheadIdx < MAZE.path.length - 1) {
          const pc = MAZE.path[aheadIdx];
          const b = brickAt(pc.c, pc.r);
          if (b && b.color !== sq.color) { aheadIdx++; continue; }
          break;
        }
        const ahead = MAZE.path[aheadIdx];
        const nextAhead = MAZE.path[Math.min(aheadIdx + 1, MAZE.path.length - 1)];
        const ctr = cellCenter(ahead.c, ahead.r);
        sq.x = ctr.x; sq.y = ctr.y;
        // Re-aim along the corridor's forward direction but KEEP it a billiard
        // diagonal so it still bounces naturally (this is the wall shoving it,
        // not pathfinding — it only happens when the wall reaches the square).
        const fwd = stepDir(ahead, nextAhead);
        // preserve diagonal liveliness: combine forward dir with a perpendicular
        const perp = { x: -fwd.y, y: fwd.x };
        const sign = (sq.vx * perp.x + sq.vy * perp.y) >= 0 ? 1 : -1;
        let dx = fwd.x + perp.x * sign * 0.7, dy = fwd.y + perp.y * sign * 0.7;
        const d = Math.hypot(dx, dy) || 1;
        sq.vx = (dx / d) * sq.speed;
        sq.vy = (dy / d) * sq.speed;
      }
    }
  }

  function drawFlood() {
    if (!MAZE.path.length) return;
    const t = Date.now();

    if (STATE.stageIndex === 0) {
      const pts = stage1PathPoints();
      if (!pts || pts.length < 2) return;
      const laneW = MAZE.cellH * 1.42;
      const floodW = Math.max(1, laneW - WALL_THICKNESS * 0.6);
      const frac = FLOOD.progress - Math.floor(FLOOD.progress);
      const upto = Math.min(MAZE.path.length - 1, FLOOD.front);
      const segPts = [];
      for (let i = 0; i <= upto; i++) segPts.push(pts[i]);
      if (FLOOD.front < MAZE.path.length && pts[FLOOD.front]) {
        const a = pts[FLOOD.front];
        const b = pts[Math.min(FLOOD.front + 1, pts.length - 1)];
        if (a && b) segPts.push({ x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac });
      }
      if (segPts.length >= 2) {
        ctx.save();
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';
        ctx.miterLimit = 2;
        ctx.strokeStyle = FLOOD_COLOR;
        ctx.lineWidth = floodW;
        ctx.beginPath();
        ctx.moveTo(segPts[0].x, segPts[0].y);
        for (let i = 1; i < segPts.length; i++) ctx.lineTo(segPts[i].x, segPts[i].y);
        ctx.stroke();

        const pulse = 0.55 + 0.45 * Math.sin(t / 220);
        const tail = segPts[segPts.length - 1];
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(140,130,255,${0.16 + 0.16 * pulse})`;
        ctx.fillRect(tail.x - floodW * 0.18, tail.y - floodW * 0.18, floodW * 0.36, floodW * 0.36);
        ctx.restore();
      }
      return;
    }

    const w = MAZE.cellW, h = MAZE.cellH;
    const ox = MAZE.offX, oy = MAZE.offY;
    const inset = WALL_THICKNESS * 0.5;
    const fw = Math.max(1, w - WALL_THICKNESS);
    const fh = Math.max(1, h - WALL_THICKNESS);

    ctx.fillStyle = FLOOD_COLOR;
    for (let i = 0; i < FLOOD.front; i++) {
      const cell = MAZE.path[i];
      if (!cell) continue;
      ctx.fillRect(ox + cell.c * w + inset, oy + cell.r * h + inset, fw + 1, fh + 1);
    }

    const frac = FLOOD.progress - Math.floor(FLOOD.progress);
    const lead = MAZE.path[FLOOD.front];
    const next = MAZE.path[Math.min(FLOOD.front + 1, MAZE.path.length - 1)];
    if (lead) {
      const x = ox + lead.c * w + inset, y = oy + lead.r * h + inset;
      const dx = next ? Math.sign(next.c - lead.c) : 1;
      const dy = next ? Math.sign(next.r - lead.r) : 0;
      ctx.fillStyle = FLOOD_COLOR;
      if (dx > 0)      ctx.fillRect(x, y, fw * frac + 1, fh + 1);
      else if (dx < 0) ctx.fillRect(x + fw * (1 - frac), y, fw * frac + 1, fh + 1);
      else if (dy > 0) ctx.fillRect(x, y, fw + 1, fh * frac + 1);
      else if (dy < 0) ctx.fillRect(x, y + fh * (1 - frac), fw + 1, fh * frac + 1);
      else             ctx.fillRect(x, y, fw * frac + 1, fh + 1);

      const pulse = 0.55 + 0.45 * Math.sin(t / 220);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(140,130,255,${0.16 + 0.16 * pulse})`;
      const eT = Math.max(fw, fh) * 0.18 * (0.8 + 0.4 * pulse);
      if (dx > 0)      ctx.fillRect(x + fw * frac - eT, y, eT, fh);
      else if (dx < 0) ctx.fillRect(x + fw * (1 - frac), y, eT, fh);
      else if (dy > 0) ctx.fillRect(x, y + fh * frac - eT, fw, eT);
      else if (dy < 0) ctx.fillRect(x, y + fh * (1 - frac), fw, eT);
      ctx.restore();
    }
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

  // Burst brick-colored shards when a matching square smashes its brick.
  function spawnBrickShards(brick) {
    const cx = MAZE.offX + brick.c * MAZE.cellW + MAZE.cellW / 2;
    const cy = MAZE.offY + brick.r * MAZE.cellH + MAZE.cellH / 2;
    const col = COLORS[brick.color];
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 140;
      PARTICLES.push({
        x: cx, y: cy,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        size: 4 + Math.random() * 5,
        life: 0.4 + Math.random() * 0.3,
        maxLife: 0.7,
        color: col,
        spin: (Math.random() - 0.5) * 14,
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
      shieldFlash: 0,           // >0 while the blue shield-block ripple plays
      trail: []                 // recent positions for the comet motion trail
    };
  }
  const TRAIL_LEN = 18;          // how many trail samples to keep (longer comet)

  function spawnSquares() {
    // Fair start: every square launches in the SAME direction (a fixed diagonal,
    // so it always has both velocity components and can round corners), and the
    // four squares are SEPARATED along the start corridor rather than clustered.
    // Diagonal heading down the first path step keeps the launch fair + lively.
    const launch = launchDirection();

    // Spread the squares out along the first stretch of the corridor.
    const offsets = [-1.5, -0.5, 0.5, 1.5]; // in square-sizes, perpendicular-ish
    SQUARES = COLOR_ORDER.map((color, i) => {
      const sq = createSquare(color);
      sq.isPlayer = color === STATE.selectedColor;
      // Separate them along the corridor direction so they don't all overlap.
      const along = MAZE.path && MAZE.path.length > 1
        ? stepDir(MAZE.path[0], MAZE.path[1]) : { x: 1, y: 0 };
      const perp = { x: -along.y, y: along.x };
      const spread = SQUARE_SIZE * 1.25;
      sq.x = MAZE.start.x + perp.x * offsets[i] * spread * 0.5 + along.x * offsets[i] * spread;
      sq.y = MAZE.start.y + perp.y * offsets[i] * spread * 0.5 + along.y * offsets[i] * spread;
      // keep inside the start cell area / on open floor
      sq.x = Math.max(SQUARE_SIZE, Math.min(view.w - SQUARE_SIZE, sq.x));
      sq.y = Math.max(SQUARE_SIZE, Math.min(view.h - SQUARE_SIZE, sq.y));
      sq.vx = launch.x * sq.speed;
      sq.vy = launch.y * sq.speed;
      return sq;
    });
  }

  // Direction (unit vector) from cell a to cell b.
  function stepDir(a, b) {
    const dx = Math.sign(b.c - a.c), dy = Math.sign(b.r - a.r);
    const d = Math.hypot(dx, dy) || 1;
    return { x: dx / d, y: dy / d };
  }

  // A fair, shared launch direction: a 45° diagonal biased to head INTO the
  // corridor (down the first path step), identical for all squares.
  function launchDirection() {
    let bx = 1, by = 1;
    if (MAZE.path && MAZE.path.length > 1) {
      const s = stepDir(MAZE.path[0], MAZE.path[1]);
      // bias the diagonal toward the corridor's initial direction
      bx = (s.x !== 0 ? s.x : 1);
      by = (s.y !== 0 ? s.y : 1);
    }
    const d = Math.hypot(bx, by) || 1;
    return { x: bx / d, y: by / d };
  }

  function updateSquares(dt) {
    for (const sq of SQUARES) {
      if (sq.eliminated) { updateEliminated(sq, dt); continue; }
      if (sq.finished) continue;

      moveAndBounce(sq, dt);
      // No self-rotation: squares do not spin on themselves. They move straight
      // and only change direction by reflecting off walls (handled above).

      // Record the comet motion trail.
      sq.trail.push({ x: sq.x, y: sq.y });
      if (sq.trail.length > TRAIL_LEN) sq.trail.shift();

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

    // A brick the square's OWN color shatters on contact, so try to break any
    // brick it is currently overlapping before resolving wall collisions.
    tryBreakBrick(sq);

    // --- X axis: move, and if we'd enter a wall, reflect vx (vertical wall) ---
    const nx = sq.x + sq.vx * dt;
    if (sq.vx > 0 && isWallForSquare(nx + half, sq.y, sq)) {
      sq.vx = -sq.vx; bounceFx(sq);           // reflect off vertical wall
    } else if (sq.vx < 0 && isWallForSquare(nx - half, sq.y, sq)) {
      sq.vx = -sq.vx; bounceFx(sq);
    } else {
      sq.x = nx;                              // no wall: advance straight
    }

    // --- Y axis: move, and if we'd enter a wall, reflect vy (horizontal wall) ---
    const ny = sq.y + sq.vy * dt;
    if (sq.vy > 0 && isWallForSquare(sq.x, ny + half, sq)) {
      sq.vy = -sq.vy; bounceFx(sq);           // reflect off horizontal wall
    } else if (sq.vy < 0 && isWallForSquare(sq.x, ny - half, sq)) {
      sq.vy = -sq.vy; bounceFx(sq);
    } else {
      sq.y = ny;                              // no wall: advance straight
    }

    // Safety clamp to keep the square on-screen (the border is solid wall, so
    // this only guards against numerical drift — it does NOT change vx/vy).
    const mazeW = MAZE.cellW * MAZE.cols, mazeH = MAZE.cellH * MAZE.rows;
    sq.x = Math.max(MAZE.offX + half, Math.min(MAZE.offX + mazeW - half, sq.x));
    sq.y = Math.max(MAZE.offY + half, Math.min(MAZE.offY + mazeH - half, sq.y));
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

    const r = 4; // slightly rounded corners
    const base = COLORS[sq.color];

    // Drop shadow beneath the body for lift off the floor (not an internal line).
    if (!sq.eliminated) {
      ctx.save();
      ctx.globalAlpha = sq.opacity * 0.30;
      ctx.fillStyle = '#000';
      roundRect(-half + 1.5, -half + 3, SQUARE_SIZE, SQUARE_SIZE, r); ctx.fill();
      ctx.restore();
    }

    // Outer glow — strong for the player, soft for everyone else.
    ctx.shadowColor = base;
    ctx.shadowBlur = (sq.isPlayer && !sq.eliminated) ? 16 : 6;

    // PLAIN SOLID body — one flat color, no gradient, no highlight, no internal
    // lines or grid texture.
    ctx.fillStyle = base;
    roundRect(-half, -half, SQUARE_SIZE, SQUARE_SIZE, r); ctx.fill();
    ctx.shadowBlur = 0;

    // A single clean dark outline for definition (an outer edge, not internal).
    ctx.strokeStyle = shade(base, -0.5);
    ctx.lineWidth = 1.5;
    roundRect(-half, -half, SQUARE_SIZE, SQUARE_SIZE, r); ctx.stroke();
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

  // Comet trail: a smooth, glowing, tapering streak behind the square in its
  // own color, drawn additively so overlapping segments bloom like light.
  function drawTrail(sq) {
    if (sq.eliminated || sq.finished || sq.trail.length < 2) return;
    const half = SQUARE_SIZE / 2;
    const base = COLORS[sq.color];
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = 'lighter';
    // soft wide glow pass
    for (let i = 1; i < sq.trail.length; i++) {
      const a = sq.trail[i - 1], b = sq.trail[i];
      const f = i / sq.trail.length;            // 0 (tail) -> 1 (near body)
      ctx.globalAlpha = f * f * 0.22;
      ctx.strokeStyle = base;
      ctx.lineWidth = Math.max(1, half * 2.1 * f);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // bright thin core pass
    for (let i = 1; i < sq.trail.length; i++) {
      const a = sq.trail[i - 1], b = sq.trail[i];
      const f = i / sq.trail.length;
      ctx.globalAlpha = f * 0.55;
      ctx.strokeStyle = shade(base, 0.35);
      ctx.lineWidth = Math.max(1, half * 0.9 * f);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawSquares() {
    // Trails underneath everything, then bodies (eliminated first).
    for (const sq of SQUARES) drawTrail(sq);
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
    const usable = open.filter(cell => {
      const ctr = cellCenter(cell.c, cell.r);
      return Math.hypot(ctr.x - MAZE.start.x, ctr.y - MAZE.start.y) > Math.max(MAZE.cellW, MAZE.cellH) * 1.5;
    });
    for (let i = usable.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [usable[i], usable[j]] = [usable[j], usable[i]];
    }
    const picks = usable.slice(0, Math.min(usable.length, 2));
    if (picks[0]) {
      const ctr = cellCenter(picks[0].c, picks[0].r);
      LOOT.push({ x: ctr.x, y: ctr.y, type: 'knife', taken: false });
    }
    if (picks[1]) {
      const ctr = cellCenter(picks[1].c, picks[1].r);
      LOOT.push({ x: ctr.x, y: ctr.y, type: 'shield', taken: false });
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


  function stage1PathPoints() {
    if (STATE.stageIndex !== 0 || !MAZE.path || !MAZE.path.length) return null;
    return MAZE.path.map(cell => ({
      x: MAZE.offX + cell.c * MAZE.cellW + MAZE.cellW / 2,
      y: MAZE.offY + cell.r * MAZE.cellH + MAZE.cellH / 2
    }));
  }


  function pointToSegmentDistance(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 <= 1e-6) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = ax + dx * t, qy = ay + dy * t;
    return Math.hypot(px - qx, py - qy);
  }

  function stage1CorridorHalfWidth() {
    return (MAZE.cellH * 1.42) * 0.5;
  }

  function isInsideStage1Corridor(px, py, pad) {
    const pts = stage1PathPoints();
    if (!pts || pts.length < 2) return false;
    const half = stage1CorridorHalfWidth() - (pad || 0);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (pointToSegmentDistance(px, py, a.x, a.y, b.x, b.y) <= half) return true;
    }
    return false;
  }

  function drawStage1VisualMaze(ctx) {
    const pts = stage1PathPoints();
    if (!pts || pts.length < 2) return false;
    const laneW = MAZE.cellH * 1.42;
    const border = WALL_THICKNESS;

    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 2;

    // Outer dark border stroke
    ctx.strokeStyle = WALL_COLOR;
    ctx.lineWidth = laneW + border * 2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

    // Inner floor stroke
    ctx.strokeStyle = FLOOR_COLOR;
    ctx.lineWidth = laneW;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

    ctx.restore();
    return true;
  }

  function drawMaze() {
    // 1) BACKGROUND: one solid flat color over the whole screen (this also fills
    //    the empty letterbox space above/below the centered square-cell maze).
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, view.w, view.h);

    const mazeW = MAZE.cellW * MAZE.cols, mazeH = MAZE.cellH * MAZE.rows;

    // 2) FLOOR + WALLS. Stage 1 uses a dedicated visual geometry layer
    //    built from merged corridor bands; other stages keep the normal cell
    //    rendering. Gameplay/path logic stays unchanged.
    const stage1Custom = drawStage1VisualMaze(ctx);
    if (!stage1Custom) {
      ctx.fillStyle = FLOOR_COLOR;
      ctx.fillRect(MAZE.offX, MAZE.offY, mazeW, mazeH);
      const T = 4;
      const inset = T / 2;
      const ox = MAZE.offX, oy = MAZE.offY, cw = MAZE.cellW, ch = MAZE.cellH;
      const isOpenCell = (c, r) => r >= 0 && c >= 0 && r < MAZE.rows && c < MAZE.cols && MAZE.grid[r][c] !== '#';
      ctx.fillStyle = WALL_COLOR;
      for (let r = 0; r < MAZE.rows; r++) {
        for (let c = 0; c < MAZE.cols; c++) {
          if (!isOpenCell(c, r)) continue;
          const x = ox + c * cw, y = oy + r * ch;
          if (!isOpenCell(c, r - 1)) ctx.fillRect(x, y - inset, cw, T);
          if (!isOpenCell(c, r + 1)) ctx.fillRect(x, y + ch - inset, cw, T);
          if (!isOpenCell(c - 1, r)) ctx.fillRect(x - inset, y, T, ch);
          if (!isOpenCell(c + 1, r)) ctx.fillRect(x + cw - inset, y, T, ch);
        }
      }
    }

    // Entry marker: a solid translucent tint + label (no grid).
    if (MAZE.start) {
      ctx.fillStyle = 'rgba(46,204,113,0.28)';
      ctx.fillRect(MAZE.start.x - MAZE.cellW / 2, MAZE.start.y - MAZE.cellH / 2, MAZE.cellW, MAZE.cellH);
      ctx.fillStyle = '#2ecc71';
      ctx.font = `bold ${MAZE.cellW * 0.42}px monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('IN', MAZE.start.x, MAZE.start.y);
    }
    // Exit marker: a checkered finish flag filling the exit cell.
    if (MAZE.exitCell) {
      drawCheckeredFlag(MAZE.offX + MAZE.exitCell.c * MAZE.cellW, MAZE.offY + MAZE.exitCell.r * MAZE.cellH, MAZE.cellW, MAZE.cellH);
    }
    ctx.textBaseline = 'alphabetic';
  }

  // Draw a black/white checkered finish flag covering a cell rect.
  function drawCheckeredFlag(x, y, w, h) {
    const cols = 4, rows = 4;
    const cw = w / cols, ch = h / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = ((r + c) % 2 === 0) ? '#101018' : '#f4f4f8';
        ctx.fillRect(x + c * cw, y + r * ch, cw + 0.5, ch + 0.5);
      }
    }
    // subtle pulsing glow ring so the finish reads at a glance
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 280);
    ctx.strokeStyle = `rgba(255,215,0,${0.4 + 0.4 * pulse})`;
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  }

  // Draw the colored brick gates. Each unbroken brick fills its cell with a
  // brick-textured block tinted its color; a brief flash plays when smashed.
  function drawBricks() {
    if (!BRICKS.length) return;
    for (const b of BRICKS) {
      if (b.broken) { if (b.hitFlash > 0) b.hitFlash = Math.max(0, b.hitFlash - 0.05); continue; }
      // Skip if the flood has already swallowed this cell (flood draws over it).
      if (FLOOD.sealed[b.r] && FLOOD.sealed[b.r][b.c]) continue;
      const x = MAZE.offX + b.c * MAZE.cellW, y = MAZE.offY + b.r * MAZE.cellH;
      const w = MAZE.cellW, h = MAZE.cellH;
      const base = COLORS[b.color];
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300 + b.c + b.r);
      // Solid flat colored block (this gate's color). NO mortar/grid/bevel lines.
      ctx.fillStyle = base;
      ctx.fillRect(x, y, w + 1, h + 1);
      // A single soft glowing colored outline so it reads as a colored gate
      // (one clean rim — not a grid).
      ctx.save();
      ctx.shadowColor = base;
      ctx.shadowBlur = 8 + 6 * pulse;
      ctx.strokeStyle = shade(base, 0.35);
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
      ctx.restore();
    }
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
    resetFlood();
    resetBricks();
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
    drawMaze(); drawFlood(); drawBricks(); drawLoot(); drawSquares();
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

    // Advance the blue flood wall first (it can seal cells behind squares),
    // then move the squares with pure billiard physics.
    updateFlood(dt);
    updateSquares(dt);

    // Safety cap (rarely reached now that the flood squeezes squares to the
    // exit): if a stage somehow still runs past STAGE_TIME_LIMIT, place any
    // remaining squares by how close they happen to be to the exit. Not
    // pathfinding — squares never steer; this only stops an infinite stage.
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
    drawFlood();
    drawBricks();
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
