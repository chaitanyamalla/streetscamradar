#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Checks fetch_nws.py against stub payloads, without the network.
#
# The payloads here are shaped from a real probe of api.weather.gov — 361 live
# alerts, 25 event types — including the parts that decided the rules: the
# small craft advisories that are most of the feed, the two thirds of alerts
# with no geometry at all, the alerts that start a day and a half from now, the
# periodic "Test Message", and the territories that share the national feed.
#
# The cases that matter are an alert reaching the map with the wrong country,
# and a bad morning at NWS being written down as a calm one across the States.
#
# Run: python3 supabase/ops/fetch_nws_test.py
# ---------------------------------------------------------------------------
import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_nws as nws  # noqa: E402

results = []


def check(condition, label):
    results.append((bool(condition), label))


def alert(event="Flood Warning", severity="Severe", areas="Travis, TX",
          ugc=("TXZ192",), onset="2026-10-02T07:00:00+00:00",
          ends="2026-10-03T07:00:00+00:00", geometry=None, ident=None, **extra):
    props = {
        "id": ident or f"urn:oid:2.49.0.1.840.0.{len(results)}.{event}.{areas}",
        "event": event, "severity": severity, "areaDesc": areas,
        "urgency": "Expected", "certainty": "Likely",
        "onset": onset, "effective": onset, "ends": ends, "expires": ends,
        "senderName": "NWS Austin/San Antonio TX",
        "web": "https://www.weather.gov/",
        "geocode": {"UGC": list(ugc), "SAME": []},
    }
    props.update(extra)
    return {"type": "Feature", "geometry": geometry, "properties": props}


def payload(features):
    return {"type": "FeatureCollection", "features": features}


def rows(features):
    return nws.rows_from(payload(features))


SQUARE = {"type": "Polygon", "coordinates": [[
    [-97.9, 30.1], [-97.5, 30.1], [-97.5, 30.5], [-97.9, 30.5], [-97.9, 30.1]]]}

# Enough filler that the feed looks healthy to MIN_PLAUSIBLE_ALERTS, made of
# the thing the real feed is mostly made of.
FILLER = [alert(event="Small Craft Advisory", ident=f"marine-{i}")
          for i in range(nws.MIN_PLAUSIBLE_ALERTS + 2)]

# --- what is kept, and what is not -----------------------------------------
kept = rows(FILLER + [alert()])
check(len(kept) == 1, f"the advisories about boats are dropped and the flood kept ({len(kept)})")
check(kept[0]["kind"] == "flood", f"a Flood Warning is a flood ({kept[0]['kind']})")
check(kept[0]["severity"] == "notice", "CAP Severe is our orange")

severe = rows(FILLER + [alert(event="Tornado Warning", severity="Extreme")])
check(severe and severe[0]["severity"] == "severe", "and CAP Extreme is our red")
check(severe and severe[0]["kind"] == "thunderstorm",
      "a tornado is drawn as a thunderstorm, the nearest sign we have")

for event, kind in (("Red Flag Warning", "forest-fire"),
                    ("Winter Storm Warning", "snow-ice"),
                    ("Extreme Heat Warning", "high-temperature"),
                    ("Hard Freeze Warning", "low-temperature"),
                    ("Dense Fog Advisory", "fog"),
                    ("High Wind Warning", "wind"),
                    ("Hurricane Warning", "wind"),
                    ("Coastal Flood Warning", "coastal-event"),
                    ("Storm Surge Warning", "coastal-event"),
                    ("Flash Flood Warning", "flood"),
                    ("Avalanche Warning", "avalanche")):
    check(nws.kind_of(event) == kind, f"{event!r} is {kind} (got {nws.kind_of(event)})")

# A coastal flood must not be read as an inland flood just because "flood" is
# in the name — the order of KIND_WORDS is the whole mechanism.
check(nws.kind_of("Coastal Flood Advisory") == "coastal-event",
      "'flood' inside 'coastal flood' does not win")

# The bug this list was written to prevent: "Storm Warning" is a marine event,
# and matching it as a substring silently threw away four of the most serious
# things on the feed.
for event, kind in (("Winter Storm Warning", "snow-ice"),
                    ("Ice Storm Warning", "snow-ice"),
                    ("Severe Thunderstorm Warning", "thunderstorm"),
                    ("Tropical Storm Warning", "wind")):
    check(nws.kind_of(event) == kind,
          f"{event!r} survives the marine list as {kind} (got {nws.kind_of(event)})")
check(nws.kind_of("Storm Warning") is None and nws.kind_of("Gale Warning") is None,
      "while the bare marine names it is there for are still dropped")

check(nws.kind_of("Test Message") is None,
      "the keep-alive test alert never reaches a traveller's map")
check(nws.kind_of("Gale Warning") is None and nws.kind_of("Hazardous Seas Warning") is None,
      "the marine-only types are dropped by name")
check(nws.kind_of("Air Quality Alert") is None,
      "an event we have no sign for is dropped rather than drawn as something else")

moderate = rows(FILLER + [alert(severity="Moderate"), alert(severity="Minor"),
                          alert(severity="Unknown")])
