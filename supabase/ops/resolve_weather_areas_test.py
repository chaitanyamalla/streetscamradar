#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Checks resolve_weather_areas.py without the network.
#
# The cases are not invented. Every rejection below is something a geocoder
# really answered when thirty live MeteoAlarm area names were put to it with no
# constraints — Portugal's Guarda in Italy, Portalegre in Brazil, Drenthe in
# Michigan, "Fleseland" for Flevoland. Those six are the reason this file's
# three rules exist, so they are the six it is tested against.
#
# A marker in the wrong valley is worse than no marker, so what is being
# asserted throughout is the REFUSAL, not the match.
#
# Run: python3 supabase/ops/resolve_weather_areas_test.py
# ---------------------------------------------------------------------------
import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import resolve_weather_areas as rw  # noqa: E402

results = []


def check(condition, label):
    results.append((bool(condition), label))


def answer(name, lat, lon, box=None):
    """One Nominatim result, in the shape jsonv2 sends."""
    entry = {"name": name, "display_name": f"{name}, Somewhere",
             "lat": str(lat), "lon": str(lon)}
    if box:
        entry["boundingbox"] = [str(v) for v in box]
    return entry


def stub(answers):
    """Make the geocoder say exactly this, with no network anywhere."""
    calls = []

    def fake(params):
        calls.append(params)
        return answers.pop(0) if answers else []
    rw.ask = fake
    rw.time.sleep = lambda _s: None
    return calls


PORTUGAL = {"lat": 39.6, "lng": -8.0,
            "box": {"minLat": 36.9, "maxLat": 42.2, "minLng": -9.6, "maxLng": -6.2}}
NETHERLANDS = {"lat": 52.2, "lng": 5.5,
               "box": {"minLat": 50.7, "maxLat": 53.7, "minLng": 3.3, "maxLng": 7.3}}

# --- normalising a name ----------------------------------------------------
check(rw.plain("Évora") == rw.plain("evora"), "accents and case do not make two names")
check(rw.plain("Noord-Brabant") == rw.plain("noord brabant"), "nor does a hyphen")
check(rw.plain("Évora") != rw.plain("Évora de Alcobaça"),
      "but a longer name IS a different place, which is the whole point")
check(rw.plain(None) == "", "and nothing is nothing, not a crash")

# --- the six that went wrong in the wild -----------------------------------
# Each one is the real answer the geocoder gave, and each must now be refused.
WILD = [
    ("Guarda", "PT", PORTUGAL, answer("Guarda", 44.97, 11.81), "Italy"),
    ("Portalegre", "PT", PORTUGAL, answer("Portalegre", -6.03, -38.01), "Brazil"),
    ("Beja", "PT", PORTUGAL, answer("Bejan", 45.93, 22.85), "Romania, and misspelt"),
    ("Limburg", "NL", NETHERLANDS, answer("Limburg", 48.03, 12.18), "Germany"),
    ("Drenthe", "NL", NETHERLANDS, answer("Drenthe", 42.78, -85.94), "Michigan"),
    ("Flevoland", "NL", NETHERLANDS, answer("Fleseland", 58.10, 7.15), "Norway, and misspelt"),
]
for area, code, country, bad, where in WILD:
    stub([[bad]])
    lat, lng, matched = rw.resolve_area(code, area, country)
    check(matched == "country",
          f"{area} is not placed in {where} — it falls back to the country")
    check((lat, lng) == (country["lat"], country["lng"]),
          f"and lands on {code} itself, where it is honest about being")

# The near-miss inside the right country, which no bounding box can catch.
stub([[answer("Évora de Alcobaça", 39.52, -8.97)]])
_lat, _lng, matched = rw.resolve_area("PT", "Évora", PORTUGAL)
check(matched == "country",
      "a name that merely STARTS with the one asked for is a different place")

# --- and the ones that should work ----------------------------------------
stub([[answer("Drenthe", 52.86, 6.62)]])
lat, lng, matched = rw.resolve_area("NL", "Drenthe", NETHERLANDS)
check(matched == "area" and abs(lat - 52.86) < 0.01,
      f"the real Drenthe, in the Netherlands, is placed ({lat}, {lng})")

stub([[answer("evora", 38.57, -7.91)]])
_lat, _lng, matched = rw.resolve_area("PT", "Évora", PORTUGAL)
check(matched == "area", "and a match differing only in accents is still a match")

# The geocoder offering rubbish first and the right answer second.
stub([[answer("Elsewhere", 10.0, 10.0), answer("Drenthe", 52.86, 6.62)]])
_lat, _lng, matched = rw.resolve_area("NL", "Drenthe", NETHERLANDS)
check(matched == "area", "a wrong first answer does not stop the right second one")

