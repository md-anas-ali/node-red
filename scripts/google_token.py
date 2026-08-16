#!/usr/bin/env python3
"""
google_token.py — fetch a currently-valid Google OAuth2 access token
for a credential stored in this server's Credential Manager
(custom-nodes/credential-manager/google-oauth2-credentials.js).

This is the ONLY way Python scripts in this project get a Google
access token — there is no service-account JSON file, no key on disk,
and the token never appears in this process's argv (which `ps aux`
inside the container could otherwise read, unlike env vars passed to
a specific child). The credential's Client Secret and refresh token
never leave Node-RED's encrypted credential store; this script only
ever receives a short-lived access token, fetched fresh (and
transparently refreshed server-side if it had expired) on every call.

Usage as a library:
    from google_token import get_access_token
    token = get_access_token("<credential_node_id>")

Usage as a CLI (prints the token — for local debugging only, since it
then ends up in your shell history/output):
    python3 scripts/google_token.py <credential_node_id>
"""
import os
import sys

import requests


def get_access_token(credential_id: str) -> str:
    port = os.environ.get("PORT", "10000")
    secret = os.environ.get("NODE_RED_LOCAL_API_SECRET")
    if not secret:
        raise RuntimeError(
            "NODE_RED_LOCAL_API_SECRET is not set in this process's environment — "
            "this script must run as a child process of the Node-RED container "
            "(entrypoint.sh exports it, and exec-node subprocesses inherit it)."
        )

    # httpAdminRoot is fixed to '/admin' in settings.js. This route is
    # NOT gated by the human editor login (adminAuth) — exec-node
    # subprocesses can't do an interactive login — only by the
    # loopback + shared-secret check in google-oauth2-credentials.js.
    url = f"http://127.0.0.1:{port}/admin/credential-manager/google/{credential_id}/token"
    resp = requests.get(url, headers={"x-local-secret": secret}, timeout=15)

    try:
        data = resp.json()
    except ValueError:
        resp.raise_for_status()
        raise RuntimeError(f"Unexpected response from Credential Manager: {resp.text[:200]}")

    if resp.status_code != 200 or not data.get("ok"):
        raise RuntimeError(f"Credential Manager error: {data.get('error', data)}")

    return data["access_token"]


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: google_token.py <credential_node_id>", file=sys.stderr)
        return 1
    try:
        print(get_access_token(sys.argv[1]))
    except Exception as exc:  # noqa: BLE001 — CLI entry point, want a clean message
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
