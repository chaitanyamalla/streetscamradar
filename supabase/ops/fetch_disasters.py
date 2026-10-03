#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Refresh public.disaster_alerts from GDACS.
#
#   https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP
#   https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH
#
# BOTH, because neither is a superset of the other and we found that out the
# hard way: an orange flood in India was on gdacs.org's own map and not on
# ours. EVENTS4APP does not carry it. On one ordinary afternoon:
#
#          EVENTS4APP      SEARCH
#   EQ             19          24
#   TC              7          18
#   FL              2          21     <- the India flood is in here
#   WF             72          15
#   DR              0           7
#   VO              0           6
#
# So EVENTS4APP is where the wildfires are and SEARCH is where everything else
# is; taking either one alone loses most of something. They are merged by
# event, keeping whichever copy GDACS updated last.
#
# What is kept
# ------------
# Orange and Red. Not Green, for any kind. And five kinds, not six: no drought.
#
# GDACS's droughts come from the Copernicus Global Drought Observatory and are
# agricultural — "Medium impact for agricultural drought in 677277 km2", read
# off soil moisture. Worth publishing, and not something a traveller can act
# on: nobody changes a trip to Vienna because Central European soil moisture is
# low. They also dwarfed everything else, because one drought is one event
# across every country it touches — 48 of the 51 rows in the table on the day
# they were removed, against two floods and one cyclone.
#
# Green has been in and out of here twice, so it is worth writing down why it
# is out. It is most of what GDACS publishes — 77 Green wildfires on the day
# this was written, against four Orange floods and one Red cyclone — and it
# means "this happened and nobody was affected". Carrying it and drawing it
# grey put seventy-odd markers on the map that no traveller needed and that
# GDACS's own public map does not show, which is how we ended up with a screen
# full of Australian bushfires while gdacs.org showed a handful in Africa.
#
# The earthquake exception went with it. It kept a Green quake of magnitude 6
# or more, on the argument that one makes the news wherever it happens. But
# GDACS grades by human impact, so a Green magnitude 7 is one that shook an
# empty stretch of ocean — which is exactly the kind of thing this rule now
# says we do not carry. If that turns out to be wrong, it is four lines to put
# back; the constant was called BIG_QUAKE.
#
# One row per event per country. GDACS names every country an event touches,
# and "is anything happening where I am going" is a question about a country,
# not about an event.
#
# What leaves, and when
# ---------------------
# Whatever GDACS stops listing. It decides when a flood is over; we should not
# second-guess that with a timer of our own, so anything absent from a run is
# deleted at the end of it.
#
# And anything it has not touched in a week. The probe says GDACS keeps its
# list current — all hundred events had been updated within two days — so this
# is a guard against a feed that goes quiet rather than a filter that fires on
# an ordinary day. It is deliberately a cut on the LAST UPDATE and not on when
# the event started: a cyclone GDACS has been tracking for fifteen days and
# updated an hour ago is a storm that is still happening, and dropping it for
# being old would be exactly wrong. For an earthquake the two dates are the
# same instant, so there the week is a real window.
#
# `iscurrent`, and the three kinds it does not fit
# -----------------------------------------------
# GDACS sets iscurrent=false when a situation has finished. For a flood, a
# storm or a fire that is a real judgement by the agency running the alert,
# and it is theirs to make. For the other three kinds it is a category error:
#
#   earthquake   the shaking lasts a minute
#   volcano      an eruption is recorded at a single instant too
#
# For all three the flag goes false while the thing is still worth knowing
# about, and obeying it did not thin those kinds out — it removed them
# entirely. A probe that runs these rules over the live list, one event at a
# time, found NOT ONE survivor of either of them:
#
#         in the list   kept   dropped for iscurrent
#   EQ             45      0                      24
#   VO              6      0                       6
#
# That is why the volcano row read "None in view" everywhere from the day it
# was added. So for these two the date is the whole of the question, and the
# week's cut below asks it — which is strict enough on its own: the newest
# volcano in the list erupted 26 days ago and still does not get in.
#
# Drought was the third, and it is not carried at all any more — see below.
#
# Refusing to write rubbish
# -------------------------
# An empty or unparseable response would, taken literally, mean nothing is
# happening anywhere on Earth — and would clear the table. That is a bad day at
# GDACS, not a calm day on the planet, so it writes nothing and the previous
# rows stay up.
#
# Usage:
#   python3 fetch_disasters.py > disasters.sql
#   python3 fetch_disasters.py --file sample.json > disasters.sql
# ---------------------------------------------------------------------------
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

SOURCE = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP"
SOURCES = (SOURCE, "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH")
TIMEOUT = 45
RETRIES = 3
INSERT_BATCH = 200

