"""Jarvis Code: every turn comes with proof, one card the owner can trust without the diff.

When a session's turn that changed files ends, its receipt goes into the transcript (so
the window, the iPhone's session view and "catch me up" all have it), as one entry:

- what changed: the files, how many;
- the tests the session ran, and how they ended (codesupervisor's journal);
- the check after the turn (code_verify), when the session has it on: waited for up to
  VERIFY_WAIT, with its picture of the page;
- a risk level: high when it failed, tests failed, the check found problems, or it touched
  auth, billing, the database schema or secrets; medium when it changed many files or
  changed code with no tests run; else low. Said in words, with why.

The entry's text reads well on its own (the phone, a voice summary); the window draws it
as a card from its receipt field (web/features/code-receipts.js).

No Claude calls here.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .. import codesupervisor as cs

log = logging.getLogger("jarvis")

VERIFY_WAIT = 120.0  # seconds a receipt waits for the check after the turn
MANY_FILES = 12
_CODE = (
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".go",
    ".rs",
    ".swift",
    ".kt",
    ".java",
    ".rb",
    ".c",
    ".cpp",
)


def risk_of(status: str, files: list[str], tests: list[Any], check: dict[str, Any] | None):
    """(low | medium | high, why)."""
    areas = cs.risky_areas(files)
    if status == "failed":
        return "high", "the turn stopped with an error"
    if tests and not tests[-1].passed:
        return "high", "its tests failed"
    if check and check.get("status") == "problems":
        return "high", "the check after it found problems"
    if areas:
        return "high", f"it touches {' and '.join(areas)}"
    if len(files) >= MANY_FILES:
        return "medium", f"it changed {len(files)} files"
    if not tests and any(f.endswith(_CODE) for f in files):
        return "medium", "it changed code and ran no tests"
    return "low", "small, tested change" if tests else "small change"


def receipt_of(task: Any, data: dict[str, Any], tests: list[Any], check: dict[str, Any] | None):
    files = [str(f) for f in data.get("files") or []]
    level, why = risk_of(str(data.get("status") or ""), files, tests, check)
    run = None
    if tests:
        last = tests[-1]
        run = {
            "command": last.command[:120],
            "passed": last.passed,
            "passed_count": last.passed_count,
            "failed_count": last.failed_count,
        }
    return {
        "files": files[:30],
        "file_count": len(files),
        "tests": run,
        "check": {
            k: (check or {}).get(k, "") for k in ("status", "text", "url", "thumb")
        } if check else None,
        "risk": level,
        "why": why,
        "elapsed": int(data.get("elapsed") or 0),
    }  # fmt: skip


def receipt_text(r: dict[str, Any]) -> str:
    parts = [f"Changed {r['file_count']} file{'s' if r['file_count'] != 1 else ''}"]
    t = r["tests"]
    if t:
        parts.append(
            f"tests passed ({t['passed_count']})"
            if t["passed"]
            else f"tests failed ({t['failed_count']})"
        )
    else:
        parts.append("no tests run")
    if r["check"]:
        parts.append(f"check: {r['check']['text'] or r['check']['status']}"[:120])
    parts.append(f"risk {r['risk']}: {r['why']}")
    return "Proof · " + " · ".join(parts)


class Receipts:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.waiting: dict[int, asyncio.Future] = {}  # task id -> its check's result

    def tests_of(self, task_id: int, since: float) -> list[Any]:
        voice = getattr(self.hub, "code_voice", None)
        journal = getattr(voice, "journal", None)
        turns = list((getattr(journal, "turns", {}) or {}).get(task_id, []))
        return [r for turn in turns[-1:] if turn.at >= since for r in turn.tests]

    def checking(self, task_id: int) -> bool:
        cv = getattr(self.hub, "code_verify", None)
        try:
            return bool(cv is not None and cv.session(task_id).verify)
        except Exception:
            return False

    def task_event(self, kind: str, data: dict[str, Any]) -> None:
        """hub.add_task_sink: a code turn that changed files ended."""
        if kind != "task_finished" or data.get("task_kind") != "code" or not data.get("files"):
            return
        task = self.hub.tasks.tasks.get(data.get("id"))
        if task is None:
            return
        spawn = getattr(self.hub, "_spawn", None)
        coro = self.write(task, dict(data), time.time() - 5)
        if spawn is not None:
            spawn(coro)
        else:  # pragma: no cover - every hub has it
            coro.close()

    def verified(self, event: dict[str, Any]) -> None:
        """hub.add_event_sink(cv_verify): the check after a turn is done."""
        if event.get("state") != "done":
            return
        waiter = self.waiting.get(event.get("id"))
        if waiter is not None and not waiter.done():
            waiter.set_result(event.get("last"))

    async def write(self, task: Any, data: dict[str, Any], since: float) -> dict[str, Any]:
        check = None
        if self.checking(task.id):
            waiter = self.waiting[task.id] = asyncio.get_running_loop().create_future()
            try:
                check = await asyncio.wait_for(waiter, VERIFY_WAIT)
            except TimeoutError:
                check = None
            finally:
                self.waiting.pop(task.id, None)
        await asyncio.sleep(0)  # (the journal hears the same turn's end on this loop)
        receipt = receipt_of(task, data, self.tests_of(task.id, since), check)
        self.hub.tasks._log(task, "system", receipt_text(receipt), receipt=receipt)
        self.hub.tasks._changed_soon()
        return receipt


def install(hub: Any) -> None:
    desk = Receipts(hub)
    hub.code_receipts = desk  # (for the tests)
    hub.add_task_sink(desk.task_event)
    hub.add_event_sink(("cv_verify",), desk.verified)
