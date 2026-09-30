#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Why is something on gdacs.org missing from our map?
#
# It answered the orange flood in India, and now it is pointed at the
# earthquakes, of which the table holds none. Rather than read our filters and
# reason about them, this runs them: it fetches the same list the refresh does,
# applies the real fetch_disasters rules to every event, and prints what each
# one was kept or dropped FOR.
#
# It imports the generator itself, so there is no second copy of the rules to
# drift out of step with the first.
#
# Reads only, writes nothing. Run it from the Probe workflow.
# ---------------------------------------------------------------------------
import json
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "supabase" / "ops"))
import fetch_disasters as fd                                    # noqa: E402

UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"
NOW = datetime.now(timezone.utc)


def get(url):
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.loads(response.read().decode("utf-8"))


def verdict(props, feature):
    """Exactly the rules in fetch_disasters.rows_from, one event at a time."""
    severity = fd.SEVERITY.get(str(props.get("alertlevel") or "").strip())
    if not severity:
        return "DROP", f"alertlevel {props.get('alertlevel')!r} is not one we keep"
    if str(props.get("iscurrent") or "true").strip().lower() == "false":
        return "DROP", "iscurrent is false"
    kind = fd.KINDS.get(str(props.get("eventtype") or "").strip().upper())
    if not kind:
        return "DROP", f"eventtype {props.get('eventtype')!r} is not a kind we draw"
    if not str(props.get("name") or props.get("description") or "").strip():
        return "DROP", "no name"

    to_date = fd.as_timestamp(props.get("todate"))
    if fd.is_stale(to_date, NOW):
        age = (NOW - datetime.fromisoformat(to_date)).days if to_date else "?"
        return "DROP", f"last update {age} days ago, past the {fd.MAX_QUIET_DAYS}-day cut"

    magnitude, _ = fd.severity_numbers(props)
    if kind == "earthquake" and severity == "routine" \
            and not (magnitude is not None and magnitude >= fd.BIG_QUAKE):
        return "DROP", f"green earthquake below M{fd.BIG_QUAKE} (M{magnitude})"

    if not fd.countries_of(props):
        return "DROP", "no usable country code, so it cannot answer the country question"

    coords = ((feature or {}).get("geometry") or {}).get("coordinates")
    if not isinstance(coords, list) or len(coords) < 2:
        return "KEEP", "stored, but with no position it cannot be drawn"
    return "KEEP", ""


def main():
    # The same two lists the refresh reads, merged the same way.
    payload = fd.merge([get(url) for url in fd.SOURCES])
    features = payload.get("features") or []
    print(f"GDACS is carrying {len(features)} events. Nothing is written.\n")

    kept, dropped = [], []
    for feature in features:
        props = (feature or {}).get("properties") or {}
        state, why = verdict(props, feature)
        row = (props, why)
        (kept if state == "KEEP" else dropped).append(row)

    print(f"{'=' * 78}\nDROPPED — {len(dropped)} of {len(features)}\n{'=' * 78}")
    for props, why in dropped:
        print(f"  {str(props.get('eventtype')):<3} {str(props.get('alertlevel')):<7} "
              f"{str(props.get('country'))[:26]:<28} {str(props.get('name'))[:34]:<36} {why}")

    print(f"\n{'=' * 78}\nKEPT — {len(kept)}\n{'=' * 78}")
    for props, why in kept:
        print(f"  {str(props.get('eventtype')):<3} {str(props.get('alertlevel')):<7} "
              f"{str(props.get('country'))[:26]:<28} {str(props.get('name'))[:34]:<36} {why}")

    # --- a tally per kind, then every flood, one line each --------------------
    #
    # "Our map has a flood in Turkey and gdacs.org does not, and gdacs.org has
    # one in Italy and our map does not" is two questions about the same list,
    # and both are answered by printing the floods rather than reasoning about
    # them. The per-kind tally above it says whether a whole kind is missing.
    tally = {}
    for feature in features:
        props = (feature or {}).get("properties") or {}
        kind = str(props.get("eventtype") or "?").strip().upper()
        state, _ = verdict(props, feature)
        seen = tally.setdefault(kind, {"KEEP": 0, "DROP": 0})
        seen[state] += 1
    print(f"\n{'=' * 78}\nPER KIND\n{'=' * 78}")
    for kind, seen in sorted(tally.items()):
        print(f"  {kind:<4} kept {seen['KEEP']:>3}   dropped {seen['DROP']:>3}")

    print(f"\n{'=' * 78}\nFLOODS, newest first\n{'=' * 78}")
    floods = []
    for feature in features:
        props = (feature or {}).get("properties") or {}
        if str(props.get("eventtype") or "").strip().upper() != "FL":
            continue
        floods.append((str(props.get("fromdate") or ""), props, feature))
    floods.sort(key=lambda f: f[0], reverse=True)
    for when, props, feature in floods:
        state, why = verdict(props, feature)
        print(f"  {state:<4} {str(props.get('alertlevel')):<7} "
              f"{str(props.get('country'))[:26]:<28} {when[:10]:<12} "
              f"-> {str(props.get('todate'))[:10]:<12} "
              f"iscurrent={str(props.get('iscurrent')):<6} {why}")
    if not floods:
        print("  GDACS's event list carries no floods at all.")

    # --- and the two countries in question, in full ---------------------------
    print(f"\n{'=' * 78}\nTURKEY AND ITALY, in full\n{'=' * 78}")
    found = 0
    for feature in features:
        props = (feature or {}).get("properties") or {}
        blob = (str(props.get("country")) + str(props.get("affectedcountries"))
                + str(props.get("name")))
        if not any(word in blob for word in
                   ("Turkey", "T\u00fcrkiye", "'TR'", "Italy", "Italia", "'IT'")):
            continue
        found += 1
        state, why = verdict(props, feature)
        print(f"\n  {state}  {why or 'on the map'}")
        for key in ("eventtype", "alertlevel", "name", "country", "affectedcountries",
                    "fromdate", "todate", "iscurrent", "eventid", "episodeid"):
            print(f"      {key:<20} = {str(props.get(key))[:100]!r}")
    if not found:
        print("  Nothing for either country in the list at all.")

    print("\nDone.")


if __name__ == "__main__":
    main()
