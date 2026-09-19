-- ---------------------------------------------------------------------------
-- Open the public view up while the map holds demo data.
--
-- The cap and the zoom gate are settings, not code, precisely so this is a
-- one-line change. To put the limit back later:
--   update public.app_settings set value = '5' where key = 'public_sample_limit';
-- ---------------------------------------------------------------------------
update public.app_settings
   set value = '500',
       note  = 'Max reports a signed-out visitor sees when zoomed in. Raised while the map holds demo data; put back to 5 once real reports arrive.'
 where key = 'public_sample_limit';

-- Slightly more forgiving, so a whole-city view counts as "zoomed in" rather
-- than only a district. Still a gate: a continent-wide view shows counts only.
update public.app_settings
   set value = '1.0',
       note  = 'Signed-out visitors see individual reports only when the map spans fewer degrees than this.'
 where key = 'public_detail_max_span';

select key, value #>> '{}' as value from public.app_settings order by key;

-- Prove it through the same function the website calls, as the anon role.
set local role anon;
select 'ANON, ZOOMED INTO PARIS' as check, count(*) as reports_visible
  from public.public_sample_reports(48.80, 2.25, 48.92, 2.42);
select 'ANON, WHOLE OF EUROPE' as check, count(*) as individual_reports
  from public.public_sample_reports(35, -10, 60, 30);
select 'ANON, WHOLE OF EUROPE' as check, sum(total) as counted_in_summary
  from public.public_area_summary(35, -10, 60, 30);
