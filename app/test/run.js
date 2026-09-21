/* Regression run for the 2026-09-20 fixes, plus the scenarios that were already
 * passing and must not drift. Usage:
 *
 *   cd app && node build.js
 *   npx http-server www -p 8080   (or: python -m http.server 8080 --directory www)
 *   node test/run.js
 */
const { boot, moveTo, walk, tap, tapRe, stat, summary, makeField } = require('./harness');

/** FINISH now asks whether the field is done (closes the round) or not
 *  (continue later). Most checks only care about the summary, so default to done. */
async function finishAs(page, done = true) {
  await tap(page, 'FINISH', { wait: 700 });
  await tapRe(page, done ? /FIELD DONE · CLOSE ROUND/ : /NOT DONE · CONTINUE LATER/, { wait: 1800 });
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const num = (s) => parseFloat(String(s).replace(/[^\d.]/g, '')) || 0;

/* 1. Overlap — must be 0 on a clean lane, and must rise on a retrace.
 *    Before the pass-id fix this read 0% however many times you retraced. */
async function overlap() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 10], [40, 70], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 800 });
  const clean = num(await stat(page, 'OVERLAP'));
  check('one clean lane reports no overlap', clean === 0, `${clean}%`);
  await tap(page, 'RESUME', { wait: 800 });
  await walk(ctx, page, [40, 70], [40, 10], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 800 });
  const retraced = num(await stat(page, 'OVERLAP'));
  check('retracing the same lane reports overlap', retraced > 50, `${retraced}%`);
  await browser.close();
}

/* 2. A tidy job must not manufacture overlap out of GPS jitter: five lanes one
 *    swath apart should only overlap at the headland turns. */
async function tidyJob() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 20, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  let x = 20, up = true;
  for (let i = 0; i < 5; i++) {
    await walk(ctx, page, [x, up ? 10 : 60], [x, up ? 60 : 10], 2, 90);
    if (i < 4) { await walk(ctx, page, [x, up ? 60 : 10], [x + 2.5, up ? 60 : 10], 1.25, 140); x += 2.5; up = !up; }
  }
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  const ov = num(await stat(page, 'OVERLAP'));
  check('tidy 5-lane job stays under 15% overlap', ov < 15, `${ov}%`);
  await finishAs(page);
  const s = await summary(page);
  check('tidy job flags no missed spots', /MISSED SPOTS \| 0\.00 rai/.test(s), s.match(/MISSED SPOTS \| [^|]+/)?.[0]);
  await browser.close();
}

/* 3. Missed spots — ground crossed while PAUSED is skipped ground and must
 *    hatch red; the walk to the tank and back must not. */
async function missed() {
  {
    const { browser, ctx, page } = await boot();
    await page.waitForTimeout(1200);
    await makeField(ctx, page);
    await moveTo(ctx, page, 40, 10, 900);
    await tap(page, 'START SPRAYING', { wait: 1200 });
    await walk(ctx, page, [40, 10], [40, 70], 2, 100);
    await tap(page, 'SAVE & PAUSE', { wait: 900 });
    await walk(ctx, page, [40, 70], [15, 70], 2, 100);
    await walk(ctx, page, [15, 70], [15, 20], 2, 100);
    await finishAs(page);
    const s = await summary(page);
    const m = num(s.match(/MISSED SPOTS \| ([\d.]+) rai/)?.[1]);
    check('virgin ground walked while PAUSED is flagged missed', m > 0.05, `${m} rai`);
    await browser.close();
  }
  {
    const { browser, ctx, page } = await boot();
    await page.waitForTimeout(1200);
    await makeField(ctx, page);
    await moveTo(ctx, page, 40, 40, 900);
    await tap(page, 'START SPRAYING', { wait: 1200 });
    await walk(ctx, page, [40, 40], [40, 60], 2, 100);
    await tap(page, 'TANK EMPTY', { wait: 900 });
    await walk(ctx, page, [40, 60], [-10, -10], 4, 90);        // the walk to the tank crosses the field: must not hatch red
    await page.waitForTimeout(2200);
    await tap(page, 'REFILLED · START SPRAYING', { wait: 900 });
    await walk(ctx, page, [-10, -10], [40, 58], 4, 90);
    await page.waitForTimeout(900);
    await tap(page, 'SAVE & PAUSE', { wait: 900 });
    await finishAs(page);
    const s = await summary(page);
    check('the refill round trip flags nothing missed', /MISSED SPOTS \| 0\.00 rai/.test(s), s.match(/MISSED SPOTS \| [^|]+/)?.[0]);
    await browser.close();
  }
}

