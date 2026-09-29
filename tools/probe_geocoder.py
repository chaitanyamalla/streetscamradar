#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Can we offer suggestions while somebody types, and from whom?
#
# Not from Nominatim. Its usage policy says so in as many words — "sending a
# query on every keystroke is not acceptable" — and this site already leans on
# Nominatim for search and reverse geocoding. Asking it to autocomplete as well
# would be abusing a free service run for everyone.
#
# Photon is the alternative from the same data: built by Komoot specifically
# for type-ahead, OpenStreetMap underneath, no key. This asks the questions
# that decide whether the search box can use it:
#
#   1. Does it send CORS headers? Without them the browser cannot call it and
#      the whole idea needs a proxy of ours.
#   2. How fast is it? A suggestion that arrives after you have finished typing
#      is not a suggestion.
#   3. Are the results any good for what people actually type here — half a
#      city name, a postcode, a street in Bangkok?
#   4. What does it return? Field names, not documentation.
#
# Writes nothing. Run it from the Probe workflow.
# ---------------------------------------------------------------------------
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ORIGIN = "https://streetscamradar.vercel.app"
UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"
TIMEOUT = 15

PHOTON = "https://photon.komoot.io/api/"
NOMINATIM = "https://nominatim.openstreetmap.org/search"

# What someone half-way through typing actually sends: a prefix, a postcode, a
# street abroad, an accented name, and something misspelled.
TYPED = [
    "lisb", "10115 berl", "khao san", "münch", "barcelon", "praha 1",
    "gare du nord", "roma termini", "kreuzberg",
]


def get(url, headers=None):
    request = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "application/json", "Origin": ORIGIN,
        **(headers or {}),
    })
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            body = response.read().decode("utf-8")
            return response.status, dict(response.headers), body, time.monotonic() - started
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read().decode("utf-8", "replace")[:300], \
            time.monotonic() - started
    except Exception as err:                                   # noqa: BLE001
        return None, {}, f"{type(err).__name__}: {err}", time.monotonic() - started


def cors(headers):
    allow = headers.get("Access-Control-Allow-Origin")
    if allow in ("*", ORIGIN):
        return f"YES ({allow}) — the browser can call this directly"
    if allow:
        return f"partial ({allow}) — not us"
    return "NO — would need a proxy or a mirror of ours"


def label(feature):
    """What we would put in the list, from whatever it gives us."""
    p = (feature or {}).get("properties") or {}
    parts = [p.get("name"), p.get("city") or p.get("district"), p.get("state"), p.get("country")]
    seen, out = set(), []
    for part in parts:
        if part and part not in seen:
            seen.add(part)
            out.append(str(part))
    return ", ".join(out)


def probe_photon():
    print(f"\n{'=' * 72}\nPHOTON — suggestions as you type\n{'=' * 72}")
    url = PHOTON + "?" + urllib.parse.urlencode({"q": "lisb", "limit": 5, "lang": "en"})
    status, headers, body, took = get(url)
    print(f"  url               : {url}")
    print(f"  status            : {status}  in {took * 1000:.0f} ms")
    print(f"  content-type      : {headers.get('Content-Type', '—')}")
    print(f"  CORS for us       : {cors(headers)}")
    print(f"  cache-control     : {headers.get('Cache-Control', '—')}")
    print(f"  rate-limit headers: "
          f"{ {k: v for k, v in headers.items() if 'rate' in k.lower() or 'limit' in k.lower()} }")
    if status != 200:
        print(f"  body              : {body[:300]}")
        return

    payload = json.loads(body)
    print(f"  top level         : {sorted(payload)}")
    features = payload.get("features") or []
    print(f"  features          : {len(features)}")
    if features:
        props = features[0].get("properties") or {}
        print(f"  property names    : {sorted(props)}")
        print("  first result      :")
        for key in sorted(props):
            print(f"      {key:<16} = {str(props[key])[:60]!r}")
        print(f"  geometry          : {features[0].get('geometry')}")

    print("\n  -- what a half-typed query gets back, and how fast --")
    times = []
    for typed in TYPED:
        u = PHOTON + "?" + urllib.parse.urlencode({"q": typed, "limit": 5, "lang": "en"})
        status, _, body, took = get(u)
        times.append(took)
        try:
            names = [label(f) for f in (json.loads(body).get("features") or [])][:3]
        except json.JSONDecodeError:
            names = ["(not JSON)"]
        print(f"    {typed:<16} {took * 1000:6.0f} ms  {status}  {names}")
    if times:
        print(f"    slowest {max(times) * 1000:.0f} ms, median "
              f"{sorted(times)[len(times) // 2] * 1000:.0f} ms")

    # Biasing towards where the map already is, so "main street" means the one
    # near you rather than one in Ohio.
    biased = PHOTON + "?" + urllib.parse.urlencode(
        {"q": "haupt", "limit": 5, "lang": "de", "lat": 52.52, "lon": 13.40})
    status, _, body, took = get(biased)
    try:
        names = [label(f) for f in (json.loads(body).get("features") or [])][:5]
    except json.JSONDecodeError:
        names = ["(not JSON)"]
    print(f"\n  -- biased to Berlin: {status} in {took * 1000:.0f} ms\n     {names}")


def probe_nominatim_for_contrast():
    """Only to show the policy is the reason, not the capability."""
    print(f"\n{'=' * 72}\nNOMINATIM — for contrast (we will NOT autocomplete with it)\n{'=' * 72}")
    url = NOMINATIM + "?" + urllib.parse.urlencode(
        {"q": "lisb", "format": "jsonv2", "limit": 5, "addressdetails": 1})
    status, headers, body, took = get(url)
    print(f"  status            : {status}  in {took * 1000:.0f} ms")
    print(f"  CORS for us       : {cors(headers)}")
    print("  policy            : per-keystroke autocomplete is explicitly not "
          "allowed, whatever the response says")


def main():
    print("Probing the geocoders. Nothing is written.")
    probe_photon()
    probe_nominatim_for_contrast()
    print("\nDone.")


if __name__ == "__main__":
    main()
