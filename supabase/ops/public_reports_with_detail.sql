-- ---------------------------------------------------------------------------
-- Give signed-out visitors the report text.
--
-- public_sample_reports deliberately withheld `description`, because the public
-- view was a teaser: headline and pin only, with the account behind sign-up.
-- Now that everyone sees the reports, a pin you can click but not read is just
-- frustrating — so the detail comes with it.
--
-- The return type changes, so the function must be dropped and recreated;
-- CREATE OR REPLACE cannot alter OUT parameters.
-- ---------------------------------------------------------------------------
drop function if exists public.public_sample_reports(double precision, double precision, double precision, double precision);

create function public.public_sample_reports(
  min_lat double precision, min_lng double precision,
  max_lat double precision, max_lng double precision
)
returns table (
  id uuid, category text, severity text, headline text, description text,
  lat double precision, lng double precision,
  address text, city text, country_code char(2),
  happened_at timestamptz, support_count int, total_in_view bigint
)
language sql stable security definer set search_path = public as $$
  with bounds as (
    select least(min_lat, max_lat) as y0, greatest(min_lat, max_lat) as y1,
           least(min_lng, max_lng) as x0, greatest(min_lng, max_lng) as x1
  ),
  visible as (
    select r.id, r.category, r.severity, r.headline, r.description,
           r.lat, r.lng, r.address, r.city, r.country_code,
           r.happened_at, r.support_count
      from public.reports r, bounds b
     where r.status = 'published'
       and r.happened_at > now() - public.report_window()
       and r.lat between b.y0 and b.y1
       and r.lng between b.x0 and b.x1
       and (b.y1 - b.y0) <= public.setting_num('public_detail_max_span', 0.35)
       and (b.x1 - b.x0) <= public.setting_num('public_detail_max_span', 0.35)
  )
  select v.*, (select count(*) from visible) as total_in_view
    from visible v
   order by (v.severity = 'high') desc, v.support_count desc, v.happened_at desc
   limit public.setting_int('public_sample_limit', 5);
$$;

-- Still no reporter_id, and still no direct table access for anon.
revoke all on function public.public_sample_reports(double precision, double precision, double precision, double precision) from public;
grant execute on function public.public_sample_reports(double precision, double precision, double precision, double precision) to anon, authenticated;

-- Check it as the role the website actually uses.
begin;
set local role anon;
select 'ANON SEES DETAIL' as check, count(*) as reports,
       count(*) filter (where description is not null and length(description) > 20) as with_text
  from public.public_sample_reports(48.80, 2.25, 48.92, 2.42);
select 'ANON STILL BLOCKED FROM TABLE' as check,
       has_table_privilege('anon','public.reports','SELECT') as can_read_table;
rollback;