/* 4. One physical refill is one tank, however many times the operator taps
 *    REFILLED FULL TANK. Before the guard, each tap added a phantom 0.00-rai tank. */
async function tankCount() {
  const { browser, ctx, page, logs } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 40, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 40], [40, 60], 2, 100);
  await tap(page, 'TANK EMPTY', { wait: 900 });
  await walk(ctx, page, [40, 60], [-10, -10], 4, 90);
  await page.waitForTimeout(2200);
  // a double tap: the second lands where TANK EMPTY reappears and must be ignored
  const btn = page.locator('text="REFILLED · START SPRAYING"').locator('visible=true').first();
  await btn.click({ force: true }); await page.waitForTimeout(250);
  await page.locator('text="TANK EMPTY"').locator('visible=true').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(900);
  check('a double tap on REFILLED · START SPRAYING leaves spraying on', await sessionOpMode(page) === 'spray', `opMode ${await sessionOpMode(page)}`);
  await walk(ctx, page, [-10, -10], [40, 58], 4, 90);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page);
  const tanks = num((await summary(page)).match(/TANKS USED \| (\d+)/)?.[1]);
  check('one refill is two tanks, however it was tapped', tanks === 2, `TANKS USED ${tanks}`);
  const phantom = logs.filter((l) => /emptied after 0\.00 rai/.test(l)).length + ((await appLog(page)).match(/emptied after 0\.00 rai/g) || []).length;
  check('no phantom zero-area tank in the log', phantom === 0, `${phantom} found`);
  await browser.close();
}

/* 5. Geofence — painting stops on exit and resumes on re-entry with no tap. */
async function geofence() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 40, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 40], [40, 70], 2, 110);
  await walk(ctx, page, [40, 70], [95, 70], 3, 150);
  await page.waitForTimeout(1200);
  const atExit = num(await stat(page, 'AREA SPRAYED'));
  const banner = (await page.locator('text="OUT OF BOUNDS — PAUSED"').count()) > 0;
  check('out-of-bounds banner shows on exit', banner);
  await walk(ctx, page, [95, 70], [95, 40], 3, 150);
  await page.waitForTimeout(2500);
  const afterOutside = num(await stat(page, 'AREA SPRAYED'));
  check('painting halts while outside', afterOutside === atExit, `${atExit} -> ${afterOutside} m²`);
  await walk(ctx, page, [95, 40], [60, 40], 3, 150);
  await walk(ctx, page, [60, 40], [60, 20], 2, 110);
  const afterBack = num(await stat(page, 'AREA SPRAYED'));
  check('painting auto-resumes on re-entry', afterBack > afterOutside, `${afterOutside} -> ${afterBack} m²`);
  await browser.close();
}

/* 6. Crash recovery — reload mid-mission, resume, and the pixel buffer,
 *    breakpoint and tank state all have to come back. */
