-- ---------------------------------------------------------------------------
-- Replace the severity picker with what actually happened, and let a
-- description be one word.
--
-- Nobody standing in a station can rate their own risk as low, medium or high,
-- and the answer told a reader nothing they could act on. What a reporter does
-- know is whether money went, whether anyone was hurt, and whether they were
-- threatened. That is what the form asks now.
--
-- Run this FIRST, then run supabase/schema.sql, which recreates the view, the
-- policies and the public functions against the new column.
--
--   Actions -> Database -> Run workflow -> supabase/ops/impacts_migration.sql
--   Actions -> Database -> Run workflow -> supabase/schema.sql
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------
begin;

-- 1. The new column. Existing reports get an empty array, not a guess: they
--    were never asked this question, and inventing an answer for somebody
--    else's report is worse than leaving it blank.
alter table public.reports
  add column if not exists impacts text[] not null default '{}';

alter table public.reports drop constraint if exists reports_impacts_check;
alter table public.reports
  add constraint reports_impacts_check
  check (impacts <@ array['money','harm','threats']::text[]);

-- 2. One word is a valid description. The headline already carries the
--    summary; the 20-character floor only ever blocked someone with little
--    to add.
alter table public.reports drop constraint if exists reports_description_check;
alter table public.reports
  add constraint reports_description_check
  check (char_length(btrim(description)) between 1 and 1200);

-- 3. Drop severity. The feed view and the two public functions read it, so
--    they go first; supabase/schema.sql puts all three back.
drop view if exists public.reports_feed;
drop function if exists public.public_area_summary(double precision, double precision, double precision, double precision, int);
drop function if exists public.public_sample_reports(double precision, double precision, double precision, double precision);

alter table public.reports drop column if exists severity;

commit;

select 'impacts migration applied'                     as step,
       (select count(*) from public.reports)           as reports,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'reports'
           and column_name = 'impacts')                as impacts_column,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'reports'
           and column_name = 'severity')               as severity_column;
