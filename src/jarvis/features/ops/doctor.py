"""The checkup: is everything JARVIS needs in place, and what to do about what isn't.

Each check says ok, warn, problem, info or unknown, in a sentence, with a plain hint and,
for the few fixes that are always safe (rebuild an index, put damaged copies away after a
backup, reconnect accounts), a fix the window offers behind a confirmation. Nothing here
changes anything: the checks only look. They never bind a port (lsof says who has 8765),
never read a secret (the Claude sign-in is Claude's own `auth status`), and every command
they run is a short read-only one, all through Probe.run so tests replace them.

Cost: no model is called. By voice ("run a checkup") it's one tool call inside the turn
the owner started.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import os
import re
import shlex
import shutil
import sqlite3
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from . import permissions, redact
from .backup import store_name
from .permissions import Runner, run_process

STATES = ("problem", "warn", "unknown", "info", "ok")  # worst first
GROUPS = {"permissions": "Permissions", "jarvis": "Jarvis", "data": "Your data"}
LOG_WINDOW = timedelta(hours=1)
LAST_LINES = 5
LOG_TAIL = 4 * 1024 * 1024  # bytes of a log read back for the last hour
FREE_WARN = 10 * 1024**3
FREE_PROBLEM = 2 * 1024**3
STALE_INDEX = timedelta(hours=3)
STALE_BRAIN_HOURS = 48
QUICK_CHECK_SECONDS = 5.0
COMPANION_PORT = 8765
# Claude processes beyond the open sessions that are still fine: a summary, a draft or a
# research step runs a short one of its own.
PROCESS_SLACK = 2
_LOG_LINE = re.compile(
    r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)(?:,\d+)? (DEBUG|INFO|WARNING|ERROR|CRITICAL) "
)
_BAD_COPY = re.compile(r"^(?P<name>.+\.json)\.bad-(?P<stamp>\d{8}-\d{6})(?:-\d+)?$")


@dataclass
class Probe:
    """Where the checkup looks. Everything is replaceable, so tests never touch the real
    Mac: its folders, its processes or its commands."""

    data: Path
    logs: Path
    home: Path
    run: Runner = run_process
    now: Callable[[], datetime] = datetime.now
    own_pid: int = field(default_factory=os.getpid)
    disk_free: Callable[[Path], int] = lambda path: shutil.disk_usage(path).free
    processes: Callable[[], list[dict[str, Any]]] | None = None
    children: Callable[[int], set[int]] | None = None
    whisper_cached: Callable[[str], bool | None] | None = None
    claude_cli: Callable[[], str | None] | None = None
    login_command: Callable[[str], str] | None = None
    # The API key JARVIS signs in with, checked with Anthropic now ({"ok", "error",
    # "hint"}), or None when it signs in with the Claude account (features/signin.py).
    key_signin: Callable[[], Awaitable[dict[str, Any] | None]] | None = None
    # The app people download: no repo, no uv, no swiftc (packaged.is_packaged).
    packaged: Callable[[], bool] | None = None
    helpers_dir: Callable[[], Path | None] | None = None


def check(
    cid: str,
    group: str,
    title: str,
    state: str,
    summary: str,
    hint: str = "",
    *,
    meta: str = "",
    details: list[str] | None = None,
    fix: dict[str, str] | None = None,
    pane: str = "",
    command: str = "",
    words: bool = False,
) -> dict[str, Any]:
    """One check as the window shows it. details are the owner's data (log lines, file and
    account names) unless words: then they're the window's own and get translated."""
    return {
        "id": cid,
        "group": group,
        "title": title,
        "state": state,
        "summary": summary,
        "hint": hint,
        "meta": meta,
        "details": details or [],
        "fix": fix,
        "pane": pane,
        "command": command,
        "details_words": words,
    }


# ── permissions ──

PERMISSION_STATE = {
    "granted": "ok",
    "not_asked": "warn",
    "limited": "warn",
    "not_running": "info",
    "unknown": "unknown",
    "denied": "problem",
    "off": "problem",
    "restricted": "problem",
}


def permission_checks(found: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for row in permissions.rows(found):
        details = [f"{a['app']}: {a['label']}" for a in row["apps"]]
        out.append(
            check(
                f"perm:{row['id']}",
                "permissions",
                row["title"],
                PERMISSION_STATE[row["state"]],
                row["label"],
                row["hint"],
                details=details,
                pane=row["id"] if row["state"] != "granted" else "",
                words=True,
            )
        )
    return out


# ── Claude ──


def claude_cli() -> str | None:
    """The Claude engine JARVIS runs: the SDK's own bundled one, else what the SDK falls
    back to (claude on the PATH, then its usual install places)."""
    with contextlib.suppress(Exception):
        import claude_agent_sdk

        bundled = Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude"
        if bundled.is_file():
            return str(bundled)
    found = shutil.which("claude")
    if found:
        return found
    home = Path.home()
    for place in (
        home / ".npm-global/bin/claude",
        Path("/usr/local/bin/claude"),
        home / ".local/bin/claude",
        home / "node_modules/.bin/claude",
        home / ".yarn/bin/claude",
        home / ".claude/local/claude",
    ):
        if place.is_file():
            return str(place)
    return None


def login_command(cli: str) -> str:
    """What to type in Terminal to sign in: plain `claude` when that's on the PATH (it
    shares the sign-in), else the engine's own path."""
    return "claude auth login" if shutil.which("claude") else f"{shlex.quote(cli)} auth login"


