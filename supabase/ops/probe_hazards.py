#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Look at the hazard sources before writing a line of parser against them.
#
# The travel advisory work taught this the expensive way: the published schema
# said CountryCode and the live interface said countryCode, so the first real
# run rejected all two hundred entries. Rather than guess again, this prints
# what the sources actually send — their shape, their field names, and a sample
# — and answers the two questions that decide the design:
#
#   1. Do they send CORS headers? If they do, the browser can call them
#      directly and there is no staleness question at all. If not, the data has
#      to come through something of ours.
#
#   2. How many events are active at once, and how many land in one city's
#      view? That decides whether a hazards layer can be on by default without
#      burying the scam pins the site exists for.
#
# Writes nothing. Run it from the hazards workflow with `probe`.
# ---------------------------------------------------------------------------
import json
import sys
import urllib.error
import urllib.request

ORIGIN = "https://streetscamradar.vercel.app"
UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"
TIMEOUT = 45

SOURCES = {
    "GDACS": "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP",
    "USGS (past day, M2.5+)":
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
    "USGS (past week, M4.5+)":
        "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson",
}

# MeteoAlarm publishes per country rather than as one global feed, and has
# moved endpoint more than once. Rather than pick one from documentation and
# find out later, try the plausible ones and report which actually answer.
METEOALARM = {
    "MeteoAlarm feeds index": "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-europe",
    "MeteoAlarm atom (Germany)":
        "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-germany",
    "MeteoAlarm api v1 (Germany)":
        "https://feeds.meteoalarm.org/api/v1/warnings/feeds-germany",
    "MeteoAlarm api portal": "https://api.meteoalarm.org/v1/alerts",
}

# Somewhere a traveller would actually look, and the half-degree box a city
# view covers. If a typical city box holds several hazards at once, a layer
# that is on by default is noise; if it is almost always empty, it is free.
CITIES = [
    ("Lisbon", 38.72, -9.14), ("Rome", 41.90, 12.50), ("Berlin", 52.52, 13.40),
    ("Bangkok", 13.75, 100.50), ("Istanbul", 41.01, 28.98), ("Mexico City", 19.43, -99.13),
    ("Tokyo", 35.68, 139.69), ("Manila", 14.60, 120.98), ("Miami", 25.76, -80.19),
    ("Jakarta", -6.21, 106.85),
]
CITY_BOX = 0.5          # degrees either way, roughly a city-and-suburbs view


def fetch(url):
    """Body plus the headers that decide whether a browser could do this."""
    request = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "application/json", "Origin": ORIGIN,
    })
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return response.status, dict(response.headers), response.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read().decode("utf-8", "replace")[:400]
    except Exception as err:                                  # noqa: BLE001
        return None, {}, f"{type(err).__name__}: {err}"


def cors_verdict(headers):
    allow = headers.get("Access-Control-Allow-Origin")
    if allow in ("*", ORIGIN):
        return f"YES ({allow}) — the browser can call this directly"
    if allow:
        return f"partial ({allow}) — not us"
    return "NO — needs a proxy or a mirror of ours"


def shape(value, depth=0):
    """A one-line description of a JSON value, without dumping the whole thing."""
    if isinstance(value, dict):
        keys = list(value)
        return f"object({len(keys)}) {keys[:14]}{' …' if len(keys) > 14 else ''}"
    if isinstance(value, list):
        return f"array({len(value)})" + (f" of {shape(value[0], depth + 1)}" if value else "")
    text = str(value)
    return f"{type(value).__name__} {text[:60]!r}" if depth else type(value).__name__


def features_of(payload):
    """GeoJSON, or something close enough to it, as a list of features."""
    if isinstance(payload, dict):
        for key in ("features", "events", "items"):
            if isinstance(payload.get(key), list):
                return payload[key]
    return payload if isinstance(payload, list) else []


