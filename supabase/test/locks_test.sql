-- ---------------------------------------------------------------------------
-- Locking a country, and putting a notice over it — against a real Postgres.
--
-- Run it with supabase/test/run.sh. The real policies, the real functions, the
-- real grants.
--
-- Written around one worry. A lock is the only feature here that makes the map
-- show LESS, so every scope is checked twice: that it hides the thing it names,
-- and that it leaves the other five alone. A lock that quietly took the
-- hospitals down with the advisories would be found by a traveller, not by us.
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

-- An admin, and a member who is not one.
insert into auth.users (id, email, raw_user_meta_data) values
  ('cccc0000-0000-4000-8000-00000000000a', 'boss@example.com', '{"full_name":"Boss"}'),
  ('cccc0000-0000-4000-8000-00000000000b', 'mem@example.com',  '{"full_name":"Mem"}')
on conflict (id) do nothing;
update public.profiles set role = 'admin' where id = 'cccc0000-0000-4000-8000-00000000000a';

-- One row in every layer, in two countries: FR which will be locked, and
-- ES which must be untouched by any of it.
-- Every count below is exact, so the ground has to be bare first.
--
-- run.sh points all four test files at ONE database and this one runs last, so
-- the ~180 reports the quota tests leave behind were being counted as France's
-- and every assertion about "one report" was wrong. Reports go entirely; the
-- four feeds are cleared for the two countries this file uses.
delete from public.reports;
delete from public.travel_advisories where country_code in ('FR', 'ES');
delete from public.disaster_alerts    where country_code in ('FR', 'ES');
delete from public.weather_warnings   where country_code in ('FR', 'ES');
delete from public.safety_places      where country_code in ('FR', 'ES');
delete from public.country_locks;
delete from public.country_notices;

-- The required columns only, read off information_schema rather than guessed.
-- The first version of this invented four column names that do not exist.
insert into public.travel_advisories (country_code, content_id, title, country_name, partial_warning)
values ('FR', 1001, 'Frankreich: Reise- und Sicherheitshinweise', 'Frankreich', true),
       ('ES', 1002, 'Spanien: Reise- und Sicherheitshinweise',    'Spanien',    true)
on conflict (country_code) do nothing;

insert into public.disaster_alerts (event_id, country_code, kind, severity, name, lat, lng)
values ('t-fr', 'FR', 'flood', 'severe', 'Flooding in the north', 49.0, 2.0),
       ('t-es', 'ES', 'flood', 'severe', 'Flooding in the south', 37.0, -4.0)
on conflict do nothing;

insert into public.weather_warnings (warning_id, country_code, kind, severity, areas, source, lat, lng)
values ('w-fr', 'FR', 'wind', 'severe', 'Paris',  'MeteoAlarm', 48.86, 2.35),
       ('w-es', 'ES', 'wind', 'severe', 'Madrid', 'MeteoAlarm', 40.41, -3.70)
on conflict do nothing;

insert into public.safety_places (id, kind, name, lat, lng, country_code)
values ('p-fr', 'police', 'Commissariat', 48.86, 2.35, 'FR'),
       ('p-es', 'police', 'Comisaria',    40.41, -3.70, 'ES')
on conflict do nothing;

insert into public.reports (reporter_id, category, headline, description, lat, lng, country_code, happened_at)
values ('cccc0000-0000-4000-8000-00000000000b', 'pickpocket', 'A thing in Paris',
        'detail with enough words in it', 48.86, 2.35, 'FR', now() - interval '2 hours'),
       ('cccc0000-0000-4000-8000-00000000000b', 'pickpocket', 'A thing in Madrid',
        'detail with enough words in it', 40.41, -3.70, 'ES', now() - interval '2 hours');

-- How many rows a reader can see in each layer, per country. One function, so
-- every scope below is asked the same question and the answers are comparable.
create or replace function pg_temp.visible(p_country text)
returns table (advisories bigint, disasters bigint, weather bigint,
               safety bigint, reports bigint)
