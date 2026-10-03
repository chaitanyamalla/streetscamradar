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
    if $PSQL -v ON_ERROR_STOP=1 -q -f "$HERE/../schema.sql" 2>&1 | grep -E '^(psql:)?.*ERROR' ; then
      echo "  FAIL  schema.sql does not apply on top of $BASE"
    else
      echo "  ok    schema.sql applies on top of $BASE, not only to an empty database"
    fi
  fi
  rm -f "$OLD"
fi
