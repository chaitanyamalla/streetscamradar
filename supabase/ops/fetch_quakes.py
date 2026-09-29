#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Refresh public.quake_events from USGS.
#
#   https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson
#   https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson
#
# The page used to read these two feeds itself. USGS serves them with
# permissive CORS and a 60-second cache and is happy to be read from a browser,
# so that worked — but it left earthquakes as the one hazard with a different
# shape from every other, and the only one where a reader's browser talked to
# an outside service. They are mirrored now like the rest.
#
# What is kept
# ------------
# Two feeds, each with its own window. A significant quake is worth knowing
# about for a month — the damage and the aftershocks outlast the shaking. An
# ordinary M4.5 is worth a week. Mixing the windows would either drop the big
# ones early or keep the small ones for a month.
#
# Below M4.5 nothing is kept at all. That is the background hum of a working
# planet, hundreds a day, and a map showing all of it teaches people to ignore
# the map.
#
# What leaves, and when
# ---------------------
# Anything the feeds no longer carry, or that has aged past its window. Both
# feeds are rolling, so this is the same rule as "when the original site
# removes it, we remove it".
#
# Refusing to write rubbish
# -------------------------
# Taken literally, an empty answer would mean the Earth had gone quiet — which
# it has not done in recorded history. A week holds well over a hundred M4.5s.
# Too few, or a feed that will not parse, and nothing is written: the previous
# rows stay up, which is the right answer to a bad day at USGS.
#
# One feed failing is NOT that: the significant quakes are worth showing
# without this week's ordinary ones, and the other way round. Only losing
# everything stops the run.
#
# Usage:
#   python3 fetch_quakes.py > quakes.sql
#   python3 fetch_quakes.py --file sample.json > quakes.sql
# ---------------------------------------------------------------------------
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

FEEDS = [
    ("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson", 30),
    ("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson", 7),
]
TIMEOUT = 30
RETRIES = 3
INSERT_BATCH = 200

# Nothing below this is stored, whichever feed it arrived in. significant_month
# includes smaller quakes that did real damage; they are still not something a
# traveller planning a trip can act on, and they are what makes a map noisy.
MIN_MAGNITUDE = 4.5

# A quiet week still holds a hundred M4.5s. Fewer than this from both feeds
# together is a broken answer, not a quiet planet.
MIN_PLAUSIBLE_EVENTS = 10


class SourceProblem(Exception):
    """The source answered, but not with something worth writing down."""