PLANS = {"max": "Max", "pro": "Pro", "team": "Team", "enterprise": "Enterprise"}


def _last_json(text: str) -> dict[str, Any] | None:
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            with contextlib.suppress(ValueError):
                data = json.loads(line)
                return data if isinstance(data, dict) else None
    with contextlib.suppress(ValueError):
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    return None


def _packaged(probe: Probe) -> bool:
    if probe.packaged is not None:
        return probe.packaged()
    from ... import packaged

    return packaged.is_packaged()


async def claude_check(probe: Probe) -> dict[str, Any]:
    cli = (probe.claude_cli or claude_cli)()
    title = "Claude sign-in"
    bundled = _packaged(probe)
    if not cli:
        return check(
            "claude",
            "jarvis",
            title,
            "problem",
            "Jarvis's Claude engine is missing",
            "Install Jarvis again from its disk image, then open it."
            if bundled
            else "Run uv sync in Jarvis's folder to put it back, then restart Jarvis.",
        )
    version = ""
    with contextlib.suppress(OSError, TimeoutError, ValueError):
        code, out, _err = await probe.run(cli, "--version", timeout=15)
        if code == 0:
            version = out.strip().split(" ")[0][:40]
    key = None
    if probe.key_signin is not None:
        with contextlib.suppress(Exception):
            key = await probe.key_signin()
    if key is not None:  # signed in with the user's own API key, asked of Anthropic now
        if key.get("ok"):
            meta = " · ".join(x for x in ("API key", version) if x)
            return check("claude", "jarvis", title, "ok", "Signed in", meta=meta)
        return check(
            "claude",
            "jarvis",
            title,
            "problem",
            "Anthropic didn't take the API key",
            "Remove it in Setup's Claude step and paste a working one (console.anthropic.com "
            "› API keys).",
            meta=version,
            details=[str(key.get("error") or "")[:300], str(key.get("hint") or "")],
        )
    try:
        _code, out, _err = await probe.run(cli, "auth", "status", "--json", timeout=20)
        status = _last_json(out)
    except (OSError, TimeoutError, ValueError):
        status = None
    if status is None or not isinstance(status.get("loggedIn"), bool):
        return check(
            "claude",
            "jarvis",
            title,
            "unknown",
            "Couldn't tell",
            "Claude didn't answer just now. Try again in a moment.",
            meta=version,
        )
    if not status["loggedIn"]:
        if bundled:  # its way in is the user's own API key, not a Claude account login
            return check(
                "claude",
                "jarvis",
                title,
                "problem",
                "Not signed in",
                "Paste your Anthropic API key in Setup's Claude step (console.anthropic.com "
                "› API keys).",
                meta=version,
            )
        return check(
            "claude",
            "jarvis",
            title,
            "problem",
            "Not signed in",
            "Sign in once in Terminal with the command below, then check again.",
            meta=version,
            command=(probe.login_command or login_command)(cli),
        )
    how = "API key" if str(status.get("authMethod", "")).lower().startswith("api") else ""
    plan = PLANS.get(str(status.get("subscriptionType", "")).lower(), how)
    return check(
        "claude",
        "jarvis",
        title,
        "ok",
        "Signed in",
        meta=" · ".join(x for x in (plan, version) if x),
    )


