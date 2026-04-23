#!/usr/bin/env python3
"""Push Garmin Index body composition to the MCP server.

Runs locally on your laptop (Garmin Connect blocks requests from cloud IPs
like Railway, so we can't do this on the server). Authenticates with your
Garmin credentials via python-garminconnect, pulls the last N days of
weigh-ins, and POSTs them to the MCP server's /garmin/body-composition
endpoint.

Setup:
    python3 -m venv .venv
    source .venv/bin/activate
    pip install garminconnect requests

Env vars:
    GARMIN_EMAIL          — Garmin Connect email
    GARMIN_PASSWORD       — Garmin Connect password
    GARMIN_PUSH_TOKEN     — bearer token that matches the server's GARMIN_PUSH_TOKEN
    GARMIN_SERVER_URL     — defaults to the deployed Railway URL
    GARMIN_DAYS           — defaults to 30

Run:
    GARMIN_EMAIL=you@example.com \\
    GARMIN_PASSWORD='...' \\
    GARMIN_PUSH_TOKEN='...' \\
    python3 scripts/garmin_push.py
"""

import datetime
import json
import os
import sys

try:
    from garminconnect import Garmin
    import requests
except ImportError as err:
    sys.stderr.write(
        f"Missing dependency ({err}). Install with:\n"
        "    pip install garminconnect requests\n"
    )
    sys.exit(2)


DEFAULT_SERVER_URL = (
    "https://whoop-mcp-server-production-7397.up.railway.app/garmin/body-composition"
)


def fetch_weigh_ins(garmin: Garmin, days: int) -> list[dict]:
    entries: dict[int, dict] = {}
    today = datetime.date.today()
    for i in range(days):
        date = today - datetime.timedelta(days=i)
        try:
            data = garmin.get_body_composition(date.isoformat())
        except Exception as err:  # noqa: BLE001 - garminconnect raises bare Exception
            message = str(err)
            if "404" in message or "Not Found" in message:
                continue
            sys.stderr.write(f"  warning on {date}: {message}\n")
            continue
        for entry in data.get("dateWeightList") or []:
            sample_pk = entry.get("samplePk")
            if sample_pk is not None and sample_pk not in entries:
                entries[sample_pk] = entry
    return list(entries.values())


def main() -> int:
    email = os.environ.get("GARMIN_EMAIL")
    password = os.environ.get("GARMIN_PASSWORD")
    token = os.environ.get("GARMIN_PUSH_TOKEN")
    server_url = os.environ.get("GARMIN_SERVER_URL", DEFAULT_SERVER_URL)
    days = int(os.environ.get("GARMIN_DAYS", "30"))

    if not email or not password or not token:
        sys.stderr.write(
            "Set GARMIN_EMAIL, GARMIN_PASSWORD, and GARMIN_PUSH_TOKEN env vars.\n"
        )
        return 1

    print(f"Logging in as {email}...", file=sys.stderr)
    garmin = Garmin(email, password)
    garmin.login()

    print(f"Fetching last {days} days of body composition...", file=sys.stderr)
    entries = fetch_weigh_ins(garmin, days)
    print(f"  {len(entries)} unique weigh-ins found.", file=sys.stderr)

    if not entries:
        print("Nothing to push. Weigh in on the Index scale and try again.", file=sys.stderr)
        return 0

    print(f"POSTing to {server_url}...", file=sys.stderr)
    resp = requests.post(
        server_url,
        headers={"Authorization": f"Bearer {token}"},
        json={"entries": entries},
        timeout=60,
    )
    resp.raise_for_status()
    print(json.dumps(resp.json(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
