#!/usr/bin/env python3
"""
Fetch police stations and hospitals from OpenStreetMap and emit SQL to load
them into public.safety_places.

Run from .github/workflows/safety-data.yml, where a GitHub runner has the
network access to reach Overpass. Reads "city,country_code,lat,lng" rows on
stdin — one per place that has scam reports — and writes SQL to stdout, so the
exact statements can be read in the job log before they touch the database.

Coverage is per CITY, not per point. An earlier version searched a 5km radius
around report coordinates rounded to 0.1 degrees, which displaced the centre by
up to 7.8km and then covered a disc far smaller than a city: in Leipzig that
centre landed southwest of town, and the Uniklinik and the Paunsdorf police
station both fell outside it. Each city's real bounding box is looked up from
Nominatim and handed to Overpass, so a city is covered edge to edge.

Nothing here talks to the database. It reads OSM, writes SQL, and the workflow
pipes that into psql.
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
TIMEOUT_S = 45         # generous: this is a background job, not a page load
PAUSE_S = 3            # between areas, to stay a good citizen
RETRIES = 2            # per area, across all mirrors, before giving up on it
MAX_PER_AREA = 1000


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


def overpass(area, lat, lng):
    """
    One area's worth of places, or None if every mirror gave up on it.

    Returns None rather than raising: Overpass 504s and read timeouts are
    routine on the free instances, and one unlucky area must not throw away
    the areas that did come back. The caller skips and carries on.
    """
    if area:
        south, west, north, east = area
        scope = f"({south},{west},{north},{east})"
    else:
        scope = f"(around:{RADIUS_M},{lat},{lng})"
    query = (
        f"[out:json][timeout:60];"
        f'nwr["amenity"~"^(hospital|police)$"]{scope};'
        f"out center {MAX_PER_AREA};"
    )
    body = urllib.parse.urlencode({"data": query}).encode()

    for attempt in range(1, RETRIES + 1):
        for url in MIRRORS:
            try:
                req = urllib.request.Request(
                    url, data=body,
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded",
                        # Overpass asks callers to identify themselves.
                        "User-Agent": "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)",
                    },
                )
                with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
                    return json.loads(res.read().decode())
            except Exception as err:                  # noqa: BLE001
                host = url.split("/")[2]
                print(f"--   attempt {attempt} via {host}: {err}", file=sys.stderr)
        if attempt < RETRIES:
            time.sleep(PAUSE_S * 2)
    return None


def to_row(el):
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
    return {
        "id": f"{el.get('type')}/{el.get('id')}",
        "kind": kind,
        "name": name,
        "address": street or None,
        "lat": float(lat),
        "lng": float(lng),
    }


def sql_str(value):
    if value is None:
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def main():
    centres = []
    for line in sys.stdin:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(",")
        try:
            if len(parts) >= 4:
                city, country = parts[0].strip(), parts[1].strip()
                centres.append((city or None, country or None, float(parts[2]), float(parts[3])))
            else:   # bare "lat,lng", e.g. from the extra_areas input
                centres.append((None, None, float(parts[0]), float(parts[1])))
        except ValueError:
            print(f"-- skipping unparsable line: {line!r}", file=sys.stderr)

    if not centres:
        print("-- no areas to fetch; nothing to do")
        return

    rows = {}
    skipped = []
    for i, (city, country, lat, lng) in enumerate(centres, 1):
        label = f"{city} ({country})" if city else f"{lat},{lng}"
        print(f"-- [{i}/{len(centres)}] {label}", file=sys.stderr)

        area = city_bbox(city, country, lat, lng)
        if area:
            print(f"--   whole city: {area}", file=sys.stderr)
        else:
            print(f"--   falling back to {RADIUS_M // 1000}km around {lat},{lng}", file=sys.stderr)
        time.sleep(1.1)   # Nominatim asks for no more than one call a second

        result = overpass(area, lat, lng)
        if result is None:
            print(f"--   giving up on {label} — keeping the rest", file=sys.stderr)
            skipped.append(label)
        else:
            for el in result.get("elements", []):
                row = to_row(el)
                if row:
                    rows[row["id"]] = row  # dedupe across overlapping areas
        if i < len(centres):
            time.sleep(PAUSE_S)

    done = len(centres) - len(skipped)
    summary = f"{len(rows)} places from {done}/{len(centres)} areas"
    if skipped:
        summary += f" ({len(skipped)} skipped: " + "; ".join(skipped) + ")"
    print(f"-- {summary}")
    print(f"-- {summary}", file=sys.stderr)

    # Only a total washout is a failure. Partial data beats no data, and the
    # next scheduled run picks up whatever was missed.
    if not rows:
        print("-- nothing fetched; failing so this does not pass silently", file=sys.stderr)
        sys.exit(1)

    print("begin;")
    for row in rows.values():
        print(
            "insert into public.safety_places (id, kind, name, address, lat, lng, updated_at) values ("
            f"{sql_str(row['id'])}, {sql_str(row['kind'])}, {sql_str(row['name'])}, "
            f"{sql_str(row['address'])}, {row['lat']}, {row['lng']}, now()) "
            "on conflict (id) do update set "
            "kind = excluded.kind, name = excluded.name, address = excluded.address, "
            "lat = excluded.lat, lng = excluded.lng, updated_at = now();"
        )
    print("commit;")
    print("select kind, count(*) from public.safety_places group by kind order by kind;")


if __name__ == "__main__":
    main()
