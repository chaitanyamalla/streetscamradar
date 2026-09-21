-- ============================================================================
-- StreetScamRadar — access-control tests.
--
-- These prove the rules in schema.sql actually hold when the database is
-- queried as a signed-out visitor and as a signed-in member. Run them against
-- a THROWAWAY database, never production: they insert and delete rows.
--
--   psql "$DATABASE_URL" -f supabase/schema.sql
--   psql "$DATABASE_URL" -f supabase/tests.sql
--
-- Every line should print PASS. A FAIL means someone can see or change
-- something they should not.
-- ============================================================================

create schema if not exists ssr_test;
grant usage on schema ssr_test to anon, authenticated;

create or replace function ssr_test.ok(cond boolean, label text)
returns void language plpgsql as $$
begin
  if cond then raise notice 'PASS  %', label;
  else raise warning 'FAIL  %', label;
  end if;
end $$;

-- Did the statement get refused outright?
create or replace function ssr_test.denied(stmt text) returns boolean
language plpgsql as $$
begin execute stmt; return false;
exception when others then return true;
end $$;

grant execute on all functions in schema ssr_test to anon, authenticated;

-- --------------------------------------------------------------------------
-- Fixtures
-- --------------------------------------------------------------------------
delete from public.reports where headline like 'TEST %';
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','alice@example.com'),
  ('22222222-2222-2222-2222-222222222222','bob@example.com'),
  ('33333333-3333-3333-3333-333333333333','carol@example.com')
on conflict (id) do nothing;

insert into public.reports (id, reporter_id, category, impacts, headline, description, lat, lng, city, country_code, happened_at) values
 ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','pickpocket','{money}',        'TEST bag lifted on metro line 1','Two men blocked the doors while a third opened my backpack.',48.8606,2.3376,'Paris','FR', now() - interval '2 hours'),
 ('aaaaaaaa-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','taxi','{money,threats}',      'TEST driver refused the meter','Quoted a flat fare and refused to switch the meter on.',48.8600,2.3400,'Paris','FR', now() - interval '1 day'),
 ('aaaaaaaa-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','distraction','{}',            'TEST bracelet pushed on wrist','Man tied a string bracelet on then demanded twenty euros.',48.8867,2.3431,'Paris','FR', now() - interval '3 days'),
 ('aaaaaaaa-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','atm','{money}',               'TEST skimmer near the station','The card slot was loose and a second panel sat above the keypad.',48.8610,2.3380,'Paris','FR', now() - interval '9 days'),
 ('aaaaaaaa-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222','tickets','{money,harm}',      'TEST fake temple tour sold','Paid for a guided tour that does not exist.',35.6762,139.6503,'Tokyo','JP', now() - interval '1 day')
on conflict (id) do nothing;

-- Confirmations, not a self-assessed severity, decide which reports a
-- signed-out visitor is shown first. Both of these are bob's, so neither
-- count includes its own author.
insert into public.report_supports (report_id, user_id) values
 ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111'),
 ('aaaaaaaa-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333'),
 ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111')
on conflict do nothing;

-- 12 extra live Paris reports, to prove the public cap is real.
insert into public.reports (reporter_id,category,impacts,headline,description,lat,lng,city,happened_at)
select '11111111-1111-1111-1111-111111111111','other','{}',
       'TEST filler report number ' || g, 'Filler text used to prove the public row cap holds.',
       48.86 + g*0.0001, 2.34 + g*0.0001, 'Paris', now() - interval '1 hour'
from generate_series(1,12) g;
-- Live Paris reports now: 3 originals + 12 filler = 15. Plus one 9-day-old
-- report owned by alice, which must stay out of everyone's map but hers.

-- ==========================================================================
-- A signed-out visitor
-- ==========================================================================
begin;
set local role anon;

select ssr_test.ok(ssr_test.denied('select * from public.reports'),      'anon cannot read the reports table');
select ssr_test.ok(ssr_test.denied('select * from public.reports_feed'), 'anon cannot read the member feed');
select ssr_test.ok(ssr_test.denied('select * from public.profiles'),     'anon cannot read profiles');
select ssr_test.ok(ssr_test.denied('select * from public.app_settings'), 'anon cannot read app_settings');
select ssr_test.ok(ssr_test.denied($$update public.app_settings set value='1' where key='public_sample_limit'$$),
                                                                         'anon cannot rewrite the public row cap');
select ssr_test.ok(ssr_test.denied($$insert into public.reports (category,impacts,headline,description,lat,lng,happened_at)
                                     values ('other','{money}','TEST anon write attempt','writing without an account at all',1,1,now())$$),
                                                                         'anon cannot file a report');

