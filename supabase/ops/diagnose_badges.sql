-- ---------------------------------------------------------------------------
-- Did the badge work actually land, on the live database?
--
-- Run from the Database workflow, whose logs are PUBLIC on this repository.
-- So: no emails, no display names, no report text, and no full ids. What comes
-- out is shapes and counts — which badges exist, how many people have each,
-- and whether the rename moved the rows it was supposed to.
--
--   Actions -> Database -> Run workflow -> supabase/ops/diagnose_badges.sql
-- ---------------------------------------------------------------------------
\pset pager off

\echo '== the badge list the table will now accept =='
select pg_get_constraintdef(oid) as allowed
  from pg_constraint
 where conname = 'contributor_badges_badge_check';

\echo ''
\echo '== the granted column arrived =='
select column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'public' and table_name = 'contributor_badges'
 order by ordinal_position;

\echo ''
\echo '== the new functions are there =='
select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('earned_badges', 'badges_of', 'badge_rungs',
                     'admin_clear_badge', 'admin_badge_overrides')
 order by 1;

\echo ''
\echo '== what each rung costs, as the database has it =='
select * from public.badge_rungs();

\echo ''
\echo '== hand-set decisions, by badge. No names. =='
-- 'founder' appearing here would mean the rename did not run.
select badge, granted, count(*) as people
  from public.contributor_badges
 group by 1, 2 order by 1, 2;

\echo ''
\echo '== what members actually hold now, earned and all =='
-- Counted over every profile, naming nobody.
select b.badge, count(*) as people
  from public.profiles p
  cross join lateral unnest(public.badges_of(p.id)) as b(badge)
 group by 1 order by 2 desc, 1;

\echo ''
\echo '== and how many members have no badge at all =='
select count(*) filter (where cardinality(public.badges_of(p.id)) = 0) as none,
       count(*) filter (where cardinality(public.badges_of(p.id)) > 0) as some,
       count(*) as members
  from public.profiles p;