# GDACS event types, as its `eventtype` field spells them.
# The kinds we draw. GDACS also publishes DR, drought, which is deliberately
# absent: see the header. An eventtype not in here falls out below.
KINDS = {
    "EQ": "earthquake", "TC": "cyclone", "FL": "flood",
    "VO": "volcano", "WF": "wildfire",
}

# The two grades we carry. GDACS publishes a third, Green, and Green is most of
# what it publishes: on an ordinary day the list is 77 Green wildfires, a Green
# flood or two, a dozen Green earthquakes nobody felt, and a handful of Orange
# and Red. Green is GDACS saying "this happened and nobody was affected", which
# is a fine thing for a monitoring agency to record and not something to put in
# front of somebody planning a trip. Anything Green falls through the lookup
# below and is dropped.
SEVERITY = {"Red": "severe", "Orange": "notice"}

# How long since GDACS last touched an event before we stop believing it.
MAX_QUIET_DAYS = 7

# The kinds whose `iscurrent` flag we obey — see the header. A flood, a storm
# and a fire each have a real end, and when the agency says one has reached it,
# that is the agency's call to make and not ours. The two that are left, an
# earthquake and an eruption, are instants and are judged on their date.
RUNNING_MEANS_SOMETHING = frozenset({"flood", "cyclone", "wildfire"})

# The feed carries a hundred events on an ordinary day, most of them Green and
# so most of them dropped. This floor is on what GDACS SENT, not on what we
# keep, because a quiet week is a real thing and an empty response is not: the
# latter is a broken response rather than a quiet planet, and must not be
# allowed to empty the table.
MIN_PLAUSIBLE_EVENTS = 20

NOT_AN_EVENT = {"contentList"}


class SourceProblem(Exception):
    """The source answered, but not with something worth writing down."""


def http_get(url, timeout=TIMEOUT):
    request = urllib.request.Request(url, headers={
        "User-Agent": "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8")


def fetch(url=SOURCE, retries=RETRIES):
    for attempt in range(1, retries + 1):
        try:
            return json.loads(http_get(url))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as err:
            print(f"--   attempt {attempt}/{retries} failed: {err}", file=sys.stderr)
            if attempt < retries:
                time.sleep(2 ** attempt)
    return None


def as_timestamp(value):
    """GDACS sends ISO strings with no zone. They are UTC; say so explicitly
    rather than let Postgres guess from the server's timezone."""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).isoformat()


def countries_of(props):
    """Every two-letter country code an event touches.

    affectedcountries arrives as a Python-repr string — single quotes — rather
    than JSON, so it is converted before parsing rather than trusted to load.
    """
    codes = []
    affected = props.get("affectedcountries")
    if isinstance(affected, str):
        try:
            affected = json.loads(affected.replace("'", '"'))
        except json.JSONDecodeError:
            affected = None
    for entry in affected if isinstance(affected, list) else []:
        code = str((entry or {}).get("iso2") or "").strip().upper()
        if len(code) == 2 and code.isalpha() and code not in codes:
            codes.append(code)
    return codes


def severity_numbers(props):
    """GDACS's measurement: its own words, and the two numbers worth having.

    severitydata arrives as a Python-repr string like
    {'severity': 5.0, 'severitytext': 'Magnitude 5M, Depth:157.801km', ...}
    — single quotes, so it is converted before parsing rather than trusted to
    load. `severity` means something different per kind (magnitude for a quake,
    km/h for a cyclone, hectares for a fire), so it is only read as a magnitude
    when the unit says M.
    """
    raw = props.get("severitydata")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw.replace("'", '"'))
        except json.JSONDecodeError:
            raw = None
    if not isinstance(raw, dict):
        return None, None, None

    magnitude = None
    if str(raw.get("severityunit") or "").strip().upper() == "M":
        try:
            magnitude = round(float(raw.get("severity")), 1)
        except (TypeError, ValueError):
            magnitude = None

    text = str(raw.get("severitytext") or "").strip()

    depth = None
    match = re.search(r"Depth:\s*([0-9.]+)\s*km", text)
    if match:
        try:
            depth = round(float(match.group(1)), 1)
        except ValueError:
            depth = None

    # The words themselves, kept. They are the only line in a popup that is a
    # measurement of the event rather than a sentence of ours about the map, and
    # what they say differs by kind in a way no wording of ours could cover.
    # Empty for the kinds GDACS does not measure, and that is fine: the popup
    # then has one line fewer rather than a line saying nothing.
    return magnitude, depth, measure_line(raw, text)


LEVEL_WORDS = ("green", "orange", "red")


