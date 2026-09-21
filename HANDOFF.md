# Handoff — 2026-09-20

Written for whoever picks this up next (including Claude Code). Everything below
was established by running the app, not by reading it: a GPS test harness now
lives in `app/test/`, and every claim here has a check behind it.

## The one-paragraph version

`app/src.html` is the whole application — a single self-contained file, vanilla
React over CDN (precompiled into `www/` by `build.js`), no framework, no build
step while developing. Across three sessions it has had eight bugs found and
fixed, its spraying screen stripped back (no nav banner, ETA bar or 3D tilt),
and its save system made fully automatic — each with regression checks in
`app/test/run.js` (33 checks, all passing). `build-41` — the APK built from the
save-system commit — is installed on the owner's phone.

## Start here

```bash
cd app
node build.js                        # regenerate www/ — it is gitignored, so always stale on a fresh clone
npx http-server www -p 8080
node test/run.js                     # 60 checks, ~18 min, expect 60/60
ONLY=refillReach,manualResume node test/run.js   # a subset, by function name
```

If `test/run.js` is not 60/60 on a clean checkout, something in the fixes below
has regressed — read the table in `app/test/README.md` to see which.

Two notes on running it:

- Playwright's own chromium download is slow on this machine. The harness takes
  `CHROME_PATH`, and the installed Chrome works:
  `CHROME_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" node test/run.js`.
- `core.autocrlf` is `true` here, so `src.html` sits in the working tree as LF
  while git stores and checks it out as CRLF. Git normalises both sides, so the
  diffs stay small and the CRLF warning on `git add` / `git diff` is noise, not
  damage. (An earlier revision of this file said the working copy must stay CRLF
  — that turned out not to matter as long as `autocrlf` is on.)

## Where things stand

- Everything is on `main` and pushed; the last code commit is `10b5444`
  (station step / edit in place). `build-55` is built from it and
  installed on the phone.
- **Check which commit a build came from before installing it.** Build numbers
  are the workflow run number, and a docs-only push makes a build too — build-39
  turned out to be the docs commit, not the UI change it was assumed to be, and
  went onto the phone as "the update". `git ls-remote --tags origin build-N`
  gives the commit.
- The owner has a real unfinished mission saved on the phone (4.90-rai field
  ถั่ว 1, 13,709 cells = 1,234 m² sprayed). It is theirs — don't finish or
  discard it while testing. To test on the phone, back up every localStorage
  key first, and restore BOTH copies afterwards — localStorage and the native
  `DATA/active-session.json` — or the newer native file wins on the next launch.
  Stub `Storage.prototype.setItem` and `Filesystem.writeFile` before the
  reload, or the app's save-on-unload writes the test state straight back.
  Wait ~20 s after the reload before killing anything (WebView commit delay).
- The working tree is clean. `playwright` is a committed devDependency, so
  `npm i` on a fresh clone is enough to run the harness — only the browser
  binaries are still separate (`npx playwright install chromium`, or point
  `CHROME_PATH` at an installed Chrome). The APK workflow is unaffected: neither
  `playwright` nor `playwright-core` declares a postinstall, so `npm ci` pulls
  the tarballs without downloading browsers.

## What changed

Eight bugs, in the order they were found. BUGs 1–3 came from the first session's
five-scenario run; 4 was an open item from it; 5–8 came out of fixing 4 and
writing its tests.

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

Fixed by resetting wind (and the weather note) when the mission ends. The first
attempt put that in `finishMission()`; BUGs 5 and 6 below are the two things
that turned out to be wrong with it, and the reset now lives on a
`phase === 'done'` effect. Read those two before touching this again.

`resetSim()` was the other candidate and is the wrong one — the width stepper
calls it on every adjustment, so the reset would fire while the operator was
still setting up, wiping a tick they had just made.

Covered by three new checks (`windReset` in `test/run.js`): that the tick
registers, that FINISH → START NEW clears it, and that PPE is *not* cleared with
it. Verified as a real regression test — with the fix reverted the middle check
fails (`wind=true`) and the others still pass.

### BUG 5 — the wind reset erased the compliance record it was meant to outlive

