#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Checks fetch_advisories.py against stub payloads, without the network.
#
# This generator is the only thing that writes to travel_advisories, and it
# runs unattended. The case that matters most is not the happy one: it is the
# day the interface answers {} or half a list, when a credulous loader would
# delete every advisory on the site and leave no trace of why.
#
# Run: python3 supabase/ops/fetch_advisories_test.py
# ---------------------------------------------------------------------------
import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_advisories as fa  # noqa: E402

results = []


def check(condition, label):
    results.append((bool(condition), label))


def payload(entries):
    """A response shaped like theirs: numbered keys plus a contentList sibling."""
    response = {str(k): v for k, v in entries.items()}
    response["contentList"] = [str(k) for k in entries]
    return {"response": response}


def country(code, name, **flags):
    return {
        "title": f"{name}: Reise- und Sicherheitshinweise",
        "CountryCode": code,
        "CountryName": name,
        "lastModified": 1758000000,
        "effective": 1757000000,
        "warning": flags.get("warning", False),
        "partialWarning": flags.get("partialWarning", False),
        "situationWarning": flags.get("situationWarning", False),
        "situationPartWarning": flags.get("situationPartWarning", False),
    }


# Codes the tests below add by hand. The filler must not mint them too, or a
# collision quietly changes the row count a test is asserting on.
RESERVED = {"ES", "AF", "PT", "IT", "FR"}


