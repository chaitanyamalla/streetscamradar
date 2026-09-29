#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Checks fetch_disasters.py against stub payloads, without the network.
#
# This generator is the only thing that writes to disaster_alerts and it runs
# unattended. The case that matters is not the happy one: it is the run where
# GDACS answers badly and a credulous loader clears every ongoing disaster from
# the map, leaving a reassuring blank where a cyclone was.
#
# Run: python3 supabase/ops/fetch_disasters_test.py
# ---------------------------------------------------------------------------
import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_disasters as fd  # noqa: E402

results = []


def check(condition, label):
    results.append((bool(condition), label))


def event(kind="FL", level="Orange", name="Flood in France", countries=("FR",),
          event_id=1, episode=1, current="true", url=None, **extra):
    affected = ", ".join(
        "{'iso2': '%s', 'iso3': 'XXX', 'countryname': 'Somewhere'}" % c for c in countries)
    props = {
        "eventtype": kind, "alertlevel": level, "name": name, "description": name,
        "eventid": event_id, "episodeid": episode, "iscurrent": current,
        "fromdate": "2026-09-18T01:00:00", "todate": "2026-09-29T01:00:00",
        "affectedcountries": f"[{affected}]",
        "url": url if url is not None else {"report": "https://www.gdacs.org/report"},
    }
    props.update(extra)
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "Point", "coordinates": [2.3, 46.6]}}


def payload(features):
    return {"type": "FeatureCollection", "features": features}


def filler(n, level="Green"):
    """Events that exist but should not be stored — the feed's usual bulk."""
    return [event(level=level, name=f"Thing {i}", event_id=1000 + i) for i in range(n)]


# --- a normal response ------------------------------------------------------
rows = fd.rows_from(payload(filler(40) + [
    event("FL", "Orange", "Flood in France", ("FR",), 1),
    event("TC", "Red", "Cyclone Alpha", ("MZ", "MG"), 2),
    event("VO", "Red", "Volcano in Italy", ("IT",), 3),
]))
by_key = {(r["event_id"], r["country_code"]): r for r in rows}

check(len(rows) == 4, f"one row per event per country ({len(rows)})")
check(("TC-2-1", "MZ") in by_key and ("TC-2-1", "MG") in by_key,
      "an event crossing two countries becomes two rows")
check(by_key[("FL-1-1", "FR")]["kind"] == "flood", "eventtype maps to a kind")
check(by_key[("TC-2-1", "MZ")]["severity"] == "severe", "Red is severe")
check(by_key[("FL-1-1", "FR")]["severity"] == "notice", "Orange is a notice")
check(all(r["kind"] != "Thing" for r in rows), "Green events are the routine background and are dropped")
check(by_key[("FL-1-1", "FR")]["from_date"].startswith("2026-09-18"), "dates parse")
check(by_key[("FL-1-1", "FR")]["from_date"].endswith("+00:00"),
      "and are pinned to UTC rather than left for Postgres to guess")
check(by_key[("FL-1-1", "FR")]["url"] == "https://www.gdacs.org/report",
      "the report link is taken out of the url object")
check([(r["country_code"], r["event_id"]) for r in rows]
      == sorted((r["country_code"], r["event_id"]) for r in rows),
      "rows come out in a stable order")

# --- the responses that would empty the table -------------------------------
for broken, label in [
    ({}, "an empty object"),
    ({"features": []}, "an empty feature list"),
    ({"features": None}, "a null feature list"),
    ([], "a JSON array"),
    ("nope", "a bare string"),
    (payload(filler(5)), "a feed with only five events"),
    (payload(filler(fd.MIN_PLAUSIBLE_EVENTS - 1)), "one event short of plausible"),
]:
    try:
        fd.rows_from(broken)
        check(False, f"{label} is refused")
    except fd.SourceProblem:
        check(True, f"{label} is refused")

# A full feed where nothing names a country cannot answer the only question
# this table exists for, so it is refused too rather than silently emptying.
try:
    fd.rows_from(payload([event(countries=(), event_id=i) for i in range(40)]))
    check(False, "a full feed naming no countries is refused")
except fd.SourceProblem:
    check(True, "a full feed naming no countries is refused")

# --- rubbish inside an otherwise good response ------------------------------
rows = fd.rows_from(payload(filler(40) + [
    event("FL", "Orange", "Good", ("FR",), 1),
    event("ZZ", "Red", "Unknown kind", ("FR",), 2),
    event("FL", "Red", "", ("FR",), 3),
    event("FL", "Red", "Not current", ("FR",), 4, current="false"),
    event("FL", "Red", "Bad codes", ("FRANCE", "1", ""), 5),
    {"type": "Feature", "properties": "not an object"},
]))
names = {r["name"] for r in rows}
check(names == {"Good"}, f"only the usable event survives ({sorted(names)})")

# --- awkward values ---------------------------------------------------------
check(fd.as_timestamp("") is None, "a blank date is not a date")
check(fd.as_timestamp("not a date") is None, "an unparseable date is not a date")
check(fd.as_timestamp(None) is None, "a missing date is not a date")
check(fd.as_timestamp("2026-09-18T01:00:00Z").startswith("2026-09-18"), "a Z-suffixed date parses")
check(fd.countries_of({"affectedcountries": "[]"}) == [], "no countries is not a crash")
check(fd.countries_of({}) == [], "a missing country list is not a crash")
check(fd.countries_of({"affectedcountries": "{broken"}) == [], "unparseable countries is not a crash")
check(fd.countries_of({"affectedcountries": "[{'iso2': 'FR'}, {'iso2': 'FR'}]"}) == ["FR"],
      "a country named twice yields one code")

# --- the SQL ----------------------------------------------------------------
rows = fd.rows_from(payload(filler(40) + [event(name="O'Brien's flood", countries=("FR",))]))
buffer = io.StringIO()
with redirect_stdout(buffer):
    fd.emit_sql(rows)
sql = buffer.getvalue()

check(sql.count("begin;") == 1 and sql.count("commit;") == 1, "the refresh is one transaction")
check("O''Brien''s flood" in sql, "an apostrophe is escaped, not injected")
check("on conflict (event_id, country_code) do update set" in sql, "an existing row is updated in place")
check("delete from public.disaster_alerts where refreshed_at < now();" in sql,
      "whatever GDACS stopped listing is deleted")
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
