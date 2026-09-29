-- ---------------------------------------------------------------------------
-- Open or close a region to new reports.
--
-- Run from the Supabase SQL editor, or through the Database workflow. Takes
-- effect immediately — no deploy, no release. Reading is never affected:
-- everything already on the map stays visible everywhere, to everyone.
--
-- Countries are ISO 3166-1 alpha-2 codes (TH, MX, FR).
-- Continents are ours: AF AN AS EU NA OC SA.
--
-- Two of the continent codes are also country codes — AS is American Samoa,
-- NA is Namibia — which is why the two lists are separate rather than one.
-- ---------------------------------------------------------------------------

-- What is closed right now, and what that works out to.
select value as setting,
       coalesce(cardinality(public.blocked_countries()), 0) as countries_closed
  from public.app_settings where key = 'blocked_regions';

-- --- Close somewhere -------------------------------------------------------
-- Edit the lists and run. Both keys must be present; use [] for none.
--
-- update public.app_settings
--    set value = '{"countries": ["TH"], "continents": []}'
--  where key = 'blocked_regions';

-- --- Open everything again -------------------------------------------------
--
-- update public.app_settings
--    set value = '{"countries": [], "continents": []}'
--  where key = 'blocked_regions';

-- --- Check it did what you meant -------------------------------------------
-- Spot-check any country before and after:
--
-- select public.reporting_allowed('TH') as thailand,
--        public.reporting_allowed('FR') as france;
--
-- And the whole list, with names, so a continent block can be read back:
--
-- select code, public.blocked_countries() @> array[code] as closed
--   from unnest(public.blocked_countries()) as code order by 1;

-- --- What this does NOT do -------------------------------------------------
-- It does not hide reports already filed there, and it does not stop anyone
-- reading the map. It refuses new reports, in the browser with a plain message
-- and in the insert policy underneath, which is the one that holds.
--
-- The honest limit: a report carries the country its reporter's browser was
-- told it was in, so the check is only as good as that. While any block is in
-- force, a report with no country at all is refused for the same reason.
