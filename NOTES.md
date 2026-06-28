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
