"""Eden Code: the owner's Mac as the QA team.

A session already has the built-in browser (with the owner's real sign-ins) and the iOS
Simulator (code_tools). A QA pass asks it to use what it just built the way a person
would: walk through the flows its changes touch, try the edge cases, watch the console
and the network, and report what broke, with screenshots, and how bad each is. It
reports, it doesn't fix: the owner decides what's next.

On demand: the window's code_qa {id} (the proof card's "Try it like a user"), or by
voice through the window. After a turn: with code_qa_auto on, a turn that changed
what a user sees (pages, styles, components, screens) gets a pass, at most QA_PER_HOUR a
session and never for a QA pass's own turn.

No Claude calls of its own: the session's turn is the pass.
"""

from __future__ import annotations

import time
from typing import Any

from .. import prefs

PREF_AUTO = "code_qa_auto"
prefs.register_feature_pref(PREF_AUTO, False)
QA_PER_HOUR = 2
_UI = (
    ".html",
    ".css",
    ".scss",
    ".tsx",
    ".jsx",
    ".vue",
    ".svelte",
    ".swift",
    ".kt",
    ".xib",
    ".storyboard",
)
PROMPT = (
    "QA pass, from Eden: use what you just built the way a real user would, in "
    "jarvis_browser (the owner's built-in browser, already signed in where they are) or "
    "jarvis_simulator for an iOS app. Walk through every flow your changes touch{files}, "
    "then the edge cases: empty and very long input, going back, reloading, a slow or "
    "failed request, a narrow window. Watch the console and the network. Don't fix "
    "anything and never buy, send or delete anything real. Report: what you tried, what "
    "broke (a screenshot of each), and how bad each is (blocker, annoying, cosmetic)."
)


def qa_prompt(files: list[str]) -> str:
    shown = ", ".join(files[:12])
    return PROMPT.format(files=f" ({shown})" if shown else "")


def touches_ui(files: list[str]) -> bool:
    return any(str(f).lower().endswith(_UI) for f in files)


class QA:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.runs: dict[int, list[float]] = {}
        # Sessions with a QA pass to come: how many turn ends until the pass's own (2 when
        # it was queued behind the turn going: that turn's end isn't the pass's).
        self.pending: dict[int, int] = {}

    def start(self, task_id: int, files: list[str] | None = None) -> bool:
        task = self.hub.tasks.tasks.get(task_id)
        if task is None or task.kind != "code":
            return False
        files = files if files is not None else sorted(task.files_changed)[-12:]
        busy = bool(getattr(task, "busy", False))
        if not self.hub.tasks.send(task_id, qa_prompt([str(f) for f in files]), note=True):
            return False  # not taken: no pass to wait for, and none counted
        # (the app's note goes first in the queue: the pass is the next turn after this one)
        self.pending[task_id] = 2 if busy else 1
        self.runs.setdefault(task_id, []).append(time.time())
        return True

    def task_event(self, kind: str, data: dict[str, Any]) -> None:
        if kind != "task_finished" or data.get("task_kind") != "code":
            return
        task_id = data.get("id")
        if task_id in self.pending:  # the pass (or the turn it waited behind) ended
            self.pending[task_id] -= 1
            if self.pending[task_id] <= 0:
                del self.pending[task_id]
            return
        if not self.hub.prefs.feature(PREF_AUTO) or data.get("status") != "done":
            return
        files = [str(f) for f in data.get("files") or []]
        recent = [t for t in self.runs.get(task_id, []) if time.time() - t < 3600]
        self.runs[task_id] = recent
        if touches_ui(files) and len(recent) < QA_PER_HOUR:
            self.start(task_id, files)

    def _cmd_qa(self, msg: dict[str, Any]) -> None:
        try:
            task_id = int(msg.get("id") or 0)
        except (TypeError, ValueError, OverflowError):  # (infinity too)
            return
        if not self.start(task_id):
            self.hub.emit("error", text="That session can't take a QA pass just now.")


def install(hub: Any) -> None:
    desk = QA(hub)
    hub.code_qa = desk  # (for the tests)
    hub.add_task_sink(desk.task_event)
    hub.register_command("code_qa", desk._cmd_qa)
