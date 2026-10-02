#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Checks fetch_weather.py against stub payloads, without the network.
#
# The payloads here are shaped from a real probe of MeteoAlarm, including the
# parts that vary between countries: "1; Wind" in one feed and "1; wind" in the
# next, four copies of every alert in four languages, and an alert that covers
# several areas at once.
#
# The case that matters is a bad afternoon at MeteoAlarm being written down as
# a calm one across Europe.
#
# Run: python3 supabase/ops/fetch_weather_test.py
# ---------------------------------------------------------------------------
import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_weather as fw  # noqa: E402

results = []


def check(condition, label):
    results.append((bool(condition), label))


def info(language="en-GB", level="3; orange; Severe", kind="1; Wind",
         areas=("Oost-Vlaanderen",), sender="Royal Meteorological Institute",
         onset="2026-09-27T07:00:00+02:00", expires="2026-09-29T10:00:00+02:00",
         web="https://www.meteo.be/warnings", **extra):
    entry = {
        "language": language, "category": ["Met"], "event": "Yellow warning for fog",
        "responseType": ["None"], "urgency": "Immediate", "severity": "Moderate",
        "certainty": "Likely", "onset": onset, "expires": expires,
        "senderName": sender, "headline": "A warning", "web": web,
        "parameter": [
            {"valueName": "awareness_level", "value": level},
            {"valueName": "awareness_type", "value": kind},
        ],
        "area": [{"areaDesc": a, "geocode": []} for a in areas],
    }
    entry.update(extra)
    return entry


def alert(identifier="2.49.0.0.56.0.BE.1", infos=None, status="Actual",
          msg_type="Alert", **kw):
    return {"uuid": "u", "alert": {
        "identifier": identifier, "sender": "kmi-irm", "sent": "2026-09-27T07:10:00+02:00",
        "status": status, "msgType": msg_type, "scope": "Public",
        "info": infos if infos is not None else [info(**kw)],
    }}


def feed(alerts):
    return {"warnings": alerts}


def europe(extra=None, answering=25):
    """Enough countries answering to look like a working afternoon."""
    payloads = {f"X{i}": feed([]) for i in range(answering)}
    payloads.update(extra or {})
    return payloads


# --- a normal response ------------------------------------------------------
rows = fw.rows_from(europe({
    "BE": feed([alert("be-1", kind="1; Wind", level="3; orange; Severe")]),
    "DE": feed([alert("de-1", kind="2; snow-ice", level="4; red; Extreme",
                      sender="Deutscher Wetterdienst")]),
    "FR": feed([alert("fr-1", kind="10; Rain", level="2; yellow; Moderate")]),
    "ES": feed([alert("es-1", kind="8; forest-fire", level="1; green; Minor")]),
}))
by_id = {(r["warning_id"], r["country_code"]): r for r in rows}

check(len(rows) == 2, f"only orange and red are stored ({len(rows)})")
# Named rather than left to a count, because this is the rule the whole weather
# layer rests on: green and yellow are about 5,000 of the 5,600 warnings live
# across Europe on an ordinary afternoon, and carrying them would flag half the
# continent permanently and teach a reader to ignore the rest.
check(("fr-1", "FR") not in by_id, "a yellow warning is not stored")
check(("es-1", "ES") not in by_id, "and neither is a green one")
check(all(r["severity"] in ("notice", "severe") for r in rows),
      "nothing but the two grades the table allows ever reaches it")
check(by_id[("be-1", "BE")]["severity"] == "notice", "orange is a notice")
check(by_id[("de-1", "DE")]["severity"] == "severe", "red is severe")
check(by_id[("be-1", "BE")]["kind"] == "wind", "the awareness type becomes a kind")
check(by_id[("de-1", "DE")]["kind"] == "snow-ice", "including the hyphenated ones")
check(by_id[("de-1", "DE")]["source"] == "Deutscher Wetterdienst",
      "the issuing service is named, because it is the authority here")
check(by_id[("be-1", "BE")]["from_date"].endswith("+00:00"),
      "a CAP time with an offset is converted to UTC, not stored as written")
check(by_id[("be-1", "BE")]["from_date"].startswith("2026-09-27T05:"),
      "and 07:00+02:00 really is 05:00 UTC")
check(by_id[("be-1", "BE")]["url"] == "https://www.meteo.be/warnings",
      "the met service's own page is kept")

# The words after the number differ between countries; the number does not.
rows = fw.rows_from(europe({
    "AT": feed([alert("at-1", kind="1; wind", level="3; Orange; Severe")]),
    "IT": feed([alert("it-1", kind="1; Wind", level="3; orange; Severe")]),
}))
check({r["kind"] for r in rows} == {"wind"},
      "the same kind spelled two ways is one kind")
