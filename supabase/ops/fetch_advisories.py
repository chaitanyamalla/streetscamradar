#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Refresh public.travel_advisories from the German Federal Foreign Office.
#
#   https://www.auswaertiges-amt.de/opendata/travelwarning
#
# One request returns every country, so this is a small, fast job — unlike the
# safety-places crawl, which walks a city at a time.
#
# What we store, and what we do not
# ---------------------------------
# We store the STATUS of each advisory: which of the four levels applies, the
# official title, and when the ministry last changed it. We never store the
# advisory text, even though a second endpoint offers it.
#
# Their terms require the information to be taken complete, kept current, and
# not presented in a distorting context, and ask that country text be linked
# rather than copied. A stored excerpt would fail all of that the first time an
# advisory was updated. A status plus the official permalink cannot go stale in
# the same way: the worst case is that we say "security notice" when it has
# become "travel warning", which the link corrects, rather than us showing
# yesterday's reassuring paragraph as though it were today's.
#
# Refusing to write rubbish
# -------------------------
# Their interface answers an empty JSON object when it is having a bad day.
# Taken literally, that means "no country on Earth has an advisory" — which,
# loaded blindly, would clear the table and quietly turn every warning on the
# site off. So a response that is empty, unparseable, or implausibly short is
# an error that writes nothing, and the previous rows stay up.
#
# Usage:
#   python3 fetch_advisories.py > advisories.sql
#   python3 fetch_advisories.py --file sample.json > advisories.sql
# ---------------------------------------------------------------------------
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

SOURCE = "https://www.auswaertiges-amt.de/opendata/travelwarning"
TIMEOUT = 45
RETRIES = 3

# They publish around 200 countries. If a response carries far fewer than that
# it is not a quiet week, it is a broken response, and it must not be allowed
# to delete the rest. Set well below the real figure so an ordinary fluctuation
# never trips it.
MIN_PLAUSIBLE = 100

INSERT_BATCH = 200

# Keys that live alongside the numbered entries inside "response" and are not
# countries.
NOT_A_COUNTRY = {"contentList"}


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
    """The payload, or None if it could not be fetched at all."""
    for attempt in range(1, retries + 1):
        try:
            return json.loads(http_get(url))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as err:
            print(f"--   attempt {attempt}/{retries} failed: {err}", file=sys.stderr)
            if attempt < retries:
                time.sleep(2 ** attempt)
    return None


