// Locking a country, and posting a notice over it, from the console.
//
// The database side is supabase/test/locks_test.sql, which is where the rules
// live and the only place they can be enforced. This is the
// other half: that the two screens drive those rules correctly, and that the
// one switch which takes information away from travellers is harder to press
// than the five that only hide a third party's feed.
const { playwright, openPage, tally, toastText } = require('./harness.js');
const { chromium } = playwright();
const t = tally('locks-admin-test');
const check = t.check;

async function open(browser, { admin = true } = {}) {
  const { ctx, page } = await openPage(browser, {
    page: 'admin.html',
    viewport: { width: 1200, height: 1100 },
    before: `window.__isAdmin = ${admin};`,
    onError: (m) => check(false, m),
  });
  await page.evaluate(() => window.__supabaseStub.__setUser({ id: 'u1', email: 'boss@example.com' }));
  await page.waitForTimeout(600);
  return { ctx, page };
}

const tab = (page, which) => page.evaluate(async (t) => {
  document.querySelector(`[data-tab="${t}"]`)?.click();
  await new Promise(res => setTimeout(res, 500));
  return !document.querySelector(`#tab-${t}`)?.hidden;
}, which);

const lockRows = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#locks-admin tbody tr')].map(tr => ({
    text: tr.textContent.replace(/\s+/g, ' ').trim(),
    country: tr.dataset.country ?? null,
    done: tr.classList.contains('is-done'),
  })));

const noticeRows = (page) => page.evaluate(() =>
  [...document.querySelectorAll('#notices-admin tbody tr')].map(tr => ({
    text: tr.textContent.replace(/\s+/g, ' ').trim(),
    lang: tr.querySelector('[lang]')?.getAttribute('lang') ?? null,
    kind: tr.querySelector('.notice-kind')?.className ?? '',
    done: tr.classList.contains('is-done'),
  })));

const applyLock = (page, { countries, scopes, note = '', confirm = true }) =>
  page.evaluate(async ([cs, sc, nt, ok]) => {
    window.confirm = () => ok;
    document.querySelector('#lock-countries').value = cs;
    document.querySelector('#lock-note').value = nt;
    for (const box of document.querySelectorAll('#lock-scopes input')) {
      box.checked = sc.includes(box.value);
    }
    document.querySelector('#lock-save').click();
    await new Promise(res => setTimeout(res, 600));
  }, [countries, scopes, note, confirm]);

