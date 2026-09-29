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
select severity, kind, count(*) as rows
  from public.disaster_alerts
 group by severity, kind
 order by severity, kind;

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
