// Typing a country, instead of remembering its code.
//
// Codes had to be typed from memory, which is a poor way to ask for one of
// 250 things: nobody knows that Switzerland is CH and Sweden is SE rather
// than the other way round, and a wrong guess is a lock that looks applied
// and does nothing.
//
// Two fields use it. The lock field holds SEVERAL countries separated by
// commas, which is why this is not a <datalist>: a datalist completes the
// whole value, and would replace "FR, ES" with "PT" rather than adding to it.
const { playwright, openPage, tally } = require('./harness.js');
const { chromium } = playwright();
const t = tally('country-suggest-test');
const check = t.check;

// A realistic catalog: the country list is derived from these, because
// country_groups is revoked from the browser.
const GROUPS = [
  { group_code: 'western-europe', kind: 'zone', countries: 7,
    members: 'FR ES PT DE CH BE NL' },
  { group_code: 'northern-europe', kind: 'zone', countries: 4,
    members: 'SE NO DK FI' },
  { group_code: 'southern-asia', kind: 'zone', countries: 3, members: 'IN PK LK' },
  { group_code: 'EU', kind: 'union', countries: 4, members: 'FR DE ES PT' },
];

async function open(browser) {
  const { ctx, page } = await openPage(browser, {
    page: 'admin.html',
    viewport: { width: 1200, height: 1100 },
    before: `window.__isAdmin = true; window.__groups = ${JSON.stringify(GROUPS)};`,
    onError: (m) => check(false, m),
  });
  await page.evaluate(() => window.__supabaseStub.__setUser({ id: 'u1', email: 'boss@example.com' }));
  await page.waitForTimeout(600);
  await page.evaluate(async () => {
    document.querySelector('[data-tab="locks"]').click();
    await new Promise(r => setTimeout(r, 600));
  });
  return { ctx, page };
}

const type = (page, field, text) => page.evaluate(async ([sel, value]) => {
  const input = document.querySelector(sel);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  const list = document.querySelector(sel === '#lock-countries' ? '#lock-suggest' : '#notice-suggest');
  return {
    open: !list.hidden,
    expanded: input.getAttribute('aria-expanded'),
    hits: [...list.querySelectorAll('.search-hit')].map(h => ({
      code: h.dataset.code,
      name: h.querySelector('b')?.textContent.trim(),
      active: h.classList.contains('is-active'),
    })),
    echo: (document.querySelector(sel === '#lock-countries' ? '#lock-echo' : '#notice-echo')
      ?.textContent ?? '').trim(),
  };
}, [field, text]);

const press = (page, field, key) => page.evaluate(async ([sel, k]) => {
  document.querySelector(sel).dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 200));
  return {
    value: document.querySelector(sel).value,
    open: !document.querySelector(sel === '#lock-countries' ? '#lock-suggest' : '#notice-suggest').hidden,
  };
}, [field, key]);