(async () => {
  const browser = await chromium.launch();

  // ---- the tabs are there, and the scopes come from the database --------
  {
    const { ctx, page } = await open(browser);
    check(await tab(page, 'locks'), 'the Locks tab opens');
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll('#lock-scopes input')].map(i => i.value));
    check(boxes.length === 6, `six things can be switched off (${boxes.length})`);
    check(boxes.join(',') === 'reports_new,reports,advisories,disasters,weather,safety',
          `read from lock_scopes() rather than written twice (${boxes.join(',')})`);
    // The one that takes warnings away from travellers reads differently.
    const heavy = await page.evaluate(() =>
      [...document.querySelectorAll('#lock-scopes .scope-pick')]
        .filter(l => l.classList.contains('is-heavy'))
        .map(l => l.querySelector('input').value));
    check(heavy.join(',') === 'reports',
          `and only "hide reports already filed" is marked heavy (${heavy.join(',')})`);
    check(await tab(page, 'notices'), 'the Notices tab opens');
    await ctx.close();
  }

  // ---- locking one country ---------------------------------------------
  {
    const { ctx, page } = await open(browser);
    await tab(page, 'locks');
    check((await lockRows(page))[0]?.text.includes('Nothing is locked'),
          'with nothing locked it says so rather than showing an empty table');

    await applyLock(page, { countries: 'FR', scopes: ['advisories'], note: 'feed is wrong' });
    check(/1 country locked/.test(await toastText(page)),
          `locking one says so ("${await toastText(page)}")`);
    let rows = await lockRows(page);
    check(rows.length === 1 && rows[0].country === 'FR', `France is listed (${rows.length} row)`);
    check(/Hide the travel advisory/.test(rows[0].text),
          `named in words, not as a slug ("${rows[0].text}")`);
    check(/until lifted/.test(rows[0].text), 'and says it stays until lifted');
    check(/feed is wrong/.test(rows[0].text), 'with our note, which only we can see');
    await ctx.close();
  }

  // ---- a whole group in one go -----------------------------------------
  {
    const { ctx, page } = await open(browser);
    await tab(page, 'locks');
    const filled = await page.evaluate(async () => {
      const sel = document.querySelector('#lock-group');
      sel.value = 'western-europe';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(res => setTimeout(res, 300));
      return document.querySelector('#lock-countries').value;
    });
    check(filled === 'FR, ES, PT',
          `choosing a group fills the countries in so they can be read first ("${filled}")`);
    check(/Check the list/.test(await toastText(page)),
          'and says to check them rather than applying silently');
    // The point of filling the field instead of applying it: nothing is
    // locked until the admin has read the list and pressed the button.
    //
    // Asked of the DATABASE rather than the table. A mutation that locked the
    // group the moment it was chosen passed twice against the DOM, because the
    // table is only repainted after a save — the screen was innocent while the
    // write had already happened.
    const wroteEarly = await page.evaluate(() => (window.__locks ?? []).length);
    check(wroteEarly === 0,
          `and nothing is written yet — choosing a group only fills the field (${wroteEarly} locks)`);
    await applyLock(page, { countries: filled, scopes: ['disasters'] });
    check(/3 countries locked/.test(await toastText(page)),
          `all three go in one call ("${await toastText(page)}")`);
    check((await lockRows(page)).length === 3, 'and all three are listed');
    await ctx.close();
  }

  // ---- everything, and lifting -----------------------------------------
  {
    const { ctx, page } = await open(browser);
    await tab(page, 'locks');
    await page.evaluate(() => document.querySelector('#lock-everything').click());
    const all = await page.evaluate(() =>
      [...document.querySelectorAll('#lock-scopes input')].every(i => i.checked));
    check(all, '"tick everything" ticks everything');
    await applyLock(page, { countries: 'IT', scopes:
      ['reports_new','reports','advisories','disasters','weather','safety'] });
    let rows = await lockRows(page);
    check(/Everything/.test(rows[0]?.text ?? ''),
          `a complete lockdown says "Everything" rather than listing six things ("${rows[0]?.text}")`);

    await page.evaluate(async () => {
      document.querySelector('#locks-admin [data-act="unlock"]').click();
      await new Promise(res => setTimeout(res, 600));
    });
    check(/open again/.test(await toastText(page)), `lifting says so ("${await toastText(page)}")`);
    check((await lockRows(page))[0]?.text.includes('Nothing is locked'),
          'and the lock is gone');
    await ctx.close();
  }

  // ---- hiding existing reports is confirmed, not one click ------------
  {
    const { ctx, page } = await open(browser);
    await tab(page, 'locks');
    await applyLock(page, { countries: 'FR', scopes: ['reports'], confirm: false });
    check((await lockRows(page))[0]?.text.includes('Nothing is locked'),
          'saying no to the confirmation applies nothing');
    await applyLock(page, { countries: 'FR', scopes: ['reports'], confirm: true });
    check((await lockRows(page)).length === 1, 'and saying yes applies it');

    // The five that only hide somebody else's feed are not confirmed.
    await page.evaluate(() => { window.confirm = () => { throw new Error('should not ask'); }; });
    await page.evaluate(async () => {
      document.querySelector('#lock-countries').value = 'ES';
      for (const box of document.querySelectorAll('#lock-scopes input')) {
        box.checked = box.value === 'weather';
      }
      document.querySelector('#lock-save').click();
      await new Promise(res => setTimeout(res, 600));
    });
    check((await lockRows(page)).length === 2,
          'hiding a weather feed is not worth a confirmation box');
    await ctx.close();
  }

  // ---- unticking everything clears, rather than locking nothing -------
  {
    const { ctx, page } = await open(browser);
    await tab(page, 'locks');
    await applyLock(page, { countries: 'FR', scopes: ['weather'] });
    check((await lockRows(page)).length === 1, 'locked to begin with');
    await applyLock(page, { countries: 'FR', scopes: [] });
    check(/lifted/i.test(await toastText(page)), `unticking all says lifted ("${await toastText(page)}")`);
    check((await lockRows(page))[0]?.text.includes('Nothing is locked'),
          'and the row is gone, not left locking nothing');
    await ctx.close();
  }

  // ---- what the database refuses reaches the screen -------------------
  {
    const { ctx, page } = await open(browser);
    await tab(page, 'locks');
    await applyLock(page, { countries: 'FP', scopes: ['weather'] });
    check(/not a country code we know/.test(await toastText(page)),
          `a mistyped country is refused with a reason ("${await toastText(page)}")`);
    check((await lockRows(page))[0]?.text.includes('Nothing is locked'),
          'and nothing was applied');
    await page.evaluate(async () => {
      document.querySelector('#lock-countries').value = '';
      document.querySelector('#lock-save').click();
      await new Promise(res => setTimeout(res, 400));
    });
    check(/Which country/.test(await toastText(page)),
          'and an empty list is caught before a round trip');
    await ctx.close();
  }

  // ---- notices ---------------------------------------------------------
  {
    const { ctx, page } = await open(browser);
    await tab(page, 'notices');
    check((await noticeRows(page))[0]?.text.includes('No notices'),
          'with none posted it says so');

    const post = (page, fields) => page.evaluate(async (f) => {
      for (const [id, value] of Object.entries(f)) document.querySelector(id).value = value;
      document.querySelector('#notice-post').click();
      await new Promise(res => setTimeout(res, 600));
    }, fields);

    await post(page, { '#notice-country': 'fr', '#notice-kind': 'danger',
      '#notice-headline': 'Ongoing protests in the centre',
      '#notice-body': 'Transport is disrupted.', '#notice-lang': 'en' });
    check(/Posted over FR/.test(await toastText(page)),
          `posting says where ("${await toastText(page)}")`);
    let rows = await noticeRows(page);
    check(rows.length === 1, 'and the notice is listed');
    check(/Ongoing protests/.test(rows[0].text), 'with what it says');
    check(/is-danger/.test(rows[0].kind), `marked serious (${rows[0].kind})`);
    check(rows[0].lang === 'en',
          `and carrying the language it was written in, so a browser can offer to translate (${rows[0].lang})`);
    const cleared = await page.evaluate(() => ({
      headline: document.querySelector('#notice-headline').value,
      body: document.querySelector('#notice-body').value,
    }));
    check(cleared.headline === '' && cleared.body === '',
          'the form empties, so the next notice is not a copy of the last');

    // German, to prove lang is not hardcoded.
    await post(page, { '#notice-country': 'DE', '#notice-kind': 'warning',
      '#notice-headline': 'Bahnstreik am Montag', '#notice-body': '', '#notice-lang': 'de' });
    rows = await noticeRows(page);
    check(rows.some(n => n.lang === 'de'),
          `a German notice is marked de (${rows.map(n => n.lang).join(',')})`);

    // Taking one down.
    await page.evaluate(async () => {
      document.querySelector('#notices-admin [data-act="drop"]').click();
      await new Promise(res => setTimeout(res, 600));
    });
    check(/Taken down/.test(await toastText(page)), 'and one can be taken down');
    check((await noticeRows(page)).length === 1, 'leaving the other');

    // What it refuses.
    await post(page, { '#notice-country': 'FR', '#notice-kind': 'warning', '#notice-headline': 'Hi' });
    check(/needs more than that/i.test(await toastText(page)),
          `a headline too short to say anything is caught ("${await toastText(page)}")`);
    await post(page, { '#notice-country': 'FP', '#notice-kind': 'warning',
      '#notice-headline': 'Pinned to a typo' });
    check(/not a country code we know/.test(await toastText(page)),
          'and a country that does not exist');
    await ctx.close();
  }

  // ---- an expired lock or notice stays listed, greyed ------------------
  {
    const { ctx, page } = await open(browser);
    await page.evaluate(() => {
      window.__locks = [{ country_code: 'FR', scopes: ['weather'], note: 'last month',
                          until: new Date(Date.now() - 86400000).toISOString() }];
      window.__notices = [{ id: 'n-old', country_code: 'FR', kind: 'info',
                            headline: 'A thing that has finished', body: null, lang: 'en',
                            until: new Date(Date.now() - 86400000).toISOString() }];
    });
    await tab(page, 'locks');
    let rows = await lockRows(page);
    check(rows[0]?.done === true, 'an expired lock is still listed, greyed');
    check(/expired/.test(rows[0]?.text ?? ''), 'and labelled, so "we paused this last month" is answerable');
    check(!/Lift/.test(rows[0]?.text ?? ''), 'with nothing to lift');
    await tab(page, 'notices');
    check((await noticeRows(page))[0]?.done === true, 'and the same for a notice that has come down');
    await ctx.close();
  }

  // ---- a member who is not an admin gets none of it -------------------
  {
    const { ctx, page } = await open(browser, { admin: false });
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll('[data-tab]')].filter(b => b.offsetParent !== null).length);
    check(shown === 0, `the console is not drawn for a non-admin (${shown} tabs visible)`);
    await ctx.close();
  }

  await browser.close();
  process.exit(t.report() ? 0 : 1);
})();
