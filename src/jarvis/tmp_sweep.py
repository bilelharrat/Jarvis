"""The private temp folders a backend killed mid-run left behind, swept once at startup
(REL3-12): a secret run's socket folder (key_proxy.Handoffs: eden-handoff-* in the temp
folder, eden-h-* under /tmp when that path is too long for a socket) and a container's relay
folder (container_run.Relay: edc-*). Each is the owner's, 0700, and holds only unix sockets;
nothing ever removed them but a clean quit, so every crash or kill left one.

Only what is certainly dead goes, since another backend may be running beside this one
(Eden Code and Eden Secretary share one, a development backend beside the installed app):
a folder of the owner's, not touched for STALE_SECONDS, whose sockets are all older than
that too; a relay's socket must also refuse a connection (nothing listens). A handoff's
socket is never connected to: whoever connects first takes the run, so a look would spend a
live one. A handoff socket lives a minute at most (HANDOFF_SECONDS), so one an hour old is a
dead backend's. Nothing but sockets and the folder itself is ever removed.

Cost policy (Claude): this never calls a model.
"""

from __future__ import annotations

import contextlib
import logging
import os
import socket
import stat
import tempfile
import time
from pathlib import Path

log = logging.getLogger("jarvis")

STALE_SECONDS = 3600.0
HANDOFF_PREFIXES = ("eden-handoff-", "eden-h-")
RELAY_PREFIX = "edc-"


def _listening(path: Path) -> bool:
    """Whether something accepts on a relay's socket (a live backend's relay)."""
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.5)
    try:
        probe.connect(str(path))
    except OSError:
        return False
    else:
        return True
    finally:
        probe.close()


def _dead(folder: Path, relay: bool, now: float) -> list[Path] | None:
    """A leftover folder's sockets when it's certainly no live backend's (see the module's
    words), else None. Only these are removed: one made since is never touched (the folder
    is then not empty, and stays)."""
    st = folder.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
        return None
    if now - st.st_mtime < STALE_SECONDS:
        return None
    found = []
    for entry in folder.iterdir():
        est = entry.lstat()
        if not stat.S_ISSOCK(est.st_mode) or now - est.st_mtime < STALE_SECONDS:
            return None  # (something else in it, or a socket in use lately: left alone)
        if relay and _listening(entry):
            return None
        found.append(entry)
    return found


def sweep(roots: list[Path] | None = None, now: float | None = None) -> list[Path]:
    """The dead leftover folders under roots (the temp folder and /tmp), removed: their
    paths."""
    if not hasattr(socket, "AF_UNIX") or not hasattr(os, "getuid"):
        return []
    now = time.time() if now is None else now
    if roots is None:
        roots = list(dict.fromkeys([Path(tempfile.gettempdir()), Path("/tmp")]))
    gone = []
    for root in roots:
        try:
            names = os.listdir(root)
        except OSError:
            continue
        for name in names:
            relay = name.startswith(RELAY_PREFIX)
            if not relay and not name.startswith(HANDOFF_PREFIXES):
                continue
            folder = root / name
            try:
                sockets = _dead(folder, relay, now)
                if sockets is None:
                    continue
                for entry in sockets:
                    entry.unlink()
                folder.rmdir()
            except OSError:
                continue
            gone.append(folder)
    if gone:
        log.info("swept %d temp folder(s) a stopped backend left behind", len(gone))
    return gone


def remove_empty(*folders: Path | None) -> None:
    """At quit: this backend's own folders, removed when nothing is left in them."""
    for folder in folders:
        if folder is not None:
            with contextlib.suppress(OSError):
                folder.rmdir()