check(not moderate, "Moderate, Minor and Unknown are the routine background we do not carry")

# --- where it is -----------------------------------------------------------
placed = rows(FILLER + [alert(geometry=SQUARE)])
check(placed and placed[0]["lat"] is not None and placed[0]["lng"] is not None,
      "an alert with a polygon gets a position")
check(placed and abs(placed[0]["lat"] - 30.3) < 0.05 and abs(placed[0]["lng"] + 97.7) < 0.05,
      f"and it is the middle of the polygon ({placed and (placed[0]['lat'], placed[0]['lng'])})")

unplaced = rows(FILLER + [alert(geometry=None)])
check(unplaced and unplaced[0]["lat"] is None,
      "an alert with no geometry is still stored, with no position")

multi = nws.centre_of({"type": "MultiPolygon", "coordinates": [SQUARE["coordinates"]]})
check(multi[0] is not None, "a MultiPolygon is placed too")
check(nws.centre_of(None) == (None, None), "and nonsense geometry is no position, not a crash")
check(nws.centre_of({"type": "Point", "coordinates": [1, 2]}) == (None, None),
      "a bare Point is not a shape we take a centre of")

# --- which country ---------------------------------------------------------
for ugc, country in (("TXZ192", "US"), ("CAZ006", "US"), ("PRZ001", "PR"),
                     ("VIZ001", "VI"), ("GUZ001", "GU"), ("MPZ001", "MP"),
                     ("ASZ001", "AS")):
    got = nws.country_of({"geocode": {"UGC": [ugc]}})
    check(got == country, f"{ugc} belongs to {country} (got {got})")
check(nws.country_of({}) == "US",
      "an alert with no zone codes is the United States rather than nothing")
check(nws.country_of({"geocode": {"UGC": None}}) == "US",
      "and so is one with a broken geocode block")

pr = rows(FILLER + [alert(areas="San Juan", ugc=("PRZ001",))])
check(pr and pr[0]["country_code"] == "PR",
      "a warning for San Juan is filed under Puerto Rico, where the map will look for it")

# --- what is not yet happening ---------------------------------------------
ahead = rows(FILLER + [alert(onset="2026-10-04T12:00:00+00:00",
                             ends="2026-10-04T23:00:00+00:00")])
check(ahead and ahead[0]["from_date"].startswith("2026-10-04"),
      "an alert that starts the day after tomorrow is kept, with its own start time")

# --- a bad morning at NWS --------------------------------------------------
for bad, why in ((None, "a payload that is not an object"),
                 ({}, "a payload with no features"),
                 ({"features": "nope"}, "features that are not a list"),
                 ({"features": []}, "an empty feed"),
                 ({"features": [alert()]}, "a feed with one alert in it")):
    try:
        nws.rows_from(bad)
        check(False, f"{why} is refused")
    except nws.SourceProblem:
        check(True, f"{why} is refused")

# A healthy feed with nothing dangerous in it is NOT a failure: it is the
# delete on its own, which is how "nothing is in force" gets written down.
quiet = rows(FILLER)
check(quiet == [], "a healthy feed of boat advisories yields no rows")

buffer = io.StringIO()
with redirect_stdout(buffer):
    nws.emit_sql([])
empty = buffer.getvalue()
check("insert into" not in empty and "delete from" in empty,
      "and that clears the table rather than leaving this morning's warnings up")
check("'US'" in empty and "'PR'" in empty,
      "the delete names every country this generator owns")
check("country_code in (" in empty and "AT" not in empty,
      "and nothing MeteoAlarm wrote is in its way")

# --- the SQL ---------------------------------------------------------------
buffer = io.StringIO()
with redirect_stdout(buffer):
    nws.emit_sql(rows(FILLER + [alert(geometry=SQUARE), alert(areas="Bexar, TX")]))
sql = buffer.getvalue()
check(sql.startswith("begin;") and sql.rstrip().endswith("commit;"),
      "one transaction, so a half-written refresh never reaches the page")
check("on conflict (warning_id, country_code) do update" in sql,
      "a warning already stored is updated rather than duplicated")
check("lat = excluded.lat" in sql and "lng = excluded.lng" in sql,
      "and a position that moved is updated with it")
check("null" in sql, "an alert with no position writes null, not a zero")

quoted = rows(FILLER + [alert(areas="O'Brien, IA")])
buffer = io.StringIO()
with redirect_stdout(buffer):
    nws.emit_sql(quoted)
check("O''Brien" in buffer.getvalue(), "an apostrophe in a county name is escaped")

# --- the kinds the table allows -------------------------------------------
schema = (Path(__file__).resolve().parents[1] / "schema.sql").read_text(encoding="utf-8")
at = schema.index("create table if not exists public.weather_warnings")
allowed = schema[at:schema.index(");", at)]
for _, kind in nws.KIND_WORDS:
    check(f"'{kind}'" in allowed, f"the table allows the kind {kind!r}")

# --- report ---------------------------------------------------------------
failed = [label for ok, label in results if not ok]
for ok, label in results:
    print(("  ok    " if ok else "  FAIL  ") + label)
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
