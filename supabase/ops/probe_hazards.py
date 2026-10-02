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
import urllib.parse
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
    """Can a MeteoAlarm warning be put on the map, and for which countries?

    The question came from a reader: Spain has 44 live orange-and-red warnings
    and not one marker, while the United States has 91. The fetcher only ever
    read `areaDesc`, and the first pass of this probe showed that was a mistake
    — 4,790 of 32,313 area blocks DO carry a <polygon>, and every single block
    carries at least one geocode (EMMA_ID mostly, with NUTS2 and NUTS3).

    So the question is no longer "is there anything" but "what, where, and in
    what format". This prints, per country: how many area blocks it sends, how
    many have a polygon, and which geocode schemes it uses — plus a real polygon
    string, because CAP writes them "lat,lon lat,lon ..." which is the opposite
    order from GeoJSON and getting it backwards puts Madrid in the Indian Ocean.
    """
    print(f"\n{'=' * 72}\nMETEOALARM — what can be put on a map, by country\n{'=' * 72}")

    rows, polygon_samples, schemes_seen = [], [], {}
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

        blocks = polys = 0
        schemes = {}
        serious = 0
        for warning in warnings:
            alert = (warning or {}).get("alert") or {}
            for info in alert.get("info") or []:
                params = cap_parameters(info)
                level = params.get("awareness_level", "").lower()
                # Only the two grades we actually store. A country whose
                # polygons are all on green warnings would be no use to us.
                if "orange" in level or "red" in level:
                    serious += 1
                for area in info.get("area") or []:
                    if not isinstance(area, dict):
                        continue
                    blocks += 1
                    if area.get("polygon"):
                        polys += 1
                        if len(polygon_samples) < 3:
                            polygon_samples.append(
                                (slug, str(area.get("areaDesc"))[:30],
                                 str(area["polygon"])[:150]))
                    for code in area.get("geocode") or []:
                        if isinstance(code, dict):
                            name = str(code.get("valueName") or "?")
                            schemes[name] = schemes.get(name, 0) + 1
                            schemes_seen.setdefault(name, str(code.get("value"))[:24])
        rows.append((slug, blocks, polys, serious, schemes))

    print("  A REAL POLYGON, so the format is not guessed at:")
    for slug, where, poly in polygon_samples:
        print(f"    {slug} / {where}")
        print(f"      {poly}")
    if not polygon_samples:
        print("    none sent one")

    print("\n  WHAT EACH GEOCODE SCHEME LOOKS LIKE:")
    for name, example in sorted(schemes_seen.items()):
        print(f"    {name:<12} e.g. {example}")

    print(f"\n  {'country':<20}{'areas':>7}{'polygons':>10}{'orange+red':>12}  schemes")
    for slug, blocks, polys, serious, schemes in sorted(rows, key=lambda r: -r[2]):
        names = ",".join(sorted(schemes)) or "—"
        print(f"  {slug:<20}{blocks:>7}{polys:>10}{serious:>12}  {names}")

    # The line that decides what to build. Counted over the countries that have
    # warnings we would actually store.
    drawable = sum(1 for _s, _b, p, serious, _c in rows if p and serious)
    busy = [s for s, _b, p, serious, _c in rows if serious and not p]
    print(f"\n  SUMMARY")
    print(f"    countries sending polygons AND serious warnings : {drawable}")
    print(f"    countries with serious warnings but NO polygon  : {len(busy)}")
    print(f"      {busy[:20]}")


# Where a region NAME gets turned into a point. Thirty of MeteoAlarm's
# thirty-eight services send no shape — only a region code we have no geometry
# for — but every one of them names the area in words, and a name can be looked
# up. Both of these are already used by the page, so neither is a new dependency.
PHOTON = "https://photon.komoot.io/api/"
NOMINATIM = "https://nominatim.openstreetmap.org/search"


