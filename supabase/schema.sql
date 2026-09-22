-- ============================================================================
-- StreetScamRadar — database schema
-- Run once in the Supabase SQL editor (Dashboard -> SQL -> New query).
-- Idempotent: re-running it is safe.
--
-- SECURITY MODEL — read this before changing anything below.
--
-- The browser talks to Postgres directly with the *anon* key, which is public
-- by design and visible in the page source. Every access rule therefore lives
-- in this file, never in JavaScript. Three separate doors:
--
--   signed-out visitor -> public_area_summary() / public_sample_reports()
--                         only. No direct table access at all. The row cap
--                         lives in SQL, so it cannot be lifted from a browser
--                         console.
--   signed-in member   -> the reports_feed view. It omits reporter_id, so
--                         members cannot deanonymise whoever filed a report.
--   report author      -> insert via the table; withdraw via delete_my_report().
--
-- Direct SELECT/UPDATE/DELETE on public.reports is revoked from both roles.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Settings. Lets you change behaviour from the dashboard without a migration.
-- RLS on with no policies: nothing reads this table directly. The two helpers
-- below are SECURITY DEFINER so they still work from inside policies.
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  key   text primary key,
  value jsonb not null,
  note  text
);

insert into public.app_settings (key, value, note) values
  ('report_window_days',       '7',      'How many days back a report stays visible.'),
  ('auto_hide_flag_threshold', '999999', 'Flags before a report auto-hides. Set to 2 to switch community moderation on.'),
  ('report_move_window_hours', '24',     'How long after filing a report its author may still move it.'),
  ('public_sample_limit',      '5',      'Max reports a signed-out visitor sees when zoomed in.'),
  ('public_detail_max_span',   '0.35',   'Signed-out visitors see individual reports only when the map spans fewer degrees than this.')
on conflict (key) do nothing;

alter table public.app_settings enable row level security;
revoke all on table public.app_settings from anon, authenticated;

create or replace function public.setting_int(p_key text, p_default int)
returns int language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::int from public.app_settings where key = p_key), p_default);
$$;

create or replace function public.setting_num(p_key text, p_default numeric)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::numeric from public.app_settings where key = p_key), p_default);
$$;

create or replace function public.report_window()
returns interval language sql stable as $$
  select make_interval(days => public.setting_int('report_window_days', 7));
$$;

-- ---------------------------------------------------------------------------
-- Scam categories. A table, not an enum, so you can add one from the Supabase
-- dashboard with no code change and no migration.
-- ---------------------------------------------------------------------------
create table if not exists public.scam_categories (
  slug       text primary key,
  label      text not null,
  glyph      text not null default '!',
  blurb      text,
  sort_order int  not null default 100,
  is_active  boolean not null default true
);

insert into public.scam_categories (slug, label, glyph, blurb, sort_order) values
  ('pickpocket',    'Pickpocketing & bag theft',   '👜', 'Crowds, transport, distraction teams.',          10),
  ('distraction',   'Distraction & street games',  '🎲', 'Shell games, petitions, bracelets, spills.',     20),
  ('taxi',          'Taxi & ride overcharging',    '🚕', 'Broken meters, long routes, card refused.',      30),
  ('tickets',       'Fake tickets & tours',        '🎫', 'Counterfeit entry, tours that never happen.',    40),
  ('rental',        'Rental & accommodation',      '🏠', 'Deposits for places that do not exist.',         50),
  ('atm',           'ATM & card skimming',         '💳', 'Tampered machines, helpful strangers.',          60),
  ('money',         'Currency & fake change',      '💵', 'Bad rates, short change, withdrawn notes.',      70),
  ('fake_official', 'Fake police or officials',    '🛂', 'Fake ID, fake fines, fake document checks.',     80),
  ('overcharge',    'Bar, menu & shop overcharge', '🧾', 'Hidden prices, swapped bills, clip joints.',     90),
  ('counterfeit',   'Counterfeit goods',           '🛍️', 'Fakes sold as genuine, bait and switch.',       100),
  ('online',        'Online & booking fraud',      '🌐', 'Fake listings and booking sites for this area.', 110),
  ('other',         'Something else',              '⚠️', 'Anything that does not fit the list.',          900)
