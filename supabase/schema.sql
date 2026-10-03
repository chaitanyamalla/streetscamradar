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
  ('public_detail_max_span',   '0.35',   'Signed-out visitors see individual reports only when the map spans fewer degrees than this.'),
  -- Where reporting is closed. Set from the dashboard, no deploy needed:
  --   update public.app_settings
  --      set value = '{"countries": [], "groups": ["south-eastern-asia"]}'
  --    where key = 'blocked_regions';
  -- A group is a continent, a zone or a union — select * from
  -- public.region_catalog for the whole menu. Reading is never affected: what
  -- is on the map stays readable everywhere.
  ('blocked_regions', '{"countries": [], "groups": []}',
   'Countries and groups where new reports are refused. Reading is unaffected.')
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
-- Country groups: the handles an administrator actually uses.
--
-- Closing somewhere should not mean listing forty countries by hand, so a
-- country belongs to several groups at once and any of them can be closed:
--
--   continent  AF AN AS EU NA OC SA
--   zone       the UN M49 sub-regions — western-europe, south-eastern-asia,
--              caribbean, northern-africa and so on. A published standard,
--              not groupings of our own invention.
--   union      the ones people name out loud: eu, schengen.
--
-- Every current ISO 3166-1 country is here, on exactly one continent and in
-- exactly one zone; the lists were checked against the region codes the
-- browser itself knows, so a typo or an omission would have shown up rather
-- than leaving a country quietly unblockable.
--
-- Two zones deliberately cross a continent, because the standard does: Cyprus
-- is in western-asia while sitting on our Europe continent, and M49 files
-- Christmas Island and Heard Island under australia-and-new-zealand. Such a
-- country is in both groups, and closing either closes it.
--
-- The other calls, made once and written here: Russia and Cyprus on the
-- Europe continent, Turkey on Asia, the sub-Antarctic islands on Antarctica.
-- Schengen includes Bulgaria and Romania, full members since January 2025.
-- ---------------------------------------------------------------------------
drop table if exists public.country_continents;   -- an earlier, narrower shape

create table if not exists public.country_groups (
  group_code   text    not null,
  kind         text    not null check (kind in ('continent','zone','union')),
  country_code char(2) not null,
  primary key (group_code, country_code)
);

create index if not exists country_groups_country_idx
  on public.country_groups (country_code);

