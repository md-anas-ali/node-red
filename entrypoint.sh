#!/bin/bash
set -e

# ---------------------------------------------------------
# Node-RED entrypoint for Render Free (512 MB RAM / 0.1 CPU)
#
# Responsibilities:
#   1. Generate/export NODE_RED_LOCAL_API_SECRET — a loopback-only
#      shared secret the Credential Manager's internal token endpoint
#      (custom-nodes/credential-manager) uses to let Python exec-node
#      scripts fetch a short-lived Google access token without ever
#      writing a token or a service-account key to disk. Exporting it
#      here means every child process Node-RED spawns (exec nodes)
#      inherits it automatically — nothing extra to wire up per script.
#   2. Seed /data with a baseline flows.json on first boot, since
#      Render's free plan has an ephemeral filesystem (no persistent
#      disk) — /data is wiped on every redeploy and every cold restart
#      after spin-down.
#   3. Make sure ffmpeg/python temp output goes to /tmp and never
#      accumulates.
#   4. Launch Node-RED bound to Render's $PORT.
#
# NOTE: this used to also bridge GOOGLE_SERVICE_ACCOUNT_JSON_BASE64
# into a service-account key file. That approach has been replaced
# entirely by the in-editor Google OAuth2 Credential Manager (see
# custom-nodes/credential-manager) — no Google secret of any kind is
# read from Render environment variables anymore.
# ---------------------------------------------------------

echo "[entrypoint] Booting Node-RED automation server..."

# --- 1. Local API secret for the Credential Manager -------------------
if [ -z "$NODE_RED_LOCAL_API_SECRET" ]; then
  export NODE_RED_LOCAL_API_SECRET="$(head -c 24 /dev/urandom | base64 | tr -d '=+/')"
  echo "[entrypoint] Generated a fresh NODE_RED_LOCAL_API_SECRET for this boot"
else
  echo "[entrypoint] Using NODE_RED_LOCAL_API_SECRET from environment"
fi

# --- 2. Seed ephemeral storage with a baseline flow ---------------------
mkdir -p /data
if [ ! -f /data/flows.json ]; then
  echo "[entrypoint] No /data/flows.json found (fresh/ephemeral container) — seeding baseline flow"
  cp "$NODE_RED_HOME/flows-seed.json" /data/flows.json
fi

if [ -z "$NODE_RED_CREDENTIAL_SECRET" ]; then
  echo "[entrypoint] WARNING: NODE_RED_CREDENTIAL_SECRET is not set."
  echo "[entrypoint]          This is the encryption key for ALL stored credentials —"
  echo "[entrypoint]          including any Google OAuth2 Client Secret and tokens"
  echo "[entrypoint]          saved through the Credential Manager. Node-RED will"
  echo "[entrypoint]          auto-generate one and store it under /data, which is"
  echo "[entrypoint]          ephemeral on Render Free: every redeploy or cold start"
  echo "[entrypoint]          after spin-down invalidates it, and you'll need to"
  echo "[entrypoint]          re-enter Client ID/Secret and re-authorize every time."
  echo "[entrypoint]          Set NODE_RED_CREDENTIAL_SECRET as a fixed Render env"
  echo "[entrypoint]          var to avoid this."
fi

# --- 3. Clean temp workspace on every boot -------------------------------
rm -rf /tmp/nr-work/* 2>/dev/null || true
mkdir -p /tmp/nr-work
export TMPDIR=/tmp/nr-work

# --- 3b. PostgreSQL bootstrap (connect w/ backoff, migrate, verify, ------
#         recover crashed jobs) — PostgreSQL is the ONLY persistent
#         storage this app uses (no Redis, no local-filesystem
#         fallback). If this fails, the container must NOT start: there
#         is nowhere else for data to safely live. See
#         scripts/db-bootstrap.js and custom-nodes/db-core/.
if [ -z "$DB_POSTGRESDB_CONNECTION_URL" ]; then
  echo "[entrypoint] FATAL: DB_POSTGRESDB_CONNECTION_URL is not set."
  echo "[entrypoint]        PostgreSQL is required — there is no fallback storage."
  exit 1
fi
echo "[entrypoint] Running PostgreSQL startup checks (connect, migrate, verify schema, recover jobs)..."
node "$NODE_RED_HOME/scripts/db-bootstrap.js"
echo "[entrypoint] PostgreSQL startup checks passed."

# --- 4. Runtime diagnostics ------------------------------------------------
echo "[entrypoint] PORT   = ${PORT:-10000}"
echo "[entrypoint] Node   = $(node -v)"
echo "[entrypoint] Python = $(python3 --version 2>&1)"
echo "[entrypoint] FFmpeg = $(ffmpeg -version 2>&1 | head -n1)"
echo "[entrypoint] NODE_OPTIONS = ${NODE_OPTIONS}"

# --- 5. Launch Node-RED -----------------------------------------------------
# --settings is NOT optional here: without it, Node-RED looks for
# settings.js inside --userDir (/data) instead of this app's settings.js,
# silently falls back to its own defaults, and every tuning/security
# choice in settings.js (credentialSecret, adminAuth, RAM options, the
# Credential Manager's httpAdminRoot assumptions) is quietly ignored.
exec node "$NODE_RED_HOME/node_modules/node-red/red.js" \
  --settings "$NODE_RED_HOME/settings.js" \
  --userDir /data \
  --port "${PORT:-10000}"
