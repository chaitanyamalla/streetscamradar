#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# What is actually on the GDACS live map right now?
#
# Two questions, both from a real answer rather than from my own reasoning:
#
#   1. We keep Red and Orange and drop Green, which today leaves exactly one
#      event on the whole map while gdacs.org shows dozens of storms. How many
#      of each kind, at each alert level, is GDACS carrying? Green was dropped
#      on the argument that it is "the routine background of a working planet"
#      — true of an earthquake, but a green tropical cyclone is still a storm
#      somebody's flight goes through.
#
#   2. GDACS carries earthquakes too, with its own impact grading. If its
#      earthquake events carry a magnitude and a position, one source can
#      replace two — and its Red/Orange grading is a better answer to "is this
#      one worth a traveller's attention" than a raw magnitude cut, because it
#      weighs where the ground moved as well as how much.
#
# Writes nothing. Run it from the Probe workflow.
# ---------------------------------------------------------------------------
import collections
import json
from datetime import datetime, timezone
import urllib.request

SOURCE = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP"
UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"
KINDS = {"EQ": "earthquake", "TC": "cyclone", "FL": "flood",
         "VO": "volcano", "WF": "wildfire"}   # DR, drought, is not carried


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    payload = get(SOURCE)
    features = payload.get("features") or []
    print(f"GDACS is carrying {len(features)} events. Nothing is written.\n")

    grid = collections.Counter()
    has_point = collections.Counter()
    no_point = collections.Counter()
    countries = collections.Counter()
    samples = {}

    for feature in features:
        props = (feature or {}).get("properties") or {}
        kind = KINDS.get(str(props.get("eventtype") or "").strip().upper(), "?")
        level = str(props.get("alertlevel") or "?").strip()
        grid[(kind, level)] += 1

        coords = ((feature or {}).get("geometry") or {}).get("coordinates")
        ok = isinstance(coords, list) and len(coords) >= 2
        (has_point if ok else no_point)[kind] += 1

        affected = props.get("affectedcountries")
        if isinstance(affected, str):
            try:
                affected = json.loads(affected.replace("'", '"'))
            except json.JSONDecodeError:
                affected = []
        countries[kind] += len(affected or [])

        if kind not in samples:
            samples[kind] = props

    # --- the grid ----------------------------------------------------------
    levels = ["Red", "Orange", "Green"]
    print(f"{'kind':<12}" + "".join(f"{l:>8}" for l in levels)
          + f"{'total':>8}{'no pos':>8}{'country rows':>14}")
    print("-" * 70)
    kept_now = kept_all = 0
    for kind in sorted(set(k for k, _ in grid)):
        row = [grid[(kind, l)] for l in levels]
        total = sum(grid[(kind, l)] for l in grid if l[0] == kind) if False else sum(row)
        other = sum(v for (k, l), v in grid.items() if k == kind and l not in levels)
        kept_now += row[0] + row[1]
        kept_all += total + other
        print(f"{kind:<12}" + "".join(f"{v:>8}" for v in row)
              + f"{total + other:>8}{no_point[kind]:>8}{countries[kind]:>14}")
    print("-" * 70)
    print(f"  kept by today's rule (Red + Orange, no earthquakes) : "
          f"{kept_now - sum(grid[('earthquake', l)] for l in ('Red', 'Orange'))}")
    print(f"  every alert level, every kind                       : {kept_all}")
    print(f"  every level except green earthquakes                : "
          f"{kept_all - grid[('earthquake', 'Green')]}")

    # --- what an event of each kind actually carries ------------------------
    for kind, props in sorted(samples.items()):
        print(f"\n{'=' * 70}\n{kind.upper()} — one event, in full\n{'=' * 70}")
        for key in ("eventname", "name", "description", "alertlevel", "alertscore",
                    "episodealertlevel", "fromdate", "todate", "iscurrent", "country",
                    "severitydata", "url", "eventid", "episodeid"):
            if key in props:
                print(f"  {key:<20} = {str(props[key])[:160]!r}")

    # --- is a magnitude in there for the earthquakes? -----------------------
    print(f"\n{'=' * 70}\nEARTHQUAKES — severity, one line each\n{'=' * 70}")
    shown = 0
    for feature in features:
        props = (feature or {}).get("properties") or {}
        if str(props.get("eventtype") or "").upper() != "EQ":
            continue
        coords = ((feature or {}).get("geometry") or {}).get("coordinates") or []
        print(f"  {str(props.get('alertlevel')):<7} "
              f"severitydata={str(props.get('severitydata'))[:90]:<92} "
              f"at={coords[:2]} {str(props.get('name'))[:40]}")
        shown += 1
        if shown >= 12:
            break
    if not shown:
        print("  (none in the list right now)")

    # --- how far back does the live list reach? -----------------------------
    print(f"\n{'=' * 70}\nHOW OLD IS WHAT GDACS IS SHOWING\n{'=' * 70}")
    now = datetime.now(timezone.utc)

    def age_days(value):
        text = str(value or "").strip()
        if not text:
            return None
        try:
            stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        return (now - stamp).total_seconds() / 86400

    rows = []
    for feature in features:
        props = (feature or {}).get("properties") or {}
        kind = KINDS.get(str(props.get("eventtype") or "").strip().upper(), "?")
        rows.append((kind, str(props.get("alertlevel") or "?"),
                     age_days(props.get("fromdate")), age_days(props.get("todate")),
                     str(props.get("iscurrent") or "")))

    print(f"  {'kind':<12}{'started':>10}{'last update':>14}   {'iscurrent':<10}")
    print("  " + "-" * 52)
    for kind in sorted({r[0] for r in rows}):
        mine = [r for r in rows if r[0] == kind]
        starts = sorted(r[2] for r in mine if r[2] is not None)
        ends = sorted(r[3] for r in mine if r[3] is not None)
        current = {r[4] for r in mine}
        print(f"  {kind:<12}{'%.1f–%.1f d' % (starts[0], starts[-1]) if starts else '—':>10}"
              f"{'%.1f–%.1f d' % (ends[0], ends[-1]) if ends else '—':>14}   {','.join(sorted(current)):<10}")

    for cut in (2, 3, 5, 7, 14, 30):
        kept = sum(1 for r in rows if r[3] is not None and r[3] <= cut)
        by_start = sum(1 for r in rows if r[2] is not None and r[2] <= cut)
        print(f"  last update within {cut:>2} days: {kept:>3} of {len(rows)}"
              f"   |   started within {cut:>2} days: {by_start:>3}")


    # --- what we could put on a popup: severitytext, per kind ---------------
    #
    # The popup now shows a one-line measurement taken from severitytext
    # ("Tropical storm (maximum wind speed of 120 km/h)"). The live table had
    # one event in it when that shipped, so it proved the cyclone case and
    # nothing else. This asks GDACS directly: of the events we keep (Red and
    # Orange), which kinds actually carry that line, and what does it read?
    print(f"\n{'=' * 70}\nSEVERITYTEXT — does each kind carry a measurement?\n{'=' * 70}")
    carried = collections.Counter()
    seen = collections.Counter()
    examples = collections.defaultdict(list)
    for feature in features:
        props = (feature or {}).get("properties") or {}
        kind = KINDS.get(str(props.get("eventtype") or "").strip().upper(), "?")
        if str(props.get("alertlevel") or "").strip() not in ("Red", "Orange"):
            continue
        seen[kind] += 1
        raw = props.get("severitydata")
        if isinstance(raw, str):
            try:
                raw = json.loads(raw.replace("'", '"'))
            except json.JSONDecodeError:
                raw = {}
        text = str((raw or {}).get("severitytext") or "").strip()
        if text:
            carried[kind] += 1
            if len(examples[kind]) < 3:
                examples[kind].append(text[:120])

    print(f"  {'kind':<12}{'red+orange':>12}{'with text':>11}")
    print("  " + "-" * 35)
    for kind in sorted(seen):
        print(f"  {kind:<12}{seen[kind]:>12}{carried[kind]:>11}")
    for kind in sorted(examples):
        for text in examples[kind]:
            print(f"    {kind:<10} {text!r}")
    if not seen:
        print("  (nothing red or orange on the map right now)")

    print("\nDone.")


if __name__ == "__main__":
    main()
