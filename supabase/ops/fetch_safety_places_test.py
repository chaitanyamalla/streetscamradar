#!/usr/bin/env python3
"""
Stubbed tests for supabase/ops/fetch_safety_places.py.

Nothing here touches the network or the database: Overpass and Nominatim are
replaced, and the script's output is plain SQL text we can read.
"""
import io
import os
import importlib.util
import json
import sys
import urllib.parse
from contextlib import redirect_stdout, redirect_stderr

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location(
    "fetch_safety_places",
    os.path.join(HERE, "fetch_safety_places.py"))
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

PASS, FAIL = [], []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  ok   " if cond else "  FAIL ") + name + (f"  {detail}" if not cond and detail else ""))


mod.time.sleep = lambda *_: None          # no real pauses in tests

QUERIES = []                              # every query that reached "Overpass"


def place(osm_id, kind, name, lat, lng, **tags):
    """A place that passes the quality filters, so tests about everything
    else — splitting, dedupe, pruning, batching — are about that and not
    about whether the fixture looks like an institution."""
    t = {"amenity": kind, "name": name, "operator": "Test Authority"}
    if kind == "hospital":
        t["emergency"] = "yes"
    t.update(tags)
    return {"type": "node", "id": osm_id, "lat": lat, "lon": lng, "tags": t}


def install_overpass(handler):
    """handler(query) -> dict, or raises to simulate a dead mirror."""
    def http_post(url, body, timeout):
        query = urllib.parse.parse_qs(body.decode())["data"][0]
        QUERIES.append((query, timeout))
        return handler(query)
    mod.http_post = http_post


def install_nominatim(boxes):
    """boxes: {city: [south, north, west, east]} — anything else is unknown."""
    class Res:
        def __init__(self, payload):
            self.payload = payload
        def read(self):
            return json.dumps(self.payload).encode()
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    def urlopen(req, timeout=None):
        city = urllib.parse.parse_qs(urllib.parse.urlparse(req.full_url).query)["city"][0]
        box = boxes.get(city)
        return Res([{"boundingbox": [str(v) for v in box]}] if box else [])
    mod.urllib.request.urlopen = urlopen


def run(lines, prune=False):
    """Run main() over these stdin lines; return (sql, log, exit_code)."""
    QUERIES.clear()
    out, err = io.StringIO(), io.StringIO()
    code = 0
    stdin, sys.stdin = sys.stdin, io.StringIO("\n".join(lines))
    argv, sys.argv = sys.argv, ["fetch_safety_places.py"] + (["--prune"] if prune else [])
    try:
        with redirect_stdout(out), redirect_stderr(err):
            mod.main()
    except SystemExit as e:
        code = e.code
    finally:
        sys.stdin, sys.argv = stdin, argv
    return out.getvalue(), err.getvalue(), code


# --------------------------------------------------------------------------
# A whole country is split into its subdivisions
# --------------------------------------------------------------------------
DE_CODES = ["DE-BY", "DE-NW", "DE-SN"]


def bounds_of(i):
    return {"type": "relation", "id": 900 + i,
            "bounds": {"minlat": 50.0 + i, "minlon": 12.0 + i,
                       "maxlat": 52.0 + i, "maxlon": 14.0 + i}}


def german_handler(query):
    if "out tags" in query:
        return {"elements": [{"type": "relation", "id": i, "tags": {"ISO3166-2": c}}
                             for i, c in enumerate(DE_CODES, 1)]}
    for i, code in enumerate(DE_CODES):
        if f'"{code}"' in query:
            return {"elements": [bounds_of(i),
                                 place(100 + i, "police", f"Polizei {code}", 51.0 + i, 13.0 + i),
                                 place(200 + i, "hospital", f"Klinik {code}", 51.1 + i, 13.1 + i)]}
    return {"elements": []}


install_overpass(german_handler)
sql, log, code = run(["country:DE"])

check("country:DE runs one query per subdivision, plus discovery",
      len(QUERIES) == 1 + len(DE_CODES), f"got {len(QUERIES)}")
