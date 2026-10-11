"""Reading a project's own files the way nothing in them can hold Eden up (bug sweep r3,
CD3-1): a folder Eden Code is opened on may be anyone's, and its .mcp.json, settings,
commands, skills or agents may be a named pipe (opening it waits for a writer forever), a
link to /dev/zero or another device (it never ends), or huge.

- read_capped: a regular file's bytes, at most cap + 1 of them. Anything else (a pipe, a
  device, a socket, a folder, a link to one) is never opened: IsADirectoryError("it isn't a
  regular file"). The open doesn't wait (O_NONBLOCK) and is re-checked once open (fstat), so
  a file swapped for a pipe in between isn't read either.
- load_json: a settings-style file's JSON object, read the way Claude Code reads it (a
  leading BOM skipped), and "" — or (None, why) in words when it's there but can't be used,
  so it is never taken for "nothing" (CD2-1). code_trust's own reader.
- read_text: a file's text, at most cap bytes of it, "" when it can't be read.
- run: one of these on a small pool of its own, with a time limit, so even a read that
  sticks (a slow or hung disk) never takes a worker from the shared pool every other
  feature's asyncio.to_thread uses. TimeoutError when it takes too long.

Cost policy (Claude): this never calls a model.
"""

from __future__ import annotations

import asyncio
import functools
import json
import os
import stat
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

READ_CAP = 1_000_000  # a settings file bigger than this isn't read
NOT_REGULAR = "it isn't a regular file"
READERS = 4  # threads for a project's files, apart from the shared pool
READ_TIMEOUT = 5.0  # seconds a read of a project's files may take, then it's given up on

_pool: ThreadPoolExecutor | None = None


def read_capped(path: Path | str, cap: int) -> bytes:
    """A regular file's bytes, at most cap + 1 of them (never a pipe or a device: it isn't
    opened, and an open never waits). FileNotFoundError (a link to nothing too),
    IsADirectoryError for anything that isn't a regular file, other OSErrors as they come."""
    if not stat.S_ISREG(os.stat(path).st_mode):  # (links followed: a link to /dev/zero)
        raise IsADirectoryError(NOT_REGULAR)
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOCTTY)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):  # (swapped meanwhile)
            raise IsADirectoryError(NOT_REGULAR)
        chunks, left = [], cap + 1
        while left > 0:
            chunk = os.read(fd, min(left, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
        return b"".join(chunks)
    finally:
        os.close(fd)


def why_not(exc: OSError) -> str:
    """Why a file couldn't be read, in words for the owner."""
    if isinstance(exc, IsADirectoryError):
        return NOT_REGULAR
    if isinstance(exc, PermissionError):
        return "it can't be read (no permission)"
    return f"it can't be read ({exc.strerror or type(exc).__name__})"


def load_json(path: Path, cap: int | None = None, lossy: bool = False) -> tuple[Any, str]:
    """A settings file's JSON object, read the way Claude Code reads it (a leading BOM is
    skipped), and "". When the file is there but can't be read, is too big, isn't UTF-8
    text, or isn't a JSON object: (None, why). No file (or an empty one: Claude Code loads
    nothing from it): (None, "")."""
    cap = READ_CAP if cap is None else cap
    try:
        raw = read_capped(path, cap)
    except (FileNotFoundError, NotADirectoryError):
        return None, ""  # (a link to nothing too: when its target appears, it's read)
    except OSError as exc:
        return None, why_not(exc)
    if len(raw) > cap:
        return None, f"it's over {cap // 1_000_000} MB, too big to check"
    try:
        text = raw.decode("utf-8-sig", errors="replace" if lossy else "strict")
    except UnicodeDecodeError:
        return None, "it isn't UTF-8 text"
    if not text.strip():
        return None, ""
    try:
        data = json.loads(text)
    except ValueError:
        return None, "it isn't valid JSON (a comment or a typo?)"
    if not isinstance(data, dict):
        return None, "it isn't a JSON object"
    return data, ""


def read_text(path: Path, cap: int) -> str:
    """A file's text (a BOM skipped, odd bytes replaced), at most cap bytes of it; "" when
    it isn't there or can't be read (a pipe, a device, no permission)."""
    try:
        return read_capped(path, cap)[:cap].decode("utf-8-sig", errors="replace")
    except OSError:
        return ""


def pool() -> ThreadPoolExecutor:
    global _pool
    if _pool is None:
        _pool = ThreadPoolExecutor(READERS, thread_name_prefix="eden-project-read")
    return _pool


async def run[T](fn: Callable[..., T], *args: Any, timeout: float | None = None, **kw: Any) -> T:
    """fn(*args, **kw) on the project-file pool, given up on after timeout seconds
    (TimeoutError; the thread is left to finish on its own, the caller isn't)."""
    loop = asyncio.get_running_loop()
    job = loop.run_in_executor(pool(), functools.partial(fn, *args, **kw))
    return await asyncio.wait_for(job, READ_TIMEOUT if timeout is None else timeout)
