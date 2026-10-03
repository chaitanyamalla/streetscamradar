# StreetScamRadar

A worldwide community map of street scams. Search any city, town or postcode
and see what has been reported there **in the last 7 days**.

- **Anyone** can see how many scams were reported in an area, and — once zoomed
  into a neighbourhood — a small sample of them.
- **Members** (free, one email) see every report in view, can add their own by
  dropping a pin or typing an address, and can confirm or flag what others post.

Live site: https://streetscamradar.vercel.app

---

## How it is put together

A static site. No build step, no server to run — the browser talks straight to
Supabase (Postgres) over HTTPS.

```
index.html      markup: map, panels, sign-in and report dialogs
styles.css      the whole design system (tokens -> desktop -> responsive)
app.js          wiring: what happens when you pan, search, filter or post
js/config.js    YOUR Supabase keys and the tunables         <- edit this
js/data.js      every database call lives here
js/auth.js      magic-link and Google sign-in
js/geo.js       search (Nominatim), suggestions (Photon), "where am I"
js/map.js       MapLibre setup, clustering, density layer
js/ui.js        rendering helpers (and HTML escaping)
js/emergency.js emergency numbers, by country
js/advisory.js  German Federal Foreign Office travel advisories (German only)
js/hazards.js   earthquakes from USGS, fetched in the browser
js/i18n.js      language: detection, switching, t()
js/locales/     one file per language; en.js is the source of truth
supabase/schema.sql   tables, security rules, functions     <- run this once
supabase/tests.sql    proves the security rules actually hold
```

### Natural hazards

Three layers, behind a button on the map rather than in the filter panel: they
are not a filter on our reports, they are other people's official data laid
over them. Each row in that panel carries its own mark — so it doubles as the
map's key — and names the agency that publishes it. **Everything there was
issued by a national agency; none of it is ours, and we add no judgement of
our own to any of it.**

| Layer | Source | Shape | Default |
|---|---|---|---|
| Earthquakes | USGS | rings at the epicentre | **off** |
| Floods, storms, fires | GDACS | markers, counted for the view | on |
| Volcanoes | GDACS | markers, counted for the view | on |
| Weather warnings | national met services, via MeteoAlarm | a chip for the country, plus markers for the areas warned | on |

The panel splits what is drawn from what is reported for the country, and the
split is about whether the thing has a place at all.

Everything GDACS publishes carries a position, so it is drawn — but **what that
position means differs by kind, and the popup says which**. A volcano and a
wildfire are where they are. A cyclone is where the storm was last placed, and
has moved since. A flood or a drought is the centre of the area affected, which
can sit well away from the water and is a region rather than a street. Saying
so costs one line and is the difference between a marker that informs and one
that misleads. GDACS earthquakes are left out entirely: USGS covers those
better, and drawing both would put two marks on one event.

A **weather warning is about a region, not a point** — it covers counties at a
time — so the chip for the country in view is the main answer, the same shape as
the travel advisory above it, and the dialog folds forty provincial warnings
into one row per kind.

It is drawn as well. Eight of the thirty-eight services send a CAP polygon and
its centre is the marker; the other thirty are drawn on the middle of their
country, and the popup says which of the two it is.

**The country, and not the area, on purpose.** The obvious thing is to place each
warning on the region it names, and it was built that way first: each area name
looked up once and remembered, under three rules needed to stop a geocoder
answering with Brazil. It worked and it was not worth it. Met services name
weather *zones* rather than places — "Litoral de Barcelona", "East Sterea &
Evvoia", "Ibérica aragonesa" — so 28 of 30 names could not be matched to anywhere
at all and fell back to the country regardless. We are not a met service. A
traveller wants to know Spain has a red wind warning out and where to go and read
it; the marker is a pointer to the chip, not a survey mark.

What survives of those rules is the one that still earns its keep: MeteoAlarm is
a European system, so a point outside Europe is wrong whatever the geocoder says.
That is what stopped Portugal being placed in Brazil, and a country lookup can go
wrong the same way a zone lookup could.

