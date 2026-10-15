-- ---------------------------------------------------------------------------
-- How much one person may file, and how fast — against a real Postgres.
--
-- Run it with supabase/test/run.sh. Nothing is mocked: the real trigger, the
-- real policy, the real grants.
--
-- These rules are the whole anti-spam story, so the test is written to fail
-- if any one of them stops working, and to say which. The four refusals are
-- provoked one at a time, as the `authenticated` role, through an ordinary
-- insert — exactly the path the report form takes.
--
-- The awkward part, and the reason this file exists rather than a browser
-- test: the rules are about TIME. A test that waited ninety seconds between
-- inserts would be useless, so created_at is moved backwards by hand to put a
-- row where the clock needs it. That is honest here — created_at is what the
-- rules read, and moving it is the only way to ask "what happens at 89
-- seconds" without sitting there for 89 seconds.
-- ---------------------------------------------------------------------------
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

create table if not exists pg_temp.failures (label text);
create table if not exists pg_temp.ran (label text);
grant insert on pg_temp.failures, pg_temp.ran to public;

create or replace function pg_temp.check(ok boolean, label text) returns void
language plpgsql as $$
begin
  raise notice '%  %', case when ok then '  ok  ' else '  FAIL' end, label;
  insert into pg_temp.ran values (label);
  if ok is not true then insert into pg_temp.failures values (label); end if;
end $$;

-- Try an insert as a member and say what came back: null when it went in, or
-- the refusal reason the trigger raised.
create or replace function pg_temp.try_report(
  p_user uuid, p_lat double precision, p_lng double precision,
  p_category text default 'pickpocket')
returns text language plpgsql as $$
begin
  insert into public.reports
    (reporter_id, category, headline, description, lat, lng, country_code, happened_at)
  values (p_user, p_category, 'A thing happened here', 'detail with enough words in it',
          p_lat, p_lng, 'FR', now() - interval '1 hour');
  return null;
exception
  when check_violation then
    -- 'report_refused:quota' -> 'quota'
    return split_part(sqlerrm, ':', 2);
  when others then
    return 'unexpected:' || sqlerrm;
end $$;
grant execute on function pg_temp.try_report(uuid, double precision, double precision, text) to public;

-- Put every one of this member's reports far enough in the past that only the
-- rule under test can fire.
create or replace function pg_temp.age_reports(p_user uuid, p_interval interval)
returns void language sql as $$
  update public.reports set created_at = now() - p_interval where reporter_id = p_user;
$$;

insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaa0000-0000-4000-8000-000000000001', 'cap@example.com',  '{"full_name":"Cap"}'),
  ('aaaa0000-0000-4000-8000-000000000002', 'fast@example.com', '{"full_name":"Fast"}'),
  ('aaaa0000-0000-4000-8000-000000000003', 'dup@example.com',  '{"full_name":"Dup"}'),
  ('aaaa0000-0000-4000-8000-000000000004', 'jet@example.com',  '{"full_name":"Jet"}'),
  ('aaaa0000-0000-4000-8000-000000000005', 'pal@example.com',  '{"full_name":"Pal"}')
on conflict (id) do nothing;

-- --- The allowance itself --------------------------------------------------
select pg_temp.check((select daily_quota from public.contributor_levels where level = 1) = 5,
  'level 1 allows five reports a day');
select pg_temp.check((select daily_quota from public.contributor_levels where level = 10) = 25,
  'level 10 allows twenty-five');
select pg_temp.check(
  (select count(*) from public.contributor_levels a
     join public.contributor_levels b on b.level = a.level + 1
    where b.daily_quota < a.daily_quota) = 0,
  'and no rung allows fewer than the one below it');

select pg_temp.check(public.report_quota('aaaa0000-0000-4000-8000-000000000001') = 5,
  'a brand-new member gets the level 1 allowance (got '
  || public.report_quota('aaaa0000-0000-4000-8000-000000000001') || ')');

-- The partner badge carries its own floor, with no climbing involved.
insert into public.contributor_badges (profile_id, badge, note, granted)
values ('aaaa0000-0000-4000-8000-000000000005', 'partner', 'works with us', true)
on conflict do nothing;
select pg_temp.check(public.report_quota('aaaa0000-0000-4000-8000-000000000005') = 20,
  'the partner badge alone is worth twenty a day (got '
  || public.report_quota('aaaa0000-0000-4000-8000-000000000005') || ')');

