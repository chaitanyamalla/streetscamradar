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
    """Events that exist but are not stored, to clear the plausibility floor.

    Green earthquakes, which is what they really are: nineteen of the hundred
    events in a typical GDACS list are earthquakes, all Green, magnitude 4.5 to
    5.6, most of them far out at sea or a hundred kilometres down. Green is
    dropped whatever the kind, so these clear the floor — which counts what
    GDACS sent — without ever reaching the table.
    """
    return [event("EQ", level, f"Thing {i}", ("ID",), 1000 + i,
                  severitydata="{'severity': 4.9, 'severitytext': "
                               "'Magnitude 4.9M, Depth:120km', 'severityunit': 'M'}")
            for i in range(n)]


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
check(all(r["kind"] != "Thing" for r in rows), "Green events are dropped, whatever the kind")
check(by_key[("FL-1-1", "FR")]["from_date"].startswith("2026-09-18"), "dates parse")
check(by_key[("FL-1-1", "FR")]["from_date"].endswith("+00:00"),
      "and are pinned to UTC rather than left for Postgres to guess")
check(by_key[("FL-1-1", "FR")]["url"] == "https://www.gdacs.org/report",
      "the report link is taken out of the url object")
check(by_key[("VO-3-1", "IT")]["lat"] == 46.6 and by_key[("VO-3-1", "IT")]["lng"] == 2.3,
      "the event's position is kept — a volcano is a point on the ground")
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


# --- Orange and Red, and nothing else ---------------------------------------
#
# Green is most of what GDACS publishes and means "this happened and nobody was
# affected". Carrying it put seventy-odd Australian bushfires on a map whose
# reader wanted to know about the four floods.
quake = lambda level, mag, depth=10, eid=500: event(
    "EQ", level, f"Earthquake M{mag}", ("ID",), eid,
    severitydata="{'severity': %s, 'severitytext': 'Magnitude %sM, Depth:%skm', "
                 "'severityunit': 'M'}" % (mag, mag, depth))

rows = fd.rows_from(payload(filler(40) + [
    event("TC", "Green", "Tropical Cyclone NOLO", ("US",), 1),
    event("WF", "Green", "Forest fires in Australia", ("AU",), 2),
    event("FL", "Green", "Flood in Guinea", ("GN",), 3),
    event("FL", "Orange", "Flood in India", ("IN",), 4),
    event("TC", "Red", "Tropical Cyclone POLO", ("MX",), 5),
]))
names = {r["name"] for r in rows}
check("Tropical Cyclone NOLO" not in names, "a green cyclone is dropped")
check("Forest fires in Australia" not in names,
      "and so is the green fire that filled the map with Australia")
check("Flood in Guinea" not in names, "and the green flood")
check(names == {"Flood in India", "Tropical Cyclone POLO"},
      f"leaving the orange and the red, and only those ({sorted(names)})")
check({r["severity"] for r in rows} == {"notice", "severe"},
      "so nothing is ever stored as routine any more")

rows = fd.rows_from(payload(filler(40) + [
    quake("Green", 5.0, 158, 501),
    quake("Green", 6.4, 12, 502),
    quake("Orange", 4.8, 30, 503),
    quake("Red", 7.1, 25, 504),
]))
kept = {r["name"] for r in rows}
check("Earthquake M5.0" not in kept, "a green magnitude 5 is one nobody felt")
check("Earthquake M6.4" not in kept,
      "and a green magnitude 6.4 goes too — GDACS grades by who it reached, and "
      "green means nobody")
check("Earthquake M4.8" in kept,
      "while GDACS grading a smaller one Orange is reason enough to keep it")
check("Earthquake M7.1" in kept, "a red one, obviously")

big = next(r for r in rows if r["name"] == "Earthquake M7.1")
check(big["magnitude"] == 7.1, f"the magnitude is read off severitydata ({big['magnitude']})")
check(big["depth_km"] == 25.0, f"and so is the depth ({big['depth_km']})")

flood = next(r for r in fd.rows_from(payload(filler(40) + [
    event("FL", "Orange", "Flood in Guinea", ("GN",), 9,
          severitydata="{'severity': 0.0, 'severitytext': 'Magnitude 0 ', 'severityunit': ''}")]))
    if r["name"] == "Flood in Guinea")
check(flood["magnitude"] is None,
      "a flood's severity number is not a magnitude, and is not stored as one")

