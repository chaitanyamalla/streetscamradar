#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Refresh public.weather_warnings from MeteoAlarm.
#
#   https://feeds.meteoalarm.org/api/v1/warnings/feeds-<country>
#
# MeteoAlarm is the European met services' shared warning system. Every warning
# here was issued by a national weather service — the sender's own name is
# stored with it — and nothing in this file second-guesses one.
#
# One request per country, 38 of them, every few hours. There is no worldwide
# feed; this is how MeteoAlarm publishes.
#
# What is kept
# ------------
# Orange and red only. MeteoAlarm grades green / yellow / orange / red, and the
# first two are most of what it publishes — about 5,000 of the 5,600 warnings
# live across Europe on an ordinary afternoon. Keeping them would flag half the
# continent permanently and teach a reader to ignore the rest.
#
# No warning text. The type, the level, the area, the times, who issued it and
# where to read it — facts about the warning — and the text stays with the
# service that wrote it, in their words and current. One row per CAP alert.
#
# What leaves, and when
# ---------------------
# Whatever MeteoAlarm stops publishing, plus anything whose own expiry has
# passed. A weather warning has a definite end, unlike a flood, so both apply.
#
# Refusing to write rubbish
# -------------------------
# Half of Europe answering with nothing is a bad afternoon for the feed, not a
# calm one for the continent. If too few countries answer at all, this writes
# nothing and the previous rows stay up.
#
# Usage:
#   python3 fetch_weather.py > weather.sql
#   python3 fetch_weather.py --file sample.json --country DE > weather.sql
# ---------------------------------------------------------------------------
import json
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

FEED = "https://feeds.meteoalarm.org/api/v1/warnings/feeds-{}"

# Thirty-eight requests, asked in parallel and given a short deadline each.
#
# Sequentially with a 30-second timeout and a retry, one unresponsive country
# could hold the whole job for a minute and a handful of them for half an hour;
# the first real run sat on this step for nine minutes and had to be killed. A
# country that has not answered in fifteen seconds is a country we do without
# this round — the next run is three hours away, and the floor below refuses to
# write if too many of them go quiet at once.
TIMEOUT = 15
WORKERS = 8
INSERT_BATCH = 200

# MeteoAlarm's feed slugs, and the country each one is about. Its own country
# list; north-macedonia is published but answers 404, which the run reports
# rather than treating as an outage.
COUNTRIES = {
    "austria": "AT", "belgium": "BE", "bosnia-herzegovina": "BA", "bulgaria": "BG",
    "croatia": "HR", "cyprus": "CY", "czechia": "CZ", "denmark": "DK",
    "estonia": "EE", "finland": "FI", "france": "FR", "germany": "DE",
    "greece": "GR", "hungary": "HU", "iceland": "IS", "ireland": "IE",
    "israel": "IL", "italy": "IT", "latvia": "LV", "lithuania": "LT",
    "luxembourg": "LU", "malta": "MT", "moldova": "MD", "montenegro": "ME",
    "netherlands": "NL", "north-macedonia": "MK", "norway": "NO", "poland": "PL",
    "portugal": "PT", "romania": "RO", "serbia": "RS", "slovakia": "SK",
    "slovenia": "SI", "spain": "ES", "sweden": "SE", "switzerland": "CH",
    "ukraine": "UA", "united-kingdom": "GB",
}

# The awareness_type parameter reads "3; Thunderstorm" — and "1; Wind" in one
# country's feed and "1; wind" in another's, which is why the NUMBER is what is
# matched on. The words after it are not stable and are not relied upon.
KINDS = {
    1: "wind", 2: "snow-ice", 3: "thunderstorm", 4: "fog",
    5: "high-temperature", 6: "low-temperature", 7: "coastal-event",
    8: "forest-fire", 9: "avalanche", 10: "rain", 12: "flood", 13: "rain-flood",
}

