#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Refresh public.disaster_alerts from GDACS.
#
#   https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP
#
# One request returns every current event worldwide, so this is a small job.
#
# What is kept
# ------------
# Every alert level GDACS publishes: Red, Orange and Green. Green used to be
# dropped, on the argument that it is the routine background of a working
# planet. That is true of a magnitude 4.7 under the sea floor. It is not true
# of a tropical cyclone, which is a storm somebody's flight goes through
# whatever its humanitarian grading — and dropping Green left ONE event on our
# whole map on a day gdacs.org was showing seven storms, two floods and
# seventy-two fires.
#
# Earthquakes are the exception, and are held to a higher bar: Orange or Red,
# or magnitude 6 and above. Nineteen of the hundred events in a typical list
# are earthquakes and every one of them is Green, magnitude 4.5 to 5.6, most
# far out at sea or a hundred kilometres down. Those are the ones nobody felt.
#
# One row per event per country. GDACS names every country an event touches,
# and "is anything happening where I am going" is a question about a country,
# not about an event.
#
# What leaves, and when
# ---------------------
# Whatever GDACS stops listing. It decides when a flood is over; we should not
# second-guess that with a timer of our own, so anything absent from a run is
# deleted at the end of it. Rows also carry to_date, so the page can ignore an
# event whose own end date has long passed even if GDACS is slow to drop it.
#
# Refusing to write rubbish
# -------------------------
# An empty or unparseable response would, taken literally, mean nothing is
# happening anywhere on Earth — and would clear the table. That is a bad day at
# GDACS, not a calm day on the planet, so it writes nothing and the previous
# rows stay up.
#
# Usage:
#   python3 fetch_disasters.py > disasters.sql
#   python3 fetch_disasters.py --file sample.json > disasters.sql
# ---------------------------------------------------------------------------
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

SOURCE = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP"
TIMEOUT = 45
RETRIES = 3
INSERT_BATCH = 200

# GDACS event types, as its `eventtype` field spells them.
KINDS = {
    "EQ": "earthquake", "TC": "cyclone", "FL": "flood",
    "VO": "volcano", "DR": "drought", "WF": "wildfire",
}

# GDACS's three grades, kept as its own words mean them.
SEVERITY = {"Red": "severe", "Orange": "notice", "Green": "routine"}

# An earthquake GDACS grades Green is kept only if it was this big anyway. A
# magnitude 6 is felt over a wide area and makes the news wherever it happens,
# which is the line between "worth knowing before you travel" and "the ground
# is never still". Below it, a Green quake is one nobody noticed.
BIG_QUAKE = 6.0

# The feed carries a hundred events on an ordinary day, most of them Green. A
# response with nothing in it at all is a broken response rather than a quiet
# planet, and must not be allowed to empty the table.
MIN_PLAUSIBLE_EVENTS = 20

NOT_AN_EVENT = {"contentList"}


class SourceProblem(Exception):
    """The source answered, but not with something worth writing down."""


