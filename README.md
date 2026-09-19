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
js/geo.js       worldwide search + "where am I" (Nominatim / OpenStreetMap)
js/map.js       MapLibre setup, clustering, density layer
js/ui.js        rendering helpers (and HTML escaping)
supabase/schema.sql   tables, security rules, functions     <- run this once
supabase/tests.sql    proves the security rules actually hold
```

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

### 4. Email delivery — required before anyone else signs in

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

Add a scam category by inserting a row into `scam_categories` — the map, the
filters and the report form all pick it up with no code change.

---

## Known limits

- **Email is the bottleneck, not the database.** The built-in sender allows ~2
  messages an hour. Configure SMTP (step 4) before any real user tries to join.
- **Magic links on phones** can open in a different browser from the one the
  person started in, landing them signed out even when the URL is right. If
  that becomes a common complaint, switch to a 6-digit code: it removes the
  redirect entirely and behaves the same on every device.

- **Geocoding** uses Nominatim, which is free and asks for roughly one request
  per second. Fine for now; if the site gets busy, swap the endpoint in
  `js/config.js` for a paid geocoder.
- **Severity is self-declared.** Someone could mark everything "high". The
  flag + auto-hide path in `app_settings` is the answer when that starts happening.
- **Reports are unverified accounts from strangers.** The site says so in the
  footer and in the "Staying safe" section — keep that prominent.
- A member's email is stored by Supabase Auth. Their name is never attached to
  a report on the map.
