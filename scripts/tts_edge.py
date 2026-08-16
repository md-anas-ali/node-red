#!/usr/bin/env python3
"""
tts_edge.py — text-to-speech via edge-tts, writing to /tmp only.

Usage (from a Node-RED exec node):
    python3 scripts/tts_edge.py "Hello world" "en-US-AriaNeural"

Prints the output file path on the LAST line of stdout on success so
a downstream function node can do:
    msg.audioPath = msg.payload.trim().split("\n").pop();

The caller (Node-RED flow) is responsible for reading/streaming the
file and then deleting it — this script does not accumulate files
across runs, but it also does not know when you're done with the
output, so cleanup is your flow's job. See README for a
cleanup-on-response pattern using a function node + fs.unlink.
"""
import asyncio
import os
import sys
import tempfile
import uuid

import edge_tts

DEFAULT_VOICE = "en-US-AriaNeural"


async def synthesize(text: str, voice: str, out_path: str) -> None:
    communicate = edge_tts.Communicate(text, voice)
    await communicate.save(out_path)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: tts_edge.py <text> [voice]", file=sys.stderr)
        return 1

    text = sys.argv[1]
    voice = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_VOICE

    tmp_dir = os.environ.get("TMPDIR", tempfile.gettempdir())
    os.makedirs(tmp_dir, exist_ok=True)
    out_path = os.path.join(tmp_dir, f"tts-{uuid.uuid4().hex}.mp3")

    asyncio.run(synthesize(text, voice, out_path))

    print(out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