def http_get(url, timeout=TIMEOUT):
    request = urllib.request.Request(url, headers={
        "User-Agent": "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8")


def fetch(url=SOURCE, retries=RETRIES):
    for attempt in range(1, retries + 1):
        try:
            return json.loads(http_get(url))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as err:
            print(f"--   attempt {attempt}/{retries} failed: {err}", file=sys.stderr)
            if attempt < retries:
                time.sleep(2 ** attempt)
    return None


def as_timestamp(value):
    """GDACS sends ISO strings with no zone. They are UTC; say so explicitly
    rather than let Postgres guess from the server's timezone."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).isoformat()


def countries_of(props):
    """Every two-letter country code an event touches.

    affectedcountries arrives as a Python-repr string — single quotes — rather
    than JSON, so it is converted before parsing rather than trusted to load.
    """
    codes = []
    affected = props.get("affectedcountries")
    if isinstance(affected, str):
        try:
            affected = json.loads(affected.replace("'", '"'))
        except json.JSONDecodeError:
            affected = None
    for entry in affected if isinstance(affected, list) else []:
        code = str((entry or {}).get("iso2") or "").strip().upper()
        if len(code) == 2 and code.isalpha() and code not in codes:
            codes.append(code)
    return codes


def severity_numbers(props):
    """Magnitude and depth, where GDACS measured them.

    severitydata arrives as a Python-repr string like
    {'severity': 5.0, 'severitytext': 'Magnitude 5M, Depth:157.801km', ...}
    — single quotes, so it is converted before parsing rather than trusted to
    load. `severity` means something different per kind (magnitude for a quake,
    km/h for a cyclone, hectares for a fire), so it is only read as a magnitude
    when the unit says M.
    """
    raw = props.get("severitydata")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw.replace("'", '"'))
        except json.JSONDecodeError:
            raw = None
    if not isinstance(raw, dict):
        return None, None

    magnitude = None
    if str(raw.get("severityunit") or "").strip().upper() == "M":
        try:
            magnitude = round(float(raw.get("severity")), 1)
        except (TypeError, ValueError):
            magnitude = None

    depth = None
    match = re.search(r"Depth:\s*([0-9.]+)\s*km", str(raw.get("severitytext") or ""))
    if match:
        try:
            depth = round(float(match.group(1)), 1)
        except ValueError:
            depth = None
    return magnitude, depth


def point_of(feature):
    """Where GDACS puts the event, when it gives something usable.

    Stored, but only drawn for volcanoes. A volcano IS this point; a flood or a
    cyclone is a centroid of everything affected, and "Flood in Guinea" lands
    400 km from the water. Keeping the number and choosing not to draw it beats
    throwing it away and being unable to draw the one kind it fits.
    """
    coordinates = ((feature or {}).get("geometry") or {}).get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        return None, None
    try:
        lng, lat = float(coordinates[0]), float(coordinates[1])
    except (TypeError, ValueError):
        return None, None
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        return None, None
    return lat, lng


def rows_from(payload):
    """Every (event, country) row worth storing."""
    if not isinstance(payload, dict):
        raise SourceProblem("payload is not a JSON object")
    features = payload.get("features")
    if not isinstance(features, list):
        raise SourceProblem("no 'features' array — the interface answers {} when it is down")
    if len(features) < MIN_PLAUSIBLE_EVENTS:
        raise SourceProblem(
            f"only {len(features)} events came back, expected at least "
            f"{MIN_PLAUSIBLE_EVENTS} — refusing to overwrite the table")

    rows = {}
    shape_reported = False
    for feature in features:
        props = (feature or {}).get("properties")
        if not isinstance(props, dict):
            continue
        if not shape_reported:
            print(f"-- fields in an event: [{', '.join(sorted(props))}]", file=sys.stderr)
            shape_reported = True

        severity = SEVERITY.get(str(props.get("alertlevel") or "").strip())
        if not severity:
            continue
        if str(props.get("iscurrent") or "true").strip().lower() == "false":
            continue
        kind = KINDS.get(str(props.get("eventtype") or "").strip().upper())
        if not kind:
            continue

        magnitude, depth = severity_numbers(props)

        # The one kind held to a higher bar — see BIG_QUAKE.
        if kind == "earthquake" and severity == "routine" \
                and not (magnitude is not None and magnitude >= BIG_QUAKE):
            continue

        name = str(props.get("name") or props.get("description") or "").strip()
        if not name:
            continue

        event_id = "{}-{}-{}".format(
            str(props.get("eventtype") or "?").strip(),
            str(props.get("eventid") or "?").strip(),
            str(props.get("episodeid") or "0").strip())

        url = props.get("url")
        if isinstance(url, dict):
            url = url.get("report") or url.get("details")
        url = url if isinstance(url, str) and url.startswith("http") else None

        lat, lng = point_of(feature)

        for code in countries_of(props):
            rows[(event_id, code)] = {
                "event_id": event_id, "country_code": code, "kind": kind,
                "severity": severity, "name": name,
                "from_date": as_timestamp(props.get("fromdate")),
                "to_date": as_timestamp(props.get("todate")),
                "url": url, "lat": lat, "lng": lng,
                "magnitude": magnitude, "depth_km": depth,
            }

    # An event GDACS lists but names no country for cannot answer the only
    # question this table exists for, so zero rows from a full feed is still a
    # problem worth stopping on.
    if not rows:
        raise SourceProblem(
            f"{len(features)} events came back but none carried a usable country code")
    return sorted(rows.values(), key=lambda r: (r["country_code"], r["event_id"]))


def sql_str(value):
    if value is None or value == "":
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def sql_num(value):
    return "null" if value is None else repr(float(value))


def emit_sql(rows):
    columns = ("event_id", "country_code", "kind", "severity", "name",
               "from_date", "to_date", "url", "lat", "lng", "magnitude", "depth_km")
    print(f"-- {len(rows)} country alerts from {SOURCE}")
    print("begin;")

    values = [
        "  ({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, now())".format(
            sql_str(r["event_id"]), sql_str(r["country_code"]), sql_str(r["kind"]),
            sql_str(r["severity"]), sql_str(r["name"]),
            sql_str(r["from_date"]), sql_str(r["to_date"]), sql_str(r["url"]),
            sql_num(r["lat"]), sql_num(r["lng"]),
            sql_num(r["magnitude"]), sql_num(r["depth_km"]))
        for r in rows
    ]
    for start in range(0, len(values), INSERT_BATCH):
        print("insert into public.disaster_alerts ({}, refreshed_at) values"
              .format(", ".join(columns)))
        print(",\n".join(values[start:start + INSERT_BATCH]))
        print("on conflict (event_id, country_code) do update set "
              "kind = excluded.kind, severity = excluded.severity, name = excluded.name, "
              "from_date = excluded.from_date, to_date = excluded.to_date, "
              "url = excluded.url, lat = excluded.lat, lng = excluded.lng, "
              "magnitude = excluded.magnitude, depth_km = excluded.depth_km, "
              "refreshed_at = now();")

    # GDACS decides when something is over. Anything it stopped listing goes,
    # which is exactly "when the original site removes it, we remove it".
    #
    # now() is the transaction's start time and does not move, so every row
    # this run touched carries exactly that value and every row it did not
    # carries something strictly earlier. No interval to tune, and no window in
    # which a fast second run would spare a stale row.
    print("delete from public.disaster_alerts where refreshed_at < now();")
    print("commit;")
    print("select kind, severity, count(*) from public.disaster_alerts "
          "group by kind, severity order by 1, 2;")


def main():
    if "--file" in sys.argv:
        with open(sys.argv[sys.argv.index("--file") + 1], encoding="utf-8") as handle:
            payload = json.load(handle)
    else:
        payload = fetch()

    if payload is None:
        print("::error::Could not reach GDACS. Nothing written; the table keeps what it had.",
              file=sys.stderr)
        sys.exit(1)

    try:
        rows = rows_from(payload)
    except SourceProblem as problem:
        print(f"::error::{problem}", file=sys.stderr)
        sys.exit(1)

    emit_sql(rows)
    countries = len({r["country_code"] for r in rows})
    kinds = {}
    for row in rows:
        kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
    print(f"-- {len(rows)} rows across {countries} countries: "
          + ", ".join(f"{k}={v}" for k, v in sorted(kinds.items())), file=sys.stderr)


if __name__ == "__main__":
    main()