language sql as $$
  select (select count(*) from public.travel_advisories where country_code = p_country),
         (select count(*) from public.disaster_alerts    where country_code = p_country),
         (select count(*) from public.weather_warnings   where country_code = p_country),
         (select count(*) from public.safety_places      where country_code = p_country),
         (select count(*) from public.reports_feed       where country_code = p_country);
$$;
grant execute on function pg_temp.visible(text) to public;

-- --- nothing locked, everything visible ----------------------------------
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000b';
select pg_temp.check(
  (select advisories = 1 and disasters = 1 and weather = 1 and safety = 1 and reports = 1
     from pg_temp.visible('FR')),
  'with nothing locked a reader sees all five layers in France (got '
  || (select advisories::text || disasters || weather || safety || reports from pg_temp.visible('FR')) || ')');
select pg_temp.check(public.reporting_allowed('FR'), 'and may file a report there');
reset role; reset request.jwt.claim.sub;

-- --- each scope hides its own layer and nothing else ---------------------
--
-- Written out five times rather than looped. The looped version needed dynamic
-- column names and a role switch inside a DO block, and it broke; this is
-- longer and says plainly which layer each lock is supposed to take down, and
-- that the other four survive. A lock that quietly took the hospitals down
-- with the advisories would be found by a traveller, not by us.

delete from public.country_locks;
insert into public.country_locks (country_code, scopes) values ('FR', array['advisories']);
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000b';
select pg_temp.check((select advisories from pg_temp.visible('FR')) = 0,
  'locking advisories hides the travel advisory in France');
select pg_temp.check((select disasters + weather + safety + reports from pg_temp.visible('FR')) = 4,
  'and leaves the other four layers alone (got '
  || (select disasters + weather + safety + reports from pg_temp.visible('FR')) || ' of 4)');
select pg_temp.check(
  (select advisories + disasters + weather + safety + reports from pg_temp.visible('ES')) = 5,
  'while Spain keeps all five, locked for advisories or not');
reset role; reset request.jwt.claim.sub;

delete from public.country_locks;
insert into public.country_locks (country_code, scopes) values ('FR', array['disasters']);
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000b';
select pg_temp.check((select disasters from pg_temp.visible('FR')) = 0,
  'locking disasters hides the disaster alerts in France');
select pg_temp.check((select advisories + weather + safety + reports from pg_temp.visible('FR')) = 4,
  'and leaves the other four layers alone (got '
  || (select advisories + weather + safety + reports from pg_temp.visible('FR')) || ' of 4)');
select pg_temp.check(
  (select advisories + disasters + weather + safety + reports from pg_temp.visible('ES')) = 5,
  'while Spain keeps all five, locked for disasters or not');
reset role; reset request.jwt.claim.sub;

delete from public.country_locks;
insert into public.country_locks (country_code, scopes) values ('FR', array['weather']);
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000b';
select pg_temp.check((select weather from pg_temp.visible('FR')) = 0,
  'locking weather hides the weather warnings in France');
select pg_temp.check((select advisories + disasters + safety + reports from pg_temp.visible('FR')) = 4,
  'and leaves the other four layers alone (got '
  || (select advisories + disasters + safety + reports from pg_temp.visible('FR')) || ' of 4)');
select pg_temp.check(
  (select advisories + disasters + weather + safety + reports from pg_temp.visible('ES')) = 5,
  'while Spain keeps all five, locked for weather or not');
reset role; reset request.jwt.claim.sub;

delete from public.country_locks;
insert into public.country_locks (country_code, scopes) values ('FR', array['safety']);
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000b';
select pg_temp.check((select safety from pg_temp.visible('FR')) = 0,
  'locking safety hides the police and hospitals in France');
select pg_temp.check((select advisories + disasters + weather + reports from pg_temp.visible('FR')) = 4,
  'and leaves the other four layers alone (got '
  || (select advisories + disasters + weather + reports from pg_temp.visible('FR')) || ' of 4)');
select pg_temp.check(
  (select advisories + disasters + weather + safety + reports from pg_temp.visible('ES')) = 5,
  'while Spain keeps all five, locked for safety or not');