def measure_line(raw, text):
    """GDACS's measurement as one popup line, or nothing.

    Not every kind measures itself the same way, and two of them send something
    that should not reach a reader. Asked of the live list rather than guessed
    (tools/probe_gdacs.py), each kind sends:

      cyclone     'Hurricane/Typhoon > 74 mph (maximum wind speed of 194 km/h)'
      earthquake  'Magnitude 5M, Depth:10km'
      wildfire    'Green impact for forestfire in 5027 ha'
      flood       'Magnitude 0 '

    The first two are exactly what a popup wants. The fire buries a real number
    behind GDACS's own alert word, which the popup already states a line above —
    so the number and its unit are used instead of the sentence. The flood
    measures nothing at all, and a line reading "Magnitude 0" is worse than no
    line.
    """
    try:
        value = float(raw.get("severity"))
    except (TypeError, ValueError):
        value = None
    unit = str(raw.get("severityunit") or "").strip()

    if not value and not unit:
        return None
    if re.fullmatch(r"magnitude\s*0+(\.0+)?\s*", text.lower()):
        return None

    if text.lower().startswith(LEVEL_WORDS):
        if value is None or not unit:
            return None
        return "{:,.0f} {}".format(value, unit)

    return text[:160] or None


def point_of(feature):
    """Where GDACS puts the event, when it gives something usable.

    Stored, but only drawn for volcanoes. A volcano IS this point; a flood or a
    cyclone is a centroid of everything affected, and "Flood in Guinea" lands
    400 km from the water. Keeping the number and choosing not to draw it beats
    throwing it away and being unable to draw the one kind it fits.
    """
    coordinates = ((feature or {}).get("geometry") or {}).get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        return None, None
    try:
        lng, lat = float(coordinates[0]), float(coordinates[1])
    except (TypeError, ValueError):
        return None, None
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        return None, None
    return lat, lng


def is_stale(to_date, now=None):
    """Has GDACS left this alone for longer than we will vouch for?

    A missing date is not stale: it means GDACS told us nothing, which is not
    the same as telling us the event is old.
    """
    if not to_date:
        return False
    try:
        stamp = datetime.fromisoformat(str(to_date))
    except ValueError:
        return False
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp < (now or datetime.now(timezone.utc)) - timedelta(days=MAX_QUIET_DAYS)


def merge(payloads):
    """One feature per event, from however many lists we were given.

    Keyed on (eventtype, eventid) and NOT on the episode: the same flood
    reaches both endpoints, sometimes at different episodes, and keying on the
    episode would put the same flood on the map twice. The copy GDACS updated
    most recently wins.
    """
    def updated(feature):
        stamp = as_timestamp(((feature or {}).get("properties") or {}).get("todate"))
        return stamp or ""

    best = {}
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        for feature in payload.get("features") or []:
            props = (feature or {}).get("properties")
            if not isinstance(props, dict):
                continue
            key = (str(props.get("eventtype") or "?").strip().upper(),
                   str(props.get("eventid") or "?").strip())
            if key not in best or updated(feature) > updated(best[key]):
                best[key] = feature
    return {"type": "FeatureCollection", "features": list(best.values())}


def rows_from(payload, now=None):
    """Every (event, country) row worth storing."""
    if not isinstance(payload, dict):
        raise SourceProblem("payload is not a JSON object")
    features = payload.get("features")
    if not isinstance(features, list):
        raise SourceProblem("no 'features' array — the interface answers {} when it is down")
    if len(features) < MIN_PLAUSIBLE_EVENTS:
        raise SourceProblem(
            f"only {len(features)} events came back, expected at least "
            f"{MIN_PLAUSIBLE_EVENTS} — refusing to overwrite the table")

    rows = {}
    shape_reported = False
    for feature in features:
        props = (feature or {}).get("properties")
        if not isinstance(props, dict):
            continue
        if not shape_reported:
            print(f"-- fields in an event: [{', '.join(sorted(props))}]", file=sys.stderr)
            shape_reported = True

        severity = SEVERITY.get(str(props.get("alertlevel") or "").strip())
        if not severity:
            continue
        kind = KINDS.get(str(props.get("eventtype") or "").strip().upper())
        if not kind:
            continue
        # See RUNNING_MEANS_SOMETHING and the header: obeyed for the three
        # kinds that can actually finish, ignored for the three that cannot.
        if kind in RUNNING_MEANS_SOMETHING \
                and str(props.get("iscurrent") or "true").strip().lower() == "false":
            continue

        magnitude, depth, measure = severity_numbers(props)

        name = str(props.get("name") or props.get("description") or "").strip()
        if not name:
            continue

        to_date = as_timestamp(props.get("todate"))
        if is_stale(to_date, now):
            continue
        # With no `iscurrent` behind them, these three have nothing else keeping
        # a year-old one out, and GDACS's list carries plenty. A missing date is
        # not stale for an event somebody is still updating, but an earthquake
        # nobody dated is one we cannot place in the week at all.
        if kind not in RUNNING_MEANS_SOMETHING:
            when = to_date or as_timestamp(props.get("fromdate"))
            if not when or is_stale(when, now):
                continue

        event_id = "{}-{}-{}".format(
            str(props.get("eventtype") or "?").strip(),
            str(props.get("eventid") or "?").strip(),
            str(props.get("episodeid") or "0").strip())

        url = props.get("url")
        if isinstance(url, dict):
            url = url.get("report") or url.get("details")
        url = url if isinstance(url, str) and url.startswith("http") else None

        lat, lng = point_of(feature)

        for code in countries_of(props):
            rows[(event_id, code)] = {
                "event_id": event_id, "country_code": code, "kind": kind,
                "severity": severity, "name": name,
                "from_date": as_timestamp(props.get("fromdate")),
                "to_date": to_date,
                "url": url, "lat": lat, "lng": lng,
                "magnitude": magnitude, "depth_km": depth, "measure": measure,
            }

    # An event GDACS lists but names no country for cannot answer the only
    # question this table exists for, so zero rows from a full feed is still a
    # problem worth stopping on.
    if not rows:
        raise SourceProblem(
            f"{len(features)} events came back but none carried a usable country code")
    return sorted(rows.values(), key=lambda r: (r["country_code"], r["event_id"]))


