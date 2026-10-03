-- ---------------------------------------------------------------------------
-- Levels, badges and who may read what — against a real Postgres.
--
-- Run it with supabase/test/run.sh, which applies the shim and schema.sql to a
-- scratch database first. Nothing here is mocked: these are the actual
-- functions, the actual policies and the actual grants.
--
-- The arithmetic is checked against numbers written out in the comments, so a
-- points function that always returned zero could not pass. The privilege
-- assertions at the end were checked by putting a REVOKE back and watching
-- them fail, which is the only way to know a "cannot read this" test is
-- testing anything at all.
-- ---------------------------------------------------------------------------
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

create table if not exists pg_temp.failures (label text);
create table if not exists pg_temp.ran (label text);
-- The test switches to the `authenticated` role to check what a member can see,
-- and its own bookkeeping has to keep working while it is there.
grant insert on pg_temp.failures, pg_temp.ran to public;

create or replace function pg_temp.check(ok boolean, label text) returns void
language plpgsql as $$
begin
  raise notice '%  %', case when ok then '  ok  ' else '  FAIL' end, label;
  insert into pg_temp.ran values (label);
  if ok is not true then insert into pg_temp.failures values (label); end if;
end $$;

-- --- Three members, and some history ---------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'ana@example.com',  '{"full_name": "Ana Beltran"}'),
  ('22222222-2222-2222-2222-222222222222', 'bo@example.com',   '{}'),
  ('33333333-3333-3333-3333-333333333333', 'ana@other.test',   '{"name": "Ana B"}');

do $$
declare ana uuid := '11111111-1111-1111-1111-111111111111';
        bo  uuid := '22222222-2222-2222-2222-222222222222';
        r   uuid;
begin
  -- Ana files four, Bo files one.
  for i in 1..4 loop
    insert into public.reports (reporter_id, category, headline, description, lat, lng, happened_at)
    values (ana, 'pickpocket', 'Something happened here ' || i, 'detail', 48.86, 2.33, now() - interval '1 hour')
    returning id into r;
    -- Two of Ana's get one confirmation each, from Bo.
    if i <= 2 then insert into public.report_supports (report_id, user_id) values (r, bo); end if;
  end loop;

  insert into public.reports (reporter_id, category, headline, description, lat, lng, happened_at)
  values (bo, 'taxi', 'Bo saw a thing happen', 'detail', 48.86, 2.33, now() - interval '1 hour')
  returning id into r;
  -- Ana confirms Bo's.
  insert into public.report_supports (report_id, user_id) values (r, ana);
end $$;

