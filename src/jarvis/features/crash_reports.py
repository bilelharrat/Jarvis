"""Crash reports (audit O1): what went wrong where nobody was looking, kept on this Mac for
the owner to send when they ask for help. Off until the owner turns it on (crash_reports, in
Settings › Health › Diagnostics); on, a report is kept for each of:

- the backend: an exception nothing caught (sys.excepthook), in a thread of its own
  (threading.excepthook), or in an asyncio task nobody awaited (the loop's exception
  handler); each chained to the handler that was there, so the log still gets it as before;
- the window: window.onerror and unhandled promise rejections, forwarded by
  web/features/crash-reports.js (crash_report {kind, message, stack, where});
- the app itself: app/features/crash-reports.js starts Electron's crashReporter with
  uploadToServer false, so its minidumps stay in <data>/crash-reports/electron, and writes a
  report of its own when a window's renderer or a helper process goes away.

Each report is a small JSON file in <data>/crash-reports (KEEP of them, the newest): what
failed, its traceback or stack, when, and the versions; every string scrubbed first with the
diagnostics file's masks (ops/redact.py: tokens, keys, passwords, emails, phone numbers, the
home folder's name) and the commit check's key formats (secret_scan.PATTERNS). The same
report twice within REPEAT_SECONDS is counted, not kept again (the count written at most every
COUNT_SAVE_SECONDS, and never into a report that was deleted: a repeat of one the owner
deleted, or one pruned, is kept again as a fresh, full report; one that can't be written, a
full disk, is tried less and less often; all of them as an uncaught exception ends the
backend); at most PER_HOUR are kept an hour. An older build's local-time names are renamed
to UTC once. Names and times are UTC, as the app's own reports are (the folder is pruned by name). Nothing leaves the Mac: the diagnostics file (ops/diagnostics.py) carries the reports
and a list of the minidumps (names and sizes; a minidump is the process's memory, which
can't be masked, so it never goes in). UPLOAD_URL is the hook for sending them once there's
somewhere to send them to: empty, upload() does nothing.

Window commands: crash_report {kind, message, stack, where} (the window's own errors; kept
only while it's on), crash_reports_state -> crash_reports {on, count, folder}.

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import sys
import threading
import time
import traceback
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .. import jsonstore, secret_scan
from ..prefs import register_feature_pref
from .ops import diagnostics, redact

log = logging.getLogger("jarvis")

PREF = "crash_reports"
register_feature_pref(PREF, False)

# Where reports would be sent once there's an endpoint for them (a future askeden.com
# route). Empty: they're kept on this Mac only, and go wherever the owner sends the
# diagnostics file.
UPLOAD_URL = ""
FOLDER = "crash-reports"
ELECTRON = "electron"  # app/features/crash-reports.js: Electron's minidumps
KEEP = 50  # reports kept, the newest
PER_HOUR = 20  # reports kept in an hour, at most (a loop of failures can't fill the disk)
REPEAT_SECONDS = 600.0  # the same failure again within this is counted, not kept again
COUNT_SAVE_SECONDS = 60.0  # a report's repeat count is written at most this often
COUNT_BACKOFF_MAX = 3600.0  # a count that can't be written (a full disk) is tried this seldom, at most
# Names from before they were UTC (local time) are renamed once, so the folder's order (and
# its pruning, oldest first) is right: one whose name is further than this from when it was
# written, and right as local time, was named in local time.
NAME_SLACK = 900.0
# Left in the folder once the old names have been looked at (_utc_names): after that pass
# every report is this build's, UTC, and never looked at again (REL3-17).
UTC_DONE = ".utc-names"
TEXT_LIMIT = 4000  # a message
STACK_LIMIT = 16_000  # a traceback or a stack
SOURCES = ("backend", "window", "electron")
STORE = "crash_report"
jsonstore.register_store(STORE, 1)


def scrub(text: Any, home: Any = None, limit: int = TEXT_LIMIT) -> str:
    """A report's words as they may be kept: masked as the diagnostics file masks its logs,
    and every key format the commit check knows hidden too."""
    out = redact.text(str(text or "")[: limit * 2], home)
    for _kind, pattern in secret_scan.PATTERNS:
        out = pattern.sub(redact.MASK, out)
    return out if len(out) <= limit else out[: limit - 1] + "…"


class Reporter:
    """One hub's crash reports: kept while the owner has them on."""

    def __init__(
        self,
        hub: Any,
        folder: Path | None = None,
        clock: Callable[[], float] = time.time,
        home: Path | None = None,
    ) -> None:
        self.hub = hub
        self.folder = folder or hub.feature_path(FOLDER)
        self.clock = clock
        self._home = redact.home_pattern(home)
        self._lock = threading.Lock()
        self._recent: dict[str, tuple[float, Path]] = {}  # signature -> (when kept, file)
        # A report's repeats, counted here and written at most every COUNT_SAVE_SECONDS:
        # file -> [times so far, times written, when last written]. A failure in a tight
        # loop read and fsynced its file on every repeat.
        self._counts: dict[Path, list[float]] = {}
        self._kept_at: list[float] = []  # when each report this hour was kept
        # Reports whose count couldn't be written (a full disk): file -> failures so far.
        # Tried again only after a wait that doubles each time, never at every repeat.
        self._failed: dict[Path, int] = {}
        self._renamed = False  # the old local-time names have been made UTC (_utc_names)
        self._hooked = False

    def on(self) -> bool:
        return self.hub.prefs.feature(PREF) is True

    # ── keeping one ──

    def record(
        self,
        source: str,
        kind: str,
        message: str,
        stack: str = "",
        where: str = "",
    ) -> Path | None:
        """Keep a report (scrubbed), unless they're off, it's the same as one just kept, or
        this hour's are used up: its file, or None."""
        if not self.on() or source not in SOURCES:
            return None
        report = {
            "source": source,
            "kind": scrub(kind, self._home, 200),
            "message": scrub(message, self._home),
            "stack": scrub(stack, self._home, STACK_LIMIT),
            "where": scrub(where, self._home, 500),
        }
        signature = hashlib.sha256(
            json.dumps([source, report["kind"], report["message"], report["stack"][:2000]]).encode()
        ).hexdigest()[:16]
        now = self.clock()
        with self._lock:
            seen = self._recent.get(signature)
            if seen is not None and not seen[1].exists():
                # Its report is gone (the owner deleted it, or it was pruned): a repeat is a
                # fresh, full report, never a count into nothing (the owner's call, 2026-10-14).
                self._recent.pop(signature, None)
                self._counts.pop(seen[1], None)
                self._failed.pop(seen[1], None)
                seen = None
            if seen is not None and now - seen[0] < REPEAT_SECONDS:
                self._count_again(seen[1])
                return None
            self._kept_at = [t for t in self._kept_at if now - t < 3600]
            if len(self._kept_at) >= PER_HOUR:
                return None
            # UTC, as app/features/crash-reports.js names its own: the folder is pruned by
            # name, oldest first, and local time against UTC pruned the wrong ones.
            moment = datetime.fromtimestamp(now, UTC)
            stamp = moment.strftime("%Y%m%d-%H%M%S")
            path = self.folder / f"{stamp}-{source}-{signature[:8]}.json"
            report.update(
                at=moment.replace(tzinfo=None).isoformat(timespec="seconds"),
                times=1,
                versions=self._versions(),
            )
            try:
                jsonstore.save_store(path, STORE, report, backup=False)
            except OSError as exc:
                log.warning("crash reports: couldn't keep one (%s)", exc)
                return None
            # Counted once it's kept: a write that failed (a full disk) used the hour's
            # allowance, and once the disk had room nothing more was kept that hour (REL3-19).
            self._kept_at.append(now)
            self._recent[signature] = (now, path)
            self._counts[path] = [1, 1, now]
            if len(self._recent) > 200:
                self.flush()
                self._recent.clear()
                self._counts.clear()
            self._prune()
        self.upload(report)
        return path

    def _count_again(self, path: Path) -> None:
        """One more time for a report: counted here, written now if it hasn't been for
        COUNT_SAVE_SECONDS (the first repeat at once), else by a later repeat or flush()."""
        count = self._counts.setdefault(path, [1, 1, 0.0])
        count[0] += 1
        failed = self._failed.get(path, 0)
        if failed:  # (a full disk: tried again after a wait that doubles each time)
            # (2**failed past ~1024 failures was a float too big: OverflowError, REL3-19)
            due = min(COUNT_SAVE_SECONDS * 2 ** min(failed, 6), COUNT_BACKOFF_MAX)
        else:
            due = 0.0 if count[1] <= 1 else COUNT_SAVE_SECONDS
        if self.clock() - count[2] >= due:
            self._write_count(path, count)

    def _write_count(self, path: Path, count: list[float]) -> None:
        count[2] = self.clock()
        try:
            data = jsonstore.load_store(path, STORE)
            if not isinstance(data, dict):  # deleted (by the owner, or pruned): stays gone
                self._counts.pop(path, None)
                self._failed.pop(path, None)
                return
            data["times"] = max(int(data.get("times") or 1), 1) + int(count[0] - count[1])
            jsonstore.save_store(path, STORE, data, backup=False)
        except (OSError, TypeError, AttributeError, ValueError):  # (Unreadable is an OSError)
            self._failed[path] = self._failed.get(path, 0) + 1
            return
        count[1] = count[0]
        self._failed.pop(path, None)

    def flush(self) -> None:
        """Every repeat counted but not written yet, written (before the diagnostics file
        reads them, and when the app quits)."""
        for path, count in list(self._counts.items()):
            if count[0] != count[1]:
                self._write_count(path, count)

    @staticmethod
    def _versions() -> dict[str, Any]:
        try:
            return diagnostics.versions()
        except Exception:  # (never a reason not to keep the report)
            return {}

    def _utc_names(self) -> None:
        """Once a run: the backend's and the window's reports an older build named in local
        time renamed to UTC, as the rest are, so oldest-first is right and pruning takes
        the oldest. A name is taken as local time only when, as UTC, it's further than
        NAME_SLACK from when the file was written, and as local time it's within it (a
        count written later moves the file's time on, never back). Once, ever: a UTC name
        whose count was written long after it (flush at quit) looked like a local-time one
        west of UTC and was renamed hours off (REL3-17), so the pass leaves UTC_DONE in the
        folder and isn't made again."""
        if self._renamed:
            return
        self._renamed = True
        done = self.folder / UTC_DONE
        if done.exists():
            return
        try:
            paths = sorted(p for p in self.folder.glob("*.json") if p.is_file())
        except OSError:
            return
        for path in paths:
            stamp, _, rest = path.name[:15], path.name[15:16], path.name[16:]
            if not rest.startswith(("backend-", "window-")):
                continue
            try:
                naive = datetime.strptime(stamp, "%Y%m%d-%H%M%S")
                written = path.stat().st_mtime
            except (ValueError, OSError):
                continue
            as_utc = naive.replace(tzinfo=UTC).timestamp()
            as_local = naive.timestamp()  # (naive: the Mac's own time zone)
            if abs(written - as_utc) <= NAME_SLACK:
                continue
            if not (-60.0 <= written - as_local <= NAME_SLACK + REPEAT_SECONDS):
                continue
            utc = datetime.fromtimestamp(as_local, UTC).strftime("%Y%m%d-%H%M%S")
            new = path.with_name(f"{utc}-{rest}")
            if not new.exists():
                with contextlib.suppress(OSError):
                    path.rename(new)
        with contextlib.suppress(OSError):
            done.touch()

    def _prune(self) -> None:
        self._utc_names()
        for old in self.files()[:-KEEP]:
            with contextlib.suppress(OSError):
                old.unlink()

    def upload(self, report: dict[str, Any]) -> bool:
        """The hook for sending a report to UPLOAD_URL once there's one. Today there's none:
        nothing is sent, and the report stays in the folder."""
        if not UPLOAD_URL:
            return False
        log.info("crash reports: an upload address is set, but sending isn't built yet")
        return False

    # ── reading them back (the diagnostics file) ──

    def files(self) -> list[Path]:
        """The kept reports, oldest first."""
        try:
            return sorted(p for p in self.folder.glob("*.json") if p.is_file())
        except OSError:
            return []

    def for_diagnostics(self) -> list[tuple[str, str]]:
        """(name in the zip, its text): each report scrubbed again as it goes in (one the app
        wrote, or an older build's), and the list of the app's minidumps, names and sizes."""
        with self._lock:
            self.flush()
        out: list[tuple[str, str]] = []
        for path in self.files()[-KEEP:]:
            try:
                raw = path.read_text(encoding="utf-8", errors="replace")[: STACK_LIMIT * 3]
            except OSError:
                continue
            out.append((f"crash-reports/{path.name}", scrub(raw, self._home, STACK_LIMIT * 3)))
        dumps = []
        with contextlib.suppress(OSError):
            for dump in sorted((self.folder / ELECTRON).rglob("*.dmp")):
                info = dump.stat()
                dumps.append(
                    {
                        "name": dump.name,
                        "bytes": info.st_size,
                        "at": datetime.fromtimestamp(info.st_mtime).isoformat(timespec="seconds"),
                    }
                )
        if dumps:
            out.append(("crash-reports/minidumps.json", json.dumps(dumps[-KEEP:], indent=1)))
        return out

    def state(self) -> dict[str, Any]:
        return {"on": self.on(), "count": len(self.files()), "folder": str(self.folder)}

    # ── the window ──

    def cmd_report(self, msg: dict[str, Any]) -> None:
        self.record(
            "window",
            str(msg.get("kind") or "error")[:100],
            str(msg.get("message") or "")[: TEXT_LIMIT * 2],
            str(msg.get("stack") or "")[: STACK_LIMIT * 2],
            str(msg.get("where") or "")[:1000],
        )

    def cmd_state(self, _msg: dict[str, Any]) -> None:
        self.hub.emit("crash_reports", **self.state())

    # ── the backend's own failures ──

    def exception(self, kind: str, exc: BaseException | None, tb: Any = None) -> None:
        if exc is None or isinstance(exc, (KeyboardInterrupt, SystemExit)):
            return
        stack = "".join(traceback.format_exception(type(exc), exc, tb or exc.__traceback__))
        try:
            self.record("backend", f"{kind}: {type(exc).__name__}", str(exc), stack)
        except Exception:  # a report that fails never adds a failure of its own
            log.exception("crash reports: couldn't keep one")

    def hook(self) -> None:
        """The hooks, chained to the ones there (each still runs, as before). In the app's
        backend only: hooked from its loop, never by a test's hub."""
        if self._hooked:
            return
        self._hooked = True
        before_sys, before_thread = sys.excepthook, threading.excepthook

        def sys_hook(kind: Any, exc: BaseException, tb: Any) -> None:
            self.exception("uncaught", exc, tb)
            # An uncaught exception in the main thread ends the backend: the repeat counts
            # not written yet go now, or they're lost (REL-17). (A SIGKILL still loses up
            # to COUNT_SAVE_SECONDS of them: nothing runs then.)
            with contextlib.suppress(Exception), self._lock:
                self.flush()
            before_sys(kind, exc, tb)

        def thread_hook(args: Any) -> None:
            name = getattr(args.thread, "name", "") if args.thread is not None else ""
            self.exception(f"thread {name}".strip(), args.exc_value, args.exc_traceback)
            before_thread(args)

        sys.excepthook = sys_hook
        threading.excepthook = thread_hook
        loop = asyncio.get_running_loop()
        before_loop = loop.get_exception_handler()

        def loop_hook(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
            exc = context.get("exception")
            if isinstance(exc, BaseException):
                self.exception("asyncio task", exc)
            if before_loop is not None:
                before_loop(loop, context)
            else:
                loop.default_exception_handler(context)

        loop.set_exception_handler(loop_hook)

    async def watch(self) -> None:
        self.hook()


def install(hub: Any) -> None:
    reporter = Reporter(hub)
    hub.crash_reports = reporter
    hub.register_command("crash_report", reporter.cmd_report)
    hub.register_command("crash_reports_state", reporter.cmd_state)
    hub.register_loop("crash_reports", reporter.watch)
    add_quit_hook = getattr(hub, "add_quit_hook", None)
    if add_quit_hook is not None:
        add_quit_hook(reporter.flush)
