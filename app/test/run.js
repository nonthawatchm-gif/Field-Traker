/* Regression run for the 2026-09-20 fixes, plus the scenarios that were already
 * passing and must not drift. Usage:
 *
 *   cd app && node build.js
 *   npx http-server www -p 8080   (or: python -m http.server 8080 --directory www)
 *   node test/run.js
 */
const { boot, moveTo, walk, tap, tapRe, stat, summary, makeField, openSettings } = require('./harness');

/** START SPRAYING; the first start of each round asks for the chemicals — skip it. */
async function startSpray(page, wait = 1200) {
  await tap(page, 'START SPRAYING', { wait: 700 });
  const skip = page.locator('text="SKIP"').locator('visible=true');
  if (await skip.count()) { await skip.first().click({ force: true }); }
  await page.waitForTimeout(wait);
}

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
  await startSpray(page, 1200);
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
  await startSpray(page, 1200);
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
    await startSpray(page, 1200);
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
    await startSpray(page, 1200);
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
  await startSpray(page, 1200);
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
  await startSpray(page, 1200);
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
  await startSpray(page, 1200);
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
  await openSettings(page);                                     // the checklist lives in the Settings sheet
  await tap(page, 'PPE worn', { wait: 400 });
  await tap(page, 'Wind checked', { wait: 500 });
  await tap(page, 'DONE', { wait: 500 });
  const before = await checklistState(page);
  check('wind ticks on the pre-flight checklist', before.wind === true, `wind=${before.wind}`);
  await startSpray(page, 1200);
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
  await openSettings(page);                                     // the checklist lives in the Settings sheet
  await tap(page, 'PPE worn', { wait: 400 });
  await tap(page, 'Wind checked', { wait: 500 });
  await tap(page, 'DONE', { wait: 500 });
  await startSpray(page, 1200);
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
  await startSpray(page, 1200);
  await walk(ctx, page, [40, 10], [40, 60], 2, 100);          // lay a lane down at x=40
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, false);                                 // not done: the round stays open with this lane on it
  await tap(page, 'START NEW', { wait: 1500 });
  await moveTo(ctx, page, 40, 20, 900);
  await startSpray(page, 1200);
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
  check('and the station step came straight after CLOSE FIELD, landing on the home screen', /START SPRAYING/.test(await txt(page)) && !/CONFIRM STATION/.test(await txt(page)));
  // field-local y grows southward (screen-style), so harness [-10,-10] is stored as x=-10, y=+10
  check('it saves with the station set right after plotting', lib[0] && Math.round(lib[0].station.x) === -10 && Math.round(lib[0].station.y) === 10,
    lib[0] ? `station ${lib[0].station.x.toFixed(1)},${lib[0].station.y.toFixed(1)}` : 'no field');
  await openSettings(page);
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
  await startSpray(page, 1200);
  await walk(ctx, page, [40, 10], [40, 40], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, false);
  let h = await history(page);
  check('FINISH files the mission in history on its own', h.length === 1 && h[0].round === 1 && h[0].complete === false,
    `${h.length} record(s)${h[0] ? `, round ${h[0].round}, complete ${h[0].complete}` : ''}`);
  await tap(page, 'START NEW', { wait: 1200 });
  await moveTo(ctx, page, 60, 10, 900);
  await startSpray(page, 1200);
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
  await startSpray(page, 1200);
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
  await startSpray(page, 1200);
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
  await startSpray(page, 1200);
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
  await startSpray(page, 1200);
  await walk(ctx, page, [40, 10], [40, 40], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, false);
  let f = await field();
  check('NOT DONE keeps round 1 open with its sprayed area', (f.round || 1) === 1 && !!f.cov, `round ${f.round || 1}, coverage ${!!f.cov}`);
  await tap(page, 'START NEW', { wait: 1500 });
  check('the field card says round 1 continues', /Round 1 · \d+% sprayed/.test(await txt(page)));
  await moveTo(ctx, page, 60, 10, 900);
  await startSpray(page, 1200);
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
  await startSpray(page, 1200);
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
    await startSpray(page, 1200);
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
    await startSpray(page, 1200);
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
  await openSettings(page);
  check('back closes the Settings sheet', (await back(page)) === 'spray-settings' && !/RENAME FIELD/.test(await txt(page)));
  await moveTo(ctx, page, 40, 10, 900);
  await startSpray(page, 1200);
  await walk(ctx, page, [40, 10], [40, 30], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await tap(page, 'FINISH', { wait: 700 });
  check('back cancels the FINISH choice, back to PAUSED', (await back(page)) === 'finish-choice' && /PAUSED/.test(await txt(page)) && !/FINISH · ROUND/.test(await txt(page)));
  await finishAs(page, false);
  check('back on the summary goes to the home screen', (await back(page)) === 'summary' && /START SPRAYING/.test(await txt(page)) && !/MISSION SUMMARY/.test(await txt(page)));
  check('back with nothing open minimizes instead of exiting', (await back(page)) === 'minimize');
  await browser.close();
}

