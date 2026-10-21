# Tests

Two suites, in two places, for two different kinds of question.

    test/run.sh                 the page: 3 suites, needs Playwright
    supabase/test/run.sh        the database: 4 files, needs Postgres

Both print one line per file and exit non-zero if anything failed.

## Running the page tests

```sh
npm i -D playwright@1.56
npx playwright install chromium
test/run.sh                  # all of them
test/run.sh notices          # only suites whose name contains "notices"
```

`run.sh` starts a static server on port 8099 if nothing is answering there,
and stops it on the way out. The site is ES modules, so it needs a real HTTP
origin — opening `index.html` from the filesystem will not load it.

## Running the database tests

```sh
supabase/test/run.sh         # PGHOST/PGUSER are respected
```

It **drops and rebuilds the public and auth schemas**, so point it at a scratch
database and never at anything that matters. It applies `supabase/schema.sql`
from empty, which is itself a test: the file has to run top to bottom on a
fresh database, and more than once it has not.

## What the stubs are for

`test/stubs/` holds stand-ins for MapLibre and supabase-js. The harness
intercepts the CDN requests the page makes and answers with these, so no test
touches the network, needs an API key, or depends on somebody else's uptime.

They record what the app did — which layers it added, which filters it set,
what it asked the database for — and the assertions read those recordings.

**The rule they live by: where the real thing is awkward, be awkward the same
way.** A stub that is easier than reality hides exactly the bug you are looking
for. Every `modelled because` comment in those files records a bug that got
through a more convenient version:

- `on(type, layer, fn)` — the three-argument form. A two-argument-only version
  stored the layer name where the handler belonged and threw the handler away.
  Nothing fired, so nothing noticed.
- `setStyle` clears sources and layers **and then reloads the basemap's own**.
  Clearing without reloading left the stub with no basemap, which no real map
  has; not clearing hid the rebuild the app has to do.
- A `Query` is a real thenable with `.catch`. Without it, reads in `data.js`
  that end in `.catch(...)` died and took the whole refresh chain down.
- `or()` is parsed, not ignored. Both hazard feeds use it to mean "still
  running or finished recently".
- A password user carries an `email` identity and a Google user does not.
  Without them, code asking "how did this person get here?" looked right while
  testing nothing.
- `__setBounds` moves the zoom with the box. Leaving it alone meant a view on
  one city still read as the whole world, so every feature that waits for
  "the view is one country" stayed silent and looked broken.

## Writing one

```js
const { playwright, openPage, tally } = require('./harness.js');
const { chromium } = playwright();
const t = tally('my-test');
const check = t.check;

(async () => {
  const browser = await chromium.launch();
  const { ctx, page } = await openPage(browser, {
    onError: (m) => check(false, m),     // a console error IS a failure
    before: `window.__reports = [];`,    // runs before the page loads
  });
  check(await page.title() !== '', 'the page has a title');
  await ctx.close();
  await browser.close();
  process.exit(t.report() ? 0 : 1);
})();
```

Name it `*-test.js` in this directory and `run.sh` finds it.

`openPage` takes `page`, `viewport`, `languages`, `before` and `onError`. What
a test can drive on `window` is listed at the top of
`test/stubs/supabase.mjs`; the MapLibre helpers are `__setBounds`,
`__setFeatures`, `__clickFeature`, `__hoverFeature` and `__leaveFeature`.

## Two habits worth keeping

**Mutation-test anything that matters.** Break the code deliberately and watch
the assertion fail. A test that passes against a broken implementation is
worse than no test, because it is believed. Several assertions in these files
were written, passed, and were found to be vacuous only when something was
broken on purpose — the commit messages name them.

**Assert on the database, not only the screen.** A mutation that locked an
entire group the moment it was selected passed twice against the DOM, because
the table is only repainted after a save: the screen was innocent while the
write had already happened.

## Why these are in the repository

They were not, for most of this project's life — they lived in a working
directory outside it. That directory was recycled and **31 suites and both
stubs were lost at once**, while the SQL tests in `supabase/test/` survived
because they were committed. These three are the rebuild. Anything not here
yet is not covered; adding to it is the cheapest useful work there is.
