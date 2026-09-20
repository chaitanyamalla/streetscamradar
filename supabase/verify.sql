-- ============================================================================
-- StreetScamRadar — post-install check.
-- Paste into the Supabase SQL editor after running schema.sql.
-- Safe: reads only, writes nothing. Every row should say PASS.
-- ============================================================================
with expected_tables(t) as (
  values ('reports'),('profiles'),('scam_categories'),
         ('report_supports'),('report_flags'),('app_settings'),
         ('safety_places')
),
expected_funcs(f) as (
  values ('public_area_summary'),('public_sample_reports'),('delete_my_report'),
         ('setting_int'),('setting_num'),('report_window'),('handle_new_user'),
         ('is_own_report'),('edit_my_report')
)
select * from (
  select 1 as ord, 'tables created' as check,
         count(*) || ' of 7' as detail,
         case when count(*) = 7 then 'PASS' else 'MISSING' end as result
    from expected_tables e
    join pg_tables p on p.tablename = e.t and p.schemaname = 'public'

  union all
  select 2, 'row level security on every table',
         count(*) filter (where c.relrowsecurity) || ' of 7',
         case when count(*) filter (where c.relrowsecurity) = 7 then 'PASS' else 'FAIL' end
    from expected_tables e
    join pg_class c on c.relname = e.t
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'

  union all
  -- 11 policies: profiles 3, report_supports 3, report_flags 2,
  -- reports 1 (insert only — reads go through the view), categories 1,
  -- safety_places 1 (read by everyone, written by nobody).
  select 3, 'security policies present', count(*) || ' of 11',
         case when count(*) = 11 then 'PASS' else 'FAIL' end
    from pg_policies where schemaname = 'public'

  union all
  select 4, 'functions created', count(distinct p.proname) || ' of 9',
         case when count(distinct p.proname) = 9 then 'PASS' else 'MISSING' end
    from expected_funcs e
    join pg_proc p on p.proname = e.f
    join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'

  union all
  select 5, 'scam categories seeded', count(*) || ' categories',
         case when count(*) = 12 then 'PASS' else 'FAIL' end
    from public.scam_categories

  union all
  select 6, 'settings seeded', count(*) || ' settings',
         case when count(*) = 4 then 'PASS' else 'FAIL' end
    from public.app_settings

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
  select 14, 'reports currently stored', count(*) || ' reports', 'INFO'
    from public.reports
) x order by ord;