Warnings that share a point — every country-level marker in one country does —
are fanned into a ring around it, spaced in screen pixels so it looks the same at
any zoom, with the worst at the top. The popup says a marker was nudged, and how
many more sit underneath it.

**Warnings reach about two days ahead, and no further.** A met service issues
before the weather arrives, and that lead time is the useful part, so a warning
that has not started yet is kept and labelled "From Fri 06:00" rather than shown
as something happening now. What is *not* on offer is a week: nobody issues a
formal weather warning that far out, and nothing forecasts an earthquake, a
volcano or a flood ahead at all — GDACS carries no forecast whatsoever, which we
checked rather than assumed. The panel says so, because a traveller planning a
trip will otherwise reasonably assume the silence means "nothing coming".

**Weather is not kept for a week** the way reports and disasters are. Each
generator deletes the rows it did not just refresh for the countries it owns,
and the page separately drops anything whose own end time has passed. Last
Tuesday's wind warning is not history, it is noise.

**Only earthquakes that matter.** Two feeds: `significant_month`, which is
USGS's own judgement of what mattered — magnitude weighted by how many people
felt it and what it did — kept for a month, because the damage outlasts the
shaking; and `4.5_week`, the ordinary threshold for "felt widely". The M2.5
daily feed was dropped: hundreds a day, none of them trip-planning
information. The mark is a hollow violet ring with a dot at the epicentre, and
the colour is the point — a filled orange circle is what a scam report is, so
the two used to read as the same thing. Earthquakes start **off**: this is a
street scam map first.

**Only orange and red weather.** MeteoAlarm grades green, yellow, orange and
red; the first two are about 5,000 of the 5,600 warnings live across Europe on
an ordinary afternoon, and describe weather that is unpleasant rather than
dangerous.

Europe, and nowhere else yet. The panel says "Europe only" rather than letting a
traveller to Peru read silence as "no warnings".

**NOAA's National Weather Service was added for the United States and removed
again**, which is worth writing down so nobody adds it back for the same
reasons. Its national feed is real and good, but 192 of 361 live alerts were
small craft advisories and gale warnings — offshore, useless to somebody walking
to a station — and most of what was left were county-by-county flood warnings.
On a world map that came out as a United States buried under a hundred flood
signs that happened to be drawn with the same image as a GDACS flood disaster,
each one linking to a weather.gov home page rather than the alert. More noise
than information. MeteoAlarm earns its place because its orange-and-red grading
is already the filter a traveller needs; NOAA would need that filter built, and
a reason better than "the feed exists".

USGS is fetched in the browser: permissive CORS, a 60-second cache, built to
be read from a page, so nothing of ours can go stale. GDACS and MeteoAlarm send
no cache headers and MeteoAlarm has no worldwide feed at all, so both are
mirrored into `public.disaster_alerts` and `public.weather_warnings` — separate
tables, because GDACS is a disaster service and not a weather service — by the
`Refresh hazards` workflow every three hours. An event leaves when its source
stops publishing it — the refresh deletes whatever it did not see — and the
page separately ignores anything whose own end date has passed.

We store no warning text from anybody. The type, the level, the area, the
times, who issued it and where to read it are facts about a warning; the
warning itself stays with the service that wrote it, in their words and
current.

Mind the units: USGS `time` is epoch **milliseconds**, GDACS dates are ISO
strings, MeteoAlarm's carry an offset (`2026-09-27T07:00:00+02:00`). All three
are pinned by tests, for the reason the travel advisories are.

`supabase/ops/probe_hazards.py` reports what the sources currently send, and
runs from the `Refresh hazards` workflow with `probe`. Run it before changing
a parser — it is what these were written from.

### Closing a region to reporting

An administrator can close somewhere to **new reports** with no deploy. You
should almost never name countries one at a time — close a group:

| Kind | Handles |
|---|---|
| continent | `AF` `AN` `AS` `EU` `NA` `OC` `SA` |
| zone | `western-europe`, `south-eastern-asia`, `caribbean`, `western-asia`, `northern-africa` … the 23 UN M49 sub-regions |
| union | `eu`, `schengen` |

