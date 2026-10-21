// What the map says over a country we have locked or written about.
//
// The database side is supabase/test/locks_test.sql, which is where the rules
// live. This is the part a traveller sees: the notices, and the line admitting
// what we have paused.
//
// That second thing is the point of the band. A map that quietly omits a
// country's disasters lets a reader conclude the country has none, which is
// the opposite of true — so "we have paused this here" has to be visible, in
// their language, without them having to notice an absence.
const { playwright, openPage, tally } = require('./harness.js');
const { chromium } = playwright();
const t = tally('notices-test');
const check = t.check;

// The map lands on one country; the band only asks once the view is a country
// rather than a continent, the same as the advisory chip.
const land = (page, { south = 48.5, west = 2.0, north = 49.0, east = 2.6 } = {}) =>
  page.evaluate(async (b) => {
    window.__ssr.map.__setBounds(b.south, b.west, b.north, b.east);
    await new Promise(r => setTimeout(r, 900));
  }, { south, west, north, east });

const band = (page) => page.evaluate(() => {
  const el = document.querySelector('#notice-band');
  return {
    there: Boolean(el),
    shown: el ? el.checkVisibility?.() ?? !el.hidden : false,
    items: [...(el?.querySelectorAll('.nb-item') ?? [])].map(i => ({
      text: i.textContent.replace(/\s+/g, ' ').trim(),
      kind: i.className,
      // The HEADLINE's own lang, not "some element in here has one". The
      // first version asked for [lang] generally, found the body's attribute
      // when the headline's was dropped, and passed.
      lang: i.querySelector('b')?.getAttribute('lang') ?? null,
      bodyLang: i.querySelector('em')?.getAttribute('lang') ?? null,
    })),
  };
});

const world = (page) => page.evaluate(async () => {
  window.__ssr.map.__setBounds(-40, -120, 60, 120);
  await new Promise(r => setTimeout(r, 900));
});