def http_get(url, timeout=TIMEOUT):
    request = urllib.request.Request(url, headers={
        "User-Agent": "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8")


def fetch(url, retries=RETRIES):
    for attempt in range(1, retries + 1):
        try:
            return json.loads(http_get(url))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as err:
            print(f"--   {url.rsplit('/', 1)[-1]} attempt {attempt}/{retries}: {err}",
                  file=sys.stderr)
            if attempt < retries:
                time.sleep(2 ** attempt)
    return None


def as_timestamp(millis):
    """USGS `time` is epoch milliseconds; GDACS sends ISO strings. Two units in
    one table is exactly what put every travel advisory in January 1970, so
    each source's unit is converted at its own edge and never guessed at."""
    try:
        value = float(millis)
    except (TypeError, ValueError):
        return None
    if not (0 < value < 4e12):          # anything outside 1970..2096 is not a time
        return None
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()


def rows_from(feeds, now=None):
    """Every quake worth storing, newest first, deduped across the feeds.

    `feeds` is [(payload, days), ...] — each feed carries its own window.
    """
    now = now or datetime.now(timezone.utc)
    by_id = {}
    counted = 0

    for payload, days in feeds:
        if not isinstance(payload, dict):
            continue
        features = payload.get("features")
        if not isinstance(features, list):
            continue
        counted += len(features)
        oldest = now - timedelta(days=days)

        for feature in features:
            props = (feature or {}).get("properties")
            point = ((feature or {}).get("geometry") or {}).get("coordinates")
            event_id = (feature or {}).get("id")
            if not isinstance(props, dict) or not isinstance(point, list) or len(point) < 2:
                continue
            if not isinstance(event_id, str) or not event_id.strip():
                continue

            try:
                lng, lat, magnitude = float(point[0]), float(point[1]), float(props.get("mag"))
            except (TypeError, ValueError):
                continue
            if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
                continue
            if magnitude < MIN_MAGNITUDE:
                continue

            at = as_timestamp(props.get("time"))
            if not at or datetime.fromisoformat(at) < oldest:
                continue

            # The same event reaches both feeds; keep it once, and keep the
            # first (widest window) so a significant quake is not aged out by
            # the weekly feed's shorter memory.
            if event_id in by_id:
                continue

            url = props.get("url")
            by_id[event_id] = {
                "event_id": event_id,
                "magnitude": round(magnitude, 1),
                "place": str(props.get("place") or "").strip(),
                "lat": lat, "lng": lng, "at": at,
                "tsunami": props.get("tsunami") in (1, "1", True),
                "url": url if isinstance(url, str) and url.startswith("http") else None,
            }

    if counted < MIN_PLAUSIBLE_EVENTS:
        raise SourceProblem(
            f"only {counted} events came back from {len(feeds)} feed(s), expected at least "
            f"{MIN_PLAUSIBLE_EVENTS} — refusing to overwrite the table")
    if not by_id:
        raise SourceProblem(
            f"{counted} events came back but none were usable above M{MIN_MAGNITUDE}")

    return sorted(by_id.values(), key=lambda r: r["at"], reverse=True)


def sql_str(value):
    if value is None or value == "":
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def sql_num(value):
    return "null" if value is None else repr(float(value))


def emit_sql(rows):
    columns = ("event_id", "magnitude", "place", "lat", "lng", "at", "tsunami", "url")
    print(f"-- {len(rows)} earthquakes from USGS")
    print("begin;")

    values = [
        "  ({}, {}, {}, {}, {}, {}, {}, {}, now())".format(
            sql_str(r["event_id"]), sql_num(r["magnitude"]), sql_str(r["place"]),
            sql_num(r["lat"]), sql_num(r["lng"]), sql_str(r["at"]),
            "true" if r["tsunami"] else "false", sql_str(r["url"]))
        for r in rows
    ]
    for start in range(0, len(values), INSERT_BATCH):
        print("insert into public.quake_events ({}, refreshed_at) values"
              .format(", ".join(columns)))
        print(",\n".join(values[start:start + INSERT_BATCH]))
        print("on conflict (event_id) do update set "
              "magnitude = excluded.magnitude, place = excluded.place, "
              "lat = excluded.lat, lng = excluded.lng, at = excluded.at, "
              "tsunami = excluded.tsunami, url = excluded.url, refreshed_at = now();")

    # now() is the transaction's start time and does not move, so every row
    # this run touched carries exactly that value and every row it did not
    # carries something strictly earlier. No interval to tune, and no window in
    # which a fast second run would spare a stale row.
    print("delete from public.quake_events where refreshed_at < now();")
    print("commit;")
    print("select count(*) as quakes, max(magnitude) as strongest, "
          "to_char(max(at), 'YYYY-MM-DD HH24:MI') as most_recent "
          "from public.quake_events;")


def main():
    if "--file" in sys.argv:
        with open(sys.argv[sys.argv.index("--file") + 1], encoding="utf-8") as handle:
            feeds = [(json.load(handle), FEEDS[0][1])]
    else:
        feeds = []
        for url, days in FEEDS:
            payload = fetch(url)
            if payload is None:
                print(f"--   giving up on {url.rsplit('/', 1)[-1]}", file=sys.stderr)
                continue
            feeds.append((payload, days))

    if not feeds:
        print("::error::Could not reach USGS. Nothing written; the table keeps what it had.",
              file=sys.stderr)
        sys.exit(1)

    try:
        rows = rows_from(feeds)
    except SourceProblem as err:
        print(f"::error::USGS answered, but not usefully: {err}", file=sys.stderr)
        sys.exit(1)

    emit_sql(rows)
    print(f"-- {len(rows)} earthquakes written", file=sys.stderr)


if __name__ == "__main__":
    main()
