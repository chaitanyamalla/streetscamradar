#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# What do our basemap tiles actually say about a disputed border?
#
# Jammu & Kashmir renders on our map the way OpenStreetMap draws it: the Line
# of Control as the working boundary, so Gilgit-Baltistan and Azad Kashmir sit
# inside Pakistan's outline and Aksai Chin inside China's. India maps the whole
# of the former princely state as its own territory, and a map distributed in
# India has to show it that way.
#
# Before changing anything there is one question that decides HOW. The
# OpenMapTiles schema, which CARTO's tiles are built from, can carry
# `disputed`, `disputed_name` and `claimed_by` on each boundary line. If our
# tiles carry those fields, then a viewer in India can be shown India's claim
# line by restyling layers we already load — no new provider, no API key, no
# cost. If they do not, the only route is drawing our own line over the top,
# and every viewer gets the same one.
#
# So this answers, from the bytes rather than from my recollection:
#
#   1. Which layers in positron and dark-matter draw boundaries, with their
#      filters and colours — i.e. what is there to restyle or to cover up.
#   2. What properties the boundary features over Kashmir actually carry.
#   3. Whether `claimed_by` / `disputed` appear, and with what values.
#
# Reads only. No key, no database, nothing written. Run from the Probe workflow.
# ---------------------------------------------------------------------------
import collections
import gzip
import json
import math
import struct
import urllib.request
import zlib

STYLES = {
    "positron":    "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    "dark-matter": "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
}

# Srinagar, and the three stretches that are drawn differently by different
# countries: the Line of Control, the Gilgit-Baltistan side, and Aksai Chin.
PLACES = [
    ("Srinagar",        34.08, 74.80),
    ("Gilgit",          35.92, 74.31),
    ("Muzaffarabad",    34.37, 73.47),
    ("Aksai Chin",      35.10, 79.00),
]
ZOOMS = [4, 6]

UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"
BOUNDARY_WORDS = ("boundar", "admin", "border", "disput", "country")


def get(url, as_json=True):
    """Fetch, and say what came back. A tile is gzipped more often than not."""
    request = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept-Encoding": "gzip, deflate"})
    with urllib.request.urlopen(request, timeout=45) as response:
        raw = response.read()
        encoding = (response.headers.get("Content-Encoding") or "").lower()
        kind = (response.headers.get("Content-Type") or "?").split(";")[0]

    # A .mvt is served gzipped by most CDNs, and urllib hands back the bytes as
    # they arrived. Sniff as well as trust the header: a tile that is really
    # gzip but unlabelled would otherwise read as a corrupt protobuf.
    if "gzip" in encoding or raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    elif "deflate" in encoding:
        raw = zlib.decompress(raw, -zlib.MAX_WBITS)

    if as_json:
        return json.loads(raw.decode("utf-8"))
    return raw, kind