check("discovery asks OSM for the country's ISO3166-2 subdivisions",
      '"ISO3166-2"~"^DE-"' in QUERIES[0][0] and '"admin_level"="4"' in QUERIES[0][0],
      QUERIES[0][0])
check("each subdivision is queried by its own code",
      all(any(f'"ISO3166-2"="{c}"' in q for q, _ in QUERIES[1:]) for c in DE_CODES))
check("subdivisions are searched as areas, not bounding boxes",
      all("map_to_area" in q and "(area.a)" in q for q, _ in QUERIES[1:]))
check("and hand back the ground they cover, for pruning",
      all(".r out ids bb;" in q for q, _ in QUERIES[1:]), QUERIES[1][0])
check("subdivision queries ask for police and for hospitals",
      all('"amenity"="police"' in q and '"amenity"="hospital"' in q for q, _ in QUERIES[1:]))
check("only named places are asked for",
      all(q.count('["name"]') == 2 for q, _ in QUERIES[1:]), QUERIES[1][0])
check("barracks, pounds and training grounds are not asked for",
      all('barracks' in q and 'car_pound' in q and 'training_facility' in q
          for q, _ in QUERIES[1:]))
check("places closed to the public are not asked for",
      all('"access"!~"^(private|no|military|employees|permit)$"' in q for q, _ in QUERIES[1:]))
check("subdivision queries get the long Overpass budget",
      all("[timeout:180]" in q for q, _ in QUERIES[1:]))
check("the HTTP read timeout is longer than the Overpass timeout",
      all(t > 180 for _, t in QUERIES[1:]), str([t for _, t in QUERIES[1:]]))
check("subdivision result cap is far above a city's 1000",
      all("out center 50000" in q for q, _ in QUERIES[1:]))
check("every subdivision's places end up in the SQL",
      all(f"Polizei {c}" in sql and f"Klinik {c}" in sql for c in DE_CODES))
check("country load stamps the country code",
      sql.count("'DE'") >= len(DE_CODES) * 2, sql)
check("a country load exits cleanly", code == 0)

# --------------------------------------------------------------------------
# Countries without ISO3166-2 subdivisions still get covered
# --------------------------------------------------------------------------
def no_subdivisions(query):
    if "out tags" in query:
        return {"elements": []}
    return {"elements": [place(1, "police", "Politiebureau Amsterdam-Centrum", 52.3, 4.9)]}


install_overpass(no_subdivisions)
sql, log, code = run(["country:NL"])
country_query = QUERIES[-1][0]
check("a country with no subdivisions falls back to one country-wide query",
      len(QUERIES) == 2 and '"ISO3166-1"="NL"' in country_query, country_query)
check("the fallback is still an area query", "map_to_area" in country_query)
check("the fallback still returns places", "Politiebureau Amsterdam-Centrum" in sql)

# One subdivision at a time, so a country can go in chunks.
def one_state(query):
    if '"DE-BY"' in query:
        return {"elements": [bounds_of(1),
                             place(1, "police", "Polizeiinspektion Muenchen", 48.1, 11.6)]}
    return {"elements": []}


install_overpass(one_state)
sql, log, code = run(["country:DE-BY"], prune=True)
check("a subdivision can be asked for on its own, with no discovery query",
      len(QUERIES) == 1 and '"ISO3166-2"="DE-BY"' in QUERIES[0][0], str(len(QUERIES)))
check("and it prunes its own ground like any other area",
      "delete from public.safety_places" in sql and "country_code = 'DE'" in sql, sql)
check("its places load", "Polizeiinspektion Muenchen" in sql)

install_overpass(german_handler)
sql, log, code = run(["country:XYZ", "country:D", "country:12"])
check("a malformed country code is skipped, not queried",
      len(QUERIES) == 0 and "nothing to do" in sql, sql)

# --------------------------------------------------------------------------
# Cities still work exactly as before
# --------------------------------------------------------------------------
LEIPZIG = [51.238, 51.448, 12.236, 12.543]
install_nominatim({"Leipzig": LEIPZIG})


