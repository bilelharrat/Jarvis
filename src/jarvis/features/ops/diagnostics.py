"""A diagnostics file to share when asking for help: the recent logs with every secret
masked, the versions of what JARVIS runs on, a fresh checkup and the security review's
headlines. It's written to the owner's Documents and goes nowhere by itself.

What's masked in the logs (redact.py): tokens, keys, passwords and cookies, emails, phone
numbers and the home folder's name. The checkup's lines are masked the same way; the
review keeps only its headlines, never a paired phone's name or a project's rules.
"""

from __future__ import annotations

import contextlib
import json
import os
import platform
import stat
import sys
import zipfile
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from ... import osplat
from . import redact

LOGS = ("jarvis.log", "jarvis.log.1", "jarvis.log.2", "backend.log", "backend.1.log")
SIZES_MB = (1, 2, 5, 10)
README = """Jarvis diagnostics

Made {made} to share when asking for help. Nothing was sent anywhere.

  logs/        the last {mb} MB of Jarvis's logs, newest first
  versions.json
  checkup.json the checkup, run as this file was made
  security.json the security review's headlines

Masked everywhere: tokens, keys, passwords, cookies, email addresses, phone numbers and
your home folder's name. Your data (memory, messages, files) is not in here.
"""


def default_folder(home: Path | None = None) -> Path:
    return (home or Path.home()) / "Documents" / "Jarvis" / "Diagnostics"


def _tail_bytes(path: Path, limit: int) -> bytes:
    """The last `limit` bytes of a log, starting at a whole line."""
    try:
        size = os.lstat(path).st_size
        fd = os.open(path, os.O_RDONLY | osplat.O_NOFOLLOW | osplat.O_BINARY)
    except OSError:
        return b""
    with os.fdopen(fd, "rb") as fh:
        fh.seek(max(0, size - limit))
        raw = fh.read(limit)
    if size > limit and b"\n" in raw:
        raw = raw.split(b"\n", 1)[1]
    return raw


def log_tails(logs: Path, budget: int) -> list[tuple[str, bytes]]:
    """The logs, newest first, each cut so all of them fit in budget bytes."""
    found = []
    for name in LOGS:
        path = logs / name
        with contextlib.suppress(OSError):
            info = os.lstat(path)
            if stat.S_ISREG(info.st_mode):
                found.append((info.st_mtime, name, path, info.st_size))
    found.sort(reverse=True)
    out = []
    left = budget
    for _mtime, name, path, size in found:
        if left <= 0:
            break
        take = min(size, left)
        raw = _tail_bytes(path, take)
        if raw:
            out.append((name, raw))
            left -= len(raw)
    return out


def git_commit(project: Path) -> str:
    """The checked-out commit, read from .git (no git command runs)."""
    with contextlib.suppress(OSError, ValueError, IndexError):
        head = (project / ".git" / "HEAD").read_text().strip()
        if not head.startswith("ref: "):
            return head[:12]
        ref = head[5:].strip()
        loose = project / ".git" / ref
        if loose.is_file():
            return loose.read_text().strip()[:12]
        for line in (project / ".git" / "packed-refs").read_text().splitlines():
            if line.endswith(" " + ref):
                return line.split(" ", 1)[0][:12]
    return ""


def versions(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "macos": platform.mac_ver()[0],
        "machine": platform.machine(),
        "python": sys.version.split()[0],
    }
    with contextlib.suppress(Exception):
        from importlib.metadata import version

        out["jarvis"] = version("jarvis")
    with contextlib.suppress(Exception):
        import claude_agent_sdk

        out["claude_agent_sdk"] = getattr(claude_agent_sdk, "__version__", "")
    with contextlib.suppress(Exception):
        from ...config import PROJECT_DIR

        out["commit"] = git_commit(PROJECT_DIR)
    out.update(extra or {})
    return out


def headlines(review: dict[str, Any] | None) -> list[dict[str, str]]:
    """The review without its items: no phone names, projects or account names."""
    return [
        {"id": f.get("id", ""), "state": f.get("state", ""), "summary": f.get("summary", "")}
        for f in (review or {}).get("findings", [])
    ]


def masked(value: Any, home_re: Any) -> Any:
    """Every string in it masked (redact.line), keys and structure kept."""
    if isinstance(value, str):
        return redact.line(value, home_re, limit=4000)
    if isinstance(value, list):
        return [masked(v, home_re) for v in value]
    if isinstance(value, dict):
        return {k: masked(v, home_re) for k, v in value.items()}
    return value


def build(
    dest: Path,
    *,
    logs: Path,
    home: Path,
    info: dict[str, Any],
    checkup: dict[str, Any] | None,
    review: dict[str, Any] | None,
    megabytes: int = 2,
    clock: Callable[[], datetime] = datetime.now,
) -> Path:
    """Write the diagnostics zip into dest (made owner-only); its path."""
    megabytes = megabytes if megabytes in SIZES_MB else 2
    home_re = redact.home_pattern(home)
    dest.mkdir(parents=True, exist_ok=True, mode=0o700)
    now = clock()
    name = f"Jarvis diagnostics {now.strftime('%Y-%m-%d at %H.%M.%S')}"
    target = dest / f"{name}.zip"
    n = 2
    while os.path.lexists(target):
        target = dest / f"{name} {n}.zip"
        n += 1
    partial = target.with_name(f".{target.name}.part")
    checked = masked(checkup or {}, home_re)
    try:
        with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(
                "README.txt", README.format(made=now.strftime("%Y-%m-%d %H:%M"), mb=megabytes)
            )
            zf.writestr("versions.json", json.dumps(info, indent=1))
            zf.writestr("checkup.json", json.dumps(checked, indent=1))
            zf.writestr("security.json", json.dumps(headlines(review), indent=1))
            for log_name, raw in log_tails(logs, megabytes * 1024 * 1024):
                body = redact.text(raw.decode("utf-8", errors="replace"), home_re)
                zf.writestr(f"logs/{log_name}", body)
        os.chmod(partial, 0o600)
        os.replace(partial, target)
    finally:
        with contextlib.suppress(OSError):
            partial.unlink()
    return target