```sql
update public.app_settings
   set value = '{"countries": [], "groups": ["south-eastern-asia"]}'
 where key = 'blocked_regions';
```

`select * from public.region_catalog` lists every handle with its members, and
`supabase/ops/set_blocked_regions.sql` has the whole thing with checks either
side. The `countries` list is for the odd exception, not the usual case.

All 250 countries sit on exactly one continent and in exactly one zone; the
lists were checked against the region codes the browser itself knows, so a
typo would have shown up rather than leaving a country quietly unblockable.
Two zones cross a continent because the standard does — Cyprus is in
`western-asia` while sitting on the `EU` continent — and a country in both is
closed by either.

**Reading is never affected.** Everything already on the map stays visible to
everyone, everywhere. What changes is that the report button says the region is
closed — before the sign-in gate, so nobody is asked to make an account for a
report that would be refused — and a pin dropped there is refused with the same
line.

The rule that actually holds is the insert policy on `reports`, which calls
`public.reporting_allowed()`. The page can be bypassed; the table cannot.

The honest limit: a report carries the country the reporter's browser was told
it was in, so the check is only as good as that. While any block is in force, a
report carrying no country at all is refused too — "I cannot tell you where
this is" is exactly what a bypass would say.

### Travel advisories

The map shows the German Federal Foreign Office's advisory status for the
country in view: a chip naming the country and the level, and a dialog with
the level, the country's emergency numbers, the ministry's own "Stand" date,
how many countries carry a warning right now, and a link to the official page.

That last line promises a daily refresh. It is withdrawn automatically once the
newest row is more than three days old — a stale page claiming to be fresh is
worse than one that says how old it is.

Note their `lastModified` and `effective` are epoch **seconds**, not
milliseconds — read the wrong way they put every advisory in January 1970,
which looks like a neglected site rather than a unit mix-up. The loader detects
the unit rather than trusting either.

It stores the **status, never the text**. Their terms require the information
to be taken complete, kept current and not shown in a distorting context, and
ask that country text be linked rather than copied; an excerpt of a multi-page
advisory satisfies none of that. A level is a fact about the advisory rather
than a piece of it, and the link means the words a reader acts on are always
the ministry's own.

The panel is in German only, deliberately: these are advisories written in
Berlin, in German, for German citizens travelling abroad, and translating them
is exactly what the terms forbid. Everyone sees it for now; the intended shape
is to show it to the readers it is for and add other countries' sources
alongside. The seam for that is `STRINGS` and `SOURCE` in `js/advisory.js`.

`.github/workflows/advisories.yml` refreshes `public.travel_advisories` daily.
The generator refuses to write a short or empty response — their interface
answers `{}` when it is down, and a credulous loader would read that as "no
country has an advisory" and clear every warning on the site.

Before using this in your own deployment, accept their terms and tell them how
you present the data: https://www.auswaertiges-amt.de/de/service/opendata

### Languages

The site speaks English, German, Spanish, French, Italian, Portuguese, Dutch,
Czech and Polish.
Which one a visitor gets is decided in this order:

1. what they last chose here, kept in this browser
2. what their account says, if they are signed in
3. what their browser asks for (`navigator.languages`)
4. English

Deliberately not their IP address: an Italian standing in Prague wants
Italian, and geolocating them would hand them Czech, confidently and wrongly.

To add a language: copy `js/locales/en.js`, translate the values, add the code
and its own name to `LANGUAGES` in `js/i18n.js`, and add it to the `locale`
check constraint in `supabase/schema.sql` — miss the last one and the picker
offers a language the database then refuses to store. `en.js` is the fallback,
so a key you have not got to yet shows English rather than a blank or a key
name. Country names and dates come from the browser's own `Intl` data, not
from these files.

Scam categories live in the database, so they carry their own labels; the
`category.<slug>` strings translate the ones we ship, and any slug added later
falls back to whatever label its row carries.

### The security model, in short

