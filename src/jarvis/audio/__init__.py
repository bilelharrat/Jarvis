"""Small native helpers for Jarvis's audio (Swift sources in this folder), built with swiftc
the first time they're needed and kept by their source's hash, as speech.ensure_player
builds the voice player. A helper that can't be built is left out and said so once; what
needed it falls back (Whisper for jarvis-hear)."""

from __future__ import annotations

import hashlib
import logging
import os
import subprocess
from pathlib import Path

log = logging.getLogger("jarvis")

HERE = Path(__file__).parent
_told: set[str] = set()  # helpers whose failed build was said in the log


def build(name: str, flags: tuple[str, ...] = ("-parse-as-library",)) -> Path | None:
    """HERE/<name>.swift built into Application Support/Jarvis/bin/<name>-<hash> (once;
    a few seconds to a minute with swiftc). None when it can't be built."""
    from ..prefs import APP_SUPPORT

    source = HERE / f"{name}.swift"
    if not source.exists():
        return None
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
            timeout=600,
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
