"""Small native helpers for Jarvis's audio (Swift sources in this folder), built with swiftc
the first time they're needed and kept by their source's hash; speech.ensure_player builds
the voice player (player/jarvis-player.swift) here too. A helper that can't be built is
left out and said so once; what needed it falls back (Whisper for jarvis-hear, afplay for
the player)."""

from __future__ import annotations

import hashlib
import logging
import os
import subprocess
from pathlib import Path

log = logging.getLogger("jarvis")

HERE = Path(__file__).parent
_told: set[str] = set()  # helpers whose failed build was said in the log


def build(
    name: str,
    flags: tuple[str, ...] = ("-parse-as-library",),
    *,
    source: Path | None = None,
    timeout: float = 600,
) -> Path | None:
    """HERE/<name>.swift (or `source`) built into Application Support/Jarvis/bin/<name>-<hash>
    (once; a few seconds to a minute with swiftc). None when it can't be built. The hash is
    the source's with the flags after it, so one built with none (the voice player) is kept
    by its source's hash alone."""
    from ..prefs import APP_SUPPORT
    from ..swift_helper import prebuilt

    source = source if source is not None else HERE / f"{name}.swift"
    if not source.exists():
        return None
    found = prebuilt(name, source)
    if found is not None:
        return found
    digest = hashlib.sha256(source.read_bytes() + " ".join(flags).encode()).hexdigest()[:10]
    binary = APP_SUPPORT / "bin" / f"{name}-{digest}"
    if binary.exists():
        return binary
    binary.parent.mkdir(parents=True, exist_ok=True)
    # Built under a temporary name and moved into place in one step: a build cut short
    # never leaves a half-written helper that looks finished.
    partial = binary.with_name(f"{binary.name}.{os.getpid()}.part")
    try:
        subprocess.run(
            ["swiftc", "-O", *flags, "-o", str(partial), str(source)],
            check=True,
            capture_output=True,
            timeout=timeout,
        )
        partial.replace(binary)
    except (OSError, subprocess.SubprocessError) as exc:
        if name not in _told:
            _told.add(name)
            log.warning("couldn't build %s (%s)", name, str(exc)[:300])
        return None
    finally:
        partial.unlink(missing_ok=True)
    return binary
