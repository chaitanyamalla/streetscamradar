-- ---------------------------------------------------------------------------
-- Open or close somewhere to new reports.
--
-- Run from the Supabase SQL editor, or through the Database workflow. Takes
-- effect immediately — no deploy, no release. Reading is never affected:
-- everything already on the map stays visible everywhere, to everyone.
--
-- You should almost never list countries one by one. Close a GROUP:
--
--   continent  AF AN AS EU NA OC SA
--   zone       western-europe, south-eastern-asia, caribbean, northern-africa,
--              western-asia, eastern-africa … the UN M49 sub-regions
--   union      eu, schengen
--
-- The `countries` list is there for the odd exception, not for the usual case.
-- ---------------------------------------------------------------------------

-- --- The menu --------------------------------------------------------------
select kind, group_code, countries, members from public.region_catalog
 order by kind, group_code;

-- --- What is closed right now ----------------------------------------------
select value as setting,
       coalesce(cardinality(public.blocked_countries()), 0) as countries_closed
  from public.app_settings where key = 'blocked_regions';

-- --- Close somewhere -------------------------------------------------------
-- One zone:
--   update public.app_settings
--      set value = '{"countries": [], "groups": ["south-eastern-asia"]}'
--    where key = 'blocked_regions';
--
-- A continent:
--   update public.app_settings
--      set value = '{"countries": [], "groups": ["AF"]}'
--    where key = 'blocked_regions';
--
-- Several handles and one extra country:
--   update public.app_settings
--      set value = '{"countries": ["MX"], "groups": ["caribbean", "schengen"]}'
--    where key = 'blocked_regions';

-- --- Open everything again -------------------------------------------------
--   update public.app_settings
--      set value = '{"countries": [], "groups": []}'
--    where key = 'blocked_regions';

-- --- Read back what you actually did ---------------------------------------
-- Never trust the handle, check the list — a zone is a standard, not a guess
-- at what you meant:
--
--   select unnest(public.blocked_countries()) as closed order by 1;
--   select public.reporting_allowed('TH'), public.reporting_allowed('FR');

-- --- What this does NOT do -------------------------------------------------
-- It does not hide reports already filed there, and it does not stop anyone
-- reading the map. It refuses NEW reports: in the browser with a plain
-- message, before the sign-in gate, and in the insert policy underneath, which
-- is the one that holds.
--
-- The honest limit: a report carries the country its reporter's browser was
-- told it was in, so the check is only as good as that. While any block is in
-- force, a report with no country at all is refused for the same reason.
