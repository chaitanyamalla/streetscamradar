-- ---------------------------------------------------------------------------
-- The earned badges: the metals, the reach ladder, and what they refuse to say.
--
-- These are arithmetic over the reports table, which is exactly the shape of
-- thing the browser tests cannot see: the page stub can agree perfectly with
-- the page while the SQL counts the wrong rows. Everything here goes through
-- the real functions against real rows.
--
--   supabase/test/run.sh
-- ---------------------------------------------------------------------------
\set ON_ERROR_STOP off
\pset pager off
set client_min_messages = notice;

create or replace function pg_temp.ok(cond boolean, label text)
returns void language plpgsql as $$
begin
  if cond then raise notice '  ok    %', label;
  else raise notice 'FAIL  %', label;
  end if;
end;
$$;

-- A member, and a helper that files reports for them.
create or replace function pg_temp.member(p_name text) returns uuid
language plpgsql as $$
-- Not called `id`: a plpgsql variable with a column's name shadows the column
-- throughout the body, and the INSERTs below both have an `id` column.
declare who uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (who, p_name || '@example.test');
  -- handle_new_user() has already made the profile from the auth.users insert
  -- above, so this is the conflict branch every time — and `listed` has to be
  -- set HERE. Setting it only in the VALUES left every member unlisted and the
  -- contributors board empty, which read as the board being broken.
  insert into public.profiles (id, display_name, listed) values (who, p_name, true)
    on conflict (id) do update
      set display_name = excluded.display_name, listed = true;
  return who;
end;
$$;

-- n published reports in one town, and optionally confirmed by somebody else.
create or replace function pg_temp.file(
  p_user uuid, p_country text, p_town text, p_n int, p_confirm_by uuid default null)
returns void language plpgsql as $$
declare i int; rid uuid;
begin
  for i in 1..p_n loop
    rid := gen_random_uuid();
    insert into public.reports (id, reporter_id, category, headline, description,
                                lat, lng, city, country_code, happened_at, status)
    values (rid, p_user, 'pickpocket', 'Something happened', 'A description here',
            48.85, 2.35, p_town, p_country, now() - interval '1 hour', 'published');
    if p_confirm_by is not null then
      insert into public.report_supports (report_id, user_id) values (rid, p_confirm_by);
    end if;
  end loop;
end;
$$;

do $$
declare
  witness uuid;
  nobody  uuid;
  b       text[];
