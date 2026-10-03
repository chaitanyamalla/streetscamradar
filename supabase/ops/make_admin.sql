-- ---------------------------------------------------------------------------
-- Make somebody an admin.
--
-- THIS FILE IS ONLY FOR THE FIRST ONE. /admin refuses anybody who is not
-- already an admin, so the first has to be made from outside it. After that,
-- every role change happens on the Members screen: find the person by nickname
-- or email, read their address, their level, how many reports they filed and
-- when they joined, and set the role from a dropdown. That is a better way to
-- identify somebody than any string typed into a file, and it is the one to
-- use unless there is no admin at all.
--
-- THREE WAYS TO NAME SOMEBODY, and which you use depends on WHERE you run it:
--
--   nickname   The handle they go by. Safe to commit — it is already on the
--              contributors report, and the Database workflow's logs are
--              public along with this repository.
--   email      Precise, and NOT safe to commit: writing one here publishes it.
--              Use it in the Supabase SQL editor, which is private.
--   user id    The uuid from admin_contributors. Precise, and meaningless to
--              anybody who does not already have the database. Either place.
--
-- Whichever you give it, an ambiguous match is REFUSED with the candidates
-- named rather than guessed at. display_name is not unique and cannot safely
-- be made unique — two people who signed up as john@gmail.com and
-- john@yahoo.com are both "john" through nobody's fault — so the one thing
-- this must never do is quietly hand the site to the wrong person.
-- ---------------------------------------------------------------------------

-- --- Who is there, and what are they called --------------------------------
-- Nicknames only, because this file is usually run where the output is public.
-- For the version with email addresses, see the SQL editor recipe below.
select coalesce(nullif(btrim(p.display_name), ''), '(no nickname)') as goes_by,
       p.role,
       public.member_level(p.id)        as level,
       public.contribution_points(p.id) as points,
       p.created_at::date               as joined
  from public.profiles p
 order by p.created_at;

-- --- Who to make an admin ---------------------------------------------------
-- A nickname, an email address, or a user id. Edit this one line.
\set who 'chaitanyamalla1993'

-- --- Them, before anything changes ------------------------------------------
select coalesce(nullif(btrim(p.display_name), ''), '(no nickname)') as goes_by,
       p.role                           as role_now,
       public.member_level(p.id)        as level,
       public.contribution_points(p.id) as points
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


-- ===========================================================================
-- IN THE SUPABASE SQL EDITOR, where nothing is published
-- ===========================================================================
-- The whole list, with email addresses and ids, so you can pick somebody with
-- certainty rather than by a handle two people might share:
--
--   select id, display_name, email, role, level, points, reports, created_at
--     from public.admin_contributors order by created_at;
--
-- Then any of these:
--
--   update public.profiles set role = 'admin'
--    where id = public.find_member('ana@example.com');
--
--   update public.profiles set role = 'admin'
--    where id = '6f1c…-the-uuid-from-above';
--
-- Taking it back. From the Members screen normally; here if you have locked
-- yourself out, which is the one thing that screen will not let you do:
--
--   update public.profiles set role = 'member'
--    where id = public.find_member('their-nickname');
--
-- The page refuses to leave the site with no admin at all. This file does not
-- check that, because this file is how you recover from exactly that.
