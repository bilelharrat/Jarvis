"""`afplay` for Windows: plays a WAV file through the default output device and returns when
it's done. Run as `python -I -m jarvis.winplay FILE.wav`. Killing it stops the sound."""

from __future__ import annotations

import sys


def main(argv: list[str]) -> int:
    if not argv:
        return 2
    import winsound

    winsound.PlaySound(argv[0], winsound.SND_FILENAME)  # blocks until the clip ends
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
