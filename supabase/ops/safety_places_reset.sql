-- ---------------------------------------------------------------------------
-- Empty public.safety_places so it can be rebuilt from scratch.
--
-- Run this ONLY immediately before a full rebuild, and only when you intend to
-- have no police or hospital pins on the map until that rebuild lands. The
-- refresh job's own --prune is the normal way to remove places that no longer
-- qualify; this is for the rarer case of changing what qualifies so
-- fundamentally that the whole table is suspect.
--
--   Actions -> Database      -> supabase/ops/safety_places_reset.sql
--   Actions -> Refresh safety places -> city_list: cities_europe.txt, prune: true
-- ---------------------------------------------------------------------------
select 'before' as step, kind, count(*) from public.safety_places group by kind order by kind;

delete from public.safety_places;

select 'after' as step, count(*) as rows_left from public.safety_places;