async function crashRecovery() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 10], [40, 60], 2, 100);
  await walk(ctx, page, [40, 60], [55, 60], 2, 100);
  await tap(page, 'TANK EMPTY', { wait: 900 });
  await walk(ctx, page, [55, 60], [30, 40], 3, 100);
  await page.waitForTimeout(1000);
  const before = num(await stat(page, 'AREA SPRAYED'));
  await page.reload();
  await page.waitForTimeout(3500);
  const notice = (await page.getByText(/Unfinished mission restored/).count()) > 0;
  check('an unfinished mission is restored by itself after a reload', notice);
  const paused = (await page.locator('text="PAUSED"').count()) > 0;
  check('it comes back PAUSED, awaiting a manual resume', paused);
  await tap(page, 'RESUME', { wait: 1200 });
  const after = num(await stat(page, 'AREA SPRAYED'));
  check('coverage survives the reload', after === before, `${before} -> ${after} m²`);
  const toSt = num(await stat(page, 'TO STATION'));
  const refillBtn = (await page.locator('text="REFILLED · START SPRAYING"').locator('visible=true').count()) > 0;
  check('the refill trip survives the reload', refillBtn && Math.abs(toSt - 64) < 3, `button ${refillBtn}, TO STATION ${toSt} m (expected ~64)`);
  await browser.close();
}

/* 7. Wind is a point-in-time reading and must not survive a mission. The reset
 *    used to live only in saveMission, so FINISH -> START NEW — the fastest path
 *    between two back-to-back missions — carried the old tick into the next
 *    pre-flight. PPE/mix-rate/nozzle keep their 4-hour memory and must not be
 *    cleared with it. */
const checklistState = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('agras-tracker-checklist') || '{}'); } catch (e) { return {}; }
});
async function windReset() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 10, 900);
  await tap(page, 'Pre-flight checklist', { wait: 500 });
  await tap(page, 'PPE worn', { wait: 400 });
  await tap(page, 'Wind checked', { wait: 500 });
  const before = await checklistState(page);
  check('wind ticks on the pre-flight checklist', before.wind === true, `wind=${before.wind}`);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 10], [40, 30], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page);
  await tap(page, 'START NEW', { wait: 1500 });
  const after = await checklistState(page);
  check('FINISH then START NEW clears the wind tick', after.wind === false, `wind=${after.wind}`);
  check('PPE keeps its 4-hour memory across the same path', after.ppe === true, `ppe=${after.ppe}`);
  await browser.close();
}

/* 8. Expiring the wind tick on the way into the summary must not erase it from
 *    the compliance record the operator then files. saveMission() reads a
 *    snapshot taken before the reset; reading the live checklist there would
 *    log Wind as never checked on a mission where it was. */
async function complianceLog() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 10, 900);
  await tap(page, 'Pre-flight checklist', { wait: 500 });
  await tap(page, 'PPE worn', { wait: 400 });
  await tap(page, 'Wind checked', { wait: 500 });
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 10], [40, 30], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page);
  const saved = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('agras-tracker-missions') || '[]')[0] || null; } catch (e) { return null; }
  });
  check('the mission is filed in history', !!saved, saved ? 'record present' : 'no record');
  check('the compliance log keeps the wind tick', saved?.checklist?.wind === true, `logged wind=${saved?.checklist?.wind}`);
  check('the compliance log keeps PPE', saved?.checklist?.ppe === true, `logged ppe=${saved?.checklist?.ppe}`);
  const live = await checklistState(page);
  check('the live checklist still expired wind for the next mission', live.wind === false, `wind=${live.wind}`);
  await browser.close();
}

/* 9. A touch-up over ground that is already fully covered breaks no new ground,
 *    so the overlap percentage has a zero denominator. It must not render as a
 *    flat "0% of sprayed area" under a non-zero rai figure. */