-- A number set on one person beats both, and only upwards.
update public.profiles set daily_report_limit = 50
 where id = 'aaaa0000-0000-4000-8000-000000000005';
select pg_temp.check(public.report_quota('aaaa0000-0000-4000-8000-000000000005') = 50,
  'a personal allowance of fifty wins');
update public.profiles set daily_report_limit = 3
 where id = 'aaaa0000-0000-4000-8000-000000000005';
select pg_temp.check(public.report_quota('aaaa0000-0000-4000-8000-000000000005') = 20,
  'but a personal THREE cannot demote a partner below their badge');
update public.profiles set daily_report_limit = null
 where id = 'aaaa0000-0000-4000-8000-000000000005';

-- --- Seeds and migrations are not gated -----------------------------------
-- Twenty rows for one member in one statement, as the owner, with no waiting.
-- If this ever starts failing, every fixture in every other test file breaks
-- with it, and so does supabase/ops/seed_test_reports.sql.
do $$
declare i int;
begin
  for i in 1..20 loop
    insert into public.reports
      (reporter_id, category, headline, description, lat, lng, country_code, happened_at)
    values ('aaaa0000-0000-4000-8000-000000000001', 'pickpocket',
            'Seeded ' || i, 'detail with enough words in it',
            48.86 + i * 0.01, 2.33, 'FR', now() - interval '2 hours');
  end loop;
end $$;
select pg_temp.check(
  (select count(*) from public.reports
    where reporter_id = 'aaaa0000-0000-4000-8000-000000000001') = 20,
  'the owner can seed twenty reports for one member without being rate limited');

-- The sample pins carry no reporter at all, and must stay insertable.
insert into public.reports
  (id, reporter_id, category, headline, description, lat, lng, country_code, happened_at)
values ('7e57da7a-0000-4000-8000-000000000099', null, 'taxi', 'A sample pin with no reporter',
        'Sample report — test data, not a real incident.', 41.38, 2.17, 'ES', now());
select pg_temp.check(
  (select count(*) from public.reports where reporter_id is null) = 1,
  'and a report with no reporter is never gated');

-- --- Now as a member, through the real path -------------------------------
set role authenticated;

-- The daily cap. Cap already has 20 seeded rows, so the first attempt is over.
set request.jwt.claim.sub = 'aaaa0000-0000-4000-8000-000000000001';
select pg_temp.check(
  pg_temp.try_report('aaaa0000-0000-4000-8000-000000000001', 48.90, 2.40) = 'quota',
  'a member over their daily allowance is refused with "quota"');

-- Fast: no history, so the first one goes in.
set request.jwt.claim.sub = 'aaaa0000-0000-4000-8000-000000000002';
select pg_temp.check(
  pg_temp.try_report('aaaa0000-0000-4000-8000-000000000002', 48.86, 2.33) is null,
  'a member with nothing filed today may file');

-- The second, seconds later, is too fast.
select pg_temp.check(
  pg_temp.try_report('aaaa0000-0000-4000-8000-000000000002', 52.52, 13.40) = 'tooFast',
  'and a second one straight after is refused with "tooFast"');

reset role;
-- Push it to 89 seconds ago: still inside the ninety-second gap.
select pg_temp.age_reports('aaaa0000-0000-4000-8000-000000000002', interval '89 seconds');
set role authenticated;
set request.jwt.claim.sub = 'aaaa0000-0000-4000-8000-000000000002';
select pg_temp.check(
  pg_temp.try_report('aaaa0000-0000-4000-8000-000000000002', 52.52, 13.40) = 'tooFast',
  'eighty-nine seconds is still too fast — the boundary is not off by one');

reset role;
select pg_temp.age_reports('aaaa0000-0000-4000-8000-000000000002', interval '91 seconds');
set role authenticated;
set request.jwt.claim.sub = 'aaaa0000-0000-4000-8000-000000000002';
-- Ninety-one seconds later and 880km away: inside the gap, and Paris to
-- Berlin in 91 seconds is 34,000 km/h, so the travel rule should catch it.
select pg_temp.check(
  pg_temp.try_report('aaaa0000-0000-4000-8000-000000000002', 52.52, 13.40) = 'impossible',
  'Paris to Berlin in ninety-one seconds is refused with "impossible"');