check({r["severity"] for r in rows} == {"notice"},
      "and the same level spelled two ways is one level")

# --- the responses that would empty the table -------------------------------
for broken, label in [
    ({}, "no country answering at all"),
    ({"DE": feed([])}, "one country answering"),
    (europe(answering=fw.MIN_COUNTRIES_ANSWERING - 1), "one country short of plausible"),
]:
    try:
        fw.rows_from(broken)
        check(False, f"{label} is refused")
    except fw.SourceProblem:
        check(True, f"{label} is refused")

# Europe answering properly with nothing severe is a real afternoon, not a
# failure — that one must go through.
try:
    check(fw.rows_from(europe()) == [], "a genuinely calm Europe is allowed to be empty")
except fw.SourceProblem:
    check(False, "a genuinely calm Europe is allowed to be empty")

# --- rubbish inside an otherwise good response ------------------------------
rows = fw.rows_from(europe({
    "BE": feed([
        alert("good"),
        alert("cancelled", msg_type="Cancel"),
        alert("exercise", status="Exercise"),
        alert(""),
        alert("unknown-kind", kind="99; Meteorite"),
        alert("unknown-level", level="7; puce; Unheard of"),
        alert("no-areas", areas=()),
        alert("no-info", infos=[]),
        {"uuid": "u", "alert": "not an object"},
        None,
    ]),
}))
check({r["warning_id"] for r in rows} == {"good"},
      f"only the usable warning survives ({sorted(r['warning_id'] for r in rows)})")

# A feed that names no service still names a sender id. A real orange warning
# is worth keeping with imperfect attribution; it is not worth dropping.
rows = fw.rows_from(europe({"BE": feed([alert("bare", sender="")])}))
check(rows and rows[0]["source"] == "kmi-irm",
      "with no service name, the CAP sender id is the attribution")

# --- one alert, four languages ----------------------------------------------
rows = fw.rows_from(europe({"BE": feed([alert("multi", infos=[
    info(language="nl-BE", sender="KMI"), info(language="fr-BE", sender="IRM"),
    info(language="en-GB", sender="RMI"), info(language="de-DE", sender="KMI"),
])])}))
check(len(rows) == 1, f"an alert repeated in four languages is one warning ({len(rows)})")
check(rows[0]["source"] == "RMI", "and English is the copy read, where offered")

rows = fw.rows_from(europe({"BE": feed([alert("nl-only", infos=[
    info(language="nl-BE", sender="KMI"), info(language="fr-BE", sender="IRM")])])}))
check(rows[0]["source"] == "KMI", "with no English copy, the first is used")

# --- several areas ----------------------------------------------------------
rows = fw.rows_from(europe({"ES": feed([alert(
    "many", areas=("Madrid", "Toledo", "Ávila", "Segovia", "Cuenca", "Guadalajara", "Soria"))])}))
check(rows[0]["areas"].startswith("Madrid, Toledo"), "areas are named in the source's words")
check(rows[0]["areas"].endswith("…"), "and a long list says it was cut rather than lying")

# --- awkward values ---------------------------------------------------------
check(fw.leading_number("3; orange; Severe") == 3, "the code in front is read")
check(fw.leading_number("orange") is None, "a level with no code is not a level")
check(fw.leading_number(None) is None, "a missing level is not a level")
check(fw.as_timestamp("") is None, "a blank time is not a time")
check(fw.as_timestamp("not a time") is None, "an unparseable time is not a time")
check(fw.as_timestamp("2026-09-27T07:00:00Z").startswith("2026-09-27T07:"),
      "a Z-suffixed time parses")

# --- the SQL ----------------------------------------------------------------
rows = fw.rows_from(europe({"IE": feed([alert("ie-1", areas=("Donegal's coast",),
                                              sender="Met Éireann")])}))
buffer = io.StringIO()
with redirect_stdout(buffer):
    fw.emit_sql(rows)
sql = buffer.getvalue()

check(sql.count("begin;") == 1 and sql.count("commit;") == 1, "the refresh is one transaction")
check("Donegal''s coast" in sql, "an apostrophe is escaped, not injected")
check("on conflict (warning_id, country_code) do update set" in sql,
      "an existing warning is updated in place")
check("refreshed_at < now();" in sql and "country_code in (" in sql,
      "whatever MeteoAlarm stopped publishing is deleted")
# The bug this guards: the table has two writers now. NOAA writes the United
# States and runs after this step, so an unscoped delete here removed every US
# row on every refresh and they only came back because the next step happened to
# succeed. A generator deletes what it wrote and nothing else.
stale = sql[sql.index("refreshed_at < now();") - 400:sql.index("refreshed_at < now();")]
check("'ES'" in stale and "'DE'" in stale,
      "and the delete names MeteoAlarm's own countries")
