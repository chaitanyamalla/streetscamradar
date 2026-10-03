-- ---------------------------------------------------------------------------
-- Who is contributing, what level they are on, and how to give them a badge.
--
-- SAFE TO RUN IN THE DATABASE WORKFLOW. Nothing below prints an email address
-- or anything that identifies a particular report, because that workflow's
-- logs are public and this repository is public with them. The view that DOES
-- carry emails is public.admin_contributors, and it is for the Supabase SQL
-- editor only — there is a recipe for it at the bottom, commented out, so it
-- cannot be run here by accident.
-- ---------------------------------------------------------------------------

-- --- The ladder ------------------------------------------------------------
-- Ten levels. Retune any threshold here and every level recomputes at once;
-- nothing is stored against a member, so nobody is left on a level the table
-- no longer agrees with.
select level, min_points from public.contributor_levels order by level;

-- --- What a point is worth -------------------------------------------------
select key, value, note from public.app_settings
 where key like 'points_%' order by key;

-- --- Everyone, by contribution ---------------------------------------------
-- Nicknames only. A member who has not chosen one shows as the name they were
-- given on sign-up, which is why the column is headed "goes by" rather than
-- "name".
select coalesce(nullif(btrim(p.display_name), ''), '(no nickname)') as goes_by,
       public.level_for(public.contribution_points(p.id))           as level,
       public.contribution_points(p.id)                             as points,
       (select count(*) from public.reports r
         where r.reporter_id = p.id and r.status = 'published')     as reports,
       coalesce((select array_agg(b.badge order by b.granted_at)
                   from public.contributor_badges b
                  where b.profile_id = p.id), '{}')                 as badges,
       p.listed                                                     as on_the_board
  from public.profiles p
 order by 3 desc, p.created_at
 limit 50;

-- --- How the levels are actually distributed -------------------------------
-- The number worth watching. If almost everybody sits on level 1 and 2, the
-- bottom of the ladder is too far apart; if half the site is on level 10, it
-- is too close together. Either is a reason to change contributor_levels, and
-- neither is a reason to add more levels.
select public.level_for(public.contribution_points(p.id)) as level,
       count(*) as members
  from public.profiles p
 group by 1 order by 1;

-- --- Badges handed out so far ----------------------------------------------
select b.badge, count(*) as people, max(b.granted_at) as most_recent
  from public.contributor_badges b group by 1 order by 2 desc;

-- --- Who can administer the site -------------------------------------------
-- Nicknames only, for the same reason as above. If this comes back empty,
-- nobody can open /admin.html and the first admin has to be made by hand —
-- see the recipe at the bottom of this file.
select coalesce(nullif(btrim(p.display_name), ''), '(no nickname)') as goes_by,
       p.role
  from public.profiles p
 where p.role <> 'member'
 order by p.role, 1;


-- ===========================================================================
-- GIVING SOMEBODY A BADGE — run these in the Supabase SQL editor, not here.
--
-- Not here because they take a person as an argument, and the argument would
-- then be committed to a public repository. A nickname is one somebody chose
-- to go by; an email address is not, and this file is on GitHub.
--
-- The four badges, and what they are for:
--
--   creator   makes videos or posts about street scams and sends people here.
--             The reason this exists: points measure reports filed, and
--             somebody who films scams in Barcelona for an audience of
--             thousands may never file one while being the most useful person
--             on the site.
--   top       a contributor you want named at the top of the board whatever
--             the arithmetic says.
--   founder   was here early, when the map was mostly empty.
--   partner   an organisation rather than a person.
--
-- Another kind? Add it to the check constraint on contributor_badges and to
-- badge.* in js/locales — the page shows a badge it has no string for as
-- nothing at all, which is the safe way round but not the one you want.
-- ---------------------------------------------------------------------------
--
-- Find the person first. Nickname, email, or the id — whichever you have:
--
--   select * from public.admin_contributors
--    where display_name ilike '%ana%' or email ilike '%ana%';
--
-- Then grant. The same three forms work here, and an ambiguous nickname is
-- REFUSED with the list of people it matched rather than guessed at:
--
--   select * from public.grant_badge('ana', 'creator', 'Scam awareness reels, 40k followers');
--   select * from public.grant_badge('ana@example.com', 'top');
--   select * from public.grant_badge('6f1c…-the-uuid', 'founder');
--
-- Granting also puts them on the contributors board, because that is normally
-- the point. For a badge that is only for your own records:
--
--   select * from public.grant_badge('ana', 'partner', 'Tourism board', false);
--
-- Taking one back. Returns how many rows went, so 0 means it was not there:
--
--   select public.revoke_badge('ana', 'creator');
--
-- The whole dashboard, with email addresses — SQL editor only:
--
--   select * from public.admin_contributors order by points desc limit 50;
--
-- ---------------------------------------------------------------------------
-- MAKING THE FIRST ADMIN. There is nowhere else this can be done: /admin.html
-- refuses anybody who is not already an admin, which is the point of it.
--
--   update public.profiles set role = 'admin'
--    where id = (select id from auth.users where email = 'you@example.com');
--
-- After that, every other role change can happen on the page. Two things it
-- will refuse: the last admin demoting themselves, and an admin removing
-- themselves — both leave a site nobody can administer, with this editor as
-- the only way back.
--
-- ---------------------------------------------------------------------------
-- WHAT A BADGE DOES NOT DO. It does not change anybody's level, it does not
-- make their reports count for more, and it does not attach their name to a
-- report. Reports stay anonymous — reports_feed drops reporter_id on purpose
-- — and the board names a member, a level and a badge without ever saying
-- which pin on the map is theirs.