/* 16. The owner's home-screen design: satellite only, one Settings button with
 *     an amber dot while the checklist is incomplete, field + START on one row,
 *     and the Offline map screen closing itself when its download finishes. */
async function homeDesign() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  const t = await txt(page);
  check('no satellite on/off toggle', (await page.locator('[aria-label="Toggle satellite imagery"]').count()) === 0);
  check('START SPRAYING and the field card share one row', await page.evaluate(() => {
    const start = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'START SPRAYING');
    const card = [...document.querySelectorAll('button')].find((b) => /FIELD SELECTOR/i.test(b.innerText));
    if (!start || !card) return false;
    const a = start.getBoundingClientRect(), c = card.getBoundingClientRect();
    return Math.abs(a.top - c.top) < 4 && a.left > c.right - 2;
  }));
  const dot = () => page.evaluate(() => !!document.querySelector('[aria-label="Settings"] span span'));
  check('the Settings button shows an amber dot while the checklist is incomplete', await dot());
  await openSettings(page);
  for (const item of ['PPE worn', 'Mix rate OK', 'Nozzle checked', 'Wind checked']) await tap(page, item, { wait: 300 });
  await tap(page, 'DONE', { wait: 500 });
  check('and none once it is complete', !(await dot()));
  await browser.close();
}

/* 17. A new field goes straight to the station step; redrawing a saved field
 *     (EDIT BOUNDARY) keeps that field — name, station, rounds — and skips it. */
async function editBoundary() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);                                   // new field: CLOSE FIELD -> station -> home
  // round 1 done, so there is round history to keep; then some coverage in round 2
  await moveTo(ctx, page, 40, 10, 900);
  await startSpray(page, 1200);
  await walk(ctx, page, [40, 10], [40, 30], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, true);
  await tap(page, 'START NEW', { wait: 1500 });
  const before = (await library(page))[0];
  await openSettings(page);
  await tap(page, 'EDIT BOUNDARY', { wait: 900 });
  for (const [x, y] of [[0, 0], [60, 0], [60, 60], [0, 60]]) {
    await moveTo(ctx, page, x, y, 600);
    await page.locator('[aria-label="Center on my location"]').click({ force: true });
    await page.waitForTimeout(350);
    await tap(page, 'ADD AT CROSSHAIR');
  }
  await tap(page, 'CLOSE FIELD', { wait: 1200 });
  const t = await txt(page);
  check('redrawing a saved field skips the station step', /START SPRAYING/.test(t) && !/CONFIRM STATION/.test(t));
  const lib = await library(page);
  const after = lib[0] || {};
  check('it is still one field, same name, same station', lib.length === 1 && after.name === before.name
    && Math.round(after.station.x) === Math.round(before.station.x) && Math.round(after.station.y) === Math.round(before.station.y),
    `${lib.length} field(s), ${after.name}`);
  check('its rounds are kept and the new boundary is stored', after.round === 2 && (after.rounds || []).length === 1 && Math.abs(after.areaSqm - 3600) < 60,
    `round ${after.round}, rounds filed ${(after.rounds || []).length}, ${Math.round(after.areaSqm)} m²`);
  await browser.close();
}

