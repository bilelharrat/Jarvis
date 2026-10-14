"""Processes a test started that would outlive it, found by the test's own temp folder.

A detached run (a hand-off's run.sh under nohup, its `tail -f`, the fake claude it starts)
is reparented to launchd the moment its starter ends, so "children of this process" never
finds it; what it always carries is a path inside the test's temp folder on its command
line (or is the child of one that does). Only those are touched: a process is taken when
its command line names the folder, or when it descends from one that does, never by a name
or a pattern that could match the owner's own processes or another test run's.
"""

from __future__ import annotations

import contextlib
import os
import signal
import time
from pathlib import Path

import psutil


def leftovers(folder: Path | str) -> list[psutil.Process]:
    """The processes whose command line names folder, and every process below them; never
    this one or its parents."""
    marker = str(folder)
    spared = {os.getpid(), *(p.pid for p in psutil.Process().parents())}
    named: set[int] = set()
    children: dict[int, list[int]] = {}
    procs: dict[int, psutil.Process] = {}
    for proc in psutil.process_iter(["pid", "ppid", "cmdline"]):
        info = proc.info
        procs[info["pid"]] = proc
        children.setdefault(info["ppid"] or 0, []).append(info["pid"])
        if any(marker in part for part in info["cmdline"] or ()):
            named.add(info["pid"])
    found: list[int] = []
    todo = sorted(named)
    while todo:
        pid = todo.pop()
        if pid in spared or pid in found:
            continue
        found.append(pid)
        todo.extend(children.get(pid, ()))
    return [procs[pid] for pid in found if pid in procs]


def reap(folder: Path | str, seconds: float = 5.0, quiet: float = 0.3) -> list[str]:
    """Kill everything leftovers finds, again as more appear (a detached start may still be
    on its way), until none has been seen for `quiet` seconds or `seconds` have gone by.
    Returns the command lines it killed, for a test that wants to say so."""
    killed: list[str] = []
    deadline = time.monotonic() + seconds
    calm_since = time.monotonic()
    while time.monotonic() < deadline:
        found = leftovers(folder)
        if not found:
            if time.monotonic() - calm_since >= quiet:
                break
            time.sleep(0.05)
            continue
        for proc in found:  # (all at once: a parent killed first orphans its children)
            with contextlib.suppress(psutil.Error, OSError):
                killed.append(" ".join(proc.cmdline()))
                proc.send_signal(signal.SIGKILL)
        psutil.wait_procs(found, timeout=1)
        calm_since = time.monotonic()
    return killed
