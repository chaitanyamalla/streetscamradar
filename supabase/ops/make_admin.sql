-- ---------------------------------------------------------------------------
-- Make somebody an admin, by the name they go by.
--
-- The first admin can only be made here, or in the Supabase SQL editor:
-- /admin refuses anybody who is not already one, which is the point of it.
-- After this, every other role change can happen on that page.
--
-- BY NICKNAME, NOT BY EMAIL, and that is deliberate. This workflow's logs are
-- public and so is this repository, so an email address written here would be
-- published along with it. A nickname is a handle somebody chose to go by, and
-- it is already on the contributors report. Use supabase/ops/contributors.sql
-- to see the nicknames.
--
-- An ambiguous nickname is REFUSED with the matches named, never guessed at —
-- display_name is not unique, so the one thing this must never do is quietly
-- hand the site to the wrong person. If it refuses, run the same thing in the
-- Supabase SQL editor with the email address or the id, where neither is
-- public.
-- ---------------------------------------------------------------------------

-- Edit this line, then run this file from the Database workflow.
\set who 'chaitanyamalla1993'

-- --- Who that is, before anything changes -----------------------------------
select coalesce(nullif(btrim(p.display_name), ''), '(no nickname)') as goes_by,
       p.role                                      as role_now,
       public.member_level(p.id)                   as level,
       public.contribution_points(p.id)            as points
  from public.profiles p
 where p.id = public.find_member(:'who');

-- --- Make them one ----------------------------------------------------------
update public.profiles set role = 'admin'
 where id = public.find_member(:'who');

-- --- Who can administer the site now ----------------------------------------
select coalesce(nullif(btrim(p.display_name), ''), '(no nickname)') as goes_by,
       p.role
  from public.profiles p
 where p.role <> 'member'
 order by p.role, 1;

-- --- Taking it back ---------------------------------------------------------
-- From /admin, by whoever is an admin. Or here:
--
--   update public.profiles set role = 'member'
--    where id = public.find_member('their-nickname');
--
-- The page refuses to leave the site with no admin at all; this file does not
-- check that, because this file is how you recover from exactly that.