def as_timestamp(value):
    """Their epoch milliseconds, as an ISO string — or None if it is not a time.

    Zero and negative values appear in place of "never set", and would
    otherwise become 1970, which reads as an advisory that has not been
    touched in fifty years.
    """
    try:
        millis = float(value)
    except (TypeError, ValueError):
        return None
    if millis <= 0:
        return None
    try:
        return datetime.fromtimestamp(millis / 1000, tz=timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def pick(entry, *names):
    """The first of these fields the entry actually has.

    Their published schema capitalises CountryCode and CountryName; a live
    response may not. Accepting both spellings costs nothing and means a
    change of case at their end is not an outage at ours.
    """
    for name in names:
        if entry.get(name) not in (None, ""):
            return entry[name]
    return None


def flag(entry, key):
    """One of the four level booleans. Anything unrecognisable counts as false:
    inventing a warning is worse than missing one, because a warning we made up
    is not in the text the reader is sent to."""
    value = entry.get(key, entry.get(key[0].upper() + key[1:]))
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return value in (1,)


def rows_from(payload):
    """Every usable country row in the payload, newest-first order irrelevant.

    Raises SourceProblem when the payload is not something we should act on.
    """
    if not isinstance(payload, dict):
        raise SourceProblem("payload is not a JSON object")
    response = payload.get("response")
    if not isinstance(response, dict) or not response:
        raise SourceProblem("no 'response' object — the interface returns {} when it is down")

    rows = {}
    skipped = 0
    seen_keys = None          # the shape we were actually handed, for the error
    for content_id, entry in response.items():
        if content_id in NOT_A_COUNTRY or not isinstance(entry, dict):
            continue
        if seen_keys is None:
            seen_keys = sorted(entry.keys())
        try:
            numeric_id = int(str(content_id).strip())
        except ValueError:
            skipped += 1
            continue

        code = str(pick(entry, "CountryCode", "countryCode") or "").strip().upper()
        title = str(pick(entry, "title", "Title") or "").strip()
        name = str(pick(entry, "CountryName", "countryName") or "").strip()
        # A row with no country code cannot be matched to anything on the map,
        # and a row with no title has nothing to show. Both are dropped rather
        # than stored as blanks that would render as an empty chip.
        if len(code) != 2 or not code.isalpha() or not title:
            skipped += 1
            continue

        row = {
            "country_code": code,
            "content_id": numeric_id,
            "title": title,
            "country_name": name or code,
            "warning": flag(entry, "warning"),
            "partial_warning": flag(entry, "partialWarning"),
            "situation_warning": flag(entry, "situationWarning"),
            "situation_part_warning": flag(entry, "situationPartWarning"),
            "last_modified": as_timestamp(entry.get("lastModified")),
            "effective": as_timestamp(entry.get("effective")),
        }

        # Some countries appear more than once across reorganisations. Keep the
        # most recently modified, so the row matches what their site shows.
        previous = rows.get(code)
        if previous is None or (row["last_modified"] or "") >= (previous["last_modified"] or ""):
            rows[code] = row

    if skipped:
        print(f"-- skipped {skipped} entr(ies) with no usable country code or title",
              file=sys.stderr)
    if len(rows) < MIN_PLAUSIBLE:
        # Say what we were handed, not just that we did not like it. Rejecting
        # every entry almost always means a field was renamed at their end, and
        # "0 countries" alone sends you reading the interface docs instead of
        # the one line that answers it.
        shape = ", ".join(seen_keys) if seen_keys else "no entries at all"
        raise SourceProblem(
            f"only {len(rows)} countries came back, expected at least {MIN_PLAUSIBLE} — "
            f"refusing to overwrite the table with a partial response. "
            f"An entry carried these fields: [{shape}]")
    return sorted(rows.values(), key=lambda r: r["country_code"])


def sql_str(value):
    if value is None or value == "":
        return "null"
    return "'" + str(value).replace("'", "''") + "'"


def sql_bool(value):
    return "true" if value else "false"


def emit_sql(rows):
    """One transaction: upsert everything, then delete whatever is no longer
    published. The delete is safe only because rows_from refuses a short
    response, so by here we know we are holding the full list."""
    columns = ("country_code", "content_id", "title", "country_name",
               "warning", "partial_warning", "situation_warning",
               "situation_part_warning", "last_modified", "effective")

    print(f"-- {len(rows)} advisories from {SOURCE}")
    print("begin;")
    values = [
        "  ({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, now())".format(
            sql_str(r["country_code"]), r["content_id"], sql_str(r["title"]),
            sql_str(r["country_name"]),
            sql_bool(r["warning"]), sql_bool(r["partial_warning"]),
            sql_bool(r["situation_warning"]), sql_bool(r["situation_part_warning"]),
            sql_str(r["last_modified"]), sql_str(r["effective"]))
        for r in rows
    ]
    for start in range(0, len(values), INSERT_BATCH):
        chunk = values[start:start + INSERT_BATCH]
        print("insert into public.travel_advisories ({}, refreshed_at) values"
              .format(", ".join(columns)))
        print(",\n".join(chunk))
        print("on conflict (country_code) do update set "
              "content_id = excluded.content_id, title = excluded.title, "
              "country_name = excluded.country_name, warning = excluded.warning, "
              "partial_warning = excluded.partial_warning, "
              "situation_warning = excluded.situation_warning, "
              "situation_part_warning = excluded.situation_part_warning, "
              "last_modified = excluded.last_modified, effective = excluded.effective, "
              "refreshed_at = now();")

    codes = ", ".join(sql_str(r["country_code"]) for r in rows)
    print(f"delete from public.travel_advisories where country_code not in ({codes});")
    print("commit;")
    print("select count(*) as advisories, "
          "count(*) filter (where warning) as full_warnings, "
          "count(*) filter (where partial_warning) as partial_warnings, "
          "count(*) filter (where situation_warning or situation_part_warning) "
          "as security_notices from public.travel_advisories;")


def main():
    if "--file" in sys.argv:
        path = sys.argv[sys.argv.index("--file") + 1]
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
    else:
        payload = fetch()

    if payload is None:
        print("::error::Could not reach the travel advisory interface. "
              "Nothing written; the table keeps what it had.", file=sys.stderr)
        sys.exit(1)

    try:
        rows = rows_from(payload)
    except SourceProblem as problem:
        print(f"::error::{problem}", file=sys.stderr)
        sys.exit(1)

    emit_sql(rows)
    levels = sum(1 for r in rows if r["warning"] or r["partial_warning"]
                 or r["situation_warning"] or r["situation_part_warning"])
    print(f"-- {len(rows)} countries, {levels} of them carrying a warning or notice",
          file=sys.stderr)


if __name__ == "__main__":
    main()
