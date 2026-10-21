-- ---------------------------------------------------------------------------
-- Is the country-lock and notice machinery live, and what is in force?
--
-- Shapes and counts only. No headlines, no notes, no reporter ids, no emails:
-- this runs in GitHub Actions on a public repository, and the note on a lock
-- is our reasoning about a third party's data.
--
-- Run: Database workflow, file = supabase/ops/diagnose_locks.sql
-- ---------------------------------------------------------------------------

-- Everything this release added, and whether it is there.
select thing, case when present then 'yes' else 'MISSING' end as live
  from (values
    ('table country_locks',    to_regclass('public.country_locks')    is not null),
    ('table country_notices',  to_regclass('public.country_notices')  is not null),
    ('column reports.reporter_weight',
       exists (select 1 from information_schema.columns
                where table_name = 'reports' and column_name = 'reporter_weight')),
    ('column contributor_levels.daily_quota',
       exists (select 1 from information_schema.columns
                where table_name = 'contributor_levels' and column_name = 'daily_quota')),
    ('column profiles.daily_report_limit',
       exists (select 1 from information_schema.columns
                where table_name = 'profiles' and column_name = 'daily_report_limit')),
    ('trigger reports_gate',
       exists (select 1 from pg_trigger where tgname = 'reports_gate' and not tgisinternal)),
    ('function report_gate',   to_regprocedure('public.report_gate(uuid,double precision,double precision,text)') is not null),
    ('function lock_scopes',   to_regprocedure('public.lock_scopes()') is not null),
    ('function active_locks',  to_regprocedure('public.active_locks()') is not null),
    ('function notices_for',   to_regprocedure('public.notices_for(text)') is not null),
    ('function member_weight', to_regprocedure('public.member_weight(uuid)') is not null),
    ('function report_quota',  to_regprocedure('public.report_quota(uuid)') is not null)
  ) as t(thing, present)
 order by present, thing;

-- The allowance ladder, as it now stands.
select level, min_points, daily_quota
  from public.contributor_levels order by level;

-- The rules, every one of them a number an admin can retune.
select key, value
  from public.app_settings
 where key in ('report_gap_seconds', 'reports_per_hour', 'duplicate_metres',
               'duplicate_hours', 'travel_kmh_limit', 'travel_min_metres',
               'partner_daily_quota', 'rank_per_confirmation', 'rank_per_flag',
               'points_per_report', 'points_per_confirmation')
 order by key;

-- What is locked and what is posted. Counts and scopes only.
select count(*) as locks_total,
       count(*) filter (where until is null or until > now()) as locks_in_force
  from public.country_locks;
select unnest(scopes) as scope, count(*) as countries
  from public.country_locks
 where until is null or until > now()
 group by 1 order by 1;
select count(*) as notices_total,
       count(*) filter (where until is null or until > now()) as notices_in_force
  from public.country_notices;

-- And that the feeds are readable at all, which is what a lock could break.
select 'advisories' as feed, count(*) from public.travel_advisories
union all select 'disasters',  count(*) from public.disaster_alerts
union all select 'weather',    count(*) from public.weather_warnings
union all select 'safety',     count(*) from public.safety_places
union all select 'reports',    count(*) from public.reports
 order by 1;