(async () => {
  const browser = await chromium.launch();

  // ---- typing a name finds the country ---------------------------------
  {
    const { ctx, page } = await open(browser);
    const s = await type(page, '#lock-countries', 'fra');
    check(s.open, 'typing part of a name opens the list');
    check(s.expanded === 'true', 'and says so for a screen reader');
    check(s.hits.some(h => h.code === 'FR'), `France is offered (${s.hits.map(h => h.code).join(',')})`);
    check(s.hits[0]?.name === 'France', `by name, not by code ("${s.hits[0]?.name}")`);
    check(s.hits[0]?.active === true, 'with the first one ready for Enter');
    await ctx.close();
  }

  // ---- the names are the reader's, not a hardcoded list ---------------
  {
    const { ctx, page } = await open(browser);
    const s = await type(page, '#lock-countries', 'switz');
    check(s.hits[0]?.code === 'CH',
          `"switz" finds CH, which nobody would have guessed (${s.hits[0]?.code})`);
    const se = await type(page, '#lock-countries', 'swed');
    check(se.hits[0]?.code === 'SE', `and "swed" finds SE, not CH (${se.hits[0]?.code})`);
    await ctx.close();
  }

  // ---- a code still works, and wins ------------------------------------
  {
    const { ctx, page } = await open(browser);
    const s = await type(page, '#lock-countries', 'in');
    check(s.hits[0]?.code === 'IN',
          `"in" offers India first — a typed code is what was meant (${s.hits[0]?.code})`);
    // and the substring matches are still there underneath
    check(s.hits.length > 1, `with name matches under it (${s.hits.length} hits)`);
    await ctx.close();
  }

  // ---- choosing adds to the field rather than replacing it ------------
  {
    const { ctx, page } = await open(browser);
    await type(page, '#lock-countries', 'france');
    let r = await press(page, '#lock-countries', 'Enter');
    check(/^FR,\s*$/.test(r.value), `the first choice fills the field ("${r.value}")`);
    check(!r.open, 'and closes the list');

    // The second one must be ADDED. This is the case a <datalist> gets wrong.
    await page.evaluate(async () => {
      const i = document.querySelector('#lock-countries');
      i.value = 'FR, spa';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
    });
    r = await press(page, '#lock-countries', 'Enter');
    check(/FR/.test(r.value) && /ES/.test(r.value),
          `a second country is added, not substituted ("${r.value}")`);
    await ctx.close();
  }

  // ---- the field is read back as names --------------------------------
  {
    const { ctx, page } = await open(browser);
    const s = await type(page, '#lock-countries', 'FR, ES, PT');
    check(/France/.test(s.echo) && /Spain/.test(s.echo) && /Portugal/.test(s.echo),
          `codes are read back as names before anything is applied ("${s.echo}")`);
    const bad = await type(page, '#lock-countries', 'FR, FP');
    check(/not a country/.test(bad.echo),
          `and a code that is not a country is named as such ("${bad.echo}")`);
    const marked = await page.evaluate(() =>
      document.querySelector('#lock-echo').classList.contains('is-unknown'));
    check(marked, 'and marked, so it is noticed before the database refuses it');
    await ctx.close();
  }

  // ---- arrows and escape ----------------------------------------------
  {
    const { ctx, page } = await open(browser);
    // 'n' matches Netherlands and Norway. The first version used 'por', which
    // matches only Portugal, so ArrowDown wrapped to the same item and the
    // assertion could not fail — which it proved by not failing.
    const many = await type(page, '#lock-countries', 'n');
    check(many.hits.length >= 2,
          `a query with more than one answer, or there is nothing to move through (${many.hits.length})`);
    const first = await page.evaluate(() =>
      document.querySelector('#lock-suggest .search-hit.is-active')?.dataset.code);
    await press(page, '#lock-countries', 'ArrowDown');
    const second = await page.evaluate(() =>
      document.querySelector('#lock-suggest .search-hit.is-active')?.dataset.code);
    check(first && second && first !== second,
          `ArrowDown moves the choice (${first} -> ${second})`);
    await press(page, '#lock-countries', 'ArrowUp');
    const back = await page.evaluate(() =>
      document.querySelector('#lock-suggest .search-hit.is-active')?.dataset.code);
    check(back === first, `and ArrowUp comes back (${back})`);
    const escaped = await press(page, '#lock-countries', 'Escape');
    check(!escaped.open, 'Escape closes the list without choosing');
    await ctx.close();
  }

  // ---- clicking works too ---------------------------------------------
  {
    const { ctx, page } = await open(browser);
    await type(page, '#lock-countries', 'denm');
    const clicked = await page.evaluate(async () => {
      // Guarded: with no suggestion to click this should fail an assertion,
      // not throw and lose every result after it.
      const hit = document.querySelector('#lock-suggest .search-hit');
      if (!hit) return '(nothing to click)';
      hit.click();
      await new Promise(r => setTimeout(r, 250));
      return document.querySelector('#lock-countries').value;
    });
    check(/DK/.test(clicked), `clicking a suggestion fills it in ("${clicked}")`);
    await ctx.close();
  }

  // ---- and a chosen country actually locks ----------------------------
  // The point of all of it: the code that ends up in the field is the one the
  // database is asked about.
  {
    const { ctx, page } = await open(browser);
    await type(page, '#lock-countries', 'germ');
    await press(page, '#lock-countries', 'Enter');
    const locked = await page.evaluate(async () => {
      for (const box of document.querySelectorAll('#lock-scopes input')) {
        box.checked = box.value === 'weather';
      }
      document.querySelector('#lock-save').click();
      await new Promise(r => setTimeout(r, 700));
      return (window.__locks ?? []).map(l => l.country_code);
    });
    check(locked.join(',') === 'DE', `the chosen country is the one locked (${locked.join(',')})`);
    await ctx.close();
  }

  // ---- the notice field gets it too, as a single country --------------
  {
    const { ctx, page } = await open(browser);
    await page.evaluate(async () => {
      document.querySelector('[data-tab="notices"]').click();
      await new Promise(r => setTimeout(r, 600));
    });
    const s = await type(page, '#notice-country', 'neth');
    check(s.open && s.hits[0]?.code === 'NL',
          `the notice field suggests too (${s.hits[0]?.code})`);
    const r = await press(page, '#notice-country', 'Enter');
    check(r.value === 'NL', `and holds one country, with no comma ("${r.value}")`);
    await ctx.close();
  }

  // ---- nothing typed, nothing shown -----------------------------------
  {
    const { ctx, page } = await open(browser);
    const s = await type(page, '#lock-countries', '');
    check(!s.open, 'an empty field offers nothing');
    check(s.echo === '', 'and reads back as nothing');
    const none = await type(page, '#lock-countries', 'zzzz');
    check(!none.open, 'and neither does something no country matches');
    await ctx.close();
  }

  await browser.close();
  process.exit(t.report() ? 0 : 1);
})();
