#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Four questions, one probe. Nothing is written.
#
#   1. NOAA/NWS — what does api.weather.gov give for the United States?
#      Event types, severity words, geometry, and the three different times a
#      CAP alert carries (onset, effective, expires).
#
#   2. Can a weather warning be in the FUTURE? Both NWS and MeteoAlarm publish
#      onset times; if those are routinely hours or days ahead then "warnings
#      for the coming week" is a real thing to show rather than a wish.
#
#   3. Does GDACS carry a forecast for a tropical cyclone — a track, or an
#      alert level for where the storm is going rather than where it is?
#
#   4. And the honest one: is there anything forecast-like for earthquakes,
#      floods, wildfires or volcanoes, or do those only ever arrive as
#      something that has already happened?
#
# Reads only. Run it from the Probe workflow.
# ---------------------------------------------------------------------------
import json
import re
import sys
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone

UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"
NOW = datetime.now(timezone.utc)


def get(url, accept="application/json"):
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")[:300]
    except Exception as err:                                    # noqa: BLE001
        return None, f"{type(err).__name__}: {err}"


def hours_from_now(stamp):
    if not stamp:
        return None
    try:
        when = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return round((when - NOW).total_seconds() / 3600, 1)


def line(title):
    print(f"\n{'=' * 78}\n{title}\n{'=' * 78}")


# --- 1 & 2. NOAA / NWS -----------------------------------------------------
def nws():
    line("NOAA / NWS — api.weather.gov/alerts/active")
    status, body = get("https://api.weather.gov/alerts/active",
                       "application/geo+json")
    print(f"  status {status}, {len(body)} bytes")
    if status != 200:
        print(f"  body: {body[:300]!r}")
        return
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        print("  not JSON")
        return

    features = payload.get("features") or []
    print(f"  {len(features)} active alerts")
    if not features:
        return

    print(f"\n  fields on one alert:\n      "
          f"{', '.join(sorted((features[0].get('properties') or {}).keys()))}")

    events, severities, urgencies, certainties = Counter(), Counter(), Counter(), Counter()
    geometry, future, ahead = Counter(), 0, []
    for f in features:
        p = f.get("properties") or {}
        events[p.get("event")] += 1
        severities[p.get("severity")] += 1
        urgencies[p.get("urgency")] += 1
        certainties[p.get("certainty")] += 1
        g = f.get("geometry")
        geometry[(g or {}).get("type") if g else "none"] += 1
        onset = hours_from_now(p.get("onset") or p.get("effective"))
        if onset is not None and onset > 1:
            future += 1
            ahead.append((onset, p.get("event"), p.get("severity")))

    print(f"\n  severity:   {dict(severities)}")
    print(f"  urgency:    {dict(urgencies)}")
    print(f"  certainty:  {dict(certainties)}")
    print(f"  geometry:   {dict(geometry)}")
    print(f"\n  the twenty commonest event types:")
    for name, n in events.most_common(20):
        print(f"      {n:>5}  {name}")
    print(f"\n  {len(events)} distinct event types in all")

    print(f"\n  STARTING IN THE FUTURE: {future} of {len(features)}")
    for onset, event, sev in sorted(ahead, reverse=True)[:12]:
        print(f"      +{onset:>7} h   {str(sev):<9} {event}")
    if ahead:
        print(f"      furthest ahead: +{max(a[0] for a in ahead)} h "
              f"({round(max(a[0] for a in ahead) / 24, 1)} days)")

    print("\n  one alert in full, so the shape is on the record:")
    p = features[0].get("properties") or {}
    for key in ("id", "event", "severity", "urgency", "certainty", "headline",
                "areaDesc", "onset", "effective", "expires", "ends",
                "senderName", "web"):
        print(f"      {key:<12} = {str(p.get(key))[:120]!r}")
    g = features[0].get("geometry")
    print(f"      geometry     = {str(g)[:160] if g else None}")
    # Which alerts carry a usable point, and which only a zone reference?
    with_geom = [f for f in features if f.get("geometry")]
    print(f"\n  {len(with_geom)} of {len(features)} carry geometry inline; "
          f"the rest reference NWS zones by URL (affectedZones).")
    if features[0].get("properties", {}).get("affectedZones"):
        print(f"      affectedZones example: "
              f"{features[0]['properties']['affectedZones'][:2]}")


# --- 2b. MeteoAlarm, same question -----------------------------------------
def meteoalarm():
    line("MeteoAlarm — are its warnings ever in the future?")
    for country in ("germany", "spain", "france", "italy"):
        status, body = get(
            f"https://feeds.meteoalarm.org/api/v1/warnings/feeds-{country}")
        if status != 200:
            print(f"  {country:<10} status {status}")
            continue
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            print(f"  {country:<10} not JSON")
            continue
        warnings = payload.get("warnings") or []
        onsets = []
        for w in warnings:
            for info in (w.get("alert") or {}).get("info") or []:
                h = hours_from_now(info.get("onset") or info.get("effective"))
                if h is not None:
                    onsets.append(h)
        ahead = [h for h in onsets if h > 1]
        print(f"  {country:<10} {len(warnings):>4} warnings, "
              f"{len(ahead):>3} start more than an hour from now"
              + (f", furthest +{max(ahead)} h ({round(max(ahead)/24,1)} d)" if ahead else ""))


# --- 3 & 4. GDACS, and what a forecast even means per kind -----------------
def gdacs():
    line("GDACS — is there a forecast in any of it?")
    status, body = get("https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH")
    if status != 200:
        print(f"  status {status}")
        return
    payload = json.loads(body)
    features = payload.get("features") or []

    # A cyclone is the one kind with a real forecast: GDACS publishes a track.
    cyclones = [f for f in features
                if str((f.get("properties") or {}).get("eventtype")).upper() == "TC"]
    print(f"  {len(cyclones)} tropical cyclones in the list")
    if cyclones:
        p = cyclones[0].get("properties") or {}
        print("\n  every field of one, looking for anything forward-looking:")
        for key in sorted(p):
            print(f"      {key:<22} = {str(p[key])[:130]}")

    # And the dates, per kind: does to_date ever sit in the future?
    print("\n  does to_date ever sit in the FUTURE, by kind?")
    ahead = Counter()
    total = Counter()
    for f in features:
        p = f.get("properties") or {}
        kind = str(p.get("eventtype") or "?").upper()
        total[kind] += 1
        h = hours_from_now(p.get("todate"))
        if h is not None and h > 24:
            ahead[kind] += 1
    for kind in sorted(total):
        print(f"      {kind:<4} {ahead[kind]:>3} of {total[kind]:>3} end more than a day from now")


def main():
    print("What can be known in advance? Nothing is written.\n")
    nws()
    meteoalarm()
    gdacs()
    print("\nDone.")


if __name__ == "__main__":
    main()