def coords_of(feature):
    geometry = feature.get("geometry") or {}
    point = geometry.get("coordinates")
    # A polygon or line gives a list of lists; the first vertex is close enough
    # for a density count.
    while isinstance(point, list) and point and isinstance(point[0], list):
        point = point[0]
    if isinstance(point, list) and len(point) >= 2:
        try:
            return float(point[1]), float(point[0])      # lat, lng
        except (TypeError, ValueError):
            return None
    return None


def tally(features, *names):
    counts = {}
    for feature in features:
        props = feature.get("properties") or {}
        value = next((props[n] for n in names if props.get(n) not in (None, "")), "—")
        counts[str(value)] = counts.get(str(value), 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: -kv[1]))


def report(name, url):
    print(f"\n{'=' * 72}\n{name}\n{url}\n{'=' * 72}")
    status, headers, body = fetch(url)
    print(f"  status            : {status}")
    print(f"  content-type      : {headers.get('Content-Type', '—')}")
    print(f"  CORS for us       : {cors_verdict(headers)}")
    print(f"  cache-control     : {headers.get('Cache-Control', '—')}")
    if status != 200:
        print(f"  body              : {body[:300]}")
        return []

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as err:
        print(f"  NOT JSON          : {err}; starts {body[:120]!r}")
        return []

    print(f"  top level         : {shape(payload)}")
    features = features_of(payload)
    print(f"  events            : {len(features)}")
    if not features:
        return []

    sample = features[0]
    print(f"  a feature         : {shape(sample)}")
    props = sample.get("properties") or {}
    print(f"  its properties    : {sorted(props)}")
    print("  sample values     :")
    for key in sorted(props)[:22]:
        print(f"      {key:<26} = {str(props[key])[:66]!r}")
    geometry = sample.get("geometry") or {}
    print(f"  geometry types    : {tally(features, 'x') and ''}"
          f"{sorted({(f.get('geometry') or {}).get('type', '—') for f in features})}")
    print(f"  first geometry    : {str(geometry)[:140]}")
    return features


def density(name, features):
    """How many of these would land in one city's view at a time."""
    located = [c for c in (coords_of(f) for f in features) if c]
    print(f"\n  -- {name}: {len(located)} of {len(features)} events have usable coordinates")
    busiest = 0
    for city, lat, lng in CITIES:
        near = sum(1 for (y, x) in located
                   if abs(y - lat) <= CITY_BOX and abs(x - lng) <= CITY_BOX)
        busiest = max(busiest, near)
        if near:
            print(f"     {city:<14} {near} in view")
    print(f"     busiest city view: {busiest} event(s)")
    return busiest


def probe_meteoalarm():
    """Which MeteoAlarm endpoint answers, and in what format."""
    print(f"\n{'=' * 72}\nMETEOALARM — which endpoint is live\n{'=' * 72}")
    for name, url in METEOALARM.items():
        status, headers, body = fetch(url)
        kind = headers.get("Content-Type", "—").split(";")[0]
        print(f"\n  {name}\n    {url}")
        print(f"    status {status}  type {kind}  CORS {cors_verdict(headers)}")
        if status == 200:
            head = body.strip()[:220].replace("\n", " ")
            print(f"    starts: {head!r}")
            # CAP/Atom rather than JSON, so count entries rather than features.
            for marker in ("<entry", "<alert", "\"features\"", "\"warnings\""):
                if marker in body:
                    print(f"    contains {marker!r} x{body.count(marker)}")


def main():
    print("Probing the hazard sources. Nothing is written.")
    everything = {}
    for name, url in SOURCES.items():
        everything[name] = report(name, url)
    probe_meteoalarm()

    print(f"\n{'=' * 72}\nHOW CROWDED WOULD THE MAP GET\n{'=' * 72}")
    print(f"  A city view here is +/-{CITY_BOX} degrees, about a city and its suburbs.")
    worst = 0
    for name, features in everything.items():
        if features:
            worst = max(worst, density(name, features))

    print(f"\n  Across every city checked, the busiest single view holds {worst} hazard(s).")
    print("  On by default is reasonable while that stays near zero; past a"
          "\n  handful it would bury the scam pins the map exists for.")


if __name__ == "__main__":
    main()