def sql_str(value):
    if value is None or value == "":
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def sql_num(value):
    return "null" if value is None else repr(float(value))


def emit_sql(rows):
    columns = ("event_id", "country_code", "kind", "severity", "name",
               "from_date", "to_date", "url", "lat", "lng", "magnitude", "depth_km",
               "measure")
    print(f"-- {len(rows)} country alerts from {SOURCE}")
    print("begin;")

    values = [
        "  ({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, now())".format(
            sql_str(r["event_id"]), sql_str(r["country_code"]), sql_str(r["kind"]),
            sql_str(r["severity"]), sql_str(r["name"]),
            sql_str(r["from_date"]), sql_str(r["to_date"]), sql_str(r["url"]),
            sql_num(r["lat"]), sql_num(r["lng"]),
            sql_num(r["magnitude"]), sql_num(r["depth_km"]), sql_str(r["measure"]))
        for r in rows
    ]
    for start in range(0, len(values), INSERT_BATCH):
        print("insert into public.disaster_alerts ({}, refreshed_at) values"
              .format(", ".join(columns)))
        print(",\n".join(values[start:start + INSERT_BATCH]))
        print("on conflict (event_id, country_code) do update set "
              "kind = excluded.kind, severity = excluded.severity, name = excluded.name, "
              "from_date = excluded.from_date, to_date = excluded.to_date, "
              "url = excluded.url, lat = excluded.lat, lng = excluded.lng, "
              "magnitude = excluded.magnitude, depth_km = excluded.depth_km, "
              "measure = excluded.measure, "
              "refreshed_at = now();")

    # GDACS decides when something is over. Anything it stopped listing goes,
    # which is exactly "when the original site removes it, we remove it".
    #
    # now() is the transaction's start time and does not move, so every row
    # this run touched carries exactly that value and every row it did not
    # carries something strictly earlier. No interval to tune, and no window in
    # which a fast second run would spare a stale row.
    print("delete from public.disaster_alerts where refreshed_at < now();")
    print("commit;")
    print("select kind, severity, count(*) from public.disaster_alerts "
          "group by kind, severity order by 1, 2;")


def main():
    if "--file" in sys.argv:
        with open(sys.argv[sys.argv.index("--file") + 1], encoding="utf-8") as handle:
            payload = json.load(handle)
    else:
        # One list failing is a list that is missing, not a reason to write
        # nothing: the wildfires are worth having without the floods and the
        # other way round. Only losing both stops the run.
        answers = []
        for url in SOURCES:
            got = fetch(url)
            if got is None:
                print(f"--   giving up on {url.rsplit('/', 1)[-1]}", file=sys.stderr)
                continue
            count = len(got.get("features") or []) if isinstance(got, dict) else 0
            print(f"--   {url.rsplit('/', 1)[-1]}: {count} events", file=sys.stderr)
            answers.append(got)
        payload = merge(answers) if answers else None

    if payload is None:
        print("::error::Could not reach GDACS. Nothing written; the table keeps what it had.",
              file=sys.stderr)
        sys.exit(1)

    try:
        rows = rows_from(payload)
    except SourceProblem as problem:
        print(f"::error::{problem}", file=sys.stderr)
        sys.exit(1)

    emit_sql(rows)
    countries = len({r["country_code"] for r in rows})
    kinds = {}
    for row in rows:
        kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
    print(f"-- {len(rows)} rows across {countries} countries: "
          + ", ".join(f"{k}={v}" for k, v in sorted(kinds.items())), file=sys.stderr)


if __name__ == "__main__":
    main()
