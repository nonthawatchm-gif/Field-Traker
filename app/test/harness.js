/* Agras Field Tracker — GPS test harness.
 *
 * Drives the built www/ bundle in headless Chromium through real
 * navigator.geolocation fixes, so every scenario below is reachable by an
 * operator walking a real field: no dev mode, no internal hooks, no SIM mode
 * (SIM is devMode-only on this build — srcMode is hard-defaulted to 'gps').
 *
 * Field geometry is local metres from an anchor at 14N/100E. A walk is fed as
 * small steps; anything over 30 m in one fix is treated by the app as a GPS
 * jump and deliberately paints nothing, so keep stepM well under that.
 */
const { chromium } = require('playwright');

const LAT0 = 14.0, LNG0 = 100.0;
const M_LAT = 110574, M_LNG = 111320 * Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => ({ latitude: LAT0 + y / M_LAT, longitude: LNG0 + x / M_LNG });

const PORT = process.env.PORT || 8080;
const CHROME = process.env.CHROME_PATH || undefined;   // unset = playwright's own download

async function boot(opts = {}) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    permissions: ['geolocation'],
    geolocation: { ...toLL(opts.x0 ?? 0, opts.y0 ?? 0), accuracy: opts.accuracy ?? 4 },
    locale: 'th-TH',
  });
  // Satellite basemap tiles are external and irrelevant to these checks; block
  // them so a run is fast and quiet whether or not the machine is online.
  await ctx.route('**', (route) => {
    const u = route.request().url();
    return u.startsWith(`http://localhost:${PORT}`) ? route.continue() : route.abort();
  });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.waitForTimeout(1500);
  return { browser, ctx, page, logs };
}

async function moveTo(ctx, page, x, y, settle = 600) {
  await ctx.setGeolocation({ ...toLL(x, y), accuracy: 4 });
  await page.waitForTimeout(settle);
}

/** Walk from [x,y] to [x,y] in stepM increments, one geolocation fix per step. */
async function walk(ctx, page, from, to, stepM = 2, dwell = 100) {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / stepM));
  for (let i = 1; i <= n; i++) {
    await ctx.setGeolocation({ ...toLL(from[0] + dx * i / n, from[1] + dy * i / n), accuracy: 4 });
    await page.waitForTimeout(dwell);
  }
}

/* Two TANK EMPTY buttons exist (the tank tile's and the dock's) and only one is
 * ever visible, hence the visible= filter. */
async function tap(page, label, opts = {}) {
  const el = page.locator(`text="${label}"`).locator('visible=true').first();
  await el.waitFor({ timeout: opts.timeout || 5000 });
  await el.click({ force: true });
  await page.waitForTimeout(opts.wait ?? 400);
}
async function tapRe(page, re, opts = {}) {
  const el = page.getByText(re).first();
  await el.waitFor({ timeout: opts.timeout || 5000 });
  await el.click({ force: true });
  await page.waitForTimeout(opts.wait ?? 400);
}

const lines = async (page) => (await page.evaluate(() => document.body.innerText))
  .split('\n').map((s) => s.trim()).filter(Boolean);

/** Read the value rendered directly under a stat label, e.g. stat(page,'OVERLAP'). */
async function stat(page, label) {
  const L = await lines(page);
  const i = L.indexOf(label);
  return i < 0 ? null : L[i + 1];
}
async function summary(page) {
  const L = await lines(page);
  const i = L.indexOf('MISSION SUMMARY');
  return i < 0 ? '' : L.slice(i, i + 30).join(' | ');
}

/** Plot a boundary by GPS corner-marking, then drop the refill station.
 *  Satellite is switched off first: with it on, plotting is crosshair-based
 *  (drag the map), which is not scriptable from geolocation alone. */
async function makeField(ctx, page, corners = [[0, 0], [80, 0], [80, 80], [0, 80]], station = [-10, -10]) {
  await page.locator('[aria-label="Toggle satellite imagery"]').click();
  await page.waitForTimeout(300);
  for (const [x, y] of corners) { await moveTo(ctx, page, x, y, 600); await tap(page, 'MARK CORNER'); }
  await tap(page, 'CLOSE FIELD', { wait: 900 });   // single tap closes; there is no confirm step
  await tap(page, 'Field setup');
  await tap(page, 'STATION');
  await moveTo(ctx, page, station[0], station[1], 800);
  await tap(page, 'MY LOCATION');
  await tap(page, 'CONFIRM STATION', { wait: 800 });
}

module.exports = { boot, moveTo, walk, tap, tapRe, lines, stat, summary, makeField, toLL };
