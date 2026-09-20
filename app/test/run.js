/* Regression run for the 2026-09-20 fixes, plus the scenarios that were already
 * passing and must not drift. Usage:
 *
 *   cd app && node build.js
 *   npx http-server www -p 8080   (or: python -m http.server 8080 --directory www)
 *   node test/run.js
 */
const { boot, moveTo, walk, tap, stat, summary, makeField } = require('./harness');

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
  await tap(page, 'FINISH', { wait: 1500 });
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
    await tap(page, 'FINISH', { wait: 1500 });
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
    await walk(ctx, page, [40, 60], [-10, -10], 4, 90);
    await page.waitForTimeout(1200);
    await walk(ctx, page, [-10, -10], [40, 58], 4, 90);
    await walk(ctx, page, [40, 58], [40, 60], 0.5, 200);
    await page.waitForTimeout(900);
    await tap(page, 'SAVE & PAUSE', { wait: 900 });
    await tap(page, 'FINISH', { wait: 1500 });
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
  await page.waitForTimeout(1200);
  await tap(page, 'REFILLED FULL TANK', { wait: 800 });
  await tap(page, 'REFILLED FULL TANK', { wait: 800 });
  await walk(ctx, page, [-10, -10], [40, 58], 4, 90);
  await walk(ctx, page, [40, 58], [40, 60], 0.5, 200);
  await page.waitForTimeout(900);
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await tap(page, 'FINISH', { wait: 1500 });
  const tanks = num((await summary(page)).match(/TANKS USED \| (\d+)/)?.[1]);
  check('one refill is one tank even when confirmed twice', tanks === 2, `TANKS USED ${tanks}`);
  const phantom = logs.filter((l) => /emptied after 0\.00 rai/.test(l)).length;
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
  await page.waitForTimeout(3000);
  const modal = (await page.locator('text="UNFINISHED MISSION DETECTED"').count()) > 0;
  check('unfinished-mission modal appears after a reload', modal);
  await tap(page, 'RESUME SPRAYING', { wait: 2500 });
  const paused = (await page.locator('text="PAUSED"').count()) > 0;
  check('resumes into PAUSED, awaiting a manual resume', paused);
  await tap(page, 'RESUME', { wait: 1200 });
  const after = num(await stat(page, 'AREA SPRAYED'));
  const bp = num(await stat(page, 'TO BREAKPOINT'));
  check('coverage survives the reload', after === before, `${before} -> ${after} m²`);
  check('breakpoint survives the reload', Math.abs(bp - 32) < 2, `TO BREAKPOINT ${bp} m (expected ~32)`);
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
  await tap(page, 'FINISH', { wait: 1500 });
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
  await tap(page, 'FINISH', { wait: 1500 });
  await tap(page, 'SAVE SESSION', { wait: 1800 });
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
  // virgin ground crossed while paused flags missed spots, which is what puts
  // the TOUCH-UP button on the summary. Finish standing back on the lane, so
  // the touch-up run can start without crossing anything new.
  await walk(ctx, page, [40, 60], [20, 60], 2, 100);
  await walk(ctx, page, [20, 60], [20, 20], 2, 100);
  await walk(ctx, page, [20, 20], [40, 20], 2, 100);
  await tap(page, 'FINISH', { wait: 1500 });
  await tap(page, 'TOUCH-UP MISSED SPOTS', { wait: 2000 });
  await walk(ctx, page, [40, 20], [40, 55], 2, 100);          // strictly over ground already sprayed
  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await tap(page, 'FINISH', { wait: 1500 });
  const s = await summary(page);
  const sub = s.match(/OVERLAPPED \| [^|]+\| ([^|]+)/)?.[1]?.trim() || '';
  const newRai = num(s.match(/AREA SPRAYED \| [^|]+\| ([\d.]+) rai/)?.[1]);
  const ovRai = num(s.match(/OVERLAPPED \| ([\d.]+) rai/)?.[1]);
  check('a touch-up over covered ground breaks no new ground', newRai === 0, `AREA SPRAYED ${newRai} rai`);
  check('it still reports the overlapped rai', ovRai > 0, `${ovRai} rai`);
  check('the overlap sub-line is not a bare 0%', !/^0% of sprayed area/.test(sub), sub);
  await browser.close();
}

(async () => {
  for (const [name, fn] of Object.entries({ overlap, tidyJob, missed, tankCount, geofence, crashRecovery, windReset, complianceLog, overlapSubLine })) {
    try { await fn(); } catch (e) { check(name + ' (threw)', false, e.message.split('\n')[0]); }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