/* 18. Spray report: chemicals asked once per round, carried into the round when
 *     it closes; sessions keep their start time and weather; the report and
 *     its shared text show it all. */
async function sprayReport() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 800 });
  check('the first START of a round asks for the chemicals', (await page.locator('text="SAVE & START"').locator('visible=true').count()) > 0);
  await page.locator('[aria-label="Chemical name"]').first().fill('ไกลโฟเซต');
  await page.locator('[aria-label="Rate per tank"]').first().fill('200');
  await tap(page, 'SAVE & START', { wait: 1200 });
  await walk(ctx, page, [40, 10], [40, 30], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, false);
  await tap(page, 'START NEW', { wait: 1500 });
  await moveTo(ctx, page, 50, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 1200 });
  check('continuing the same round does not ask again', (await page.locator('text="SAVE & START"').locator('visible=true').count()) === 0 && /SAVE & PAUSE/.test(await txt(page)));
  await walk(ctx, page, [50, 10], [50, 30], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, true);
  const f = (await library(page))[0] || {};
  const r1 = (f.rounds || [])[0] || {};
  check('the closed round keeps its chemicals, start and finish', r1.chemicals && r1.chemicals[0] && r1.chemicals[0].name === 'ไกลโฟเซต' && r1.chemicals[0].rate === '200' && r1.startedTs && r1.finishedTs > r1.startedTs,
    JSON.stringify({ chem: r1.chemicals, s: !!r1.startedTs, f: !!r1.finishedTs }));
  const h = await history(page);
  check('each session record has its start time, field and chemicals', h.length === 2 && h.every((m) => m.startedTs && m.fieldId === f.id && m.chemicals && m.chemicals[0].name === 'ไกลโฟเซต'), `${h.length} record(s)`);
  await tap(page, 'START NEW', { wait: 1500 });
  await tap(page, 'START SPRAYING', { wait: 800 });
  const pre = await page.locator('[aria-label="Chemical name"]').first().inputValue().catch(() => '');
  check('round 2 asks again, pre-filled with what was used last time', (await page.locator('text="SAVE & START"').locator('visible=true').count()) > 0 && pre === 'ไกลโฟเซต', `pre-filled "${pre}"`);
  await tap(page, 'SKIP', { wait: 1200 });
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, false);
  await tap(page, 'START NEW', { wait: 1500 });
  await page.locator('text="Field selector"').first().click({ force: true }); await page.waitForTimeout(800);
  await tap(page, 'REPORT', { wait: 900 });
  const rep = await txt(page);
  check('the report shows round 1 done with its chemical and times', /ครั้งที่ 1/.test(rep) && /พ่นเสร็จแล้ว/.test(rep) && /ไกลโฟเซต · 200 cc\/ถัง/.test(rep) && /เริ่มพ่น/.test(rep) && /น\./.test(rep));
  check('and round 2 still open with no chemical named', /ครั้งที่ 2/.test(rep) && /ยังไม่เสร็จ/.test(rep) && /ไม่ได้ระบุ/.test(rep));
  check('the report lists the weather line for each session', (rep.match(/ไม่มีข้อมูล|ลม \d+/g) || []).length >= 3);
  await browser.close();
}

/* 19. Fixes from the farmer walk-through: plotting opens at field scale and can
 *     frame all its corners, the hint says when to close, a new field is named
 *     right after its station, the Settings button says why it is amber, DONE
 *     is on screen without scrolling, and round 2 gets the whole chemical set. */