The browser holds the Supabase **anon key**, which is public by design and
visible in the page source. Nothing is protected by hiding it. Every rule lives
in `supabase/schema.sql` as Row Level Security, so editing JavaScript in a
browser console gets you nothing extra. Three doors:

| Who | Can reach | Sees |
|---|---|---|
| Signed out | two capped SQL functions only | counts per area; at most **5** reports, and only when zoomed in past ~0.35° |
| Member | the `reports_feed` view | every published report from the last 7 days |
| Author | `delete_my_report()` | can withdraw their own report |

Direct read, update and delete on the `reports` table are **revoked** from both
roles. `reporter_id` is not in the members' view, so nobody can work out who
filed a report.

---

## Setup

### 1. Create the database

In your Supabase project: **SQL Editor → New query**, paste the whole of
`supabase/schema.sql`, and run it. It is safe to run more than once.
"Success. No rows returned" is what a good run looks like — the file ends in
`GRANT` statements, which return nothing.

Then paste `supabase/verify.sql` into the same editor. It reads only, and every
row should say PASS. It checks the things that matter: that the tables and
policies exist, and that a signed-out visitor genuinely cannot read the reports
table or the member feed.

To check it worked: **Table Editor** should now list `reports`,
`scam_categories`, `profiles`, `report_supports`, `report_flags` and
`app_settings`.

### 2. Point the site at your project

Done — `js/config.js` already holds the project URL and the publishable key
for project `navjxkozsikggyxlebrd`:

```js
export const SUPABASE_URL = 'https://navjxkozsikggyxlebrd.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_...';
```

This project uses Supabase's newer key system, so it is a *publishable* key
rather than the older anon JWT. Both sit in the same dashboard page and both map
to the `anon` Postgres role, which is what every rule in `schema.sql` is written
against.

Both are safe to commit. **Never put the `service_role` key in this repo** — it
bypasses every rule above, and this repository is public.

Until you do this the site still loads, shows a banner at the top, and skips
every database call.

### 3. Turn on sign-in

**Authentication → Providers**

