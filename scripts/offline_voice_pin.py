"""Print the SHA-256 and size of each offline-voice file that has no checksum yet, to paste
into local_voice.OFFLINE_VOICE_FILES. Run it once, by hand, when you've decided to trust
the files at those URLs (it downloads them; the lexicons are a few MB each):

    .venv/bin/python scripts/offline_voice_pin.py

Nothing is kept: each file is hashed as it streams and thrown away. Files that already
have a checksum are left alone.
"""

from __future__ import annotations

import hashlib
import sys

import httpx

sys.path.insert(0, "src")
from jarvis.local_voice import OFFLINE_VOICE_FILES  # noqa: E402


def main() -> None:
    with httpx.Client(follow_redirects=True, timeout=120) as client:
        for name, spec in OFFLINE_VOICE_FILES.items():
            if spec.get("sha256"):
                continue
            digest, size = hashlib.sha256(), 0
            with client.stream("GET", spec["url"]) as response:
                response.raise_for_status()
                for chunk in response.iter_bytes(1 << 16):
                    digest.update(chunk)
                    size += len(chunk)
            print(f'"{name}": "sha256": "{digest.hexdigest()}", "size": {size},')


if __name__ == "__main__":
    main()
