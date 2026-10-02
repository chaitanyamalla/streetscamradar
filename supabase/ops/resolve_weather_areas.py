#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Turn a met service's area NAMES into points, once, into public.weather_areas.
#
# Thirty of MeteoAlarm's thirty-eight services send no geometry — only a region
# code we have no shapes for. But every one of them names the area in words, and
# a name can be looked up. That is the whole of this file.
#
# WHAT A PROBE OF THE LIVE NAMES FOUND, and why the rules below exist
# -------------------------------------------------------------------
# Thirty real area names were put to a geocoder with no constraints. Six came
# back in the WRONG COUNTRY:
#
#   Guarda       (Portugal)    -> Italy
#   Portalegre   (Portugal)    -> Brazil
#   Beja         (Portugal)    -> "Bejan", Romania
#   Limburg      (Netherlands) -> Germany
#   Drenthe      (Netherlands) -> the United States
#   Flevoland    (Netherlands) -> "Fleseland", Norway
#
# and several more landed in the wrong town inside the right country — "Évora"
# matched "Évora de Alcobaça", "Noord-Brabant" matched "Noordschans".
#
# A marker in the wrong valley is worse than no marker at all, so three rules,
# each of which catches a different one of those failures:
#
#   1. ASK WITHIN THE COUNTRY. The geocoder is told which country, so Portugal's
#      Guarda cannot be Italy's and Drenthe cannot be in Michigan.
#
#   2. THE NAME MUST MATCH EXACTLY, accents and case aside. This is what rejects
#      "Fleseland" for Flevoland and "Évora de Alcobaça" for Évora. A near miss
#      is not a weaker answer, it is a different place.
#
#   3. THE POINT MUST BE INSIDE THE COUNTRY, and inside Europe. The country's own
#      bounding box comes from the same geocoder, so no coordinates are written
#      down here and guessed at. The Europe box is the backstop: MeteoAlarm is a
#      European system, and anything outside that rectangle is wrong whatever
#      else agreed with it — which is the cheapest possible check against Spain
#      landing in Brazil.
#
# Whatever fails all that gets the middle of its own country, recorded as such,
# and the popup says "somewhere in Spain" rather than implying a street corner.
#
# Nominatim rather than Photon: it takes a countrycodes filter and returns a
# bounding box, and rule 1 and rule 3 both need those. Its terms ask for at most
# one request a second and a real User-Agent; both are honoured below, and the
# work is capped per run so a cold start spreads over a few hours instead of
# arriving as a thousand requests.
#
# Usage:
#   python3 resolve_weather_areas.py todo.tsv > areas.sql
#   (todo.tsv is "<country_code>\t<area_name>" per line, from psql)
# ---------------------------------------------------------------------------
import json
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_weather as fw  # noqa: E402  — for the country list, kept in one place

ENDPOINT = "https://nominatim.openstreetmap.org/search"
UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"
TIMEOUT = 20

# Nominatim's usage policy: no more than one request a second. 1.1 to be sure,
# and the page's own geocoder config uses the same number.
PAUSE = 1.1

# How many NEW names one run will look up. Europe has a few hundred in total and
# they almost never change, so after the first few runs this is reached only when
# a service renames something. Capped so a cold start is spread over a few hours
# rather than arriving as one long burst at somebody else's free service.
MAX_PER_RUN = 120

# The backstop, and the reason it can be this simple: MeteoAlarm is a European
# system. Everything it covers is inside this rectangle, including the awkward
# bits — the Canaries at 27.6°N, the Azores at 31.3°W, Svalbard at 81°N, Cyprus
# and Israel in the south-east corner, and Ukraine's eastern edge at 40°E.
# Nothing outside it can be right, which is what catches Brazil and Michigan
# even if every other rule somehow agreed.
EUROPE = {"minLat": 27.0, "maxLat": 82.0, "minLng": -32.0, "maxLng": 45.0}


def plain(text):
    """A name with its accents, case and punctuation taken off, for comparing.

    "Évora" and "evora" are the same name; "Évora de Alcobaça" is not.
    """
    folded = unicodedata.normalize("NFKD", str(text or ""))
    folded = "".join(c for c in folded if not unicodedata.combining(c))
    keep = [c.lower() if c.isalnum() or c.isspace() else " " for c in folded]
    return " ".join("".join(keep).split())


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


def in_box(lat, lng, box):
    return (box["minLat"] <= lat <= box["maxLat"]
            and box["minLng"] <= lng <= box["maxLng"])


def point_of(entry):
    try:
        return float(entry["lat"]), float(entry["lon"])
    except (KeyError, TypeError, ValueError):
        return None, None


