-- ---------------------------------------------------------------------------
-- Does the admin console actually run on this database?
--
-- It did not: admin_members declared `email text` against an auth.users whose
-- email is varchar(255), and plpgsql refused the whole function with
-- "structure of query does not match function result type". That could only
-- ever fail on the real database, because the test shim said text — so the fix
-- is checked here, where it failed.
--
-- The first attempt at this file got "sign in required", which is the guard
-- working: the workflow connects with no JWT, so auth.uid() is null and
-- admin_required() refuses it, exactly as it refuses a signed-out browser.
-- So the session claims to be the admin for the length of this file — set from
-- the table rather than typed, so no id is written here or printed.
--
-- Nicknames and roles only in the output. These logs are public.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub',
                  (select id::text from public.profiles where role = 'admin'
                    order by created_at limit 1), false) is not null
       as speaking_as_the_first_admin;

select count(*) as members_the_admin_screen_can_see
  from public.admin_members(null, 100);

select coalesce(nullif(btrim(m.display_name), ''), '(no nickname)') as goes_by,
       m.role, m.level, m.points, m.reports
  from public.admin_members(null, 100) m
 order by m.points desc;

-- The other four screens, each called once. A count rather than the rows: what
-- is being asked is whether the function runs at all.
select 'reports'  as screen, count(*) as rows_it_returns from public.admin_reports('all', null, 100)
union all
select 'regions',  count(*) from public.admin_region_catalog()
union all
select 'settings', count(*) from public.admin_settings()
union all
select 'levels',   count(*) from public.contributor_levels;

select set_config('request.jwt.claim.sub', '', false) = '' as claim_dropped;
