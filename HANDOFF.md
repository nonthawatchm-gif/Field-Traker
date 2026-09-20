# Handoff — 2026-09-20 (updated later the same day)

Written for whoever picks this up next (including Claude Code). Everything below
was established by running the app, not by reading it: a GPS test harness now
lives in `app/test/`, and every claim here has a check behind it.

## The one-paragraph version

`app/src.html` is the whole application — a single self-contained file, vanilla
React over CDN (precompiled into `www/` by `build.js`), no framework, no build
step while developing. Today's session ran five scenarios against it, found
three bugs, fixed all three in `src.html`, and left four smaller items open.
A later session picked this up: `www/` is rebuilt, open item 1 (the wind reset)
is fixed and has a check of its own, and everything is committed.

## Start here

```bash
cd app
node build.js                        # regenerate www/ — it is gitignored, so always stale on a fresh clone
npx http-server www -p 8080
node test/run.js                     # 18 checks, ~7 min, expect 18/18
```

If `test/run.js` is not 18/18 on a clean checkout, something in the fixes below
has regressed — read the table in `app/test/README.md` to see which.

Two notes on running it:

- Playwright's own chromium download is slow on this machine. The harness takes
  `CHROME_PATH`, and the installed Chrome works:
  `CHROME_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" node test/run.js`.
- `core.autocrlf` is `true` here, so `src.html` sits in the working tree as LF
  while git stores and checks it out as CRLF. Git normalises both sides — the
  three-session diff is still 67 insertions / 10 deletions, not a whole-file
  rewrite — so the CRLF warning on `git diff` is noise, not damage.

## What changed today

47 insertions, 6 deletions in `app/src.html`. CRLF line endings — the file is
CRLF throughout and must stay that way; a tool that silently rewrites it to LF
turns a three-line change into a whole-file diff.

### BUG 2 — overlap was never detected within a spray run

`stamp()` only credits overlap when a cell's stored pass id differs from the
incoming one. In GPS mode the id passed in was `sim.epoch`, which advances in
exactly one place: breakpoint re-entry after a refill. So every fix in a
continuous run carried the same id and re-crossing your own ground was a no-op.
Measured: the same 60 m line walked three times reported 149 m² sprayed and
**0 % overlap**; the same retrace after a refill cycle reported 100 %.

Fixed with a lane tracker beside `stamp()`:

```js
const PASS_TURN_RAD = 2.0944;   // 120° — a turn, not a curve
const PASS_MIN_SEG_M = 1.5;     // below this it's jitter at ±4m accuracy
function gpsPassId(sim, from, to) { ... }
```

`sim.epoch` stays the id carrier — so save/restore needed no new persisted field
and the refill bump still works — but it now also advances at a real turn. The
1.5 m floor rejects jitter at ±4 m accuracy; the 0.3 EMA absorbs a gradually
curving field edge so following an irregular boundary never splits a lane, while
a headland U-turn always does. `sim.passHeading` is added to `makeSim()` and
reset to `null` at the breakpoint resume.

### BUG 3 — missed spots never fired

`markMissed()` sat behind `spraying`, which is `running && opMode === 'spray'`.
Combined with the `armed` test above it, the only reachable state was the single
fix on which the operator crossed back over the boundary. Walking while paused
flagged nothing; five out-and-back crossings over virgin ground gave 0.00 rai.

Fixed by splitting the predicate: `spraying` still gates real spray, and a new
`onSprayLane = missionActive && opMode === 'spray'` gates flagging.
`missionActive` is running **or** paused. The refill legs stay excluded, so the
walk to the tank never hatches the map red.

The renderer was never at fault — `paintCell(i, j, -1)` and `markMissed()`'s
geometry (including the `insideRatio < 0.5` edge exemption) were both correct.

### BUG 1 — `REFILLED FULL TANK` double-counted a tank