check("'US'" not in stale,
      "and never touches a row another generator wrote")
check("to_date < now()" in sql,
      "and so is a warning that has simply run out, which weather warnings do")
check(sql.index("insert into") < sql.index("delete from"),
      "the delete runs after the inserts, so nothing is dropped before it is replaced")

buffer = io.StringIO()
with redirect_stdout(buffer):
    fw.emit_sql([])
empty = buffer.getvalue()
check("insert into" not in empty and "delete from" in empty,
      "a calm afternoon still clears the table rather than leaving yesterday's warnings up")

# --- where a warning is, when the feed says ---------------------------------
# Eight of the thirty-eight countries send a CAP <polygon>; the rest send region
# codes only. The trap is the coordinate order: CAP writes "lat,lon" and GeoJSON
# wants "lon,lat", so reading the pairs the wrong way round puts a warning for
# the Gulf of Finland in Somalia.
GULF = ("58.9909,23.0513 58.9858,22.8864 59.3382,22.8386 59.4833,23.1917")

lat, lng = fw.centre_of({"polygon": [GULF]})
check(lat is not None, "an area with a polygon gets a position")
check(55 < lat < 61 and 20 < lng < 26,
      f"and it is in the Gulf of Finland, not in Somalia ({lat}, {lng})")
check(lat > lng, "latitude is read first, as CAP writes it")

check(fw.centre_of({"polygon": GULF})[0] is not None,
      "a polygon sent as a bare string rather than a list is read too")
check(fw.centre_of({"areaDesc": "Somewhere"}) == (None, None),
      "an area with no polygon is no position — most of Europe is this")
check(fw.centre_of({"polygon": []}) == (None, None), "an empty polygon list too")
check(fw.centre_of({"polygon": ["nonsense here"]}) == (None, None),
      "and nonsense is no position rather than a crash")
check(fw.centre_of({"polygon": ["999,999 998,998"]}) == (None, None),
      "coordinates off the Earth are refused")
check(fw.centre_of(None) == (None, None), "and so is no area at all")

# A warning over six provinces takes the first NAMED area's shape, not the
# average of all six — the average can be somewhere the warning does not apply.
first = fw.position_of({"area": [
    {"areaDesc": "No shape here"},
    {"areaDesc": "Gulf", "polygon": [GULF]},
]})
check(first[0] is not None, "the first area that has a shape is the one used")
check(fw.position_of({"area": [{"areaDesc": "Nowhere"}]}) == (None, None),
      "and a warning where no area has a shape has no position, not a guess")
check(fw.position_of({}) == (None, None), "nor does one with no areas at all")

# The whole point: it reaches the SQL.
buffer = io.StringIO()
with redirect_stdout(buffer):
    fw.emit_sql([{"warning_id": "x", "country_code": "EE", "kind": "wind",
                  "severity": "severe", "areas": "Gulf", "from_date": None,
                  "to_date": None, "source": "Riigi Ilmateenistus", "url": None,
                  "lat": 59.2, "lng": 23.0}])
placed_sql = buffer.getvalue()
check("59.2" in placed_sql and "23.0" in placed_sql,
      "a position reaches the insert")
# coalesce rather than a plain assignment, and this is the case it is for: a
# warning positioned by the area lookup has no polygon of its own, so an
# `excluded.lat` of null would wipe its marker on every single refresh and only
# put it back if the resolve step that follows happened to succeed.
check("lat = coalesce(excluded.lat" in placed_sql,
      "a position already stored survives a refresh that brings none")
check("area_key = excluded.area_key" in placed_sql,
      "while the area it is positioned ON is always taken from the feed, since "
      "that is what the lookup joins to")

buffer = io.StringIO()
with redirect_stdout(buffer):
    fw.emit_sql([{"warning_id": "y", "country_code": "ES", "kind": "wind",
                  "severity": "severe", "areas": "Litoral de Barcelona",
                  "from_date": None, "to_date": None, "source": "AEMET",
                  "url": None, "lat": None, "lng": None}])
check("null" in buffer.getvalue(),
      "and a warning with no position writes null, not a zero off West Africa")

# --- the country list -------------------------------------------------------
check(len(fw.COUNTRIES) == len(set(fw.COUNTRIES.values())),
      "no two feed slugs claim the same country")
check(all(len(c) == 2 and c.isupper() for c in fw.COUNTRIES.values()),
      "every country is a two-letter code the page can match on")

# --- report -----------------------------------------------------------------
failed = [label for ok, label in results if not ok]
for ok, label in results:
    print(("  ok    " if ok else "  FAIL  ") + label)
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