# ── the speech model and the Swift compiler ──


def whisper_cached(name: str) -> bool | None:
    """Whether faster-whisper's model is on this Mac already (Hugging Face's cache, read
    locally: nothing is fetched). None when that can't be told."""
    if os.path.isdir(name):
        return (Path(name) / "model.bin").is_file()
    try:
        from faster_whisper.utils import _MODELS
        from huggingface_hub import try_to_load_from_cache
    except Exception:
        return None
    try:
        hit = try_to_load_from_cache(_MODELS.get(name, name), "model.bin")
    except Exception:
        return None
    return isinstance(hit, str)


def whisper_check(probe: Probe, model: str, loaded: bool) -> dict[str, Any]:
    title = "Speech recognition"
    if loaded:
        return check("whisper", "jarvis", title, "ok", "Loaded", meta=model)
    cached = (probe.whisper_cached or whisper_cached)(model)
    if cached:
        return check("whisper", "jarvis", title, "ok", "Downloaded", meta=model)
    if cached is None:
        return check("whisper", "jarvis", title, "unknown", "Couldn't tell", meta=model)
    return check(
        "whisper",
        "jarvis",
        title,
        "warn",
        "Not downloaded yet",
        "It downloads by itself the next time Jarvis starts with an internet connection.",
        meta=model,
    )


def _prebuilt_helpers(probe: Probe) -> Path | None:
    if probe.helpers_dir is not None:
        return probe.helpers_dir()
    from ...swift_helper import HELPERS_ENV

    folder = os.environ.get(HELPERS_ENV, "").strip()
    return Path(folder) if folder else None


async def swift_check(probe: Probe) -> dict[str, Any]:
    """xcode-select first: with no developer tools, the swiftc in /usr/bin is only a stub
    that offers to install them. The app people download carries its helpers prebuilt and
    needs no compiler: that's said instead (and nothing is run)."""
    title = "Swift compiler"
    folder = _prebuilt_helpers(probe)
    if folder is not None:
        if (folder / "helpers.json").is_file():
            return check(
                "swiftc", "jarvis", title, "ok", "Not needed: Jarvis's helpers are built in"
            )
        return check(
            "swiftc",
            "jarvis",
            title,
            "warn",
            "Jarvis's built-in helpers are missing",
            "Install Jarvis again from its disk image, then open it.",
        )
    hint = (
        "Some of Jarvis's native helpers can't be built, so it uses slower fallbacks. "
        "Install Xcode, or run xcode-select --install in Terminal."
    )
    try:
        code, _out, _err = await probe.run("xcode-select", "-p", timeout=10)
        if code != 0:
            return check("swiftc", "jarvis", title, "warn", "Not installed", hint)
        code, out, _err = await probe.run("xcrun", "--find", "swiftc", timeout=15)
    except (OSError, TimeoutError):
        return check("swiftc", "jarvis", title, "unknown", "Couldn't tell")
    if code != 0 or not out.strip():
        return check("swiftc", "jarvis", title, "warn", "Not installed", hint)
    return check("swiftc", "jarvis", title, "ok", "Installed", meta=out.strip()[:200])


