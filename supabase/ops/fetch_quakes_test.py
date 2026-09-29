#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Checks fetch_quakes.py against stub payloads, without the network.
#
# This generator is the only thing that writes to quake_events and it runs
# unattended twice a day. The case that matters is not the happy one: it is the
# run where USGS answers badly and a credulous loader empties the table,
# leaving a map that quietly says no earthquake has happened anywhere.
#
# Run: python3 supabase/ops/fetch_quakes_test.py
# ---------------------------------------------------------------------------
import io
import sys
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_quakes as fq  # noqa: E402

results = []
NOW = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)


def check(condition, label):
    results.append((bool(condition), label))


def quake(event_id="us1", mag=5.4, place="8 km NE of Paris, France",
          ago_days=1, lat=48.88, lng=2.38, tsunami=0, url="https://earthquake.usgs.gov/x",
          **extra):
    when = (NOW - timedelta(days=ago_days)).timestamp() * 1000
    props = {"mag": mag, "place": place, "time": when, "tsunami": tsunami, "url": url}
    props.update(extra)
    return {"type": "Feature", "id": event_id, "properties": props,
            "geometry": {"type": "Point", "coordinates": [lng, lat, 10]}}


def feed(*quakes):
    return {"type": "FeatureCollection", "features": list(quakes)}


def padding(count, start=100):
    """Enough ordinary quakes to clear the plausibility floor."""
    return [quake(event_id=f"pad{i}", ago_days=2) for i in range(start, start + count)]


# --- the ordinary run -------------------------------------------------------
rows = fq.rows_from([(feed(quake(), *padding(12)), 7)], now=NOW)
check(len(rows) == 13, f"every quake in the feed is kept ({len(rows)})")
check(rows[0]["event_id"] == "us1", "newest first")
check(rows[0]["magnitude"] == 5.4, "magnitude survives as a number")
check(rows[0]["place"] == "8 km NE of Paris, France", "the agency's own words for where")
check(rows[0]["at"].startswith("2026-09-28T12:00"), "epoch milliseconds become a real timestamp")
check(rows[0]["tsunami"] is False, "no tsunami warning unless USGS says so")

check(fq.rows_from([(feed(quake(tsunami=1), *padding(12)), 7)], now=NOW)[0]["tsunami"] is True,
      "and a tsunami warning is carried through")

# --- what is left out -------------------------------------------------------
small = fq.rows_from([(feed(quake(event_id="tiny", mag=3.2), *padding(12)), 7)], now=NOW)
check(not any(r["event_id"] == "tiny" for r in small),
      "below M4.5 is the background hum of a working planet, and is dropped")

old = fq.rows_from([(feed(quake(event_id="ancient", ago_days=20), *padding(12)), 7)], now=NOW)
check(not any(r["event_id"] == "ancient" for r in old),
      "a quake older than its feed's window is dropped")

kept = fq.rows_from([(feed(quake(event_id="big", ago_days=20), *padding(12)), 30)], now=NOW)
check(any(r["event_id"] == "big" for r in kept),
      "but the same age is kept when it came from the month-long feed")

broken = fq.rows_from([(feed(
    quake(event_id="noid"), {"id": "", "properties": {}, "geometry": {}},
    {"id": "nogeom", "properties": {"mag": 5, "time": 1}},
    quake(event_id="nowhere", lat=999),
    quake(event_id="nomag", mag=None),
    *padding(12)), 7)], now=NOW)
check({r["event_id"] for r in broken} >= {"noid"},
      "a good quake beside malformed ones still arrives")
check(not any(r["event_id"] in ("nogeom", "nowhere", "nomag") for r in broken),
      "and the malformed ones are skipped rather than stored half-made")

# --- the same event in both feeds -------------------------------------------
both = fq.rows_from([
    (feed(quake(event_id="same", ago_days=20), *padding(6)), 30),
    (feed(quake(event_id="same", ago_days=20), *padding(6, 200)), 7),
], now=NOW)
check(sum(1 for r in both if r["event_id"] == "same") == 1,
      "an event in both feeds is stored once")
check(any(r["event_id"] == "same" for r in both),
      "and keeps the wider window, so a significant quake is not aged out by the weekly feed")

# --- a bad day at USGS ------------------------------------------------------
def refuses(feeds, label):
    try:
        fq.rows_from(feeds, now=NOW)
        check(False, label)
    except fq.SourceProblem:
        check(True, label)


refuses([(feed(), 7)], "an empty feed is a broken answer, not a quiet planet")
refuses([({}, 7)], "so is a response with no features array")
refuses([("not json at all", 7)], "so is something that is not a payload")
refuses([(feed(*padding(3)), 7)], "so are three events in a week that normally holds a hundred")
refuses([(feed(*[quake(event_id=f"s{i}", mag=2.0) for i in range(20)]), 7)],
        "twenty quakes all below the threshold leave nothing to write, and stop the run")

# --- the SQL ----------------------------------------------------------------
rows = fq.rows_from([(feed(
    quake(event_id="us'x", place="O'Brien's Point, Alaska"), *padding(12)), 7)], now=NOW)
buffer = io.StringIO()
with redirect_stdout(buffer):
    fq.emit_sql(rows)
sql = buffer.getvalue()

check(sql.count("begin;") == 1 and sql.count("commit;") == 1, "the refresh is one transaction")
check("O''Brien''s Point" in sql and "us''x" in sql, "an apostrophe is escaped, not injected")
check("on conflict (event_id) do update set" in sql, "an existing quake is updated in place")
check("48.88" in sql and "2.38" in sql, "the position reaches the SQL as a number, not a string")
check("'5.4'" not in sql and "5.4" in sql, "so does the magnitude")
check("delete from public.quake_events where refreshed_at < now();" in sql,
      "whatever USGS stopped listing is deleted")
check(sql.index("insert into") < sql.index("delete from"),
      "the delete runs after the inserts, so nothing is dropped before it is replaced")
check("interval" not in sql,
      "the delete uses the transaction clock rather than a tuned interval")

# --- report -----------------------------------------------------------------
failed = [label for ok, label in results if not ok]
for ok, label in results:
    print(("  ok    " if ok else "  FAIL  ") + label)
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