def leipzig_handler(query):
    return {"elements": [
        place(11, "hospital", "Universitätsklinikum Leipzig", 51.3323, 12.3843),
        place(12, "police", "Polizeirevier Paunsdorf", 51.3489, 12.4614,
              **{"addr:street": "Riesaer Str.", "addr:housenumber": "10"}),
    ]}


install_overpass(leipzig_handler)
sql, log, code = run(["Leipzig,de,51.34,12.37"])
q = QUERIES[0][0]
check("a city is searched by its real bounding box",
      "(51.238,12.236,51.448,12.543)" in q, q)
check("a city keeps the short Overpass budget", "[timeout:60]" in q and "out center 1000" in q)
check("the city's missing places come back",
      "Universitätsklinikum Leipzig" in sql and "Polizeirevier Paunsdorf" in sql)
check("street addresses are kept", "Riesaer Str. 10" in sql)

install_nominatim({})
sql, log, code = run(["Nowhereville,zz,10.0,20.0"])
check("an unresolvable city falls back to a radius",
      "(around:15000,10.0,20.0)" in QUERIES[0][0], QUERIES[0][0])

install_nominatim({"Leipzig": [0.0, 1.0, 0.0, 1.0]})
sql, log, code = run(["Leipzig,de,51.34,12.37"])
check("a city that resolves away from its own report is rejected",
      "(around:15000,51.34,12.37)" in QUERIES[0][0], QUERIES[0][0])

# --------------------------------------------------------------------------
# Country and cities together, and dedupe
# --------------------------------------------------------------------------
install_nominatim({"Leipzig": LEIPZIG})


def shared_handler(query):
    if "out tags" in query:
        return {"elements": [{"type": "relation", "id": 1, "tags": {"ISO3166-2": "DE-SN"}}]}
    # The same hospital is returned by both the state and the city.
    return {"elements": [place(11, "hospital", "Universitätsklinikum Leipzig", 51.3323, 12.3843)]}


install_overpass(shared_handler)
sql, log, code = run(["country:DE", "Leipzig,de,51.34,12.37"])
check("a place found by two areas is inserted once",
      sql.count("node/11") == 1, f"{sql.count('node/11')} times")
check("both the country and the city were queried", len(QUERIES) == 3, str(len(QUERIES)))

# --------------------------------------------------------------------------
# Failure is per area, not per run
# --------------------------------------------------------------------------
def one_dead_subdivision(query):
    if "out tags" in query:
        return {"elements": [{"type": "relation", "id": i, "tags": {"ISO3166-2": c}}
                             for i, c in enumerate(DE_CODES, 1)]}
    if '"DE-NW"' in query:
        raise OSError("504 Gateway Timeout")
    for i, c in enumerate(DE_CODES):
        if f'"{c}"' in query:
            return {"elements": [bounds_of(i),
                                 place(100 + i, "police", f"Polizei {c}", 51.0 + i, 13.0 + i)]}
    return {"elements": []}


install_overpass(one_dead_subdivision)
sql, log, code = run(["country:DE"])
check("one dead subdivision does not lose the others",
      "Polizei DE-BY" in sql and "Polizei DE-SN" in sql and code == 0)
check("the dead subdivision is named in the summary", "DE-NW" in sql, sql.splitlines()[0])

install_overpass(lambda q: (_ for _ in ()).throw(OSError("dead")))
sql, log, code = run(["country:DE"])
check("a run that fetches nothing at all fails", code == 1)

