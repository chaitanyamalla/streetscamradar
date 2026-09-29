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

    # --- and specifically: every earthquake, one line each --------------------
    #
    # None of them reach the table, and several very different things would look
    # like that from outside: an ordinary week where GDACS graded them all Green
    # and none reached magnitude 6, a magnitude that is never read, or a list
    # that is simply not carrying recent quakes. One line each fits in a log
    # tail, where a full dump of 39 events does not — and a tally of the reasons
    # answers it outright.
    print(f"\n{'=' * 78}\nEARTHQUAKES, newest first\n{'=' * 78}")
    quakes = []
    for feature in features:
        props = (feature or {}).get("properties") or {}
        if str(props.get("eventtype") or "").strip().upper() != "EQ":
            continue
        state, why = verdict(props, feature)
        quakes.append((str(props.get("fromdate") or ""), props, state, why))
    quakes.sort(key=lambda q: q[0], reverse=True)

    reasons = {}
    for when, props, state, why in quakes:
        magnitude, depth = fd.severity_numbers(props)
        age = "?"
        stamp = fd.as_timestamp(props.get("fromdate"))
        if stamp:
            age = (NOW - datetime.fromisoformat(stamp)).days
        reasons[why or "on the map"] = reasons.get(why or "on the map", 0) + 1
        print(f"  {state:<4} M{str(magnitude):<5} {str(props.get('alertlevel')):<7} "
              f"{str(props.get('country'))[:22]:<24} {when[:16]:<18} {age} d ago  "
              f"iscurrent={props.get('iscurrent')}  {why}")

    print(f"\n  {len(quakes)} earthquakes seen. Why:")
    for why, count in sorted(reasons.items(), key=lambda kv: -kv[1]):
        print(f"      {count:>3}  {why}")

    print("\nDone.")


if __name__ == "__main__":
    main()