(async () => {
  const browser = await chromium.launch();

  // ---- nothing to say, nothing shown ------------------------------------
  {
    const { ctx, page } = await openPage(browser, { onError: (m) => check(false, m) });
    await land(page);
    const b = await band(page);
    check(b.there, 'the band is in the markup');
    check(!b.shown, 'and is not shown over a country we have said nothing about');
    check(b.items.length === 0, 'with nothing in it');
    await ctx.close();
  }

  // ---- a notice is shown, in the language it was written in ------------
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m),
      before: `window.__notices = [{
        id:'n1', country_code:'FR', kind:'danger',
        headline:'Ongoing protests in the centre',
        body:'Transport is disrupted all week.', lang:'en', until:null }];`,
    });
    await land(page);
    const b = await band(page);
    check(b.shown, 'a notice brings the band up');
    check(b.items.length === 1, `one item (${b.items.length})`);
    check(/Ongoing protests in the centre/.test(b.items[0].text), 'with the headline');
    check(/Transport is disrupted/.test(b.items[0].text), 'and the detail under it');
    check(/is-danger/.test(b.items[0].kind), `marked serious (${b.items[0].kind})`);
    // The words are in one language whatever the reader's is, so the element
    // says which — a browser can then offer to translate it, and a screen
    // reader pronounces it correctly instead of reading English as German.
    check(b.items[0].lang === 'en',
          `the headline is tagged with the language it is in (${b.items[0].lang})`);
    check(b.items[0].bodyLang === 'en',
          `and so is the detail under it (${b.items[0].bodyLang})`);
    await ctx.close();
  }

  // ---- loudest first ---------------------------------------------------
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m),
      before: `window.__notices = [
        { id:'a', country_code:'FR', kind:'info',    headline:'Marathon on Sunday', lang:'en', until:null },
        { id:'b', country_code:'FR', kind:'danger',  headline:'Border crossing closed', lang:'en', until:null },
        { id:'c', country_code:'FR', kind:'warning', headline:'Rail strike', lang:'en', until:null }];`,
    });
    await land(page);
    const b = await band(page);
    check(b.items.length === 3, `all three are shown (${b.items.length})`);
    check(/Border crossing closed/.test(b.items[0].text),
          `a closed border is never under a marathon ("${b.items[0].text}")`);
    check(/Marathon/.test(b.items[2].text), 'and the marathon is last');
    await ctx.close();
  }

  // ---- what we have paused is admitted ---------------------------------
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m),
      before: `window.__locks = [{ country_code:'FR',
        scopes:['disasters','weather'], until:null }];`,
    });
    await land(page);
    const b = await band(page);
    check(b.shown, 'a lock alone brings the band up, with no notice written');
    const paused = b.items.find(i => /is-paused/.test(i.kind));
    check(Boolean(paused), 'there is a paused line');
    check(/paused this here/i.test(paused?.text ?? ''),
          `which says we did it, not the country ("${paused?.text}")`);
    check(/disaster alerts/i.test(paused?.text ?? '') && /weather/i.test(paused?.text ?? ''),
          `naming both layers ("${paused?.text}")`);
    check(!/reports/i.test(paused?.text ?? ''), 'and nothing we did not pause');
    await ctx.close();
  }

  // ---- pausing NEW reports is not announced ----------------------------
  // Nothing is missing from the map for that one, so saying "paused" would
  // send a reader looking for an absence that is not there.
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m),
      before: `window.__locks = [{ country_code:'FR', scopes:['reports_new'], until:null }];`,
    });
    await land(page);
    const b = await band(page);
    check(!b.shown, 'pausing new reports alone says nothing on the map');
    await ctx.close();
  }

  // ---- an expired lock says nothing ------------------------------------
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m),
      before: `window.__locks = [{ country_code:'FR', scopes:['weather'],
        until: new Date(Date.now() - 3600000).toISOString() }];`,
    });
    await land(page);
    check(!(await band(page)).shown, 'a lock past its time is not announced either');
    await ctx.close();
  }

  // ---- another country's notice stays there ----------------------------
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m),
      before: `window.__notices = [{ id:'x', country_code:'ES', kind:'warning',
        headline:'Something in Spain', lang:'en', until:null }];`,
    });
    await land(page);   // the geocoder stub answers FR
    check(!(await band(page)).shown, "Spain's notice does not appear over France");
    await ctx.close();
  }

  // ---- another country's LOCK stays there too --------------------------
  // The notices path filters by country in the database; the paused line
  // picks the lock out of a list of every active lock, in the page, and a
  // mutation that took the first one regardless of country passed until this
  // existed.
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m),
      before: `window.__locks = [{ country_code:'ES', scopes:['weather'], until:null }];`,
    });
    await land(page);   // the geocoder stub answers FR
    check(!(await band(page)).shown,
          "a lock on Spain says nothing over France");
    await ctx.close();
  }

  // ---- zoomed out to a continent, nothing is asked ---------------------
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m),
      before: `window.__notices = [{ id:'n1', country_code:'FR', kind:'danger',
        headline:'Ongoing protests in the centre', lang:'en', until:null }];`,
    });
    await world(page);
    check(!(await band(page)).shown,
          'across a continent the band is empty — the question "which country" has no answer');
    await land(page);
    check((await band(page)).shown, 'and it appears once the view is one country');
    await ctx.close();
  }

  // ---- in the reader's language where the words are ours ---------------
  {
    const { ctx, page } = await openPage(browser, {
      onError: (m) => check(false, m),
      languages: ['de-DE', 'de'],
      before: `window.__locks = [{ country_code:'FR', scopes:['weather'], until:null }];`,
    });
    await land(page);
    const paused = (await band(page)).items.find(i => /is-paused/.test(i.kind));
    check(/pausiert/i.test(paused?.text ?? ''),
          `the paused line is in German, because those words are ours ("${paused?.text}")`);
    check(/Wetterwarnungen/.test(paused?.text ?? ''), 'including the layer name');
    await ctx.close();
  }

  await browser.close();
  process.exit(t.report() ? 0 : 1);
})();
