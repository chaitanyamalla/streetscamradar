-- ---------------------------------------------------------------------------
-- Does admin_members actually run on this database?
--
-- It did not: it declared `email text` against an auth.users whose email is
-- varchar(255), and plpgsql refused the whole function with "structure of
-- query does not match function result type". That failed only on the real
-- database, because the test shim said text.
--
-- So this calls it for real. Nicknames and roles only — no email addresses,
-- because this workflow's logs are public.
-- ---------------------------------------------------------------------------
select count(*) as members_the_admin_screen_can_see
  from public.admin_members(null, 100);

select coalesce(nullif(btrim(m.display_name), ''), '(no nickname)') as goes_by,
       m.role, m.level, m.points, m.reports
  from public.admin_members(null, 100) m
 order by m.points desc;

-- And the other four screens, each called once. A count rather than the rows:
-- what is being asked is whether the function runs at all.
select 'reports'  as screen, count(*) as rows_it_returns from public.admin_reports('all', null, 100)
union all
select 'regions',  count(*) from public.admin_region_catalog()
union all
select 'settings', count(*) from public.admin_settings()
union all
select 'levels',   count(*) from public.contributor_levels;