# ── this Mac ──


def _gb(n: int) -> str:
    return f"{n / 1024**3:.1f}" if n < 10 * 1024**3 else f"{n / 1024**3:.0f}"


def disk_check(probe: Probe) -> dict[str, Any]:
    title = "Free disk space"
    try:
        free = probe.disk_free(probe.data if probe.data.exists() else probe.home)
    except OSError:
        return check("disk", "data", title, "unknown", "Couldn't tell")
    summary = f"{_gb(free)} GB free"
    if free < FREE_PROBLEM:
        state = "problem"
    elif free < FREE_WARN:
        state = "warn"
    else:
        return check("disk", "data", title, "ok", summary)
    return check(
        "disk",
        "data",
        title,
        state,
        summary,
        "Free up some space: Jarvis needs room for its index, recordings and backups.",
    )


async def port_check(probe: Probe, companion_on: bool) -> dict[str, Any]:
    """Who listens on the companion's port, from lsof: it's never bound to find out."""
    title = "Phone companion port"
    try:
        code, out, _err = await probe.run(
            "lsof", "-nP", f"-iTCP:{COMPANION_PORT}", "-sTCP:LISTEN", "-Fpc", timeout=10
        )
    except (OSError, TimeoutError):
        return check("port", "jarvis", title, "unknown", "Couldn't tell", meta=str(COMPANION_PORT))
    holders: list[tuple[int, str]] = []
    pid = 0
    for line in out.splitlines():
        if line.startswith("p") and line[1:].isdigit():
            pid = int(line[1:])
        elif line.startswith("c") and pid:
            holders.append((pid, line[1:][:60]))
            pid = 0
    if code not in (0, 1):
        return check("port", "jarvis", title, "unknown", "Couldn't tell", meta=str(COMPANION_PORT))
    others = [(p, c) for p, c in holders if p != probe.own_pid]
    if others:
        pid, command = others[0]
        return check(
            "port",
            "jarvis",
            title,
            "problem" if companion_on else "warn",
            "Used by another app",
            "Another app is using port 8765, so the phone companion can't start. Quit that "
            "app, then turn the companion on again.",
            meta=f"{command} ({pid})",
        )
    if holders:
        return check("port", "jarvis", title, "ok", "In use by the phone companion", meta="8765")
    if companion_on:
        return check(
            "port",
            "jarvis",
            title,
            "problem",
            "The phone companion isn't listening",
            "Turn the phone companion off and on again in Settings › iPhone & Watch.",
            meta="8765",
        )
    return check("port", "jarvis", title, "ok", "Not in use", meta="8765")


def _snapshot() -> list[dict[str, Any]]:
    import psutil

    out = []
    for proc in psutil.process_iter(["pid", "ppid", "exe", "memory_info"]):
        info = proc.info
        memory = info.get("memory_info")
        out.append(
            {
                "pid": info.get("pid"),
                "ppid": info.get("ppid"),
                "exe": info.get("exe") or "",
                "rss": getattr(memory, "rss", 0) or 0,
            }
        )
    return out


def _children(pid: int) -> set[int]:
    import psutil

    try:
        return {p.pid for p in psutil.Process(pid).children(recursive=True)}
    except psutil.Error:
        return set()