on conflict (slug) do nothing;

alter table public.scam_categories enable row level security;
drop policy if exists "categories are public" on public.scam_categories;
create policy "categories are public" on public.scam_categories
  for select to anon, authenticated using (is_active);

-- ---------------------------------------------------------------------------
-- Profiles. One row per member, created automatically on sign-up.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text,
  home_label   text,
  home_lat     double precision,
  home_lng     double precision,
  -- The language you chose, so the site opens in it on any device you sign in
  -- on. Null means "whatever this browser asks for", which is what a member
  -- who has never touched the picker gets.
  locale       text,
  created_at   timestamptz not null default now(),
  constraint home_lat_range check (home_lat is null or home_lat between -90 and 90),
  constraint home_lng_range check (home_lng is null or home_lng between -180 and 180),
  constraint locale_known   check (locale is null or locale in ('en','de','es','fr','it','pt','nl','cs','pl'))
);

-- Existing installs: add the column and its check without touching the rest.
alter table public.profiles add column if not exists locale text;
alter table public.profiles drop constraint if exists locale_known;
alter table public.profiles add constraint locale_known
  check (locale is null or locale in ('en','de','es','fr','it','pt','nl','cs','pl'));

alter table public.profiles enable row level security;
drop policy if exists "read own profile"   on public.profiles;
drop policy if exists "update own profile" on public.profiles;
drop policy if exists "insert own profile" on public.profiles;
create policy "read own profile"   on public.profiles for select to authenticated using (id = auth.uid());
create policy "update own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "insert own profile" on public.profiles for insert to authenticated with check (id = auth.uid());

