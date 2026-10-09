"""Rebuild the second brain in its own low-priority process.

Reading thousands of documents and PDFs is CPU-heavy Python. Run inside the app's
process it held the interpreter lock for minutes, and the voice loop (listening,
transcribing, speaking) stalled behind it. The app starts this instead and reloads the
index when it finishes.

    python -m jarvis.brain_build '{"store": "...", "bsh": "...", "notes": true, ...}'

Prints one JSON object per line: {"progress": "..."} while working, then {"done": {...}}.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path
from typing import IO

from . import osplat
from .knowledge import Collector, KnowledgeBase

# The lock file, held for as long as this process lives (not only while main() runs).
_lock: IO[str] | None = None


def _private_output() -> None:
    """Keep the app's pipes to this process: the processes it starts (the document readers,
    osascript) get /dev/null for stdout and stderr instead of inheriting them. One of them
    stuck on a file would otherwise hold the pipes open after this process is gone, and
    the app, reading to their end, would wait with it."""
    null = os.open(os.devnull, os.O_WRONLY)
    for fd, name in ((1, "stdout"), (2, "stderr")):
        mine = os.dup(fd)  # not inherited by child processes (PEP 446)
        setattr(sys, name, open(mine, "w", buffering=1, errors="backslashreplace"))  # noqa: SIM115
        os.dup2(null, fd)
    os.close(null)


def main() -> None:
    global _lock
    args = json.loads(sys.argv[1])
    # The folder first: on a fresh install there's none yet for the lock file to go in.
    Path(args["store"]).parent.mkdir(parents=True, exist_ok=True)
    # One rebuild at a time, even if an earlier app run left one going.
    _lock = open(Path(args["store"]).with_suffix(".lock"), "w")  # noqa: SIM115 - held until exit
    try:
        osplat.lock_file(_lock)
    except OSError:
        print(json.dumps({"busy": True}), flush=True)
        return
    osplat.lower_priority()  # the voice loop comes first
    kb = KnowledgeBase(Path(args["store"]))
    only = set(args["only"]) if args.get("only") is not None else None
    if not kb.load() and only:
        # No saved index to keep the other sources from (none yet, or one that can't be
        # used): read them all, or they'd be missing until the next full rebuild.
        only = None
    collector = Collector(kb, Path(args["bsh"]) if args.get("bsh") else None)

    def progress(message: str) -> None:
        print(json.dumps({"progress": message}), flush=True)

    # The newer sources and search by meaning's vectors (args["more"], from
    # jarvis.features.brain): read and made here too, under this lock and at this priority.
    from . import brain_sources

    summary = collector.run(
        notes=args.get("notes", False),
        bsh=args.get("bsh_on", False),
        folders=args.get("folders", []),
        computer=args.get("computer", False),
        photos=args.get("photos", False),
        mail=args.get("mail", False),
        messages=args.get("messages", False),
        only=only,
        progress=progress,
        extra=brain_sources.extra_sources(args),
        finish=brain_sources.finisher(args),
    )
    print(json.dumps({"done": summary}), flush=True)


def run() -> None:
    """main(), then out at once. A source the Collector gave up on can still be stuck in a
    read (a file that never finishes loading), and a normal exit waits for its thread;
    the app would wait with it. Everything is saved and printed by now."""
    code = 0
    try:
        _private_output()
        main()
    except BaseException:  # noqa: BLE001 - reported, then the process ends either way
        traceback.print_exc()
        code = 1
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()  # os._exit() skips the flush a normal exit does
        except (OSError, ValueError):
            pass
    os._exit(code)


if __name__ == "__main__":
    run()
