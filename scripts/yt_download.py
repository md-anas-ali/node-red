#!/usr/bin/env python3
"""
yt_download.py — download a video/audio with yt-dlp into /tmp only.

Usage (from a Node-RED exec node):
    python3 scripts/yt_download.py "<url>" audio
    python3 scripts/yt_download.py "<url>" video

Prints the downloaded file path on the last line of stdout.

Deliberately conservative for a 512MB/0.1CPU box:
  - "audio" mode extracts audio only (much smaller memory/CPU
    footprint than transcoding video).
  - "video" mode caps to 480p to avoid pulling huge source files
    into an ephemeral /tmp that shares RAM-backed space with
    everything else.
  - Always writes to $TMPDIR (falls back to /tmp) so the caller's
    flow is responsible for reading and then deleting the file —
    nothing here is auto-persisted.
"""
import os
import sys
import tempfile
import uuid

import yt_dlp


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: yt_download.py <url> [audio|video]", file=sys.stderr)
        return 1

    url = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else "audio"

    tmp_dir = os.environ.get("TMPDIR", tempfile.gettempdir())
    os.makedirs(tmp_dir, exist_ok=True)
    job_id = uuid.uuid4().hex
    out_template = os.path.join(tmp_dir, f"yt-{job_id}.%(ext)s")

    if mode == "video":
        ydl_opts = {
            "outtmpl": out_template,
            "format": "bestvideo[height<=480]+bestaudio/best[height<=480]",
            "merge_output_format": "mp4",
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
        }
    else:
        ydl_opts = {
            "outtmpl": out_template,
            "format": "bestaudio/best",
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "128",
                }
            ],
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
        }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        final_path = ydl.prepare_filename(info)
        if mode != "video":
            # postprocessor rewrites the extension to .mp3
            final_path = os.path.splitext(final_path)[0] + ".mp3"

    print(final_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
