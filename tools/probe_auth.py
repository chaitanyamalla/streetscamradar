#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# Which sign-in methods does the live project actually have switched on?
#
# The Google button on the page is hidden unless Supabase says the provider is
# enabled — js/auth.js enabledProviders() asks /auth/v1/settings and hides the
# button rather than offering one that answers "Unsupported provider". So the
# question "is Google set up?" has an authoritative answer, and it is this
# endpoint, not the dashboard UI and not my reading of it.
#
# This replicates that call exactly, so a disagreement between this and the
# page means a bug in our code rather than a configuration we misread.
#
# No secret needed: the endpoint takes the publishable key, which is in
# js/config.js and is meant to be public. It returns which providers are on
# and nothing about any user — no emails, no ids, no counts. Safe to print in
# a public repository's job log, which is why it is printed in full.
#
# Reads only. Run from the Probe workflow.
# ---------------------------------------------------------------------------
import json
import re
import urllib.error
import urllib.request
from pathlib import Path

CONFIG = Path(__file__).resolve().parent.parent / "js" / "config.js"
UA = "StreetScamRadar/1.0 (+https://streetscamradar.vercel.app)"


def from_config(name):
    """Read a constant out of js/config.js, so this cannot drift from the app."""
    source = CONFIG.read_text()
    found = re.search(rf"export const {name}\s*=\s*'([^']+)'", source)
    if not found:
        raise SystemExit(f"{name} not found in {CONFIG}")
    return found.group(1)


def main():
    url = from_config("SUPABASE_URL")
    key = from_config("SUPABASE_PUBLISHABLE_KEY")
    print(f"Asking {url} which sign-in methods are on. Nothing is written.\n")

    request = urllib.request.Request(
        f"{url}/auth/v1/settings",
        headers={"apikey": key, "User-Agent": UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            settings = json.loads(response.read().decode("utf-8"))
            status = response.status
    except urllib.error.HTTPError as problem:
        body = problem.read().decode("utf-8", "replace")[:400]
        raise SystemExit(f"HTTP {problem.code} from /auth/v1/settings\n{body}")

    print(f"HTTP {status}\n")
    print("-- the whole reply (no user data in it) --")
    print(json.dumps(settings, indent=2, sort_keys=True))

    external = settings.get("external") or {}
    print("\n-- providers --")
    for name, on in sorted(external.items()):
        print(f"  {'ON ' if on else 'off'}  {name}")

    # Exactly what js/auth.js does, so the verdict matches the button.
    google = bool(external.get("google"))
    print("\n-- the question that was asked --")
    print(f"  Google sign-in enabled: {'YES' if google else 'NO'}")
    print(f"  The button on the page is therefore: {'SHOWN' if google else 'HIDDEN'}")

    # Two settings that decide whether email sign-in is usable at all. With the
    # built-in mailer capped at a couple of messages an hour, a confirmation
    # requirement is what turns that cap into a broken sign-up.
    print("\n-- email sign-in, for contrast --")
    print(f"  signups disabled project-wide : {settings.get('disable_signup')}")
    print(f"  mailer_autoconfirm (no email needed to confirm): {settings.get('mailer_autoconfirm')}")
    if not google:
        raise SystemExit("\nGoogle is NOT enabled on this project yet.")


if __name__ == "__main__":
    main()