insert into public.country_groups (group_code, kind, country_code) values
  ('AF','continent','AO'), ('AF','continent','BF'), ('AF','continent','BI'), ('AF','continent','BJ'),
  ('AF','continent','BW'), ('AF','continent','CD'), ('AF','continent','CF'), ('AF','continent','CG'),
  ('AF','continent','CI'), ('AF','continent','CM'), ('AF','continent','CV'), ('AF','continent','DJ'),
  ('AF','continent','DZ'), ('AF','continent','EG'), ('AF','continent','EH'), ('AF','continent','ER'),
  ('AF','continent','ET'), ('AF','continent','GA'), ('AF','continent','GH'), ('AF','continent','GM'),
  ('AF','continent','GN'), ('AF','continent','GQ'), ('AF','continent','GW'), ('AF','continent','KE'),
  ('AF','continent','KM'), ('AF','continent','LR'), ('AF','continent','LS'), ('AF','continent','LY'),
  ('AF','continent','MA'), ('AF','continent','MG'), ('AF','continent','ML'), ('AF','continent','MR'),
  ('AF','continent','MU'), ('AF','continent','MW'), ('AF','continent','MZ'), ('AF','continent','NA'),
  ('AF','continent','NE'), ('AF','continent','NG'), ('AF','continent','RE'), ('AF','continent','RW'),
  ('AF','continent','SC'), ('AF','continent','SD'), ('AF','continent','SH'), ('AF','continent','SL'),
  ('AF','continent','SN'), ('AF','continent','SO'), ('AF','continent','SS'), ('AF','continent','ST'),
  ('AF','continent','SZ'), ('AF','continent','TD'), ('AF','continent','TG'), ('AF','continent','TN'),
  ('AF','continent','TZ'), ('AF','continent','UG'), ('AF','continent','YT'), ('AF','continent','ZA'),
  ('AF','continent','ZM'), ('AF','continent','ZW'), ('AN','continent','AQ'), ('AN','continent','BV'),
  ('AN','continent','GS'), ('AN','continent','HM'), ('AN','continent','TF'), ('antarctica','zone','AQ'),
  ('antarctica','zone','BV'), ('antarctica','zone','GS'), ('antarctica','zone','TF'), ('AS','continent','AE'),
  ('AS','continent','AF'), ('AS','continent','AM'), ('AS','continent','AZ'), ('AS','continent','BD'),
  ('AS','continent','BH'), ('AS','continent','BN'), ('AS','continent','BT'), ('AS','continent','CC'),
  ('AS','continent','CN'), ('AS','continent','CX'), ('AS','continent','GE'), ('AS','continent','HK'),
  ('AS','continent','ID'), ('AS','continent','IL'), ('AS','continent','IN'), ('AS','continent','IO'),
  ('AS','continent','IQ'), ('AS','continent','IR'), ('AS','continent','JO'), ('AS','continent','JP'),
  ('AS','continent','KG'), ('AS','continent','KH'), ('AS','continent','KP'), ('AS','continent','KR'),
  ('AS','continent','KW'), ('AS','continent','KZ'), ('AS','continent','LA'), ('AS','continent','LB'),
  ('AS','continent','LK'), ('AS','continent','MM'), ('AS','continent','MN'), ('AS','continent','MO'),
  ('AS','continent','MV'), ('AS','continent','MY'), ('AS','continent','NP'), ('AS','continent','OM'),
  ('AS','continent','PH'), ('AS','continent','PK'), ('AS','continent','PS'), ('AS','continent','QA'),
  ('AS','continent','SA'), ('AS','continent','SG'), ('AS','continent','SY'), ('AS','continent','TH'),
  ('AS','continent','TJ'), ('AS','continent','TL'), ('AS','continent','TM'), ('AS','continent','TR'),
  ('AS','continent','TW'), ('AS','continent','UZ'), ('AS','continent','VN'), ('AS','continent','YE'),
  ('australia-and-new-zealand','zone','AU'), ('australia-and-new-zealand','zone','CC'), ('australia-and-new-zealand','zone','CX'), ('australia-and-new-zealand','zone','HM'),
  ('australia-and-new-zealand','zone','NF'), ('australia-and-new-zealand','zone','NZ'), ('caribbean','zone','AG'), ('caribbean','zone','AI'),
  ('caribbean','zone','AW'), ('caribbean','zone','BB'), ('caribbean','zone','BL'), ('caribbean','zone','BQ'),
  ('caribbean','zone','BS'), ('caribbean','zone','CU'), ('caribbean','zone','CW'), ('caribbean','zone','DM'),
  ('caribbean','zone','DO'), ('caribbean','zone','GD'), ('caribbean','zone','GP'), ('caribbean','zone','HT'),
  ('caribbean','zone','JM'), ('caribbean','zone','KN'), ('caribbean','zone','KY'), ('caribbean','zone','LC'),
  ('caribbean','zone','MF'), ('caribbean','zone','MQ'), ('caribbean','zone','MS'), ('caribbean','zone','PR'),
  ('caribbean','zone','SX'), ('caribbean','zone','TC'), ('caribbean','zone','TT'), ('caribbean','zone','VC'),
  ('caribbean','zone','VG'), ('caribbean','zone','VI'), ('central-america','zone','BZ'), ('central-america','zone','CR'),
  ('central-america','zone','GT'), ('central-america','zone','HN'), ('central-america','zone','MX'), ('central-america','zone','NI'),
  ('central-america','zone','PA'), ('central-america','zone','SV'), ('central-asia','zone','KG'), ('central-asia','zone','KZ'),
  ('central-asia','zone','TJ'), ('central-asia','zone','TM'), ('central-asia','zone','UZ'), ('eastern-africa','zone','BI'),
  ('eastern-africa','zone','DJ'), ('eastern-africa','zone','ER'), ('eastern-africa','zone','ET'), ('eastern-africa','zone','KE'),
  ('eastern-africa','zone','KM'), ('eastern-africa','zone','MG'), ('eastern-africa','zone','MU'), ('eastern-africa','zone','MW'),
  ('eastern-africa','zone','MZ'), ('eastern-africa','zone','RE'), ('eastern-africa','zone','RW'), ('eastern-africa','zone','SC'),
  ('eastern-africa','zone','SO'), ('eastern-africa','zone','SS'), ('eastern-africa','zone','TZ'), ('eastern-africa','zone','UG'),
  ('eastern-africa','zone','YT'), ('eastern-africa','zone','ZM'), ('eastern-africa','zone','ZW'), ('eastern-asia','zone','CN'),
  ('eastern-asia','zone','HK'), ('eastern-asia','zone','JP'), ('eastern-asia','zone','KP'), ('eastern-asia','zone','KR'),
  ('eastern-asia','zone','MN'), ('eastern-asia','zone','MO'), ('eastern-asia','zone','TW'), ('eastern-europe','zone','BG'),
  ('eastern-europe','zone','BY'), ('eastern-europe','zone','CZ'), ('eastern-europe','zone','HU'), ('eastern-europe','zone','MD'),
  ('eastern-europe','zone','PL'), ('eastern-europe','zone','RO'), ('eastern-europe','zone','RU'), ('eastern-europe','zone','SK'),
  ('eastern-europe','zone','UA'), ('eu','union','AT'), ('eu','union','BE'), ('eu','union','BG'),
  ('eu','union','CY'), ('eu','union','CZ'), ('eu','union','DE'), ('eu','union','DK'),
  ('eu','union','EE'), ('eu','union','ES'), ('eu','union','FI'), ('eu','union','FR'),
  ('eu','union','GR'), ('eu','union','HR'), ('eu','union','HU'), ('eu','union','IE'),
  ('eu','union','IT'), ('eu','union','LT'), ('eu','union','LU'), ('eu','union','LV'),
  ('eu','union','MT'), ('eu','union','NL'), ('eu','union','PL'), ('eu','union','PT'),
  ('eu','union','RO'), ('eu','union','SE'), ('eu','union','SI'), ('eu','union','SK'),
  ('EU','continent','AD'), ('EU','continent','AL'), ('EU','continent','AT'), ('EU','continent','AX'),
  ('EU','continent','BA'), ('EU','continent','BE'), ('EU','continent','BG'), ('EU','continent','BY'),
  ('EU','continent','CH'), ('EU','continent','CY'), ('EU','continent','CZ'), ('EU','continent','DE'),
  ('EU','continent','DK'), ('EU','continent','EE'), ('EU','continent','ES'), ('EU','continent','FI'),
  ('EU','continent','FO'), ('EU','continent','FR'), ('EU','continent','GB'), ('EU','continent','GG'),
  ('EU','continent','GI'), ('EU','continent','GR'), ('EU','continent','HR'), ('EU','continent','HU'),
  ('EU','continent','IE'), ('EU','continent','IM'), ('EU','continent','IS'), ('EU','continent','IT'),
  ('EU','continent','JE'), ('EU','continent','LI'), ('EU','continent','LT'), ('EU','continent','LU'),
  ('EU','continent','LV'), ('EU','continent','MC'), ('EU','continent','MD'), ('EU','continent','ME'),
  ('EU','continent','MK'), ('EU','continent','MT'), ('EU','continent','NL'), ('EU','continent','NO'),
  ('EU','continent','PL'), ('EU','continent','PT'), ('EU','continent','RO'), ('EU','continent','RS'),
  ('EU','continent','RU'), ('EU','continent','SE'), ('EU','continent','SI'), ('EU','continent','SJ'),
  ('EU','continent','SK'), ('EU','continent','SM'), ('EU','continent','UA'), ('EU','continent','VA'),
  ('EU','continent','XK'), ('melanesia','zone','FJ'), ('melanesia','zone','NC'), ('melanesia','zone','PG'),
  ('melanesia','zone','SB'), ('melanesia','zone','VU'), ('micronesia','zone','FM'), ('micronesia','zone','GU'),
  ('micronesia','zone','KI'), ('micronesia','zone','MH'), ('micronesia','zone','MP'), ('micronesia','zone','NR'),
  ('micronesia','zone','PW'), ('micronesia','zone','UM'), ('middle-africa','zone','AO'), ('middle-africa','zone','CD'),
  ('middle-africa','zone','CF'), ('middle-africa','zone','CG'), ('middle-africa','zone','CM'), ('middle-africa','zone','GA'),
  ('middle-africa','zone','GQ'), ('middle-africa','zone','ST'), ('middle-africa','zone','TD'), ('NA','continent','AG'),
  ('NA','continent','AI'), ('NA','continent','AW'), ('NA','continent','BB'), ('NA','continent','BL'),
  ('NA','continent','BM'), ('NA','continent','BQ'), ('NA','continent','BS'), ('NA','continent','BZ'),
  ('NA','continent','CA'), ('NA','continent','CR'), ('NA','continent','CU'), ('NA','continent','CW'),
  ('NA','continent','DM'), ('NA','continent','DO'), ('NA','continent','GD'), ('NA','continent','GL'),
  ('NA','continent','GP'), ('NA','continent','GT'), ('NA','continent','HN'), ('NA','continent','HT'),
  ('NA','continent','JM'), ('NA','continent','KN'), ('NA','continent','KY'), ('NA','continent','LC'),
  ('NA','continent','MF'), ('NA','continent','MQ'), ('NA','continent','MS'), ('NA','continent','MX'),
  ('NA','continent','NI'), ('NA','continent','PA'), ('NA','continent','PM'), ('NA','continent','PR'),
  ('NA','continent','SV'), ('NA','continent','SX'), ('NA','continent','TC'), ('NA','continent','TT'),
  ('NA','continent','US'), ('NA','continent','VC'), ('NA','continent','VG'), ('NA','continent','VI'),
  ('northern-africa','zone','DZ'), ('northern-africa','zone','EG'), ('northern-africa','zone','EH'), ('northern-africa','zone','LY'),
  ('northern-africa','zone','MA'), ('northern-africa','zone','SD'), ('northern-africa','zone','TN'), ('northern-america','zone','BM'),
  ('northern-america','zone','CA'), ('northern-america','zone','GL'), ('northern-america','zone','PM'), ('northern-america','zone','US'),
  ('northern-europe','zone','AX'), ('northern-europe','zone','DK'), ('northern-europe','zone','EE'), ('northern-europe','zone','FI'),
  ('northern-europe','zone','FO'), ('northern-europe','zone','GB'), ('northern-europe','zone','GG'), ('northern-europe','zone','IE'),
  ('northern-europe','zone','IM'), ('northern-europe','zone','IS'), ('northern-europe','zone','JE'), ('northern-europe','zone','LT'),
  ('northern-europe','zone','LV'), ('northern-europe','zone','NO'), ('northern-europe','zone','SE'), ('northern-europe','zone','SJ'),
  ('OC','continent','AS'), ('OC','continent','AU'), ('OC','continent','CK'), ('OC','continent','FJ'),
  ('OC','continent','FM'), ('OC','continent','GU'), ('OC','continent','KI'), ('OC','continent','MH'),
  ('OC','continent','MP'), ('OC','continent','NC'), ('OC','continent','NF'), ('OC','continent','NR'),
  ('OC','continent','NU'), ('OC','continent','NZ'), ('OC','continent','PF'), ('OC','continent','PG'),
  ('OC','continent','PN'), ('OC','continent','PW'), ('OC','continent','SB'), ('OC','continent','TK'),
  ('OC','continent','TO'), ('OC','continent','TV'), ('OC','continent','UM'), ('OC','continent','VU'),
  ('OC','continent','WF'), ('OC','continent','WS'), ('polynesia','zone','AS'), ('polynesia','zone','CK'),
  ('polynesia','zone','NU'), ('polynesia','zone','PF'), ('polynesia','zone','PN'), ('polynesia','zone','TK'),
  ('polynesia','zone','TO'), ('polynesia','zone','TV'), ('polynesia','zone','WF'), ('polynesia','zone','WS'),
  ('SA','continent','AR'), ('SA','continent','BO'), ('SA','continent','BR'), ('SA','continent','CL'),
  ('SA','continent','CO'), ('SA','continent','EC'), ('SA','continent','FK'), ('SA','continent','GF'),
  ('SA','continent','GY'), ('SA','continent','PE'), ('SA','continent','PY'), ('SA','continent','SR'),
  ('SA','continent','UY'), ('SA','continent','VE'), ('schengen','union','AT'), ('schengen','union','BE'),
  ('schengen','union','BG'), ('schengen','union','CH'), ('schengen','union','CZ'), ('schengen','union','DE'),
  ('schengen','union','DK'), ('schengen','union','EE'), ('schengen','union','ES'), ('schengen','union','FI'),
  ('schengen','union','FR'), ('schengen','union','GR'), ('schengen','union','HR'), ('schengen','union','HU'),
  ('schengen','union','IS'), ('schengen','union','IT'), ('schengen','union','LI'), ('schengen','union','LT'),
  ('schengen','union','LU'), ('schengen','union','LV'), ('schengen','union','MT'), ('schengen','union','NL'),
  ('schengen','union','NO'), ('schengen','union','PL'), ('schengen','union','PT'), ('schengen','union','RO'),
  ('schengen','union','SE'), ('schengen','union','SI'), ('schengen','union','SK'), ('south-america','zone','AR'),
  ('south-america','zone','BO'), ('south-america','zone','BR'), ('south-america','zone','CL'), ('south-america','zone','CO'),
  ('south-america','zone','EC'), ('south-america','zone','FK'), ('south-america','zone','GF'), ('south-america','zone','GY'),
  ('south-america','zone','PE'), ('south-america','zone','PY'), ('south-america','zone','SR'), ('south-america','zone','UY'),
  ('south-america','zone','VE'), ('south-eastern-asia','zone','BN'), ('south-eastern-asia','zone','ID'), ('south-eastern-asia','zone','KH'),
  ('south-eastern-asia','zone','LA'), ('south-eastern-asia','zone','MM'), ('south-eastern-asia','zone','MY'), ('south-eastern-asia','zone','PH'),
  ('south-eastern-asia','zone','SG'), ('south-eastern-asia','zone','TH'), ('south-eastern-asia','zone','TL'), ('south-eastern-asia','zone','VN'),
  ('southern-africa','zone','BW'), ('southern-africa','zone','LS'), ('southern-africa','zone','NA'), ('southern-africa','zone','SZ'),
  ('southern-africa','zone','ZA'), ('southern-asia','zone','AF'), ('southern-asia','zone','BD'), ('southern-asia','zone','BT'),
  ('southern-asia','zone','IN'), ('southern-asia','zone','IO'), ('southern-asia','zone','IR'), ('southern-asia','zone','LK'),
  ('southern-asia','zone','MV'), ('southern-asia','zone','NP'), ('southern-asia','zone','PK'), ('southern-europe','zone','AD'),
  ('southern-europe','zone','AL'), ('southern-europe','zone','BA'), ('southern-europe','zone','ES'), ('southern-europe','zone','GI'),
  ('southern-europe','zone','GR'), ('southern-europe','zone','HR'), ('southern-europe','zone','IT'), ('southern-europe','zone','ME'),
  ('southern-europe','zone','MK'), ('southern-europe','zone','MT'), ('southern-europe','zone','PT'), ('southern-europe','zone','RS'),
  ('southern-europe','zone','SI'), ('southern-europe','zone','SM'), ('southern-europe','zone','VA'), ('southern-europe','zone','XK'),
  ('western-africa','zone','BF'), ('western-africa','zone','BJ'), ('western-africa','zone','CI'), ('western-africa','zone','CV'),
  ('western-africa','zone','GH'), ('western-africa','zone','GM'), ('western-africa','zone','GN'), ('western-africa','zone','GW'),
  ('western-africa','zone','LR'), ('western-africa','zone','ML'), ('western-africa','zone','MR'), ('western-africa','zone','NE'),
  ('western-africa','zone','NG'), ('western-africa','zone','SH'), ('western-africa','zone','SL'), ('western-africa','zone','SN'),
  ('western-africa','zone','TG'), ('western-asia','zone','AE'), ('western-asia','zone','AM'), ('western-asia','zone','AZ'),
  ('western-asia','zone','BH'), ('western-asia','zone','CY'), ('western-asia','zone','GE'), ('western-asia','zone','IL'),
  ('western-asia','zone','IQ'), ('western-asia','zone','JO'), ('western-asia','zone','KW'), ('western-asia','zone','LB'),
  ('western-asia','zone','OM'), ('western-asia','zone','PS'), ('western-asia','zone','QA'), ('western-asia','zone','SA'),
  ('western-asia','zone','SY'), ('western-asia','zone','TR'), ('western-asia','zone','YE'), ('western-europe','zone','AT'),
  ('western-europe','zone','BE'), ('western-europe','zone','CH'), ('western-europe','zone','DE'), ('western-europe','zone','FR'),
  ('western-europe','zone','LI'), ('western-europe','zone','LU'), ('western-europe','zone','MC'), ('western-europe','zone','NL')