-- The same gap, a plausible distance: allowed.
select pg_temp.check(
  pg_temp.try_report('aaaa0000-0000-4000-8000-000000000002', 48.88, 2.35, 'taxi') is null,
  'the same gap a few streets away is fine');

-- --- The repeat rule ------------------------------------------------------
reset role;
select pg_temp.age_reports('aaaa0000-0000-4000-8000-000000000003', interval '3 hours');
insert into public.reports
  (reporter_id, category, headline, description, lat, lng, country_code, happened_at, created_at)
values ('aaaa0000-0000-4000-8000-000000000003', 'pickpocket', 'First time',
        'detail with enough words in it', 48.8584, 2.2945, 'FR',
        now() - interval '3 hours', now() - interval '3 hours');
set role authenticated;
set request.jwt.claim.sub = 'aaaa0000-0000-4000-8000-000000000003';
-- About 30 metres away, same category, same day.
select pg_temp.check(
  pg_temp.try_report('aaaa0000-0000-4000-8000-000000000003', 48.85845, 2.29485) = 'duplicate',
  'the same category thirty metres away within the day is refused with "duplicate"');
-- A different category in the same spot is a different incident.
select pg_temp.check(
  pg_temp.try_report('aaaa0000-0000-4000-8000-000000000003', 48.85845, 2.29485, 'taxi') is null,
  'but another category in the same place is not a repeat');

-- --- The hourly cap -------------------------------------------------------
reset role;
delete from public.reports where reporter_id = 'aaaa0000-0000-4000-8000-000000000004';
do $$
declare i int;
begin
  for i in 1..3 loop
    insert into public.reports
      (reporter_id, category, headline, description, lat, lng, country_code,
       happened_at, created_at)
    values ('aaaa0000-0000-4000-8000-000000000004', 'tickets', 'Hourly ' || i,
            'detail with enough words in it', 48.86 + i * 0.02, 2.33, 'FR',
            now() - interval '30 minutes', now() - interval '30 minutes');
  end loop;
end $$;
set role authenticated;
set request.jwt.claim.sub = 'aaaa0000-0000-4000-8000-000000000004';
select pg_temp.check(
  pg_temp.try_report('aaaa0000-0000-4000-8000-000000000004', 49.20, 2.80, 'money') = 'hourly',
  'a fourth report within the hour is refused with "hourly", under the daily cap');

-- --- What the form is told ------------------------------------------------
set request.jwt.claim.sub = 'aaaa0000-0000-4000-8000-000000000004';
select pg_temp.check(
  (select quota = 5 and used = 3 and remaining = 2 from public.my_reporting_allowance()),
  'my_reporting_allowance counts what is left (got '
  || (select quota || '/' || used || '/' || remaining from public.my_reporting_allowance()) || ')');
-- next_allowed_at is "last one plus the gap", which for somebody whose last
-- report was half an hour ago is a moment in the PAST — they may file now.
-- The first version of this asserted it was in the future and failed, which
-- was the assertion being wrong rather than the function.
-- Worked out as the owner first: a member has no SELECT on public.reports at
-- all — they read through views and functions — so a test that recomputes the
-- expected value while acting as one dies on a permission it was never meant
-- to be testing.
reset role;
-- Not `on commit drop`: psql commits every statement on its own, so such a
-- table is gone before the next line can read it. The suite's own bookkeeping
-- tables are declared the same way for the same reason.
create table if not exists pg_temp.expected_next (at timestamptz);
delete from pg_temp.expected_next;
insert into pg_temp.expected_next
select max(created_at) + interval '90 seconds' from public.reports
 where reporter_id = 'aaaa0000-0000-4000-8000-000000000004';
grant select on pg_temp.expected_next to public;
set role authenticated;
set request.jwt.claim.sub = 'aaaa0000-0000-4000-8000-000000000004';
select pg_temp.check(
  (select abs(extract(epoch from (a.next_allowed_at - e.at))) < 1
     from public.my_reporting_allowance() a, pg_temp.expected_next e),
  'and says when the next one may go in: the last one plus the gap');
select pg_temp.check(
  (select next_allowed_at < now() from public.my_reporting_allowance()),
  'which is in the past for somebody whose last report was half an hour ago');