def probe_area_names():
    """Can a met service's own area names be turned into points?

    This is the question the whole European marker plan rests on, and it is not
    obvious: "Bayern" is a state and will resolve cleanly, but AEMET writes
    "Litoral de Barcelona" and "Ibérica aragonesa", which are weather zones
    rather than places. A name that resolves to the wrong valley is worse than
    no marker at all, so the thing to find out is WHICH kind of answer comes
    back — a city, a region, or nothing — and whether the geocoder admits it.

    Real names, pulled from the live feeds rather than invented, for the
    countries that send no shape and have warnings worth drawing.
    """
    print(f"\n{'=' * 72}\nCAN AREA NAMES BE PLACED — the European marker plan\n{'=' * 72}")

    # Collect real area names per country, from services that send no polygon.
    wanted = ["spain", "germany", "france", "greece", "portugal", "netherlands"]
    codes = {"spain": "ES", "germany": "DE", "france": "FR",
             "greece": "GR", "portugal": "PT", "netherlands": "NL"}
    names = {}
    for slug in wanted:
        status, _h, body = fetch(METEO_FEED.format(slug))
        if status != 200:
            continue
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            continue
        found = []
        for warning in (payload.get("warnings") or [])[:400]:
            alert = (warning or {}).get("alert") or {}
            for info in alert.get("info") or []:
                for area in info.get("area") or []:
                    if isinstance(area, dict) and not area.get("polygon"):
                        name = str(area.get("areaDesc") or "").strip()
                        if name and name not in found:
                            found.append(name)
        names[slug] = found
        print(f"  {slug:<14} {len(found)} distinct area names, e.g. {found[:4]}")

    print("\n  WHAT THE GEOCODER MAKES OF THEM")
    print(f"  {'name':<34}{'country':<9}{'photon says':<34}{'type':<12}position")
    placed = unplaced = 0
    for slug, found in names.items():
        for name in found[:5]:
            params = urllib.parse.urlencode({
                "q": name, "limit": "1", "lang": "en", "layer": "district",
            })
            # The country filter is the important part: "Bayern" without it can
            # match a street in Brazil.
            params += f"&osm_tag=:!boundary"
            status, _h, body = fetch(f"{PHOTON}?{params}")
            label = kindOf = "—"
            position = "none"
            try:
                data = json.loads(body or "{}")
                feats = data.get("features") or []
                if feats:
                    props = feats[0].get("properties") or {}
                    label = str(props.get("name") or "?")[:30]
                    kindOf = str(props.get("type") or props.get("osm_value") or "?")[:10]
                    coords = (feats[0].get("geometry") or {}).get("coordinates") or []
                    if len(coords) >= 2:
                        position = f"{round(coords[1], 2)},{round(coords[0], 2)}"
                        placed += 1
                    sameCountry = str(props.get("countrycode") or "") == codes[slug]
                    if not sameCountry:
                        kindOf += f" !{props.get('countrycode')}"
                else:
                    unplaced += 1
            except (json.JSONDecodeError, TypeError, IndexError):
                unplaced += 1
            print(f"  {name[:33]:<34}{codes[slug]:<9}{label:<34}{kindOf:<12}{position}")

    print(f"\n  SUMMARY")
    print(f"    placed   : {placed}")
    print(f"    unplaced : {unplaced}")
    print("    Read the 'type' and the country flag: a '!XX' means the geocoder")
    print("    answered with somewhere in the WRONG COUNTRY, which is the failure")
    print("    mode that matters and the reason to filter by country code.")


# Where a reader is sent to read the warning itself. Each national service fills
# CAP's <web> with whatever it likes, and MeteoAlarm has pages of its own; which
# of the two is more use to a traveller is the question, and it is answerable.
METEOALARM_PAGES = (
    "https://meteoalarm.org/en/live/region/{}",
    "https://www.meteoalarm.org/en/live/region/{}",
    "https://meteoalarm.org/en/live/{}",
    "https://meteoalarm.org/en/live/",
)


def probe_official_links(sample=("spain", "greece", "portugal", "germany",
                                 "france", "italy", "netherlands", "ireland")):
    """What "Official details" actually opens, and whether there is a better one.

    The popup links to CAP's <web>, which is the issuing service's own choice. A
    reader clicking it on a Greek rain warning lands whereever the Hellenic
    service points, which may be the warning, may be a homepage, and will be in
    Greek. MeteoAlarm shows the same warning on a European map in English.

    So: collect the distinct <web> per country and look at them, then see
    whether MeteoAlarm has a per-country page that answers at all. Neither half
    is a guess once this has run.
    """
    print(f"\n{'=' * 72}\nWHERE 'OFFICIAL DETAILS' SENDS A READER\n{'=' * 72}")

    print("  WHAT EACH SERVICE PUTS IN CAP's <web>")
    for slug in sample:
        status, _h, body = fetch(METEO_FEED.format(slug))
        if status != 200:
            print(f"  {slug:<14} feed said {status}")
            continue
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            continue
        links, deep = {}, 0
        for warning in (payload.get("warnings") or []):
            alert = (warning or {}).get("alert") or {}
            for info in alert.get("info") or []:
                web = str(info.get("web") or "").strip()
                if not web:
                    continue
                links[web] = links.get(web, 0) + 1
                # A link with a path beyond "/" is at least pointing somewhere
                # inside the site; a bare domain is a front page.
                rest = urllib.parse.urlparse(web).path.strip("/")
                if rest:
                    deep += 1
        shown = sorted(links.items(), key=lambda kv: -kv[1])[:3]
        print(f"  {slug:<14} {len(links)} distinct link(s), {deep} with a path")
        for link, n in shown:
            print(f"                 x{n:<4} {link[:88]}")

    print("\n  DOES METEOALARM HAVE A PAGE PER COUNTRY")
    for pattern in METEOALARM_PAGES:
        url = pattern.format("spain") if "{}" in pattern else pattern
        status, headers, body = fetch(url)
        kind = headers.get("content-type", "—") if headers else "—"
        hint = ""
        if status == 200 and body:
            lowered = body.lower()
            for marker in ("spain", "espa", "awareness", "warning"):
                if marker in lowered:
                    hint += f" has {marker!r}"
        print(f"    {status}  {len(body or ''):>7} bytes  {kind[:24]:<24} {url}{hint}")


def main():
    print("Probing the hazard sources. Nothing is written.")
    everything = {}
    for name, url in SOURCES.items():
        everything[name] = report(name, url)
    probe_meteoalarm()
    probe_meteoalarm_detail()
    probe_meteoalarm_geometry()
    probe_area_names()
    probe_official_links()

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
