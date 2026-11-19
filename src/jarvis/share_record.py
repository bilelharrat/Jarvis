"""Where the running backend is, said by the backend itself: <data folder>/backend.json.

Only one backend may own the data folder (server.serve holds backend.lock), and every Eden
desktop app that finds it owned should open on that backend instead of starting its own:
Eden Code, Eden Secretary, Eden Daredevil and Ask Eden (app/eden/main.js) all share one
engine. They find it here (app/backend-share.js reads this file).

The record used to be written by the app that spawned the backend, straight after spawning,
before the backend had even tried for the lock. Two apps opening at once (Ask Eden starting
its engine, Eden Code opening a moment later) then both wrote it: the loser's backend exited
with 75 ("Another Eden backend is still using your data") after it had written over the
winner's record and taken it away again, and the app said so with nothing left to find. Now
the backend writes it, and only once it holds the lock, so the record always names the owner:
a backend still starting (no /health yet) included, and a `jarvis serve` in a terminal too.

What it holds: the port, this process's pid, the launch token, the protocol and package
version, the profile ("code" or "full"), which app started it ("app", its pid "launcher"), when
it started, and whether that app has let go of it ("released": the backend then stays up for
the other apps' windows, launcher_watch.Linger). The token is what the app's window opens
with; the file is the owner's alone (0600, written through a temporary file made 0600 first),
and app/backend-share.js refuses one anyone else could read.

PROTOCOL is what a window and the socket expect of each other (the /ws query: token, app,
since/hub; /health; /share/release and /share/shutdown). An app opens on a backend with the
same PROTOCOL; on any other it asks the owner (app/backend-handover.js). Raise it, here and in
app/backend-share.js (tests/web/backend-handover.test.mjs checks they match), whenever an app
of the new version couldn't work on a backend of the old one or the other way round.

Cost policy: no model is called; a few small file writes per start, release and stop.
"""

from __future__ import annotations

import contextlib
import json
import os
import time
from pathlib import Path
from typing import Any

FILE = "backend.json"
PROTOCOL = 1
# 76: this backend stopped to hand the data over to a newer one (/share/shutdown). The app
# that started it opens on the new one instead of starting it again (app/main.js).
HANDED_OVER = 76


def package_version() -> str:
    try:
        from importlib.metadata import version

        return version("jarvis")
    except Exception:  # run from a tree that was never installed
        return "0"


def _write(folder: Path, record: dict[str, Any]) -> bool:
    """Writes the record through a temporary file, the owner's alone from the start."""
    try:
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / FILE
        tmp = folder / f"{FILE}.{os.getpid()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(record, handle)
        with contextlib.suppress(OSError):
            os.chmod(tmp, 0o600)  # (an umask can't widen it, but a reused tmp could be wider)
        os.replace(tmp, path)
        return True
    except OSError:
        return False


def read(folder: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((folder / FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def publish(
    folder: Path,
    *,
    port: int,
    token: str,
    profile: str,
    environ: Any = None,
    now: float | None = None,
) -> dict[str, Any] | None:
    """Says this backend owns the data folder (called once it holds backend.lock). The app
    that started it is named by its own settings (JARVIS_LAUNCHER_PID, JARVIS_LAUNCHER_APP);
    a terminal's has none."""
    environ = os.environ if environ is None else environ
    try:
        launcher = int(environ.get("JARVIS_LAUNCHER_PID", "") or 0)
    except ValueError:
        launcher = 0
    record = {
        "protocol": PROTOCOL,
        "version": package_version(),
        "port": int(port),
        "pid": os.getpid(),
        "token": token,
        "profile": "code" if profile == "code" else "full",
        "app": str(environ.get("JARVIS_LAUNCHER_APP", "") or ("" if launcher else "terminal")),
        "launcher": launcher,
        "started": int((time.time() if now is None else now) * 1000),
    }
    return record if _write(folder, record) else None


def update(folder: Path, **fields: Any) -> bool:
    """Changes this backend's record (never another's: the pid must be this process's)."""
    record = read(folder)
    if not record or record.get("pid") != os.getpid():
        return False
    return _write(folder, {**record, **fields})


def withdraw(folder: Path) -> bool:
    """Takes the record away as this backend stops: only its own, and never one its app marked
    as restarting on purpose (app/backend-share.js markRestarting: the app watching it waits
    for the new one instead of starting a backend of its own)."""
    record = read(folder)
    if not record or record.get("pid") != os.getpid() or record.get("restarting"):
        return False
    with contextlib.suppress(OSError):
        (folder / FILE).unlink()
        return True
    return False
