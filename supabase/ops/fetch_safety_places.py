#!/usr/bin/env python3
"""
Fetch police stations and hospitals from OpenStreetMap and emit SQL to load
them into public.safety_places.

Run from .github/workflows/safety-data.yml, where a GitHub runner has the
network access to reach Overpass. Reads areas on stdin and writes SQL to
stdout, so the exact statements can be read in the job log before they touch
the database. Nothing here talks to the database.

Three kinds of line are understood:

  city,country_code,lat,lng   one city that has scam reports
  lat,lng                     an ad-hoc point, covered by a radius
  country:DE                  an entire country

Cities are covered per CITY, not per point. An earlier version searched a 5km
radius around report coordinates rounded to 0.1 degrees, which displaced the
centre by up to 7.8km and then covered a disc far smaller than a city: in
Leipzig that centre landed southwest of town, and the Uniklinik and the
Paunsdorf police station both fell outside it. Each city's real bounding box is
looked up from Nominatim and handed to Overpass, so a city is covered edge to
edge.

A country is covered per SUBDIVISION. One query for a whole country is too big
for the free Overpass instances and hits the result cap, so the country's
admin_level=4 subdivisions (Bundeslaender, regions, provinces) are discovered
from OSM itself and queried one at a time. That keeps each query a size
Overpass will actually answer, and means one failed subdivision costs one
subdivision rather than the country. Countries that do not tag ISO3166-2 at
that level fall back to a single country-wide query.
"""
import json
import sys
import time
import urllib.parse
import urllib.request

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
NOMINATIM = "https://nominatim.openstreetmap.org/search"
RADIUS_M = 15000       # fallback only, when a city cannot be resolved
PAUSE_S = 3            # between areas, to stay a good citizen
RETRIES = 3            # per area, across all mirrors, before giving up on it
AMENITY = 'nwr["amenity"~"^(hospital|police)$"]'

# A city is a small query; a subdivision is a large one and needs both a longer
# Overpass budget and room for far more results. The HTTP read timeout is kept
# above the Overpass timeout so we hear the server's own answer rather than
# hanging up on it.
CITY = dict(timeout=60, http=75, cap=1000, pause=PAUSE_S)
REGION = dict(timeout=180, http=200, cap=50000, pause=8)

INSERT_BATCH = 500     # rows per insert statement; see emit_sql


class Area:
    """Somewhere to search, already turned into an Overpass query."""

    def __init__(self, label, query, budget, country=None):
        self.label = label
        self.query = query
        self.budget = budget
        self.country = country


def http_post(url, body, timeout):
    req = urllib.request.Request(
        url, data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            # Overpass asks callers to identify themselves.
            "User-Agent": "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode())


def overpass(query, budget, retries=RETRIES):
    """
    One query's worth of OSM, or None if every mirror gave up on it.

    Returns None rather than raising: 504s, 429s and read timeouts are routine
    on the free instances, and one unlucky area must not throw away the areas
    that did come back. The caller skips and carries on.
    """
    body = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(1, retries + 1):
        for url in MIRRORS:
            try:
                return http_post(url, body, budget["http"])
            except Exception as err:                  # noqa: BLE001
                host = url.split("/")[2]
                print(f"--   attempt {attempt} via {host}: {err}", file=sys.stderr)
        if attempt < retries:
            # Overpass throttles by accumulated query time, so a run of heavy
            # queries earns a "too many requests" that only waiting clears.
            time.sleep(PAUSE_S * 2 ** attempt)
    return None


def city_bbox(city, country, lat, lng):
    """
    The city's bounding box from Nominatim, or None to fall back to a radius.

    Sanity-checked against the report's own coordinates: a name like "Springfield"
    can resolve to the wrong continent, and a box that does not contain the
    report that asked for it is the wrong box.
    """
    if not city:
        return None
    params = {"city": city, "format": "jsonv2", "limit": "1"}
    if country:
        params["countrycodes"] = country.lower()
    url = f"{NOMINATIM}?{urllib.parse.urlencode(params)}"
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)",
        })
        with urllib.request.urlopen(req, timeout=20) as res:
            hits = json.loads(res.read().decode())
        if not hits:
            return None
        south, north, west, east = (float(v) for v in hits[0]["boundingbox"])
    except Exception as err:                          # noqa: BLE001
        print(f"--   could not resolve {city!r}: {err}", file=sys.stderr)
        return None

    if not (south <= lat <= north and west <= lng <= east):
        print(f"--   {city!r} resolved somewhere that does not contain its own "
              f"report ({lat},{lng}) — ignoring", file=sys.stderr)
        return None
    return south, west, north, east


