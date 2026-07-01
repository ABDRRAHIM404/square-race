# Maze Runners — Rebuild Build Spec

> This document is the complete task specification for rebuilding "Maze Runners" (originally "square-race").
> It is written for a coding agent (e.g. Claude Code) to implement. Follow `CLAUDE.md` guidelines while
> building: think before coding, keep it simple, make surgical changes if editing existing code, and work
> in verifiable steps.

---

## 1. What This Project Is

A full-screen mobile game where 4 colored squares move on their own (billiard-style physics — no player
steering) through a winding corridor maze, from a start point to an exit. The player's only choice is which
colored square to back before the race starts. Races are designed to be screen-recorded and posted as short
vertical videos (TikTok/Reels style — see reference: an Instagram Reels screenshot of a similar "square race"
game, portrait 9:16, flat bold colors, simple shapes).

The core new requirement driving this rebuild: **the player must be able to design their own mazes**, in-app,
with a visual editor — not just play 5 hardcoded maps.

Built with pure HTML5 Canvas + vanilla JavaScript (no game engine, no external libraries, no image assets —
everything drawn in code). Wrapped to Android via Capacitor. Android debug APK built automatically via GitHub
Actions on every push to `main`. This stack is confirmed sufficient for the new scope — do not introduce a
game engine or framework.

---

## 2. Architecture (Required — This Is the Core of the Rebuild)

The single biggest structural change from the original project: **maze data must be fully decoupled from
game logic and rendering.** The original hardcoded 5 mazes directly in drawing/physics code. That approach
must not be used here, because the in-app editor needs to read and write mazes independently of both the
renderer and the race engine.

Required layers, each independent and only talking to the others through the maze data format (Section 3):

1. **Maze Data Layer** — the maze data format itself (Section 3), plus load/save/list/delete/duplicate
   operations against storage (Section 8). Pure data, no rendering or physics code here.
2. **Renderer** — given a maze data object, draws it to the canvas. Used by both the race screen and the
   editor's live preview. One renderer, reused in both places — do not fork rendering logic between editor
   and race mode.
3. **Physics/Race Engine** — given a maze data object, simulates the race (movement, collisions, loot,
   pursuing wall, elimination, win condition). Must not know anything about how it's drawn or how the maze
   was authored.
4. **Editor UI** — screen(s) for authoring a maze: placing walls, start/exit, dead ends, bricks, loot zones.
   Produces/edits a maze data object. Uses the Renderer for live preview and the Physics/Race Engine for
   test-play. Includes path validation, time estimation, and duplicate/clone (Section 7).
5. **Race UI** — the actual gameplay screens (title, select, stage intro, race, result, final) — see
   Section 6. Reads maze data, drives the Physics/Race Engine and Renderer.

**Test of good architecture:** it must be possible to hand-write a new maze data object from scratch (or
build it entirely through the editor) and have it playable with zero changes to engine, renderer, or race UI
code. If adding a maze ever requires touching JS logic, the architecture has failed this spec.

---

## 3. Maze Data Format

Define a single declarative format (JSON-serializable JS object) that fully describes one maze. It must
capture, at minimum:

- **Metadata**: id, name, created/modified timestamp.
- **Grid/coordinate system**: a fixed grid or coordinate space the corridor is authored in (snap-to-grid
  recommended for clean 90°-style corridors matching the reference screenshot's look).
- **Corridor geometry**: the wall segments (or corridor path) that define the playable space. Must support
  a winding single(-ish) corridor shape, not just an open rectangular arena, and must support **dead ends**
  (corridor branches that lead nowhere).
- **Start point**: where all 4 squares spawn (a small shared area/point).
- **Exit/goal point**: where squares must reach to finish.
- **Dead end markers**: which corridor branches are dead ends, since dead ends interact specially with the
  pursuing wall (Section 4.4).
- **Brick obstacles**: positions of breakable brick walls (Section 4.3).
- **Loot spawn zones**: positions for knife/shield/speed-boost spawns, constrained to be near-but-not-
  adjacent to the exit (Section 4.2).
- **Optional per-maze toggles**: e.g. whether the speed-boost item is enabled for this maze (Section 4.5).

This format is the contract between every layer in Section 2. Keep it flat and simple — no engine-specific
or renderer-specific fields leaking into it.

---

## 4. Core Gameplay Mechanics

### 4.1 Movement (Billiard Physics)
- 4 colored squares (yellow, blue, green, red), yellow fastest → blue slowest (carry forward existing speed
  tiers unless testing shows they need retuning for corridor-style mazes).
- Fully passive movement: constant velocity, straight-line travel, reflect off every wall (outer boundary +
  internal corridor walls + bricks + the pursuing wall where applicable).
- Frame-rate independent — all movement uses `deltaTime`, no fixed-timestep assumptions.
- No player steering at any point during a race.

### 4.2 Loot: Knife & Shield (+ optional Speed Boost)
- **Knife**: reusable elimination weapon. Once picked up, the carrier eliminates any square it touches for
  the rest of the race (not consumed on use). Only one knife per maze unless otherwise configured.
- **Shield**: absorbs exactly one knife hit, then breaks and is gone. A shielded square touched by a knife
  survives that one hit; a second hit (with no shield) eliminates it.
- Both spawn in a zone **near the exit but not immediately adjacent to it** — encourages a late-race risk/
  reward pickup, not a guaranteed grab right at the finish.
- **Speed Boost (optional, per-maze toggle)**: a rarer third item type that gives a temporary or one-time
  speed increase to whoever picks it up. Off by default; the editor should let the player enable it per
  maze. Keep this simple — do not over-engineer stacking/duration rules beyond a single clear effect.

### 4.3 Breakable Brick Walls
- Obstacle type placed in corridors. Behaves like a normal wall (squares bounce off it) until touched, at
  which point it breaks/disappears, opening that space permanently for the rest of the race.
- Purely a geometry/pathing obstacle — does not eliminate squares on its own.

### 4.4 Pursuing Wall (Safety Mechanism, Not a Pacing Mechanic)
- A wall that follows behind the pack of squares, moving forward at a **constant speed equal to 20% of the
  squares' movement speed**.
- Its speed is fixed and does **not** scale with maze length or target race time — it exists purely as a
  safety net against a square getting stuck bouncing forever in a pocket of the maze (an infinite loop),
  which is possible given fully passive billiard movement.
- **It travels along the corridor path itself, not in a straight line across the maze.** The wall's leading
  edge advances through the tunnel geometry — following every turn, branch, and dead end in sequence — the
  same way a flood would move through the corridor from the start point onward. A straight-line sweep
  (e.g. left-to-right across the whole canvas) is not correct behavior; the wall must track the maze's
  actual corridor shape at all times, using the same corridor geometry defined in the maze data format
  (Section 3).
- **It fills the entire width of the corridor floor it has advanced through** — the wall is not a thin line
  or partial-width object. Once the wall's leading edge has passed a point in the corridor, that entire
  floor section (full corridor width, wall-to-wall) is filled/sealed behind it. This is what makes it
  correctly block off dead ends and pockets rather than leaving a gap a square could slip through.
- **Default behavior everywhere in the open corridor: it acts exactly like a normal wall.** A square
  touching the wall's leading edge in the open, still-traversable corridor simply bounces off, same as any
  other wall — this is the common case and should not eliminate anyone.
- **Elimination only happens in one specific situation**: a square is in a dead end, the pursuing wall's
  advancing front has filled in behind it and sealed off the only way back out, and there is genuinely no
  path left for that square other than being caught. Only then does contact eliminate the square. This
  requires the engine to be able to detect "this square is in a dead end that the wall has now sealed" as a
  distinct state from "square touched the wall's leading edge in an open, still-passable corridor."
- Do not implement this as a general kill-on-touch mechanic — that would contradict the "just a safety net"
  purpose and would make races unpredictable in a way that undermines the maze design's control over pacing.

### 4.5 Race Duration Target
- Each maze should take **60–90 seconds** to resolve under normal play.
- This is achieved through **maze design** (corridor length, number of turns, dead end frequency) — not
  through the pursuing wall's speed, which stays fixed per Section 4.4.
- The editor's time estimator (Section 7) exists specifically to help hit this window while designing.

### 4.6 Win / Placement Condition
- A square reaching the exit banks its placement (1st, 2nd, 3rd, 4th) in finish order.
- A square eliminated (by knife, or by the pursuing wall's dead-end kill) is placed last among remaining
  squares at time of elimination — carry forward the existing "eliminated squares placed last" rule from the
  original knife mechanic.

### 4.7 Visual/Recording Polish
- **Slow-mo / freeze-frame** on kill events and on each square's finish moment — a short hit-stop (~0.3s) to
  make these moments read clearly on video and hold up well when clipped/replayed.
- **Portrait 9:16 safe zones**: keep HUD elements (score, mute button, etc.) clear of the very top and very
  bottom of the screen, since TikTok's own UI (captions, buttons, username) overlaps those regions on
  exported video. Treat this as a layout constraint on all in-race UI.

---

## 5. Scoring (Unchanged From Original)

- Points per stage by finish placement: 1st = 4, 2nd = 3, 3rd = 2, 4th = 1.
- Final result is a podium ranked by cumulative points across all mazes played in the session.

---

## 6. Screens / Flow

Carry forward the original flow, with additions:

| Screen | Behavior |
|---|---|
| Title | Tap anywhere to start |
| Select | Tap a colored square, then tap START |
| Stage Intro | Brief countdown/name display before each maze begins |
| Race | Squares play out the maze; mute button; safe-zone HUD (4.7) |
| Stage Result | Placements + points earned this maze; **Quick-Restart** button (re-run the same maze
  immediately, no menu navigation) alongside the normal "next maze" progression |
| Final Result | Podium by cumulative score across the session; Play Again / Change Square |
| **Maze Library (new)** | Lists saved mazes with **auto-generated thumbnails** (Section 7); lets the
  player choose which maze(s) go into a session, since sessions are no longer fixed at 5 stages — the
  player's library and selection determine session length |
| **Maze Editor (new)** | See Section 7 |

Session length is flexible: no hardcoded "5 stages." The app ships with **one default maze** as a
placeholder/tutorial map; everything beyond that comes from the player's own saved mazes.

---

## 7. Maze Editor (New — Core Feature)

A dedicated in-app screen for designing mazes, built on the same Renderer used in races (Section 2).

Required capabilities:
- **Draw/place corridor walls** on a snap-to-grid canvas, matching the winding-corridor look from the
  reference image (90°-ish turns, consistent corridor width).
- **Set start point and exit/goal point.**
- **Mark dead ends** explicitly (interacts with pursuing-wall logic, Section 4.4).
- **Place brick obstacles** (Section 4.3).
- **Place loot spawn zones** for knife/shield/speed-boost (Section 4.2), constrained near-but-not-adjacent
  to the exit.
- **Toggle speed-boost item on/off** for this maze (Section 4.5 sub-point).
- **Path validation**: before allowing save, confirm there is a valid path from start to exit. Block saving
  (or clearly warn) if the maze is unsolvable, since a broken maze could soft-lock or crash a race.
- **Test-play button**: immediately run the maze in the real Physics/Race Engine from within the editor, so
  the player can check feel/timing without leaving the editor.
- **Built-in time estimator**: while designing, estimate roughly how long the maze will take to resolve
  (based on corridor length/turns/square speed), to help hit the 60–90s target (Section 4.5) without
  repeated manual test-plays.
- **Auto-generated thumbnail**: generate a small preview image of the maze (e.g. a scaled-down render) for
  display in the Maze Library screen (Section 6).
- **Duplicate & tweak**: a "clone this maze" action that copies an existing maze as a starting point for a
  new one, rather than always starting from a blank canvas.
- **Name and save** the maze to storage (Section 8).

---

## 8. Maze Storage: `localStorage` + Export/Import

No backend/server — this is a solo, offline-first content-creation tool, so a server would add complexity
(hosting, accounts, sync) with no real benefit here.

- **`localStorage`** (or Capacitor's equivalent storage API in the native wrapper) is the source of truth on
  each device. Each saved maze is stored under its own key (e.g. `maze_<id>`), holding the maze data object
  from Section 3.
- Persists across app restarts; not wiped unless app data/cache is cleared or the app is uninstalled. Does
  **not** sync across devices automatically — each device's storage is separate.
- **Export**: per-maze (and "export all") action that serializes maze data to JSON and either downloads it
  as a `.json` file, shows it as copyable text, or — since this is wrapped in Capacitor — triggers the native
  share sheet so the player can send it to Files/Drive/etc.
- **Import**: action to paste JSON text or pick a `.json` file, parse it, and write it into `localStorage` as
  a new (or replacement) maze entry. Validate the imported data against the maze format before accepting it.
- Purpose: backup mazes, move them between devices, and survive app reinstalls without redesigning from
  scratch.

---

## 9. Everything Else Carried Over Unchanged From the Original README

- Web Audio API sound effects (no audio files), mute button.
- Canvas 2D only — no external libraries, no image assets, everything drawn in code.
- Frame-rate independent movement via `deltaTime`.
- Capacitor wrapping; `android/` folder generated by `npx cap add android`, gitignored, regenerated by CI —
  do not commit it.
- GitHub Actions workflow (`.github/workflows/build-apk.yml`) builds a debug APK automatically on push to
  `main`, uploaded as a build artifact. CI runner should use Node.js 22+ (LTS) and JDK 17.
- **Use current Capacitor 8.x.** As of this spec, that means: `minSdkVersion 24` (Android 7.0), but
  `compileSdkVersion` / `targetSdkVersion 36` (Android 16) — targeting the current SDK matters even for a
  sideloaded debug APK, since Capacitor's Android runtime, WebView behavior, and plugin compatibility are
  tied to it. Do not leave `compileSdkVersion`/`targetSdkVersion` on an old default; use whatever
  `variables.gradle` minimums the installed Capacitor 8.x CLI scaffolds when running `npx cap add android`,
  and keep them current rather than hardcoding the numbers in this document long-term.
- **Edge-to-edge display**: modern Android (API 35+) enforces edge-to-edge layout by default, meaning the
  app's content can draw behind the system status bar/navigation bar unless handled explicitly. Capacitor 8
  moved this from automatic margin-adjustment to a dedicated System Bars handling approach (via CSS
  env variables / safe-area insets) rather than native margin patches. This directly interacts with the
  **9:16 safe zone** requirement in Section 4.7 — implement the in-race HUD's safe zones using CSS
  safe-area-inset variables so they work correctly both for TikTok's own UI overlap *and* for the system
  status/navigation bars on edge-to-edge Android.
- Target: portrait orientation, offline-capable after install.
- MIT license.
- Project folder name (`square-race/` or renamed) is not load-bearing — nothing depends on it.

---

## 10. Suggested Project Structure

Adjust as needed during implementation, but this reflects the required layering from Section 2:

```
square-race/
├── .github/workflows/build-apk.yml
├── www/
│   ├── index.html
│   ├── style.css
│   ├── mazes/
│   │   └── default-maze.js        # the one shipped default maze (data only)
│   ├── engine/
│   │   ├── mazeFormat.js          # maze data shape + validation helpers
│   │   ├── renderer.js            # draws a maze data object to canvas
│   │   ├── physics.js             # billiard movement, collisions
│   │   └── race.js                # race rules: loot, pursuing wall, elimination, scoring
│   ├── storage/
│   │   └── mazeStorage.js         # localStorage load/save/list/delete/duplicate + export/import
│   ├── editor/
│   │   └── editor.js              # editor UI: drawing, validation, test-play, thumbnails, estimator
│   ├── ui/
│   │   ├── screens.js             # title/select/intro/result/final/library screen flow
│   │   └── hud.js                 # in-race HUD, safe-zone layout
│   └── audio.js                   # Web Audio sfx + mute
├── android/                        # generated by Capacitor, gitignored
├── .gitignore
├── capacitor.config.json
├── package.json
└── README.md
```

---

## 11. Build Guidelines (from CLAUDE.md — apply throughout)

- State assumptions explicitly; if something in this spec is ambiguous during implementation, surface it
  rather than silently picking an interpretation.
- Minimum code that solves the problem — no speculative flexibility beyond what this spec describes.
- Match the layered architecture in Section 2 strictly; the maze editor and race mode must share the same
  Renderer and maze data format, not forked copies.
- Work in verifiable steps, e.g.:
  1. Maze data format + default maze → verify: default maze loads and renders statically.
  2. Physics/race engine on default maze (no loot/bricks/pursuing wall yet) → verify: 4 squares bounce
     correctly start-to-exit, placements recorded.
  3. Add loot (knife/shield), bricks, pursuing wall + dead-end kill logic → verify: each mechanic works in
     isolation on a small test maze built for that purpose.
  4. Race UI screens + scoring + quick-restart → verify: full session playable start to podium.
  5. `localStorage` storage + export/import → verify: save, reload app, maze persists; export/import
     round-trips correctly.
  6. Editor: drawing, validation, test-play, thumbnail, duplicate, time estimator → verify: a maze designed
     entirely in-editor is fully playable with zero code changes.
  7. Polish: slow-mo/freeze-frame, 9:16 safe zones, speed-boost toggle → verify against the 60–90s target
     and visual check against the reference screenshot's aesthetic.
- Do not introduce a game engine, physics library, or frontend framework — stack stays Canvas 2D + vanilla
  JS + Capacitor, per Section 1.