def process_check(probe: Probe, open_sessions: int) -> dict[str, Any]:
    """Claude engines this run started, and ones an earlier run left behind (orphaned:
    their parent gone, so launchd has them). Only JARVIS's own engine counts: the owner's
    other Claude apps run their own."""
    title = "Claude processes"
    cli = (probe.claude_cli or claude_cli)()
    if not cli:
        return check("processes", "jarvis", title, "unknown", "Couldn't tell")
    target = os.path.realpath(cli)
    try:
        procs = (probe.processes or _snapshot)()
        mine = (probe.children or _children)(probe.own_pid)
    except Exception:
        return check("processes", "jarvis", title, "unknown", "Couldn't tell")
    ours, left = [], []
    for proc in procs:
        exe = str(proc.get("exe") or "")
        if not exe or os.path.realpath(exe) != target:
            continue
        if proc.get("pid") in mine:
            ours.append(proc)
        elif proc.get("ppid") == 1:
            left.append(proc)
    if left:
        mb = sum(int(p.get("rss") or 0) for p in left) // (1024 * 1024)
        return check(
            "processes",
            "jarvis",
            title,
            "warn",
            f"{len(left)} left from an earlier run",
            "They belong to a run of Jarvis that has ended. Quitting them in Activity "
            "Monitor (they're named claude) frees their memory.",
            meta=f"{mb} MB",
            details=[f"pid {p.get('pid')}" for p in left[:10]],
        )
    if len(ours) > open_sessions + PROCESS_SLACK:
        return check(
            "processes",
            "jarvis",
            title,
            "warn",
            f"{len(ours)} running for {open_sessions} open sessions",
            "Some may be left over from sessions that have ended; if they stay after Jarvis "
            "quits, the next checkup lists them.",
        )
    summary = f"{len(ours)} running for open sessions" if ours else "None running"
    return check("processes", "jarvis", title, "ok", summary)


# ── logs ──


def _tail(path: Path, limit: int = LOG_TAIL) -> str:
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - limit))
            raw = fh.read(limit)
    except OSError:
        return ""
    text = raw.decode("utf-8", errors="replace")
    return text.split("\n", 1)[1] if size > limit and "\n" in text else text


def log_errors(logs: Path, now: datetime) -> tuple[int, list[str], bool]:
    """(ERROR and CRITICAL records in the last hour, the last few, whether there's a log).
    jarvis.log has full timestamps; its rotated copy is read too when the hour spans it."""
    since = now - LOG_WINDOW
    found: list[str] = []
    seen_any = False
    for name in ("jarvis.log.1", "jarvis.log"):
        path = logs / name
        if not path.exists():
            continue
        seen_any = True
        for line in _tail(path).splitlines():
            m = _LOG_LINE.match(line)
            if not m or m.group(2) not in ("ERROR", "CRITICAL"):
                continue
            try:
                at = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
            if since <= at <= now + timedelta(minutes=5):
                found.append(line)
    return len(found), found[-LAST_LINES:], seen_any


def log_check(probe: Probe) -> dict[str, Any]:
    title = "Errors in the log"
    count, last, seen = log_errors(probe.logs, probe.now())
    if not seen:
        return check("logs", "jarvis", title, "info", "No log yet")
    if not count:
        return check("logs", "jarvis", title, "ok", "None in the last hour")
    home = redact.home_pattern(probe.home)
    return check(
        "logs",
        "jarvis",
        title,
        "problem" if count >= 20 else "warn",
        f"{count} in the last hour" if count != 1 else "1 in the last hour",
        "If something isn't working, make a diagnostics file and share it when you ask for help.",
        details=[redact.line(line, home, limit=300) for line in last],
    )


# ── the data folder ──


def _stamp_of(stamp: str) -> str:
    with contextlib.suppress(ValueError):
        return datetime.strptime(stamp, "%Y%m%d-%H%M%S").strftime("%Y-%m-%d %H:%M")
    return stamp


def damaged_copies(data: Path) -> list[Path]:
    """The .bad-<stamp> copies jsonstore set aside, beside the stores and in brain/."""
    out: list[Path] = []
    for folder in (data, data / "brain"):
        with contextlib.suppress(OSError), os.scandir(folder) as entries:
            for entry in entries:
                if _BAD_COPY.match(entry.name) and entry.is_file(follow_symlinks=False):
                    out.append(Path(entry.path))
    return sorted(out)[:200]