on conflict (group_code, country_code) do update set kind = excluded.kind;

alter table public.country_groups enable row level security;
revoke all on table public.country_groups from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Where reporting is closed.
--
-- The page asks for this list once and refuses a pin there with a plain
-- message. That is the courtesy; THIS is the rule — the page can be bypassed
-- and the insert policy below cannot.
--
-- The honest limit: a report carries the country its reporter's browser was
-- told it was in, so the check is only as good as that. Hence the second
-- clause in reporting_allowed — while any block is in force, a report with no
-- country at all is refused, because "I could not tell you where this is" is
-- exactly what a bypass would say. With nothing blocked, nothing changes.
-- ---------------------------------------------------------------------------
create or replace function public.blocked_countries()
returns text[] language sql stable security definer set search_path = public as $$
  with setting as (
    select coalesce(value, '{}'::jsonb) as value
      from public.app_settings where key = 'blocked_regions'
  )
  select coalesce(array(
    select jsonb_array_elements_text(
      coalesce((select value->'countries' from setting), '[]'::jsonb))
    union
    select g.country_code
      from public.country_groups g
     where g.group_code in (
       select jsonb_array_elements_text(
         coalesce((select value->'groups' from setting), '[]'::jsonb)))
  ), '{}'::text[]);
$$;

grant execute on function public.blocked_countries() to anon, authenticated;

create or replace function public.reporting_allowed(p_country text)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when coalesce(array_length(public.blocked_countries(), 1), 0) = 0 then true
    when p_country is null or btrim(p_country) = '' then false
    else upper(btrim(p_country)) <> all (public.blocked_countries())
  end;
$$;

grant execute on function public.reporting_allowed(text) to anon, authenticated;

-- Every handle there is, so an administrator can read the menu rather than
-- guess at it. Admin-only, like the table behind it.
create or replace view public.region_catalog as
  select group_code, kind, count(*)::int as countries,
         string_agg(country_code, ' ' order by country_code) as members
    from public.country_groups
   group by group_code, kind;

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

-- The name somebody is given on sign-up.
--
-- The local part of an email address is a poor nickname and for a Google
-- account it is a needless one: Google sends the name on the account, and a
-- member called "Ana Beltran" is far easier to find than one called "ab1992"
-- when you are trying to give her a badge. Whichever provider is used, this
-- takes the best name offered and falls back to the address only when there
-- is nothing else.
--
-- The name is a default, not a decision: it is editable in account settings,
-- and it is not published anywhere unless the member switches on `listed`.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(
            nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
            nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
            nullif(btrim(new.raw_user_meta_data ->> 'preferred_username'), ''),
            split_part(coalesce(new.email, 'member'), '@', 1)))
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

  -- The habitable band. Nobody is pickpocketed on the Antarctic ice, and a
  -- report there is a mis-tap or somebody playing. 60°S is the Antarctic
  -- Treaty line — Puerto Williams, the southernmost town on Earth, is at 55°S
  -- — and 84°N is past the northern tip of Greenland, so Svalbard, Tromsø and
  -- Murmansk stay inside it. The page checks this too; this is the one that
  -- holds, because the page can be bypassed and a table cannot.
  --
  -- Water is NOT checked here: knowing a point is in the Seine rather than on
  -- the bridge over it needs coastlines, which is a geocoder's job. The page
  -- asks one. See describePoint in js/geo.js.
  lat           double precision not null check (lat between -60 and 84),
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

create index if not exists reports_happened_idx on public.reports (happened_at desc);
create index if not exists reports_lat_idx      on public.reports (lat);
create index if not exists reports_lng_idx      on public.reports (lng);
create index if not exists reports_status_idx   on public.reports (status);
create index if not exists reports_reporter_idx on public.reports (reporter_id);

-- Existing installs: the same band, applied to a table that is already there.
-- Wrapped because a single stray row must not stop the rest of the schema from
-- being applied; the warning says what happened and nothing is lost.
do $$
begin
  alter table public.reports drop constraint if exists reports_lat_habitable;
  alter table public.reports add constraint reports_lat_habitable
    check (lat between -60 and 84);
exception when check_violation then
  raise warning 'reports exist outside 60S-84N; latitude constraint not applied';
end $$;

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
    and public.reporting_allowed(country_code)
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

-- The reports you have confirmed, however old they are.
--
-- reports_feed cannot answer this. Its WHERE clause keeps somebody else's
-- report only while it is inside the week, so a report you confirmed nine days
-- ago drops out of the view — while the row in report_supports stays forever.
-- That is why the profile could say "2 you have confirmed" and then list none
-- of them: the counter was reading the supports and the list was reading the
-- feed, and the two were answering different questions.
--
-- A function rather than widening the view, because this is a different
-- question with a different rule. The view says what is CURRENT; this says
-- what YOU vouched for. Widening the view would have let every member read
-- any aged-out report they had once tapped, through every query that uses it.
--
-- SECURITY DEFINER, so it needs no grants on reports, and scoped to auth.uid()
-- on the inside: the caller cannot ask for anybody else's confirmations.
-- reporter_id is dropped here exactly as the view drops it.
drop function if exists public.my_confirmed_reports();
create or replace function public.my_confirmed_reports()
returns table (
  id uuid, category text, impacts text[], headline text, description text,
  lat double precision, lng double precision, address text, city text,
  country_code char(2), happened_at timestamptz, created_at timestamptz,
  support_count int, flag_count int, is_mine boolean
) language sql security definer set search_path = public stable as $$
  select r.id, r.category, r.impacts, r.headline, r.description,
         r.lat, r.lng, r.address, r.city, r.country_code,
         r.happened_at, r.created_at,
         r.support_count, r.flag_count,
         (r.reporter_id = auth.uid()) as is_mine
    from public.reports r
    join public.report_supports s on s.report_id = r.id
   where s.user_id = auth.uid()
     and r.status = 'published'
   order by r.happened_at desc;
$$;

revoke all on function public.my_confirmed_reports() from anon;
grant execute on function public.my_confirmed_reports() to authenticated;

-- How many of them there are, counted over EXACTLY the rows the list returns.
--
-- The tile used to count report_supports directly, which includes supports on
-- reports that have since been removed — so the number could be larger than
-- the list by rows nobody can show. Counting the same join closes that off by
-- construction rather than by anyone remembering to keep two queries in step.
drop function if exists public.my_confirmation_count();
create or replace function public.my_confirmation_count()
returns int language sql security definer set search_path = public stable as $$
  select count(*)::int
    from public.report_supports s
    join public.reports r on r.id = s.report_id
   where s.user_id = auth.uid()
     and r.status = 'published';
$$;

revoke all on function public.my_confirmation_count() from anon;
grant execute on function public.my_confirmation_count() to authenticated;

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
-- Both tables are created back where they are described, further down. Only
-- their definitions moved up here, because this file has to be runnable
-- top-to-bottom on an EMPTY database and my_confirmed_reports() — a few
-- hundred lines below — selects from report_supports. Postgres resolves the
-- tables a SQL function names when the function is created, so on a brand new
-- database that function failed and took the rest of the file with it. It has
-- never been noticed because the live database was built up a change at a
-- time, and the tables were already there every time since.
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
-- What a member has put in: a level, and sometimes a badge.
--
-- TEN LEVELS, NOT A HUNDRED. A hundred was the other option and it is the
-- wrong shape for this site. A level ladder only works while the next rung is
-- in sight, and here the realistic distribution is steep: most members file
-- one or two reports ever, a handful file dozens. Spread over a hundred rungs
-- that puts almost everybody on level 1 or 2 forever, with a progress bar that
-- never visibly moves and ninety rungs nobody will ever stand on — a ladder
-- whose top is unreachable demotivates rather than the reverse. Ten rungs,
-- with the top one a real achievement and the first few reachable in an
-- afternoon, is the version where the bar moves.
--
-- The numbers live in a table rather than in code so they can be retuned
-- against what people actually do, without a deploy. The NAMES do not live
-- here: they are in js/locales, because this site is read in nine languages
-- and a rank written in English in a database row is a rank eight of them
-- cannot read.
-- ---------------------------------------------------------------------------
create table if not exists public.contributor_levels (
  level      int primary key check (level between 1 and 100),
  min_points int not null check (min_points >= 0)
);

insert into public.contributor_levels (level, min_points) values
  (1, 0), (2, 10), (3, 25), (4, 50), (5, 90),
  (6, 150), (7, 230), (8, 330), (9, 450), (10, 600)