async function farmerFixes() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1500);
  check('no sample-field area shows before a field is plotted', !/3\.63|3-2-\d+ rai/.test(await txt(page)));
  const span = await page.evaluate(() => { const d = window.__agrasDbg, c = document.querySelector('canvas'); return d && d.pan ? c.width / d.pan.s : 0; });
  check('plotting opens at field scale (about 100 m across, not 20 m)', span >= 80, `${span.toFixed(0)} m across`);
  for (const [x, y] of [[0, 0], [80, 0], [80, 80]]) {
    await moveTo(ctx, page, x, y, 600);
    await page.locator('[aria-label="Center on my location"]').click({ force: true });
    await page.waitForTimeout(350);
    await tap(page, 'ADD AT CROSSHAIR');
  }
  check('with 3 corners the hint says to tap CLOSE FIELD', /tap CLOSE FIELD/.test(await txt(page)) && !/map a real boundary/.test(await txt(page)));
  const before = await page.evaluate(() => ({ ...window.__agrasDbg.pan }));
  await page.locator('[aria-label="Show all corners"]').click({ force: true }); await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({ ...window.__agrasDbg.pan }));
  check('Show all corners centres the view on the corners', Math.abs(after.x - 40) < 2 && Math.abs(Math.abs(after.y) - 40) < 2,
    `centre ${after.x.toFixed(0)},${after.y.toFixed(0)} (was ${before.x.toFixed(0)},${before.y.toFixed(0)})`);
  await moveTo(ctx, page, 0, 80, 600);
  await page.locator('[aria-label="Center on my location"]').click({ force: true }); await page.waitForTimeout(350);
  await tap(page, 'ADD AT CROSSHAIR');
  await tap(page, 'CLOSE FIELD', { wait: 900 });
  await moveTo(ctx, page, -10, -10, 800);
  await tap(page, 'MY LOCATION');
  await tap(page, 'CONFIRM STATION', { wait: 800 });
  check('a new field asks for its name after the station step', /NAME THIS FIELD/.test(await txt(page)));
  await page.locator('[aria-label="Field name"]').fill('นาหลังบ้าน');
  await tap(page, 'SAVE', { wait: 600 });
  const lib = await library(page);
  check('the name is saved to the field', lib[0] && lib[0].name === 'นาหลังบ้าน', lib[0] && lib[0].name);
  const home = await txt(page);
  check('the Settings button is captioned and says why it wants attention', /SETTINGS/.test(home) && /4 checks left/.test(home));
  await openSettings(page);
  const vp = page.viewportSize();
  const box = await page.locator('text="DONE"').locator('visible=true').first().boundingBox();
  check('Settings DONE is on screen without scrolling', !!box && box.y + box.height <= vp.height && box.y > 0, box ? `DONE at y=${box.y.toFixed(0)} of ${vp.height}` : 'no DONE');
  await tap(page, 'DONE', { wait: 500 });
  await moveTo(ctx, page, 40, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 800 });
  await page.locator('[aria-label="Chemical name"]').first().fill('30-20-10');
  await page.locator('[aria-label="Rate per tank"]').first().fill('100');
  await tap(page, 'ADD CHEMICAL', { wait: 300 });
  await page.locator('[aria-label="Chemical name"]').nth(1).fill('อิมา');
  await page.locator('[aria-label="Rate per tank"]').nth(1).fill('20');
  await tap(page, 'SAVE & START', { wait: 1200 });
  await walk(ctx, page, [40, 10], [40, 30], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, true);
  await tap(page, 'START NEW', { wait: 1500 });
  await tap(page, 'START SPRAYING', { wait: 800 });
  const names = await page.locator('[aria-label="Chemical name"]').evaluateAll((els) => els.map((e) => e.value));
  check('round 2 is pre-filled with the whole previous set', names.length === 2 && names[0] === '30-20-10' && names[1] === 'อิมา', JSON.stringify(names));
  await browser.close();
}

/* 20. The mission clock is spray time: it stops for the refill trip (TANK
 *     EMPTY until REFILLED) and runs again once spraying resumes. */
