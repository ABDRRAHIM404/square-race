# Build Notes / Requirements Log

Extra requirements gathered during development (beyond IMPLEMENTATION_PLAN.md):

## Phase 6 — Obstacles
- **Gaps must never spawn within the first 2 segments of the track.**
  Give players a clear, hazard-free start before the first lethal pit appears.
  (Implementation: skip 'gap' placement on the first 2 straight segments.)
  STATUS: DONE & verified (0 violations across trials).

## Phase 8 — Select screen
- **Show each square's personality name + one-line trait under its color**,
  so the choice is meaningful. Copy:
    Yellow  -> "RECKLESS — fast but risky"
    Blue    -> "CAUTIOUS — slow but survives"
    Green   -> "BALANCED — steady all-rounder"
    Red     -> "AGGRESSIVE — fast and pushy"
  (Pull the name from AI_PROFILES; trait is fixed copy per color.)
  STATUS: DONE — vertical-list Select screen shows name + trait per color.

## Progress
- Phases 1–10 COMPLETE (scaffold, HTML/CSS, engine, track, squares,
  obstacles, AI, screens/UI, audio, CI). Remaining: Phase 11 final QA.

## Phase 11 — QA  (COMPLETE ✅)
- Rapid "PLAY AGAIN" mashing must NOT stack game loops or audio instances.
  FIXED/VERIFIED: single rAF chain (only bootstrap schedules the loop);
  startMusic idempotent + defensive stopMusic() at top of startRace();
  taps debounced via Input.consume(). Test: 10x mash -> 1 rAF queued, 1 music node.
- Edge cases verified by automated suite:
  * All squares eliminated -> RESULTS shows "NO SURVIVORS" (winner=null),
    placements still 4-deep, no crash.  (Fixed: winner only if someone finished.)
  * Player finishes last -> placements correct & unique.
  * Mid-race resize -> view + canvas backing rescale, world coords intact,
    race still completes, no exception.
  * Rapid button taps -> RACE ignored without selection; no double-trigger.
- Balance sanity (60 races): ~3.1 finishers / 0.9 eliminated avg; wins spread
  across all 4 colors; ~1/60 no-winner races (handled gracefully).
- All JSON + game.js + workflow YAML validate. No scratch artifacts left.

ALL 11 PHASES COMPLETE. Project is push-ready.

---

# MAJOR REDESIGN — "MAZE RUNNERS" (full-screen maze stages)

The original Square Race track game (Phases 1–11 above) was replaced per user
request with a full-screen **maze stage** game. The scaffold/config/CI/HTML/CSS
are unchanged; `www/game.js` was rewritten.

## Locked spec (from user + ask_user clarifications)
- **Maze stages**: each stage is a full-screen 15×15 grid maze (no dark
  background visible around it). Internal walls form corridors. One entry (S)
  and one exit (E) per maze. **5 hardcoded mazes**, played in order.
- **Physics**: 4 colored squares move in straight lines and bounce off ALL
  walls (outer + internal) like billiard balls (reflection). **Fully passive** —
  no player steering. Per-color speed: yellow 250 > red 230 > green 215 >
  blue 200 (px/s).
- **Loot** (replaces all old obstacles): KNIVES + SHIELDS spawn on the maze
  floor (5–7 per stage, ~55% knives / 45% shields, seeded). Run over loot to
  carry it (icon shown on square), ONE item max. Touch a square carrying a
  KNIFE → eliminated (spin out), UNLESS you carry a SHIELD (absorbs one hit,
  then consumed). Knives are **loot-only** (NOT free-roaming).
- **Win flow**: stage ends when all surviving squares reach the exit (exit
  order recorded) or are eliminated (placed last; last-to-die ranks higher).
  Per-stage placement → points (1st=4, 2nd=3, 3rd=2, 4th=1). After 5 stages →
  **final podium by cumulative points** (highest total wins).
- **State machine**: TITLE → SELECT → STAGE_INTRO → RACE → STAGE_RESULT →
  (next stage) … → FINAL_RESULT → (replay).
- Title screen renamed **MAZE RUNNERS**.

