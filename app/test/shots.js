/* Screenshots of the themed UI, driven the same way the checks drive it:
 * real geolocation fixes, no dev mode. Writes into shots/ next to this file.
 *   PORT=8081 CHROME_PATH=/opt/pw-browsers/chromium node test/shots.js
 */
const fs = require('fs'), path = require('path');
const { boot, moveTo, walk, tap, makeField, openSettings } = require('./harness');

const OUT = process.env.SHOTS_DIR || path.join(__dirname, 'shots');
let n = 0;
const shot = async (page, name) => {
  await page.waitForTimeout(400);
  const f = path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f });
  console.log('  ', path.basename(f));
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { browser, ctx, page, logs } = await boot();
  await page.waitForTimeout(1800);

  await shot(page, 'first-run');
  await makeField(ctx, page);
  await shot(page, 'home-field-ready');

  await openSettings(page);
  await shot(page, 'settings-sheet');
  await tap(page, 'DONE', { wait: 500 });

  await moveTo(ctx, page, 40, 10, 900);
  await tap(page, 'START SPRAYING', { wait: 900 });
  await shot(page, 'chemicals');
  await tap(page, 'SKIP', { wait: 900 });

  await walk(ctx, page, [40, 10], [40, 60], 3, 90);
  await walk(ctx, page, [40, 60], [43, 60], 1.5, 90);
  await walk(ctx, page, [43, 60], [43, 15], 3, 90);
  await shot(page, 'spraying');

  await tap(page, 'TANK EMPTY', { wait: 900 });
  await shot(page, 'refill-walk');
  await walk(ctx, page, [43, 15], [-10, -10], 4, 60);
  await shot(page, 'refill-at-station');
  await tap(page, 'REFILLED \u00b7 START SPRAYING', { wait: 900 });

  // Step outside the boundary: spraying cuts off and the alert takes over.
  await moveTo(ctx, page, 20, 40, 900);
  await walk(ctx, page, [20, 40], [-18, 40], 4, 140);
  await shot(page, 'out-of-bounds');
  await walk(ctx, page, [-18, 40], [20, 40], 4, 90);

  await tap(page, 'SAVE & PAUSE', { wait: 900 });
  await shot(page, 'paused');
  await tap(page, 'FINISH', { wait: 900 });
  await shot(page, 'finish-choice');
  await tap(page, 'FIELD DONE \u00b7 CLOSE ROUND 1', { wait: 1400 });
  await shot(page, 'summary');

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  console.log('page errors:', errs.length ? errs : 'none');
  await browser.close();
})().catch((e) => { console.error('shots failed:', e.message); process.exit(1); });
