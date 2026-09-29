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
# Red and Orange events only. GDACS also grades Green, which is the routine
# background of a working planet — keep it and half the countries on Earth look
# eventful, which teaches a reader to ignore the whole thing.
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

# Worth a traveller's attention. Green is not.
SEVERITY = {"Red": "severe", "Orange": "notice"}

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

        for code in countries_of(props):
            rows[(event_id, code)] = {
                "event_id": event_id, "country_code": code, "kind": kind,
                "severity": severity, "name": name,
                "from_date": as_timestamp(props.get("fromdate")),
                "to_date": as_timestamp(props.get("todate")),
                "url": url,
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


def emit_sql(rows):
    columns = ("event_id", "country_code", "kind", "severity", "name",
               "from_date", "to_date", "url")
    print(f"-- {len(rows)} country alerts from {SOURCE}")
    print("begin;")

    values = [
        "  ({}, {}, {}, {}, {}, {}, {}, {}, now())".format(
            sql_str(r["event_id"]), sql_str(r["country_code"]), sql_str(r["kind"]),
            sql_str(r["severity"]), sql_str(r["name"]),
            sql_str(r["from_date"]), sql_str(r["to_date"]), sql_str(r["url"]))
        for r in rows
    ]
    for start in range(0, len(values), INSERT_BATCH):
        print("insert into public.disaster_alerts ({}, refreshed_at) values"
              .format(", ".join(columns)))
        print(",\n".join(values[start:start + INSERT_BATCH]))
        print("on conflict (event_id, country_code) do update set "
              "kind = excluded.kind, severity = excluded.severity, name = excluded.name, "
              "from_date = excluded.from_date, to_date = excluded.to_date, "
              "url = excluded.url, refreshed_at = now();")

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
