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
| touch-up over covered ground: overlap rai > 0, sub-line not a bare 0% | the seeded pass-id collision (BUG 7) and the zero denominator (BUG 8) |
| closed boundary is in the library before spraying; station moves are written back | field auto-save |
| FINISH files the mission; re-finishing updates it; the next mission gets its own | mission auto-save |
| a 39-rai field's session saves and survives a reload | the localStorage quota blow-out |
| arriving 5 m from the station pin counts; 4 m from the breakpoint resumes | the 2.5 m / 1.5 m radii that stranded the 2026-09-21 field run |
| RESUME SPRAYING works from anywhere; tile TANK REFILLED away from the pin moves on | no way out of the refill trip |
| walking the field during the trip alerts; walking straight to the station doesn't | spraying unrecorded with the screen off |

## Writing more

`harness.js` exports `boot`, `makeField`, `walk`, `moveTo`, `tap`, `tapRe`,
`lines`, `stat`, `summary`. Field geometry is local metres from an anchor at
14 N / 100 E, so `[40, 10]` is 40 m east and 10 m north of it. The default field
is an 80 × 80 m square = 4.00 rai, with the refill station outside it at
`[-10, -10]`.

Two gotchas worth knowing before you add a case:

- `makeField` switches satellite imagery **off** first. With it on, boundary
  plotting is crosshair-based (drag the map), which geolocation alone cannot
  drive. With it off you get `MARK CORNER`, which marks the live fix.
- There are two `TANK EMPTY` buttons in the DOM (the tank tile's and the dock's)
  and only ever one visible, which is why `tap()` filters on `visible=true`.