async function overlapSubLine() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 10], [40, 60], 2, 100);          // lay a lane down at x=40
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, false);                                 // not done: the round stays open with this lane on it
  await tap(page, 'START NEW', { wait: 1500 });
  await moveTo(ctx, page, 40, 20, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 20], [40, 55], 2, 100);          // the next session re-sprays only that lane
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, false);
  const s = await summary(page);
  const sub = s.match(/OVERLAPPED \| [^|]+\| ([^|]+)/)?.[1]?.trim() || '';
  const newRai = num(s.match(/AREA SPRAYED \| [^|]+\| ([\d.]+) rai/)?.[1]);
  const ovRai = num(s.match(/OVERLAPPED \| ([\d.]+) rai/)?.[1]);
  check('continuing a round over its own sprayed ground breaks no new ground', newRai === 0, `AREA SPRAYED ${newRai} rai`);
  check('it still reports the overlapped rai', ovRai > 0, `${ovRai} rai`);
  check('the overlap sub-line is not a bare 0%', !/^0% of sprayed area/.test(sub), sub);
  await browser.close();
}

/* 10. Fields save themselves. A closed boundary is in the library before any
 *     spraying starts, and moving its station is written back to it. */
const library = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('agras-tracker-field-library') || '[]'); } catch (e) { return []; }
});
async function fieldAutoSave() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page, undefined, [-10, -10]);
  let lib = await library(page);
  check('a closed boundary is saved to the library without START SPRAYING', lib.length === 1, `${lib.length} field(s)`);
  // field-local y grows southward (screen-style), so harness [-10,-10] is stored as x=-10, y=+10
  check('it saves with the station set right after plotting', lib[0] && Math.round(lib[0].station.x) === -10 && Math.round(lib[0].station.y) === 10,
    lib[0] ? `station ${lib[0].station.x.toFixed(1)},${lib[0].station.y.toFixed(1)}` : 'no field');
  await tap(page, 'Field setup');
  await tap(page, 'STATION');
  await moveTo(ctx, page, 90, 40, 800);
  await tap(page, 'MY LOCATION');
  await tap(page, 'CONFIRM STATION', { wait: 800 });
  lib = await library(page);
  check('moving the station is written back to the saved field', lib.length === 1 && Math.round(lib[0].station.x) === 90,
    lib[0] ? `${lib.length} field(s), station x=${lib[0].station.x.toFixed(1)}` : 'no field');
  await browser.close();
}

/* 11. Missions file themselves in history on FINISH. Closing the summary back
 *     to PAUSED and finishing again is the same mission: one record, updated. */
const history = (page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('agras-tracker-missions') || '[]'); } catch (e) { return []; }
});
async function missionAutoSave() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 10], [40, 40], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, false);
  let h = await history(page);
  check('FINISH files the mission in history on its own', h.length === 1 && h[0].round === 1 && h[0].complete === false,
    `${h.length} record(s)${h[0] ? `, round ${h[0].round}, complete ${h[0].complete}` : ''}`);
  await tap(page, 'START NEW', { wait: 1200 });
  await moveTo(ctx, page, 60, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [60, 10], [60, 30], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, false);
  h = await history(page);
  check('the next session gets a record of its own, still round 1', h.length === 2 && h[0].round === 1, `${h.length} record(s)`);
  await browser.close();
}

/* 12. A big field's unfinished mission must survive a reload. The old snapshot
 *     stored the raw pixel grid and blew the ~5M-char localStorage quota
 *     somewhere past 12-16 rai, and the save failed without a word. */
async function bigFieldResume() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page, [[0, 0], [250, 0], [250, 250], [0, 250]], [-10, -10]);
  await moveTo(ctx, page, 20, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [20, 10], [20, 60], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 1500 });
  const size = await page.evaluate(() => (localStorage.getItem('agras-tracker-active-session') || '').length);
  check('a 39-rai field session is actually saved', size > 0, `${(size / 1000).toFixed(0)}k chars`);
  const before = num(await stat(page, 'AREA SPRAYED'));
  await page.reload();
  await page.waitForTimeout(4000);
  const paused = (await page.locator('text="PAUSED"').count()) > 0;
  const after = num(await stat(page, 'AREA SPRAYED'));
  check('and it comes back after a reload with its coverage', paused && after === before && before > 0, `${before} -> ${after} m²${paused ? '' : ', not paused'}`);
  await browser.close();
}