def box_of(entry):
    """Nominatim's boundingbox: [south, north, west, east], as strings."""
    try:
        south, north, west, east = (float(v) for v in entry["boundingbox"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (south < north and west < east):
        return None
    return {"minLat": south, "maxLat": north, "minLng": west, "maxLng": east}


def resolve_country(code):
    """The middle of a country and the box around it, from the geocoder itself.

    Both are needed: the middle is the fallback for a name nothing could place,
    and the box is what says a candidate is actually in the country rather than
    merely answered under its name.
    """
    name = country_name(code)
    if not name:
        return None
    for entry in ask({"q": name, "countrycodes": code.lower()}):
        lat, lng = point_of(entry)
        if lat is None or not in_box(lat, lng, EUROPE):
            continue
        return {"lat": round(lat, 4), "lng": round(lng, 4), "box": box_of(entry)}
    return None


def resolve_area(code, area, country):
    """Where an area name is, or the country's middle if we cannot be sure.

    Returns (lat, lng, matched). `matched` is 'area' when the geocoder named this
    exact place inside the right country, and 'country' when it did not — which
    the page then says out loud rather than implying a precision it has not got.
    """
    wanted = plain(area)
    if wanted:
        for entry in ask({"q": area, "countrycodes": code.lower()}):
            lat, lng = point_of(entry)
            if lat is None:
                continue
            # Rule 2: the same name, not a name beginning with it.
            if plain(entry.get("name") or
                     str(entry.get("display_name", "")).split(",")[0]) != wanted:
                continue
            # Rule 3: inside the country, and inside Europe.
            if not in_box(lat, lng, EUROPE):
                continue
            if country and country.get("box") and not in_box(lat, lng, country["box"]):
                continue
            return round(lat, 4), round(lng, 4), "area"
    if country:
        return country["lat"], country["lng"], "country"
    return None, None, None


def sql_str(value):
    return "'" + str(value).replace("'", "''") + "'"


def emit(rows):
    """The upserts, then the one update that places the warnings waiting on them.

    The update runs whether or not anything new was resolved: a warning issued
    this morning for an area resolved last week is exactly the case that matters,
    and it needs no lookup at all.
    """
    print("begin;")
    for start in range(0, len(rows), 100):
        batch = rows[start:start + 100]
        print("insert into public.weather_areas "
              "(country_code, area_name, lat, lng, matched, resolved_at) values")
        print(",\n".join(
            "  ({}, {}, {}, {}, {}, now())".format(
                sql_str(r["country_code"]), sql_str(r["area_name"]),
                r["lat"], r["lng"], sql_str(r["matched"]))
            for r in batch))
        print("on conflict (country_code, area_name) do update set "
              "lat = excluded.lat, lng = excluded.lng, "
              "matched = excluded.matched, resolved_at = now();")

    # Only rows with nothing better. A CAP polygon from the service itself beats
    # anything a geocoder can tell us about a name, so those are left alone.
    print("""
update public.weather_warnings w
   set lat = a.lat, lng = a.lng, place_kind = a.matched
  from public.weather_areas a
 where a.country_code = w.country_code
   and a.area_name = w.area_key
   and a.lat is not null
   and w.lat is null;""")
    print("commit;")
    print("select matched, count(*) from public.weather_areas group by matched;")
    print("select count(*) filter (where lat is not null) as placed, count(*) as rows_in_all "
          "from public.weather_warnings;")


def todo_from(path):
    """The work list psql handed us: country code and area name, tab separated."""
    wanted = []
    seen = set()
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        code, _, area = line.partition("\t")
        code, area = code.strip(), area.strip()
        if len(code) != 2 or not area or (code, area) in seen:
            continue
        seen.add((code, area))
        wanted.append((code.upper(), area))
    return wanted


def main():
    todo = todo_from(sys.argv[1]) if len(sys.argv) > 1 else []
    if len(todo) > MAX_PER_RUN:
        print(f"-- {len(todo)} names waiting; doing {MAX_PER_RUN} this run",
              file=sys.stderr)
        todo = todo[:MAX_PER_RUN]

    rows, countries = [], {}
    kept = fell_back = 0
    for code, area in todo:
        if code not in countries:
            countries[code] = resolve_country(code)
            time.sleep(PAUSE)
            if countries[code]:
                rows.append({"country_code": code, "area_name": "",
                             "lat": countries[code]["lat"], "lng": countries[code]["lng"],
                             "matched": "country"})
        lat, lng, matched = resolve_area(code, area, countries[code])
        time.sleep(PAUSE)
        if matched is None:
            print(f"--   no answer at all for {code} {area!r}", file=sys.stderr)
            continue
        rows.append({"country_code": code, "area_name": area,
                     "lat": lat, "lng": lng, "matched": matched})
        kept += matched == "area"
        fell_back += matched == "country"

    print(f"-- resolved {kept} by name, {fell_back} to their country", file=sys.stderr)
    emit(rows)


if __name__ == "__main__":
    main()
