#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Where each country MeteoAlarm covers is, so its warnings can be drawn.
#
# This used to try much harder. It took each warning's AREA name — "Litoral de
# Barcelona", "East Sterea & Evvoia" — and looked that up, under three rules
# needed to stop a geocoder answering with Brazil. It worked, and it was not
# worth it: those names are weather zones rather than places, so 28 of 30 could
# not be matched at all and fell back to the country anyway.
#
# So the country IS the answer, and asking for it directly is the whole job. One
# lookup per country, thirty-eight in total, ever. We are not a met service; we
# are a travel map saying "Spain has a red wind warning out, here is MeteoAlarm".
#
# A service that sends a real shape still beats this — eight of the thirty-eight
# put a CAP polygon in their warnings and those are drawn where the service put
# them, which costs nothing and is strictly better. Everything else sits on its
# country and the popup says so.
#
# Nominatim: it takes a countrycodes filter, its terms ask for at most one
# request a second, and both are honoured below.
#
# Usage:
#   python3 resolve_weather_places.py todo.txt > places.sql
#   (todo.txt is one country code per line, from psql)
# ---------------------------------------------------------------------------
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_weather as fw  # noqa: E402  — for the country list, kept in one place

ENDPOINT = "https://nominatim.openstreetmap.org/search"
UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"
TIMEOUT = 20

# Nominatim's usage policy: no more than one request a second. The page's own
# geocoder config uses the same number.
PAUSE = 1.1

# MeteoAlarm is a European system, so anything outside this rectangle is wrong
# whatever else agreed with it. It is the cheapest check there is and it is the
# one that stopped Portugal being placed in Brazil. The awkward edges are all
# inside it: the Canaries at 27.6°N, the Azores at 31.3°W, Svalbard at 81°N,
# Cyprus and Israel in the south-east, Ukraine's eastern edge at 40°E.
EUROPE = {"minLat": 27.0, "maxLat": 82.0, "minLng": -32.0, "maxLng": 45.0}


def country_name(code):
    """The country's name, from the feed slug we already keep for it.

    No second list to drift out of step: fetch_weather.COUNTRIES maps MeteoAlarm's
    own slug to the code, "united-kingdom" to GB, and a slug is a name with
    hyphens in it.
    """
    for slug, iso in fw.COUNTRIES.items():
        if iso == code:
            return slug.replace("-", " ").title()
    return None


def ask(params):
    query = urllib.parse.urlencode({**params, "format": "jsonv2", "limit": "5"})
    request = urllib.request.Request(f"{ENDPOINT}?{query}",
                                     headers={"User-Agent": UA,
                                              "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError, OSError) as err:
        print(f"--   geocoder said no: {err}", file=sys.stderr)
        return []


def in_europe(lat, lng):
    return (EUROPE["minLat"] <= lat <= EUROPE["maxLat"]
            and EUROPE["minLng"] <= lng <= EUROPE["maxLng"])


def resolve_country(code):
    """The middle of a country, or None if nothing credible came back.

    None rather than a best guess: a warning with no marker is a warning in the
    chip and the list, which is no loss. A warning on the wrong continent is.
    """
    name = country_name(code)
    if not name:
        return None
    for entry in ask({"q": name, "countrycodes": code.lower()}):
        try:
            lat, lng = float(entry["lat"]), float(entry["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not in_europe(lat, lng):
            continue
        return round(lat, 4), round(lng, 4)
    return None


def sql_str(value):
    return "'" + str(value).replace("'", "''") + "'"


def emit(rows):
    """The upserts, then the one update that places the warnings waiting on them.

    The update runs whether or not anything new was resolved: a warning issued
    this morning in a country resolved last week is the ordinary case, and it
    needs no lookup at all.
    """
    print("begin;")
    if rows:
        print("insert into public.weather_places "
              "(country_code, lat, lng, resolved_at) values")
        print(",\n".join(
            "  ({}, {}, {}, now())".format(sql_str(r["country_code"]), r["lat"], r["lng"])
            for r in rows))
        print("on conflict (country_code) do update set "
              "lat = excluded.lat, lng = excluded.lng, resolved_at = now();")

    # Only warnings with nothing better. A CAP polygon from the service itself
    # beats the middle of a country, so those are left exactly as they are.
    print("""
update public.weather_warnings w
   set lat = p.lat, lng = p.lng, place_kind = 'country'
  from public.weather_places p
 where p.country_code = w.country_code
   and p.lat is not null
   and w.lat is null;""")
    print("commit;")
    print("select count(*) filter (where lat is not null) as placed, "
          "count(*) as rows_in_all from public.weather_warnings;")


def todo_from(path):
    """The work list psql handed us: one country code per line."""
    wanted, seen = [], set()
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        code = line.strip().upper()
        if len(code) != 2 or not code.isalpha() or code in seen:
            continue
        seen.add(code)
        wanted.append(code)
    return wanted


def main():
    todo = todo_from(sys.argv[1]) if len(sys.argv) > 1 else []
    rows = []
    for code in todo:
        point = resolve_country(code)
        time.sleep(PAUSE)
        if not point:
            print(f"--   could not place {code}", file=sys.stderr)
            continue
        rows.append({"country_code": code, "lat": point[0], "lng": point[1]})

    print(f"-- placed {len(rows)} of {len(todo)} countries", file=sys.stderr)
    emit(rows)


if __name__ == "__main__":
    main()