reset role; reset request.jwt.claim.sub;

-- --- The rules are numbers, not code --------------------------------------
-- Every one of them has to be retunable from the admin page without a deploy,
-- because a rule set too tight turns honest people away.
select pg_temp.check(
  (select count(*) from public.app_settings
    where key in ('report_gap_seconds', 'reports_per_hour', 'duplicate_metres',
                  'duplicate_hours', 'travel_kmh_limit', 'travel_min_metres',
                  'partner_daily_quota')) = 7,
  'all seven rules live in app_settings');

-- Loosening one takes effect at once.
--
-- Same place, deliberately. The first version of this moved the reporter from
-- Paris to Lyon in zero seconds and was refused — by the TRAVEL rule, not the
-- gap, and quite rightly. Worth knowing as a property of the design: the
-- travel rule imposes its own minimum gap on reports far apart, whatever
-- report_gap_seconds is set to, and only standing still exempts you from it.
update public.app_settings set value = '0' where key = 'report_gap_seconds';
set role authenticated;
set request.jwt.claim.sub = 'aaaa0000-0000-4000-8000-000000000003';
select pg_temp.check(
  pg_temp.try_report('aaaa0000-0000-4000-8000-000000000003', 48.8584, 2.2945, 'money') is null,
  'setting the gap to zero lets a report in the same place straight through');
reset role; reset request.jwt.claim.sub;
update public.app_settings set value = '90' where key = 'report_gap_seconds';

-- --- The travel rule's two floors ----------------------------------------
-- Added because the test above caught the rule calling an ordinary pair of
-- reports in the same street impossible: thirty-eight metres in five
-- hundredths of a second computes as 2,700 km/h.
--
-- The gap is set to zero here on purpose. With it at ninety the gap rule
-- answers first and the travel rule is never reached, which is how the first
-- version of this test managed to assert nothing at all.
reset role; reset request.jwt.claim.sub;
update public.app_settings set value = '0' where key = 'report_gap_seconds';
delete from public.reports where reporter_id = 'aaaa0000-0000-4000-8000-000000000002';
insert into public.reports
  (reporter_id, category, headline, description, lat, lng, country_code, happened_at, created_at)
values ('aaaa0000-0000-4000-8000-000000000002', 'pickpocket', 'Somewhere in Paris',
        'detail with enough words in it', 48.8584, 2.2945, 'FR',
        now() - interval '1 hour', now());

select pg_temp.check(
  (select count(*) from public.app_settings where key = 'travel_min_metres') = 1,
  'the travel rule has a distance below which it says nothing');

-- Forty metres, in no time at all. Nonsense as a speed, nothing as a journey.
select pg_temp.check(
  public.report_gate('aaaa0000-0000-4000-8000-000000000002', 48.85845, 2.29495, 'taxi')
    is distinct from 'impossible',
  'forty metres in no time at all is not called impossible');

-- Tokyo, in the same no time at all. Still nonsense, and now also a journey.
select pg_temp.check(
  public.report_gate('aaaa0000-0000-4000-8000-000000000002', 35.68, 139.69, 'taxi')
    = 'impossible',
  'but Paris to Tokyo in the same instant is');

-- And the same journey with a plausible amount of time in hand is fine: a
-- rule that refused a reporter who actually flew somewhere would be worse
-- than no rule.
reset role;
update public.reports set created_at = now() - interval '14 hours'
 where reporter_id = 'aaaa0000-0000-4000-8000-000000000002';
select pg_temp.check(
  public.report_gate('aaaa0000-0000-4000-8000-000000000002', 35.68, 139.69, 'taxi')
    is distinct from 'impossible',
  'and Paris to Tokyo with fourteen hours in hand is an ordinary flight');
update public.app_settings set value = '90' where key = 'report_gap_seconds';

-- --- Distance, checked against known numbers -----------------------------
select pg_temp.check(
  abs(public.metres_between(48.8584, 2.2945, 48.8606, 2.3376) - 3180) < 120,
  'the Eiffel Tower to the Louvre is about 3.2km (got '
  || round(public.metres_between(48.8584, 2.2945, 48.8606, 2.3376)) || 'm)');
select pg_temp.check(public.metres_between(48.86, 2.33, 48.86, 2.33) = 0,
  'and a point is no distance from itself');