# awareness_level reads "3; orange; Severe" — same instability, same fix.
# 1 green and 2 yellow are deliberately absent: see the note at the top.
LEVELS = {3: "notice", 4: "severe"}

# 37 of the 38 countries answered when this was written. Well under half would
# mean the interface is having a bad day, and overwriting a table of live
# warnings with that would replace real warnings with silence.
MIN_COUNTRIES_ANSWERING = 20


class SourceProblem(Exception):
    """The source answered, but not with something worth writing down."""


def http_get(url, timeout=TIMEOUT):
    request = urllib.request.Request(url, headers={
        "User-Agent": "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8")


def fetch_country(slug):
    """One country's warnings, or None if it would not say."""
    try:
        return json.loads(http_get(FEED.format(slug)))
    except urllib.error.HTTPError as err:
        # A 404 is MeteoAlarm saying it publishes nothing for that country,
        # not a network problem.
        print(f"--   {slug}: HTTP {err.code}", file=sys.stderr)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as err:
        print(f"--   {slug}: {err}", file=sys.stderr)
    return None


def fetch_all():
    """Every country at once. Returns only the ones that answered."""
    slugs = list(COUNTRIES)
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        answers = list(pool.map(fetch_country, slugs))
    return {COUNTRIES[slug]: payload
            for slug, payload in zip(slugs, answers) if payload is not None}


def as_timestamp(value):
    """CAP times carry their offset — "2026-09-27T07:00:00+02:00" — so they are
    converted to UTC here rather than left for Postgres to interpret."""
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


def leading_number(value):
    """The code in front of "3; orange; Severe"."""
    head = str(value or "").split(";")[0].strip()
    try:
        return int(head)
    except ValueError:
        return None


def parameters_of(info):
    """MeteoAlarm puts the type and the level in CAP parameter pairs."""
    out = {}
    for entry in info.get("parameter") or []:
        if isinstance(entry, dict) and entry.get("valueName"):
            out[str(entry["valueName"])] = entry.get("value")
    return out


def pick_info(alert):
    """One language's worth of an alert.

    An alert repeats itself once per language. Which one is picked barely
    matters — we store no text from it — so English is taken when offered
    purely so the logs are readable, and the first entry otherwise.
    """
    infos = [i for i in (alert.get("info") or []) if isinstance(i, dict)]
    for info in infos:
        if str(info.get("language") or "").lower().startswith("en"):
            return info
    return infos[0] if infos else None


def areas_of(info):
    """The met service's own names for where the warning applies."""
    names = []
    for area in info.get("area") or []:
        name = str((area or {}).get("areaDesc") or "").strip() if isinstance(area, dict) else ""
        if name and name not in names:
            names.append(name)
    return names


def rows_from(payloads):
    """Every warning worth storing, from {country_code: payload}.

    `payloads` holds only the countries that answered; a country that did not
    is absent rather than empty, so its existing rows are left alone instead of
    being read as "all clear".
    """
    if len(payloads) < MIN_COUNTRIES_ANSWERING:
        raise SourceProblem(
            f"only {len(payloads)} of {len(COUNTRIES)} countries answered, expected at "
            f"least {MIN_COUNTRIES_ANSWERING} — refusing to overwrite the table")

    rows = {}
    for code, payload in payloads.items():
        warnings = payload.get("warnings") if isinstance(payload, dict) else None
        if not isinstance(warnings, list):
            continue

        for warning in warnings:
            alert = (warning or {}).get("alert")
            if not isinstance(alert, dict):
                continue
            # Cancellations and test messages are not warnings.
            if str(alert.get("status") or "Actual").strip().lower() != "actual":
                continue
            if str(alert.get("msgType") or "Alert").strip().lower() in ("cancel", "ack", "error"):
                continue

            info = pick_info(alert)
            if not info:
                continue

            params = parameters_of(info)
            severity = LEVELS.get(leading_number(params.get("awareness_level")))
            kind = KINDS.get(leading_number(params.get("awareness_type")))
            if not severity or not kind:
                continue

            areas = areas_of(info)
            source = str(info.get("senderName") or alert.get("sender") or "").strip()
            if not areas or not source:
                continue

            url = info.get("web")
            url = url if isinstance(url, str) and url.startswith("http") else None

            identifier = str(alert.get("identifier") or "").strip()
            if not identifier:
                continue

            rows[(identifier, code)] = {
                "warning_id": identifier, "country_code": code, "kind": kind,
                "severity": severity,
                # Enough to recognise where, without storing a page of geocodes.
                "areas": ", ".join(areas[:6]) + (" …" if len(areas) > 6 else ""),
                "from_date": as_timestamp(info.get("onset") or info.get("effective")),
                "to_date": as_timestamp(info.get("expires")),
                "source": source[:120], "url": url,
            }

    return sorted(rows.values(), key=lambda r: (r["country_code"], r["warning_id"]))


def sql_str(value):
    if value is None or value == "":
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def emit_sql(rows):
    columns = ("warning_id", "country_code", "kind", "severity", "areas",
               "from_date", "to_date", "source", "url")
    print(f"-- {len(rows)} orange/red weather warnings from MeteoAlarm")
    print("begin;")

    if rows:
        values = [
            "  ({}, {}, {}, {}, {}, {}, {}, {}, {}, now())".format(
                sql_str(r["warning_id"]), sql_str(r["country_code"]), sql_str(r["kind"]),
                sql_str(r["severity"]), sql_str(r["areas"]), sql_str(r["from_date"]),
                sql_str(r["to_date"]), sql_str(r["source"]), sql_str(r["url"]))
            for r in rows
        ]
        for start in range(0, len(values), INSERT_BATCH):
            print("insert into public.weather_warnings ({}, refreshed_at) values"
                  .format(", ".join(columns)))
            print(",\n".join(values[start:start + INSERT_BATCH]))
            print("on conflict (warning_id, country_code) do update set "
                  "kind = excluded.kind, severity = excluded.severity, "
                  "areas = excluded.areas, from_date = excluded.from_date, "
                  "to_date = excluded.to_date, source = excluded.source, "
                  "url = excluded.url, refreshed_at = now();")

    # Zero orange or red warnings across Europe is a real and welcome state of
    # the weather, unlike an interface returning nothing, so this runs even
    # when there is nothing to insert. now() is the transaction's start time
    # and does not move, so every row this run touched carries exactly it.
    print("delete from public.weather_warnings where refreshed_at < now();")

    # A warning that has run out has run out, whatever the feed still lists.
    print("delete from public.weather_warnings where to_date is not null "
          "and to_date < now();")
    print("commit;")
    print("select country_code, severity, count(*) from public.weather_warnings "
          "group by country_code, severity order by 3 desc, 1 limit 12;")


def main():
    if "--file" in sys.argv:
        with open(sys.argv[sys.argv.index("--file") + 1], encoding="utf-8") as handle:
            code = sys.argv[sys.argv.index("--country") + 1] if "--country" in sys.argv else "DE"
            payloads = {code: json.load(handle)}
            # One file is a sample, not a sweep of Europe, so the floor that
            # protects a real run would only get in the way here.
            globals()["MIN_COUNTRIES_ANSWERING"] = 1
    else:
        payloads = fetch_all()

    try:
        rows = rows_from(payloads)
    except SourceProblem as problem:
        print(f"::error::{problem}", file=sys.stderr)
        sys.exit(1)

    emit_sql(rows)
    kinds = {}
    for row in rows:
        kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
    print(f"-- {len(payloads)} countries answered; {len(rows)} orange/red warnings across "
          f"{len({r['country_code'] for r in rows})} of them: "
          + (", ".join(f"{k}={v}" for k, v in sorted(kinds.items())) or "none"), file=sys.stderr)


if __name__ == "__main__":
    main()
