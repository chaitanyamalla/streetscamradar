#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Refresh the United States' rows in public.weather_warnings, from NOAA/NWS.
#
#   https://api.weather.gov/alerts/active
#
# MeteoAlarm covers Europe and stops there. The National Weather Service is the
# equivalent for the United States: one national feed, CAP like MeteoAlarm's,
# and every alert issued by an NWS office rather than by us. The rows land in
# the SAME table, so the page needs no new concept — a warning is a warning.
#
# What a probe of the live feed found, and what follows from it
# ------------------------------------------------------------
# 361 active alerts, 25 distinct event types. Three things decided the rules:
#
#   MARINE IS MOST OF IT. 123 Small Craft Advisories and 69 Gale Warnings —
#   192 of the 361 — are about boats offshore. This is a map for somebody
#   walking around a city, so the marine-only types are dropped by name.
#
#   ONLY A THIRD CARRY GEOMETRY. 103 of 361 have a polygon; the rest reference
#   NWS forecast zones by URL and would need a second request each to place.
#   Where there is a polygon we store its centroid and the map draws a marker.
#   Where there is not, the row is still stored and still reaches the chip —
#   no position is a reason not to draw it, not a reason to lose it.
#
#   A THIRD START IN THE FUTURE. 130 of 361 had an onset more than an hour
#   ahead, the furthest 46 hours out. They are kept, with from_date in the
#   future, and the page says so rather than implying something is happening
#   now. Two days is the real lead time a met service gives; nobody issues a
#   formal warning a week ahead, so "the coming week" is not on offer here.
#
# What is kept
# ------------
# CAP grades severity Extreme / Severe / Moderate / Minor / Unknown. Extreme
# and Severe only, mapped to our red and orange, which is the same line we draw
# through MeteoAlarm's four colours. Moderate is the yellow-equivalent: most of
# what a met service issues, and flagging it permanently teaches a reader to
# ignore the rest.
#
# NWS also emits a periodic "Test Message" to prove the feed is alive. It is
# dropped by name, because a test alert on a traveller's map is a lie.
#
# No warning text, exactly as with MeteoAlarm: the type, the level, the area,
# the times, who issued it and where to read it. The words stay with NWS.
#
# Usage:
#   python3 fetch_nws.py > nws.sql
#   python3 fetch_nws.py --file sample.json > nws.sql
# ---------------------------------------------------------------------------
import json
import sys
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone

FEED = "https://api.weather.gov/alerts/active"
UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"
TIMEOUT = 45

# A quiet day still has alerts somewhere in a country that size. Nothing at all
# is a broken response, not a calm continent, and must not empty our rows.
MIN_PLAUSIBLE_ALERTS = 5

# CAP severity -> ours. Extreme is red, Severe is orange, and the rest is the
# routine background we do not carry.
SEVERITY = {"Extreme": "severe", "Severe": "notice"}

# Offshore only. A gale warning matters enormously to a boat and not at all to
# somebody deciding whether to walk to the station.
#
# Two lists, because the obvious one list is wrong: "Storm Warning" is a marine
# event, and matching it as a substring also throws away "Winter Storm Warning",
# "Ice Storm Warning", "Severe Thunderstorm Warning" and "Tropical Storm
# Warning" — four of the most serious things on the feed. So the names that are
# a longer warning's ending are matched WHOLE, and only the unmistakable ones
# are matched as words.
MARINE_EXACT = (
    "storm warning", "storm watch", "gale warning", "gale watch",
    "squall warning",
)
MARINE_WORDS = (
    "small craft", "hurricane force wind", "hazardous seas", "marine",
    "brisk wind", "ashfall", "low water", "high seas",
)

# NWS covers the US territories too, and they are their OWN countries on the
# map — a warning for San Juan filed under "US" would never be shown to
# somebody looking at Puerto Rico. Every alert names its forecast zones in
# geocode.UGC, and a UGC code begins with the two-letter state or territory it
# belongs to, so the prefix is the answer. Anything else is a state, which is
# the United States.
TERRITORIES = {
    "PR": "PR",   # Puerto Rico
    "VI": "VI",   # US Virgin Islands
    "GU": "GU",   # Guam
    "MP": "MP",   # Northern Mariana Islands
    "AS": "AS",   # American Samoa
}

# Every country this generator owns rows for, so the stale-row delete clears
# exactly what it wrote and nothing MeteoAlarm wrote.
OURS = ("US", *sorted(TERRITORIES.values()))

# The fifty states, DC, and the marine/offshore prefixes, so that anything
# ELSE showing up as a zone prefix gets named in the log rather than filed
# under "US" in silence.
#
# This exists because the first live run put one Guam-office alert under US: the
# Tiyan office also forecasts for Palau, Micronesia and the Marshall Islands,
# which are not the United States and have UGC prefixes we have not seen. Rather
# than guess at them, the run says what it saw, and the next person has a fact
# instead of a hunch.
US_STATES = frozenset("""
AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO
MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY
DC
""".split()) | frozenset({
    # Marine and offshore zone prefixes. They reach here only on an alert we
    # kept for other reasons, and they are not a country getting lost.
    "AM", "AN", "GM", "LC", "LE", "LH", "LM", "LO", "LS", "PH", "PK", "PM",
    "PZ", "SL", "ANZ", "PZZ",
})