- **Email** — on by default. That is the magic link; nothing else to do.
- **Google** — toggle on, then paste a Client ID and Secret from
  [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
  (Create credentials → OAuth client ID → Web application). Into
  *Authorised redirect URIs* put the callback URL Supabase shows you on that
  same page — it looks like
  `https://YOUR-PROJECT.supabase.co/auth/v1/callback`.

**Authentication → URL Configuration** — do this or sign-in links are dead.

- *Site URL*: `https://streetscamradar.vercel.app`
- *Redirect URLs*: add `https://streetscamradar.vercel.app/**` and, for local
  work, `http://localhost:8080/**`

Supabase defaults Site URL to `http://localhost:3000`. If you leave it, the
magic-link email arrives and the link lands on `localhost refused to connect`.
The page always asks to come back to its own origin, but Supabase ignores that
unless the origin is in the Redirect URLs list, and falls back to Site URL.

The Google button only appears when the Google provider is actually enabled —
the page asks `/auth/v1/settings` on load. Nothing to configure; enable Google
in the dashboard and the button shows up by itself.

### 4. Sign-in, and the email rate limit

Three ways in, in order of how much they depend on email:

| Method | Sends an email? | Works while rate-limited? |
|---|---|---|
| Password | no | **yes** |
| Magic link | yes | no |
| Google | no | yes, once configured |

**Password sign-in needs no email at all**, which is why it exists — a free
Supabase project allows only about 2 emails an hour, and that is the first thing
that blocks testing.

For sign-up to be instant, turn off **Authentication → Providers → Email →
Confirm email**. Otherwise creating an account still sends a confirmation
message and the rate limit applies again. The trade is real: with confirmation
off, nobody proves they own the address they signed up with. For a community
map that is an acceptable start, and the flag/auto-hide path in `app_settings`
is the answer if abuse follows — but revisit it before the site gets popular.

#### Custom SMTP — needed before real users arrive

Supabase's built-in email sender is capped at roughly **2 emails per hour** and
is meant for testing only. Hit it and sign-in fails with *"email rate limit
exceeded"*. The exact cap is under **Authentication → Rate Limits**.

A community site cannot run on that, so set up your own sender before inviting
anyone: **Project Settings → Authentication → SMTP Settings**. Resend, Brevo,
Postmark and SendGrid all have free tiers well above this; Resend's is ~3,000
emails a month and takes about ten minutes including domain verification.

Once custom SMTP is on, raise the limit under Authentication → Rate Limits —
the low default exists only because the shared sender is shared.

While rate-limited, you cannot test sign-in at all. Either wait an hour, or
configure SMTP and the limit lifts immediately.

### 5. Deploy

Vercel already builds this repo on push. There is no build command and no
environment variable to set — it is static files.

Run it locally with any static server:

```bash
npx http-server -p 8080 .
# then open http://localhost:8080
```

### 6. Supabase MCP (optional)

`.mcp.json` registers Supabase's MCP server, so Claude Code can run migrations
and inspect the database directly instead of you copying SQL by hand. It is
scoped to this project and holds no secret — just the project ref. On first use
Claude Code will ask you to approve the server and sign in to Supabase.

It only works where the network allows `mcp.supabase.com`; some managed
environments block it, in which case use the SQL editor as above.

---

## Police stations and hospitals

They live in `public.safety_places` and are refreshed from OpenStreetMap by
`.github/workflows/safety-data.yml` — **Actions → Refresh safety places → Run
workflow**, and weekly on a schedule.

They were originally read live from OpenStreetMap's Overpass API on every pan.
That tied a feature of the site to a free, shared, frequently congested
service: it queued requests rather than refusing them, so the layer hung rather
than failing, and often showed nothing at all. Reading from our own table is one
indexed query, and police stations and hospitals barely move.

The refresh job derives its areas from where reports actually are — one centre
per ~11km cell with a published report — so coverage follows the map instead of
a hardcoded city list. Add somewhere extra with the `extra_areas` input
(`lat,lng` pairs separated by semicolons).

Overpass 504s are routine. A failed area is skipped and logged, the rest still
load, and the next run picks it up; the job only fails if nothing at all came
back.

## Running SQL from GitHub Actions

`.github/workflows/database.yml` runs any `.sql` file under `supabase/` against
the database on a GitHub runner, and prints the output in the job log. It exists
because some environments (Claude Code's web sandbox among them) have no network
route to Supabase at all, while a GitHub runner does.

One-time setup — add a repository secret:

1. **Settings → Secrets and variables → Actions → New repository secret**
2. Name: `SUPABASE_DB_URL`
3. Value: the **Session pooler** string from Supabase (the *Connect* button):
   `postgresql://postgres.navjxkozsikggyxlebrd:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`

Use the pooler, not `db.<ref>.supabase.co` — that host is IPv6-only and GitHub
runners are IPv4-only, so the direct string fails with *Network is unreachable*.

Then **Actions → Database → Run workflow**, and give it a file, e.g.
`supabase/verify.sql`. Only paths under `supabase/` are accepted, so the SQL
being run is always something committed and reviewable in this repo.

## Checking the security rules yourself

`supabase/tests.sql` asserts things like *"a signed-out visitor cannot read the
reports table"* and *"a member cannot inflate the support count on their own
report"*. Run it against a **throwaway** database, never production — it writes
and deletes rows:

```bash
psql "$DATABASE_URL" -f supabase/schema.sql
psql "$DATABASE_URL" -f supabase/tests.sql
```

Every line should print `PASS`.

---

## Things you can change without touching code

In the `app_settings` table:

| Key | Default | What it does |
|---|---|---|
| `report_window_days` | `7` | How long a report stays on the map |
| `public_sample_limit` | `5` | How many reports a signed-out visitor may see |
| `public_detail_max_span` | `0.35` | How far in they must zoom before seeing any |
| `auto_hide_flag_threshold` | `999999` | Flags before a report auto-hides. **Set to `2`** to switch community moderation on |
| `points_per_report` | `5` | Points for a report that is still published |
| `points_per_confirmation` | `4` | Points for each confirmation one of your reports receives |
| `points_per_given` | `1` | Points for confirming somebody else's report |

Add a scam category by inserting a row into `scam_categories` — the map, the
filters and the report form all pick it up with no code change.

The ten levels are rows in `contributor_levels`, so a threshold is an `update`
and nothing is stored against a member — change one and everybody's level
recomputes at once.

---

## Levels and badges

### How a level is earned

Points, not a count of reports. Level by volume alone rewards filing, and the
cheapest way to file more is to file worse — on a map people use to decide
where to walk, that is the one failure that matters. So the heaviest single
thing a member can earn is somebody else recognising what they reported:

| | Points |
|---|---|
| Filing a report | 5 |
| A confirmation your report receives | 4 |
| Confirming somebody else's report | 1 |

A report nobody confirms is worth 5; the same report with three confirmations
is worth 17. Confirming your own report is worth nothing on either side, and
the insert policy on `report_supports` refuses it anyway.

Points are lifetime. A report that has aged off the map was still filed.
Withdrawing one does take its points back, because withdrawing deletes it.

### Ten levels, not a hundred

| Level | Points | | Level | Points |
|---|---|---|---|---|
| 1 Beginner | 0 | | 6 Veteran | 150 |
| 2 Reporter | 10 | | 7 Guardian | 230 |
| 3 Contributor | 25 | | 8 Expert | 330 |
| 4 Regular | 50 | | 9 Champion | 450 |
| 5 Trusted | 90 | | 10 Legend | 600 |

A hundred was the other option and it is the wrong shape here. A ladder only
works while the next rung is in sight, and the realistic distribution on a site
like this is steep: most members file one or two reports ever, a handful file
dozens. Over a hundred rungs that leaves almost everybody on level 1 with a bar
that never visibly moves and ninety rungs nobody will stand on. Ten rungs, with
the first few reachable in an afternoon and the top a real achievement, is the
version where the bar moves.

Watch the distribution rather than guessing — `supabase/ops/contributors.sql`
prints it. If almost everybody is on 1 and 2 the bottom is too far apart; if
half the site is on 10 it is too close together. Either is a reason to retune
`contributor_levels`, and neither is a reason to add more levels. The names
live in `js/locales`, not in the database, because this site is read in nine
languages.

### Badges

Points measure reports filed and recognised. They say nothing about somebody
who makes videos about street scams and sends their audience here — who may be
the most useful contributor on the site while never filing a single report.
That is what a badge is for. Granted by hand, with a reason written beside it.

| Badge | For |
|---|---|
| `creator` | Makes videos or posts about street scams |
| `top` | A contributor you want named whatever the arithmetic says |
| `founder` | Here early, when the map was mostly empty |
| `partner` | An organisation rather than a person |

Somebody can hold several at once, which is why they are a table rather than a
column.

### The admin page

`/admin`, for whoever runs the site. Five screens:

| Screen | What it does |
|---|---|
| **Members** | Every member with nickname, email, level, points, reports and badges. Change their role, give them a level, give or take a badge, put them on the contributors list, or remove them — which deletes their reports with them. |
| **Reports** | Everything filed, filtered by flagged / hidden / taken down / on the map / all, with the text, the flag reasons and **who filed it**. Approve, hide, take down, or delete. |
| **Levels** | The ladder, edited as a whole and saved in one go. |
| **Regions** | Which countries are closed to new reports, picked from the list of continents, UN zones and unions rather than typed from memory. |
| **Settings** | The `app_settings` numbers — the point weights, the report window, the auto-hide threshold — each with what it does beside it. |

**Three things the screens enforce rather than trust:**

- **Approving a report clears its flags.** Otherwise the same people re-hide it
  the moment the threshold is reached again, and an admin who looked at it has
  already answered that question.
- **A report already taken down leaves the Flagged queue.** It has had its
  decision; a queue that keeps showing it is a queue nobody finishes reading.
- **The ladder is sent whole, not row by row.** It is only valid as a set —
  ascending, starting at level 1 with 0 points — and editing it a row at a time
  passes through states that are none of those. A refused ladder is taken off
  the screen rather than left looking saved, and shortening the ladder clears
  any `level_override` that pointed at a rung that no longer exists.

**Reports show who filed them**, which `reports_feed` deliberately withholds
from everybody else. Moderation is the one job that cannot be done without it:
the thing you are usually looking at is not one bad report but six from one
account.

**It is not a generic SQL console, on purpose.** A table editor that can run
anything is the Supabase dashboard — it exists, it is behind a real login, and
it is not served to the public. What is here is the handful of things somebody
running this site actually does, each with its own validation: a status that
must be one of three, a setting that must be a number, a region handle that
must exist (a typo closes nothing, silently, while you believe a country is
shut).

**Its address is `/admin`** — `vercel.json` sets `cleanUrls`, so Vercel serves
the extensionless form and 308-redirects `/admin.html` to it. Checked against
the live site rather than assumed: `/admin` → 200, `/admin.html` → 308,
`/nonsense` → 404.

**A secret address would not be security**, and it is worth being clear about
why. The page is useless to a non-admin: every call it makes is refused by the
database, and `js/data.js` names those calls in plain sight to anybody who opens
the browser's sources. Moving it to `/x7f2-admin` would hide the link and not
the functions, which is the wrong half. What actually protects it is below.

**The public site does not link to it at all**, not even for an admin. That
header belongs to the map, administration is not part of it, and `/admin` is
reached by typing it or by a bookmark. Tidiness, not a lock: the protection is
below, and the map does not read anybody's `role` for any purpose.

**What protects it is the database, not the page.** Every call it makes is
refused unless `auth.uid()` belongs to somebody whose profile row says `admin`,
and that check runs inside each function. Hiding the controls from a member is
politeness; opening a console and calling `admin_set_role` yourself gets
`admins only`. There is a test for exactly that.

**Two lockouts are refused**: the last admin cannot demote themselves, and an
admin cannot remove themselves here (close your own account from your profile,
like anybody else). Both would leave a site nobody can administer, with the SQL
editor as the only way back.

**The first admin is made in the SQL editor**, because there is nowhere else it
can be done:

```sql
update public.profiles set role = 'admin'
 where id = (select id from auth.users where email = 'you@example.com');
```

**There is no "add member" button, and there cannot be one.** Creating an
account needs Supabase's admin API and the secret key, and that key bypasses
every rule in `schema.sql` — so it can never be in a page served to the public.
Anyone can sign up on the map themselves; the admin page decides what they are
once they have. To create an account by hand, use **Authentication → Users** in
the Supabase dashboard.

The page is in **English only**, and it is the only page here that is.
Everything a traveller reads is in nine languages; this is a control panel for
one or two people who chose to run the site, and half of what it shows —
`that is the last admin`, `no such role: wizard` — comes back from Postgres in
English anyway.

A level given from the admin page sits in `profiles.level_override` and wins
over the earned one. The profile shows the given level without a progress bar:
somebody handed level 7 has not earned 600 points, and a bar pretending
otherwise would be a lie about their own account.

### Finding somebody and giving them a badge

Either from the admin page above, or in the **Supabase SQL editor** — not the
Database workflow, whose logs are public along with this repository. Find them
by whatever you happen to know:

```sql
select * from public.admin_contributors
 where display_name ilike '%ana%' or email ilike '%ana%';
```

`admin_contributors` is the dashboard: nickname, email, level, points, reports,
confirmations, badges, and whether they are on the contributors list. It is
revoked from both browser roles, so only the SQL editor and the table editor
can read it.

Then grant. A nickname, an email address or the id — all three work:

```sql
select * from public.grant_badge('Ana Beltran', 'creator', 'Scam awareness reels');
select * from public.grant_badge('ana@example.com', 'top');
select * from public.grant_badge('6f1c…-the-uuid', 'founder');
select public.revoke_badge('ana', 'creator');     -- returns how many rows went
```

An ambiguous nickname is **refused** with the matches named, never guessed at.
`display_name` is not unique and cannot safely be made unique — two people
signing up as `john@gmail.com` and `john@yahoo.com` are both "john" through no
fault of their own — so the one thing this must never do is quietly badge the
wrong John. Use the email or the id when it says so.

Granting also puts them on the contributors list, because that is normally the
point; pass `false` as the fourth argument for a badge that is only for your
records. Revoking a badge does **not** take them off the list — being named is
their decision, not a side effect of yours.

### When Google sign-in is added

Nothing above changes. A Google account arrives in `auth.users` with an email
like any other, and the sign-up trigger now prefers the name Google supplies
(`raw_user_meta_data->>'full_name'`, then `name`, then `preferred_username`)
over the local part of the address — so the nickname you search for is what
they are actually called rather than a fragment of their address. Members can
still edit it in account settings.

### What levels and badges never do

They do not attach a name to a report. `reports_feed` drops `reporter_id` on
purpose, and the contributors list carries a name, a level and a badge without
ever saying which pin on the map is whose. Being on that list is opt-in and off
by default, because the name most members carry was taken from their email
address at sign-up rather than chosen.

### The reference page

`/guide.html` explains, for readers rather than for operators: what red and
orange mean on each of the two scales, what a level is and how points are
earned, what each badge means, and where every layer comes from with its own
limit beside it. In all nine languages.

It exists because the map's own panels were filling up with it. The weather key
carried five paragraphs — how far ahead warnings reach, what the two marker
brightnesses mean, what a marker's position does and does not mean, which
countries are covered, and that this is not an alert service — in a panel
floating over the map that somebody opened to find out what a colour meant.
What stays in the key is the line that reads the markers in front of you and
the credit for whoever issued them. The rest moved, with a link where it was.

The levels table, the point weights, the badge list and the grade names on that
page are all read from the same places the map reads them, so retuning
`contributor_levels` or `points_per_report` changes what the page tells people
rather than leaving it quoting the numbers it shipped with.

### Testing the SQL

Everything else in this repository tests the page with the database stubbed,
which means the stub and the page can agree perfectly while the SQL underneath
is wrong. `supabase/test/run.sh` applies `schema.sql` to a throwaway Postgres
and checks the arithmetic, the lookups, the admin calls and who may read what
— 107 assertions, including putting a `REVOKE` back to confirm the permission
checks fail when they should.

It runs **twice**: once against an empty database, and once as an upgrade,
applying `origin/main`'s schema first and the working copy on top. The second
pass exists because the first one cannot see a whole class of fault — `CREATE
OR REPLACE` will not change a function's return type, and on an empty database
there is nothing to replace. The live apply found that the hard way.

---

## Known limits

- **Email is the bottleneck, not the database.** The built-in sender allows ~2
  messages an hour. Configure SMTP (step 4) before any real user tries to join.
- **Magic links on phones** can open in a different browser from the one the
  person started in, landing them signed out even when the URL is right. If
  that becomes a common complaint, switch to a 6-digit code: it removes the
  redirect entirely and behaves the same on every device.

- **Geocoding** uses two free services, for two different jobs. Nominatim
  answers a deliberate search and names the point behind a dropped pin; it
  asks for roughly one request per second and its policy forbids per-keystroke
  autocomplete in as many words. Suggestions while someone types therefore come
  from Photon (Komoot, same OpenStreetMap data), which is built for exactly
  that and sends the CORS headers a page needs. Both endpoints are in
  `js/config.js`; swap either for a paid service if the site gets busy.

  What keeps that fair: nothing is asked before three characters, nothing until
  typing pauses for 280 ms, and each request cancels the one before it.
- **Severity is self-declared.** Someone could mark everything "high". The
  flag + auto-hide path in `app_settings` is the answer when that starts happening.
- **Reports are unverified accounts from strangers.** The site says so in the
  footer and in the "Staying safe" section — keep that prominent.
- A member's email is stored by Supabase Auth. Their name is never attached to
  a report on the map.
