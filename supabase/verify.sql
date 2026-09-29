-- ============================================================================
-- StreetScamRadar — post-install check.
-- Paste into the Supabase SQL editor after running schema.sql.
-- Safe: reads only, writes nothing. Every row should say PASS.
-- ============================================================================
with expected_tables(t) as (
  values ('reports'),('profiles'),('scam_categories'),
         ('report_supports'),('report_flags'),('app_settings'),
         ('safety_places'),('travel_advisories'),('disaster_alerts'),
         ('weather_warnings')
),
expected_funcs(f) as (
  values ('public_area_summary'),('public_sample_reports'),('delete_my_report'),
         ('setting_int'),('setting_num'),('report_window'),('handle_new_user'),
         ('is_own_report'),('edit_my_report'),('delete_my_account'),
         ('report_move_window')
)
select * from (
  select 1 as ord, 'tables created' as check,
         count(*) || ' of 10' as detail,
         case when count(*) = 10 then 'PASS' else 'MISSING' end as result
    from expected_tables e
    join pg_tables p on p.tablename = e.t and p.schemaname = 'public'

  union all
  select 2, 'row level security on every table',
         count(*) filter (where c.relrowsecurity) || ' of 10',
         case when count(*) filter (where c.relrowsecurity) = 10 then 'PASS' else 'FAIL' end
    from expected_tables e
    join pg_class c on c.relname = e.t
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'

  union all
  -- 14 policies: profiles 3, report_supports 3, report_flags 2,
  -- reports 1 (insert only — reads go through the view), categories 1, and one
  -- each for the four mirrored tables — safety_places, travel_advisories,
  -- disaster_alerts and weather_warnings — which everybody reads and nobody
  -- but the refresh workflows writes.
  select 3, 'security policies present', count(*) || ' of 14',
         case when count(*) = 14 then 'PASS' else 'FAIL' end
    from pg_policies where schemaname = 'public'

  union all
  select 4, 'functions created', count(distinct p.proname) || ' of 11',
         case when count(distinct p.proname) = 11 then 'PASS' else 'MISSING' end
    from expected_funcs e
    join pg_proc p on p.proname = e.f
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'

  union all
  select 5, 'scam categories seeded', count(*) || ' categories',
         case when count(*) = 12 then 'PASS' else 'FAIL' end
    from public.scam_categories

  union all
  -- Named rather than counted. A magic number here went stale the moment a
  -- sixth setting was added, and a FAIL that only means "somebody added a
  -- setting" teaches you to ignore the column.
  select 6, 'settings seeded',
         (select count(*)::text || ' present' from public.app_settings),
         case when not exists (
                select 1 from (values ('report_window_days'),
                                      ('auto_hide_flag_threshold'),
                                      ('report_move_window_hours'),
                                      ('public_sample_limit'),
                                      ('public_detail_max_span'),
                                      ('blocked_regions')) as wanted(key)
                 where wanted.key not in (select key from public.app_settings))
              then 'PASS' else 'MISSING' end

  union all
  -- The important one: signed-out visitors must NOT be able to read reports.
  select 7, 'anon CANNOT read reports table',
         case when has_table_privilege('anon','public.reports','SELECT')
              then 'anon has SELECT — NOT SAFE' else 'revoked' end,
         case when has_table_privilege('anon','public.reports','SELECT')
              then 'FAIL' else 'PASS' end

  union all
  select 8, 'anon CANNOT read the member feed',
         case when has_table_privilege('anon','public.reports_feed','SELECT')
              then 'anon has SELECT — NOT SAFE' else 'revoked' end,
         case when has_table_privilege('anon','public.reports_feed','SELECT')
              then 'FAIL' else 'PASS' end

  union all
  select 9, 'members CAN read the member feed',
         case when has_table_privilege('authenticated','public.reports_feed','SELECT')
              then 'granted' else 'missing' end,
         case when has_table_privilege('authenticated','public.reports_feed','SELECT')
              then 'PASS' else 'FAIL' end

  union all
  select 10, 'members CAN file a report',
         case when has_table_privilege('authenticated','public.reports','INSERT')
              then 'granted' else 'missing' end,
         case when has_table_privilege('authenticated','public.reports','INSERT')
              then 'PASS' else 'FAIL' end

  union all
  select 11, 'anon CAN call the two public functions',
         (case when has_function_privilege('anon','public.public_area_summary(double precision,double precision,double precision,double precision,integer)','EXECUTE') then 1 else 0 end
        + case when has_function_privilege('anon','public.public_sample_reports(double precision,double precision,double precision,double precision)','EXECUTE') then 1 else 0 end) || ' of 2',
         case when has_function_privilege('anon','public.public_area_summary(double precision,double precision,double precision,double precision,integer)','EXECUTE')
               and has_function_privilege('anon','public.public_sample_reports(double precision,double precision,double precision,double precision)','EXECUTE')
              then 'PASS' else 'FAIL' end

  union all
  select 12, 'reporter stays anonymous in the feed',
         case when exists (select 1 from information_schema.columns
                            where table_schema='public' and table_name='reports_feed'
                              and column_name='reporter_id')
              then 'reporter_id EXPOSED' else 'reporter_id absent' end,
         case when exists (select 1 from information_schema.columns
                            where table_schema='public' and table_name='reports_feed'
                              and column_name='reporter_id')
              then 'FAIL' else 'PASS' end

  union all
  select 13, 'sign-up trigger installed',
         case when exists (select 1 from pg_trigger where tgname='on_auth_user_created')
              then 'present' else 'missing' end,
         case when exists (select 1 from pg_trigger where tgname='on_auth_user_created')
              then 'PASS' else 'FAIL' end

  union all
  select 14, 'language choice can be stored',
         coalesce((select array_length(
                     regexp_split_to_array(
                       substring(pg_get_constraintdef(oid) from 'ARRAY\[(.*)\]'), ','), 1)::text
                   || ' languages allowed'
                     from pg_constraint where conname = 'locale_known'),
                  'profiles.locale MISSING'),
         case when exists (select 1 from information_schema.columns
                            where table_schema='public' and table_name='profiles'
                              and column_name='locale')
              then 'PASS' else 'FAIL' end

  union all
  select 15, 'travel advisories loaded',
         (select count(*) || ' countries' from public.travel_advisories),
         case when (select count(*) from public.travel_advisories) >= 100
              then 'PASS' else 'EMPTY' end

  union all
  select 16, 'advisories readable by a signed-out visitor',
         case when has_table_privilege('anon', 'public.travel_advisories', 'SELECT')
              then 'anon can select' else 'anon CANNOT select' end,
         case when has_table_privilege('anon', 'public.travel_advisories', 'SELECT')
               and not has_table_privilege('anon', 'public.travel_advisories', 'INSERT')
              then 'PASS' else 'FAIL' end

  union all
  select 17, 'advisory levels in force',
         (select coalesce(count(*) filter (where warning) || ' travel warnings, '
               || count(*) filter (where partial_warning) || ' partial, '
               || count(*) filter (where situation_warning or situation_part_warning)
               || ' security notices', '—')
            from public.travel_advisories), 'INFO'

  union all
  select 18, 'advisories last refreshed',
         (select coalesce(to_char(max(refreshed_at), 'YYYY-MM-DD HH24:MI') || ' UTC', 'never')
            from public.travel_advisories), 'INFO'

  union all
  -- The exact bug that shipped once: their timestamps are epoch SECONDS, and
  -- reading them as milliseconds puts every advisory in January 1970. That is
  -- invisible in a count and obvious in a date range, so the range is checked.
  select 19, 'advisory dates look like dates',
         (select coalesce(to_char(min(last_modified), 'YYYY-MM-DD') || ' … '
                       || to_char(max(last_modified), 'YYYY-MM-DD'), 'none stored')
            from public.travel_advisories),
         case when (select min(last_modified) from public.travel_advisories)
                   > timestamptz '2000-01-01'
              then 'PASS' else 'SUSPECT' end

  union all
  -- Empty is a legitimate answer here, unlike the advisories: on a calm day
  -- GDACS lists nothing Red or Orange anywhere. What would be wrong is rows
  -- that stopped being refreshed, which the next two checks would show.
  select 20, 'ongoing disasters stored',
         (select coalesce(count(*) || ' country alerts across '
                       || count(distinct country_code) || ' countries', '0')
            from public.disaster_alerts), 'INFO'

  union all
  select 21, 'disasters readable by a signed-out visitor',
         case when has_table_privilege('anon', 'public.disaster_alerts', 'SELECT')
              then 'anon can select' else 'anon CANNOT select' end,
         case when has_table_privilege('anon', 'public.disaster_alerts', 'SELECT')
               and not has_table_privilege('anon', 'public.disaster_alerts', 'INSERT')
              then 'PASS' else 'FAIL' end

  union all
  -- The refresh deletes whatever GDACS stopped listing, so every stored row
  -- was seen on the last run. A refreshed_at that has stopped moving means the
  -- workflow has stopped, and the map would be showing last week's floods.
  select 22, 'disasters last refreshed',
         (select coalesce(to_char(max(refreshed_at), 'YYYY-MM-DD HH24:MI') || ' UTC', 'never')
            from public.disaster_alerts),
         case when not exists (select 1 from public.disaster_alerts) then 'EMPTY'
              when (select max(refreshed_at) from public.disaster_alerts)
                   > now() - interval '12 hours' then 'PASS' else 'STALE' end

  union all
  select 23, 'weather warnings stored',
         (select coalesce(count(*) || ' orange/red across '
                       || count(distinct country_code) || ' countries', '0')
            from public.weather_warnings), 'INFO'

  union all
  select 24, 'weather warnings readable by a signed-out visitor',
         case when has_table_privilege('anon', 'public.weather_warnings', 'SELECT')
              then 'anon can select' else 'anon CANNOT select' end,
         case when has_table_privilege('anon', 'public.weather_warnings', 'SELECT')
               and not has_table_privilege('anon', 'public.weather_warnings', 'INSERT')
              then 'PASS' else 'FAIL' end

  union all
  -- A warning nobody refreshed is a warning about weather that has moved on.
  select 25, 'weather warnings last refreshed',
         (select coalesce(to_char(max(refreshed_at), 'YYYY-MM-DD HH24:MI') || ' UTC', 'never')
            from public.weather_warnings),
         case when not exists (select 1 from public.weather_warnings) then 'EMPTY'
              when (select max(refreshed_at) from public.weather_warnings)
                   > now() - interval '12 hours' then 'PASS' else 'STALE' end

  union all
  select 25.1, 'earthquakes stored',
         (select coalesce(count(*)::text || ' quakes, strongest M' || max(magnitude)::text,
                          'none — GDACS has graded none of them worth showing')
            from public.disaster_alerts where kind = 'earthquake'),
         'INFO'

  union all
  -- Every alert level is kept now, so this is the shape of the map: mostly
  -- green, which is why the page names the grade on every one.
  select 25.2, 'how GDACS graded what we hold',
         (select coalesce(string_agg(severity || ' ' || n, ', ' order by severity), 'nothing')
            from (select severity, count(*)::text as n
                    from public.disaster_alerts group by severity) g),
         'INFO'

  union all
  select 25.3, 'an earthquake carries its magnitude',
         (select coalesce(count(*) filter (where magnitude is not null)::text
                          || ' of ' || count(*)::text, '0 of 0')
            from public.disaster_alerts where kind = 'earthquake'),
         case when exists (select 1 from public.disaster_alerts
                            where kind = 'earthquake' and magnitude is null)
              then 'SUSPECT' else 'PASS' end

  union all
  -- A volcano IS its coordinates, where a flood's are the centre of an area,
  -- so a volcano without them is the one the map cannot place at all.
  select 26, 'volcanoes carry a position',
         (select coalesce(count(*) filter (where lat is not null) || ' of '
                       || count(*) || ' volcanoes', 'none listed')
            from public.disaster_alerts where kind = 'volcano'),
         case when exists (select 1 from public.disaster_alerts
                            where kind = 'volcano' and lat is null)
              then 'SUSPECT' else 'PASS' end

  union all
  -- The page refuses a pin in the sea or at the poles, but the page can be
  -- bypassed. This is the rule that cannot be.
  select 27, 'reports confined to inhabited latitudes',
         coalesce((select string_agg(conname, ', ')
                     from pg_constraint
                    where conrelid = 'public.reports'::regclass and contype = 'c'
                      and pg_get_constraintdef(oid) like '%60%'), 'no latitude constraint'),
         case when exists (select 1 from pg_constraint
                            where conrelid = 'public.reports'::regclass and contype = 'c'
                              and pg_get_constraintdef(oid) like '%60%')
              then 'PASS' else 'FAIL' end

  union all
  select 28, 'country groups seeded',
         (select count(distinct group_code) || ' groups over '
               || count(distinct country_code) || ' countries'
            from public.country_groups),
         case when (select count(distinct country_code) from public.country_groups) >= 240
               and (select count(distinct group_code) from public.country_groups) >= 25
              then 'PASS' else 'INCOMPLETE' end

  union all
  -- Normally nothing. When something is closed this says what, because a
  -- region left shut by accident is invisible from every other angle.
  select 29, 'regions closed to reporting',
         case when coalesce(cardinality(public.blocked_countries()), 0) = 0
              then 'none — reporting open everywhere'
              else cardinality(public.blocked_countries()) || ' countries: '
                   || array_to_string(public.blocked_countries(), ', ') end,
         'INFO'

  union all
  select 30, 'the block is enforced by the table, not only the page',
         case when exists (
                select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'reports'
                   and policyname = 'members create reports'
                   and with_check like '%reporting_allowed%')
              then 'in the insert policy' else 'NOT in the insert policy' end,
         case when exists (
                select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'reports'
                   and policyname = 'members create reports'
                   and with_check like '%reporting_allowed%')
              then 'PASS' else 'FAIL' end

  union all
  select 31, 'reports currently stored', count(*) || ' reports', 'INFO'
    from public.reports
) x order by ord;