/* 13. The refill trip with real GPS error. Field test 2026-09-21: the operator
 *     stood at the tank, the nearest fix was 3.0 m from the pin, the old 2.5 m
 *     radius never fired, and the app recorded none of the next 47 minutes. */
const txt = async (page) => page.evaluate(() => document.body.innerText);
const sessionOpMode = (page) => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('agras-tracker-active-session')).opMode; } catch (e) { return null; } });
const appLog = (page) => page.evaluate(() => localStorage.getItem('agras_log_v1') || '');
async function refillFlow() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 40, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 40], [40, 60], 2, 100);
  await tap(page, 'TANK EMPTY', { wait: 900 });
  check('TANK EMPTY puts REFILLED · START SPRAYING on the dock', /REFILLED · START SPRAYING/.test(await txt(page)) && /REFILL — NOT RECORDING/.test(await txt(page)));
  const areaA = num(await stat(page, 'AREA SPRAYED'));
  await walk(ctx, page, [40, 60], [60, 20], 3, 100);          // nowhere near the station
  const areaB = num(await stat(page, 'AREA SPRAYED'));
  check('nothing is recorded between the two taps', areaB === areaA, `${areaA} -> ${areaB} m²`);
  await tap(page, 'REFILLED · START SPRAYING', { wait: 900 });
  await walk(ctx, page, [60, 20], [60, 50], 2, 100);
  const areaC = num(await stat(page, 'AREA SPRAYED'));
  // 30 m at the default 2.5 m swath is ~75 m²
  check('REFILLED · START SPRAYING records again from wherever you are', areaC - areaB > 50, `${areaB} -> ${areaC} m²`);
  check('and TANK EMPTY is back on the dock', (await page.locator('text="TANK EMPTY"').locator('visible=true').count()) > 0);
  await browser.close();
}
async function tileRefill() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 40, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 40], [40, 60], 2, 100);
  await tap(page, 'TANK EMPTY', { wait: 2200 });
  await tap(page, 'SAVE & PAUSE', { wait: 900 });              // the tank tile is on screen while paused
  await tap(page, 'REFILLED · SPRAY', { wait: 900 });
  check('the tank tile ends the refill trip too', await sessionOpMode(page) === 'spray', `opMode ${await sessionOpMode(page)}`);
  await browser.close();
}

/* 14. Rounds. "Not done" keeps the round open with its coverage; "field done"
 *     closes it, and the next spraying of the field is round N+1 on an empty map. */
