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
    del severity          # only its presence matters now that Green is gone
    kind = fd.KINDS.get(str(props.get("eventtype") or "").strip().upper())
    if not kind:
        return "DROP", f"eventtype {props.get('eventtype')!r} is not a kind we draw"
    if kind in fd.RUNNING_MEANS_SOMETHING \
            and str(props.get("iscurrent") or "true").strip().lower() == "false":
        return "DROP", "iscurrent is false"
    if not str(props.get("name") or props.get("description") or "").strip():
        return "DROP", "no name"

    to_date = fd.as_timestamp(props.get("todate"))
    if fd.is_stale(to_date, NOW):
        age = (NOW - datetime.fromisoformat(to_date)).days if to_date else "?"
        return "DROP", f"last update {age} days ago, past the {fd.MAX_QUIET_DAYS}-day cut"

    if kind not in fd.RUNNING_MEANS_SOMETHING:
        when = to_date or fd.as_timestamp(props.get("fromdate"))
        if not when:
            return "DROP", "no date at all, so it cannot be placed in the week"
        if fd.is_stale(when, NOW):
            days = (NOW - datetime.fromisoformat(when)).days
            return "DROP", f"happened {days} days ago, past the {fd.MAX_QUIET_DAYS}-day cut"

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

    # --- the droughts, in full, with every field GDACS sends -----------------
    #
    # "Are these still active, and why is Europe one of them?" The list holds
    # seven. Five share a todate three days old; two carry one frozen months
    # back. If that is the difference between a drought GDACS is still
    # assessing and one it has stopped assessing, then the five are live and
    # our seven-day cut is already removing the other two for us. Print every
    # field of every one, and the report link, so it can be checked rather
    # than inferred.
    print(f"\n{'=' * 78}\nDROUGHTS, every field\n{'=' * 78}")
    found = 0
    for feature in features:
        props = (feature or {}).get("properties") or {}
        if str(props.get("eventtype") or "").strip().upper() != "DR":
            continue
        found += 1
        state, why = verdict(props, feature)
        print(f"\n  [{found}] {state}  {why or 'on the map'}")
        for key in sorted(props):
            value = str(props[key])
            if len(value) > 150:
                value = value[:150] + "…"
            print(f"      {key:<22} = {value}")
    if not found:
        print("  nothing of kind DR in the list at all.")

    print("\nDone.")


if __name__ == "__main__":
    main()