Introduced by BUG 4's first fix, and it did ship: `build-36` went onto the
owner's phone with it. `saveMission()` builds the Spec §5 compliance log from
the live `checklist`, but by the time the operator taps SAVE SESSION on the
summary the reset has already fired — so a mission where Wind *was* checked
filed a record saying it wasn't. The fix for the open item quietly corrupted the
compliance trail it was supposed to be keeping honest.

`missionChecklistRef` now snapshots the checklist on entry to `'done'`, before
the reset, and `saveMission()` builds the record from that.

Any mission saved from `build-36` may carry `checklist.wind: false` wrongly.
Only `build-36` is affected — it was installed and used for one SIM walkthrough,
and the history written during that walkthrough was restored from a backup
afterwards, so in practice there is probably nothing to correct. Worth knowing
if a record from that window ever looks wrong.

### BUG 6 — wind survived the SIM route-follower's auto-finish

The reset lived in `finishMission()`, which is only the manual FINISH button.
When the SIM route-follower walks the last leg it sets `phase = 'done'` itself,
so that path kept the tick. Moved the reset onto a `phase === 'done'` effect,
which covers every way a mission can end, and dropped the now-dead copies in
`finishMission()` and `saveMission()`. GPS-mode operators could not reach this —
`'done'` has no other entrance there — but it made the on-device SIM walkthrough
disagree with the test suite, which is reason enough.

### BUG 7 — a touch-up credited nothing for re-spraying covered ground

Found by writing the test for BUG 8 below. `startTouchUp()` seeds the new sim's
`lastPass` from the finished mission but `makeSim()` restarts `epoch` at 0, and
`stamp()` only credits overlap when a cell's stored id *differs* from the
incoming one. So the touch-up's first lane reused ids the previous mission had
already written: walking back over ground you had just sprayed added no new area
(the cells are not virgin) and no overlap (the id matched). It vanished.

Fixed with `fresh.epoch = prev.epoch + 1`. Ids only increase, so that is past
every seeded id and past the `-1`/`-2` sentinels for unsprayed and restored
ground. This is the same class as BUG 2 — a pass-id collision — in the one code
path that manufactures its own seeded grid.

**This one is GPS-only, and that matters for how you test it.** SIM does not go
through `sim.epoch` at all: `advance()` stamps with `target.passId`, an id that
comes off the route waypoints, so a SIM touch-up only ever collided on its first
leg and still reported most of its overlap. A SIM walkthrough on the phone
therefore looks almost fine both before and after the fix and proves nothing
about it. The GPS check in `test/run.js` is the evidence: pre-fix it reports
`0 rai` overlapped on a touch-up over covered ground, post-fix `0.06 rai`.
Real operators are always in GPS mode, so they had the full-lane version of the
bug.

### BUG 8 — "0% of sprayed area" under a non-zero overlap figure

A touch-up over a field already at 100 % breaks no new ground, so the overlap
percentage (`mOverlapCells / mSprayedCells`) divides by zero and the guard
returned a flat `0`. The summary then showed `0.90 rai` overlapped and `0% of
sprayed area` on the line below it.

The sub-line is now built once as `overlapSub`: the percentage when there is new
ground, `re-sprayed over ground already covered` when there is not, and `no
ground covered twice` when there is no overlap at all. The `≈ N L wasted`
estimate rides along in the first two, and stays omitted until a tank has
actually been closed, since it is derived from the measured rai-per-tank.

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

### Saving is fully automatic (session 3)

The owner reported the save system as unusable and chose "save everything
automatically". What was actually broken, and what replaced it:

- **Resume silently failed on any real-sized field.** The session snapshot
  stored the raw RGBA pixel grid plus the Int32 `lastPass` array as base64:
  measured 1.05 M chars for 4 rai, 3.99 M for 16 rai, and **nothing at all for
  39 rai** — `localStorage` tops out near 5 M chars, `saveActiveSession()`
  swallowed the quota error, and the phone's log and history already use
  ~0.6 M. Snapshot v2 keeps only `passes` and `missed`, run-length encoded
  (39 rai: 17 k chars), and restore rebuilds the pixels with `paintCell()` and
  `lastPass` with the `-2` "restored" sentinel. v1 snapshots still load. A
  failed autosave now writes an `ERR` line to the test log instead of vanishing.