storm = next(r for r in fd.rows_from(payload(filler(40) + [
    event("TC", "Orange", "Storm", ("US",), 9,
          severitydata="{'severity': 249.9984, 'severitytext': "
                       "'Hurricane/Typhoon > 74 mph (maximum wind speed of 250 km/h)', "
                       "'severityunit': 'km/h'}")]))
    if r["name"] == "Storm")
check(storm["magnitude"] is None,
      "nor is a cyclone's wind speed, which shares the field and not the meaning")


# --- and nothing GDACS has left alone for a week ----------------------------
from datetime import datetime, timedelta, timezone  # noqa: E402

NOW = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)
ago = lambda d: (NOW - timedelta(days=d)).isoformat()

rows = fd.rows_from(payload(filler(40) + [
    event("TC", "Orange", "Storm updated today", ("US",), 11, todate=ago(0.2)),
    event("TC", "Orange", "Storm nobody has touched", ("US",), 12, todate=ago(20)),
    event("EQ", "Red", "Earthquake last month", ("JP",), 13, todate=ago(31),
          severitydata="{'severity': 7.0, 'severitytext': 'Magnitude 7M, Depth:10km', "
                       "'severityunit': 'M'}"),
    event("FL", "Orange", "Flood with no end date", ("GN",), 14, todate=""),
]), now=NOW)
names = {r["name"] for r in rows}
check("Storm updated today" in names, "an event GDACS updated today is kept")
check("Storm nobody has touched" not in names,
      "one it has not touched in twenty days is not, whatever it still lists")
check("Earthquake last month" not in names,
      "and a month-old earthquake goes even though GDACS graded it Red")
check("Flood with no end date" in names,
      "a missing date is GDACS telling us nothing, which is not the same as telling us it is old")

# The cut is on the last update, not on when it started: a cyclone GDACS has
# tracked for a fortnight and updated an hour ago is a storm still happening.
rows = fd.rows_from(payload(filler(40) + [
    event("TC", "Red", "Long-running cyclone", ("MX",), 15,
          fromdate=ago(16), todate=ago(0.1)),
]), now=NOW)
check("Long-running cyclone" in {r["name"] for r in rows},
      "a storm running sixteen days but updated an hour ago stays on the map")


# --- two lists, neither of them complete ------------------------------------
#
# The India flood that started this: on gdacs.org, in SEARCH, not in
# EVENTS4APP. Taking either list alone loses most of something.
app_list = payload([event("WF", "Green", f"Fire {i}", ("AU",), 700 + i) for i in range(8)])
search_list = payload([
    event("FL", "Orange", "Flood in India", ("IN",), 1104121, todate=ago(1)),
    event("WF", "Orange", "Fire in Kenya", ("KE",), 801),
    event("VO", "Orange", "Volcano in Italy", ("IT",), 802),
])

both = fd.merge([app_list, search_list])
names = {(f["properties"]["eventtype"], f["properties"]["eventid"]) for f in both["features"]}
check(("FL", 1104121) in names, "an event only SEARCH carries is kept")
check(("WF", 700) in names, "and one only EVENTS4APP carries is kept too")
check(len(both["features"]) == 11, f"eight fires and three others, all of them ({len(both['features'])})")

# The same flood in both lists, at different episodes and different freshness.
stale_copy = payload([event("FL", "Orange", "Flood in India", ("IN",), 1104121,
                            episode=3, todate=ago(9))])
fresh_copy = payload([event("FL", "Orange", "Flood in India", ("IN",), 1104121,
                            episode=7, todate=ago(1))])
merged = fd.merge([stale_copy, fresh_copy])
check(len(merged["features"]) == 1,
      f"the same flood in both lists is one event, not two ({len(merged['features'])})")
check(merged["features"][0]["properties"]["episodeid"] == 7,
      "and it is the copy GDACS updated last")
check(len(fd.merge([fresh_copy, stale_copy])["features"]) == 1
      and fd.merge([fresh_copy, stale_copy])["features"][0]["properties"]["episodeid"] == 7,
      "whichever order the two lists arrive in")

check(len(fd.merge([])["features"]) == 0, "no lists at all merges to nothing")
check(len(fd.merge([app_list, None, "not a payload"])["features"]) == 8,
      "and a list that is not a list is skipped rather than throwing")

rows = fd.rows_from(fd.merge([payload(filler(40)), search_list]), now=NOW)
check({r["name"] for r in rows} >= {"Flood in India", "Fire in Kenya", "Volcano in Italy"},
      "the merged list goes through the ordinary rules unchanged")

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