def city_area(city, country, lat, lng):
    label = f"{city} ({country})" if city else f"{lat},{lng}"
    box = city_bbox(city, country, lat, lng)
    if box:
        print(f"--   whole city: {box}", file=sys.stderr)
        scope = "({},{},{},{})".format(*box)
    else:
        print(f"--   falling back to {RADIUS_M // 1000}km around {lat},{lng}",
              file=sys.stderr)
        scope = f"(around:{RADIUS_M},{lat},{lng})"
    time.sleep(1.1)   # Nominatim asks for no more than one call a second
    query = (f"[out:json][timeout:{CITY['timeout']}];"
             f"{AMENITY}{scope};"
             f"out center {CITY['cap']};")
    return Area(label, query, CITY, country)


def subdivision_codes(cc):
    """The country's ISO3166-2 subdivision codes, straight from OSM."""
    query = (f'[out:json][timeout:90];'
             f'rel["ISO3166-2"~"^{cc}-"]["admin_level"="4"];'
             f'out tags;')
    result = overpass(query, REGION, retries=2)
    if result is None:
        return []
    codes = set()
    for el in result.get("elements", []):
        code = (el.get("tags") or {}).get("ISO3166-2")
        if code and code.startswith(f"{cc}-"):
            codes.add(code)
    return sorted(codes)


def country_areas(cc):
    """
    One Area per subdivision, or a single country-wide Area as a fallback.

    Splitting is not an optimisation, it is what makes the query answerable:
    every police station and hospital in Germany at once exceeds what the free
    Overpass instances will return, and a partial answer that looks complete is
    worse than no answer.
    """
    cc = cc.upper()
    codes = subdivision_codes(cc)
    if not codes:
        print(f"-- no ISO3166-2 subdivisions found for {cc}; "
              f"falling back to one country-wide query", file=sys.stderr)
        query = (f"[out:json][timeout:{REGION['timeout']}];"
                 f'rel["ISO3166-1"="{cc}"]["admin_level"="2"];map_to_area->.a;'
                 f"{AMENITY}(area.a);"
                 f"out center {REGION['cap']};")
        return [Area(cc, query, REGION, cc)]

    print(f"-- {cc}: {len(codes)} subdivisions — {', '.join(codes)}", file=sys.stderr)
    areas = []
    for code in codes:
        query = (f"[out:json][timeout:{REGION['timeout']}];"
                 f'rel["ISO3166-2"="{code}"]["admin_level"="4"];map_to_area->.a;'
                 f"{AMENITY}(area.a);"
                 f"out center {REGION['cap']};")
        areas.append(Area(code, query, REGION, cc))
    return areas


def plan(lines):
    """Turn stdin into a list of Areas, resolving cities and countries first."""
    areas = []
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.lower().startswith("country:"):
            cc = line.split(":", 1)[1].strip()
            if len(cc) != 2 or not cc.isalpha():
                print(f"-- skipping bad country code: {line!r}", file=sys.stderr)
                continue
            areas.extend(country_areas(cc))
            continue
        parts = line.split(",")
        try:
            if len(parts) >= 4:
                city, country = parts[0].strip(), parts[1].strip()
                areas.append(city_area(city or None, country or None,
                                       float(parts[2]), float(parts[3])))
            else:   # bare "lat,lng", e.g. from the extra_areas input
                areas.append(city_area(None, None, float(parts[0]), float(parts[1])))
        except ValueError:
            print(f"-- skipping unparsable line: {line!r}", file=sys.stderr)
    return areas