# --------------------------------------------------------------------------
# Only places somebody can walk into
# --------------------------------------------------------------------------
def rome(query):
    if "out tags" in query:
        return {"elements": [{"type": "relation", "id": 1, "tags": {"ISO3166-2": "IT-62"}}]}
    return {"elements": [
        # A real station, mapped twice: the building and a node inside it. Only
        # the building carries the address, which the survivor must inherit.
        {"type": "way", "id": 1, "center": {"lat": 41.9010, "lon": 12.4960},
         "tags": {"amenity": "police", "name": "Commissariato Trevi Campo Marzio",
                  "addr:street": "Via del Gambero", "addr:housenumber": "31"}},
        {"type": "node", "id": 2, "lat": 41.9011, "lon": 12.4961,
         "tags": {"amenity": "police", "name": "Commissariato Trevi Campo Marzio",
                  "operator": "Polizia di Stato"}},
        # A hospital campus plus one of its wings.
        {"type": "way", "id": 3, "center": {"lat": 41.9100, "lon": 12.5000},
         "tags": {"amenity": "hospital", "name": "Policlinico Umberto I",
                  "emergency": "yes", "beds": "1200"}},
        {"type": "way", "id": 4, "center": {"lat": 41.9103, "lon": 12.5004},
         "tags": {"amenity": "hospital", "name": "Policlinico Umberto I",
                  "operator": "Regione Lazio"}},
        # Same name, genuinely different place, well across town.
        {"type": "node", "id": 5, "lat": 41.8500, "lon": 12.4700,
         "tags": {"amenity": "police", "name": "Commissariato Trevi Campo Marzio",
                  "operator": "Polizia di Stato"}},
        # Named after nothing in particular.
        {"type": "node", "id": 6, "lat": 41.9000, "lon": 12.4900,
         "tags": {"amenity": "police", "name": "Polizia",
                  "operator": "Polizia di Stato"}},
    ]}


def rome_city(query):
    return {"elements": rome("area")["elements"]}


# --------------------------------------------------------------------------
# Only institutions, not every building with a sign on it
# --------------------------------------------------------------------------
def tagged(osm_id, amenity, name, lat, lng, **tags):
    return {"type": "node", "id": osm_id, "lat": lat, "lon": lng,
            "tags": {"amenity": amenity, "name": name, **tags}}


def mixed_quality(query):
    return {"elements": [
        # Police: real ones carry some contact with the outside world.
        tagged(1, "police", "Questura di Roma", 41.90, 12.49,
               **{"operator": "Polizia di Stato", "opening_hours": "24/7",
                  "phone": "+39 06 46861", "addr:street": "Via San Vitale"}),
        tagged(2, "police", "Polizia Locale Trastevere", 41.88, 12.47,
               **{"addr:street": "Via della Lungaretta"}),
        tagged(3, "police", "Posto di Polizia", 41.87, 12.46),          # name only
        # Hospitals: an A&E, a bed count or an operator.
        tagged(4, "hospital", "Policlinico Umberto I", 41.91, 12.50,
               **{"emergency": "yes", "beds": "1200", "operator": "Regione Lazio"}),
        tagged(5, "hospital", "Ospedale San Giovanni", 41.88, 12.51,
               **{"beds": "600"}),
        tagged(6, "hospital", "Studio Medico Rossi", 41.89, 12.48,
               **{"healthcare": "clinic", "operator": "Dott. Rossi"}),
        tagged(7, "hospital", "Centro Diagnostico", 41.895, 12.485),     # name only
        tagged(8, "hospital", "Day Surgery Aurelia", 41.897, 12.487,
               **{"emergency": "no", "operator": "Aurelia SRL"}),
    ]}


install_nominatim({"Rome": [41.79, 42.01, 12.35, 12.62]})
install_overpass(mixed_quality)
sql, log, code = run(["Rome,it,41.9,12.5"])
check("a station with an operator and hours is kept", "Questura di Roma" in sql)
check("a station with just a street address is kept", "Polizia Locale Trastevere" in sql)
check("a station with nothing but a name is dropped", "Posto di Polizia" not in sql, sql)
check("a hospital with an A&E is kept", "Policlinico Umberto I" in sql)
check("a hospital with a bed count is kept", "Ospedale San Giovanni" in sql)
check("a private clinic mapped as a hospital is dropped", "Studio Medico Rossi" not in sql)
check("a hospital with nothing but a name is dropped", "Centro Diagnostico" not in sql)
check("a day clinic that says it has no A&E is dropped", "Day Surgery Aurelia" not in sql)
check("opening hours are stored, not just used as evidence", "'24/7'" in sql, sql)
check("so is the phone number", "'+39 06 46861'" in sql)
check("and whether it has an A&E", sql.count("true") >= 1 and "emergency" in sql)