def damaged_now(data: Path) -> list[str]:
    """Stores whose file doesn't read as JSON right now (a hand edit, a disk fault)."""
    out: list[str] = []
    with contextlib.suppress(OSError), os.scandir(data) as entries:
        for entry in entries:
            if not (store_name(entry.name) and entry.is_file(follow_symlinks=False)):
                continue
            try:
                if entry.stat(follow_symlinks=False).st_size > 32 * 1024 * 1024:
                    continue  # large: its store reads it, and says if it can't
                raw = Path(entry.path).read_bytes()
                if raw.strip():
                    json.loads(raw.decode("utf-8-sig"))
            except (ValueError, UnicodeDecodeError, RecursionError):
                out.append(entry.name)
            except OSError:
                continue
    return sorted(out)


def damaged_check(probe: Probe) -> dict[str, Any]:
    title = "Damaged data files"
    now = damaged_now(probe.data)
    copies = damaged_copies(probe.data)
    if now:
        return check(
            "damaged",
            "data",
            title,
            "problem",
            f"{len(now)} can't be read" if len(now) != 1 else "1 can't be read",
            "Restart Jarvis: it sets a damaged file aside and goes back to its last good copy.",
            details=now,
        )
    if copies:
        details = []
        for path in copies[:20]:
            m = _BAD_COPY.match(path.name)
            rel = path.relative_to(probe.data)
            name = str(rel.parent / m.group("name")) if rel.parent != Path(".") else m.group("name")
            details.append(f"{name} · {_stamp_of(m.group('stamp'))}")
        return check(
            "damaged",
            "data",
            title,
            "warn",
            f"{len(copies)} damaged copies kept aside"
            if len(copies) != 1
            else "1 damaged copy kept aside",
            "Jarvis set these aside and carried on with the last good copy, so nothing needs "
            "doing. Once you're sure nothing is missing, put them away.",
            details=details,
            fix={
                "id": "tidy_damaged",
                "label": "Put them away",
                "confirm": "Back up your data first, then move the damaged copies into the "
                "Damaged files folder inside Jarvis's data folder?",
            },
        )
    return check("damaged", "data", title, "ok", "None")


def quick_check(db: Path, seconds: float = QUICK_CHECK_SECONDS) -> str:
    """SQLite's quick_check on the file index, read-only and stopped after `seconds`:
    ok | damaged | slow | missing | busy."""
    if not db.is_file():
        return "missing"
    deadline = time.monotonic() + seconds
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
    except sqlite3.Error:
        return "damaged"
    try:
        conn.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 5000)
        rows = conn.execute("PRAGMA quick_check(1)").fetchall()
        return "ok" if rows == [("ok",)] else "damaged"
    except sqlite3.OperationalError as exc:
        text = str(exc).lower()
        if "interrupt" in text:
            return "slow"
        return "busy" if "locked" in text or "busy" in text else "damaged"
    except sqlite3.DatabaseError:
        return "damaged"
    finally:
        conn.close()


REBUILD_FILES = {
    "id": "rebuild_file_index",
    "label": "Rebuild",
    "confirm": "Rebuild the file index? It starts again from nothing and fills back in, in "
    "the background.",
}
REBUILD_BRAIN = {
    "id": "rebuild_knowledge",
    "label": "Rebuild",
    "confirm": "Rebuild the second brain's index now? It runs in the background.",
}


