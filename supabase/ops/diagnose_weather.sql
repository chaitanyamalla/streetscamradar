-- ---------------------------------------------------------------------------
-- What MeteoAlarm is giving us right now, and for whom.
--
-- Read-only. Public met-service data only — no reporter, no email, no report
-- text — so it is safe to run from the Actions log of a public repository.
--
-- Counts LAST, as in diagnose_disasters.sql: a log tail is read from the end,
-- and the summary is the line that answers the question.
--
-- Run: Database workflow, file = supabase/ops/diagnose_weather.sql
-- ---------------------------------------------------------------------------

-- Which services are issuing anything at all, and how much.
select country_code, source, count(*) as warnings,
       count(*) filter (where severity = 'severe') as red,
       count(*) filter (where severity = 'notice') as orange
  from public.weather_warnings
 where to_date is null or to_date >= now()
 group by country_code, source
 order by warnings desc, country_code;

-- What is being warned of, across the whole of Europe.
select kind, severity, count(*) as warnings
  from public.weather_warnings
 where to_date is null or to_date >= now()
 group by kind, severity
 order by warnings desc;

-- Rows that have expired but are still sitting in the table. The refresh
-- deletes them, so a number above zero means it has not run since they ended.
select count(*) as expired_still_stored
  from public.weather_warnings
 where to_date is not null and to_date < now();

select count(distinct country_code) as countries_with_warnings,
       count(*) as rows_in_all,
       to_char(max(refreshed_at), 'YYYY-MM-DD HH24:MI') as last_refresh
  from public.weather_warnings;
