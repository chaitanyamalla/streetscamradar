// What a member is told about their daily allowance, and why a report was
// refused.
//
// The rules themselves are in the database, where they cannot be skipped —
// supabase/test/quota_test.sql. This is the half a person sees: that the five
// refusals arrive as sentences rather than as 'report_refused:quota', and that
// the number left is on the form BEFORE anybody writes three paragraphs and
// finds out afterwards.
//
// The refusal strings are matched on real text on purpose. A test that only
// checked "some message appeared" would pass while showing a Postgres
// exception to a traveller in Lisbon.
const { playwright, openPage, tally, signIn, toastText } = require('./harness.js');
const { chromium } = playwright();
const t = tally('limits-test');
const check = t.check;

const CATEGORIES = [
  { slug: 'pickpocket', label: 'Pickpocketing', glyph: '👝', blurb: 'Bags and pockets.', sort: 10 },
  { slug: 'taxi', label: 'Taxi & transport', glyph: '🚕', blurb: 'Meters and fares.', sort: 20 },
];

async function open(browser, { allowance, languages } = {}) {
  const { ctx, page } = await openPage(browser, {
    languages,
    onError: (m) => check(false, m),
    before: `window.__categories = ${JSON.stringify(CATEGORIES)};`
          + (allowance ? `window.__allowance = ${JSON.stringify(allowance)};` : ''),
  });
  await signIn(page, {
    id: 'u1', email: 'ana@example.com',
    app_metadata: { provider: 'email', providers: ['email'] },
    identities: [{ provider: 'email' }],
  });
  return { ctx, page };
}

const openForm = (page) => page.evaluate(async () => {
  document.querySelector('#open-report')?.click();
  await new Promise(r => setTimeout(r, 600));
  const line = document.querySelector('#report-allowance');
  return {
    open: document.querySelector('#report-dialog')?.open ?? false,
    shown: line ? line.checkVisibility?.() ?? !line.hidden : false,
    text: (line?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    spent: line?.classList.contains('is-spent') ?? false,
  };
});

// Fill the form and submit it, returning whatever the toast said.
const fileOne = (page) => page.evaluate(async () => {
  window.__ssr.state.pin = { lat: 48.8584, lng: 2.2945, address: 'Champ de Mars',
                             city: 'Paris', countryCode: 'FR' };
  const cat = document.querySelector('#scam-category');
  cat.value = cat.options[0]?.value ?? 'pickpocket';
  document.querySelector('#scam-headline').value = 'A thing happened here today';
  const details = document.querySelector('#scam-details');
  details.value = 'Enough words to pass whatever the minimum length happens to be, easily.';
  details.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#report-form').requestSubmit();
  await new Promise(r => setTimeout(r, 800));
  return (document.querySelector('#toast')?.textContent ?? '').replace(/\s+/g, ' ').trim();
});

(async () => {
  const browser = await chromium.launch();

  // ---- the number is on the form, before anybody types -----------------
  {
    const { ctx, page } = await open(browser, { allowance: { quota: 5, used: 2 } });
    const s = await openForm(page);
    check(s.open, 'the report form opens');
    check(s.shown, 'the allowance line is shown to a member');
    check(s.text === '3 of 5 reports left today', `and says what is left ("${s.text}")`);
    check(!s.spent, 'not marked as spent while there is some left');
    await ctx.close();
  }

  // ---- nothing left reads as a sentence, not "0 of 5" ------------------
  {
    const { ctx, page } = await open(browser, { allowance: { quota: 5, used: 5 } });
    const s = await openForm(page);
    check(/No reports left today/i.test(s.text), `none left says so ("${s.text}")`);
    check(s.spent, 'and is marked as spent');
    check(!/0 of 5/.test(s.text), 'rather than printing "0 of 5", which reads as a bug');
    await ctx.close();
  }

  // ---- a trusted contributor's higher allowance ------------------------
  {
    const { ctx, page } = await open(browser, { allowance: { quota: 50, used: 1 } });
    const s = await openForm(page);
    check(s.text === '49 of 50 reports left today', `a partner's fifty shows ("${s.text}")`);
    await ctx.close();
  }

  // ---- each refusal becomes a sentence ---------------------------------
  const expected = {
    quota:      [/everything your level allows today/i, 'the daily allowance'],
    hourly:     [/a lot of reports in one hour/i,       'the hourly cap'],
    tooFast:    [/a minute or two between reports/i,    'the minimum gap'],
    duplicate:  [/already reported something like this/i, 'the repeat check'],
    impossible: [/long way from your last report/i,     'impossible travel'],
  };
  for (const [reason, [pattern, what]] of Object.entries(expected)) {
    const { ctx, page } = await open(browser, { allowance: { quota: 5, used: 0 } });
    await page.evaluate(x => { window.__refuseReport = x; }, reason);
    await openForm(page);
    const said = await fileOne(page);
    check(pattern.test(said), `${what} is explained, not raw ("${said}")`);
    check(!/report_refused/.test(said), `and "report_refused:${reason}" never reaches the reader`);
    await ctx.close();
  }

  // ---- a reason we have never seen keeps its own words ----------------
  // One we have not seen before is exactly the one worth reading, so it must
  // not become "something went wrong".
  {
    const { ctx, page } = await open(browser, { allowance: { quota: 5, used: 0 } });
    await page.evaluate(() => { window.__refuseReport = 'somethingNew'; });
    await openForm(page);
    const said = await fileOne(page);
    check(/report_refused:somethingNew/.test(said),
          `an unmapped reason keeps its own wording ("${said}")`);
    await ctx.close();
  }

  // ---- and it is in the reader's language ------------------------------
  {
    const { ctx, page } = await open(browser, {
      allowance: { quota: 5, used: 1 }, languages: ['de-DE', 'de'] });
    const s = await openForm(page);
    check(/4 von 5/.test(s.text), `German reads naturally ("${s.text}")`);
    await page.evaluate(() => { window.__refuseReport = 'quota'; });
    const said = await fileOne(page);
    check(/dein Level erlaubt/i.test(said), `and so does the refusal ("${said}")`);
    await ctx.close();
  }

  // ---- a successful report goes in, and the number drops --------------
  {
    const { ctx, page } = await open(browser, { allowance: { quota: 5, used: 0 } });
    await openForm(page);
    const said = await fileOne(page);
    check(!/report_refused|refused/i.test(said), `an allowed report posts ("${said}")`);
    const went = await page.evaluate(() => window.__lastInsert?.country_code);
    check(went === 'FR', `and reached the database (${went})`);
    await ctx.close();
  }

  // ---- signed out: no line at all -------------------------------------
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m),
      before: `window.__categories = ${JSON.stringify(CATEGORIES)};`,
    });
    const hidden = await page.evaluate(() =>
      document.querySelector('#report-allowance')?.hidden);
    check(hidden === true, 'a signed-out visitor is shown no allowance line');
    await ctx.close();
  }

  await browser.close();
  process.exit(t.report() ? 0 : 1);
})();