on conflict (level) do nothing;

alter table public.contributor_levels enable row level security;
drop policy if exists "the ladder is public" on public.contributor_levels;
create policy "the ladder is public" on public.contributor_levels
  for select to anon, authenticated using (true);

-- The weights. Tunable for the same reason the thresholds are.
insert into public.app_settings (key, value, note) values
  ('points_per_report',       '5', 'Points for filing a report that is still published.'),
  ('points_per_confirmation', '4', 'Points for each confirmation one of your reports receives.'),
  ('points_per_given',        '1', 'Points for confirming somebody else''s report.')
on conflict (key) do nothing;

-- Just the three point weights, for the page that explains them.
--
-- A function rather than a read of app_settings, which is revoked from both
-- browser roles and should stay that way: it also holds which regions are
-- closed to reporting and what the auto-hide threshold is, neither of which is
-- a visitor's business. What a report is worth is.
create or replace function public.point_weights()
returns table (report int, confirmation int, given int)
language sql stable security definer set search_path = public as $$
  select public.setting_int('points_per_report', 5),
         public.setting_int('points_per_confirmation', 4),
         public.setting_int('points_per_given', 1);
$$;

grant execute on function public.point_weights() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Points.
--
-- NOT A COUNT OF REPORTS, and that is the whole design. Level by volume alone
-- rewards filing, and the cheapest way to file more is to file worse — which
-- on a map people use to decide where to walk is the one failure that matters.
-- So the heaviest single thing a member can earn is somebody else recognising
-- what they reported: a report nobody confirms is worth 5, the same report
-- with three confirmations is worth 17. Confirming other people's reports is
-- worth a little, because reading the map carefully and saying "this happened
-- to me too" is a real contribution and the one that makes the rest useful.
--
-- Lifetime, not windowed. A report that has aged off the map was still filed,
-- and taking somebody's level away a week later because the world moved on
-- would be a strange thing to do. Withdrawing a report DOES take its points
-- back, because withdrawing deletes it — which is the right way round.
--
-- Counted on demand rather than kept in a column. It is two indexed counts
-- against reports and report_supports, it is read when somebody opens their
-- own profile, and a stored counter is a thing that goes wrong quietly.
-- ---------------------------------------------------------------------------
create or replace function public.contribution_points(p_user uuid)
returns int language sql stable security definer set search_path = public as $$
  select coalesce((
           select count(*)::int * public.setting_int('points_per_report', 5)
             from public.reports r
            where r.reporter_id = p_user
              and r.status = 'published'
         ), 0)
       -- Counted from report_supports rather than from reports.support_count,
       -- so that a confirmation by the report's own author is worth nothing on
       -- EITHER side of the exchange. The insert policy on report_supports
       -- already refuses a self-confirmation, so through the site this is the
       -- same number; it is written this way so that the two legs below agree
       -- about what does not count, whatever is seeded past RLS or changed in
       -- that policy later.
       + coalesce((
           select count(*)::int * public.setting_int('points_per_confirmation', 4)
             from public.report_supports s
             join public.reports r on r.id = s.report_id
            where r.reporter_id = p_user
              and r.status = 'published'
              and s.user_id is distinct from p_user
         ), 0)
       + coalesce((
           select count(*)::int * public.setting_int('points_per_given', 1)
             from public.report_supports s
             join public.reports r on r.id = s.report_id
            where s.user_id = p_user
              and r.status = 'published'
              and r.reporter_id is distinct from p_user
         ), 0);
$$;

create or replace function public.level_for(p_points int)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(max(level), 1)
    from public.contributor_levels
   where min_points <= greatest(coalesce(p_points, 0), 0);
$$;

-- ---------------------------------------------------------------------------
-- Roles, and a level set by hand.
--
-- Three roles. `moderator` is defined here and granted nothing yet — it is in
-- the constraint so that giving it meaning later is a policy change rather
-- than a migration, and so the admin page can hand it out before it does
-- anything. `admin` is the one with teeth.
--
-- WHAT AN ADMIN CANNOT DO FROM A BROWSER, and this is a property of the
-- architecture rather than an omission: create an account. That needs
-- Supabase's admin API and the secret key, and the secret key cannot be in a
-- page served to the public — it bypasses every rule in this file. Anyone can
-- sign up on their own, so an "add user" button would only be a way of doing
-- what they can already do; the admin page says so rather than offering a
-- button that cannot work.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists role text not null default 'member';
alter table public.profiles drop constraint if exists profiles_role_known;
alter table public.profiles add constraint profiles_role_known
  check (role in ('member', 'moderator', 'admin'));

-- A level given rather than earned. Null means the arithmetic decides, which
-- is the normal case; a number here wins over it. For the people whose
-- contribution the points cannot see — the same reason badges exist.
alter table public.profiles add column if not exists level_override int;
alter table public.profiles drop constraint if exists profiles_level_override_range;
alter table public.profiles add constraint profiles_level_override_range
  check (level_override is null or level_override between 1 and 100);

create index if not exists profiles_role_idx on public.profiles (role) where role <> 'member';

-- Whether somebody is an admin.
--
-- SECURITY DEFINER because every policy and every admin function below has to
-- ask, and a member can only read their OWN profile row — so a plain select
-- here would answer "no" for everybody but yourself and quietly lock the admin
-- page to one person.
create or replace function public.is_admin(p_user uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p where p.id = p_user and p.role = 'admin'
  );
$$;

grant execute on function public.is_admin(uuid) to authenticated;

-- The level somebody is actually on: the one given, or the one earned.
create or replace function public.member_level(p_user uuid)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.level_override from public.profiles p where p.id = p_user),
    public.level_for(public.contribution_points(p_user)));
$$;

-- ---------------------------------------------------------------------------
-- Badges, for the people this does not measure.
--
-- Points describe one kind of contribution — reports filed and recognised.
-- They say nothing about somebody who makes videos about street scams and
-- sends their audience here, and that person may be the most useful
-- contributor on the site while never filing a single report. A badge is the
-- answer to that: granted by hand, by the people who run this, for a reason
-- written down beside it.
--
-- A table rather than a column on profiles, because these are not exclusive:
-- the creator who films scams in Barcelona is often also a top contributor,
-- and a column would make us choose which of the two to hide.
-- ---------------------------------------------------------------------------
create table if not exists public.contributor_badges (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  badge      text not null check (badge in ('creator', 'top', 'founder', 'partner')),
  -- Why this person has it, in your words. Never shown on the page; it is
  -- there so that in a year you can still tell what you were recognising.
  note       text,
  granted_at timestamptz not null default now(),
  primary key (profile_id, badge)
);

alter table public.contributor_badges enable row level security;
-- No policy at all: nothing reads this table directly. The page sees badges
-- through my_standing() and contributors_board(), both of which decide what a
-- reader is allowed to know, and granting goes through grant_badge().
revoke all on table public.contributor_badges from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Being listed is opt-in.
--
-- display_name is set for you on sign-up from the local part of your email,
-- so for most members it is something they never chose and often their real
-- name. Publishing that on a contributors board because they filed a report
-- would be taking a decision that is theirs. The board shows members who
-- switched this on, and nobody else.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists listed boolean not null default false;

-- Finding somebody by the name they go by, which is what granting a badge
-- starts with. Case-insensitive, because nobody remembers the capitals.
create index if not exists profiles_display_name_idx
  on public.profiles (lower(display_name));

-- ---------------------------------------------------------------------------
-- Your own standing: points, level, and how far to the next one.
--
-- One call rather than four, and SECURITY DEFINER because it reads other
-- people's support rows to count what yours received.
-- ---------------------------------------------------------------------------
-- The output columns changed — role and given_level were added — and Postgres
-- will not replace a function's return type in place. Dropped first, which on
-- a live database is the difference between a schema that applies and one that
-- stops here.
drop function if exists public.my_standing();
create or replace function public.my_standing()
returns table (
  points int, level int, level_floor int,
  next_level int, next_points int,
  reports int, received int, given int,
  badges text[], listed boolean, role text, given_level int
)
language sql stable security definer set search_path = public as $$
  with me as (select auth.uid() as id),
  p as (select public.contribution_points((select id from me)) as points),
  -- The level SHOWN, which is the given one where there is one. The rungs
  -- below still describe the earned ladder: somebody handed level 7 has not
  -- earned 600 points, and a progress bar pretending otherwise would be a lie
  -- about their own account. The page reads given_level and drops the bar.
  lv as (select public.member_level((select id from me)) as level),
  earned as (select public.level_for((select points from p)) as level)
  select (select points from p)::int,
         (select level from lv)::int,
         (select min_points from public.contributor_levels
           where level = (select level from earned))::int,
         (select min(level) from public.contributor_levels
           where min_points > (select points from p))::int,
         (select min(min_points) from public.contributor_levels
           where min_points > (select points from p))::int,
         (select count(*)::int from public.reports r
           where r.reporter_id = (select id from me) and r.status = 'published'),
         (select count(*)::int from public.report_supports s
             join public.reports r on r.id = s.report_id
            where r.reporter_id = (select id from me)
              and r.status = 'published'
              and s.user_id is distinct from (select id from me)),
         (select count(*)::int from public.report_supports s
             join public.reports r on r.id = s.report_id
            where s.user_id = (select id from me)
              and r.status = 'published'
              and r.reporter_id is distinct from (select id from me)),
         (select coalesce(array_agg(b.badge order by b.granted_at), '{}')
            from public.contributor_badges b where b.profile_id = (select id from me)),
         coalesce((select pr.listed from public.profiles pr
                    where pr.id = (select id from me)), false),
         coalesce((select pr.role from public.profiles pr
                    where pr.id = (select id from me)), 'member'),
         (select pr.level_override from public.profiles pr
           where pr.id = (select id from me))
   where (select id from me) is not null;
$$;

revoke all on function public.my_standing() from public, anon;
grant execute on function public.my_standing() to authenticated;

