"""A backend the J.A.R.V.I.S. app started goes when the app does.

The app runs the backend as its child (through uv when it runs from the repo). If the app
quits or crashes without stopping it, the backend kept running on its own, holding the data
folder's lock: the next app's backend then waited for it ("Another JARVIS backend is still
using your data") and gave up. Now the backend finds the app among its ancestors when it
starts and, once that process is gone, stops itself: gently (SIGTERM, as a quit does), and
for good after STOP_GRACE seconds if that hangs (the lock goes with the process).

A backend nobody's app started (a terminal, the cloud server's systemd) has no app to watch.
"""

from __future__ import annotations

import logging
import os
import signal
import threading
import time
from collections.abc import Callable
from typing import Any

log = logging.getLogger("jarvis")

CHECK_EVERY = 3.0
STOP_GRACE = 20.0
APP_MARK = ".app/Contents/MacOS/"


def find_app(process: Any, bundle: str = "", depth: int = 4) -> Any:
    """The app among this process's ancestors (psutil processes): the bundle's executable
    when JARVIS_APP_BUNDLE says which, else the first one inside a .app. None without one."""
    current = process
    for _ in range(depth):
        try:
            current = current.parent()
            if current is None or current.pid <= 1:
                return None
            exe = current.exe() or ""
        except Exception:  # gone, or not ours to look at
            return None
        if (bundle and exe.startswith(bundle.rstrip("/") + "/Contents/MacOS/")) or (
            not bundle and APP_MARK in exe
        ):
            return current
    return None


class Watch:
    """Stops this backend once the app is gone."""

    def __init__(
        self,
        alive: Callable[[], bool],
        stop: Callable[[], None],
        force: Callable[[], None],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.alive, self.stop, self.force, self.clock = alive, stop, force, clock
        self.stopping_since: float | None = None

    def check(self) -> str:
        """One look: "" (the app's there), "stop" (asked to stop), "force" (it hung)."""
        if self.stopping_since is not None:
            if self.clock() - self.stopping_since >= STOP_GRACE:
                self.force()
                return "force"
            return ""
        if self.alive():
            return ""
        log.info("the J.A.R.V.I.S. app that started this backend has quit: stopping")
        self.stopping_since = self.clock()
        self.stop()
        return "stop"


def start() -> threading.Thread | None:
    """Watches the app that started this process, if one did (a daemon thread)."""
    try:
        import psutil
    except ImportError:
        return None
    try:
        me = psutil.Process()
        app = find_app(me, os.environ.get("JARVIS_APP_BUNDLE", ""))
        if app is None:
            return None
        born = app.create_time()
    except Exception:
        return None

    def alive() -> bool:
        try:  # the same process: a reused pid is another one
            return app.is_running() and app.create_time() == born
        except Exception:
            return False

    watch = Watch(
        alive,
        stop=lambda: os.kill(os.getpid(), signal.SIGTERM),
        force=lambda: (log.warning("stopping didn't finish in time: ending now"), os._exit(0)),
    )

    def loop() -> None:
        while True:
            time.sleep(CHECK_EVERY)
            watch.check()

    thread = threading.Thread(target=loop, name="launcher-watch", daemon=True)
    thread.start()
    return thread