async function sprayTimeOnly() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 10, 900);
  await startSpray(page, 1200);
  const clock = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('agras-tracker-active-session')).elapsed; } catch (e) { return null; } });
  const snap = () => page.evaluate(() => window.__agrasSaveNow && window.__agrasSaveNow());
  await walk(ctx, page, [40, 10], [40, 40], 2, 100);
  await tap(page, 'TANK EMPTY', { wait: 600 });
  await snap(); await page.waitForTimeout(6500);
  const t0 = await clock();
  await walk(ctx, page, [40, 40], [-10, -10], 4, 90);
  await page.waitForTimeout(4000);
  await snap(); await page.waitForTimeout(6500);
  const t1 = await clock();
  check('the clock stops during the refill trip', t0 != null && t1 != null && t1 - t0 < 1.5, `${t0 && t0.toFixed(1)}s -> ${t1 && t1.toFixed(1)}s over ~25 s of refilling`);
  await tap(page, 'REFILLED · START SPRAYING', { wait: 900 });
  await walk(ctx, page, [-10, -10], [40, 45], 4, 90);
  await walk(ctx, page, [40, 45], [40, 70], 2, 100);
  await snap(); await page.waitForTimeout(6500);
  const t2 = await clock();
  check('and runs again once spraying resumes', t2 - t1 > 3, `${t1.toFixed(1)}s -> ${t2.toFixed(1)}s`);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page);
  check('the summary calls it spray time', /SPRAY TIME/.test(await txt(page)));
  await browser.close();
}

/* 21. Carrying on with a field: the home screen frames the whole field, marks
 *     where spraying stopped, and says how far away that is. */
async function continueField() {
  const { browser, ctx, page } = await boot();
  await page.waitForTimeout(1200);
  await makeField(ctx, page);
  await moveTo(ctx, page, 40, 10, 900);
  await startSpray(page, 1200);
  await walk(ctx, page, [40, 10], [40, 50], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, false);
  await tap(page, 'START NEW', { wait: 1500 });
  const lib = await library(page);
  const stop = lib[0] && lib[0].lastStop;
  check('the field remembers where spraying stopped', !!stop && Math.abs(stop.x - 40) < 3 && Math.abs(Math.abs(stop.y) - 50) < 3, stop ? `${stop.x.toFixed(0)},${stop.y.toFixed(0)}` : 'none');
  await moveTo(ctx, page, -20, -20, 1500);
  const t = await txt(page);
  const m = t.match(/Last stop · (\d+) m/);
  check('the home screen says how far the last stop is', !!m && Math.abs(+m[1] - Math.hypot(60, 70)) < 6, m ? m[0] : t.slice(0, 80));
  const framed = await page.evaluate(() => {
    const d = window.__agrasDbg, c = document.querySelector('canvas');
    return d && d.pan ? 80 * d.pan.s < c.width && 80 * d.pan.s > c.width * 0.25 : false;
  });
  check('and frames the whole field', framed);
  await startSpray(page, 900);
  await walk(ctx, page, [-20, -20], [45, 50], 4, 90);
  await walk(ctx, page, [45, 50], [45, 70], 2, 100);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await finishAs(page, true);
  await tap(page, 'START NEW', { wait: 1500 });
  const lib2 = await library(page);
  check('a closed round forgets the last stop', lib2[0] && !lib2[0].lastStop && !/Last stop/.test(await txt(page)));
  await browser.close();
}

// ONLY=manualResume,refillReach node test/run.js  — run a subset by function name
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
(async () => {
  for (const [name, fn] of Object.entries({ overlap, tidyJob, missed, tankCount, geofence, crashRecovery, windReset, complianceLog, overlapSubLine, fieldAutoSave, missionAutoSave, bigFieldResume, refillFlow, tileRefill, rounds, notRecordingAlert, backButton, homeDesign, editBoundary, sprayReport, farmerFixes, sprayTimeOnly, continueField }).filter(([n]) => !ONLY || ONLY.includes(n))) {
    try { await fn(); } catch (e) { check(name + ' (threw)', false, e.message.split('\n')[0]); }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
