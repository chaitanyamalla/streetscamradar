-- ---------------------------------------------------------------------------
-- What MeteoAlarm and NOAA/NWS are giving us right now, and for whom.
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

-- What is being warned of, everywhere we are told anything.
select kind, severity, count(*) as warnings
  from public.weather_warnings
 where to_date is null or to_date >= now()
 group by kind, severity
 order by warnings desc;

-- How many have somewhere to be drawn. MeteoAlarm sends no geometry, so Europe
-- should be zero here and the United States about a third; a US figure of zero
-- means NOAA's polygons stopped arriving, which would empty the map layer
-- without emptying the chip, and nothing else would look wrong.
select country_code,
       count(*) as warnings,
       count(lat) as with_a_position,
       round(100.0 * count(lat) / greatest(count(*), 1)) as pct_placed
  from public.weather_warnings
 where to_date is null or to_date >= now()
 group by country_code
 order by warnings desc;

-- How far ahead anybody is warning. Two days is the ceiling a met service
-- works to, so a figure much above 50 hours means something is wrong with the
-- dates rather than that somebody has learned to forecast a week out.
select count(*) filter (where from_date > now()) as not_yet_started,
       round(max(extract(epoch from (from_date - now())) / 3600)::numeric, 1)
         as furthest_ahead_hours
  from public.weather_warnings
 where to_date is null or to_date >= now();

-- How many warnings are sharing one point, and where. Every area name a country
-- could not place lands on that country's middle, so a country with twenty
-- unplaceable zone names has twenty markers on one pixel. The map fans them out
-- to be clickable, but a number above about eight here means the lookup is
-- doing badly for that country rather than the map doing badly.
select country_code, lat, lng,
       count(*) as warnings_on_this_point,
       count(distinct kind) as kinds_on_it,
       max(place_kind) as placed_by
  from public.weather_warnings
 where lat is not null and (to_date is null or to_date >= now())
 group by country_code, lat, lng
having count(*) > 1
 order by 4 desc
 limit 12;

-- Rows that have expired but are still sitting in the table. The refresh
-- deletes them, so a number above zero means it has not run since they ended.
select count(*) as expired_still_stored
  from public.weather_warnings
 where to_date is not null and to_date < now();

select count(distinct country_code) as countries_with_warnings,
       count(*) as rows_in_all,
       to_char(max(refreshed_at), 'YYYY-MM-DD HH24:MI') as last_refresh
  from public.weather_warnings;