-- --- The sign-up trigger ---------------------------------------------------
select pg_temp.check(
  (select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 'Ana Beltran',
  'a Google-style sign-up is named from full_name, not from the email address');
select pg_temp.check(
  (select display_name from public.profiles where id = '22222222-2222-2222-2222-222222222222') = 'bo',
  'and an email sign-up still falls back to the local part');

-- --- Points ----------------------------------------------------------------
-- Ana: 4 reports x 5 = 20, 2 confirmations received x 4 = 8, 1 given x 1 = 1.
select pg_temp.check(public.contribution_points('11111111-1111-1111-1111-111111111111') = 29,
  'four reports, two confirmations on them and one given is 29 (got '
  || public.contribution_points('11111111-1111-1111-1111-111111111111') || ')');
-- Bo: 1 report x 5 = 5, 0 received, 2 given x 1 = 2.
-- Bo: 1 report x 5 = 5, 1 confirmation received from Ana x 4 = 4, 2 given x 1 = 2.
select pg_temp.check(public.contribution_points('22222222-2222-2222-2222-222222222222') = 11,
  'one report, one confirmation on it and two given is 11 (got '
  || public.contribution_points('22222222-2222-2222-2222-222222222222') || ')');

-- --- The ladder ------------------------------------------------------------
select pg_temp.check((select count(*) from public.contributor_levels) = 10, 'the ladder has ten rungs');
select pg_temp.check(public.level_for(0) = 1,   'nothing filed is level 1, never level 0');
select pg_temp.check(public.level_for(-5) = 1,  'and so is a negative, which should be impossible anyway');
select pg_temp.check(public.level_for(9) = 1 and public.level_for(10) = 2,
  'the first rung is crossed at exactly its own threshold');
select pg_temp.check(public.level_for(29) = 3,  'Ana is on level 3');
select pg_temp.check(public.level_for(99999) = 10, 'and the top of the ladder is the top');

-- --- Confirming your own report earns nothing ------------------------------
do $$
declare bo uuid := '22222222-2222-2222-2222-222222222222'; own uuid;
begin
  select id into own from public.reports where reporter_id = bo limit 1;
  insert into public.report_supports (report_id, user_id) values (own, bo);
end $$;
select pg_temp.check(public.contribution_points('22222222-2222-2222-2222-222222222222') = 11,
  'a confirmation by the report''s own author is worth nothing on either side (got '
  || public.contribution_points('22222222-2222-2222-2222-222222222222') || ')');

-- --- Retuning the weights recomputes everyone ------------------------------
update public.app_settings set value = '10' where key = 'points_per_report';
select pg_temp.check(public.contribution_points('11111111-1111-1111-1111-111111111111') = 49,
  'changing a weight in app_settings moves every level at once (got '
  || public.contribution_points('11111111-1111-1111-1111-111111111111') || ')');
update public.app_settings set value = '5' where key = 'points_per_report';

-- --- my_standing, as the member themselves ---------------------------------
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.check(
  (select points = 29 and level = 3 and level_floor = 25 and next_level = 4
          and next_points = 50 and reports = 4 and received = 2 and given = 1
     from public.my_standing()),
  'my_standing agrees with the parts it is made of');
select pg_temp.check((select listed = false and badges = '{}' from public.my_standing()),
  'and a new member is on no board and has no badge');
reset role; reset request.jwt.claim.sub;
select pg_temp.check((select count(*) from public.my_standing()) = 0,
  'and a caller it cannot identify gets no row at all, rather than a zeroed one');

-- --- A badge, by each of the three things you might know --------------------
select pg_temp.check(
  (select goes_by from public.grant_badge('Ana Beltran', 'creator', 'Reels about Barcelona')) = 'Ana Beltran',
  'a badge can be granted by the name somebody goes by');
select pg_temp.check(
  (select count(*) from public.grant_badge('bo@example.com', 'founder')) = 1,
  'or by their email address');
select pg_temp.check(
  (select count(*) from public.grant_badge('11111111-1111-1111-1111-111111111111', 'top')) = 1,
  'or by the id straight out of admin_contributors');
select pg_temp.check(
  (select array_agg(badge order by badge) from public.contributor_badges
    where profile_id = '11111111-1111-1111-1111-111111111111') = array['creator','top'],
  'and somebody can hold more than one, which is why this is a table');

-- An ambiguous nickname is refused, with the matches named. The clash is made
-- here rather than in the fixture, so that everything above is testing the
-- ordinary case.
update public.profiles set display_name = 'Ana Beltran'
 where id = '33333333-3333-3333-3333-333333333333';
do $$
declare said text;
begin
  perform public.grant_badge('Ana Beltran', 'partner');
  perform pg_temp.check(false, 'an ambiguous nickname should not have been accepted');
exception when others then
  said := sqlerrm;
  perform pg_temp.check(said like '%2 people%', 'an ambiguous nickname is refused: ' || said);
end $$;

do $$
declare said text;
begin
  perform public.grant_badge('nobody-at-all', 'top');
  perform pg_temp.check(false, 'a name nobody has should not have been accepted');
exception when others then
  perform pg_temp.check(sqlerrm like '%nobody here is called%', 'and so is a name nobody has');
end $$;

-- Granting puts somebody on the board; revoking a badge does not take them off.
select pg_temp.check(
  (select listed from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'granting a badge also puts them on the board, which is normally the point');
select pg_temp.check(public.revoke_badge('bo@example.com', 'founder') = 1,
  'a badge can be taken back');
select pg_temp.check(public.revoke_badge('bo@example.com', 'founder') = 0,
  'and taking back one that is not there says so rather than failing');

-- --- The board -------------------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
-- Two, not one: Bo was listed when the founder badge was granted and taking
-- the badge back does not take the consent back. That is deliberate — being
-- named is the member's decision, not a side effect of ours.
select pg_temp.check((select count(*) from public.contributors_board(20)) = 2,
  'the board lists the members who are on it, and nobody else');
select pg_temp.check(
  (select array_agg(display_name order by points desc) from public.contributors_board(20))
    = array['Ana Beltran', 'bo'],
  'best first, by points');
select pg_temp.check(
  (select level from public.contributors_board(20) where display_name = 'Ana Beltran') = 3,
  'with a level each');
select pg_temp.check(
  (select badges from public.contributors_board(20) where display_name = 'bo') = '{}',
  'and no badge left on the member whose badge was revoked');
reset role; reset request.jwt.claim.sub;
select pg_temp.check(
  (select listed from public.profiles where id = '22222222-2222-2222-2222-222222222222'),
  'who is still listed, because that was their decision and not the badge''s');

-- --- What the board must never carry ---------------------------------------
select pg_temp.check(
  not exists (select 1 from information_schema.columns
               where table_name = 'contributors_board'),
  'the board is a function, not a table anyone can widen with a join');

-- --- Who may read what -----------------------------------------------------
select pg_temp.check(
  not has_function_privilege('anon', 'public.my_standing()', 'execute'),
  'a signed-out visitor cannot ask for anybody''s standing');
select pg_temp.check(
  not has_function_privilege('anon', 'public.contributors_board(int)', 'execute'),
  'nor read the board');
select pg_temp.check(
  not has_function_privilege('authenticated', 'public.grant_badge(text,text,text,boolean)', 'execute'),
  'and a signed-in member cannot grant themselves a badge');
select pg_temp.check(
  not has_function_privilege('authenticated', 'public.find_member(text)', 'execute'),
  'nor look somebody up by email through find_member');
select pg_temp.check(
  not has_table_privilege('authenticated', 'public.admin_contributors', 'select'),
  'the dashboard with the email addresses is for the service role alone');
select pg_temp.check(
  not has_table_privilege('authenticated', 'public.contributor_badges', 'select'),
  'and the badges table is read through the two functions, never directly');

-- --- The dashboard itself --------------------------------------------------
select pg_temp.check(
  (select email = 'ana@example.com' and level = 3 and points = 29 and reports = 4
     from public.admin_contributors where display_name = 'Ana Beltran' and email = 'ana@example.com'),
  'admin_contributors joins the nickname, the address, the level and the count');

-- --- Withdrawing a report takes its points with it -------------------------
do $$
declare ana uuid := '11111111-1111-1111-1111-111111111111';
begin
  delete from public.reports r where r.reporter_id = ana
    and r.id = (select id from public.reports where reporter_id = ana
                 and support_count = 0 limit 1);
end $$;
select pg_temp.check(public.contribution_points('11111111-1111-1111-1111-111111111111') = 24,
  'withdrawing an unconfirmed report costs its 5 points (got '
  || public.contribution_points('11111111-1111-1111-1111-111111111111') || ')');


-- ===========================================================================
-- Roles, and the admin page's calls
-- ===========================================================================
-- Nobody is an admin to begin with. The first one is made in the SQL editor,
-- which is the only place that can be done, and that is deliberate.
select pg_temp.check((select count(*) from public.profiles where role = 'admin') = 0,
  'a fresh install has no admins at all');
select pg_temp.check(not public.is_admin('11111111-1111-1111-1111-111111111111'),
  'and filing reports does not make you one');

update public.profiles set role = 'admin'
 where id = '11111111-1111-1111-1111-111111111111';
select pg_temp.check(public.is_admin('11111111-1111-1111-1111-111111111111'),
  'the first admin is made by hand, in the SQL editor');

-- --- A member cannot use any of it ------------------------------------------
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$
declare n int;
begin
  select count(*) into n from public.admin_members(null, 10);
  perform pg_temp.check(false, 'a member should not be able to list the members');
exception when others then
  perform pg_temp.check(sqlerrm = 'admins only', 'a member listing members is refused: ' || sqlerrm);
end $$;
do $$
begin
  perform public.admin_set_role('22222222-2222-2222-2222-222222222222', 'admin');
  perform pg_temp.check(false, 'a member should not be able to make themselves an admin');
exception when others then
  perform pg_temp.check(sqlerrm = 'admins only', 'nor make themselves one: ' || sqlerrm);
end $$;
do $$
begin
  perform public.admin_remove_member('11111111-1111-1111-1111-111111111111');
  perform pg_temp.check(false, 'a member should not be able to remove the admin');
exception when others then
  perform pg_temp.check(sqlerrm = 'admins only', 'nor remove anybody: ' || sqlerrm);
end $$;
reset role; reset request.jwt.claim.sub;

-- --- A signed-out caller cannot either ---------------------------------------
set role authenticated;
do $$
begin
  perform public.admin_members(null, 10);
  perform pg_temp.check(false, 'a caller with no identity should be refused');
exception when others then
  perform pg_temp.check(sqlerrm = 'sign in required',
    'and a caller it cannot identify is told to sign in rather than told "no such member": ' || sqlerrm);
end $$;
reset role;

-- --- The admin can ----------------------------------------------------------
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select pg_temp.check((select count(*) from public.admin_members(null, 100)) = 3,
  'an admin sees every member');
select pg_temp.check(
  (select email from public.admin_members('bo@example', 100)) = 'bo@example.com',
  'and can find one by a fragment of their email address');
select pg_temp.check(
  (select count(*) from public.admin_members('ana', 100)) = 2,
  'or by a fragment of a nickname, which may well match two people');
select pg_temp.check(
  (select role from public.admin_members('bo@example', 100)) = 'member',
  'the list says what role each of them has');

-- Roles.
select pg_temp.check(
  public.admin_set_role('22222222-2222-2222-2222-222222222222', 'moderator') = 'moderator',
  'an admin can give somebody a role');
do $$
begin
  perform public.admin_set_role('22222222-2222-2222-2222-222222222222', 'wizard');
  perform pg_temp.check(false, 'a role that does not exist should be refused');
exception when others then
  perform pg_temp.check(sqlerrm like 'no such role%', 'a role that does not exist is refused');
end $$;

-- A level given rather than earned.
select pg_temp.check(public.admin_set_level('22222222-2222-2222-2222-222222222222', 8) = 8,
  'an admin can put somebody on a level their points do not reach');
select pg_temp.check(public.member_level('22222222-2222-2222-2222-222222222222') = 8
                 and public.level_for(public.contribution_points('22222222-2222-2222-2222-222222222222')) = 2,
  'the given level wins, and the earned one underneath it is untouched');
select pg_temp.check(public.admin_set_level('22222222-2222-2222-2222-222222222222', null) = 2,
  'and clearing it hands the member back to the arithmetic');
do $$
begin
  perform public.admin_set_level('22222222-2222-2222-2222-222222222222', 44);
  perform pg_temp.check(false, 'a level off the ladder should be refused');
exception when others then
  perform pg_temp.check(sqlerrm like 'there is no level%', 'a level the ladder does not have is refused');
end $$;

-- Badges, from the page rather than from the SQL editor.
select pg_temp.check(
  public.admin_set_badge('22222222-2222-2222-2222-222222222222', 'creator', true, 'Reels')
    = array['creator'],
  'an admin can give a badge from the page');
select pg_temp.check(
  public.admin_set_badge('22222222-2222-2222-2222-222222222222', 'creator', false) = '{}',
  'and take it off again');

-- --- The two ways to lock yourself out, both refused ------------------------
do $$
begin
  perform public.admin_set_role('11111111-1111-1111-1111-111111111111', 'member');
  perform pg_temp.check(false, 'the last admin should not be able to demote themselves');
exception when others then
  perform pg_temp.check(sqlerrm like 'that is the last admin%',
    'the last admin cannot demote themselves: ' || sqlerrm);
end $$;
do $$
begin
  perform public.admin_remove_member('11111111-1111-1111-1111-111111111111');
  perform pg_temp.check(false, 'an admin should not remove themselves here');
exception when others then
  perform pg_temp.check(sqlerrm like 'use Account settings%',
    'and removing yourself is sent to the ordinary door: ' || sqlerrm);
end $$;

-- With a second admin in place, the first may step down.
select pg_temp.check(
  public.admin_set_role('22222222-2222-2222-2222-222222222222', 'admin') = 'admin',
  'a second admin can be made');
select pg_temp.check(
  public.admin_set_role('11111111-1111-1111-1111-111111111111', 'member') = 'member',
  'and then the first can step down');
reset role; reset request.jwt.claim.sub;
select pg_temp.check(not public.is_admin('11111111-1111-1111-1111-111111111111'),
  'which really does take the role away');

-- --- Removing somebody takes their reports with them ------------------------
-- Counted outside the role, because `authenticated` has no select on reports
-- at all — the whole table is read through reports_feed. Being refused here
-- would say nothing about the removal.
select pg_temp.check(
  (select count(*) from public.reports where reporter_id = '11111111-1111-1111-1111-111111111111') > 0,
  'the member about to be removed has reports on the map');
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select pg_temp.check(public.admin_remove_member('11111111-1111-1111-1111-111111111111'),
  'an admin can remove a member');
reset role; reset request.jwt.claim.sub;
select pg_temp.check(
  (select count(*) from public.reports where reporter_id = '11111111-1111-1111-1111-111111111111') = 0,
  'and their reports go with them');
select pg_temp.check(
  (select count(*) from auth.users where id = '11111111-1111-1111-1111-111111111111') = 0
  and (select count(*) from public.profiles where id = '11111111-1111-1111-1111-111111111111') = 0,
  'along with the account itself and the profile that cascades from it');


-- ===========================================================================
-- The rest of the admin console
-- ===========================================================================
-- Bo is the admin by now; the member Ana was removed above. A second member
-- and a report to moderate.
insert into auth.users (id, email, raw_user_meta_data) values
  ('44444444-4444-4444-4444-444444444444', 'dee@example.com', '{"full_name": "Dee"}');

do $$
declare dee uuid := '44444444-4444-4444-4444-444444444444';
        bo  uuid := '22222222-2222-2222-2222-222222222222';
        r   uuid;
begin
  insert into public.reports (reporter_id, category, headline, description, lat, lng, happened_at)
  values (dee, 'pickpocket', 'A report somebody flagged', 'detail', 48.86, 2.33, now() - interval '2 hours')
  returning id into r;
  insert into public.report_flags (report_id, user_id, reason) values (r, bo, 'wrong');
end $$;

set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

-- --- Reports ----------------------------------------------------------------
select pg_temp.check((select count(*) from public.admin_reports('flagged', null, 50)) = 1,
  'the flagged filter finds the one report somebody flagged');
select pg_temp.check(
  (select reporter from public.admin_reports('flagged', null, 50)) = 'Dee',
  'and names who filed it — which reports_feed withholds from everyone else, '
  'because six reports from one account is the thing moderation is looking for');
select pg_temp.check(
  (select reasons from public.admin_reports('flagged', null, 50)) = array['wrong'],
  'with the reasons it was flagged for');
select pg_temp.check((select count(*) from public.admin_reports('all', null, 50)) >= 2,
  'and the all filter shows more than the flagged one');
select pg_temp.check((select count(*) from public.admin_reports('all', 'somebody flagged', 50)) = 1,
  'search narrows it by headline');

-- Approving clears the flags, so the same people cannot re-hide what an admin
-- has already looked at.
select pg_temp.check(
  public.admin_set_report_status(
    (select id from public.admin_reports('flagged', null, 50)), 'published') = 'published',
  'a flagged report can be approved');
select pg_temp.check((select count(*) from public.admin_reports('flagged', null, 50)) = 0,
  'and approving clears the flags with it');

do $$
declare r uuid;
begin
  select id into r from public.admin_reports('all', 'somebody flagged', 50);
  perform public.admin_set_report_status(r, 'under_review');
  perform pg_temp.check(
    (select count(*) from public.admin_reports('under_review', null, 50)) = 1,
    'a report can be taken off the map without deleting it');
  perform pg_temp.check(
    (select on_the_map from public.admin_reports('under_review', null, 50)) = false,
    'and the list says plainly that it is no longer on the map');
  begin
    perform public.admin_set_report_status(r, 'vanished');
    perform pg_temp.check(false, 'a status that does not exist should be refused');
  exception when others then
    perform pg_temp.check(sqlerrm like 'no such status%', 'a status that does not exist is refused');
  end;
  perform pg_temp.check(public.admin_delete_report(r), 'and a report can be deleted outright');
  perform pg_temp.check(
    (select count(*) from public.admin_reports('all', 'somebody flagged', 50)) = 0,
    'which really does remove it');
end $$;

-- A report already taken down has had its decision, and a queue that keeps
-- showing it is a queue nobody finishes reading. On a report of its own,
-- because the assertions above still need the first one flagged.
reset role; reset request.jwt.claim.sub;
do $$
declare dee uuid := '44444444-4444-4444-4444-444444444444';
        bo  uuid := '22222222-2222-2222-2222-222222222222';
        r   uuid;
begin
  insert into public.reports (reporter_id, category, headline, description, lat, lng, happened_at)
  values (dee, 'atm', 'A second report, also flagged', 'detail', 48.86, 2.33, now() - interval '3 hours')
  returning id into r;
  insert into public.report_flags (report_id, user_id, reason) values (r, bo, 'duplicate');
end $$;
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

select pg_temp.check((select count(*) from public.admin_reports('flagged', null, 50)) = 1,
  'the new flagged report is in the queue');
select pg_temp.check(
  public.admin_set_report_status(
    (select id from public.admin_reports('flagged', null, 50)), 'removed') = 'removed',
  'and it can be taken down');
select pg_temp.check((select count(*) from public.admin_reports('flagged', null, 50)) = 0,
  'which takes it out of the queue — what makes the queue drainable at all');
select pg_temp.check((select count(*) from public.admin_reports('removed', null, 50)) = 1,
  'while leaving it findable under Taken down');

-- --- The ladder -------------------------------------------------------------
select pg_temp.check(
  (select count(*) from public.admin_set_levels(
     '[{"level":1,"min_points":0},{"level":2,"min_points":20},{"level":3,"min_points":60}]'::jsonb)) = 3,
  'the ladder can be replaced with a shorter one');
select pg_temp.check(public.level_for(25) = 2 and public.level_for(60) = 3,
  'and every level recomputes against the new rungs at once');

do $$
begin
  perform public.admin_set_levels('[{"level":1,"min_points":0},{"level":2,"min_points":0}]'::jsonb);
  perform pg_temp.check(false, 'a ladder that does not climb should be refused');
exception when others then
  perform pg_temp.check(sqlerrm like '%not more than the rung below%',
    'a ladder that does not climb is refused: ' || sqlerrm);
end $$;
do $$
begin
  perform public.admin_set_levels('[{"level":2,"min_points":0},{"level":3,"min_points":10}]'::jsonb);
  perform pg_temp.check(false, 'a ladder not starting at 1 should be refused');
exception when others then
  perform pg_temp.check(sqlerrm like '%start at level 1%', 'a ladder not starting at level 1 is refused');
end $$;
do $$
begin
  perform public.admin_set_levels('[{"level":1,"min_points":5}]'::jsonb);
  perform pg_temp.check(false, 'a first rung above zero should be refused');
exception when others then
  perform pg_temp.check(sqlerrm like '%0 points%', 'and so is a first rung somebody has to climb to');
end $$;
select pg_temp.check((select count(*) from public.contributor_levels) = 3,
  'a refused ladder leaves the one that was there, rather than half of it');

-- A rung that no longer exists cannot be anybody's given level.
select pg_temp.check(public.admin_set_level('44444444-4444-4444-4444-444444444444', 3) = 3,
  'somebody can be given the top rung');
select pg_temp.check(
  (select count(*) from public.admin_set_levels(
     '[{"level":1,"min_points":0},{"level":2,"min_points":20}]'::jsonb)) = 2,
  'and the ladder can then be shortened under them');
reset role; reset request.jwt.claim.sub;
select pg_temp.check(
  (select level_override from public.profiles where id = '44444444-4444-4444-4444-444444444444') is null,
  'which clears the level they were given, rather than leaving them on a rung that is gone');
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

-- --- Regions ----------------------------------------------------------------
select pg_temp.check((select closed from public.admin_blocked_regions()) = 0,
  'nothing is closed to begin with');
select pg_temp.check((select count(*) from public.admin_region_catalog()) > 0,
  'and the catalogue of regions can be read rather than guessed at');
select pg_temp.check(public.admin_set_blocked_regions(array['MX'], array['schengen']) > 1,
  'a country and a whole region can be closed together');
select pg_temp.check(not public.reporting_allowed('MX') and not public.reporting_allowed('FR'),
  'and both really are closed to new reports');
select pg_temp.check(public.reporting_allowed('JP'),
  'while everywhere else stays open');
do $$
begin
  perform public.admin_set_blocked_regions('{}', array['narnia']);
  perform pg_temp.check(false, 'a region that does not exist should be refused');
exception when others then
  perform pg_temp.check(sqlerrm like '%no region called narnia%',
    'a region nobody has heard of is refused rather than closing nothing in silence');
end $$;
select pg_temp.check(public.admin_set_blocked_regions('{}', '{}') = 0,
  'and everywhere can be opened again');
select pg_temp.check(public.reporting_allowed('FR'), 'which really does reopen it');

-- --- Settings ---------------------------------------------------------------
select pg_temp.check((select count(*) from public.admin_settings()) = 8,
  'the editable settings are a known list, not the whole table');
select pg_temp.check(
  not exists (select 1 from public.admin_settings() where key = 'blocked_regions'),
  'and blocked_regions is not one of them — it is JSON and has its own screen');
select pg_temp.check(public.admin_set_setting('points_per_report', '7') = '7',
  'a setting can be changed');
select pg_temp.check(public.contribution_points('44444444-4444-4444-4444-444444444444') >= 0,
  'and the functions that read it carry on working');
do $$
begin
  perform public.admin_set_setting('points_per_report', 'lots');
  perform pg_temp.check(false, 'a word where a number goes should be refused');
exception when others then
  perform pg_temp.check(sqlerrm like '%has to be a number%',
    'a word where a number goes is refused now rather than at the next read');
end $$;
do $$
begin
  perform public.admin_set_setting('blocked_regions', '{}');
  perform pg_temp.check(false, 'a setting off the list should be refused');
exception when others then
  perform pg_temp.check(sqlerrm like '%not editable from here%',
    'and a setting that is not on the list is refused');
end $$;
select pg_temp.check(public.admin_set_setting('points_per_report', '5') = '5', 'and put back');
reset role; reset request.jwt.claim.sub;

-- --- None of it is reachable by a member ------------------------------------
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
do $$
declare refused int := 0;
begin
  begin perform public.admin_reports('all', null, 10); exception when others then
    if sqlerrm = 'admins only' then refused := refused + 1; end if; end;
  begin perform public.admin_delete_report(gen_random_uuid()); exception when others then
    if sqlerrm = 'admins only' then refused := refused + 1; end if; end;
  begin perform public.admin_set_levels('[{"level":1,"min_points":0}]'::jsonb); exception when others then
    if sqlerrm = 'admins only' then refused := refused + 1; end if; end;
  begin perform public.admin_set_blocked_regions('{}', '{}'); exception when others then
    if sqlerrm = 'admins only' then refused := refused + 1; end if; end;
  begin perform public.admin_set_setting('points_per_report', '999'); exception when others then
    if sqlerrm = 'admins only' then refused := refused + 1; end if; end;
  begin perform public.admin_region_catalog(); exception when others then
    if sqlerrm = 'admins only' then refused := refused + 1; end if; end;
  perform pg_temp.check(refused = 6,
    'every one of the six new console calls refuses a member (' || refused || ' of 6)');
end $$;
reset role; reset request.jwt.claim.sub;

\echo ''
select (select count(*) - (select count(*) from pg_temp.failures) from pg_temp.ran)
       || '/' || (select count(*) from pg_temp.ran) || ' passed'
       || case when (select count(*) from pg_temp.failures) = 0 then '' else '  <-- FAILURES' end;
