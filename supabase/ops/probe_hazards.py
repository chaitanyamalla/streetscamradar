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


# The countries MeteoAlarm covers, as its feed slugs spell them. Taken from its
# own country list rather than guessed; the probe says which of them answer.
METEO_COUNTRIES = [
    "austria", "belgium", "bosnia-herzegovina", "bulgaria", "croatia", "cyprus",
    "czechia", "denmark", "estonia", "finland", "france", "germany", "greece",
    "hungary", "iceland", "ireland", "israel", "italy", "latvia", "lithuania",
    "luxembourg", "malta", "moldova", "montenegro", "netherlands", "north-macedonia",
    "norway", "poland", "portugal", "romania", "serbia", "slovakia", "slovenia",
    "spain", "sweden", "switzerland", "ukraine", "united-kingdom",
]
METEO_FEED = "https://feeds.meteoalarm.org/api/v1/warnings/feeds-{}"


def cap_parameters(info):
    """MeteoAlarm hides the awareness type and level in CAP `parameter` pairs."""
    out = {}
    for entry in info.get("parameter") or []:
        if isinstance(entry, dict) and entry.get("valueName"):
            out[str(entry["valueName"])] = str(entry.get("value"))
    return out


def probe_meteoalarm_detail():
    """What one country's warnings actually look like, and how many there are.

    A parser needs four things from this: where the country lives in the
    response, where the severity lives, where the times live, and whether an
    alert names an area a traveller would recognise. Everything printed here is
    one of those.
    """
    print(f"\n{'=' * 72}\nMETEOALARM — what one country sends\n{'=' * 72}")

    shown = 0
    totals, levels, events, failures = {}, {}, {}, []
    for slug in METEO_COUNTRIES:
        status, headers, body = fetch(METEO_FEED.format(slug))
        if status != 200:
            failures.append(f"{slug} ({status})")
            continue
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as err:
            failures.append(f"{slug} (not JSON: {err})")
            continue

        warnings = payload.get("warnings") if isinstance(payload, dict) else None
        if not isinstance(warnings, list):
            failures.append(f"{slug} (no 'warnings' array: {shape(payload)})")
            continue
        totals[slug] = len(warnings)

        for warning in warnings:
            alert = (warning or {}).get("alert") or {}
            for info in alert.get("info") or []:
                params = cap_parameters(info)
                level = params.get("awareness_level", "—")
                kind = params.get("awareness_type", info.get("event", "—"))
                levels[level] = levels.get(level, 0) + 1
                events[kind] = events.get(kind, 0) + 1

        # The full shape, for the first two countries that have anything.
        if warnings and shown < 2:
            shown += 1
            alert = (warnings[0] or {}).get("alert") or {}
            info_list = alert.get("info") or []
            info = info_list[0] if info_list else {}
            print(f"\n  {slug}: {len(warnings)} warnings")
            print(f"    a warning        : {shape(warnings[0])}")
            print(f"    alert keys       : {sorted(alert)}")
            for key in ("identifier", "sender", "sent", "status", "msgType", "scope"):
                if key in alert:
                    print(f"      {key:<14} = {str(alert[key])[:70]!r}")
            print(f"    info entries     : {len(info_list)}"
                  f"  languages {[i.get('language') for i in info_list][:8]}")
            print(f"    info keys        : {sorted(info)}")
            for key in ("language", "category", "event", "responseType", "urgency",
                        "severity", "certainty", "effective", "onset", "expires",
                        "senderName", "headline", "web", "contact"):
                if key in info:
                    print(f"      {key:<14} = {str(info[key])[:78]!r}")
            print(f"    parameters       : {cap_parameters(info)}")
            areas = info.get("area") or []
            print(f"    areas            : {len(areas)}")
            for area in areas[:3]:
                keys = sorted(area) if isinstance(area, dict) else "—"
                desc = (area or {}).get("areaDesc") if isinstance(area, dict) else area
                print(f"      keys {keys} areaDesc {str(desc)[:60]!r}")

    print("\n  -- how much there is, right now --")
    busy = {k: v for k, v in sorted(totals.items(), key=lambda kv: -kv[1]) if v}
    print(f"    countries answering : {len(totals)} of {len(METEO_COUNTRIES)}")
    print(f"    countries with any  : {len(busy)}")
    print(f"    warnings in total   : {sum(totals.values())}")
    print(f"    busiest             : {list(busy.items())[:8]}")
    print(f"    awareness_level     : {levels}")
    print(f"    awareness_type      : {dict(list(events.items())[:14])}")
    if failures:
        print(f"    did not answer      : {failures}")