-- ---------------------------------------------------------------------------
-- The contributors board.
--
-- Members only, and only members who asked to be on it. No geography and no
-- report of anybody's is named here, which matters: reports_feed drops
-- reporter_id so that whoever reported a scam stays anonymous, and a board
-- that said "Ana — 4 reports in Seville" would hand back exactly what that
-- view exists to withhold. A name, a level, a badge and a number. Nothing
-- that points at a pin.
-- ---------------------------------------------------------------------------
create or replace function public.contributors_board(p_limit int default 20)
returns table (display_name text, level int, points int, badges text[])
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim(p.display_name), ''), 'Member'),
         public.member_level(p.id),
         public.contribution_points(p.id),
         coalesce((select array_agg(b.badge order by b.granted_at)
                     from public.contributor_badges b where b.profile_id = p.id), '{}')
    from public.profiles p
   where p.listed
   order by 3 desc, p.created_at
   limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

revoke all on function public.contributors_board(int) from public, anon;
grant execute on function public.contributors_board(int) to authenticated;

-- ---------------------------------------------------------------------------
-- The dashboard: everyone, with their level and their badges.
--
-- For the Supabase table editor and SQL editor, which connect as the service
-- role — so this is the one place emails appear beside levels, and it is
-- revoked from both browser roles. Do NOT select from this in a script that
-- runs in GitHub Actions: those logs are public, and this view's whole point
-- is that it joins names to addresses. supabase/ops/contributors.sql is the
-- version that is safe to run there.
-- ---------------------------------------------------------------------------
drop view if exists public.admin_contributors;
create or replace view public.admin_contributors as
  select p.id,
         p.display_name,
         u.email,
         p.role,
         public.member_level(p.id)                          as level,
         public.contribution_points(p.id)                   as points,
         coalesce((select array_agg(b.badge order by b.granted_at)
                     from public.contributor_badges b where b.profile_id = p.id), '{}') as badges,
         (select count(*) from public.reports r
           where r.reporter_id = p.id and r.status = 'published')          as reports,
         (select count(*) from public.report_supports s
             join public.reports r on r.id = s.report_id
            where r.reporter_id = p.id and r.status = 'published'
              and s.user_id is distinct from p.id)                         as confirmations_received,
         p.listed,
         p.created_at
    from public.profiles p
    left join auth.users u on u.id = p.id;

revoke all on public.admin_contributors from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The admin page's own calls.
--
-- Every one of them asks the database whether the caller is an admin, and the
-- answer does not come from the page. A page can be edited in a console; this
-- cannot. Hiding the controls is politeness, the check is the security.
-- ---------------------------------------------------------------------------
create or replace function public.admin_required()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;
  if not public.is_admin(auth.uid()) then
    raise exception 'admins only';
  end if;
end;
$$;