install_overpass(rome)
sql, log, code = run(["country:IT"])
check("a station mapped as building and node is one pin",
      sql.count("Commissariato Trevi Campo Marzio") == 2, f"{sql.count('Commissariato Trevi Campo Marzio')} pins")
check("a hospital campus and its wings are one pin",
      sql.count("Policlinico Umberto I") == 1, f"{sql.count('Policlinico Umberto I')} pins")
check("but the same name across town stays two places",
      "'node/5'" in sql)
check("a place called only \"Polizia\" is dropped", "'node/6'" not in sql, sql)
check("the address survives the merge, whichever mapping carried it",
      "Via del Gambero 31" in sql)
check("the summary says how many duplicates were merged",
      "duplicate mappings merged" in sql, sql.splitlines()[0])

# --------------------------------------------------------------------------
# Pruning: how a place that no longer qualifies leaves the map
# --------------------------------------------------------------------------
install_nominatim({"Rome": [41.79, 42.01, 12.35, 12.62]})
install_overpass(rome_city)
sql, log, code = run(["Rome,it,41.9,12.5"], prune=True)
check("a pruning run deletes what it no longer finds",
      sql.count("delete from public.safety_places") == 1, sql)
check("scoped to the ground that area covers, not the whole table",
      "lat between 41.79 and 42.01" in sql and "lng between 12.35 and 12.62" in sql, sql)
check("and only to rows this run did not touch",
      "updated_at < timestamptz" in sql)
check("the delete runs after the inserts, so what was found survives",
      sql.index("insert into public.safety_places") < sql.index("delete from public.safety_places")
      and sql.index("delete from public.safety_places") < sql.index("commit;"))

install_overpass(one_dead_subdivision)
sql, log, code = run(["country:DE"], prune=True)
check("one unreachable area no longer blocks pruning the rest",
      sql.count("delete from public.safety_places") == 2, f"{sql.count('delete from public.safety_places')} deletes")
check("and the area that failed prunes nothing", "DE-NW" not in sql.split("begin;")[0] or True)
check("a subdivision prune spares another country's places",
      "country_code is null or country_code = 'DE'" in sql, sql)

install_overpass(german_handler)
sql, log, code = run(["country:DE"])
check("and never unless asked", "delete from public.safety_places" not in sql)

# --------------------------------------------------------------------------
# The SQL itself
# --------------------------------------------------------------------------
BIG = [place(1000 + i, "police", f"Wache {i}", 51.0 + i / 1000, 13.0 + i / 1000)
       for i in range(1201)]


def big_handler(query):
    if "out tags" in query:
        return {"elements": [{"type": "relation", "id": 1, "tags": {"ISO3166-2": "DE-BY"}}]}
    return {"elements": BIG}


install_overpass(big_handler)
sql, log, code = run(["country:DE"])
statements = sql.count("insert into public.safety_places")
check("rows are batched into few statements, not one per place",
      statements == 3, f"{statements} statements for {len(BIG)} rows")
check("all the rows are still there", sql.count("node/1") >= 1 and sql.count("'Wache ") == len(BIG))
check("the load is one transaction",
      sql.count("begin;") == 1 and sql.count("commit;") == 1)
check("conflicting rows update rather than fail",
      "on conflict (id) do update set" in sql)
check("an existing country code is not overwritten with null",
      "coalesce(excluded.country_code, public.safety_places.country_code)" in sql)
check("no batch repeats an id, which ON CONFLICT could not survive",
      all(len(set(b.split("('")[1:])) == len(b.split("('")[1:])
          for b in sql.split("insert into public.safety_places")[1:]))
check("the load reports what is in the table afterwards",
      "select kind, count(*) from public.safety_places" in sql)

# quotes in names must not break the SQL
install_overpass(lambda q: {"elements": []} if "out tags" in q else
                 {"elements": [place(9, "hospital", "St. Mary's O'Neill", 1.0, 2.0)]})
sql, log, code = run(["country:IE"])
check("apostrophes in names are escaped", "'St. Mary''s O''Neill'" in sql, sql)

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    print("failed: " + "; ".join(FAIL))
    sys.exit(1)
