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
import urllib.request

SOURCE = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP"
UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"
KINDS = {"EQ": "earthquake", "TC": "cyclone", "FL": "flood",
         "VO": "volcano", "DR": "drought", "WF": "wildfire"}


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

    print("\nDone.")


if __name__ == "__main__":
    main()