-- ---------------------------------------------------------------------------
-- Which reports a visitor sees first.
-- ---------------------------------------------------------------------------
reset role; reset request.jwt.claim.sub;

-- --- standing is worth something, and not much ---------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('bbbb0000-0000-4000-8000-000000000001', 'plain@example.com', '{"full_name":"Plain"}'),
  ('bbbb0000-0000-4000-8000-000000000002', 'star@example.com',  '{"full_name":"Star"}')
on conflict (id) do nothing;

select pg_temp.check(public.member_weight('bbbb0000-0000-4000-8000-000000000001') = 1,
  'a new member is worth 1 — their level, and nothing else (got '
  || public.member_weight('bbbb0000-0000-4000-8000-000000000001') || ')');

-- An awareness creator who is also gold, and a partner.
insert into public.contributor_badges (profile_id, badge, note, granted) values
  ('bbbb0000-0000-4000-8000-000000000002', 'creator', 'makes videos', true),
  ('bbbb0000-0000-4000-8000-000000000002', 'gold',    'thirty confirmed', true),
  ('bbbb0000-0000-4000-8000-000000000002', 'partner', 'works with us', true)
on conflict do nothing;
-- level 1 + creator 5 + partner 3 + gold 4 = 13
select pg_temp.check(public.member_weight('bbbb0000-0000-4000-8000-000000000002') = 13,
  'a decorated member is worth 13 (got '
  || public.member_weight('bbbb0000-0000-4000-8000-000000000002') || ')');

-- The ratio that is the whole design: standing breaks ties, evidence wins.
-- The bound the whole design rests on, and the one the first version of this
-- got wrong: ONE confirmation must beat the highest standing there is.
select pg_temp.check(
  public.report_rank(1, 0, 0) > public.report_rank(0, 0, 22),
  'one stranger confirming a report beats the best standing on the site');
select pg_temp.check(
  public.member_weight('bbbb0000-0000-4000-8000-000000000002') < 25,
  'because no member can be worth more than a confirmation');
select pg_temp.check(
  public.report_rank(0, 0, 13) > public.report_rank(0, 0, 1),
  'but among reports nobody has confirmed, standing decides');
select pg_temp.check(
  public.report_rank(1, 1, 0) < public.report_rank(0, 0, 0),
  'and one flag costs more than one confirmation is worth');

-- --- the weight is stamped on the way in ---------------------------------
set role authenticated;
set request.jwt.claim.sub = 'bbbb0000-0000-4000-8000-000000000002';
select pg_temp.check(
  pg_temp.try_report('bbbb0000-0000-4000-8000-000000000002', 45.4642, 9.1900) is null,
  'a decorated member files a report');
reset role;
select pg_temp.check(
  (select reporter_weight from public.reports
    where reporter_id = 'bbbb0000-0000-4000-8000-000000000002') = 13,
  'and their standing is stamped on it (got '
  || (select reporter_weight from public.reports
       where reporter_id = 'bbbb0000-0000-4000-8000-000000000002') || ')');
select pg_temp.check(
  (select reporter_weight from public.reports where reporter_id is null limit 1) = 0,
  'while a sample pin stands for nobody');

-- --- the sample puts the better report first -----------------------------
-- Two reports in one square: one from a new member with no confirmations,
-- one from the decorated member, also with none. Standing is all there is to
-- separate them, which is exactly the case the old rule could not answer.
delete from public.reports where lat between 45.0 and 46.0 and lng between 9.0 and 10.0;
insert into public.reports
  (reporter_id, category, headline, description, lat, lng, country_code,
   happened_at, created_at, reporter_weight)
values
  ('bbbb0000-0000-4000-8000-000000000001', 'pickpocket', 'From a new member',
   'detail with enough words in it', 45.4642, 9.1900, 'IT',
   now() - interval '30 minutes', now() - interval '30 minutes', 1),
  ('bbbb0000-0000-4000-8000-000000000002', 'taxi', 'From a known contributor',
   'detail with enough words in it', 45.4645, 9.1905, 'IT',
   now() - interval '2 hours', now() - interval '2 hours', 13);