# --- iscurrent, and the kinds it does not fit -------------------------------
#
# A probe of the live list found NOT ONE survivor of two whole kinds: 0 of 45
# earthquakes and 0 of 6 volcanoes, every one of them dropped for iscurrent
# alone. The flag is right for a flood, a storm or a fire, where the agency is
# saying the thing has finished. It is a category error for an earthquake and
# an eruption, which are recorded at a single instant. (Drought was the third,
# and is not carried at all now — see KINDS.)
BIG = "{'severity': 7.1, 'severitytext': 'Magnitude 7.1M, Depth:12km', 'severityunit': 'M'}"
rows = fd.rows_from(payload(filler(40) + [
    event("EQ", "Orange", "Quake two days ago", ("ID",), 7001, current="false",
          fromdate="2026-09-27T04:00:00", todate="2026-09-27T04:00:00", severitydata=BIG),
    event("EQ", "Orange", "Quake five weeks ago", ("ID",), 7002, current="false",
          fromdate="2026-08-24T04:00:00", todate="2026-08-24T04:00:00", severitydata=BIG),
    event("EQ", "Orange", "Quake with no date at all", ("ID",), 7003, current="false",
          fromdate="", todate="", severitydata=BIG),
    event("FL", "Red", "Flood the agency called over", ("FR",), 7004, current="false"),
]), now=NOW)
names = {r["name"] for r in rows}
check("Quake two days ago" in names,
      "a significant earthquake stays on the map after GDACS stops calling it current")
check("Quake five weeks ago" not in names,
      "but the week's cut still removes an old one, which is all that kept them out before")
check("Quake with no date at all" not in names,
      "an earthquake nobody dated cannot be placed in the week, so it is not stored")
check("Flood the agency called over" not in names,
      "and iscurrent still means what it says for a kind that can finish")

# The same flag, the same week's cut, for the eruptions it does not fit either.
rows = fd.rows_from(payload(filler(40) + [
    event("VO", "Orange", "Eruption three days ago", ("ID",), 7101, current="false",
          fromdate="2026-09-26T04:00:00", todate="2026-09-26T04:00:00"),
    event("VO", "Red", "Eruption a month ago", ("ID",), 7102, current="false",
          fromdate="2026-08-26T04:00:00", todate="2026-08-26T04:00:00"),
    event("TC", "Red", "Storm the agency called over", ("MX",), 7104, current="false"),
]), now=NOW)
names = {r["name"] for r in rows}
check("Eruption three days ago" in names,
      "an eruption is kept on its date too — GDACS never calls one current for long")
check("Eruption a month ago" not in names, "and a month-old one is still too old")
check("Storm the agency called over" not in names,
      "while a storm the agency called over is still over")


# --- drought is not a kind we carry -----------------------------------------
#
# GDACS's droughts come from the Copernicus Global Drought Observatory and are
# agricultural. One is also one event across every country it touches, so five
# of them were 48 of the table's 51 rows.
rows = fd.rows_from(payload(filler(40) + [
    event("DR", "Red", "Drought updated this morning", ("KE", "SO", "ET"), 7103,
          fromdate="2026-05-21T00:00:00", todate=ago(0.2)),
    event("FL", "Orange", "Flood in Kenya", ("KE",), 7105),
]), now=NOW)
names = {r["name"] for r in rows}
check("Drought updated this morning" not in names,
      "a red drought GDACS updated this morning is still not stored")
check("Flood in Kenya" in names,
      "and dropping the kind did not take the other kinds in those countries with it")
check(all(r["kind"] != "drought" for r in rows), "nothing reaches the table as a drought")

# --- awkward values ---------------------------------------------------------
check(fd.point_of({"geometry": {"coordinates": [2.3, 46.6]}}) == (46.6, 2.3),
      "coordinates arrive lng-first and are stored lat-first")
check(fd.point_of({}) == (None, None), "no geometry is not a crash")
check(fd.point_of({"geometry": {"coordinates": ["x", "y"]}}) == (None, None),
      "unparseable coordinates are not a position")
check(fd.point_of({"geometry": {"coordinates": [999, 999]}}) == (None, None),
      "a position off the planet is refused rather than drawn")
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
check("46.6" in sql and "2.3" in sql, "the position reaches the SQL as a number, not a string")
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
