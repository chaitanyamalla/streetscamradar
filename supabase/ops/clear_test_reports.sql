-- ---------------------------------------------------------------------------
-- Remove every sample report seed_test_reports.sql put in, and nothing else.
--
-- They all carry an id starting 7e57da7a ("testdata"), which no real report
-- can have: a real one gets gen_random_uuid(). So this cannot reach a report
-- somebody actually filed.
--
-- Run: Database workflow, file = supabase/ops/clear_test_reports.sql
-- ---------------------------------------------------------------------------
delete from public.reports where id::text like '7e57da7a%';

select count(*) as test_reports_left
  from public.reports where id::text like '7e57da7a%';

select count(*) as real_reports_still_there
  from public.reports where id::text not like '7e57da7a%';