begin
  witness := pg_temp.member('witness');   -- confirms other people's reports
  perform pg_temp.ok(true, '--- nothing earned by nobody ---');

  nobody := pg_temp.member('nobody');
  b := public.badges_of(nobody);
  perform pg_temp.ok(b = '{}', format('a member with no reports has no badges (%s)', b));

  -- ---- the metals, which count CONFIRMED reports and not filed ones -------
  perform pg_temp.ok(true, '--- the metals ---');
  declare filer uuid := pg_temp.member('filer');
  begin
    perform pg_temp.file(filer, 'FR', 'Paris', 40);         -- nobody confirmed
    b := public.badges_of(filer);
    perform pg_temp.ok(not (b && array['bronze','silver','gold']),
      format('forty reports nobody confirmed earn no metal (%s)', b));
    perform pg_temp.ok('local' = any(b),
      format('but forty in one town is still Local hero (%s)', b));
  end;

  declare bronze uuid := pg_temp.member('bronze_m');
  begin
    perform pg_temp.file(bronze, 'FR', 'Lyon', 3, witness);
    b := public.badges_of(bronze);
    perform pg_temp.ok('bronze' = any(b), format('three confirmed is Bronze (%s)', b));
    perform pg_temp.ok(not ('silver' = any(b)) and not ('gold' = any(b)),
      'and only Bronze — one metal at a time');
  end;

  declare silver uuid := pg_temp.member('silver_m');
  begin
    perform pg_temp.file(silver, 'FR', 'Nice', 10, witness);
    b := public.badges_of(silver);
    perform pg_temp.ok('silver' = any(b), format('ten confirmed is Silver (%s)', b));
    perform pg_temp.ok(not ('bronze' = any(b)),
      'and Bronze is gone rather than kept beside it');
  end;

  declare gold uuid := pg_temp.member('gold_m');
  begin
    perform pg_temp.file(gold, 'FR', 'Lille', 30, witness);
    b := public.badges_of(gold);
    perform pg_temp.ok('gold' = any(b), format('thirty confirmed is Gold (%s)', b));
    perform pg_temp.ok(not ('silver' = any(b)), 'and only Gold');
  end;

  -- A confirmation by the author counts for nothing, the way points do not.
  declare selfer uuid := pg_temp.member('selfer');
  begin
    perform pg_temp.file(selfer, 'FR', 'Brest', 5, selfer);
    b := public.badges_of(selfer);
    perform pg_temp.ok(not (b && array['bronze','silver','gold']),
      format('confirming your own reports earns no metal (%s)', b));
  end;

  -- ---- the reach ladder ---------------------------------------------------
  perform pg_temp.ok(true, '--- how far the map reaches ---');

  declare local_m uuid := pg_temp.member('local_m');
  begin
    perform pg_temp.file(local_m, 'FR', 'Rennes', 4);
    perform pg_temp.ok(not ('local' = any(public.badges_of(local_m))),
      'four in one town is not yet Local hero');
    perform pg_temp.file(local_m, 'FR', 'Rennes', 1);
    perform pg_temp.ok('local' = any(public.badges_of(local_m)),
      'the fifth earns it');
  end;

  declare country_m uuid := pg_temp.member('country_m');
  begin
    -- Five towns, one country, and only one report in each: this is width,
    -- so it must NOT need the depth Local hero asks for.
    perform pg_temp.file(country_m, 'FR', 'Dijon', 1);
    perform pg_temp.file(country_m, 'FR', 'Tours', 1);
    perform pg_temp.file(country_m, 'FR', 'Nancy', 1);
    perform pg_temp.file(country_m, 'FR', 'Reims', 1);
    b := public.badges_of(country_m);
    perform pg_temp.ok(not ('country' = any(b)), 'four towns is not yet Country hero');
    perform pg_temp.file(country_m, 'FR', 'Caen', 1);
    b := public.badges_of(country_m);
    perform pg_temp.ok('country' = any(b), format('the fifth town earns it (%s)', b));
    perform pg_temp.ok(not ('local' = any(b)),
      'and it replaces Local hero rather than sitting beside it');
  end;

  declare region_m uuid := pg_temp.member('region_m');
  begin
    -- France, Germany, Belgium are all western-europe in country_groups.
    perform pg_temp.file(region_m, 'FR', 'Paris', 1);
    perform pg_temp.file(region_m, 'DE', 'Berlin', 1);
    b := public.badges_of(region_m);
    perform pg_temp.ok(not ('regional' = any(b)), 'two countries is not yet Regional hero');
    perform pg_temp.file(region_m, 'BE', 'Ghent', 1);
    b := public.badges_of(region_m);
    perform pg_temp.ok('regional' = any(b),
      format('three countries in one region earns it (%s)', b));
  end;

  declare global_m uuid := pg_temp.member('global_m');
  begin
    perform pg_temp.file(global_m, 'FR', 'Paris', 1);
    perform pg_temp.file(global_m, 'JP', 'Tokyo', 1);
    b := public.badges_of(global_m);
    perform pg_temp.ok('global' = any(b),
      format('two continents is Globetrotter (%s)', b));
    perform pg_temp.ok(not (b && array['local','country','regional']),
      'and nothing below it on the ladder');
  end;

  -- ---- a withdrawn report takes its badge with it ------------------------
  perform pg_temp.ok(true, '--- nothing is stored, so nothing goes stale ---');
  declare fader uuid := pg_temp.member('fader');
  begin
    perform pg_temp.file(fader, 'FR', 'Metz', 5, witness);
    perform pg_temp.ok('local' = any(public.badges_of(fader)), 'five reports, Local hero');
    update public.reports set status = 'removed' where reporter_id = fader;
    b := public.badges_of(fader);
    perform pg_temp.ok(b = '{}',
      format('withdrawing them takes the badges with them, with no job to run (%s)', b));
  end;

  -- ---- granted and earned arrive together --------------------------------
  perform pg_temp.ok(true, '--- granted beside earned ---');
  declare mixed uuid := pg_temp.member('mixed');
  begin
    perform pg_temp.file(mixed, 'FR', 'Arles', 10, witness);
    insert into public.contributor_badges (profile_id, badge) values (mixed, 'partner');
    b := public.badges_of(mixed);
    perform pg_temp.ok('partner' = any(b) and 'silver' = any(b) and 'local' = any(b),
      format('a granted badge and two earned ones all show (%s)', b));
  end;

  -- 'founder' is not a badge any more, and 'gold' was never grantable.
  declare refused boolean := false;
  begin
    begin
      insert into public.contributor_badges (profile_id, badge) values (nobody, 'founder');
    exception when check_violation then refused := true;
    end;
    perform pg_temp.ok(refused, 'founder can no longer be granted');
    refused := false;
    begin
      insert into public.contributor_badges (profile_id, badge) values (nobody, 'gold');
    exception when check_violation then refused := true;
    end;
    perform pg_temp.ok(not refused,
      'while an earned badge CAN be handed out by hand, which is the override');
    delete from public.contributor_badges where profile_id = nobody and badge = 'gold';
    refused := false;
    begin
      insert into public.contributor_badges (profile_id, badge) values (nobody, 'early');
    exception when check_violation then refused := true;
    end;
    perform pg_temp.ok(not refused, 'while early, which replaced it, can be');
  end;

  -- ---- an admin overrules the count, both ways ---------------------------
  --
  -- The seven earned badges are a rule, and a rule needs somebody who can say
  -- "not this person" — and the other way round, give one to somebody the
  -- count has not caught up with. Three states: given, taken away, and no
  -- opinion, which is the normal one.
  perform pg_temp.ok(true, '--- what an admin can overrule ---');
  declare forced uuid := pg_temp.member('forced');
  begin
    perform pg_temp.file(forced, 'FR', 'Vichy', 10, witness);
    b := public.badges_of(forced);
    perform pg_temp.ok('silver' = any(b) and 'local' = any(b),
      format('earned Silver and Local hero on their own (%s)', b));

    -- Taken away: the reports that earned it have not gone anywhere, so a
    -- delete would hand it straight back. The row has to say no.
    insert into public.contributor_badges (profile_id, badge, granted)
      values (forced, 'silver', false);
    b := public.badges_of(forced);
    perform pg_temp.ok(not ('silver' = any(b)),
      format('an admin can take an earned badge away (%s)', b));
    perform pg_temp.ok('local' = any(b),
      'and only that one — the rest of what they earned stands');

    -- Given: a badge the count has not reached.
    insert into public.contributor_badges (profile_id, badge, granted)
      values (forced, 'gold', true);
    b := public.badges_of(forced);
    perform pg_temp.ok('gold' = any(b),
      format('and give one the count has not reached (%s)', b));

    -- Hand back to the count.
    delete from public.contributor_badges where profile_id = forced and badge = 'silver';
    b := public.badges_of(forced);
    perform pg_temp.ok('silver' = any(b),
      format('clearing the decision puts the earned one back (%s)', b));

    -- A revoked badge stays revoked when the count rises. An admin decision
    -- is a decision, not a one-off correction that the next report undoes.
    insert into public.contributor_badges (profile_id, badge, granted)
      values (forced, 'local', false) on conflict (profile_id, badge)
      do update set granted = false;
    perform pg_temp.file(forced, 'FR', 'Vichy', 20, witness);
    b := public.badges_of(forced);
    perform pg_temp.ok(not ('local' = any(b)),
      format('and twenty more reports do not undo a revoke (%s)', b));
  end;

  -- ---- the thresholds are settings, not constants ------------------------
  perform pg_temp.ok(true, '--- tunable from the dashboard ---');
  declare tuned uuid := pg_temp.member('tuned');
  begin
    perform pg_temp.file(tuned, 'FR', 'Pau', 2, witness);
    perform pg_temp.ok(not ('bronze' = any(public.badges_of(tuned))),
      'two confirmed is under the default Bronze rung');
    update public.app_settings set value = '2' where key = 'badge_bronze_confirmed';
    perform pg_temp.ok('bronze' = any(public.badges_of(tuned)),
      'lowering the setting grants it with no deploy');
    update public.app_settings set value = '3' where key = 'badge_bronze_confirmed';
  end;

  -- ---- the board still names no place ------------------------------------
  perform pg_temp.ok(true, '--- what the board still refuses to say ---');
  declare row_text text;
  begin
    select array_to_string(array_agg(x::text), ' ') into row_text
      from public.contributors_board(50) x;
    perform pg_temp.ok(row_text not ilike '%Paris%' and row_text not ilike '%Tokyo%'
                   and row_text not ilike '%Rennes%' and row_text not ilike '%FR%',
      'no town and no country code reaches the contributors board');
  end;
end;
$$;