reset role; reset request.jwt.claim.sub;

delete from public.country_locks;
insert into public.country_locks (country_code, scopes) values ('FR', array['reports']);
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000b';
select pg_temp.check((select reports from pg_temp.visible('FR')) = 0,
  'locking reports hides the reports in France');
select pg_temp.check((select advisories + disasters + weather + safety from pg_temp.visible('FR')) = 4,
  'and leaves the other four layers alone (got '
  || (select advisories + disasters + weather + safety from pg_temp.visible('FR')) || ' of 4)');
select pg_temp.check(
  (select advisories + disasters + weather + safety + reports from pg_temp.visible('ES')) = 5,
  'while Spain keeps all five, locked for reports or not');
reset role; reset request.jwt.claim.sub;

-- --- a complete lockdown -------------------------------------------------
delete from public.country_locks;
insert into public.country_locks (country_code, scopes, note)
values ('FR', public.lock_scopes(), 'everything, for the test');
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000b';
select pg_temp.check(
  (select advisories + disasters + weather + safety + reports = 0 from pg_temp.visible('FR')),
  'a complete lockdown empties every layer in that country');
select pg_temp.check(
  (select advisories + disasters + weather + safety + reports = 5 from pg_temp.visible('ES')),
  'and still touches nothing anywhere else');
select pg_temp.check(not public.reporting_allowed('FR'), 'and no new report is accepted there');
select pg_temp.check(public.reporting_allowed('ES'), 'while Spain stays open');
reset role; reset request.jwt.claim.sub;

-- --- your own reports are no exception -----------------------------------
-- If they were, a member could tell a country was locked by watching their own
-- pins survive while everybody else's vanished.
delete from public.country_locks;
insert into public.country_locks (country_code, scopes) values ('FR', array['reports']);
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000b';
select pg_temp.check(
  (select count(*) from public.reports_feed where country_code = 'FR') = 0,
  'a member cannot see their OWN report in a country whose reports are locked');
reset role; reset request.jwt.claim.sub;

-- --- pausing new reports leaves the old ones readable --------------------
-- The distinction the whole scope list exists for: refusing a write costs one
-- would-be reporter, hiding the reads costs every traveller in the country.
delete from public.country_locks;
insert into public.country_locks (country_code, scopes) values ('FR', array['reports_new']);
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000b';
select pg_temp.check(
  (select count(*) from public.reports_feed where country_code = 'FR') = 1,
  'reports already filed stay readable when only NEW ones are paused');
select pg_temp.check(not public.reporting_allowed('FR'), 'while a new one is refused');
reset role; reset request.jwt.claim.sub;

-- --- expiry needs no job to run ------------------------------------------
delete from public.country_locks;
insert into public.country_locks (country_code, scopes, until)
values ('FR', array['advisories'], now() + interval '1 hour');
set role authenticated;
select pg_temp.check(
  (select advisories from pg_temp.visible('FR')) = 0,
  'a lock with an hour left is in force');
reset role;
update public.country_locks set until = now() - interval '1 second' where country_code = 'FR';
set role authenticated;
select pg_temp.check(
  (select advisories from pg_temp.visible('FR')) = 1,
  'and one second past its time it simply is not, with nothing having run');
reset role;
select pg_temp.check(
  (select count(*) from public.active_locks()) = 0,
  'an expired lock is not among the active ones');
select pg_temp.check(
  (select count(*) from public.country_locks) = 1,
  'though the row is still there, so "we paused this last month" is answerable');

-- --- what the public may read about a lock -------------------------------
delete from public.country_locks;
-- As the admin, because admin_required() is checked by the database and not by
-- whoever is calling: the owner with no JWT is not an admin, it is nobody.
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000a';
select public.admin_set_lock(array['FR'], array['disasters'],
  'the feed is reporting nonsense for this country', null) is not null;
select pg_temp.check(
  (select count(*) from public.active_locks() where country_code = 'FR') = 1,
  'a reader can see THAT a country is locked, and what is paused');
