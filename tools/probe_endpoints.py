#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Which GDACS endpoint does gdacs.org's own map read?
#
# An orange flood in India is on their live map. The list we mirror —
# geteventlist/EVENTS4APP — carries nothing for India at all, so the event
# never reached any filter of ours. That means we are reading a narrower feed
# than the site shows, and the question is which one it is reading instead.
#
# This tries the endpoints GDACS publishes, and for each one reports: does it
# answer, how many events, how many are floods, and is India in there. No
# guessing from documentation — the travel advisory work already cost a release
# that way.
#
# Reads only, writes nothing. Run it from the Probe workflow.
# ---------------------------------------------------------------------------
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"
TODAY = datetime.now(timezone.utc).date()
WEEK = TODAY - timedelta(days=7)
MONTH = TODAY - timedelta(days=30)

BASE = "https://www.gdacs.org/gdacsapi/api/events/geteventlist"
CANDIDATES = [
    ("EVENTS4APP (what we mirror)", f"{BASE}/EVENTS4APP"),
    ("SEARCH, no arguments", f"{BASE}/SEARCH"),
    ("SEARCH, last 30 days, all kinds",
     f"{BASE}/SEARCH?fromDate={MONTH}&toDate={TODAY}&alertlevel=&eventlist=EQ;TC;FL;VO;WF;DR"),
    ("SEARCH, last 7 days, floods only",
     f"{BASE}/SEARCH?fromDate={WEEK}&toDate={TODAY}&alertlevel=&eventlist=FL"),
    ("MAP", f"{BASE}/MAP"),
    ("MAP, last 30 days",
     f"{BASE}/MAP?fromDate={MONTH}&toDate={TODAY}&alertlevel=&eventlist=EQ;TC;FL;VO;WF;DR"),
    ("rss.xml", "https://www.gdacs.org/xml/rss.xml"),
    ("rss_7d.xml", "https://www.gdacs.org/xml/rss_7d.xml"),
]


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")[:200]
    except Exception as err:                                    # noqa: BLE001
        return None, f"{type(err).__name__}: {err}"


def look(name, url):
    status, body = fetch(url)
    print(f"\n{'-' * 78}\n{name}\n  {url}\n  status {status}, {len(body)} bytes")
    if status != 200:
        print(f"  body: {body[:200]!r}")
        return

    india = len(re.findall(r"India", body))
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        floods = len(re.findall(r"eventtype>FL|FL</", body))
        print(f"  not JSON — mentions of India: {india}, of FL: {floods}")
        if india:
            for m in re.finditer(r".{200}India.{200}", body):
                print(f"    …{m.group(0)}…")
                break
        return

    features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(features, list):
        print(f"  JSON, top level {sorted(payload) if isinstance(payload, dict) else type(payload)}")
        return

    kinds, flood_rows = {}, []
    for f in features:
        props = (f or {}).get("properties") or {}
        kind = str(props.get("eventtype") or "?")
        kinds[kind] = kinds.get(kind, 0) + 1
        blob = str(props.get("country")) + str(props.get("affectedcountries"))
        if kind == "FL" and "India" in blob:
            flood_rows.append(props)
    print(f"  {len(features)} events  {kinds}")
    print(f"  mentions of India anywhere in the body: {india}")
    for props in flood_rows:
        print(f"    FLOOD IN INDIA: {props.get('alertlevel')} {str(props.get('name'))[:60]!r} "
              f"from {props.get('fromdate')} to {props.get('todate')} "
              f"current={props.get('iscurrent')} id={props.get('eventid')}")


def main():
    print("Which GDACS endpoint has the India flood? Nothing is written.")
    for name, url in CANDIDATES:
        look(name, url)
    print("\nDone.")


if __name__ == "__main__":
    main()