def probe_meteoalarm_geometry():
    """Can a MeteoAlarm warning be put on the map at all?

    The question came from a reader: Spain has 44 live warnings and not one
    marker, while the United States has 91. NOAA sends a polygon with most of
    its serious alerts; the fetcher only ever reads `areaDesc` out of
    MeteoAlarm, and nobody has checked whether there is more in there.

    CAP allows three ways to say where an area is — <polygon>, <circle> and
    <geocode> — so this counts all three across every country, and prints the
    geocode naming schemes it finds. A scheme like EMMA_ID is a published region
    code we could resolve to a point once, offline; a polygon we could use
    directly. If all three come back empty everywhere, then Europe genuinely
    cannot be drawn from this feed and the chip is the honest answer.
    """
    print(f"\n{'=' * 72}\nMETEOALARM — is there anything to put on a map\n{'=' * 72}")

    polygons = circles = areas_total = with_any = 0
    schemes, samples, per_country = {}, [], {}
    for slug in METEO_COUNTRIES:
        status, _headers, body = fetch(METEO_FEED.format(slug))
        if status != 200:
            continue
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            continue
        warnings = payload.get("warnings") if isinstance(payload, dict) else None
        if not isinstance(warnings, list):
            continue

        placed = 0
        for warning in warnings:
            alert = (warning or {}).get("alert") or {}
            for info in alert.get("info") or []:
                for area in info.get("area") or []:
                    if not isinstance(area, dict):
                        continue
                    areas_total += 1
                    has = False
                    if area.get("polygon"):
                        polygons += 1
                        has = True
                        if len(samples) < 2:
                            samples.append((slug, "polygon",
                                            str(area["polygon"])[:160]))
                    if area.get("circle"):
                        circles += 1
                        has = True
                        if len(samples) < 4:
                            samples.append((slug, "circle", str(area["circle"])[:160]))
                    for code in area.get("geocode") or []:
                        if not isinstance(code, dict):
                            continue
                        name = str(code.get("valueName") or "?")
                        schemes[name] = schemes.get(name, 0) + 1
                        has = True
                        if len(samples) < 8:
                            samples.append((slug, f"geocode {name}",
                                            str(code.get("value"))[:80]))
                    if has:
                        with_any += 1
                        placed += 1
        if placed:
            per_country[slug] = placed

    for slug, what, value in samples:
        print(f"  {slug:<18} {what:<18} {value}")

    print("\n  SUMMARY")
    print(f"    area blocks seen        : {areas_total}")
    print(f"    with <polygon>          : {polygons}")
    print(f"    with <circle>           : {circles}")
    print(f"    with any geometry/code  : {with_any}")
    print(f"    geocode schemes         : {schemes}")
    print(f"    countries with any      : {dict(list(per_country.items())[:12])}")
    if not polygons and not circles and not schemes:
        print("    -> nothing to place a marker with. The chip is the honest answer.")
    elif schemes and not polygons:
        print("    -> no shapes, but there ARE region codes: resolvable to points")
        print("       ONCE, offline, into a lookup table the fetcher reads.")


def main():
    print("Probing the hazard sources. Nothing is written.")
    everything = {}
    for name, url in SOURCES.items():
        everything[name] = report(name, url)
    probe_meteoalarm()
    probe_meteoalarm_detail()
    probe_meteoalarm_geometry()

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
