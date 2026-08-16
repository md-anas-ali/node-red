#!/bin/bash
# ---------------------------------------------------------------
# ffmpeg_lock.sh — forces ffmpeg concurrency = 1 on a 512MB/0.1CPU
# instance. Two ffmpeg jobs running at once is one of the fastest
# ways to OOM-kill this container; this wrapper serializes every
# call through a single flock so a second job just waits its turn
# instead of racing for RAM.
#
# Usage (from a Node-RED exec node command):
#   /usr/src/node-red/scripts/ffmpeg_lock.sh -y -i input.mp3 -threads 1 output.mp3
#
# Any arguments you pass are forwarded to `ffmpeg` verbatim, and
# `-threads 1` is enforced regardless of what you pass, to also cap
# ffmpeg's own internal thread pool.
# ---------------------------------------------------------------
set -e

LOCK_FILE="/tmp/nr-work/ffmpeg.lock"
mkdir -p /tmp/nr-work

exec flock -w 300 "$LOCK_FILE" ffmpeg -threads 1 "$@"
