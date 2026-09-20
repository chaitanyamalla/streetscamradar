#!/usr/bin/env python3
"""
Fetch police stations and hospitals from OpenStreetMap and emit SQL to load
them into public.safety_places.

Run from .github/workflows/safety-data.yml, where a GitHub runner has the
network access to reach Overpass. Reads a CSV of "lat,lng" centres on stdin —
one per area that has scam reports — and writes SQL to stdout, so the exact
statements can be read in the job log before they touch the database.

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
RADIUS_M = 5000        # around each reported area
TIMEOUT_S = 45         # generous: this is a background job, not a page load
PAUSE_S = 3            # between areas, to stay a good citizen
RETRIES = 2            # per area, across all mirrors, before giving up on it
MAX_PER_AREA = 300


def overpass(lat, lng):
    """
    One area's worth of places, or None if every mirror gave up on it.

    Returns None rather than raising: Overpass 504s and read timeouts are
    routine on the free instances, and one unlucky area must not throw away
    the areas that did come back. The caller skips and carries on.
    """
    query = (
        f"[out:json][timeout:40];"
        f'nwr["amenity"~"^(hospital|police)$"](around:{RADIUS_M},{lat},{lng});'
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
        lat, _, lng = line.partition(",")
        try:
            centres.append((float(lat), float(lng)))
        except ValueError:
            print(f"-- skipping unparsable line: {line!r}", file=sys.stderr)

    if not centres:
        print("-- no areas to fetch; nothing to do")
        return

    rows = {}
    skipped = []
    for i, (lat, lng) in enumerate(centres, 1):
        print(f"-- [{i}/{len(centres)}] {lat},{lng}", file=sys.stderr)
        result = overpass(lat, lng)
        if result is None:
            print(f"--   giving up on {lat},{lng} — keeping the rest", file=sys.stderr)
            skipped.append((lat, lng))
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
        summary += f" ({len(skipped)} skipped: " + "; ".join(f"{a},{b}" for a, b in skipped) + ")"
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
