# GPS test harness

Drives the built `www/` bundle in headless Chromium through real
`navigator.geolocation` fixes. Every check is reachable by an operator walking a
real field — no dev mode, no internal hooks, no SIM mode (SIM is `devMode`-only
on this build; `srcMode` is hard-defaulted to `'gps'`).

## Run

```bash
cd app
npm i && npx playwright install chromium   # first time only; playwright is already a devDependency
node build.js
npx http-server www -p 8080          # or: python -m http.server 8080 --directory www
node test/run.js
```

Playwright's own chromium download is slow on this machine; the installed Chrome
works and skips it entirely:

```bash
CHROME_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" node test/run.js
```

`run.js` exits non-zero if any check fails. A full run takes about seven minutes —
the walks are fed one geolocation fix at a time on purpose, because the app
treats a jump over 30 m as a GPS glitch and deliberately paints nothing.

Env: `PORT` (default 8080), `CHROME_PATH` (default: playwright's own download).

## What it covers

| Check | Guards against |
|---|---|
| clean lane → 0 % overlap | GPS jitter manufacturing phantom overlap |
| retraced lane → overlap > 50 % | the pass-id regression (see HANDOFF.md, BUG 2) |
| tidy 5-lane job → < 15 % overlap, no missed spots | lane splitting too eagerly at the turns |
| virgin ground walked while PAUSED → missed > 0.05 rai | the missed-spot gate (BUG 3) |
| refill round trip → no missed spots | the walk to the tank hatching the map red |
| refill confirmed twice → TANKS USED 2, no 0.00-rai tank | the phantom-tank regression (BUG 1) |
| geofence: banner, painting halts, auto-resumes | Scenario 2 |
| reload mid-mission: restored by itself, PAUSED, coverage + breakpoint intact | Scenario 5, automatic restore |
| FINISH → START NEW clears Wind but keeps PPE | the wrong-event wind reset (BUG 4) |
| the filed compliance log still records Wind as checked | the reset eating the record (BUG 5) |
| continuing a round over its own ground: overlap rai > 0, sub-line not a bare 0% | the seeded pass-id collision (BUG 7) and the zero denominator (BUG 8) |
| closed boundary is in the library before spraying; station moves are written back | field auto-save |
| FINISH files the mission; re-finishing updates it; the next mission gets its own | mission auto-save |
| a 39-rai field's session saves and survives a reload | the localStorage quota blow-out |
| TANK EMPTY stops recording; REFILLED · START SPRAYING resumes anywhere; the tile does too | the two-tap refill trip |
| a double tap on the refill button doesn't undo itself | the shared dock spot |
| NOT DONE keeps the round; FIELD DONE opens round N+1 on an empty map, and that is what is stored | rounds, and the stale library write |
| walking the field during the trip alerts; walking straight to the station doesn't | spraying unrecorded with the screen off |
| back closes one layer; with nothing open it minimizes | the Android back button |
| no imagery toggle; field + START on one row; Settings dot follows the checklist | the home-screen redesign |
| a new field goes to the station step; EDIT BOUNDARY keeps the field and skips it | the owner's plotting flow |
| chemicals asked once per round, kept into the closed round; report + share text | the spray report |
| plotting opens ~100 m across; Show all corners; CLOSE FIELD hint; name a new field; Settings caption + reason chip; DONE on screen; round 2 gets the whole chemical set | the farmer walk-through fixes |
| the clock stops for the refill trip and runs again after REFILLED; summary says SPRAY TIME | spray time only |
| the field remembers where spraying stopped; home shows the distance and frames the whole field; a closed round forgets it | carrying on with a field |
| ROUTE: lanes one swath apart, tanks per rai, start nearest the station, direction switch, back closes, Edge gap | suggested route |
| SIM: tank runs out per area, walks to the station and back without painting, covers the field, stops at FINISH | SIM walks the route |
| SIM → GPS mid-mission: the SIM walk stops, no auto-REFILLED, the record is tagged `src: 'sim'` | SIM→GPS switch |
| Field app (`prod`): no DEV even with the old flag, 7-tap ignored, no test-log row; test app: DEV on, TEST tag | two apps |
| Crop check: photo pinned at the operator, field card counts it, AI (mocked) queued offline and done online with Sonnet 5 + JSON schema + the key, listed in the report | crop check |
| a fetched Esri tile is really in Cache Storage; the in-memory tile cache drops the least recently drawn tile and revokes its blob; `buildField()` matches per-sample `pointInPoly()`; the missed-cell counter matches the grid; GPS pace is steady at a steady walk | the CPU/RAM pass: offline map never stored, blob leak, scanline rewrite, pace spikes |

## Writing more

`harness.js` exports `boot`, `makeField`, `walk`, `moveTo`, `tap`, `tapRe`,
`lines`, `stat`, `summary`. Field geometry is local metres from an anchor at
14 N / 100 E, so `[40, 10]` is 40 m east and 10 m north of it. The default field
is an 80 × 80 m square = 4.00 rai, with the refill station outside it at
`[-10, -10]`.

Two gotchas worth knowing before you add a case:

- `makeField` plots each corner the way an operator walking the boundary
  does: set the fix, tap Center on my location, tap ADD AT CROSSHAIR. The app
  is satellite-only, so there is no MARK CORNER any more. `openSettings()`
  opens the one Settings sheet (checklist, station, tools).
- There are two `TANK EMPTY` buttons in the DOM (the tank tile's and the dock's)
  and only ever one visible, which is why `tap()` filters on `visible=true`.