def file_index_check(
    probe: Probe, on: bool, status: dict[str, Any], db: Path | None
) -> dict[str, Any]:
    title = "File index"
    if not on:
        return check("file_index", "data", title, "info", "Off")
    health = quick_check(db) if db is not None else "missing"
    files = int(status.get("files") or 0)
    last = status.get("last") if isinstance(status.get("last"), dict) else {}
    if health == "damaged":
        return check(
            "file_index",
            "data",
            title,
            "problem",
            "Damaged",
            "Rebuild it: it's only a list of what's on your disk, so nothing is lost.",
            fix=REBUILD_FILES,
        )
    if status.get("state") in ("indexing", "running"):
        return check("file_index", "data", title, "info", "Updating now", meta=f"{files:,}")
    if last.get("error"):
        return check(
            "file_index",
            "data",
            title,
            "warn",
            "Its last update didn't finish",
            "It tries again every half hour; rebuild it if this keeps happening.",
            fix=REBUILD_FILES,
            meta=f"{files:,}",
        )
    refreshed = str(status.get("refreshed_at") or "")
    if not refreshed:
        return check("file_index", "data", title, "info", "Not built yet")
    with contextlib.suppress(ValueError):
        if probe.now() - datetime.fromisoformat(refreshed) > STALE_INDEX:
            return check(
                "file_index",
                "data",
                title,
                "warn",
                "Not updated for a while",
                "It updates every half hour while Jarvis runs; rebuild it if this stays.",
                fix=REBUILD_FILES,
                meta=f"{files:,}",
            )
    summary = f"{files:,} files" if files != 1 else "1 file"
    return check("file_index", "data", title, "ok", summary, meta=refreshed[:16].replace("T", " "))