def bulk(n, start=200000):
    """n plausible filler countries, avoiding the codes the tests use by name."""
    out = {}
    i = 0
    while len(out) < n:
        code = chr(65 + i // 26) + chr(65 + i % 26)
        i += 1
        if code in RESERVED:
            continue
        out[start + len(out)] = country(code, f"Land {code}")
    return out


# --- a normal response ------------------------------------------------------
entries = bulk(fa.MIN_PLAUSIBLE + 10)
entries[262646] = country("ES", "Spanien", situationWarning=True)
entries[199206] = country("AF", "Afghanistan", warning=True)
rows = fa.rows_from(payload(entries))
by_code = {r["country_code"]: r for r in rows}

check(len(rows) == fa.MIN_PLAUSIBLE + 12, f"every country is kept ({len(rows)})")
check("contentList" not in by_code, "the contentList sibling key is not read as a country")
check(by_code["ES"]["content_id"] == 262646, "contentId becomes content_id")
check(by_code["ES"]["situation_warning"] is True, "situationWarning maps to situation_warning")
check(by_code["ES"]["warning"] is False, "an unset level stays false")
check(by_code["AF"]["warning"] is True, "a full travel warning is carried through")
check(by_code["ES"]["title"].startswith("Spanien:"), "the official title is kept verbatim")
check(by_code["ES"]["last_modified"].startswith("2025-09-16"),
      f"the source's epoch seconds become a timestamp ({by_code['ES']['last_modified']})")
check([r["country_code"] for r in rows] == sorted(r["country_code"] for r in rows),
      "rows come out in a stable order")

# --- the failures that would wipe the table ---------------------------------
for broken, label in [
    ({}, "an empty object"),
    ({"response": {}}, "an empty response object"),
    ({"response": {"contentList": []}}, "a response holding only contentList"),
    ([], "a JSON array"),
    ("nope", "a bare string"),
    (payload(bulk(5)), "a response with only 5 countries"),
    (payload(bulk(fa.MIN_PLAUSIBLE - 1)), "a response one country short of plausible"),
]:
    try:
        fa.rows_from(broken)
        check(False, f"{label} is refused")
    except fa.SourceProblem:
        check(True, f"{label} is refused")

# --- rubbish inside an otherwise good response ------------------------------
entries = bulk(fa.MIN_PLAUSIBLE + 5)
entries[1] = {"CountryCode": "", "title": "no code"}
entries[2] = {"CountryCode": "ESP", "title": "three letters"}
entries[3] = {"CountryCode": "IT", "title": ""}
entries[4] = {"CountryCode": "12", "title": "digits"}
entries[5] = "not even an object"
rows = fa.rows_from(entries_payload := payload(entries))
codes = {r["country_code"] for r in rows}
check("ESP" not in codes and "12" not in codes, "a malformed country code is dropped")
check(all(r["title"] for r in rows), "a row with no title is dropped")
check(len(rows) == fa.MIN_PLAUSIBLE + 5, "the good rows in a partly bad response survive")

# --- a renamed field, which is what a live response actually did ------------
# The published schema says CountryCode/CountryName; a real response need not
# agree. Both spellings are accepted, and when nothing parses the error names
# the fields it was handed instead of only the count.
entries = {}
for i in range(fa.MIN_PLAUSIBLE + 3):
    code = chr(65 + i // 26) + chr(65 + i % 26)
    entries[400000 + i] = {
        "title": f"Land {code}: Hinweise", "countryCode": code, "countryName": f"Land {code}",
        "lastModified": 1758000000, "warning": False, "partialWarning": False,
        "situationWarning": True, "situationPartWarning": False,
    }
rows = fa.rows_from(payload(entries))
check(len(rows) == fa.MIN_PLAUSIBLE + 3, 'lowercase countryCode/countryName parse too')
check(rows[0]["situation_warning"] is True, 'and the level booleans still read')
check(rows[0]["country_name"].startswith('Land '), 'and the country name comes through')

try:
    fa.rows_from(payload({1: {"someOtherShape": 1, "andAnother": 2}}))
    check(False, 'an unrecognisable entry shape is refused')
except fa.SourceProblem as problem:
    check('someOtherShape' in str(problem) and 'andAnother' in str(problem),
          f'and the error names the fields it was handed')

# --- duplicates -------------------------------------------------------------
entries = bulk(fa.MIN_PLAUSIBLE + 2)
entries[900001] = {**country("PT", "Portugal"), "lastModified": 1000000000}
entries[900002] = {**country("PT", "Portugal", warning=True), "lastModified": 1758000000}
rows = fa.rows_from(payload(entries))
portugal = [r for r in rows if r["country_code"] == "PT"]
check(len(portugal) == 1, "a country listed twice yields one row")
check(portugal[0]["warning"] is True and portugal[0]["content_id"] == 900002,
      "the more recently modified of two duplicates wins")

# --- odd timestamps ---------------------------------------------------------
check(fa.as_timestamp(0) is None, "epoch 0 is not a date")
check(fa.as_timestamp(-5) is None, "a negative timestamp is not a date")
check(fa.as_timestamp(None) is None, "a missing timestamp is not a date")
check(fa.as_timestamp("nope") is None, "a non-numeric timestamp is not a date")
check(fa.as_timestamp(1758000000000).startswith("2025-09-16"), "milliseconds convert")
# The live interface sends seconds, not milliseconds. Read as milliseconds they
# land in January 1970, which looks like a stale site rather than a unit bug —
# so both units are pinned here.
check(fa.as_timestamp(1728000000).startswith("2024-10-04"),
      f"seconds convert too ({fa.as_timestamp(1728000000)})")
check(not fa.as_timestamp(1728000000).startswith("1970"),
      "and are never read as milliseconds, which would give 1970")
check(fa.as_timestamp(1).startswith("1970"),
      "a genuinely tiny value is still 1970, not rescued into something plausible")

# --- booleans arriving as strings -------------------------------------------
check(fa.flag({"warning": "true"}, "warning") is True, '"true" counts as set')
check(fa.flag({"warning": "false"}, "warning") is False, '"false" counts as unset')
check(fa.flag({}, "warning") is False, "a missing level counts as unset")
check(fa.flag({"warning": None}, "warning") is False, "a null level counts as unset")

# --- the SQL ----------------------------------------------------------------
entries = bulk(fa.MIN_PLAUSIBLE)
entries[777] = country("FR", "Frankreich's Test", partialWarning=True)
rows = fa.rows_from(payload(entries))
buffer = io.StringIO()
with redirect_stdout(buffer):
    fa.emit_sql(rows)
sql = buffer.getvalue()

check(sql.count("begin;") == 1 and sql.count("commit;") == 1,
      "the whole refresh is one transaction")
check("Frankreich''s Test" in sql, "an apostrophe in a name is escaped, not injected")
check("delete from public.travel_advisories where country_code not in (" in sql,
      "countries that stopped being published are deleted")
check(sql.index("insert into") < sql.index("delete from"),
      "the delete runs after the inserts, so nothing is dropped before it is replaced")
check("'FR'" in sql.split("delete from")[1], "a country in this run is excluded from the delete")
check(sql.count("insert into public.travel_advisories") ==
      -(-len(rows) // fa.INSERT_BATCH), "rows are batched into whole insert statements")
check("on conflict (country_code) do update set" in sql, "an existing country is updated in place")
check("refreshed_at = now()" in sql, "every touched row records when we read it")

# --- report -----------------------------------------------------------------
failed = [label for ok, label in results if not ok]
for ok, label in results:
    print(("  ok    " if ok else "  FAIL  ") + label)
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
