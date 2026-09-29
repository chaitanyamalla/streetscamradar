#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# What does a geocoder hand back for a COUNTRY?
#
# Searching "France" on the map landed on the middle of the ocean. The suspect
# is the bounding box: France is not only the hexagon, it is also French
# Guiana, Réunion, New Caledonia and French Polynesia, and one box drawn round
# all of them is most of the planet. Fitting the map to that box is how you end
# up looking at the Atlantic.
#
# This asks both services we use — Nominatim for the search button, Photon for
# the suggestions — what box they give for countries known to have far-flung
# territories, for a few ordinary countries, and for a city, so the threshold
# that tells one from the other is set from real numbers rather than a guess.
#
# Writes nothing. Run it from the Probe workflow.
# ---------------------------------------------------------------------------
import json
import urllib.parse
import urllib.request

UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
PHOTON = "https://photon.komoot.io/api/"

SCATTERED = ["France", "United States", "Russia", "Chile", "Portugal",
             "Netherlands", "Spain", "Norway", "Ecuador", "New Zealand",
             "United Kingdom", "Denmark"]
COMPACT = ["Germany", "Thailand", "Kenya", "Japan", "Poland", "Peru",
           "Australia", "Canada", "Brazil", "India"]
SMALLER = ["Bavaria", "Catalonia", "Lisbon", "Paris", "Khao San Road, Bangkok"]


def get(url):
    request = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def nominatim(query):
    url = NOMINATIM + "?" + urllib.parse.urlencode(
        {"q": query, "format": "jsonv2", "addressdetails": 1, "limit": 1})
    rows = get(url)
    if not rows:
        return None
    row = rows[0]
    box = [float(v) for v in row["boundingbox"]]      # south north west east
    return {
        "kind": row.get("addresstype") or row.get("type"),
        "lat": float(row["lat"]), "lng": float(row["lon"]),
        "south": box[0], "north": box[1], "west": box[2], "east": box[3],
    }


def photon(query):
    url = PHOTON + "?" + urllib.parse.urlencode({"q": query, "limit": 1, "lang": "en"})
    features = get(url).get("features") or []
    if not features:
        return None
    props = features[0].get("properties") or {}
    extent = props.get("extent")                      # west north east south
    point = features[0]["geometry"]["coordinates"]
    out = {"kind": props.get("type") or props.get("osm_value"),
           "lat": point[1], "lng": point[0]}
    if extent and len(extent) == 4:
        out.update(west=extent[0], north=extent[1], east=extent[2], south=extent[3])
    return out


def describe(name, row):
    if not row:
        print(f"  {name:<26} (nothing found)")
        return
    if "south" not in row:
        print(f"  {name:<26} kind={row['kind']:<12} point only, no box")
        return
    lat_span = row["north"] - row["south"]
    lng_span = row["east"] - row["west"]
    print(f"  {name:<26} kind={str(row['kind']):<12} "
          f"point=({row['lat']:.2f}, {row['lng']:.2f})  "
          f"box lat {row['south']:.1f}…{row['north']:.1f} ({lat_span:.1f}°)  "
          f"lng {row['west']:.1f}…{row['east']:.1f} ({lng_span:.1f}°)")


def section(title, names):
    print(f"\n{'-' * 78}\n{title}\n{'-' * 78}")
    for name in names:
        print(f"\n{name}")
        try:
            describe("nominatim", nominatim(name))
        except Exception as err:                                   # noqa: BLE001
            print(f"  nominatim                  failed: {type(err).__name__}: {err}")
        try:
            describe("photon", photon(name))
        except Exception as err:                                   # noqa: BLE001
            print(f"  photon                     failed: {type(err).__name__}: {err}")


def main():
    print("How big is the box a geocoder draws round a country? Nothing is written.")
    section("COUNTRIES WITH TERRITORIES FAR FROM THE MAINLAND", SCATTERED)
    section("COUNTRIES IN ONE PIECE, FOR CONTRAST", COMPACT)
    section("SMALLER THAN A COUNTRY — THESE MUST KEEP WORKING", SMALLER)
    print("\nDone.")


if __name__ == "__main__":
    main()
