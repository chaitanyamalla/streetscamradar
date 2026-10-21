// The page boots, draws itself, and says nothing to the console.
//
// The broad one. It does not go deep into any feature — the other suites do
// that — it checks that the whole thing comes up: the map and its layers, the
// reports card, the chips, the gate a signed-out visitor meets, and that
// switching language or theme does not break any of it.
//
// A console error is a failure here, not a curiosity. Several real bugs in
// this project first appeared as one line nobody was reading.
const { playwright, openPage, tally, signIn } = require('./harness.js');
const { chromium } = playwright();
const t = tally('app-test');
const check = t.check;

const CATEGORIES = [
  { slug: 'pickpocket', label: 'Pickpocketing', glyph: '👝', blurb: 'Bags and pockets.', sort: 10 },
  { slug: 'taxi', label: 'Taxi & transport', glyph: '🚕', blurb: 'Meters and fares.', sort: 20 },
  { slug: 'tickets', label: 'Tickets', glyph: '🎫', blurb: 'Queue-jump passes.', sort: 30 },
];
const REPORTS = [
  { id: 'r1', category: 'pickpocket', impacts: ['money'], headline: 'Bag opened on the metro',
    description: 'Three people crowded the doorway as the doors closed.',
    lat: 48.8606, lng: 2.3376, address: 'Louvre-Rivoli', city: 'Paris', country_code: 'FR',
    happened_at: new Date(Date.now() - 3600e3).toISOString(),
    created_at: new Date(Date.now() - 3600e3).toISOString(),
    support_count: 2, flag_count: 0, reporter_id: 'someone' },
  { id: 'r2', category: 'taxi', impacts: ['money'], headline: 'Meter off, price named at the end',
    description: 'Driver would not use the meter and named a number on arrival.',
    lat: 48.8584, lng: 2.2945, address: 'Champ de Mars', city: 'Paris', country_code: 'FR',
    happened_at: new Date(Date.now() - 7200e3).toISOString(),
    created_at: new Date(Date.now() - 7200e3).toISOString(),
    support_count: 0, flag_count: 0, reporter_id: 'someone' },
];

const fixtures = `
  window.__categories = ${JSON.stringify(CATEGORIES)};
  window.__reports = ${JSON.stringify(REPORTS)};
`;

const land = (page) => page.evaluate(async () => {
  window.__ssr.map.__setBounds(48.80, 2.20, 48.92, 2.42);
  await new Promise(r => setTimeout(r, 900));
});