def tile_of(lat, lng, z):
    n = 2 ** z
    x = int((lng + 180.0) / 360.0 * n)
    s = math.sin(math.radians(lat))
    y = int((0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


# --- the smallest protobuf reader that answers the question ----------------
# Mapbox vector tiles are protobuf. Geometry is not needed here, only the
# property tables, so this walks the wire format and ignores the rest rather
# than pulling in a dependency the probe workflow does not install.

def fields(buf):
    """Yield (field_number, wire_type, value) over one protobuf message."""
    i, end = 0, len(buf)
    while i < end:
        key, i = varint(buf, i)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, i = varint(buf, i)
        elif wire == 1:
            value, i = buf[i:i + 8], i + 8
        elif wire == 2:
            size, i = varint(buf, i)
            value, i = buf[i:i + size], i + size
        elif wire == 5:
            value, i = buf[i:i + 4], i + 4
        else:
            raise ValueError(f"unsupported wire type {wire}")
        yield number, wire, value


def varint(buf, i):
    result = shift = 0
    while True:
        byte = buf[i]
        i += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, i
        shift += 7


def packed(buf):
    out, i = [], 0
    while i < len(buf):
        value, i = varint(buf, i)
        out.append(value)
    return out


def value_of(buf):
    """An MVT Value: whichever of the seven typed fields is set."""
    for number, _wire, raw in fields(buf):
        if number == 1:
            return raw.decode("utf-8", "replace")
        if number == 2:
            return struct.unpack("<f", raw)[0]
        if number == 3:
            return struct.unpack("<d", raw)[0]
        if number in (4, 5):
            return raw
        if number == 6:
            return (raw >> 1) ^ -(raw & 1)
        if number == 7:
            return bool(raw)
    return None


def layers_of(tile):
    """{layer name: [ {property: value}, ... ]} for one .mvt, geometry dropped."""
    out = {}
    for number, _wire, raw in fields(tile):
        if number != 3:
            continue
        name, keys, values, features = None, [], [], []
        for fnum, _fw, fraw in fields(raw):
            if fnum == 1:
                name = fraw.decode("utf-8", "replace")
            elif fnum == 2:
                features.append(fraw)
            elif fnum == 3:
                keys.append(fraw.decode("utf-8", "replace"))
            elif fnum == 4:
                values.append(value_of(fraw))
        rows = []
        for feature in features:
            tags = []
            for fnum, _fw, fraw in fields(feature):
                if fnum == 2:
                    tags = packed(fraw)
            row = {}
            for k, v in zip(tags[0::2], tags[1::2]):
                if k < len(keys) and v < len(values):
                    row[keys[k]] = values[v]
            rows.append(row)
        out[name or "?"] = rows
    return out


def report_style(label, url):
    print(f"\n{'=' * 74}\n{label}  {url}\n{'=' * 74}")
    style = get(url)

    print("\n-- boundary layers (what there is to restyle, or to cover) --")
    found = 0
    for layer in style.get("layers") or []:
        haystack = f"{layer.get('id','')} {layer.get('source-layer','')}".lower()
        if not any(word in haystack for word in BOUNDARY_WORDS):
            continue
        found += 1
        paint = layer.get("paint") or {}
        colour = paint.get("line-color") or paint.get("fill-color") or paint.get("text-color")
        print(f"  {layer.get('id')}")
        print(f"      source-layer : {layer.get('source-layer')}   type: {layer.get('type')}")
        print(f"      colour       : {json.dumps(colour)}")
        print(f"      filter       : {json.dumps(layer.get('filter'))}")
        print(f"      zoom         : {layer.get('minzoom')} .. {layer.get('maxzoom')}")
    if not found:
        print("  none matched " + "/".join(BOUNDARY_WORDS) +
              " — the style names its layers something else, see the full list below")
        for layer in (style.get("layers") or []):
            print(f"    {layer.get('id')}  <- {layer.get('source-layer')}")

    return style


def tile_template(style):
    """Resolve the vector source's tile URL template through its TileJSON."""
    for name, source in (style.get("sources") or {}).items():
        if source.get("type") != "vector":
            continue
        if source.get("tiles"):
            return name, source["tiles"][0]
        if source.get("url"):
            tilejson = get(source["url"])
            if tilejson.get("tiles"):
                return name, tilejson["tiles"][0]
    return None, None


def report_tiles(style):
    name, template = tile_template(style)
    print(f"\n-- vector source --\n  {name}: {template}")
    if not template:
        print("  no vector source with a tile template; cannot read features")
        return

    seen_keys = collections.Counter()
    claimed = collections.Counter()
    samples = []

    for place, lat, lng in PLACES:
        for z in ZOOMS:
            x, y = tile_of(lat, lng, z)
            url = (template.replace("{z}", str(z)).replace("{x}", str(x))
                           .replace("{y}", str(y)).replace("{ratio}", "")
                           .replace("@2x", ""))
            try:
                raw, kind = get(url, as_json=False)
            except Exception as problem:            # noqa: BLE001 - a probe reports, never raises
                print(f"  {place} z{z}: {type(problem).__name__}: {problem}")
                continue

            try:
                layers = layers_of(raw)
            except Exception as problem:            # noqa: BLE001 - same reason
                print(f"  {place} z{z} -> {z}/{x}/{y}: not readable as a tile")
                print(f"      {type(problem).__name__}: {problem}")
                print(f"      content-type: {kind}   {len(raw)} bytes")
                print(f"      first bytes : {raw[:120]!r}")
                continue
            boundary_layers = {k: v for k, v in layers.items()
                               if any(word in k.lower() for word in BOUNDARY_WORDS)}
            print(f"\n  {place} z{z} -> {z}/{x}/{y}  ({len(raw)} bytes, {kind})")
            print(f"      layers: {', '.join(sorted(layers)) or 'none'}")

            for layer_name, rows in sorted(boundary_layers.items()):
                print(f"      {layer_name}: {len(rows)} feature(s)")
                for row in rows:
                    for key in row:
                        seen_keys[key] += 1
                    if "claimed_by" in row:
                        claimed[str(row.get("claimed_by"))] += 1
                    if row.get("disputed") or row.get("claimed_by"):
                        if len(samples) < 25:
                            samples.append((place, z, layer_name, row))
                shown = rows[:4]
                for row in shown:
                    print(f"          {json.dumps(row, default=str, sort_keys=True)}")

    print("\n-- every property seen on a boundary feature --")
    for key, count in seen_keys.most_common():
        print(f"  {count:5d}  {key}")

    print("\n-- the field that decides the approach --")
    if "claimed_by" in seen_keys or "disputed" in seen_keys:
        print("  PRESENT. A viewer in India can be served India's claim line by")
        print("  restyling layers we already load. No provider change, no API key.")
        print(f"  claimed_by values: {dict(claimed) or 'none set on these tiles'}")
        for place, z, layer_name, row in samples:
            print(f"    {place} z{z} {layer_name}: {json.dumps(row, default=str, sort_keys=True)}")
    else:
        print("  ABSENT. These tiles carry no disputed/claimed_by field, so the only")
        print("  route is drawing our own line over the top — one depiction for all.")


def main():
    print("Reading our basemap's own bytes. Nothing is written.")
    for label, url in STYLES.items():
        style = report_style(label, url)
        report_tiles(style)


if __name__ == "__main__":
    main()