def to_row(el, country):
    tags = el.get("tags") or {}
    if el.get("type") == "node":
        lat, lng = el.get("lat"), el.get("lon")
    else:
        centre = el.get("center") or {}
        lat, lng = centre.get("lat"), centre.get("lon")
    if lat is None or lng is None:
        return None

    kind = "hospital" if tags.get("amenity") == "hospital" else "police"
    name = tags.get("name") or ("Hospital" if kind == "hospital" else "Police station")
    street = " ".join(x for x in (tags.get("addr:street"), tags.get("addr:housenumber")) if x)
    cc = (tags.get("addr:country") or country or "").strip().upper() or None
    return {
        "id": f"{el.get('type')}/{el.get('id')}",
        "kind": kind,
        "name": name,
        "address": street or None,
        "lat": float(lat),
        "lng": float(lng),
        "country_code": cc if cc and len(cc) == 2 else None,
    }


def sql_str(value):
    if value is None:
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def emit_sql(rows):
    """
    Batched inserts, not one statement per place.

    psql waits for each statement in turn, so a country's worth of places one
    statement at a time is thousands of round trips over the pooler — the run
    that loaded 3,949 places spent about six minutes doing nothing but that.
    Rows are already deduped by OSM id, so no batch can hit the same id twice,
    which is the one thing a multi-row ON CONFLICT cannot survive.
    """
    columns = ("id", "kind", "name", "address", "lat", "lng", "country_code")
    values = [
        "  ({}, {}, {}, {}, {}, {}, {}, now())".format(
            sql_str(r["id"]), sql_str(r["kind"]), sql_str(r["name"]),
            sql_str(r["address"]), r["lat"], r["lng"], sql_str(r["country_code"]))
        for r in rows
    ]
    print("begin;")
    for start in range(0, len(values), INSERT_BATCH):
        chunk = values[start:start + INSERT_BATCH]
        print("insert into public.safety_places ({}, updated_at) values"
              .format(", ".join(columns)))
        print(",\n".join(chunk))
        print("on conflict (id) do update set "
              "kind = excluded.kind, name = excluded.name, "
              "address = excluded.address, lat = excluded.lat, lng = excluded.lng, "
              "country_code = coalesce(excluded.country_code, "
              "public.safety_places.country_code), updated_at = now();")
    print("commit;")
    print("select kind, count(*) from public.safety_places group by kind order by kind;")


def main():
    areas = plan(sys.stdin)
    if not areas:
        print("-- no areas to fetch; nothing to do")
        return

    rows = {}
    skipped = []
    for i, area in enumerate(areas, 1):
        print(f"-- [{i}/{len(areas)}] {area.label}", file=sys.stderr)
        result = overpass(area.query, area.budget)
        if result is None:
            print(f"--   giving up on {area.label} — keeping the rest", file=sys.stderr)
            skipped.append(area.label)
        else:
            found = 0
            for el in result.get("elements", []):
                row = to_row(el, area.country)
                if not row:
                    continue
                found += 1
                previous = rows.get(row["id"])
                if previous and not row["country_code"]:
                    row["country_code"] = previous["country_code"]
                rows[row["id"]] = row   # dedupe across overlapping areas
            print(f"--   {found} places", file=sys.stderr)
        if i < len(areas):
            time.sleep(area.budget["pause"])

    done = len(areas) - len(skipped)
    summary = f"{len(rows)} places from {done}/{len(areas)} areas"
    if skipped:
        summary += f" ({len(skipped)} skipped: " + "; ".join(skipped) + ")"
    print(f"-- {summary}")
    print(f"-- {summary}", file=sys.stderr)

    # Only a total washout is a failure. Partial data beats no data, and the
    # next scheduled run picks up whatever was missed.
    if not rows:
        print("-- nothing fetched; failing so this does not pass silently", file=sys.stderr)
        sys.exit(1)

    emit_sql(list(rows.values()))


if __name__ == "__main__":
    main()