Arriving at the station already calls `openTank()`. The button called it again,
and since `openTank()` starts with `closeTank()`, each tap pushed a phantom
0.00-rai tank. One physical refill reported `TANKS USED 3 · avg 0.02 rai/tank`.
Guarded with `if (!tankOpenRef.current) openTank();`.

### BUG 4 — wind survived a mission on the FINISH → START NEW path

Was open item 1. `setChecklistField('wind', false)` lived only in
`saveMission()`, so FINISH → START NEW carried the previous mission's Wind tick
straight into the next pre-flight — the fastest path between two back-to-back
missions, and exactly the case the 4-hour PPE memory exists for. SAVE SESSION
and a page reload always reset it correctly, which is why it hid for so long.

Fixed by resetting wind (and the weather note) in `finishMission()`, which is
the one handler every manual mission exit goes through. `saveMission()` keeps
its own reset: the SIM route-follower's auto-complete sets `phase = 'done'`
directly and never calls `finishMission()`.

`resetSim()` was the other candidate and is the wrong one — the width stepper
calls it on every adjustment, so the reset would fire while the operator was
still setting up, wiping a tick they had just made.

Covered by three new checks (`windReset` in `test/run.js`): that the tick
registers, that FINISH → START NEW clears it, and that PPE is *not* cleared with
it. Verified as a real regression test — with the fix reverted the middle check
fails (`wind=true`) and the other seventeen still pass.

### Smaller changes in the same commit

- **Checklist wording** (was open item 3) — the collapsed row now reads
  `2 items unchecked` / `All checked` rather than `2/4 checked`, matching the
  wording the Scenario 1 test plan expects.
- **Wasted litres in the summary** — `OVERLAPPED` now carries an `≈ N L wasted`
  estimate derived from the measured rai-per-tank average, so it only appears
  once at least one tank has been closed. It does not reintroduce the Rate
  field, which stays removed.
- **Touch-up baseline** — `startTouchUp()` now rebases `coverageBaseRef`,
  `tankAreasRef` and `tankBaselineAreaRef` onto the seeded grid. Before this the
  new mission's first tank and its overlap rai counted the *previous* mission's
  ground, so a touch-up run opened with a wildly inflated rai/tank figure.

## Still open

In the order I'd do them.

1. **Overlap can read over 100 %.** It is `overlapCells / sprayedCells × 100`
   and counts overlap *events*, so ground covered three times reads 200 %. That
   is the right number for "chemical wasted as a share of the field" and the
   summary frames it that way (`≈20.0 L wasted`), but it may read as a bug to an
   operator. Decide: keep, cap the display at 100 %, or relabel. This was
   reachable before today's fix too (a post-refill retrace already hit 100 %) —
   the fix just makes it common. **Needs a product call, not a code call.**

2. **Outbound nav-line colour.** The leg to the station is teal
   (`rgba(46,230,199,.85)`); only the return legs are amber. The test plan
   expected amber outbound. Cosmetic, unclear which is intended.

## Things worth knowing before you edit

- **`src.html` is the source of truth.** `www/` is generated and gitignored;
  never hand-edit it. `build.js` precompiles the JSX, vendors React, runs
  Tailwind against `src.html`, and inlines the fonts.
- **Validate before delivering.** The project convention is to compile the
  `<script type="text/babel">` block and run `node --check` on the output. That
  catches the syntax errors a 4,300-line single file invites.
- **SIM mode is dev-only** — `srcMode` is hard-defaulted to `'gps'` and the
  toggle only renders under `devMode` (the secret tap on the status pill, or
  `localStorage.agras_dev = '1'`). Any test plan that starts "switch to SIM
  mode" is written against an older build.
- **Rate Zones remain deliberately out of scope.** They would need the data
  model and all the water-calculation logic reworked; that was a decision, not
  an oversight.

## Full test report

`claude/test-report-2026-09-20.md` in the Claude project — all five scenarios,
what passed as found, the measured before/after numbers, and the reproduction
parameters.
