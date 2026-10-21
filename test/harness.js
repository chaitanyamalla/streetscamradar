// Shared machinery: find Playwright, serve the site, open a page with the
// stubs in place, count assertions.
//
// PLAYWRIGHT IS LOOKED UP, NOT HARDCODED. The old suites required an absolute
// path into a global install; the container was rebuilt, the path moved, and
// every one of them died with MODULE_NOT_FOUND before running an assertion.
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  'playwright',                                        // a local devDependency
  '/opt/node-tools/node_modules/playwright',           // this sandbox, today
  '/opt/node22/lib/node_modules/playwright',           // this sandbox, before
  '/usr/lib/node_modules/playwright',
];

function playwright() {
  for (const where of CANDIDATES) {
    try { return require(where); } catch { /* try the next one */ }
  }
  throw new Error(
    'Playwright not found. Install it with:\n'
    + '  npm i -D playwright@1.56 && npx playwright install chromium\n'
    + 'Tried: ' + CANDIDATES.join(', '));
}

const ROOT = path.resolve(__dirname, '..');
const STUBS = path.join(__dirname, 'stubs');
const ML = fs.readFileSync(path.join(STUBS, 'maplibre.mjs'), 'utf8');
const SB = fs.readFileSync(path.join(STUBS, 'supabase.mjs'), 'utf8');

/** A tally that prints one line and sets the exit code. */
function tally(name) {
  const rows = [];
  return {
    check: (ok, label) => { rows.push({ ok: Boolean(ok), label }); return Boolean(ok); },
    report() {
      const bad = rows.filter(r => !r.ok);
      for (const r of bad) console.log('  FAIL ' + r.label);
      console.log(`${name.padEnd(22)} ${rows.length - bad.length}/${rows.length} passed`);
      return bad.length === 0;
    },
    get count() { return rows.length; },
  };
}

/**
 * A page with every outside thing answered locally: no CDN, no tiles, no
 * geocoder, no Supabase. A test that reached the network would be slow, flaky
 * and dependent on somebody else's uptime to tell us whether our code works.
 */
async function openPage(browser, {
  page: which = 'index.html',
  viewport = { width: 1280, height: 900 },
  languages = ['en-GB', 'en'],
  before,                 // runs in the page before anything loads
  origin = 'http://127.0.0.1:8099',
  onError,
} = {}) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(
    `Object.defineProperty(navigator,'languages',{get:()=>${JSON.stringify(languages)}})`);
  if (before) await ctx.addInitScript(before);

  await ctx.route('**/maplibre-gl@*/+esm', r => r.fulfill({ contentType: 'application/javascript', body: ML }));
  await ctx.route('**/supabase-js@*/+esm', r => r.fulfill({ contentType: 'application/javascript', body: SB }));
  await ctx.route('**/maplibre-gl.css', r => r.fulfill({ contentType: 'text/css', body: '.maplibregl-map{position:relative}' }));
  await ctx.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await ctx.route('**/fonts.gstatic.com/**', r => r.fulfill({ status: 200, body: '' }));
  await ctx.route('**/auth/v1/settings', r => r.fulfill({ contentType: 'application/json', body: '{"external":{"email":true,"google":true}}' }));
  await ctx.route('**/nominatim.openstreetmap.org/**', r => r.fulfill({ contentType: 'application/json', body: '{"address":{"country_code":"fr"},"display_name":"Paris"}' }));
  await ctx.route('**/photon.komoot.io/**', r => r.fulfill({ contentType: 'application/json', body: '{"features":[]}' }));
  await ctx.route('**/earthquake.usgs.gov/**', r => r.fulfill({ contentType: 'application/json', body: '{"type":"FeatureCollection","features":[]}' }));
  await ctx.route('**/overpass**', r => r.fulfill({ contentType: 'application/json', body: '{"elements":[]}' }));

  const page = await ctx.newPage();
  // A thrown error or a console error is a failure, not a curiosity. Several
  // real bugs in this project first showed up as one line nobody was reading.
  if (onError) {
    page.on('pageerror', e => onError('page error: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') onError('console: ' + m.text()); });
  }
  await page.goto(`${origin}/${which}`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  return { ctx, page };
}

/** Sign somebody in and let the page settle. */
const signIn = (page, user) => page.evaluate(async (u) => {
  window.__supabaseStub.__setUser(u);
  await new Promise(r => setTimeout(r, 400));
}, user);

const toastText = (page) => page.evaluate(() =>
  (document.querySelector('#toast')?.textContent ?? '').replace(/\s+/g, ' ').trim());

module.exports = { playwright, openPage, tally, signIn, toastText, ROOT, STUBS };
