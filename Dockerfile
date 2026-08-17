# syntax=docker/dockerfile:1
#
# Node-RED automation server for Render Free (512 MB RAM / 0.1 CPU)
#
# Multi-stage build:
#   1) node-builder    -> installs only production npm deps for Node-RED
#   2) python-builder   -> builds a Python venv (edge-tts/requests/yt-dlp
#                         install from prebuilt wheels, no compiler needed)
#   3) final            -> slim runtime image: node + python3 + ffmpeg +
#                         the pre-built node_modules / venv, running as a
#                         non-root user under tini.
#
# No secrets are baked in anywhere in this file. All credentials are
# supplied at deploy time via Render environment variables.

# ---------- Stage 1: Node.js production dependencies ----------
FROM node:22-bookworm-slim AS node-builder

# python3/build-essential here are ONLY for npm packages that may need to
# compile native addons during `npm install` (Node-RED core itself is
# pure JS/bcryptjs, but keep this so the image never fails on transitive
# native deps). Discarded when this stage is discarded.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY package.json package-lock.json ./
# The Credential Manager (custom-nodes/credential-manager) is installed
# as a local `file:` dependency declared in package.json — it needs to
# be present before `npm ci` reads/installs it.
COPY custom-nodes ./custom-nodes
# npm ci (not install) — installs exactly what's pinned in
# package-lock.json, so a nested dependency updating on npm's registry
# can never silently change what gets built. Regenerate the lockfile
# with `npm install --package-lock-only` after editing package.json.
# --install-links makes npm COPY local `file:` deps into node_modules
# instead of symlinking them (npm's default for file: deps) — required
# here because the final image stage below copies only node_modules,
# not this stage's /build/custom-nodes source, so a symlink would dangle.
RUN npm ci --omit=dev --no-audit --no-fund --install-links \
    && npm cache clean --force

# ---------- Stage 2: Python virtualenv ----------
FROM python:3.12-slim-bookworm AS python-builder

# No apt packages needed here: edge-tts/requests/yt-dlp all ship
# prebuilt manylinux wheels for this platform (verified — nothing in
# requirements.txt triggers a source build), so no compiler or dev
# headers are required to build this venv.
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /tmp/requirements.txt

# ---------- Stage 3: Final runtime image ----------
FROM node:22-bookworm-slim AS final

# Runtime-only system packages (no compilers, keeps image lean):
#   python3        - to run the venv's interpreter
#   ffmpeg         - audio/video processing
#   curl           - healthchecks / debugging from inside the container
#   ca-certificates- TLS trust store for HTTPS calls (Google APIs, yt-dlp, etc.)
#   tini           - proper PID 1 / zombie reaping / signal forwarding
#   tzdata         - so TZ env var behaves correctly in cron/inject nodes
#   util-linux     - provides `flock`, used to force ffmpeg concurrency=1
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        ffmpeg \
        curl \
        ca-certificates \
        tini \
        tzdata \
        util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

ENV NODE_RED_HOME=/usr/src/node-red \
    NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=256 \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TMPDIR=/tmp/nr-work \
    PORT=10000

WORKDIR $NODE_RED_HOME

COPY --from=node-builder /build/node_modules ./node_modules
COPY --from=python-builder /opt/venv /opt/venv

COPY package.json .
COPY settings.js .
COPY flows-seed.json .
COPY scripts ./scripts
COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh scripts/*.sh 2>/dev/null; \
    chmod +x /entrypoint.sh && \
    mkdir -p /data /tmp/nr-work /tmp/secrets && \
    chown -R node:node /data /tmp/nr-work /tmp/secrets $NODE_RED_HOME

USER node

EXPOSE 10000

# Render's own "Health Check Path" setting (see render.yaml) is what
# actually gates traffic/restarts on Render. This HEALTHCHECK is a
# best-effort local safety net for `docker run` / other orchestrators.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entrypoint.sh"]
