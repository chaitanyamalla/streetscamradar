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

\echo ''
select (select count(*) - (select count(*) from pg_temp.failures) from pg_temp.ran)
       || '/' || (select count(*) from pg_temp.ran) || ' passed'
       || case when (select count(*) from pg_temp.failures) = 0 then '' else '  <-- FAILURES' end;
