#!/usr/bin/env python3
"""
gsheet_append.py — append one row to a Google Sheet using the
Node-RED Credential Manager's Google OAuth2 credential.

No service-account JSON, no GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 — the
access token is fetched in-process from Node-RED's internal token
endpoint via google_token.py, so it never appears in this process's
argv (visible to `ps aux` inside the container) or in Node-RED's exec
node command string.

Usage (from a Node-RED exec node):
    python3 scripts/gsheet_append.py <credential_id> <spreadsheet_id> <sheet_name> <comma,separated,values>

<credential_id> is the id of the "google-oauth2-credentials" config
node you created and connected in the editor's Configuration nodes
list — shown in that node's edit dialog once it's deployed.

Remember the Google account you authorized needs edit access to the
target spreadsheet (share it with that account, or use your own).
"""
import sys

import requests

from google_token import get_access_token

SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"


def main() -> int:
    if len(sys.argv) < 5:
        print(
            "usage: gsheet_append.py <credential_id> <spreadsheet_id> <sheet_name> <comma,separated,values>",
            file=sys.stderr,
        )
        return 1

    credential_id, spreadsheet_id, sheet_name, raw_values = sys.argv[1:5]
    row = raw_values.split(",")

    access_token = get_access_token(credential_id)

    url = f"{SHEETS_API}/{spreadsheet_id}/values/{sheet_name}:append"
    resp = requests.post(
        url,
        params={"valueInputOption": "USER_ENTERED"},
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        json={"values": [row]},
        timeout=30,
    )

    if not resp.ok:
        print(f"Sheets API error {resp.status_code}: {resp.text}", file=sys.stderr)
        return 1

    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