## Safeguard — guaranteed stage termination (NEW)
Billiard motion has no guarantee of reaching the exit, so a stage could loop
forever. Two-part fix in `www/game.js`:
1. **Exit attraction**: after a 6s pure-billiard grace period, surviving
   squares get a velocity bias toward the exit that ramps up over ~20s
   (`pull` 0 → 0.6). Keeps early play billiard-like; guarantees progress.
2. **Hard cap** `STAGE_TIME_LIMIT = 30s`: any still-active squares are
   force-finished (teleported to exit, ranked by current distance) so the
   stage always terminates.
VERIFIED: all 5 stages now finish naturally in ~12–30s (none rely on the hard
cap as a fallback; it exists only as a guarantee).

## Verification (automated, headless)
- `/tmp/maze_check2.js`: all 5 mazes 15×15, rect, exactly one S & one E, exit
  reachable, **0 border holes** → "ALL MAZES VALID ✅". (Fixed maze 2's
  non-rectangular row and maze 5's 2 border holes.)
- `/tmp/e2e.js`: full 5-stage playthrough — every stage terminates (no infinite
  loop), all 4 squares placed each stage with unique placements, cumulative
  points total 50 (5×10), final ranking sorts by points desc. Knife-vs-
  unshielded → eliminated + eliminatedOrder updated; knife-vs-shield →
  survives + shield consumed. ALL TESTS PASSED ✅.
- `/tmp/timing.js`: stage durations ~12–30s, all natural finishes.
- `node --check www/game.js` → SYNTAX OK. JSON configs unchanged & valid.
- Visual SVG→PNG snapshots of maze (walls/loot/squares) and FINAL_RESULT
  podium rendered & confirmed; scratch PNGs cleaned up.

## Rebrand to "Maze Runners" (DONE ✅)
User approved rebranding the app identity to match the new gameplay:
- `capacitor.config.json`: appName → "Maze Runners", appId → com.mazerunners.game
- `package.json`: name → "maze-runners", description + keywords updated
- `www/index.html`: <title> → "Maze Runners"
- `www/game.js`: header comment → "MAZE RUNNERS — Maze Stages"
- `.github/workflows/build-apk.yml`: artifact name → "maze-runners-debug-apk"
- `README.md`: fully rewritten to describe the maze/billiard/loot gameplay.
The project FOLDER stays named `square-race/` (renaming it would break the
user's local clone path); README notes the folder name is cosmetic and safe to
rename. All JSON/YAML/JS re-validated after the rebrand.

MAZE REDESIGN + REBRAND COMPLETE ✅ — project is push-ready.

---

# UPDATE — single-path mazes, knife fix, slower speed, effects, sounds

Six requested changes (all DONE & verified):

1. **Single-path mazes** — all 5 MAZE_LAYOUTS replaced with SINGLE-PATH
   corridors (one continuous route IN→EX, NO branching). Verified: every open
   cell has degree ≤ 2; exactly two degree-1 endpoints (S & E); 0 internal
   junctions (deg3=0). Designs: horizontal serpentine, narrow vertical lanes,
   flipped serpentine, wide vertical lanes, double-thick serpentine.
   - Because straight-line exit-attraction pushed squares into corridor walls,
     replaced it with **corridor guidance**: `computePath()` walks the single
     corridor into an ordered waypoint list; each square tracks `pathIdx` and
     gets a gentle, time-ramping bias toward the NEXT waypoint along the path
     (never through walls). Added an **anti-stall** (if `pathIdx` doesn't
     advance for 0.8s, snap heading at the next waypoint + nudge) so squares
     never pin in a corner. Stages now finish naturally (~16–35s); 45s hard cap
     remains as a safety net (≈1.5% of stage-runs in stress test, force-finished
     by distance-to-exit → always valid placements).

2. **Knife single-use** — `knifeStrike()` now sets `attacker.item = null` the
   moment it connects (on a kill OR a shield-block). A spent knife can't kill a
   second square. Verified: kill→knife gone→second strike does nothing.

3. **Slower movement** — `COLOR_SPEED` reduced 30%: yellow 250→175, red
   230→161, green 215→150, blue 200→140.

4. **Death explosion** — added a PARTICLES system. `eliminate()` calls
   `spawnExplosion()` (14 colored fragments bursting outward with drag +
   gravity + spin, ~0.85s life). Updated/drawn each RACE frame; reset per stage.

5. **Shield effect** — shield block sets `shieldFlash` → an expanding blue
   ripple ring + bright inner flash (0.5s) around the shielded square.

6. **Distinct sounds** — new Web Audio helpers `glide()` (freq sweep) and
   `noise()` (filtered noise burst):
   - knife kill = explosion **boom** (low sine drop + noise blast + rumble),
   - shield block = metallic **ping** (detuned high glides),
   - reach exit = rising success **chime** (G5→B5→E6 arpeggio).

Verification: `node --check` OK; all 5 mazes validate as single-path
(`/tmp/extract_mazes.js`); full 5-stage e2e passes (`/tmp/e2e2.js`) incl. speed
values, knife single-use, knife+shield mutual consume, shield ripple flag,
explosion particle spawn, points total 50; timing/stress harnesses confirm
natural completion. Visual SVG→PNG snapshot of the single-path maze with knife/
shield carriers, shield ripple, and explosion fragments confirmed; scratch
cleaned up.

UPDATE COMPLETE ✅ — project remains push-ready.

---

# UPDATE — PURE BILLIARD PHYSICS (remove ALL pathfinding/attraction)

User feedback: squares were navigating to the exit (the corridor-guidance /
exit-attraction added earlier). User demanded pure billiard physics with zero
exit knowledge. DONE:

1. **Removed all pathfinding & exit attraction** — deleted `computePath()`,
   `advancePathIdx()`, `MAZE.path`, and per-square `pathIdx`/`stuckTime`. No
   attraction force, no steering, no corridor guidance anywhere.
2. **Removed self-rotation** — live squares no longer spin (`sq.angle` stays 0
   during play; deleted the `sq.angle += ...` movement increment). `angle` is
   now used ONLY for the death spin-out animation on eliminated squares.
3. **`moveAndBounce` rewritten to pure reflection** — straight-line constant-
   speed motion; on hitting a VERTICAL wall flip `vx`, on a HORIZONTAL wall
   flip `vy` (axis-separate stepping so we know which wall was hit). Speed
   magnitude never changes (only sign flips) — verified. Removed the old
   anti-stall random re-kick and speed-renorm (no longer needed; reflection
   preserves speed). Square-vs-square billiard collisions are kept (legit
   ball-to-ball physics).
4. **Safety net = 2-minute cap only** (user's explicit choice). `STAGE_TIME_LIMIT
   = 120s`. KNOWN/ACCEPTED BEHAVIOR: with single-path grid-aligned corridors,
   a purely-reflecting square oscillates in its corridor and essentially never
   bounces into the exit on its own (simulated 16 min → 0 escapes). So in
   practice each stage runs to the 120s cap, then remaining squares are placed
   by current distance-to-exit. This is per user instruction ("pure physics
   only, no safety net except like a 2 minutes cap"). NOT pathfinding — squares
   never steer; the cap only stops an infinite stage.

Verification (`/tmp/e2e3.js`): live squares don't self-rotate; speed stays
constant (reflection only); no pathfinding fields exist; manual reflection test
(horizontal mover flips vx, vy stays exactly 0); knife single-use + reduced
speeds intact; stage settles at the 120s cap with 4 placed. `node --check` OK;
JSON/YAML valid; all 5 mazes still validate as single-path.

NOTE for user: because pure reflection + single-path corridors means stages
end on the 2-minute timer rather than by a square actually reaching the exit,
the gameplay is now "watch them bounce for up to 2 min, then rank by proximity."
If you later want squares to actually bounce INTO the exit naturally, the mazes
need to be more open (rooms/pillars) — flagged, not changed (honoring the
explicit pure-physics + 2-min-cap instruction).

---

# UPDATE — match the viral reference video (simu.lation2d "SQUARE RACE")

User shared screenshots of the real viral game and identified how it solves the
billiard-in-corridor problem + visual upgrades. Plan:

1. **Advancing blue wall (THE corridor-loop fix)** — a blue wall grows cell-by-
   cell ALONG the single-path corridor from the START, sealing the path behind
   the squares so they can only go forward. Pure billiard physics are KEPT
   (no pathfinding); the wall just squeezes squares toward the exit, guaranteeing
   they reach it. Wall only PUSHES — never catches/eliminates a square (if it
   reaches a square's cell it just keeps it ahead).
2. **Fair launch** — all 4 squares launch at the SAME angle/speed-direction and
   are SEPARATED (spread out) at the start, not random per-square.
3. **Motion trails** — colored comet trail behind each moving square.
4. **Colored brick walls** — some wall blocks are tinted a square's color; only
   the MATCHING color breaks/passes through that brick (a color-exclusive
   shortcut); other colors bounce off it as a normal wall.
5. Floor stays as-is (light corridors) — good already.
6. **Checkered-flag exit** instead of the "EX" tile.
7. **Glossier squares** (bevel/highlight) instead of flat fill.
8. (caption "Choose a Square" ignored — it's just the video's text overlay.)


## STATUS — reference-match update COMPLETE & verified (all 8 items)

1. **Advancing blue flood wall** ✅ `FLOOD` system: seals corridor cells start→exit
   (`MAZE.path` from `computePath`, used ONLY by the wall — squares stay pure
   physics). `updateFlood` advances steadily (~26s sweep) and PUSHES any square
   at/behind the front to the next open path cell (never catches/eliminates).
   Indigo `#3b32a6` with pulsing bright leading edge. Timing-verified: all 5
   stages settle naturally in ~24–26s.
2. **Fair separated launch** ✅ `spawnSquares` + `launchDirection()`/`stepDir()`:
   identical 45° diagonal for all four, spread along the start corridor.
3. **Motion trails** ✅ `trail[]` per square (TRAIL_LEN 12), `drawTrail` tapering
   fading comet streak in the square's color.
4. **Colored brick walls (break_match)** ✅ `BRICKS` system: bricks placed on
   interior path cells (spacing 12, margin 4 → 8 gates, 2 per color). A brick
   blocks every square EXCEPT its matching color (`isWallForSquare` returns true
   for non-matching). The matching square enters → `tryBreakBrick` shatters it
   (`spawnBrickShards` particle burst, brick `broken=true`, opens for everyone).
   The flood also clears any brick it swallows, and the flood-push skips ahead of
   unbreakable gates so no square is ever trapped. Brick-textured render
   (`drawBricks`): tinted block + running-bond mortar lines + outline.
   Dedicated test `/tmp/bricks.js`: wrong color = wall, matching color = passes &
   breaks, broken brick blocks no one. ALL PASS.
5. Floor unchanged (light `#e9edf2` + faint checker) — per user "floor is good".
6. **Checkered-flag exit** ✅ `drawCheckeredFlag` 4×4 black/white checker +
   pulsing gold border, replaces the old "EX" tile.
7. **Glossier squares** ✅ `drawSquare` rounded corners r=4, white top-highlight
   band, bottom inner-shadow, dark outline.
8. Video caption ignored.

Verification this session: `node --check www/game.js` OK; `/tmp/flood.js` (all 5
stages settle 24–26s with bricks live); `/tmp/bricks.js` (all brick rules pass);
`/tmp/e2e3.js` (pure physics, constant speed/reflection, no steering fields,
knife single-use, reduced speeds, 4 placed, settles within cap) — the only
"fail" there is a STALE assertion "MAZE has no path field", which is now
intentionally present for the flood wall (squares still never read it).
Visual logic mirrored & sanity-rendered via `/tmp/render_v2.js` (path 97,
flood front, 8 bricks). Static maze walls kept dark slate `#2b2f44` (the flood is
the indigo element, matching the reference's blue advancing wall).

## UPDATE — slower pacing + visual overhaul (this session)

User feedback: "make the wall ~50% slower, squares ~20% slower, improve the
gameplay visuals 100×, I don't like the wall's pixel-by-pixel motion, and the
cells are rectangular not square."

1. **Square speed −20%** — `COLOR_SPEED` now `{yellow:140, red:129, green:120,
   blue:112}` (was 175/161/150/140). Verified constant-speed reflection at 140.
2. **Flood wall −50%** — sweep changed `pathLen/26` → `pathLen/52` (~52s sweep).
   Stages now settle in ~47–51s (was ~24s), verified per-stage in isolation.
3. **Smooth flood (no pixel-by-pixel)** — `drawFlood` rewritten: the integer
   `sealed[]` grid still drives physics, but the LEADING FACE is now drawn as a
   continuously advancing partial-cell fill using the fractional `FLOOD.progress`
   (rises like liquid along the corridor direction) plus an additive glowing
   energy edge. Sealed body uses a vertical indigo gradient with top sheen +
   bottom shade. New helper `fillCellFractionLocal`.
4. **Visual overhaul (≈"100× better")**:
   - `shade(hex, amt)` helper added (lighten/darken) — used throughout.
   - **Walls**: drop shadow + vertical gradient body (#3a3f5e→#2b2f44→#1d2031) +
     top/left bevel highlights + bottom inner shadow → 3D slab look.
   - **Floor**: soft vertical gradient (#eef2f7→#dde4ee), cached + reset on layout.
   - **Squares**: vertical body gradient (light top→dark bottom) + RADIAL glassy
     specular highlight top-left + rim-light top edge + drop shadow + colored
     outer glow (strong for player). Rounded r=5.
   - **Trails**: longer (TRAIL_LEN 12→18), two-pass additive comet (wide soft
     glow + bright thin core) so it blooms like light.
   - **Bricks**: gradient masonry body + running-bond mortar + bevel + PULSING
     glowing colored rim (shadowBlur) so the "which color may pass" reads instantly.
   - Checkered flag + IN marker unchanged (already liked).

NOTE on "rectangular pixels": the maze is 15×15 cells stretched to fill a
390×844 portrait screen, so each CELL is ~26px wide × ~56px tall (rectangular) —
that is the source of the rectangular look in walls/flood/bricks. The SQUARES
themselves are true 22×22 squares. Left the maze filling the full screen (so no
letterboxing); the rectangular cells are inherent to a full-bleed 15×15 grid on
a tall phone. (If the user wants truly square cells we'd letterbox the maze or
change the grid aspect — flagged, not changed.)

Verification: node --check OK; JSON/YAML OK; flood timing ~47–51s all 5 stages;
brick rules, fairness (same 45° launch, separated, trails), and pure-physics
(no rotation, constant 140 speed, reflection-only, knife single-use, 4 placed,
settles within cap) all PASS. Faithful SVG snapshot rendered (`snapshot.jpg`):
gradient beveled walls, smooth gradient flood face + glow, 4 glossy gradient
squares w/ radial specular + comet trails, glowing gradient bricks.

## UPDATE — wider floor (smaller grid) + flood another 40% slower

User: "make the floor wider, like 3 cells" + (follow-up) keep the same push
behavior but make the wall 40% slower again. User chose the "bigger cells /
fewer rows" approach (keep single-file 1-wide corridor logic; just enlarge cells
so the floor LOOKS ~3x wider). Rationale: computePath/flood/brick logic all
assume a single-file corridor; widening to a literal 3-wide corridor would need
a path-logic rewrite. Enlarging cells achieves the wider-floor look safely.

1. **MAZE_LAYOUTS rebuilt on a 9-wide grid** (was 15x15). New cells are
   ~43px wide x ~77px tall (was ~26x56), so the corridor floor reads markedly
   wider. All 5 are validated single-path (S->E, no branching, every open cell
   on the path, maxNeighbors<=2):
   - M1 9x11 horizontal serpentine (path 39)
   - M2 9x11 vertical weaving lanes (path 39)
   - M3 9x11 flipped horizontal (path 39)
   - M4 9x13 longer horizontal serpentine (path 47)
   - M5 9x13 longer vertical serpentine (path 47)
   Validated with /tmp/finalmazes.js (opens==pathLen, reachedE, maxNb<=2).
2. **Flood 40% slower again** — sweep `pathLen/52` -> `pathLen/87`. Stages now
   settle naturally in ~65-82s (was ~47-51s), all well under the 120s cap. Push
   behavior unchanged (advances + pushes squares forward, full width).
3. **Brick spacing tightened** to match shorter paths: spacing 12->6, margin
   4->3, giving ~6 gates/stage (all 4 colors covered) instead of 3.

Verification: node --check OK; per-stage flood timing 65-82s all 5; bricks,
fairness (same 45 deg launch, separated, trails), pure-physics (no rotation,
constant 140 speed, reflection-only, knife single-use, 4 placed, settles in cap)
all PASS. Snapshot re-rendered (snapshot.jpg) with the wider 9-wide corridors.

## UPDATE — remove ALL grid lines + perfect-square cells (this session)

User: (1) remove every grid/tile/cell line — floor one solid flat color, walls
solid dark blocks with no cell borders, squares plain solid (no internal
lines/texture), flood one solid color, nothing reveals the grid; (2) cells must
be PERFECT SQUARES (size = screenWidth/cols for both W and H), maze need not
fill screen height — center it and fill leftover space with background color;
never stretch cells to rectangles.

Done:
1. **Perfect square cells** — `layoutMaze` now sets `cell = view.w/cols` and uses
   it for BOTH cellW and cellH. Maze centered vertically via `MAZE.offY =
   (view.h - cell*rows)/2`; `offX=0`. Verified: cellW==cellH==43.33 on all 5
   stages (/tmp/aspect.js). The leftover top/bottom space is the letterbox.
   - Introduced real offsets: every pixel<->cell conversion now uses offX/offY
     (`cellCenter`, `isWallAtPixel`, `isWallForSquare`, `squarePathIndex`,
     `tryBreakBrick`, `spawnBrickShards`, wall rects, draw fns). Pixels outside
     the maze area read as wall, and the move clamp keeps squares within the
     maze bounds (not the full screen).
2. **All grid/cell lines removed** — flat solid color everywhere:
   - `BG_COLOR #cdd6e3` (letterbox), `FLOOR_COLOR #e9edf2` (solid floor, no
     checker), `WALL_COLOR #2b2f44` (solid blocks, +1px overlap so adjacent
     wall cells MERGE with no seams/bevels/highlights), `FLOOD_COLOR #3b32a6`
     (solid, +1px overlap, no per-cell sheen; keeps the smooth fractional
     leading face + one soft glow band, which is an advance edge, not a grid).
   - Bricks: solid flat color block (no mortar/running-bond/bevel) + one soft
     glowing colored rim so you can still read which color may pass.
   - Squares: PLAIN SOLID color (removed body gradient, radial specular
     highlight, and top rim line) + one clean outer outline + drop shadow +
     outer glow. No internal lines/texture.
   - ZERO createLinearGradient/createRadialGradient calls remain in the file.
   - The checkered finish flag is kept (explicit earlier request; it's a finish
     icon, not the maze grid).
3. **Taller mazes** so square cells fill most of the portrait screen: rebuilt
   MAZE_LAYOUTS to 9x17 (mazes 1-3, ~107px letterbox total) and 9x19 (mazes
   4-5, ~21px). All validated single-path (S->E, no branching, all cells on
   path). Maze 3 horizontally mirrored to differ from maze 1.

Verification: node --check OK; JSON/YAML OK; square cells YES all 5; flood
timing ~80s all 5 (under 120s cap); bricks, fairness, pure-physics all PASS
(test harness /tmp/bricks.js updated to add offX/offY to its pixel math). Brick
count is now ~10/stage (longer paths). Snapshot re-rendered (snapshot.jpg):
solid flat floor/walls/flood/bricks, plain solid squares, square cells,
centered maze with background letterbox.

## UPDATE — thin walls + smaller squares (this session)

User: walls should be THIN lines (4-6px) between corridors like the original
game, not thick full-cell blocks; corridor floor should fill almost the entire
cell with only a thin dark separator line. Also reduce square size 20%.

Done:
1. **Thin wall lines** — `drawMaze` walls section rewritten. Instead of filling
   each '#' cell solid, it now draws a thin `WALL_THICKNESS = 5`px line only on
   the edges of a wall cell that border an OPEN/corridor cell (or the outer maze
   border), straddling the boundary. The corridor floor fills ~88% of the cell;
   the wall is just a thin separator line. IMPORTANT: physics is UNCHANGED — a
   '#' cell is still fully solid in isWallAtPixel/isWallForSquare, so squares
   bounce exactly at the boundary where the thin line sits (the line IS the wall
   they hit). Verified: wall-cell interior reads solid, corridor interior reads
   passable, all timing/brick/fairness/physics tests still pass.
   - Flood + bricks still fill the full path cell (they're the wall/gate filling
     the wide corridor edge-to-edge, matching the reference's blue wall sweep);
     they draw over the thin separator lines along the corridor as they advance.
2. **Square size -20%** — `SQUARE_SIZE` 22 -> 18.

Verification (/tmp/verify*.js, rebuilt after /tmp was cleared): SQUARE_SIZE=18;
cells still perfect squares (43.33) all 5; flood settles ~76-80s all 5 (under
120s cap); pure physics (constant speed, reflection, no rotation); thin-wall
collision (wall solid / corridor passable); brick gates (wrong=wall, match=pass)
all PASS. Snapshot re-rendered (snapshot.jpg): thin 5px wall lines, wide ~88%
corridor floor, smaller solid squares.

- User refinement applied: maze rendering now draws wall borders from the OPEN corridor cells themselves as ~4px outline segments only, so corridors read as wide open floor and non-flood wall cells are no longer visually perceived as filled blocks.

- User refinement applied: non-flood maze wall physics now also matches the thin-line rendering, so the dark separators between corridor rows/columns are only ~4–6px actual blocking space instead of full-cell solid bands.

- User refinement applied: flood now renders as one continuous inset indigo strip with no internal cell dividers/separators.

- User refinement applied: loot is limited to exactly 1 knife and 1 shield per stage (when enough eligible cells exist).

- User refinement applied: maze visual style keeps only corridor outline lines; no internal grid dividers are drawn inside open lanes.

- User refinement applied: vertical dead space between horizontal corridor rows is compacted by about 70%, and the reclaimed space is redistributed into taller corridor lanes so rows sit closer together while corridors get slightly bigger.

- Rolled back the broken row-compaction geometry refactor after it caused out-of-maze squares/items; returning to the last stable full-cell geometry before reattempting spacing changes more safely.

- Safe Stage-1-only spacing trial: Stage 1 maze row count reduced from 17 to 11 so the empty vertical space between serpentine lanes is substantially reduced and that reclaimed space becomes taller corridors, without changing the overall rendering/physics system.

- Stage 1 rebuilt to keep the same overall height while reducing blank lane-to-lane gaps: horizontal corridors now use two stacked open rows per lane, with fewer separator rows so the recovered vertical space makes the lanes taller instead of shrinking the maze.

- Stage 1 refinement: turn connectors widened horizontally by using 3-cell openings at bends, so corners feel roomier; this also lets colored brick gates read as full lane blockers across the thicker-lane shape.

- Stage 1 cleanup pass: connector openings normalized to 4-cell turn widths, and the start lane narrowed slightly at the far-right corner to make the launch area look cleaner and more intentional while preserving the thicker-lane concept.

- Stage 1 refinement: turn connectors are now explicitly 2 cells wide by 2 cells tall.

- Stage 1 refinement: brick gates are temporarily disabled for Stage 1 only, per user request.

- Stage 1 behavior fix: stacked 2-row corridor bands are now treated as one fused movement lane for square positioning, so squares and the flood no longer get trapped cycling inside the upper/lower half of a thicker lane.

- Reworked Stage 1 safely: restored single-row corridor logic for movement/flood, then thickened lanes in rendering only by visually enlarging open floor bands and shrinking apparent gaps between them.

- Stage 1 visual thickening refined: horizontal corridor runs are now rendered as merged thick bands rather than thickened per-cell outlines, removing duplicate inner wall lines while keeping the single-path logic intact.

- Stage 1 renderer switched to custom merged lane shapes: straight runs and turns are outlined as single thick corridor shapes instead of stitched from per-cell border fragments.

- Reset to stable Stage 1 logic/rendering, then applied one minimal visual-only change: Stage 1 corridor floor bands are slightly overpainted above/below open rows to reduce the apparent dark separator gap without altering movement, flood, or path logic.

- Added a Stage 1 visual-geometry layer: merged thick horizontal lane rectangles plus narrow vertical connector rectangles are now generated separately from gameplay logic so Stage 1 can be visually denser while keeping the stable one-cell path underneath.

- Stage 1 visual architecture revised again: instead of stitched rectangles, the corridor is now rendered from the underlying Stage 1 path as one continuous thick stroked shape (outer wall stroke + inner floor stroke), while gameplay logic remains unchanged.

- Stage 1 corridor corners changed from rounded joins to sharp 90° corners by using butt caps + miter joins in the continuous-path visual renderer.

- Stage 1 flood renderer now follows the same continuous path geometry and fills the corridor width horizontally instead of drawing as separate cell blocks.
