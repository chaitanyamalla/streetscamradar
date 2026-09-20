-- ---------------------------------------------------------------------------
-- Why is a member's own report not on the map?
--
-- Read-only. Deliberately prints no email address, no description and no full
-- reporter id: this runs in a GitHub Actions log on a public repository.
-- ---------------------------------------------------------------------------
select 'window' as check, public.report_window() as report_window, now() as now_utc;

select 'member reports' as check,
       left(r.id::text, 8)                                  as id,
       left(coalesce(r.reporter_id::text, 'demo'), 8)       as reporter,
       r.status,
       r.category,
       r.impacts,
       round(r.lat::numeric, 3)                             as lat,
       round(r.lng::numeric, 3)                             as lng,
       coalesce(r.city, '-')                                as city,
       r.happened_at,
       age(now(), r.happened_at)                            as age,
       (r.happened_at > now() - public.report_window())      as inside_window,
       r.support_count,
       r.flag_count
  from public.reports r
 where r.reporter_id is not null
 order by r.happened_at desc;

-- Exactly what a signed-out visitor gets where those reports are.
select 'anon sees' as check, count(*) as reports_visible
  from public.reports r
 where r.reporter_id is not null
   and r.status = 'published'
   and r.happened_at > now() - public.report_window();
