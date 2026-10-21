#!/bin/bash
# ---------------------------------------------------------------------------
# Every browser suite, against a local copy of the site.
#
#   test/run.sh            everything
#   test/run.sh limits     only suites whose name contains "limits"
#
# Needs Playwright and a Chromium:
#   npm i -D playwright@1.56 && npx playwright install chromium
#
# The SQL suites are separate and need a Postgres: supabase/test/run.sh.
# ---------------------------------------------------------------------------
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PORT="${PORT:-8099}"
WANTED="${1:-}"

# The site is ES modules, so it needs a real HTTP origin — file:// will not
# load it. Started here and stopped on the way out, unless something is
# already answering on the port.
started=""
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/index.html" 2>/dev/null; then
  (cd "$ROOT" && exec python3 -m http.server "$PORT" >/dev/null 2>&1) &
  started=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -s -o /dev/null "http://127.0.0.1:$PORT/index.html" 2>/dev/null && break
    sleep 0.4
  done
fi
cleanup() { [ -n "$started" ] && kill "$started" 2>/dev/null; }
trap cleanup EXIT

if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/index.html" 2>/dev/null; then
  echo "nothing is serving the site on port $PORT"
  exit 1
fi

bad=0
for suite in "$HERE"/*-test.js "$HERE"/*-test.mjs; do
  [ -e "$suite" ] || continue
  name="$(basename "$suite")"
  case "$name" in harness*) continue;; esac
  if [ -n "$WANTED" ] && [[ "$name" != *"$WANTED"* ]]; then continue; fi
  out="$(node "$suite" 2>&1)"
  status=$?
  # A suite that prints no tally has crashed, which is a failure however
  # cheerful its exit code looks.
  if ! printf '%s' "$out" | grep -qE 'passed|consistent'; then
    echo "$name -> produced no result"
    printf '%s\n' "$out" | tail -4
    bad=1
    continue
  fi
  printf '%s\n' "$out" | grep -E 'FAIL|passed|consistent'
  [ $status -ne 0 ] && bad=1
done

echo
if [ $bad -eq 0 ]; then echo "all suites passed"; else echo "SOMETHING FAILED"; fi
exit $bad