def knowledge_check(
    summary: dict[str, Any], state: dict[str, Any], age_hours: float, sources_on: bool
) -> dict[str, Any]:
    title = "Second brain index"
    notes = int(summary.get("notes") or 0)
    if state.get("state") == "building":
        return check("knowledge", "data", title, "info", "Updating now")
    if state.get("state") == "error":
        return check(
            "knowledge",
            "data",
            title,
            "problem",
            "Its last update didn't finish",
            "Rebuild it; if it fails again, the reason is under Settings › Second brain.",
            details=[redact.line(str(state.get("detail", "")), limit=300)]
            if state.get("detail")
            else [],
            fix=REBUILD_BRAIN,
        )
    if not sources_on:
        return check("knowledge", "data", title, "info", "No sources are on")
    if not notes:
        return check(
            "knowledge",
            "data",
            title,
            "warn",
            "Empty",
            "Build it now, or it builds by itself within a day.",
            fix=REBUILD_BRAIN,
        )
    if math.isfinite(age_hours) and age_hours > STALE_BRAIN_HOURS:
        days = min(int(age_hours // 24), 9999)
        return check(
            "knowledge",
            "data",
            title,
            "warn",
            f"Not updated for {days} days",
            "It updates by itself once a day while Jarvis runs; rebuild it now if you like.",
            fix=REBUILD_BRAIN,
            meta=f"{notes:,}",
        )
    return check("knowledge", "data", title, "ok", f"{notes:,} notes" if notes != 1 else "1 note")


def connectors_check(connections: list[dict[str, Any]]) -> dict[str, Any]:
    title = "Connected accounts"
    enabled = [c for c in connections if c.get("status") != "off"]
    if not enabled:
        return check("connectors", "jarvis", title, "info", "None connected")
    broken = [c for c in enabled if c.get("status") in ("error", "disconnected")]
    working = [c for c in enabled if c.get("status") == "connected"]
    if broken:
        details = []
        for conn in broken[:10]:
            why = redact.line(str(conn.get("error") or ""), limit=160)
            details.append(f"{conn.get('name', '')}: {why}" if why else str(conn.get("name", "")))
        return check(
            "connectors",
            "jarvis",
            title,
            "warn",
            f"{len(broken)} couldn't connect" if len(broken) != 1 else "1 couldn't connect",
            "Reconnect them; one that still fails may need signing in again in Tools & Accounts.",
            details=details,
            fix={
                "id": "restart_connectors",
                "label": "Reconnect",
                "confirm": "Reconnect the accounts that couldn't connect?",
            },
        )
    if len(working) < len(enabled):
        return check("connectors", "jarvis", title, "info", "Connecting…")
    return check(
        "connectors",
        "jarvis",
        title,
        "ok",
        f"{len(working)} connected" if len(working) != 1 else "1 connected",
    )


def backups_check(info: dict[str, Any], now: datetime) -> dict[str, Any]:
    title = "Backups"
    if info.get("error"):
        return check(
            "backups",
            "data",
            title,
            "problem",
            "The backup folder isn't available",
            "Choose another folder in Backups, or connect the drive it's on.",
            meta=str(info.get("folder", ""))[:200],
        )
    newest = info.get("newest")
    daily = bool(info.get("daily"))
    if not newest:
        return check(
            "backups",
            "data",
            title,
            "warn",
            "No backup yet",
            "Make one in Backups. With daily backups on, one is made each day.",
        )
    try:
        made = datetime.fromisoformat(str(newest.get("created")))
    except ValueError:
        made = None
    days = (now.date() - made.date()).days if made else None
    if days is None:
        summary = "Last one: unknown"
    elif days <= 0:
        summary = "Last one today"
    elif days == 1:
        summary = "Last one yesterday"
    else:
        summary = f"Last one {days} days ago"
    if not daily:
        return check(
            "backups",
            "data",
            title,
            "info",
            summary,
            "Daily backups are off: turn them on in Backups.",
        )
    if days is not None and days > 2:
        return check(
            "backups",
            "data",
            title,
            "warn",
            summary,
            "Daily backups are on but none was made lately. Check the backup folder is there.",
        )
    return check("backups", "data", title, "ok", summary)


# ── all of it ──


def summarize(checks: list[dict[str, Any]]) -> dict[str, Any]:
    counts = {state: 0 for state in STATES}
    for item in checks:
        counts[item["state"]] = counts.get(item["state"], 0) + 1
    worst = next((s for s in STATES if counts.get(s)), "ok")
    return {"counts": counts, "worst": worst}


def spoken(result: dict[str, Any]) -> str:
    """The checkup in a few words for Claude to say (never a log line or a file's words)."""
    checks = result.get("checks", [])
    attention = [c for c in checks if c["state"] in ("problem", "warn")]
    fine = sum(1 for c in checks if c["state"] == "ok")
    if not attention:
        return (
            f"Checkup done: all {fine} checks are fine. Details are in Settings › Health & safety."
        )
    parts = [f"{c['title']}: {c['summary']}" for c in attention[:6]]
    more = f" and {len(attention) - 6} more" if len(attention) > 6 else ""
    return (
        f"Checkup done: {fine} fine, {len(attention)} to look at: "
        + "; ".join(parts)
        + more
        + ". Details and fixes are in Settings › Health & safety."
    )


async def run(probe: Probe, hub_state: dict[str, Any]) -> dict[str, Any]:
    """Every check, the slow ones side by side. hub_state is what the hub knows, read on
    its loop beforehand (see Ops.hub_state)."""
    found, claude, swift, port = await asyncio.gather(
        permissions.statuses(probe.run),
        claude_check(probe),
        swift_check(probe),
        port_check(probe, bool(hub_state.get("companion_on"))),
    )
    local = await asyncio.to_thread(
        lambda: [
            whisper_check(
                probe, hub_state.get("whisper_model", ""), hub_state.get("whisper_loaded")
            ),
            process_check(probe, int(hub_state.get("open_sessions") or 0)),
            log_check(probe),
            disk_check(probe),
            damaged_check(probe),
            file_index_check(
                probe,
                bool(hub_state.get("file_index_on")),
                hub_state.get("file_index") or {},
                hub_state.get("file_index_db"),
            ),
        ]
    )
    whisper, processes, logs, disk, damaged, files = local
    checks = [
        *permission_checks(found),
        claude,
        whisper,
        connectors_check(hub_state.get("connections") or []),
        logs,
        processes,
        port,
        swift,
        disk,
        damaged,
        files,
        knowledge_check(
            hub_state.get("knowledge") or {},
            hub_state.get("brain_state") or {},
            float(hub_state.get("knowledge_age", math.inf)),
            bool(hub_state.get("knowledge_sources")),
        ),
        backups_check(hub_state.get("backups") or {}, probe.now()),
    ]
    return {
        "at": probe.now().isoformat(timespec="seconds"),
        "checks": checks,
        "groups": GROUPS,
        **summarize(checks),
    }