create or replace function public.admin_members(
  p_search text default null,
  p_limit  int  default 100
)
returns table (
  id uuid, display_name text, email text, role text,
  level int, level_override int, points int,
  reports int, badges text[], listed boolean, created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_required();
  return query
    select p.id,
           p.display_name,
           -- Cast, because auth.users.email is varchar(255) and this function
           -- declares text. plpgsql will not widen one to the other on its own:
           -- it raises "structure of query does not match function result type",
           -- which is how the Members screen came back empty on the live site
           -- while every local test passed against a shim that said text.
           u.email::text,
           p.role,
           public.member_level(p.id),
           p.level_override,
           public.contribution_points(p.id),
           (select count(*)::int from public.reports r
             where r.reporter_id = p.id and r.status = 'published'),
           coalesce((select array_agg(b.badge order by b.granted_at)
                       from public.contributor_badges b where b.profile_id = p.id), '{}'),
           p.listed,
           p.created_at
      from public.profiles p
      left join auth.users u on u.id = p.id
     where p_search is null
        or btrim(p_search) = ''
        or p.display_name ilike '%' || btrim(p_search) || '%'
        or u.email        ilike '%' || btrim(p_search) || '%'
     order by public.contribution_points(p.id) desc, p.created_at
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

-- How many admins there would be left. Used by both of the calls that can
-- remove one, because locking yourself out of your own admin page is a
-- mistake nobody makes twice and everybody makes once.
create or replace function public.other_admins(p_except uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.profiles p
   where p.role = 'admin' and p.id is distinct from p_except;
$$;

create or replace function public.admin_set_role(p_id uuid, p_role text)
returns text language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_required();
  if p_role not in ('member', 'moderator', 'admin') then
    raise exception 'no such role: %', p_role;
  end if;
  if not exists (select 1 from public.profiles where id = p_id) then
    raise exception 'no such member';
  end if;
  -- Taking admin away from the last admin leaves a site nobody can administer,
  -- and the only way back is the SQL editor. Refused, including when it is
  -- yourself doing it to yourself.
  if p_role <> 'admin'
     and exists (select 1 from public.profiles where id = p_id and role = 'admin')
     and public.other_admins(p_id) = 0 then
    raise exception 'that is the last admin — make somebody else an admin first';
  end if;
  update public.profiles set role = p_role where id = p_id;
  return p_role;
end;
$$;

create or replace function public.admin_set_level(p_id uuid, p_level int)
returns int language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_required();
  if p_level is not null and not exists
       (select 1 from public.contributor_levels where level = p_level) then
    raise exception 'there is no level %', p_level;
  end if;
  update public.profiles set level_override = p_level where id = p_id;
  if not found then raise exception 'no such member'; end if;
  return public.member_level(p_id);
end;
$$;

create or replace function public.admin_set_badge(
  p_id uuid, p_badge text, p_on boolean, p_note text default null
)
returns text[] language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_required();
  if p_on then
    insert into public.contributor_badges (profile_id, badge, note)
    values (p_id, p_badge, p_note)
    on conflict (profile_id, badge)
      do update set note = coalesce(excluded.note, public.contributor_badges.note);
  else
    delete from public.contributor_badges b
     where b.profile_id = p_id and b.badge = p_badge;
  end if;
  return coalesce((select array_agg(b.badge order by b.granted_at)
                     from public.contributor_badges b where b.profile_id = p_id), '{}');
end;
$$;

create or replace function public.admin_set_listed(p_id uuid, p_listed boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_required();
  update public.profiles set listed = coalesce(p_listed, false) where id = p_id;
  if not found then raise exception 'no such member'; end if;
  return coalesce(p_listed, false);
end;
$$;

-- Removing somebody. Their reports go with them, which is what account
-- deletion already does for a member removing themselves — the difference is
-- only who asked.
create or replace function public.admin_remove_member(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_required();
  if p_id = auth.uid() then
    raise exception 'use Account settings to close your own account';
  end if;
  if exists (select 1 from public.profiles where id = p_id and role = 'admin')
     and public.other_admins(p_id) = 0 then
    raise exception 'that is the last admin — make somebody else an admin first';
  end if;
  if not exists (select 1 from public.profiles where id = p_id) then
    raise exception 'no such member';
  end if;
  delete from public.reports where reporter_id = p_id;
  delete from auth.users where id = p_id;   -- profiles cascades from here
  return true;
end;
$$;

-- These are reachable from a browser, by a signed-in member, and every one of
-- them refuses anybody who is not an admin. That refusal is the whole of the
-- security — the page hiding its own buttons is only good manners.
revoke all on function public.admin_members(text, int) from public, anon;
revoke all on function public.admin_set_role(uuid, text) from public, anon;
revoke all on function public.admin_set_level(uuid, int) from public, anon;
revoke all on function public.admin_set_badge(uuid, text, boolean, text) from public, anon;
revoke all on function public.admin_set_listed(uuid, boolean) from public, anon;
revoke all on function public.admin_remove_member(uuid) from public, anon;
grant execute on function public.admin_members(text, int) to authenticated;
grant execute on function public.admin_set_role(uuid, text) to authenticated;
grant execute on function public.admin_set_level(uuid, int) to authenticated;
grant execute on function public.admin_set_badge(uuid, text, boolean, text) to authenticated;
grant execute on function public.admin_set_listed(uuid, boolean) to authenticated;
grant execute on function public.admin_remove_member(uuid) to authenticated;
-- admin_required and other_admins are called by the functions above while they
-- run as the definer, so they need no grant of their own.
revoke all on function public.admin_required() from public, anon, authenticated;
revoke all on function public.other_admins(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The rest of the admin console: reports, the ladder, the regions, the
-- settings.
--
-- One rule throughout, the same as the member calls above: every function
-- starts with admin_required(), so the page is never what decides. A browser
-- can be edited; this cannot.
--
-- These are deliberately NOT a generic "run SQL from the page" tool. A table
-- editor that can run anything is the Supabase dashboard, which exists, is
-- behind a real login, and is not served to the public. What is here is the
-- handful of things somebody running this site actually does, each with its
-- own validation — a ladder that must stay ascending, a status that must be
-- one of three, a setting that must be one of a known list.
-- ---------------------------------------------------------------------------

-- --- Reports ---------------------------------------------------------------
--
-- An admin sees every report, including the ones the map hides: aged out,
-- flagged into review, or removed. And the reporter's nickname with it, which
-- reports_feed deliberately withholds from everybody else — moderation is the
-- one job that cannot be done without it, because the thing you are usually
-- looking at is not one bad report but six from one account.
create or replace function public.admin_reports(
  p_filter text default 'flagged',
  p_search text default null,
  p_limit  int  default 100
)
returns table (
  id uuid, category text, headline text, description text,
  city text, country_code char(2), lat double precision, lng double precision,
  happened_at timestamptz, created_at timestamptz,
  status text, support_count int, flag_count int,
  reporter_id uuid, reporter text, reasons text[], on_the_map boolean
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_required();
  return query
    select r.id, r.category, r.headline, r.description,
           r.city, r.country_code, r.lat, r.lng,
           r.happened_at, r.created_at,
           r.status, r.support_count, r.flag_count,
           r.reporter_id,
           coalesce(nullif(btrim(p.display_name), ''), '(deleted account)'),
           coalesce((select array_agg(distinct f.reason order by f.reason)
                       from public.report_flags f where f.report_id = r.id), '{}'),
           (r.status = 'published' and r.happened_at > now() - public.report_window())
      from public.reports r
      left join public.profiles p on p.id = r.reporter_id
     where case p_filter
             -- Flagged means "flagged and still waiting on a decision". A
             -- report already taken down has had one, and leaving it here
             -- means a queue that never empties and so stops being read.
             when 'flagged'      then r.flag_count > 0 and r.status <> 'removed'
             when 'under_review' then r.status = 'under_review'
             when 'removed'      then r.status = 'removed'
             when 'published'    then r.status = 'published'
             else true
           end
       and (p_search is null or btrim(p_search) = ''
            or r.headline ilike '%' || btrim(p_search) || '%'
            or r.city     ilike '%' || btrim(p_search) || '%'
            or p.display_name ilike '%' || btrim(p_search) || '%')
     order by r.flag_count desc, r.happened_at desc
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

-- Approve, hide, or take down. Three statuses and nothing else, because the
-- check constraint on the column is the same three and a typo should fail here
-- rather than there.
--
-- Approving CLEARS the flags. Leaving them would re-hide the report the moment
-- auto_hide_flag_threshold is reached again by the same people who flagged it
-- the first time, and an admin who looked at it and said it was fine has
-- already answered that question.
create or replace function public.admin_set_report_status(p_id uuid, p_status text)
returns text language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_required();
  if p_status not in ('published', 'under_review', 'removed') then
    raise exception 'no such status: %', p_status;
  end if;
  if p_status = 'published' then
    delete from public.report_flags where report_id = p_id;
  end if;
  update public.reports set status = p_status where id = p_id;
  if not found then raise exception 'no such report'; end if;
  return p_status;
end;
$$;

-- Gone for good, rather than hidden. For a report that should never have been
-- filed — somebody's address, somebody's name — where "removed" still leaves
-- it in the table.
create or replace function public.admin_delete_report(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_required();
  delete from public.reports where id = p_id;
  if not found then raise exception 'no such report'; end if;
  return true;
end;
$$;

-- --- The ladder ------------------------------------------------------------
--
-- Replaced whole rather than edited row by row. A ladder is only valid as a
-- set — ascending, starting at level 1, no two rungs at the same height — and
-- editing it one row at a time means passing through states that are none of
-- those. The page sends the table it wants; this takes it or refuses it.
create or replace function public.admin_set_levels(p_rows jsonb)
returns table (level int, min_points int)
language plpgsql security definer set search_path = public as $$
declare
  wanted record;
  seen   int := -1;
  count_ int := 0;
begin
  perform public.admin_required();

  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'the ladder needs at least one rung';
  end if;

  for wanted in
    select (row ->> 'level')::int as lv, (row ->> 'min_points')::int as pts
      from jsonb_array_elements(p_rows) as row
     order by (row ->> 'level')::int
  loop
    count_ := count_ + 1;
    if count_ = 1 and wanted.lv <> 1 then
      raise exception 'the ladder has to start at level 1';
    end if;
    if count_ = 1 and wanted.pts <> 0 then
      raise exception 'level 1 is where everybody starts, so it is 0 points';
    end if;
    if wanted.lv < 1 or wanted.lv > 100 then
      raise exception 'level % is outside 1..100', wanted.lv;
    end if;
    if wanted.pts <= seen and count_ > 1 then
      raise exception 'level % asks for % points, which is not more than the rung below it',
        wanted.lv, wanted.pts;
    end if;
    seen := wanted.pts;
  end loop;

  delete from public.contributor_levels;
  insert into public.contributor_levels (level, min_points)
  select (row ->> 'level')::int, (row ->> 'min_points')::int
    from jsonb_array_elements(p_rows) as row;

  -- A rung that no longer exists cannot be somebody's given level.
  update public.profiles p set level_override = null
   where p.level_override is not null
     and not exists (select 1 from public.contributor_levels l
                      where l.level = p.level_override);

  return query select l.level, l.min_points
                 from public.contributor_levels l order by l.level;
end;
$$;

-- --- Regions ---------------------------------------------------------------
--
-- Which countries are closed to NEW reports. Reading is never affected:
-- everything already on the map stays visible to everyone, everywhere.
create or replace function public.admin_region_catalog()
returns table (group_code text, kind text, countries int, members text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_required();
  return query select c.group_code, c.kind, c.countries, c.members
                 from public.region_catalog c order by c.kind, c.group_code;
end;
$$;

create or replace function public.admin_blocked_regions()
returns table (countries text[], groups text[], closed int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_required();
  return query
    select coalesce(array(select jsonb_array_elements_text(
             coalesce(s.value->'countries', '[]'::jsonb))), '{}')::text[],
           coalesce(array(select jsonb_array_elements_text(
             coalesce(s.value->'groups', '[]'::jsonb))), '{}')::text[],
           coalesce(array_length(public.blocked_countries(), 1), 0)
      from public.app_settings s where s.key = 'blocked_regions';
end;
$$;

create or replace function public.admin_set_blocked_regions(
  p_countries text[], p_groups text[]
)
returns int language plpgsql security definer set search_path = public as $$
declare unknown text;
begin
  perform public.admin_required();

  -- A group handle that matches nothing closes nothing, silently, and the
  -- person who typed it believes a country is shut when it is open. Refused
  -- with the name they used, so a typo reads as a typo.
  select g into unknown from unnest(coalesce(p_groups, '{}')) as g
   where g not in (select group_code from public.country_groups) limit 1;
  if unknown is not null then
    raise exception 'there is no region called % — see the list beside this', unknown;
  end if;

  insert into public.app_settings (key, value, note)
  values ('blocked_regions',
          jsonb_build_object('countries', to_jsonb(coalesce(p_countries, '{}')),
                             'groups',    to_jsonb(coalesce(p_groups, '{}'))),
          'Where new reports are refused.')
  on conflict (key) do update set value = excluded.value;

  return coalesce(array_length(public.blocked_countries(), 1), 0);
end;
$$;

-- --- Settings --------------------------------------------------------------
--
-- The handful of numbers that change how the site behaves, by name, with what
-- they are for. A known list rather than the whole table: blocked_regions is
-- JSON and has its own screen, and a free-text editor over every row is a way
-- to put a word where an integer goes and find out at the next refresh.
create or replace function public.admin_settings()
returns table (key text, value text, note text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_required();
  return query
    select s.key, s.value #>> '{}', s.note
      from public.app_settings s
     where s.key in ('report_window_days', 'public_sample_limit',
                     'public_detail_max_span', 'auto_hide_flag_threshold',
                     'points_per_report', 'points_per_confirmation',
                     'points_per_given', 'report_move_window_hours')
     order by s.key;
end;
$$;

create or replace function public.admin_set_setting(p_key text, p_value text)
returns text language plpgsql security definer set search_path = public as $$
declare cleaned text := btrim(coalesce(p_value, ''));
begin
  perform public.admin_required();
  if p_key not in ('report_window_days', 'public_sample_limit',
                   'public_detail_max_span', 'auto_hide_flag_threshold',
                   'points_per_report', 'points_per_confirmation',
                   'points_per_given', 'report_move_window_hours') then
    raise exception 'that setting is not editable from here: %', p_key;
  end if;
  -- Every one of these is a number, and every one of them is read with ::int
  -- or ::numeric somewhere. A word here does not fail now, it fails on the
  -- next read, in a function nobody is watching.
  if cleaned !~ '^[0-9]+(\.[0-9]+)?$' then
    raise exception '% has to be a number, not %', p_key, coalesce(p_value, 'nothing');
  end if;
  update public.app_settings set value = to_jsonb(cleaned::numeric) where key = p_key;
  if not found then raise exception 'no such setting'; end if;
  return cleaned;
end;
$$;

revoke all on function public.admin_reports(text, text, int) from public, anon;
revoke all on function public.admin_set_report_status(uuid, text) from public, anon;
revoke all on function public.admin_delete_report(uuid) from public, anon;
revoke all on function public.admin_set_levels(jsonb) from public, anon;
revoke all on function public.admin_region_catalog() from public, anon;
revoke all on function public.admin_blocked_regions() from public, anon;
revoke all on function public.admin_set_blocked_regions(text[], text[]) from public, anon;
revoke all on function public.admin_settings() from public, anon;
revoke all on function public.admin_set_setting(text, text) from public, anon;
grant execute on function public.admin_reports(text, text, int) to authenticated;
grant execute on function public.admin_set_report_status(uuid, text) to authenticated;
grant execute on function public.admin_delete_report(uuid) to authenticated;
grant execute on function public.admin_set_levels(jsonb) to authenticated;
grant execute on function public.admin_region_catalog() to authenticated;
grant execute on function public.admin_blocked_regions() to authenticated;
grant execute on function public.admin_set_blocked_regions(text[], text[]) to authenticated;
grant execute on function public.admin_settings() to authenticated;
grant execute on function public.admin_set_setting(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Granting a badge, by whatever you happen to know about the person.
--
-- A nickname, an email address, or the id itself — because which of the three
-- you have depends on where you met them. Someone who emailed you is an
-- email; someone whose videos you watched is a nickname.
--
-- It REFUSES an ambiguous name rather than guessing, and says who it found.
-- display_name is not unique and cannot safely be made unique — two people
-- signing up as john@gmail.com and john@yahoo.com are both "john" through no
-- fault of their own — so the one thing this must never do is quietly badge
-- the wrong John.
--
-- GOOGLE SIGN-IN CHANGES NOTHING HERE. A Google account arrives in auth.users
-- with an email like any other, and handle_new_user below now takes the name
-- Google supplies in preference to the local part of the address — so the
-- nickname you search for is the one they are called rather than a fragment
-- of their address.
-- ---------------------------------------------------------------------------
create or replace function public.find_member(p_who text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  needle text := btrim(coalesce(p_who, ''));
  hits   uuid[];
  names  text[];
begin
  if needle = '' then
    raise exception 'give a nickname, an email address or a user id';
  end if;

  -- An id, if it looks like one. Tried first because it is the only form that
  -- cannot be ambiguous.
  begin
    return (select p.id from public.profiles p where p.id = needle::uuid);
  exception when invalid_text_representation then
    null;
  end;

  select array_agg(p.id), array_agg(coalesce(p.display_name, u.email))
    into hits, names
    from public.profiles p
    left join auth.users u on u.id = p.id
   where lower(u.email) = lower(needle)
      or lower(btrim(p.display_name)) = lower(needle);

  if hits is null or cardinality(hits) = 0 then
    raise exception 'nobody here is called %  — try the email address, or the id from admin_contributors', needle;
  end if;
  if cardinality(hits) > 1 then
    raise exception '% people answer to that (%) — use the email address or the id instead',
      cardinality(hits), array_to_string(names, ', ');
  end if;
  return hits[1];
end;
$$;

drop function if exists public.grant_badge(text, text, text, boolean);
create or replace function public.grant_badge(
  p_who   text,
  p_badge text,
  p_note  text default null,
  -- Granted to somebody who asked to be recognised, so by default it also puts
  -- them on the board. Pass false for a badge that is only for your own
  -- records.
  p_list  boolean default true
)
-- The output columns are NOT called `badge`, `id` or `display_name`, which is
-- not a style choice: a plpgsql OUT parameter shadows a column of the same name
-- everywhere in the body, so `on conflict (profile_id, badge)` below resolved
-- `badge` to the OUT parameter and the whole function failed with "column
-- reference badge is ambiguous" the first time it was ever run.
returns table (member_id uuid, goes_by text, granted text, level int, points int)
language plpgsql security definer set search_path = public as $$
declare who uuid := public.find_member(p_who);
begin
  insert into public.contributor_badges (profile_id, badge, note)
  values (who, p_badge, p_note)
  on conflict (profile_id, badge) do update set note = coalesce(excluded.note, public.contributor_badges.note);

  if p_list then
    update public.profiles set listed = true where profiles.id = who;
  end if;

  return query
    select p.id, p.display_name, p_badge,
           public.level_for(public.contribution_points(p.id)),
           public.contribution_points(p.id)
      from public.profiles p where p.id = who;
end;
$$;

create or replace function public.revoke_badge(p_who text, p_badge text)
returns int language plpgsql security definer set search_path = public as $$
declare
  who  uuid := public.find_member(p_who);
  gone int;
begin
  delete from public.contributor_badges b
   where b.profile_id = who and b.badge = p_badge;
  get diagnostics gone = row_count;
  return gone;
end;
$$;

-- Nobody in a browser runs these. They are for the SQL editor, which connects
-- as the service role and is not bound by a grant at all.
revoke all on function public.find_member(text) from public, anon, authenticated;
revoke all on function public.grant_badge(text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.revoke_badge(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- How far back a reader asked to look.
--
-- The page has a row of chips — today, 2 days, 3 days, 5 days, the whole
-- window — and for the two zoom levels where a signed-out visitor gets counts
-- rather than rows, the filtering has to happen here: a density circle is a
-- number the database computed, and there is nothing in the browser left to
-- filter.
--
-- Clamped at both ends rather than trusted. A request for 0 days would empty
-- the map and a request for 400 would ask for rows the window has already
-- retired, so anything outside 1 day .. the window is the window. Null means
-- the whole window, which is what every caller that has not been updated
-- sends.
create or replace function public.report_age_limit(p_days int)
returns interval language sql stable set search_path = public as $$
  select case
           when p_days is null then public.report_window()
           when make_interval(days => greatest(p_days, 1)) > public.report_window()
             then public.report_window()
           else make_interval(days => greatest(p_days, 1))
         end;
$$;

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
drop function if exists public.public_area_summary(double precision, double precision, double precision, double precision, int, int);
create or replace function public.public_area_summary(
  min_lat double precision, min_lng double precision,
  max_lat double precision, max_lng double precision,
  cells   int default 12,
  -- How far back the reader's chip is set. Null is the whole window.
  max_age_days int default null
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
     and r.happened_at > now() - public.report_age_limit(max_age_days)
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
drop function if exists public.public_sample_reports(double precision, double precision, double precision, double precision, int);
create or replace function public.public_sample_reports(
  min_lat double precision, min_lng double precision,
  max_lat double precision, max_lng double precision,
  -- As above. The sample is capped at five rows, so without this a reader who
  -- asked for today would be shown five reports from across the week and told
  -- the rest were hidden.
  max_age_days int default null
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
       and r.happened_at > now() - public.report_age_limit(max_age_days)
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

revoke all on function public.public_area_summary(double precision, double precision, double precision, double precision, int, int) from public;
revoke all on function public.public_sample_reports(double precision, double precision, double precision, double precision, int) from public;
grant execute on function public.public_area_summary(double precision, double precision, double precision, double precision, int, int) to anon, authenticated;
grant execute on function public.public_sample_reports(double precision, double precision, double precision, double precision, int) to anon, authenticated;
-- report_age_limit is read by both of those while they run as the definer, so
-- it needs no grant of its own; given one anyway, because a reader asking the
-- database what its own window is is not a secret.
grant execute on function public.report_age_limit(int) to anon, authenticated;

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

-- ---------------------------------------------------------------------------
-- Ongoing natural disasters, from GDACS.
--
-- Mirrored rather than read from the browser, even though GDACS allows that.
-- It sends no cache headers, so a direct fetch means every visitor's session
-- hits a public service run for emergency response; this way it is asked once
-- every few hours no matter how many people are looking. It also means a
-- disaster still shows when GDACS is having a bad day.
--
-- One row per event PER COUNTRY. A cyclone crossing a coast or a river
-- flooding two states is one event to GDACS and two answers to "is anything
-- happening where I am going", which is the only question this table exists
-- to answer.
--
-- Written only by the refresh workflow, which connects as the database owner.
-- ---------------------------------------------------------------------------
create table if not exists public.disaster_alerts (
  event_id     text    not null,          -- GDACS eventtype-eventid-episodeid
  country_code char(2) not null,
  -- Five kinds, not six. Drought was here and is gone: GDACS's droughts come
  -- from the Copernicus Global Drought Observatory and are AGRICULTURAL —
  -- "Medium impact for agricultural drought in 677277 km2", measured from soil
  -- moisture. That is a real thing to publish and not a thing a traveller can
  -- act on, and it dwarfed everything else on the map: 48 of 51 rows on the
  -- day it was removed, one event spread across twenty-six countries.
  kind         text    not null check (kind in
                 ('earthquake','cyclone','flood','volcano','wildfire')),
  -- GDACS's own grading of likely humanitarian impact: Red, Orange, Green.
  -- All three are kept. Green used to be dropped on the argument that it is
  -- the routine background of a working planet — true of a magnitude 4.7 under
  -- the sea floor, and not true of a tropical cyclone, which is a storm
  -- somebody's flight goes through whatever its humanitarian grading. Dropping
  -- it left one event on the whole map while gdacs.org showed seven storms.
  --
  -- What follows from keeping it: the page must SAY which grade, or showing
  -- seventy green wildfires implies seventy disasters. It does, on every one.
  severity     text    not null check (severity in ('severe','notice','routine')),
  name         text    not null,          -- GDACS's own words, in English
  from_date    timestamptz,
  to_date      timestamptz,
  url          text,
  -- Where GDACS puts the event. What it MEANS differs by kind: a volcano and
  -- a wildfire are at the point; a cyclone is where the storm was last
  -- placed; a flood is the centroid of everything affected,
  -- which is open water or empty country as often as not. The page draws all
  -- of them and says which in the popup, rather than implying a street.
  lat          double precision,
  lng          double precision,
  refreshed_at timestamptz not null default now(),
  primary key (event_id, country_code)
);

alter table public.disaster_alerts add column if not exists lat double precision;
alter table public.disaster_alerts add column if not exists lng double precision;

-- What GDACS measured, where it measures anything: magnitude and depth for an
-- earthquake, so the map can size a ring by one and the popup can name the
-- other. A quake 158 km down is felt far less than the same one at 10 km, and
-- a reader deciding where to go deserves to see which it was.
alter table public.disaster_alerts add column if not exists magnitude numeric(4,1);
alter table public.disaster_alerts add column if not exists depth_km  numeric(6,1);

-- GDACS's own measurement of the event, in its own words: "Magnitude 5.2M,
-- Depth:10km", "Tropical storm (maximum wind speed of 120 km/h)". It arrives in
-- severitydata.severitytext and we were throwing it away, keeping only the two
-- numbers we could parse out of it for earthquakes.
--
-- Stored verbatim and shown verbatim. It is the one line in a disaster popup
-- that is a FACT about the event rather than a sentence of ours about the map,
-- and what it says differs by kind in a way no wording of ours could cover.
-- Empty for the kinds GDACS does not measure, and then the popup simply has one
-- line fewer.
alter table public.disaster_alerts add column if not exists measure text;

-- The severity rule widened after the table already existed, so the old
-- constraint is replaced rather than left to reject every Green row.
alter table public.disaster_alerts drop constraint if exists disaster_alerts_severity_check;
alter table public.disaster_alerts add constraint disaster_alerts_severity_check
  check (severity in ('severe','notice','routine'));

-- Drought left after the table already existed, so the rows go before the
-- constraint does. The other way round and the ALTER is rejected by the very
-- rows it is meant to forbid. The refresh would have cleared them on its next
-- run anyway — it deletes whatever it did not just write — but a schema that
-- cannot be applied to a live database is not a schema.
delete from public.disaster_alerts where kind = 'drought';
alter table public.disaster_alerts drop constraint if exists disaster_alerts_kind_check;
alter table public.disaster_alerts add constraint disaster_alerts_kind_check
  check (kind in ('earthquake','cyclone','flood','volcano','wildfire'));

create index if not exists disaster_alerts_country_idx
  on public.disaster_alerts (country_code);

alter table public.disaster_alerts enable row level security;

drop policy if exists "disasters are public" on public.disaster_alerts;
create policy "disasters are public" on public.disaster_alerts
  for select to anon, authenticated using (true);

grant select on table public.disaster_alerts to anon, authenticated;
revoke insert, update, delete on table public.disaster_alerts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Severe weather warnings, from MeteoAlarm and the US National Weather Service.
--
-- MeteoAlarm is the European met services' shared warning system: every row
-- from it was issued by a national weather service — the Deutscher
-- Wetterdienst, Météo-France, AEMET — and `source` names which one. NOAA's
-- National Weather Service is the same thing for the United States, one
-- national CAP feed instead of thirty-eight country ones. Both write to this
-- table, because a warning is a warning. We publish none of our own judgement
-- about weather and never will.
--
-- Europe and the United States, and the page says which rather than letting a
-- traveller to Peru read an empty panel as "no warnings".
--
-- NOT KEPT FOR A WEEK, unlike the reports and the disasters. A warning is
-- about the next few hours: once it has expired it is not history a traveller
-- needs, it is noise. Each generator deletes the rows it did not just refresh
-- for the countries it owns, and the page additionally drops anything whose
-- own to_date has passed, so an expired warning is gone whatever the table
-- still holds.
--
-- A warning may not have STARTED yet. Met services issue around two days
-- ahead — 130 of 361 live NWS alerts had an onset in the future when we
-- probed, the furthest 46 hours out — so from_date can be ahead of now() and
-- the page labels those rows as upcoming instead of implying they are in
-- force. Nobody issues a formal warning a week ahead; two days is the real
-- lead time on offer, from any met service in the world.
--
-- ORANGE AND RED ONLY. MeteoAlarm grades green, yellow, orange and red; green
-- and yellow together are the great majority of what it publishes — roughly
-- 5,000 of the 5,600 warnings live across Europe on an ordinary afternoon —
-- and they describe weather that is unpleasant rather than dangerous. Storing
-- them would mean half the continent is permanently flagged.
--
-- We keep no warning TEXT. The type, the level, the area name, the times, the
-- issuing service and its link — all facts about the warning — and the reader
-- goes to the met service for the warning itself, in their words and current.
--
-- Written only by the refresh workflow, which connects as the database owner.
-- ---------------------------------------------------------------------------
create table if not exists public.weather_warnings (
  warning_id   text    not null,          -- the CAP alert identifier
  country_code char(2) not null,
  kind         text    not null check (kind in
                 ('wind','snow-ice','thunderstorm','fog','high-temperature',
                  'low-temperature','coastal-event','forest-fire','avalanche',
                  'rain','flood','rain-flood')),
  severity     text    not null check (severity in ('severe','notice')),
  areas        text    not null,          -- the met service's own area names
  from_date    timestamptz,
  to_date      timestamptz,
  source       text    not null,          -- e.g. "Deutscher Wetterdienst"
  url          text,
  -- Where to put a marker, from whichever of two things we have:
  --
  --   A CAP <polygon>, which eight of the thirty-eight services send — Israel,
  --   Latvia, Ukraine, Estonia, Norway, Sweden, Iceland, the United Kingdom.
  --   Its centre is the marker, and that is the best answer available.
  --
  --   Otherwise the middle of the country, from public.weather_places. The other
  --   thirty send a region code we have no geometry for, and their area names
  --   are weather zones rather than places, so the country is as close as this
  --   gets. place_kind says which of the two it was and the popup repeats it.
  --
  -- Null only until the country has been looked up. Such a row is still a real
  -- warning: it reaches the chip and the list as before, it simply has no
  -- marker yet.
  lat          double precision check (lat between -90 and 90),
  lng          double precision check (lng between -180 and 180),
  refreshed_at timestamptz not null default now(),
  primary key (warning_id, country_code)
);

-- Existing installs: the table shipped without a position at all.
alter table public.weather_warnings
  add column if not exists lat double precision,
  add column if not exists lng double precision;

-- Whether a warning's position is the service's own shape or only the country
-- it is in. The popup says which, because "marked at the centre of the area
-- warned" is a lie when the marker is on the middle of Spain.
alter table public.weather_warnings
  add column if not exists place_kind text;

-- Dropped. It held the one area name a warning was positioned on, for a lookup
-- that tried to place "Litoral de Barcelona" and "East Sterea & Evvoia". Those
-- are weather zones rather than places: 28 of 30 could not be matched and fell
-- back to the country anyway, so the country is the answer and the column has
-- nothing to join.
alter table public.weather_warnings drop column if exists area_key;

-- ---------------------------------------------------------------------------
-- Where each country is, so its warnings can be drawn on it.
--
-- One row per country, thirty-eight in all, looked up once and then never
-- again — a country does not move. This is deliberately the whole of it: the
-- earlier version held a row per AREA NAME and three rules to stop a geocoder
-- answering with Brazil, and it earned 2 matches in 30 because met services name
-- weather zones rather than places.
--
-- We are not a met service. A traveller wants to know that Spain has a red wind
-- warning out and where to read it; the marker is a pointer to the chip, not a
-- survey mark.
--
-- A service that sends a real shape still beats this. Eight of the thirty-eight
-- put a CAP polygon in their warnings, those are drawn where the service put
-- them, and the update that uses this table skips them.
--
-- Written only by the refresh workflow, which connects as the database owner.
-- Not readable by the page: it joins server-side.
-- ---------------------------------------------------------------------------
drop table if exists public.weather_areas;

create table if not exists public.weather_places (
  country_code char(2) primary key,
  lat          double precision check (lat between -90 and 90),
  lng          double precision check (lng between -180 and 180),
  resolved_at  timestamptz not null default now()
);

alter table public.weather_places enable row level security;
revoke all on table public.weather_places from anon, authenticated;

-- NOAA's National Weather Service wrote here for a day and was removed. Its
-- feed is mostly marine advisories and county flood warnings; on a world travel
-- map that came out as a United States covered in flood signs drawn with the
-- same image as a GDACS flood disaster, linking to a weather.gov home page.
-- More noise than information, so it went, and its rows go with it. Nothing
-- writes these country codes any more, and MeteoAlarm's refresh deletes only
-- its own thirty-eight, so without this they would sit here for ever.
delete from public.weather_warnings
 where country_code in ('US', 'PR', 'VI', 'GU', 'MP', 'AS');

create index if not exists weather_warnings_country_idx
  on public.weather_warnings (country_code);

alter table public.weather_warnings enable row level security;

drop policy if exists "weather warnings are public" on public.weather_warnings;
create policy "weather warnings are public" on public.weather_warnings
  for select to anon, authenticated using (true);

grant select on table public.weather_warnings to anon, authenticated;
revoke insert, update, delete on table public.weather_warnings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Earthquakes used to have a mirror of their own, from USGS. They come from
-- GDACS now, in disaster_alerts with everything else: GDACS carries them with
-- a magnitude, a depth, a position and its own impact grading, and that
-- grading answers "is this one worth a traveller's attention" better than a
-- magnitude cut can, because it weighs where the ground moved as well as how
-- much. One source, one table, one job.
--
-- Dropped rather than left empty. A table nothing reads is a table somebody
-- will one day wonder about.
-- ---------------------------------------------------------------------------
drop table if exists public.quake_events;

-- ---------------------------------------------------------------------------
-- Travel advisories, from the German Federal Foreign Office.
--
-- One row per country, mirrored from their open-data interface. We store the
-- STATUS of an advisory — which of the four levels applies, its official
-- title, when the ministry last changed it — and never the advisory text.
--
-- That is deliberate, not a shortcut. Their terms require the information to
-- be taken complete, kept current, and not put in a distorting context; an
-- excerpt of a multi-page advisory is none of those things. The status is a
-- fact about the advisory rather than the advisory itself, and content_id
-- gives us the official permalink so the full text is always read from them,
-- always current, in their words.
--
-- Written only by the refresh workflow, which connects as the database owner.
-- ---------------------------------------------------------------------------
create table if not exists public.travel_advisories (
  country_code  char(2) primary key,
  content_id    bigint not null,
  title         text   not null,          -- e.g. "Spanien: Reise- und Sicherheitshinweise"
  country_name  text   not null,          -- the ministry's own (German) name for it
  -- The four levels, most serious first. All false = ordinary country
  -- information, which is itself worth showing: "no warning" is an answer.
  warning                boolean not null default false,  -- full travel warning
  partial_warning        boolean not null default false,  -- parts of the country
  situation_warning      boolean not null default false,  -- security notice, countrywide
  situation_part_warning boolean not null default false,  -- security notice, parts
  last_modified timestamptz,              -- when the ministry last changed it
  effective     timestamptz,
  refreshed_at  timestamptz not null default now()   -- when we last read it
);

alter table public.travel_advisories enable row level security;

drop policy if exists "advisories are public" on public.travel_advisories;
create policy "advisories are public" on public.travel_advisories
  for select to anon, authenticated using (true);

-- Supabase grants new public tables to anon and authenticated by default, so
-- in practice the revoke below is what makes this read-only. The grant is
-- stated anyway: it costs nothing, it survives a project whose default
-- privileges differ, and it says out loud that this table is meant to be world
-- readable — it is public government data, not anybody's report.
grant select on table public.travel_advisories to anon, authenticated;
revoke insert, update, delete on table public.travel_advisories from anon, authenticated;

alter table public.safety_places enable row level security;

-- Readable by everyone; writable by nobody through the API. The refresh
-- workflow connects as the database owner, which bypasses RLS.
drop policy if exists "safety places are public" on public.safety_places;
create policy "safety places are public" on public.safety_places
  for select to anon, authenticated using (true);

revoke insert, update, delete on table public.safety_places from anon, authenticated;