select pg_temp.check(
  (select headline from public.public_sample_reports(45.46, 9.18, 45.47, 9.20, null)
    limit 1) = 'From a known contributor',
  'the known contributor is shown first, though theirs is the older report (got '
  || coalesce((select headline from public.public_sample_reports(45.46, 9.18, 45.47, 9.20, null)
                limit 1), 'nothing') || ')');
select pg_temp.check(
  (select count(*) from public.public_sample_reports(45.46, 9.18, 45.47, 9.20, null)) = 2,
  'and the new member''s report is still there — ranked, never hidden');

-- One confirmation on the new member's report turns it right back around.
do $$
declare target uuid;
begin
  select id into target from public.reports where headline = 'From a new member';
  insert into public.report_supports (report_id, user_id)
  values (target, 'aaaa0000-0000-4000-8000-000000000003');
end $$;
select pg_temp.check(
  (select headline from public.public_sample_reports(45.46, 9.18, 45.47, 9.20, null)
    limit 1) = 'From a new member',
  'and one stranger confirming it beats all that standing (got '
  || coalesce((select headline from public.public_sample_reports(45.46, 9.18, 45.47, 9.20, null)
                limit 1), 'nothing') || ')');

-- --- and the rank never leaves the database ------------------------------
-- Given a rank, anybody could subtract the confirmations and flags they can
-- already see and recover the author's standing. Reports here are anonymous,
-- so neither number may be readable.
select pg_temp.check(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'reports_feed'
      and column_name in ('reporter_weight', 'rank', 'reporter_id')) = 0,
  'reports_feed exposes neither the weight, nor a rank, nor the reporter');
-- Asked of pg_proc, not information_schema.columns. A FUNCTION is not in
-- information_schema.columns at all, so the first version of this counted
-- zero because it was looking in the wrong place, and would have passed with
-- the weight returned in plain sight.
select pg_temp.check(
  (select count(*)
     from (select unnest(p.proargnames) as name, unnest(p.proargmodes)::text as mode
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'public_sample_reports') a
    where a.mode = 't' and a.name in ('reporter_weight', 'rank', 'reporter_id')) = 0,
  'and the public sample returns no weight, rank or reporter column');
-- Names are not enough on their own: a leak can wear an innocent name. The
-- value under support_count has to BE the confirmation count — swapping the
-- weight into that column is a mutation a name check cannot see.
select pg_temp.check(
  (select support_count from public.public_sample_reports(45.46, 9.18, 45.47, 9.20, null)
    where headline = 'From a new member') = 1,
  'and support_count really is the confirmation count, not something wearing its name (got '
  || coalesce((select support_count::text from public.public_sample_reports(45.46, 9.18, 45.47, 9.20, null)
                where headline = 'From a new member'), 'nothing') || ')');
-- The new member's weight is 1 and their confirmations are also 1, so that
-- row cannot tell the two apart — the first version of this checked only
-- there and the swap went straight through it. The decorated member is the
-- row that distinguishes them: weight 13, confirmations 0.
select pg_temp.check(
  (select support_count from public.public_sample_reports(45.46, 9.18, 45.47, 9.20, null)
    where headline = 'From a known contributor') = 0,
  'proved on the row where the two numbers differ: 13 of standing, 0 confirmations (got '
  || coalesce((select support_count::text from public.public_sample_reports(45.46, 9.18, 45.47, 9.20, null)
                where headline = 'From a known contributor'), 'nothing') || ')');

set role authenticated;
set request.jwt.claim.sub = 'bbbb0000-0000-4000-8000-000000000001';
select pg_temp.check(
  (select count(*) from public.reports_feed) >= 0,
  'a member can read the feed');
select pg_temp.check(
  not exists (
    select 1 from information_schema.column_privileges
     where table_schema = 'public' and table_name = 'reports'
       and grantee in ('authenticated', 'anon') and privilege_type = 'SELECT'),
  'and still cannot select the reports table itself, where the weight lives');
reset role; reset request.jwt.claim.sub;

-- --- Results --------------------------------------------------------------
select case when count(*) = 0
            then (select 'quota_test  ' || count(*) || '/' || count(*) || ' passed' from pg_temp.ran)
            else 'quota_test  FAILED: ' || count(*) || ' of '
                 || (select count(*) from pg_temp.ran) || string_agg(E'\n  - ' || label, '')
       end
  from pg_temp.failures;

