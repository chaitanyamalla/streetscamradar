-- ---------------------------------------------------------------------------
-- Remove police stations from the map.
--
-- They were dropped on purpose rather than for lack of data quality: police
-- come to you when you call the emergency number the map already shows, so a
-- map of stations answered a question nobody had. A hospital is the opposite —
-- somewhere you take yourself, for the sprained wrist or the stitches that do
-- not warrant an ambulance.
--
-- The kind column keeps its check constraint, so bringing them back is a
-- change to the fetch script and nothing else.
-- ---------------------------------------------------------------------------
select 'before' as step, kind, count(*) from public.safety_places group by kind order by kind;

delete from public.safety_places where kind = 'police';

select 'after' as step, kind, count(*) from public.safety_places group by kind order by kind;
