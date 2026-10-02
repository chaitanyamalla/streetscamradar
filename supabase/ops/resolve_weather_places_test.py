#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Checks resolve_weather_places.py without the network.
#
# This file used to be twice as long, because the thing it tested tried to place
# each warning's AREA name and needed three rules to stop a geocoder answering
# with Brazil. The areas are weather zones rather than places — 28 of 30 could
# not be matched and fell back to the country anyway — so the country is the
# answer now and most of those rules have nothing left to guard.
#
# What survives is the one that still earns its place: MeteoAlarm is a European
# system, so a point outside Europe is wrong whatever the geocoder says. It is
# kept because it is what stopped Portugal being placed in Brazil, and a country
# lookup can go wrong the same way a zone lookup could.
#
# Run: python3 supabase/ops/resolve_weather_places_test.py
# ---------------------------------------------------------------------------
import io
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import resolve_weather_places as rw  # noqa: E402

results = []


def check(condition, label):
    results.append((bool(condition), label))


def answer(name, lat, lon):
    return {"name": name, "display_name": f"{name}, Somewhere",
            "lat": str(lat), "lon": str(lon)}


def stub(answers):
    rw.ask = lambda _params: (answers.pop(0) if answers else [])
    rw.time.sleep = lambda _s: None


# --- the country list has no second copy -----------------------------------
check(rw.country_name("ES") == "Spain", f"ES is Spain (got {rw.country_name('ES')})")
check(rw.country_name("GB") == "United Kingdom", "and GB is the United Kingdom")
check(rw.country_name("BA") == "Bosnia Herzegovina", "and BA reads as a name")
check(rw.country_name("ZZ") is None, "a country MeteoAlarm does not cover has no name here")
missing = [c for c in set(rw.fw.COUNTRIES.values()) if not rw.country_name(c)]
check(not missing, f"every country the fetcher mirrors has a name here ({missing})")

# --- placing a country -----------------------------------------------------
stub([[answer("Spain", 40.4, -3.7)]])
check(rw.resolve_country("ES") == (40.4, -3.7), "a country the geocoder knows is placed")

stub([[]])
check(rw.resolve_country("ES") is None,
      "a geocoder that answers nothing leaves the country unplaced")

# The rule that earns its keep. A country lookup can go wrong the same way a
# zone lookup could, and this is what stopped Portugal being put in Brazil.
stub([[answer("Portalegre", -6.03, -38.01)]])
check(rw.resolve_country("PT") is None,
      "an answer in Brazil is refused rather than written down as Portugal")
stub([[answer("Drenthe", 42.78, -85.94)]])
check(rw.resolve_country("NL") is None, "and one in Michigan is not the Netherlands")
stub([[answer("Nowhere", 10.0, 10.0), answer("Greece", 39.07, 21.82)]])
check(rw.resolve_country("GR") == (39.07, 21.82),
      "a wrong first answer does not stop the right second one")

# --- the Europe rectangle --------------------------------------------------
check(rw.in_europe(40.4, -3.7), "Madrid is in Europe")
check(rw.in_europe(28.1, -15.4), "and so are the Canaries, at 28°N")
check(rw.in_europe(37.7, -25.7), "and the Azores, at 25°W")
check(rw.in_europe(78.2, 15.6), "and Svalbard, at 78°N")
check(rw.in_europe(32.1, 34.8), "and Israel, which MeteoAlarm carries")
check(rw.in_europe(50.4, 30.5), "and Kyiv")
check(not rw.in_europe(-6.03, -38.01), "Brazil is not")
check(not rw.in_europe(42.78, -85.94), "nor is Michigan")
check(not rw.in_europe(35.7, 139.7), "nor Tokyo")

# --- the SQL ---------------------------------------------------------------
buffer = io.StringIO()
with redirect_stdout(buffer):
    rw.emit([{"country_code": "ES", "lat": 40.4, "lng": -3.7}])
sql = buffer.getvalue()
check(sql.startswith("begin;") and sql.rstrip().endswith(";"), "one transaction")
check("on conflict (country_code) do update" in sql,
      "a country already placed is updated rather than duplicated")
check("and w.lat is null" in sql,
      "a warning that came with its own polygon is left alone — the service "
      "knows better than a geocoder")
check("place_kind = 'country'" in sql,
      "and the warning records that it is on its country, so the popup can say so")

buffer = io.StringIO()
with redirect_stdout(buffer):
    rw.emit([])
empty = buffer.getvalue()
check("insert into public.weather_places" not in empty,
      "a run with nothing new to place writes no countries")
check("update public.weather_warnings" in empty,
      "but still places this morning's warnings on last week's countries, which "
      "is the ordinary case once Europe has been resolved once")

# --- the work list ---------------------------------------------------------
tmp = Path("/tmp/ssr-todo.txt")
tmp.write_text("ES\nES\n\nxx\nGR \n1\n", encoding="utf-8")
check(rw.todo_from(tmp) == ["ES", "XX", "GR"],
      f"the work list is de-duplicated, trimmed and upper-cased ({rw.todo_from(tmp)})")
tmp.unlink()

# --- report ----------------------------------------------------------------
failed = [label for ok, label in results if not ok]
for ok, label in results:
    print(("  ok    " if ok else "  FAIL  ") + label)
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
