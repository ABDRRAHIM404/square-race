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