# --- the Europe backstop ---------------------------------------------------
check(rw.in_box(40.4, -3.7, rw.EUROPE), "Madrid is in Europe")
check(rw.in_box(28.1, -15.4, rw.EUROPE), "and so are the Canaries, at 28°N")
check(rw.in_box(37.7, -25.7, rw.EUROPE), "and the Azores, at 25°W")
check(rw.in_box(78.2, 15.6, rw.EUROPE), "and Svalbard, at 78°N")
check(rw.in_box(32.1, 34.8, rw.EUROPE), "and Israel, which MeteoAlarm carries")
check(rw.in_box(50.4, 30.5, rw.EUROPE), "and Kyiv")
check(not rw.in_box(-6.03, -38.01, rw.EUROPE), "Brazil is not")
check(not rw.in_box(42.78, -85.94, rw.EUROPE), "nor is Michigan")
check(not rw.in_box(35.7, 139.7, rw.EUROPE), "nor Tokyo")

# Even with the country check disabled, Europe alone catches the worst of them.
stub([[answer("Portalegre", -6.03, -38.01)]])
_lat, _lng, matched = rw.resolve_area("PT", "Portalegre", None)
check(matched is None,
      "with no country to fall back on, Brazil is refused rather than accepted")

# --- the country list has no second copy -----------------------------------
check(rw.country_name("ES") == "Spain", f"ES is Spain (got {rw.country_name('ES')})")
check(rw.country_name("GB") == "United Kingdom", "and GB is the United Kingdom")
check(rw.country_name("BA") == "Bosnia Herzegovina", "and BA reads as a name")
check(rw.country_name("ZZ") is None, "a country MeteoAlarm does not cover has no name here")
missing = [c for c in set(rw.fw.COUNTRIES.values()) if not rw.country_name(c)]
check(not missing, f"every country the fetcher mirrors has a name here ({missing})")

# --- a country we cannot place at all --------------------------------------
stub([[]])
check(rw.resolve_country("ES") is None,
      "a geocoder that answers nothing for a country gives no country row")
stub([[answer("Somewhere", 10.0, 10.0, [5, 15, 5, 15])]])
check(rw.resolve_country("ES") is None,
      "and an answer outside Europe is not written down as Spain")
stub([[answer("Spain", 40.4, -3.7, [27.6, 43.8, -18.2, 4.3])]])
spain = rw.resolve_country("ES")
check(spain and spain["box"] and spain["box"]["minLat"] == 27.6,
      "a real answer brings the country's box with it, for the check above")

# --- the SQL ---------------------------------------------------------------
buffer = io.StringIO()
with redirect_stdout(buffer):
    rw.emit([{"country_code": "ES", "area_name": "Litoral de Barcelona",
              "lat": 41.4, "lng": 2.2, "matched": "area"}])
sql = buffer.getvalue()
check(sql.startswith("begin;") and sql.rstrip().endswith(";"), "one transaction")
check("on conflict (country_code, area_name) do update" in sql,
      "a name already looked up is updated rather than duplicated")
check("Litoral de Barcelona" in sql, "the name is written down with its point")
check("and w.lat is null" in sql,
      "and a warning that came with its own polygon is left alone — the service "
      "knows better than a geocoder")
check("place_kind = a.matched" in sql,
      "the warning records whether it is on its area or only on its country")

buffer = io.StringIO()
with redirect_stdout(buffer):
    rw.emit([])
empty = buffer.getvalue()
check("insert into public.weather_areas" not in empty,
      "a run with nothing new to look up writes no names")
check("update public.weather_warnings" in empty,
      "but still places this morning's warnings on last week's names, which is "
      "the ordinary case once Europe has been resolved once")

buffer = io.StringIO()
with redirect_stdout(buffer):
    rw.emit([{"country_code": "PT", "area_name": "O'Bidos", "lat": 1, "lng": 2,
              "matched": "area"}])
check("O''Bidos" in buffer.getvalue(), "an apostrophe in a place name is escaped")

# --- the work list ---------------------------------------------------------
tmp = Path("/tmp/ssr-todo.tsv")
tmp.write_text("ES\tLitoral de Barcelona\nES\tLitoral de Barcelona\n"
               "\tnothing\nXX\n PT \t Guarda \n", encoding="utf-8")
todo = rw.todo_from(tmp)
check(todo == [("ES", "Litoral de Barcelona"), ("PT", "Guarda")],
      f"the work list is de-duplicated and trimmed, and junk lines are dropped ({todo})")
tmp.unlink()

# --- report ----------------------------------------------------------------
failed = [label for ok, label in results if not ok]
for ok, label in results:
    print(("  ok    " if ok else "  FAIL  ") + label)
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
