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
from pathlib import Path

from .knowledge import Collector, KnowledgeBase


def main() -> None:
    args = json.loads(sys.argv[1])
    try:
        os.nice(10)  # the voice loop comes first
    except OSError:
        pass
    kb = KnowledgeBase(Path(args["store"]))
    kb.load()
    collector = Collector(kb, Path(args["bsh"]) if args.get("bsh") else None)

    def progress(message: str) -> None:
        print(json.dumps({"progress": message}), flush=True)

    summary = collector.run(
        notes=args.get("notes", False),
        bsh=args.get("bsh_on", False),
        folders=args.get("folders", []),
        computer=args.get("computer", False),
        photos=args.get("photos", False),
        mail=args.get("mail", False),
        messages=args.get("messages", False),
        only=set(args["only"]) if args.get("only") is not None else None,
        progress=progress,
    )
    print(json.dumps({"done": summary}), flush=True)


if __name__ == "__main__":
    main()
