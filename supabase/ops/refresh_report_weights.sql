-- ---------------------------------------------------------------------------
-- Recompute reports.reporter_weight for every report.
--
-- The column is stamped when a report is filed, from the author's standing at
-- that moment — see member_weight() in schema.sql. That is deliberate: it
-- keeps the ordering cheap, and climbing to level 10 does not retroactively
-- lift everything somebody filed as a beginner.
--
-- It does mean two cases need this file:
--
--   rows that predate the column, which all carry the default 0
--   a change to the weights in member_weight(), which old rows will not know
--
-- Safe to run whenever. It writes only this one column, touches nothing a
-- reader sees directly, and recomputing it twice gives the same answer.
--
-- Run: Database workflow, file = supabase/ops/refresh_report_weights.sql
-- ---------------------------------------------------------------------------
begin;

update public.reports r
   set reporter_weight = case
         when r.reporter_id is null then 0
         else public.member_weight(r.reporter_id)
       end
 where r.reporter_weight is distinct from case
         when r.reporter_id is null then 0
         else public.member_weight(r.reporter_id)
       end;

commit;

-- Shapes and counts only. No headlines, no reporter ids, nothing about who.
select reporter_weight, count(*) as reports
  from public.reports
 group by reporter_weight
 order by reporter_weight;

select count(*) as reports_total,
       count(*) filter (where reporter_id is null) as sample_pins,
       count(*) filter (where reporter_weight = 0 and reporter_id is not null) as weight_zero
  from public.reports;