select pg_temp.check(
  (select count(*) from (select unnest(p.proargnames) as name, unnest(p.proargmodes)::text as mode
                           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'active_locks') a
    where a.mode = 't' and a.name = 'note') = 0,
  'but never the note — it is our reasoning about somebody else''s data');
reset role; reset request.jwt.claim.sub;

-- --- only an admin may lock anything -------------------------------------
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000b';
do $$
declare ok boolean := false;
begin
  begin
    perform public.admin_set_lock(array['IT'], array['reports_new']);
  exception when others then ok := true;
  end;
  perform pg_temp.check(ok, 'an ordinary member cannot lock a country');
end $$;
do $$
declare ok boolean := false;
begin
  begin
    perform public.admin_post_notice('IT', 'warning', 'Something is happening');
  exception when others then ok := true;
  end;
  perform pg_temp.check(ok, 'nor post a notice');
end $$;
-- Read as the owner: a member has no privilege on country_locks at all, which
-- is itself the point — the only way in for a browser is active_locks(), and
-- that withholds the note.
reset role; reset request.jwt.claim.sub;
select pg_temp.check(
  (select count(*) from public.country_locks where country_code = 'IT') = 0,
  'and nothing of theirs reached the table');

select pg_temp.check(
  not exists (select 1 from information_schema.table_privileges
               where table_schema = 'public' and table_name = 'country_locks'
                 and grantee in ('anon', 'authenticated')),
  'and a browser has no privilege on country_locks at all — active_locks() is the only door');

-- --- locking a whole list in one call ------------------------------------
reset role; reset request.jwt.claim.sub;
delete from public.country_locks;
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000a';
select pg_temp.check(
  public.admin_set_lock(array['FR','ES','IT'], array['advisories','disasters']) = 3,
  'a zone can be locked in one call, so a half-applied lock is not a state');
-- Through admin_locks(), which is the door the console uses and the only one
-- an admin has: the table itself is closed to every browser role.
select pg_temp.check(
  (select count(*) from public.admin_locks()
    where 'advisories' = any(scopes) and 'disasters' = any(scopes)) = 3,
  'and all three carry both scopes');

-- Clearing every scope removes the lock rather than storing one that locks
-- nothing, which is the obvious reading of unticking every box.
select pg_temp.check(public.admin_set_lock(array['IT'], array[]::text[]) = 0,
  'unticking everything clears the lock');
select pg_temp.check(
  (select count(*) from public.admin_locks() where country_code = 'IT') = 0,
  'and the row is gone, not left locking nothing');

-- --- what admin_set_lock refuses -----------------------------------------
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000a';
do $$
declare bad text;
begin
  -- 'zz' and 'FP' are both two letters and neither is a country. 'FP' is the
  -- one that matters: it is what a mistyped 'FR' looks like.
  for bad in select * from unnest(array['zz', 'FP', 'FRA', '']) loop
    declare ok boolean := false;
    begin
      begin
        perform public.admin_set_lock(array[bad], array['reports_new']);
      exception when others then ok := true;
      end;
      perform pg_temp.check(ok, format('%L is refused as a country code', bad));
    end;
  end loop;
end $$;
do $$
declare ok boolean := false;
begin
  begin
    perform public.admin_set_lock(array['FR'], array['everything']);
  exception when others then ok := true;
  end;
  perform pg_temp.check(ok, 'a scope nobody has heard of is refused');
end $$;
do $$
declare ok boolean := false;
begin
  begin
    perform public.admin_set_lock(array['FR'], array['reports_new'], null,
                                  now() - interval '1 day');
  exception when others then ok := true;
  end;
  perform pg_temp.check(ok, 'and a lock that would already have expired');
end $$;

-- --- notices ------------------------------------------------------------
reset role; reset request.jwt.claim.sub;
delete from public.country_notices;
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000a';
select public.admin_post_notice('FR', 'danger', 'Ongoing protests in the centre',
  'Several districts are affected and transport is disrupted.', 'en', null) is not null;
