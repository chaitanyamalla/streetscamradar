#!/bin/bash
# ---------------------------------------------------------------------------
# Apply schema.sql to a throwaway Postgres and check the parts of it that are
# arithmetic rather than plumbing.
#
# Why this exists: everything else in this repository tests the PAGE, with the
# database stubbed. That means the stub and the page can agree perfectly while
# the SQL underneath is wrong, and the first four bugs in the levels work were
# exactly that shape — one of them a plpgsql OUT parameter shadowing a column,
# which no amount of browser testing would ever have found.
#
#   supabase/test/run.sh                # needs postgres on PATH
#
# It drops and rebuilds the public and auth schemas, so point it at a scratch
# database and never at anything that matters. PGHOST/PGUSER are respected.
# ---------------------------------------------------------------------------
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PSQL="psql ${PGHOST:+-h $PGHOST} ${PGUSER:+-U $PGUSER}"

$PSQL -q -c 'drop schema if exists public cascade; create schema public; drop schema if exists auth cascade;' >/dev/null 2>&1
$PSQL -v ON_ERROR_STOP=1 -q -f "$HERE/supabase_shim.sql" || { echo "the shim would not apply"; exit 1; }
# ON_ERROR_STOP on purpose: schema.sql has to run top to bottom on an EMPTY
# database, and for a long time it did not — a function referred to a table
# created two hundred lines below it, which only ever worked because the live
# database already had the table from an earlier run.
$PSQL -v ON_ERROR_STOP=1 -q -f "$HERE/../schema.sql" || { echo "schema.sql would not apply to an empty database"; exit 1; }
$PSQL -f "$HERE/levels_test.sql" 2>&1 | grep -E '  ok  |FAIL|^ERROR|passed' | sed 's/^psql:[^ ]*//;s/NOTICE: *//'
echo
$PSQL -f "$HERE/badges_test.sql" 2>&1 | grep -E '  ok  |FAIL|^ERROR|passed' | sed 's/^psql:[^ ]*//;s/NOTICE: *//'

# ---------------------------------------------------------------------------
# And again, as an UPGRADE rather than an install.
#
# Everything above runs against an empty database, which is exactly the shape
# this file cannot see a whole class of fault in: CREATE OR REPLACE will not
# change a function's return type or insert a column into a view, and on an
# empty database there is nothing to replace, so it never comes up. It comes up
# on the live database every time, which is where it was found — the schema
# stopped dead at my_standing() after two output columns were added to it.
#
# So: apply whatever is on the default branch, then apply the working copy on
# top of it, the way the real database gets it.
# ---------------------------------------------------------------------------
BASE="$(git -C "$HERE/../.." rev-parse --verify -q origin/main >/dev/null 2>&1 && echo origin/main || echo '')"
if [ -n "$BASE" ]; then
  echo
  OLD="$(mktemp)"
  git -C "$HERE/../.." show "$BASE:supabase/schema.sql" > "$OLD" 2>/dev/null
  if [ -s "$OLD" ]; then
    $PSQL -q -c 'drop schema if exists public cascade; create schema public; drop schema if exists auth cascade;' >/dev/null 2>&1
    $PSQL -v ON_ERROR_STOP=1 -q -f "$HERE/supabase_shim.sql" >/dev/null 2>&1
    $PSQL -q -f "$OLD" >/dev/null 2>&1
    # Put a row in the shape the OLD schema allowed and the new one does not,
    # so the upgrade has something real to migrate. A constraint swap that
    # forgets to move its rows first passes on an empty table and fails on the
    # only database anybody cares about.
    $PSQL -q >/dev/null 2>&1 <<'SEED'
      insert into auth.users (id, email)
        values ('11111111-1111-1111-1111-111111111111', 'old@example.test')
        on conflict do nothing;
      insert into public.profiles (id, display_name)
        values ('11111111-1111-1111-1111-111111111111', 'Old hand')
        on conflict (id) do nothing;
      insert into public.contributor_badges (profile_id, badge)
        values ('11111111-1111-1111-1111-111111111111', 'founder')
        on conflict do nothing;
SEED
    if $PSQL -v ON_ERROR_STOP=1 -q -f "$HERE/../schema.sql" 2>&1 | grep -E '^(psql:)?.*ERROR' ; then
      echo "  FAIL  schema.sql does not apply on top of $BASE"
    else
      echo "  ok    schema.sql applies on top of $BASE, not only to an empty database"
      MOVED="$($PSQL -tAc "select badge from public.contributor_badges
                            where profile_id = '11111111-1111-1111-1111-111111111111'" 2>/dev/null | tr -d ' ')"
      if [ "$MOVED" = "early" ]; then
        echo "  ok    and a badge granted as 'founder' came across as 'early'"
      elif [ -z "$MOVED" ]; then
        # The seed above did not take, because $BASE has itself moved past the
        # rename and its constraint no longer accepts 'founder'. There is
        # nothing left to migrate, which is the rename having finished rather
        # than the rename being broken — and this check retiring itself is the
        # correct end for a check about a one-way migration.
        echo "  ok    $BASE no longer has a 'founder' badge to move (the rename is done)"
      else
        echo "  FAIL  the founder badge did not survive the rename (got '$MOVED')"
      fi
    fi
  fi
  rm -f "$OLD"
fi
