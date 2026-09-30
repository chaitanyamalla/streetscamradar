#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Which GDACS endpoint does gdacs.org's own map read?
#
# It answered the India flood: EVENTS4APP and SEARCH disagree, and both are
# merged now. It is pointed at Italy for the same reason — gdacs.org shows a
# flood there and the merged list carries nothing for Italy at all, so either
# some third list has it, or their map is drawing something that is not a
# GDACS event.
#
# So this does two things. It asks every endpoint we know of for its floods,
# in full, and says whether Italy is anywhere in the body. Then it reads the
# map pages themselves and prints every API URL they reference, because the
# only authority on what their map calls is their map.
#
# No guessing from documentation — the travel advisory work already cost a
# release that way.
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

# Anything that would name Italy, in the spellings GDACS uses.
ITALY = ("Italy", "Italia", "'IT'", '"IT"', "ITA")

BASE = "https://www.gdacs.org/gdacsapi/api/events/geteventlist"
CANDIDATES = [
    ("EVENTS4APP (half of what we mirror)", f"{BASE}/EVENTS4APP"),
    ("SEARCH, no arguments (the other half)", f"{BASE}/SEARCH"),
    ("SEARCH, last 7 days, floods only",
     f"{BASE}/SEARCH?fromDate={WEEK}&toDate={TODAY}&alertlevel=&eventlist=FL"),
    ("SEARCH, last 30 days, all kinds",
     f"{BASE}/SEARCH?fromDate={MONTH}&toDate={TODAY}&alertlevel=&eventlist=EQ;TC;FL;VO;WF;DR"),
    # What gdacs.org's own home page calls, one request per kind. The argument
    # is `eventtypes`, PLURAL — `eventlist`, which every other endpoint here
    # takes, gets a 400 "Eventtype is required." from this one. That single
    # letter is why we had never read the list their map draws.
    ("MAP eventtypes=FL (what their map draws)", f"{BASE}/MAP?eventtypes=FL"),
    ("MAP eventtypes=EQ", f"{BASE}/MAP?eventtypes=EQ"),
    ("MAP eventtypes=TC", f"{BASE}/MAP?eventtypes=TC"),
    ("MAP eventtypes=VO", f"{BASE}/MAP?eventtypes=VO"),
    ("MAP eventtypes=DR", f"{BASE}/MAP?eventtypes=DR"),
    ("MAP eventtypes=WF", f"{BASE}/MAP?eventtypes=WF"),
    ("homepagetable", f"{BASE}/homepagetable"),
    ("rss.xml", "https://www.gdacs.org/xml/rss.xml"),
    ("rss_7d.xml", "https://www.gdacs.org/xml/rss_7d.xml"),
]

# The pages their live map is drawn on. We do not parse these for events — we
# read them for the URLs they call, which is the only reliable answer to "what
# is their map actually showing".
PAGES = [
    ("home", "https://www.gdacs.org/"),
    ("alerts", "https://www.gdacs.org/Alerts/default.aspx"),
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


def mentions_italy(body):
    return {word: len(re.findall(re.escape(word), body)) for word in ITALY
            if re.search(re.escape(word), body)}


def look(name, url):
    status, body = fetch(url)
    print(f"\n{'-' * 78}\n{name}\n  {url}\n  status {status}, {len(body)} bytes")
    if status != 200:
        print(f"  body: {body[:200]!r}")
        return

    italy = mentions_italy(body)
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        floods = len(re.findall(r"eventtype>FL|FL</", body))
        print(f"  not JSON — FL mentions: {floods}, Italy: {italy or 'none'}")
        for match in re.finditer(r".{160}Italy.{160}", body, re.S):
            print(f"    …{match.group(0)[:340]!r}…")
            break
        return

    features = payload.get("features") if isinstance(payload, dict) else None
    if not isinstance(features, list):
        print(f"  JSON, top level {sorted(payload) if isinstance(payload, dict) else type(payload)}")
        return

    kinds, floods = {}, []
    for feature in features:
        props = (feature or {}).get("properties") or {}
        kind = str(props.get("eventtype") or "?")
        kinds[kind] = kinds.get(kind, 0) + 1
        if kind == "FL":
            floods.append(props)
    print(f"  {len(features)} events  {kinds}")
    print(f"  Italy anywhere in the body: {italy or 'none'}")
    print(f"  every flood it carries ({len(floods)}):")
    for props in floods:
        print(f"    {str(props.get('alertlevel')):<7} {str(props.get('country'))[:30]:<32} "
              f"{str(props.get('fromdate'))[:10]} -> {str(props.get('todate'))[:10]}  "
              f"current={props.get('iscurrent')}  id={props.get('eventid')}")


def read_page(name, url):
    status, body = fetch(url)
    print(f"\n{'-' * 78}\nPAGE {name}\n  {url}\n  status {status}, {len(body)} bytes")
    if status != 200:
        return
    print(f"  Italy anywhere on the page: {mentions_italy(body) or 'none'}")
    seen = []
    for match in re.finditer(r"""["'(]([^"'()\s]*(?:gdacsapi|geteventlist|\.json|/xml/)[^"'()\s]*)""",
                             body, re.IGNORECASE):
        found = match.group(1)
        if found not in seen:
            seen.append(found)
    print(f"  data URLs it references ({len(seen)}):")
    for found in seen[:40]:
        print(f"    {found}")


def main():
    print("What does gdacs.org's own map read, and does anything have Italy? "
          "Nothing is written.")
    for name, url in CANDIDATES:
        look(name, url)
    for name, url in PAGES:
        read_page(name, url)
    print("\nDone.")


if __name__ == "__main__":
    main()