select public.admin_post_notice('FR', 'info', 'Marathon on Sunday',
  null, 'en', now() + interval '2 days') is not null;
select public.admin_post_notice('FR', 'warning', 'Rail strike', null, 'en', null) is not null;

set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000b';
select pg_temp.check((select count(*) from public.notices_for('FR')) = 3,
  'all three notices are shown over that country');
select pg_temp.check(
  (select kind from public.notices_for('FR') limit 1) = 'danger',
  'loudest first, so a protest is never under a marathon (got '
  || (select string_agg(kind, ',') from public.notices_for('FR')) || ')');
select pg_temp.check((select count(*) from public.notices_for('ES')) = 0,
  'and nothing of France''s appears over Spain');
select pg_temp.check((select count(*) from public.notices_for('fr')) = 3,
  'a lowercase country code finds them too — the map has both spellings about');
reset role; reset request.jwt.claim.sub;

-- An expired notice comes down on its own.
reset role; reset request.jwt.claim.sub;
update public.country_notices set until = now() - interval '1 minute'
 where headline = 'Rail strike';
set role authenticated;
select pg_temp.check((select count(*) from public.notices_for('FR')) = 2,
  'a notice past its time comes down with nothing having run');
select pg_temp.check(
  (select count(*) from public.country_notices) = 2,
  'and the row goes with it, because a notice that is no longer true is not history');
reset role;

-- Taking one down by hand.
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000a';
do $$
declare target uuid;
begin
  select id into target from public.country_notices where headline = 'Marathon on Sunday';
  perform pg_temp.check(public.admin_drop_notice(target), 'an admin can take a notice down');
  perform pg_temp.check(not public.admin_drop_notice(target),
    'and taking down one that is already gone says so rather than pretending');
end $$;

-- What a notice refuses.
do $$
declare ok boolean := false;
begin
  begin
    perform public.admin_post_notice('FP', 'warning', 'Pinned to a typo');
  exception when others then ok := true;
  end;
  perform pg_temp.check(ok, 'a notice cannot be pinned to a country that does not exist');
end $$;
do $$
declare ok boolean := false;
begin
  begin
    perform public.admin_post_notice('FR', 'shouting', 'Something is happening');
  exception when others then ok := true;
  end;
  perform pg_temp.check(ok, 'a kind nobody has heard of is refused');
end $$;
do $$
declare ok boolean := false;
begin
  begin
    perform public.admin_post_notice('FR', 'warning', 'Hi');
  exception when others then ok := true;
  end;
  perform pg_temp.check(ok, 'and a headline too short to say anything');
end $$;
do $$
declare ok boolean := false;
begin
  begin
    perform public.admin_post_notice('FR', 'warning', 'Written in Klingon', null, 'tlh');
  exception when others then ok := true;
  end;
  perform pg_temp.check(ok, 'and a language this site is not read in');
end $$;

-- --- a notice is independent of a lock ----------------------------------
-- The two are separate on purpose: most notices lock nothing, and a lock
-- without a notice is a map going quiet for no stated reason.
reset role; reset request.jwt.claim.sub;
delete from public.country_locks;
delete from public.country_notices;
set role authenticated;
set request.jwt.claim.sub = 'cccc0000-0000-4000-8000-00000000000a';
select public.admin_post_notice('PT', 'warning', 'Wildfires in the interior',
  null, 'en', null) is not null;
set role authenticated;
select pg_temp.check((select count(*) from public.notices_for('PT')) = 1,
  'a notice can stand with no lock behind it');
select pg_temp.check(public.reporting_allowed('PT'),
  'and posting one does not quietly close the country');
reset role;

-- --- Results ------------------------------------------------------------
select case when count(*) = 0
            then (select 'locks_test  ' || count(*) || '/' || count(*) || ' passed' from pg_temp.ran)
            else 'locks_test  FAILED: ' || count(*) || ' of '
                 || (select count(*) from pg_temp.ran) || string_agg(E'\n  - ' || label, '')
       end
  from pg_temp.failures;