-- Zoomed out across Europe: counts only.
select ssr_test.ok((select count(*) from public.public_sample_reports(40,-5,55,20)) = 0,
                   'anon sees NO individual reports when zoomed out');
select ssr_test.ok((select coalesce(sum(total),0) from public.public_area_summary(40,-5,55,20)) = 15,
                   'anon still gets aggregate counts when zoomed out');

-- Zoomed in on Paris: a capped handful, best-confirmed first.
select ssr_test.ok((select count(*) from public.public_sample_reports(48.80,2.25,48.92,2.42)) = 5,
                   'anon sample is hard-capped at 5 with 15 reports in view');
select ssr_test.ok((select headline from public.public_sample_reports(48.80,2.25,48.92,2.42) limit 1) like 'TEST driver%',
                   'anon sample leads with the best-confirmed report, not a self-rated one');
select ssr_test.ok((select impacts from public.public_sample_reports(48.80,2.25,48.92,2.42)
                     where headline like 'TEST driver%') = '{money,threats}'::text[],
                   'anon sample carries what happened, not a severity grade');
select ssr_test.ok((select max(total_in_view) from public.public_sample_reports(48.80,2.25,48.92,2.42)) = 15,
                   'anon is told how many exist without being shown them');
select ssr_test.ok(not exists (select 1 from public.public_sample_reports(48.80,2.25,48.92,2.42) where headline like '%skimmer%'),
                   'anon never sees a report older than the 7-day window');
rollback;

-- ==========================================================================
-- A signed-in member (alice)
-- ==========================================================================
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';

select ssr_test.ok((select count(*) from public.reports_feed
                     where city='Paris' and happened_at > now() - interval '7 days') = 15,
                   'member sees every live report in view, not a sample');
select ssr_test.ok(not exists (select 1 from public.reports_feed
                                where headline like 'TEST skimmer%' and is_mine = false),
                   'a report past the window is not in the general feed');
select ssr_test.ok(exists (select 1 from public.reports_feed where headline like 'TEST skimmer%' and is_mine),
                   'but its own author still sees it');
select ssr_test.ok(ssr_test.denied('select reporter_id from public.reports_feed'),
                   'reporter_id is never exposed — whoever reported stays anonymous');
select ssr_test.ok(ssr_test.denied('select * from public.reports'),
                   'member cannot bypass the view by reading the table');
select ssr_test.ok((select bool_and(is_mine) from public.reports_feed where headline like 'TEST bag lifted%'),
                   'is_mine identifies your own report');

select ssr_test.ok(ssr_test.denied($$insert into public.reports (reporter_id,category,impacts,headline,description,lat,lng,happened_at)
                                     values ('22222222-2222-2222-2222-222222222222','other','{money}','TEST impersonation','filing this as somebody else entirely',1,1,now())$$),
                   'member cannot file a report as another user');
select ssr_test.ok(ssr_test.denied($$insert into public.reports (reporter_id,category,impacts,headline,description,lat,lng,happened_at,support_count)
                                     values ('11111111-1111-1111-1111-111111111111','other','{money}','TEST inflated support','starting out with fake community backing',1,1,now(),99)$$),
                   'member cannot pre-inflate support_count');
select ssr_test.ok(ssr_test.denied($$update public.reports set support_count=999 where id='aaaaaaaa-0000-0000-0000-000000000001'$$),
                   'member cannot edit support_count afterwards');
select ssr_test.ok(ssr_test.denied($$delete from public.reports where id='aaaaaaaa-0000-0000-0000-000000000002'$$),
                   'member cannot delete another member''s report');
select ssr_test.ok(ssr_test.denied($$insert into public.reports (reporter_id,category,impacts,headline,description,lat,lng,happened_at)
                                     values ('11111111-1111-1111-1111-111111111111','other','{catastrophic}','TEST invented impact','an impact nobody defined',1,1,now())$$),
                   'impacts are limited to the three the form offers');
rollback;

-- A one-word description is a real answer. The headline carries the summary.
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
insert into public.reports (reporter_id,category,impacts,headline,description,lat,lng,happened_at)
  values ('11111111-1111-1111-1111-111111111111','other','{}','TEST one word description','Pickpockets',1,1,now());
select ssr_test.ok(exists (select 1 from public.reports_feed where headline like 'TEST one word%'),
                   'a one-word description is accepted');