# NWS publishes around eighty event names and adds to them. Matching on words
# rather than on a fixed list means a new name lands in the right place instead
# of being dropped silently — the order matters, first match wins.
KIND_WORDS = (
    ("avalanche",       "avalanche"),
    ("red flag",        "forest-fire"),
    ("fire weather",    "forest-fire"),
    ("fire warning",    "forest-fire"),
    ("coastal flood",   "coastal-event"),
    ("lakeshore flood", "coastal-event"),
    ("storm surge",     "coastal-event"),
    ("rip current",     "coastal-event"),
    ("high surf",       "coastal-event"),
    ("tsunami",         "coastal-event"),
    ("flash flood",     "flood"),
    ("flood",           "flood"),
    ("tornado",         "thunderstorm"),
    ("thunderstorm",    "thunderstorm"),
    ("blizzard",        "snow-ice"),
    ("winter",          "snow-ice"),
    ("snow",            "snow-ice"),
    ("ice storm",       "snow-ice"),
    ("freezing rain",   "snow-ice"),
    ("sleet",           "snow-ice"),
    ("fog",             "fog"),
    ("heat",            "high-temperature"),
    ("frost",           "low-temperature"),
    ("freeze",          "low-temperature"),
    ("cold",            "low-temperature"),
    ("wind chill",      "low-temperature"),
    ("hurricane",       "wind"),
    ("tropical storm",  "wind"),
    ("typhoon",         "wind"),
    ("wind",            "wind"),
    ("dust",            "wind"),
    ("rain",            "rain"),
)


# Zone prefixes we could not place, counted so the run can say so. Not an
# error: the row is still stored, under "US".
UNKNOWN_PREFIXES = Counter()


class SourceProblem(RuntimeError):
    """The feed answered in a way we will not write to the table."""


def fetch(url=FEED):
    request = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "application/geo+json"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8"))


def kind_of(event):
    """Which of our twelve kinds an NWS event name is, or None."""
    name = str(event or "").lower().strip()
    if not name or name in MARINE_EXACT:
        return None
    if any(word in name for word in MARINE_WORDS):
        return None
    if "test" in name:                 # the keep-alive, and anything like it
        return None
    for word, kind in KIND_WORDS:
        if word in name:
            return kind
    return None


def country_of(props):
    """Which country an alert belongs to, from its forecast zone codes.

    Defensive on purpose: a missing or unfamiliar geocode block means the
    United States, which is right for every state and wrong only in the case
    where NWS stops publishing UGC codes at all. Losing a territory to "US" is
    a marker in the wrong country list; guessing the other way would put a
    Texas warning in Guam.
    """
    codes = ((props or {}).get("geocode") or {}).get("UGC") or []
    for code in codes:
        prefix = str(code)[:2].upper()
        if prefix in TERRITORIES:
            return TERRITORIES[prefix]
    for code in codes:
        prefix = str(code)[:2].upper()
        if prefix and prefix not in US_STATES:
            UNKNOWN_PREFIXES[prefix] += 1
    return "US"


def as_timestamp(value):
    if not value:
        return None
    try:
        when = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when.astimezone(timezone.utc).isoformat()


def centre_of(geometry):
    """The middle of an alert's polygon, where it has one.

    The mean of the ring's vertices rather than a true centroid: these are
    small, roughly convex county and zone shapes, the difference is a few
    kilometres, and a marker is a "something here" rather than a survey mark.
    Two thirds of alerts have no geometry at all and come back (None, None).
    """
    if not isinstance(geometry, dict):
        return None, None
    rings = []
    if geometry.get("type") == "Polygon":
        rings = geometry.get("coordinates") or []
    elif geometry.get("type") == "MultiPolygon":
        for polygon in geometry.get("coordinates") or []:
            rings.extend(polygon or [])
    points = [p for ring in rings[:1] for p in (ring or [])
              if isinstance(p, (list, tuple)) and len(p) >= 2]
    if not points:
        return None, None
    try:
        lng = sum(float(p[0]) for p in points) / len(points)
        lat = sum(float(p[1]) for p in points) / len(points)
    except (TypeError, ValueError):
        return None, None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None, None
    return round(lat, 4), round(lng, 4)