async function rounds() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  const field = async () => (await library(page))[0] || {};
  await moveTo(ctx, page, 40, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 10], [40, 40], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, false);
  let f = await field();
  check('NOT DONE keeps round 1 open with its sprayed area', (f.round || 1) === 1 && !!f.cov, `round ${f.round || 1}, coverage ${!!f.cov}`);
  await tap(page, 'START NEW', { wait: 1500 });
  check('the field card says round 1 continues', /Round 1 · \d+% sprayed — continues/.test(await txt(page)));
  await moveTo(ctx, page, 60, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [60, 10], [60, 40], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, true);
  f = await field();
  const h = await history(page);
  check('FIELD DONE closes round 1 and opens round 2 with no coverage', f.round === 2 && !f.cov && (f.rounds || []).length === 1,
    `round ${f.round}, coverage ${!!f.cov}, rounds filed ${(f.rounds || []).length}`);
  check('the history marks round 1 complete', h[0] && h[0].round === 1 && h[0].complete === true, h[0] ? `round ${h[0].round}, complete ${h[0].complete}` : 'none');
  await page.locator('[aria-label="Close"]').locator('visible=true').first().click();   // the summary's X instead of START NEW
  await page.waitForTimeout(1500);
  check('the summary X goes back to the home screen', /START SPRAYING/.test(await txt(page)) && !/MISSION SUMMARY/.test(await txt(page)));
  check('the field card says round 2 has not started', /Round 2 · not started/.test(await txt(page)));
  const areaBefore = num(await stat(page, 'AREA SPRAYED'));
  await moveTo(ctx, page, 40, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await page.waitForTimeout(800);
  const areaAtStart = num(await stat(page, 'AREA SPRAYED'));
  // standing still at START stamps one spray circle (radius = half the swath, ~5 m²); round 1 left ~150 m² here
  check('round 2 starts on an empty map', areaAtStart < 20, `AREA SPRAYED ${areaAtStart} m² at the start (card showed ${areaBefore})`);
  await page.reload();
  await page.waitForTimeout(3500);
  const f2 = (await library(page))[0] || {};
  check('round 2 is what the phone actually stored, not just what the screen showed', f2.round === 2, `stored round ${f2.round}`);
  await browser.close();
}
async function notRecordingAlert() {
  {
    const { browser, ctx, page } = await boot();
    await page.waitForTimeout(1200);
    await makeField(ctx, page);
    await moveTo(ctx, page, 40, 40, 900);
    await tap(page, 'START SPRAYING', { wait: 1200 });
    await walk(ctx, page, [40, 40], [40, 60], 2, 100);
    await tap(page, 'TANK EMPTY', { wait: 900 });
    await walk(ctx, page, [40, 60], [70, 60], 2, 100);         // spraying on, app waiting: walk the field away from the station
    await walk(ctx, page, [70, 60], [70, 20], 2, 100);
    check('walking the field while the app waits for a refill raises an alert', /not recording/.test(await appLog(page)));
    await browser.close();
  }
  {
    const { browser, ctx, page } = await boot();
    await page.waitForTimeout(1200);
    await makeField(ctx, page);
    await moveTo(ctx, page, 60, 60, 900);
    await tap(page, 'START SPRAYING', { wait: 1200 });
    await walk(ctx, page, [60, 60], [60, 70], 2, 100);
    await tap(page, 'TANK EMPTY', { wait: 900 });
    await walk(ctx, page, [60, 70], [-10, -10], 2, 100);       // straight to the station, across the field
    check('walking straight to the station raises no alert', !/not recording/.test(await appLog(page)));
    await browser.close();
  }
}

/* 15. The phone's back button closes one layer at a time and never exits. */
const back = (page) => page.evaluate(() => window.__agrasBack && window.__agrasBack());
async function backButton() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await tap(page, 'Field setup');
  check('back closes the Field setup menu', (await back(page)) === 'field-setup' && !/FIELD SETUP/.test(await txt(page)));
  await moveTo(ctx, page, 40, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  await walk(ctx, page, [40, 10], [40, 30], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await tap(page, 'FINISH', { wait: 700 });
  check('back cancels the FINISH choice, back to PAUSED', (await back(page)) === 'finish-choice' && /PAUSED/.test(await txt(page)) && !/FINISH · ROUND/.test(await txt(page)));
  await finishAs(page, false);
  check('back on the summary goes to the home screen', (await back(page)) === 'summary' && /START SPRAYING/.test(await txt(page)) && !/MISSION SUMMARY/.test(await txt(page)));
  check('back with nothing open minimizes instead of exiting', (await back(page)) === 'minimize');
  await browser.close();
}

// ONLY=manualResume,refillReach node test/run.js  — run a subset by function name
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
(async () => {
  for (const [name, fn] of Object.entries({ overlap, tidyJob, missed, tankCount, geofence, crashRecovery, windReset, complianceLog, overlapSubLine, fieldAutoSave, missionAutoSave, bigFieldResume, refillFlow, tileRefill, rounds, notRecordingAlert, backButton }).filter(([n]) => !ONLY || ONLY.includes(n))) {
    try { await fn(); } catch (e) { check(name + ' (threw)', false, e.message.split('\n')[0]); }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
