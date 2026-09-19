-- Removes every demo report seeded by seed_demo.sql, and nothing else.
-- Real reports always carry a reporter_id, so this cannot touch them.
delete from public.reports where reporter_id is null;
select 'REMOVED' as step,
       (select count(*) from public.reports where reporter_id is null) as demo_left,
       (select count(*) from public.reports) as real_reports_remaining;
