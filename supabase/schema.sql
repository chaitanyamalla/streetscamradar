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
  kind         text    not null check (kind in
                 ('earthquake','cyclone','flood','volcano','drought','wildfire')),
  -- GDACS grades Red / Orange / Green; Green is the routine background of a
  -- working planet and never reaches this table.
  severity     text    not null check (severity in ('severe','notice')),
  name         text    not null,          -- GDACS's own words, in English
  from_date    timestamptz,
  to_date      timestamptz,
  url          text,
  -- Where GDACS puts the event. What it MEANS differs by kind: a volcano and
  -- a wildfire are at the point; a cyclone is where the storm was last
  -- placed; a flood or a drought is the centroid of everything affected,
  -- which is open water or empty country as often as not. The page draws all
  -- of them and says which in the popup, rather than implying a street.
  lat          double precision,
  lng          double precision,
  refreshed_at timestamptz not null default now(),
  primary key (event_id, country_code)
);

alter table public.disaster_alerts add column if not exists lat double precision;
alter table public.disaster_alerts add column if not exists lng double precision;

create index if not exists disaster_alerts_country_idx
  on public.disaster_alerts (country_code);

alter table public.disaster_alerts enable row level security;

drop policy if exists "disasters are public" on public.disaster_alerts;
create policy "disasters are public" on public.disaster_alerts
  for select to anon, authenticated using (true);

grant select on table public.disaster_alerts to anon, authenticated;
revoke insert, update, delete on table public.disaster_alerts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Severe weather warnings, from MeteoAlarm.
--
-- MeteoAlarm is the European met services' shared warning system: every row
-- here was issued by a national weather service — the Deutscher Wetterdienst,
-- Météo-France, AEMET — and `source` names which one. We publish none of our
-- own judgement about weather and never will.
--
-- Europe only. That is MeteoAlarm's remit, and the page says so rather than
-- letting a traveller to Peru read an empty panel as "no warnings".
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
  refreshed_at timestamptz not null default now(),
  primary key (warning_id, country_code)
);

create index if not exists weather_warnings_country_idx
  on public.weather_warnings (country_code);

alter table public.weather_warnings enable row level security;

drop policy if exists "weather warnings are public" on public.weather_warnings;
create policy "weather warnings are public" on public.weather_warnings
  for select to anon, authenticated using (true);

grant select on table public.weather_warnings to anon, authenticated;
revoke insert, update, delete on table public.weather_warnings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Earthquakes, from USGS.
--
-- Mirrored like everything else here, rather than fetched by the page. USGS
-- does serve these with permissive CORS and a 60-second cache — it is built
-- to be read from a browser — and for a long time the page read it directly.
-- One table and one refresh job for every hazard is worth more than the
-- freshness that costs: one shape to reason about, one place a reader's
-- browser talks to, nothing asked of an outside service on every visit, and
-- the map still works on a day USGS does not.
--
-- The freshness that costs is real and should be said plainly: an earthquake
-- can be up to twelve hours old here before the job runs again. This is a
-- trip-planning signal, not an alerting service — the official source is
-- linked on every one, and the emergency numbers are already on the map.
--
-- WHAT IS KEPT. Two USGS feeds, and only two:
--
--   significant_month  USGS's own judgement of what mattered — magnitude
--                      weighted by how many people felt it and what it did.
--                      Kept for a month, because the damage and the
--                      aftershocks outlast the shaking.
--   4.5_week           the ordinary threshold for "felt widely, sometimes
--                      damaging", kept for a week.
--
-- Below M4.5 an earthquake is a local event a visitor would not notice, and
-- there are hundreds a day. A map that shows all of them teaches people to
-- ignore it.
--
-- Written only by the refresh workflow, which connects as the database owner.
-- ---------------------------------------------------------------------------
create table if not exists public.quake_events (
  event_id     text    primary key,       -- the USGS id, e.g. us6000tyc9
  magnitude    numeric(3,1) not null,
  -- The source's own words for where it was, never translated: it is a place
  -- description from an agency, not a label of ours.
  place        text    not null default '',
  lat          double precision not null,
  lng          double precision not null,
  at           timestamptz not null,
  tsunami      boolean not null default false,
  url          text,
  refreshed_at timestamptz not null default now()
);

create index if not exists quake_events_at_idx
  on public.quake_events (at desc);

alter table public.quake_events enable row level security;

drop policy if exists "earthquakes are public" on public.quake_events;
create policy "earthquakes are public" on public.quake_events
  for select to anon, authenticated using (true);

grant select on table public.quake_events to anon, authenticated;
revoke insert, update, delete on table public.quake_events from anon, authenticated;

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