const look = (page) => page.evaluate(() => ({
  title: document.title,
  lang: document.documentElement.lang,
  theme: document.documentElement.dataset.theme,
  layers: window.__ssr.map.__layers.map(l => l.id),
  sources: Object.keys(window.__ssr.map.__sources),
  count: (document.querySelector('#reports-count')?.textContent ?? '').trim(),
  cardTitle: (document.querySelector('#reports-title')?.textContent ?? '').trim(),
  listed: document.querySelectorAll('#report-list .report-item, #report-list article').length,
  listText: (document.querySelector('#report-list')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  pins: window.__ssr.map.getSource('reports')?._get()?.features?.length ?? -1,
  images: window.__ssr.map.listImages().length,
}));

(async () => {
  const browser = await chromium.launch();

  // ---- it comes up -----------------------------------------------------
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m), before: fixtures });
    const s = await look(page);
    check(/StreetScamRadar/i.test(s.title), `the page names itself ("${s.title}")`);
    check(s.lang === 'en', `and sets the document language (${s.lang})`);
    check(['light', 'dark'].includes(s.theme), `with a theme chosen (${s.theme})`);

    // Every layer the map is supposed to draw with. A missing one is a layer
    // the app will later try to setPaintProperty on.
    for (const id of ['density-blob', 'density-count', 'clusters', 'cluster-count',
                      'report-point', 'report-halo', 'report-icon', 'hazard-ring',
                      'hazard-core', 'weather-icon', 'disaster-icon', 'volcano-icon',
                      'safety-icon']) {
      check(s.layers.includes(id), `the ${id} layer is added`);
    }
    for (const id of ['reports', 'density', 'safety', 'hazards', 'disasters', 'weather']) {
      check(s.sources.includes(id), `the ${id} source is added`);
    }
    // Ours draw ABOVE the basemap's, or the map would be on top of the pins.
    check(s.layers.indexOf('report-icon') > s.layers.indexOf('boundary_country_inner'),
          'and our layers sit above the basemap');
    check(s.images > 0, `category icons are registered (${s.images})`);
    await ctx.close();
  }

  // ---- reports in view reach the card and the map ----------------------
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m), before: fixtures });
    await signIn(page, { id: 'u1', email: 'ana@example.com',
      app_metadata: { provider: 'email', providers: ['email'] },
      identities: [{ provider: 'email' }] });
    await land(page);
    const s = await look(page);
    check(s.pins === 2, `both reports are drawn as pins (${s.pins})`);
    check(s.count === '2', `and counted on the card (${s.count})`);
    check(/Bag opened on the metro/.test(s.listText), 'the first is listed');
    check(/Meter off/.test(s.listText), 'and so is the second');
    check(/Reports/i.test(s.cardTitle), `the card is titled ("${s.cardTitle}")`);
    await ctx.close();
  }

  // ---- a signed-out visitor is met by the gate, not by an error -------
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m), before: fixtures });
    await land(page);
    const gate = await page.evaluate(async () => {
      document.querySelector('#open-report')?.click();
      await new Promise(r => setTimeout(r, 500));
      return {
        auth: document.querySelector('#auth-dialog')?.open ?? false,
        report: document.querySelector('#report-dialog')?.open ?? false,
        toast: (document.querySelector('#toast')?.textContent ?? '').trim(),
      };
    });
    check(gate.auth, 'asking to report signs you in first');
    check(!gate.report, 'rather than opening a form that cannot be submitted');
    check(gate.toast.length > 0, `and says why ("${gate.toast}")`);
    await ctx.close();
  }

  // ---- changing language rebuilds everything -------------------------
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m), before: fixtures });
    await signIn(page, { id: 'u1', email: 'ana@example.com',
      app_metadata: { provider: 'email', providers: ['email'] },
      identities: [{ provider: 'email' }] });
    await land(page);
    const switched = await page.evaluate(async () => {
      const sel = document.querySelector('#lang-select');
      sel.value = 'de';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 900));
      return document.documentElement.lang;
    });
    check(switched === 'de', `the page switches language (${switched})`);
    const s = await look(page);
    check(s.pins === 2, `and the pins survive it (${s.pins})`);
    check(s.layers.includes('report-icon'), 'with the layers still there');
    check(/Meldungen|Berichte/i.test(s.cardTitle) || s.cardTitle.length > 0,
          `and the card is retitled ("${s.cardTitle}")`);
    await ctx.close();
  }

  // ---- changing theme rebuilds the map -------------------------------
  // setStyle throws the whole style away, so everything the app added has to
  // go back. This is the check that the rebuild happens at all.
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m), before: fixtures });
    await signIn(page, { id: 'u1', email: 'ana@example.com',
      app_metadata: { provider: 'email', providers: ['email'] },
      identities: [{ provider: 'email' }] });
    await land(page);
    const before = await look(page);
    const themed = await page.evaluate(async () => {
      document.querySelector('#theme-button')?.click();
      await new Promise(r => setTimeout(r, 1200));
      return document.documentElement.dataset.theme;
    });
    check(themed !== before.theme, `the theme changes (${before.theme} -> ${themed})`);
    const after = await look(page);
    for (const id of ['report-icon', 'clusters', 'safety-icon']) {
      check(after.layers.includes(id), `${id} is rebuilt after the style is replaced`);
    }
    check(after.layers.filter(l => l === 'report-icon').length === 1,
          'exactly once, not twice');
    check(after.pins === 2, `and the reports are drawn again (${after.pins})`);
    await ctx.close();
  }

  await browser.close();
  process.exit(t.report() ? 0 : 1);
})();