- **Restore is automatic.** The "Unfinished mission detected" modal and the
  Tools menu "Resume saved session" row are gone; an unfinished mission comes
  back on launch, PAUSED, with a notice. The "reopen last field" startup effect
  is skipped when that happens (`resumedAtStartRef`), or it would reset the sim.
  The notice is plain text on purpose — an earlier version bolded RESUME as its
  own element and a text match hit it instead of the dock button.
- **Fields save the moment the boundary closes** (`closeBoundary()`), named
  `แปลง DD/MM HH:MM`. Before, a plotted field stayed unsaved until SAVE or START
  SPRAYING, so closing the app lost the walk. Field setup's SAVE / SAVE NEW
  (which made duplicates) is now RENAME FIELD.
- **Station, spray width and tank size are written back to the active field.**
  Moving a saved field's station used to last only until it was reloaded.
- **Missions file themselves in history on arrival at the summary**
  (`recordMission()` from the `phase === 'done'` effect). SAVE SESSION is gone;
  START NEW no longer silently throws the mission away. `missionRecordIdRef`
  (also carried in the session snapshot) makes the record an upsert, so closing
  the summary back to PAUSED and finishing again updates one record.
  `beginNewMission()` clears it at START SPRAYING, START NEW and TOUCH-UP.

### The owner's workflow (session 3, from their own diagram)

The owner drew the intended flow and it replaced three pieces of the old one:

- **Refill is two taps, no GPS geometry.** TANK EMPTY turns recording off and
  points at the station; REFILLED · START SPRAYING (dock, or the tank tile's
  REFILLED · SPRAY) turns it back on wherever the operator stands. The
  arrive-at-station / return-to-breakpoint states (`refilling`,
  `toBreakpoint`), the breakpoint pin, all the radii and the spray-time
  auto-refill near the station are gone; `opMode` is `spray | toStation`.
  Sessions saved by older builds map the removed states to `toStation`.
  The two buttons share a spot on the dock, so each ignores the other for 2 s
  after a switch (`modeSwitchAtRef`) — a gloved double tap would otherwise undo
  itself and close a phantom zero-area tank.
- **FINISH asks**: FIELD DONE · CLOSE ROUND N, or NOT DONE · CONTINUE LATER.
- **Fields are sprayed in numbered rounds.** `entry.round` is the open round
  (missing = 1). Continue-later keeps the round and its `cov`; field-done files
  `{n, finishedTs, rai}` in `entry.rounds`, drops `cov`/`stats` and bumps
  `round`, so the next spraying starts on an empty map. History records carry
  `round`, `complete`, `fieldName`. TOUCH-UP and the summary's X (back to
  PAUSED) are gone — continue-later covers both.

Also: the summary has an X that goes home (same as START NEW), and the
Android back button closes one layer per press — FINISH choice, summary,
dialogs, history, library, menus, station setup, plotting — then minimizes
(never exits, so a running mission keeps tracking). `@capacitor/app`
provides the event; `window.__agrasBack` lets the browser tests press it.
Verified on the phone with the real key (`adb shell input keyevent
KEYCODE_BACK`).

### Home-screen redesign (session 3, from the owner's annotated screenshots)

Satellite only — the imagery toggle is gone, and with it MARK CORNER (it only
showed with imagery off). Walking a boundary is now: stand at the corner,
Center on my location, ADD AT CROSSHAIR; `harness.makeField` plots that way.
The north-up control is a red arrowhead (`NorthArrow`) that points north. The
field card and START SPRAYING share a row; spray settings, the pre-flight
checklist, plot / station / rename and the tools (offline map, history, test
log) all live in one SETTINGS sheet behind a round button (aria-label
"Settings") with an amber dot while the checklist is incomplete or the weather
warns. The two top cards are equal size. The field boundary is a white line on
a dark halo. The Offline map screen closes itself when its download finishes.
A **new** field (ADD FIELD in the library, or nothing saved active) goes from
CLOSE FIELD straight to placing the refill station. **Redrawing** a saved field
(Settings → EDIT BOUNDARY) edits it in place — name, station, round number and
filed rounds kept, no station step — and drops only the open round's `cov`,
since its cells were laid out on the old boundary (`editingFieldIdRef`).
Every design round was shown to the owner as phone-sized screenshots (their
real field's coordinates, tiles allowed) before anything was built.

Found while testing it: **every field-library write must go through
`updateLibrary()`**. Three writers (rename, delete, the "last sprayed" stamp)
saved from inside a `setFieldLibrary(updater)`, which runs a render later on an
older list — at FINISH the stamp overwrote the closed round in storage while
the screen showed round 2. The rounds test reloads and checks what was stored.

### Field test 2026-09-21 — the refill trip silently stopped recording

The owner's first real spraying run on the automatic-save build (16:56–17:48,
4.90-rai ถั่ว 1, screen off almost throughout). From the test log:

- 16:56–17:00 sprayed and recorded 902 m². 17:00:58 TANK EMPTY → `toStation`.
- **`sprayed=902m2` never moved again** while `dist` went 194 → 1,700 m. No
  `refilling`, no `toBreakpoint`, ever. The mission filed at 0.56 rai.
- Projecting the logged fixes: the operator's closest approach to the station
  pin after TANK EMPTY was **3.0 m** (GPS ±3 m at the time). The arrival radius
  was 2.5 m. GPS over the run: 4,785 fixes, median ±3 m, p90 ±10 m.
- At 17:23 they tapped the tank tile (labelled TANK EMPTY even mid-trip);
  `refillTank()` opened tank 2 but left `opMode` at `toStation`, so spraying
  stayed off for the remaining 25 minutes. REFILLED FULL TANK only appears once
  the app believes you are *at* the station, so it never showed.

(Superseded by the owner's two-tap workflow above.) First fixed in four parts: `STATION_ARRIVE_RADIUS = 8` m for arriving after TANK
EMPTY and `BREAKPOINT_RADIUS` 1.5 → 5 m (the spray-time auto-refill trigger
stays at 2.5 m so a lane past the station does not cut spraying off); a RESUME
SPRAYING dock button replaces the disabled TANK EMPTY in every refill state;
the tank tile reads TANK REFILLED mid-trip and, from `toStation`, moves on to
`toBreakpoint`; and a screen-off alert fires after 40 m walked inside the field
during the trip that did not bring the operator 20 m closer to its target.

The lost 47 minutes are still in the log as a GPS track; they were not
reconstructed, because which stretches had the nozzle open is not knowable
from the log alone (the walk to the tank and the fill are in there too).

Everything else in that log was healthy: continuous fixes with the screen off
(headless frames every minute), 82 % → 76 % battery in 52 minutes, the mission
filed itself on FINISH, and the startup restore at 18:04 read both copies.

### Kill-testing the save on the phone (session 3)

Driven over CDP with `am force-stop` as the kill, SIM at 20×:

| | build-41 (localStorage only, 15 s autosave) | build-43 (+ native file, 5 s) |
|---|---|---|
| screen off, then killed | nothing lost | — |
| killed mid-spray | lost 1,242 m² (the last 15 s) | lost 77–89 m² |
| killed ~0.5 s after SAVE & PAUSE | that save lost, 3 of 3 | that save restored, 3 of 3 |

The cause: **Android's WebView does not commit localStorage to disk when
`setItem` returns** — it holds writes for several seconds, and a process kill
in that window drops them. In the build-43 runs the app's own log shows the
localStorage copy 12 s stale at every relaunch and the native file 4–5 s old,
and restores from the file. Screen-off is safe on both builds because the
visibility save has time to commit before Android gets round to killing the
process. Real walking is ~20× slower than the SIM, so the build-43 mid-spray
loss is on the order of 5 m².

Not covered: a real power loss (the file write is in the OS page cache, not
fsync'd), and whether a mission finished and then killed within a few seconds
can come back — the delete of both copies has the same commit window as a
write, so it can, and FINISH on it would just update the same history record.

## Verified on the phone, and what wasn't

`build-37` was driven on a Galaxy S23 Ultra over CDP, in dev/SIM mode, against
the owner's own saved data. Confirmed there: the checklist row wording, wind
expiring on both the FINISH path and the SIM auto-finish, the filed compliance
record keeping `wind: true` while the live checklist showed `false`, the
OVERLAPPED sub-line reading `re-sprayed over ground already covered` on a run
that broke no new ground, and the whole hands-free refill cycle (TANK EMPTY →
walk to station → REFILLING → walk back → auto-resume at the breakpoint).

**Not verified on the phone: BUG 7**, for the reason in its section above — SIM
cannot reach it. Confirming it on a real device means walking a field in GPS
mode, finishing, tapping TOUCH-UP, and re-walking sprayed ground to see whether
OVERLAPPED moves. That has not been done.

### Driving the app on the phone

```bash
adb shell am start -n com.agras.fieldtracker/.MainActivity
adb shell cat /proc/net/unix | grep -o "webview_devtools_remote_[0-9]*"
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
```

Then talk to `http://localhost:9222/json` over CDP. Three things cost time here:

- **Back up `localStorage` first and restore it after.** A dev-mode SIM mission
  writes real coverage into the operator's saved field and a real row into their
  mission history — `persistCoverage()` fires on autosave, not just on save.
- **Restore and `location.reload()` in the same evaluation.** Restoring while
  the app is running is not enough: React still holds the old mission list in
  state and writes it straight back over you. Reloading in the same expression
  is what makes it stick.
- **The SIM route-follower stops when the screen sleeps.** It runs on
  `requestAnimationFrame`, so a dozing phone freezes the walk mid-field and the
  numbers sit still. `adb shell svc power stayon usb` for the duration, and put
  it back with `stayon false`. (Real GPS tracking is unaffected — that is the
  headless frame path, driven by fixes from the foreground service.)

## Still open

In the order I'd do them.


1. **Outbound nav-line colour.** The leg to the station is teal
   (`rgba(46,230,199,.85)`); only the return legs are amber. The test plan
   expected amber outbound. Cosmetic, unclear which is intended.

2. **BUG 7 has never been seen on real hardware in GPS mode.** The fix is
   right and the GPS-fed test proves it, but nobody has walked a field, tapped
   TOUCH-UP and re-crossed sprayed ground with a real phone. The next field day
   is the chance to confirm OVERLAPPED actually moves.

3. **`≈ N L wasted` needs a closed tank before it appears.** It is derived from
   the measured rai-per-tank average, so a mission where the operator never taps
   TANK EMPTY shows overlap in rai with no litres beside it. That is honest —
   there is nothing to derive it from — but if the figure is wanted on every
   mission it needs another source, and the Rate field is deliberately gone.

## Decided, do not reopen

- **Overlap reading over 100 % is intended.** It is
  `overlapCells / sprayedCells × 100` counting overlap *events*, so ground
  covered three times reads 200 %, and a single retrace of a lane reads 100 %
  (measured). The owner's call was to keep it exactly as is — not capped, not
  relabelled, not converted to a "×2.0 passes" figure. It is the right number
  for "chemical wasted as a share of the field", which is how the summary frames
  it, alongside the `≈ N L wasted` estimate.

## Things worth knowing before you edit

- **`src.html` is the source of truth.** `www/` is generated and gitignored;
  never hand-edit it. `build.js` precompiles the JSX, vendors React, runs
  Tailwind against `src.html`, and inlines the fonts.
- **Validate before delivering.** The project convention is to compile the
  `<script type="text/babel">` block and run `node --check` on the output —
  `node build.js && node --check www/app.js`. That catches the syntax errors a
  4,300-line single file invites. It will not catch a `const` used above its
  declaration: the render body is one long run of derived values, and a helper
  added near where it is *used* rather than after what it *reads* throws only at
  runtime. Adding `overlapSub` hit exactly that.
- **Watch for pass-id collisions.** BUG 2 and BUG 7 are the same mistake in two
  places. `stamp()` credits overlap only when a cell's stored `lastPass` differs
  from the incoming id, so any code path that seeds a grid, restarts a counter,
  or invents its own ids has to guarantee the new ids cannot collide with the
  stored ones. `applyCoverage()` does it with the `-2` sentinel, `startTouchUp()`
  by carrying the counter forward. A third path would need the same care.
- **SIM mode is dev-only** — `srcMode` is hard-defaulted to `'gps'` and the
  toggle only renders under `devMode` (the secret tap on the status pill, or
  `localStorage.agras_dev = '1'`). Any test plan that starts "switch to SIM
  mode" is written against an older build.
- **Rate Zones remain deliberately out of scope.** They would need the data
  model and all the water-calculation logic reworked; that was a decision, not
  an oversight.

## Full test report

The first session's five-scenario write-up was saved as
`claude/test-report-2026-09-20.md` in the Claude project, not in this repo — it
is not at that path in the working tree, so treat it as possibly gone. Nothing
here depends on it: every claim above has a check in `app/test/run.js` behind
it, and that is the durable record.
