-- ---------------------------------------------------------------------------
-- What the hazard chip would show right now, and for whom.
--
-- Read-only. Public agency data only — no reporter, no email, no report text —
-- so it is safe to run from the Actions log of a public repository.
--
-- The full listing used to run to 80+ lines, which the log tail truncates from
-- the top — so the interesting rows scrolled out of reach. Smallest first:
-- the counts, then the Red and Orange rows (the ones drawn full-colour), and
-- the Green ones only as a tally, since they are drawn dull by design.
--
-- Run: Database workflow, file = supabase/ops/diagnose_disasters.sql
-- ---------------------------------------------------------------------------

-- Rows the page would drop as finished, even though GDACS still lists them.
select count(*) as finished_more_than_a_week_ago
  from public.disaster_alerts
 where to_date is not null and to_date < now() - interval '7 days';

-- Every Red and Orange row: these are the ones drawn in full colour.
select country_code, kind, severity, name,
       to_char(from_date, 'YYYY-MM-DD') as started,
       to_char(to_date,   'YYYY-MM-DD') as ends,
       -- No coordinates means no marker, however good the row is otherwise.
       round(lat::numeric, 2) as lat, round(lng::numeric, 2) as lng,
       to_char(refreshed_at, 'YYYY-MM-DD HH24:MI') as seen_at
  from public.disaster_alerts
 where severity in ('severe', 'notice')
 order by severity, country_code, event_id;

-- Everything that is not a wildfire, whatever its grade. The wildfires are 77
-- of the 84 rows and would push the rest out of the readable end of the log;
-- what is left is small enough to read and is where a wrong row shows up.
select country_code, kind, severity, name,
       to_char(from_date, 'YYYY-MM-DD') as started,
       to_char(to_date,   'YYYY-MM-DD') as ends,
       to_char(refreshed_at, 'YYYY-MM-DD HH24:MI') as seen_at
  from public.disaster_alerts
 where kind <> 'wildfire'
 order by kind, country_code, event_id;

-- The counts LAST, not first. A log tail is read from the end, and this is the
-- line that answers "did the change do what it said" — putting it at the top
-- meant it was the first thing to scroll out of reach.
select severity, kind, count(*) as rows
  from public.disaster_alerts
 group by severity, kind
 order by severity, kind;

select count(*) as rows_in_all from public.disaster_alerts;