-- Defence in depth: RLS already returns no rows to a signed-out visitor, but
-- revoking the grant turns a silent empty result into a hard refusal.
revoke all on table public.profiles from anon;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(coalesce(new.email, 'member'), '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Reports.
-- ---------------------------------------------------------------------------
create table if not exists public.reports (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid references auth.users on delete set null,
  category      text not null references public.scam_categories(slug),
  -- What actually happened, as facts a reporter can know. This replaced a
  -- low/medium/high severity picker: nobody standing in a station can rate
  -- their own risk on a three-point scale, and the answer told a reader
  -- nothing they could act on. An empty array means it was attempted and
  -- nothing here applies, which is itself useful.
  impacts       text[] not null default '{}'
                check (impacts <@ array['money','harm','threats']::text[]),
  headline      text not null check (char_length(btrim(headline)) between 8 and 90),
  -- One word is a valid answer. The headline already carries the summary;
  -- a 20-character floor here only ever blocked someone with little to add.
  description   text not null check (char_length(btrim(description)) between 1 and 1200),

  lat           double precision not null check (lat between -90 and 90),
  lng           double precision not null check (lng between -180 and 180),
  address       text,
  city          text,
  country_code  char(2),

  happened_at   timestamptz not null,
  created_at    timestamptz not null default now(),

  status        text not null default 'published' check (status in ('published','under_review','removed')),
  support_count int not null default 0,
  flag_count    int not null default 0,

  constraint happened_not_future check (happened_at <= now() + interval '1 hour')
);

create index if not exists reports_happened_idx on public.reports (happened_at desc);
create index if not exists reports_lat_idx      on public.reports (lat);
create index if not exists reports_lng_idx      on public.reports (lng);
create index if not exists reports_status_idx   on public.reports (status);
create index if not exists reports_reporter_idx on public.reports (reporter_id);

alter table public.reports enable row level security;

-- Nobody reads, edits or deletes this table directly. Reads go through
-- reports_feed; withdrawal goes through delete_my_report(). Only INSERT
-- stays, so a member can file a report.
revoke select, update, delete on table public.reports from anon, authenticated;
grant insert on table public.reports to authenticated;

drop policy if exists "members read recent reports" on public.reports;
drop policy if exists "members edit own reports"    on public.reports;
drop policy if exists "members delete own reports"  on public.reports;

drop policy if exists "members create reports" on public.reports;
create policy "members create reports" on public.reports
  for insert to authenticated
  with check (
    reporter_id  = auth.uid()
    and status   = 'published'
    and support_count = 0
    and flag_count    = 0
    and happened_at > now() - public.report_window()
  );

-- What a signed-in member may read. A view rather than a policy, because it
-- must drop reporter_id: whoever reported a scam stays anonymous to everyone
-- except themselves (via is_mine) and you, in the dashboard.
-- security_invoker = false on purpose — the WHERE clause here IS the rule.
drop view if exists public.reports_feed;
create view public.reports_feed
with (security_invoker = false) as
  select r.id, r.category, r.impacts, r.headline, r.description,
         r.lat, r.lng, r.address, r.city, r.country_code,
         r.happened_at, r.created_at,
         r.support_count, r.flag_count,
         (r.reporter_id = auth.uid()) as is_mine
    from public.reports r
   where (r.status = 'published' and r.happened_at > now() - public.report_window())
      or r.reporter_id = auth.uid();

revoke all on public.reports_feed from anon;
grant select on public.reports_feed to authenticated;

-- Withdraw your own report. SECURITY DEFINER so it needs no table grants.
create or replace function public.delete_my_report(p_report_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare removed int;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;
  delete from public.reports where id = p_report_id and reporter_id = auth.uid();
  get diagnostics removed = row_count;
  return removed > 0;
end;
$$;

revoke all on function public.delete_my_report(uuid) from public, anon;
grant execute on function public.delete_my_report(uuid) to authenticated;

-- Fix your own wording. SECURITY DEFINER for the same reason as the delete:
-- members have no UPDATE on the table at all, and this is the only way in.
--
-- What it will not let you change: whose report it is, where it happened, what
-- category it is, or what it has collected. A report that could be rewritten
-- into a different report somewhere else, after people had confirmed it, would
-- make confirmation meaningless.
--
-- The time is optional. Left null it keeps the original, which is the point —
-- correcting a typo should not quietly move when the scam happened. Given, it
-- must still be a time the report could have been filed with in the first
-- place: not in the future, and not older than the window.
-- Where it happened can be corrected too, but only for a day. Somebody who
-- mis-tapped the map should be able to fix it; a report that could still be
-- moved a week later, after people had confirmed it, would let a confirmed
-- warning be relocated to somewhere nobody had ever confirmed.
create or replace function public.report_move_window()
returns interval language sql stable as $$
  select make_interval(hours => public.setting_int('report_move_window_hours', 24));
$$;

drop function if exists public.edit_my_report(uuid, text, text, timestamptz);
create or replace function public.edit_my_report(
  p_report_id    uuid,
  p_headline     text,
  p_description  text,
  p_happened_at  timestamptz default null,
  p_lat          double precision default null,
  p_lng          double precision default null,
  p_address      text default null,
  p_city         text default null,
  p_country_code text default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  changed int;
  filed   timestamptz;
  moving  boolean := p_lat is not null and p_lng is not null;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;
  if p_happened_at is not null then
    if p_happened_at > now() + interval '1 hour' then
      raise exception 'that time is in the future';
    end if;
    if p_happened_at <= now() - public.report_window() then
      raise exception 'that time is outside the % window', public.report_window();
    end if;
  end if;

  select created_at into filed
    from public.reports
   where id = p_report_id and reporter_id = auth.uid();
  if filed is null then
    return false;                       -- not yours, or not there
  end if;

  if moving then
    if filed <= now() - public.report_move_window() then
      raise exception 'a report can only be moved in its first %',
        public.report_move_window();
    end if;
    if p_lat not between -90 and 90 or p_lng not between -180 and 180 then
      raise exception 'that is not a place';
    end if;
  end if;

  update public.reports r
     set headline     = btrim(p_headline),
         description  = btrim(p_description),
         happened_at  = coalesce(p_happened_at, r.happened_at),
         lat          = case when moving then p_lat else r.lat end,
         lng          = case when moving then p_lng else r.lng end,
         address      = case when moving then p_address else r.address end,
         city         = case when moving then p_city else r.city end,
         country_code = case when moving then upper(nullif(btrim(p_country_code), ''))
                             else r.country_code end
   where r.id = p_report_id
     and r.reporter_id = auth.uid();
  get diagnostics changed = row_count;
  return changed > 0;
end;
$$;

revoke all on function public.edit_my_report(uuid, text, text, timestamptz, double precision, double precision, text, text, text) from public, anon;
grant execute on function public.edit_my_report(uuid, text, text, timestamptz, double precision, double precision, text, text, text) to authenticated;

-- Close your account. SECURITY DEFINER because nothing the browser holds may
-- touch auth.users.
--
-- Your reports go with it. The alternative — auth.users' ON DELETE SET NULL
-- leaving them behind — would both keep your words on the map after you asked
-- to leave and collide with the one thing reporter_id IS NULL means here,
-- which is seeded demo data that ops scripts delete on sight.
--
-- Confirmations and flags you left on other people's reports cascade from
-- auth.users, and the counters correct themselves through their triggers.
create or replace function public.delete_my_account()
returns boolean language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'sign in required';
  end if;
  delete from public.reports where reporter_id = uid;
  delete from auth.users where id = uid;
  return true;
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------
-- Support ("I saw this too") and flags. One of each per member per report.
-- Support is what earns a report visibility; flags are what take it away.
-- ---------------------------------------------------------------------------
create table if not exists public.report_supports (
  report_id  uuid not null references public.reports on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)
);

create table if not exists public.report_flags (
  report_id  uuid not null references public.reports on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  reason     text not null default 'other' check (reason in ('wrong','abusive','personal_data','duplicate','other')),
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)
);

alter table public.report_supports enable row level security;
alter table public.report_flags    enable row level security;

-- Whether a report is your own. SECURITY DEFINER because the support policy
-- below has to ask, and members have no select on reports at all.
create or replace function public.is_own_report(p_report_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.reports r
     where r.id = p_report_id and r.reporter_id = auth.uid()
  );
$$;

revoke all on function public.is_own_report(uuid) from public, anon;
grant execute on function public.is_own_report(uuid) to authenticated;

-- Own rows only: who supported what is nobody else's business. The public
-- number lives in reports.support_count.
--
-- Confirming is for other people's reports. Support is now what decides how
-- loudly a report is drawn, so a reporter confirming themselves would be
-- voting for their own visibility. The author's move on their own report is
-- to withdraw it.
drop policy if exists "read own supports"  on public.report_supports;
drop policy if exists "add own support"    on public.report_supports;
drop policy if exists "drop own support"   on public.report_supports;
create policy "read own supports" on public.report_supports for select to authenticated using (user_id = auth.uid());
create policy "add own support"   on public.report_supports for insert to authenticated
  with check (user_id = auth.uid() and not public.is_own_report(report_id));
create policy "drop own support"  on public.report_supports for delete to authenticated using (user_id = auth.uid());

drop policy if exists "read own flags" on public.report_flags;
drop policy if exists "add own flag"   on public.report_flags;
create policy "read own flags" on public.report_flags for select to authenticated using (user_id = auth.uid());
create policy "add own flag"   on public.report_flags for insert to authenticated with check (user_id = auth.uid());

revoke all on table public.report_supports from anon;
revoke all on table public.report_flags    from anon;

-- Counters are maintained here, never by the client — a member must not be
-- able to inflate the support count on their own report.
create or replace function public.recount_supports()
returns trigger language plpgsql security definer set search_path = public as $$
declare target uuid := coalesce(new.report_id, old.report_id);
begin
  update public.reports r
     set support_count = (select count(*) from public.report_supports s where s.report_id = target)
   where r.id = target;
  return null;
end;
$$;

create or replace function public.recount_flags()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target uuid := coalesce(new.report_id, old.report_id);
  total  int;
  limit_ int := public.setting_int('auto_hide_flag_threshold', 999999);
begin
  select count(*) into total from public.report_flags f where f.report_id = target;
  update public.reports r
     set flag_count = total,
         status = case when total >= limit_ and r.status = 'published' then 'under_review' else r.status end
   where r.id = target;
  return null;
end;
$$;

drop trigger if exists supports_recount on public.report_supports;
create trigger supports_recount
  after insert or delete on public.report_supports
  for each row execute function public.recount_supports();

drop trigger if exists flags_recount on public.report_flags;
create trigger flags_recount
  after insert or delete on public.report_flags
  for each row execute function public.recount_flags();

-- ---------------------------------------------------------------------------
-- The signed-out view of the world.
--
-- Zoomed out -> counts only, bucketed into a coarse grid. No text, no pin.
-- Zoomed in  -> a capped handful of individual reports, best-supported first.
-- Both SECURITY DEFINER, because the anon role cannot read reports at all.
-- ---------------------------------------------------------------------------
-- The return type changes with severity gone, and Postgres will not replace a
-- function's signature in place.
drop function if exists public.public_area_summary(double precision, double precision, double precision, double precision, int);
create or replace function public.public_area_summary(
  min_lat double precision, min_lng double precision,
  max_lat double precision, max_lng double precision,
  cells   int default 12
)
returns table (lat double precision, lng double precision, total bigint, confirmed bigint)
language sql stable security definer set search_path = public as $$
  with bounds as (
    select least(min_lat, max_lat) as y0, greatest(min_lat, max_lat) as y1,
           least(min_lng, max_lng) as x0, greatest(min_lng, max_lng) as x1
  ),
  grid as (
    -- A cell size off a fixed ladder of powers of two, anchored at 0,0 and
    -- shared by the whole world.
    --
    -- This used to divide the viewport into `cells` columns starting at its
    -- own south-west corner, which meant every cell centre moved whenever the
    -- viewport did: the circles slid around under the cursor on any pan, and
    -- drifted continuously while zooming. Snapping to a global lattice makes a
    -- circle's position a property of where the reports are, so panning never
    -- moves one and zooming only regroups when the span crosses a power of two.
    select b.*,
           greatest(
             power(2::numeric,
                   floor(log(2::numeric,
                             greatest(b.x1 - b.x0, b.y1 - b.y0, 1e-6)::numeric
                               / greatest(cells, 1))))::double precision,
             0.0005) as step
      from bounds b
  ),
  frame as (
    -- Widen the search to whole cells.
    --
    -- Snapping the centres stopped the circles sliding, but the counts still
    -- changed on every pan, because a cell straddling the edge of the screen
    -- was only counted as far as the screen went: the number in the circle
    -- ticked up and down as you moved, and cells blinked in and out at the
    -- margin. Asking for whole cells means a circle's number is a property of
    -- the cell, so nothing changes until the view crosses a cell boundary.
    select floor(g.y0 / g.step) * g.step as qy0,
           ceil (g.y1 / g.step) * g.step as qy1,
           floor(g.x0 / g.step) * g.step as qx0,
           ceil (g.x1 / g.step) * g.step as qx1,
           g.step
      from grid g
  )
  select floor(r.lat / f.step) * f.step + f.step / 2,
         floor(r.lng / f.step) * f.step + f.step / 2,
         count(*),
         count(*) filter (where r.support_count > 0)
    from public.reports r, frame f
   where r.status = 'published'
     and r.happened_at > now() - public.report_window()
     and r.lat between f.qy0 and f.qy1
     and r.lng between f.qx0 and f.qx1
   group by 1, 2;
$$;

-- Signed-out visitors get the report text too. This used to withhold
-- description, because the public view was a teaser with the account behind
-- sign-up; a pin you can click but not read is just frustrating. It lived in
-- supabase/ops/public_reports_with_detail.sql for a while, which meant every
-- re-run of this file silently took the text away again until that script was
-- run after it. One definition, here.
drop function if exists public.public_sample_reports(double precision, double precision, double precision, double precision);
create or replace function public.public_sample_reports(
  min_lat double precision, min_lng double precision,
  max_lat double precision, max_lng double precision
)
returns table (
  id uuid, category text, impacts text[], headline text, description text,
  lat double precision, lng double precision,
  address text, city text, country_code char(2),
  happened_at timestamptz, support_count int, total_in_view bigint
)
language sql stable security definer set search_path = public as $$
  with bounds as (
    select least(min_lat, max_lat) as y0, greatest(min_lat, max_lat) as y1,
           least(min_lng, max_lng) as x0, greatest(min_lng, max_lng) as x1
  ),
  visible as (
    select r.id, r.category, r.impacts, r.headline, r.description,
           r.lat, r.lng, r.address, r.city, r.country_code,
           r.happened_at, r.support_count
      from public.reports r, bounds b
     where r.status = 'published'
       and r.happened_at > now() - public.report_window()
       and r.lat between b.y0 and b.y1
       and r.lng between b.x0 and b.x1
       -- Individual reports only once the viewer has zoomed in far enough that
       -- this is a neighbourhood question, not a country-wide scrape.
       and (b.y1 - b.y0) <= public.setting_num('public_detail_max_span', 0.35)
       and (b.x1 - b.x0) <= public.setting_num('public_detail_max_span', 0.35)
  )
  -- Confirmations decide the order. A report several people recognised is a
  -- better warning than one somebody rated "high" about themselves, and it is
  -- the number the map now draws with.
  select v.*, (select count(*) from visible) as total_in_view
    from visible v
   order by v.support_count desc, v.happened_at desc
   limit public.setting_int('public_sample_limit', 5);
$$;

revoke all on function public.public_area_summary(double precision, double precision, double precision, double precision, int) from public;
revoke all on function public.public_sample_reports(double precision, double precision, double precision, double precision) from public;
grant execute on function public.public_area_summary(double precision, double precision, double precision, double precision, int) to anon, authenticated;
grant execute on function public.public_sample_reports(double precision, double precision, double precision, double precision) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Police stations and hospitals, stored rather than fetched live.
--
-- These were read straight from OpenStreetMap's Overpass API on every pan,
-- which made the layer only as reliable as a free, shared, frequently
-- congested service — and it was regularly neither fast nor available. They
-- now live here, refreshed by .github/workflows/safety-data.yml, so the page
-- reads them the same way it reads everything else: one indexed query against
-- our own database.
--
-- This is reference data, not user content: the same for everyone, readable
-- signed in or not, and never written from the browser.
-- ---------------------------------------------------------------------------
create table if not exists public.safety_places (
  id           text primary key,          -- OSM type/id, e.g. "node/12345"
  kind         text not null check (kind in ('police', 'hospital')),
  name         text not null,
  address      text,
  lat          double precision not null check (lat between -90 and 90),
  lng          double precision not null check (lng between -180 and 180),
  country_code char(2),
  opening_hours text,                            -- as OSM records it, e.g. "24/7"
  phone         text,
  emergency     boolean not null default false,  -- a hospital with an A&E
  updated_at   timestamptz not null default now()
);

-- Added after the table already existed on live projects.
alter table public.safety_places add column if not exists opening_hours text;
alter table public.safety_places add column if not exists phone text;
alter table public.safety_places add column if not exists emergency boolean not null default false;

create index if not exists safety_places_lat_idx on public.safety_places (lat);
create index if not exists safety_places_lng_idx on public.safety_places (lng);
create index if not exists safety_places_kind_idx on public.safety_places (kind);

alter table public.safety_places enable row level security;

-- Readable by everyone; writable by nobody through the API. The refresh
-- workflow connects as the database owner, which bypasses RLS.
drop policy if exists "safety places are public" on public.safety_places;
create policy "safety places are public" on public.safety_places
  for select to anon, authenticated using (true);

revoke insert, update, delete on table public.safety_places from anon, authenticated;