def rows_from(payload):
    """Every alert worth storing, as a row for weather_warnings."""
    if not isinstance(payload, dict):
        raise SourceProblem("payload is not a JSON object")
    features = payload.get("features")
    if not isinstance(features, list):
        raise SourceProblem("no 'features' array")
    if len(features) < MIN_PLAUSIBLE_ALERTS:
        raise SourceProblem(
            f"only {len(features)} alerts came back, expected at least "
            f"{MIN_PLAUSIBLE_ALERTS} — refusing to overwrite our rows")

    rows, seen = [], set()
    dropped = Counter()
    for feature in features:
        props = (feature or {}).get("properties")
        if not isinstance(props, dict):
            continue

        severity = SEVERITY.get(str(props.get("severity") or "").strip())
        if not severity:
            dropped[f"severity {props.get('severity')}"] += 1
            continue
        kind = kind_of(props.get("event"))
        if not kind:
            dropped[f"event {props.get('event')}"] += 1
            continue

        warning_id = str(props.get("id") or "").strip()
        if not warning_id or warning_id in seen:
            continue
        areas = str(props.get("areaDesc") or "").strip()
        if not areas:
            dropped["no area"] += 1
            continue

        to_date = as_timestamp(props.get("ends") or props.get("expires"))
        lat, lng = centre_of(feature.get("geometry"))
        seen.add(warning_id)
        rows.append({
            "warning_id": warning_id,
            "country_code": country_of(props),
            "kind": kind,
            "severity": severity,
            "areas": areas[:400],
            "from_date": as_timestamp(props.get("onset") or props.get("effective")),
            "to_date": to_date,
            "source": str(props.get("senderName") or "US National Weather Service")[:120],
            "url": str(props.get("web") or "https://www.weather.gov/")[:300],
            "lat": lat,
            "lng": lng,
        })

    print(f"-- NWS: {len(features)} alerts, {len(rows)} stored", file=sys.stderr)
    print(f"-- with a position: {sum(1 for r in rows if r['lat'] is not None)}",
          file=sys.stderr)
    for why, n in dropped.most_common(12):
        print(f"--   dropped {n:>4}  {why}", file=sys.stderr)
    by_country = Counter(r["country_code"] for r in rows)
    print("-- by country: " + ", ".join(f"{c} {n}" for c, n in by_country.most_common()),
          file=sys.stderr)
    if UNKNOWN_PREFIXES:
        # Filed under US because we had nothing better, and said out loud so it
        # can be fixed with a fact rather than a guess.
        print("-- zone prefixes we could not place (stored as US): "
              + ", ".join(f"{p} {n}" for p, n in UNKNOWN_PREFIXES.most_common(10)),
              file=sys.stderr)
    # No rows is a legitimate answer here, where no FEATURES is not: a healthy
    # feed full of small craft advisories and frost advisories means nothing
    # dangerous is in force on land, and the right thing to write is the delete
    # on its own. Refusing would leave yesterday's warnings standing.
    return rows


def sql_str(value):
    if value is None:
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def sql_num(value):
    return "null" if value is None else str(value)


def emit_sql(rows):
    """The SQL for one refresh. With no rows it is the delete alone, which is
    the correct way to say "nothing is in force here any more"."""
    print("begin;")
    columns = ("warning_id", "country_code", "kind", "severity", "areas",
               "from_date", "to_date", "source", "url", "lat", "lng")
    for start in range(0, len(rows), 200):
        batch = rows[start:start + 200]
        print(f"insert into public.weather_warnings ({', '.join(columns)}) values")
        values = []
        for r in batch:
            values.append("  ({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {})".format(
                sql_str(r["warning_id"]), sql_str(r["country_code"]), sql_str(r["kind"]),
                sql_str(r["severity"]), sql_str(r["areas"]), sql_str(r["from_date"]),
                sql_str(r["to_date"]), sql_str(r["source"]), sql_str(r["url"]),
                sql_num(r["lat"]), sql_num(r["lng"])))
        print(",\n".join(values))
        print("on conflict (warning_id, country_code) do update set "
              "kind = excluded.kind, severity = excluded.severity, "
              "areas = excluded.areas, from_date = excluded.from_date, "
              "to_date = excluded.to_date, source = excluded.source, "
              "url = excluded.url, lat = excluded.lat, lng = excluded.lng, "
              "refreshed_at = now();")

    # Only this generator's countries, and only the rows it did not just
    # refresh. MeteoAlarm's countries are written by the other generator and
    # must not be touched by this one.
    #
    # Weather is deliberately NOT kept for a week the way reports and disasters
    # are: a warning that is no longer in the feed is no longer in force, and
    # yesterday's wind warning is noise on a map somebody is using to decide
    # whether to go out now.
    print("delete from public.weather_warnings where country_code in ({}) "
          "and refreshed_at < now();".format(", ".join(sql_str(c) for c in OURS)))
    print("commit;")


def main():
    args = sys.argv[1:]
    if "--file" in args:
        with open(args[args.index("--file") + 1], encoding="utf-8") as handle:
            payload = json.load(handle)
    else:
        payload = fetch()
    emit_sql(rows_from(payload))


if __name__ == "__main__":
    main()
