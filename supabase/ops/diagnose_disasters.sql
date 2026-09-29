-- ---------------------------------------------------------------------------
-- What the hazard chip would show right now, and for whom.
--
-- Read-only. Public agency data only — no reporter, no email, no report text —
-- so it is safe to run from the Actions log of a public repository.
--
-- Run: Database workflow, file = supabase/ops/diagnose_disasters.sql
-- ---------------------------------------------------------------------------
select country_code, kind, severity, name,
       to_char(from_date, 'YYYY-MM-DD') as started,
       to_char(to_date,   'YYYY-MM-DD') as ends,
       to_char(refreshed_at, 'YYYY-MM-DD HH24:MI') as seen_at
  from public.disaster_alerts
 order by severity, country_code, event_id;

-- Rows the page would drop as finished, even though GDACS still lists them.
select count(*) as finished_more_than_a_week_ago
  from public.disaster_alerts
 where to_date is not null and to_date < now() - interval '7 days';