select ssr_test.ok(ssr_test.denied($$insert into public.reports (reporter_id,category,impacts,headline,description,lat,lng,happened_at)
                                     values ('11111111-1111-1111-1111-111111111111','other','{}','TEST empty description','   ',1,1,now())$$),
                   'but an empty one is not');
rollback;

-- Confirming is for other people's reports.
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select ssr_test.ok(ssr_test.denied($$insert into public.report_supports (report_id,user_id)
                                     values ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111')$$),
                   'a member cannot confirm their own report');
select ssr_test.ok((select support_count from public.reports_feed where id='aaaaaaaa-0000-0000-0000-000000000003') = 1,
                   'but can confirm somebody else''s');
delete from public.report_supports
 where report_id='aaaaaaaa-0000-0000-0000-000000000003' and user_id='11111111-1111-1111-1111-111111111111';
select ssr_test.ok((select support_count from public.reports_feed where id='aaaaaaaa-0000-0000-0000-000000000003') = 0,
                   'and can take the confirmation back');
rollback;

-- Support counter is maintained by the trigger, never the client.
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
insert into public.report_supports (report_id,user_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222');
select ssr_test.ok((select support_count from public.reports_feed where id='aaaaaaaa-0000-0000-0000-000000000001') = 1,
                   'supporting a report increments the public counter');
select ssr_test.ok(ssr_test.denied($$insert into public.report_supports (report_id,user_id)
                                     values ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111')$$),
                   'member cannot support on someone else''s behalf');
select ssr_test.ok((select count(*) from public.report_supports) = 1,
                   'member sees only their own support rows');
rollback;

-- Withdrawing your own report.
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select ssr_test.ok(public.delete_my_report('aaaaaaaa-0000-0000-0000-000000000002') = false,
                   'delete_my_report refuses another member''s report');
select ssr_test.ok(public.delete_my_report('aaaaaaaa-0000-0000-0000-000000000001') = true,
                   'delete_my_report withdraws your own report');
rollback;

-- Editing your own wording.
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select ssr_test.ok(public.edit_my_report('aaaaaaaa-0000-0000-0000-000000000002','TEST hijacked headline','trying to rewrite somebody else''s report') = false,
                   'edit_my_report refuses another member''s report');
select ssr_test.ok(public.edit_my_report('aaaaaaaa-0000-0000-0000-000000000001','TEST corrected headline here','A better description of what happened.') = true,
                   'edit_my_report rewrites your own');
select ssr_test.ok((select headline from public.reports_feed where id='aaaaaaaa-0000-0000-0000-000000000001') = 'TEST corrected headline here',
                   'and the new wording is what everyone reads');
select ssr_test.ok((select happened_at from public.reports_feed where id='aaaaaaaa-0000-0000-0000-000000000001') > now() - interval '3 hours',
                   'an edit with no time given leaves when it happened alone');
select ssr_test.ok(ssr_test.denied($$select public.edit_my_report('aaaaaaaa-0000-0000-0000-000000000001','TEST ok headline here','x',now() + interval '2 days')$$),
                   'a time in the future is refused');
select ssr_test.ok(ssr_test.denied($$select public.edit_my_report('aaaaaaaa-0000-0000-0000-000000000001','TEST ok headline here','x',now() - interval '30 days')$$),
                   'a time outside the window is refused');
select ssr_test.ok(ssr_test.denied($$select public.edit_my_report('aaaaaaaa-0000-0000-0000-000000000001','short','x')$$),
                   'the headline still has to be a headline');
select ssr_test.ok((select support_count from public.reports_feed where id='aaaaaaaa-0000-0000-0000-000000000001') = 0,
                   'editing does not disturb what a report collected');
rollback;

-- The density grid is a property of the world, not of your viewport.
-- It used to divide the viewport into columns from its own corner, so the
-- circles slid around under the cursor on any pan — about half a kilometre
-- for a fifth of a degree.
begin;
set local role anon;
select ssr_test.ok(
  (select lat from public.public_area_summary(48.70, 2.20, 49.00, 2.50) limit 1)
  = (select lat from public.public_area_summary(48.72, 2.22, 49.02, 2.52) limit 1),
  'panning does not move a density circle');
select ssr_test.ok(
  (select lng from public.public_area_summary(48.70, 2.20, 49.00, 2.50) limit 1)
  = (select lng from public.public_area_summary(48.75, 2.25, 49.05, 2.55) limit 1),
  'and neither does panning again');
select ssr_test.ok(
  (select count(*) from public.public_area_summary(48.70, 2.20, 49.00, 2.50)) > 0,
  'the grid still actually groups something');
-- Snapping the centres was only half of it: a cell straddling the edge of the
-- screen used to be counted only as far as the screen went, so the number in
-- the circle ticked up and down as you panned.
select ssr_test.ok(
  (select coalesce(sum(total), 0) from public.public_area_summary(48.70, 2.20, 49.00, 2.50))
  = (select coalesce(sum(total), 0) from public.public_area_summary(48.72, 2.22, 49.02, 2.52)),
  'and panning does not change what a circle counts');
select ssr_test.ok(
  (select count(*) from public.public_area_summary(48.70, 2.20, 49.00, 2.50))
  = (select count(*) from public.public_area_summary(48.73, 2.23, 49.03, 2.53)),
  'nor how many circles there are');
rollback;

-- Moving a report, and the day you have to do it in.
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select ssr_test.ok(public.edit_my_report('aaaaaaaa-0000-0000-0000-000000000001','TEST moved headline here','Now in the right place.',null, 48.8700, 2.3500, 'Rue de Rivoli', 'Paris', 'fr') = true,
                   'a fresh report can be moved');
select ssr_test.ok((select round(lat::numeric,4) from public.reports_feed where id='aaaaaaaa-0000-0000-0000-000000000001') = 48.8700,
                   'and it really moves');
select ssr_test.ok((select country_code from public.reports_feed where id='aaaaaaaa-0000-0000-0000-000000000001') = 'FR',
                   'the country code is stored upper-case whatever was sent');
select ssr_test.ok((select address from public.reports_feed where id='aaaaaaaa-0000-0000-0000-000000000001') = 'Rue de Rivoli',
                   'the address comes with it');
rollback;

-- The same report, filed a week ago, may no longer be moved.
begin;
update public.reports set created_at = now() - interval '8 days'
 where id = 'aaaaaaaa-0000-0000-0000-000000000001';
set local role authenticated;
set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
select ssr_test.ok(ssr_test.denied($$select public.edit_my_report('aaaaaaaa-0000-0000-0000-000000000001','TEST still fine headline','text',null,1.0,1.0,null,null,null)$$),
                   'an older report cannot be moved');
select ssr_test.ok(public.edit_my_report('aaaaaaaa-0000-0000-0000-000000000001','TEST reworded not moved','Still just words.') = true,
                   'but its words can still be fixed');
rollback;

-- Closing your account.
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
select ssr_test.ok(public.delete_my_account() = true, 'delete_my_account closes your own account');
-- The checks below read auth.users and the reports table, which the member
-- role cannot do — that is the whole reason the function is SECURITY DEFINER.
reset role;
select ssr_test.ok(not exists (select 1 from auth.users where id='22222222-2222-2222-2222-222222222222'),
                   'and you are gone');
select ssr_test.ok(not exists (select 1 from public.reports where reporter_id='22222222-2222-2222-2222-222222222222'),
                   'your reports go with you');
select ssr_test.ok(exists (select 1 from auth.users where id='11111111-1111-1111-1111-111111111111'),
                   'and nobody else is touched');
select ssr_test.ok(not exists (select 1 from public.reports where reporter_id is null and headline like 'TEST %'),
                   'no report is left orphaned as if it were demo data');
rollback;

-- Community moderation, once you switch it on.
update public.app_settings set value='2' where key='auto_hide_flag_threshold';
begin;
  set local role authenticated;
  set local "request.jwt.claim.sub" = '11111111-1111-1111-1111-111111111111';
  insert into public.report_flags (report_id,user_id,reason) values ('aaaaaaaa-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','wrong');
commit;
begin;
  set local role authenticated;
  set local "request.jwt.claim.sub" = '22222222-2222-2222-2222-222222222222';
  insert into public.report_flags (report_id,user_id,reason) values ('aaaaaaaa-0000-0000-0000-000000000005','22222222-2222-2222-2222-222222222222','wrong');
commit;
select ssr_test.ok((select status from public.reports where id='aaaaaaaa-0000-0000-0000-000000000005') = 'under_review',
                   'two flags auto-hide a report once the threshold is on');
begin;
set local role anon;
select ssr_test.ok(not exists (select 1 from public.public_sample_reports(35.5,139.5,35.8,139.8)),
                   'an auto-hidden report vanishes from the public map');
rollback;
update public.app_settings set value='999999' where key='auto_hide_flag_threshold';

-- --------------------------------------------------------------------------
delete from public.reports where headline like 'TEST %';
drop schema ssr_test cascade;
