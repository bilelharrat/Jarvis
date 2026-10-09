"""Eden Code's diffs and test results as spoken summaries, for screen-reader mode (J.A.R.V.I.S.
Daredevil): when a session's turn ends while features/accessibility.py says the mode is on, a
heads-up says what changed, file by file, by function, class or section (never line numbers),
and how its tests went, with the names of the ones that failed. The heads-up goes where every
heads-up goes in that mode (to the owner's screen reader, or JARVIS's voice).

- Test results come from the test runs a session made itself (a Bash step running pytest, Jest,
  Vitest, node --test, go test, cargo test or dotnet test: its whole output, heard through
  TaskManager.message_sinks), or else from the Tests pane's run in that project during the turn.
- spoken_changes (a tool, any mode): the same summary for a session on request ("what did Eden
  Code change?"), over everything the session changed.
- A turn that changed nothing and ran no tests says nothing.

Claude cost policy: no model call; git's diff and the tests' own output are read here.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

from claude_agent_sdk import ToolResultBlock, ToolUseBlock, create_sdk_mcp_server, tool

from .. import code_speech, diffspeak, lang

log = logging.getLogger("jarvis")

TEXTS = {
    "Eden Code finished in {folder}.": "Eden Code 在 {folder} 里完成了。",
    "Eden Code stopped with an error in {folder}.": "Eden Code 在 {folder} 里出错停下了。",
}
lang.add_texts(TEXTS)

PROMPT = (
    "\n- Eden Code, said for the ear: spoken_changes says what a coding session changed, file by "
    "file by function or section, and how its tests went with the failing tests' names. Use it "
    "for 'what did Eden Code change?' or 'did the tests pass?', and read it as it is."
)
LABELS = {"spoken_changes": "Said what Eden Code changed"}
KEEP_PENDING = 200


def _text(words: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": words}]}
    if error:
        out["is_error"] = True
    return out


def _result_text(content: Any) -> str:
    if isinstance(content, list):
        return "\n".join(str(c.get("text", "")) for c in content if isinstance(c, dict))
    return str(content or "")


class CodeSpoken:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.pending: dict[str, int] = {}  # a test run's tool_use id -> its session
        self.reports: dict[
            int, tuple[float, code_speech.TestReport]
        ] = {}  # session -> (when, report)

    def on(self) -> bool:
        """Whether screen-reader mode is on (features/accessibility.py)."""
        a11y = getattr(self.hub, "accessibility", None)
        try:
            return bool(a11y is not None and a11y.effective())
        except Exception:  # noqa: BLE001
            return False

    # ── what sessions run ──

    def take(self, task: Any, message: Any) -> None:
        """TaskManager.message_sinks: a test command a session runs, and its whole output."""
        if getattr(task, "kind", "code") != "code":
            return
        for block in getattr(message, "content", None) or []:
            if isinstance(block, ToolUseBlock) and block.name == "Bash":
                if code_speech.runs_tests(str((block.input or {}).get("command", ""))):
                    self.pending[block.id] = task.id
                    while len(self.pending) > KEEP_PENDING:
                        self.pending.pop(next(iter(self.pending)))
            elif isinstance(block, ToolResultBlock) and block.tool_use_id in self.pending:
                task_id = self.pending.pop(block.tool_use_id)
                report = code_speech.read_test_output(_result_text(block.content))
                if report is not None:
                    self.reports[task_id] = (time.monotonic(), report)

    # ── the summary ──

    def test_words(self, task: Any, since: float | None) -> str:
        """The tests' words: the session's own latest run (since `since`, monotonic), else the
        Tests pane's in that project in the same time."""
        found = self.reports.get(task.id)
        if found is not None and (since is None or found[0] >= since):
            return found[1].words()
        verify = getattr(self.hub, "code_verify", None)
        runner = getattr(verify, "tests", None)
        run = runner.latest(Path(task.cwd)) if runner is not None else None
        results = getattr(run, "results", None)
        if run is None or results is None or not getattr(run, "finished", None):
            return ""
        if since is not None and run.finished < time.time() - (time.monotonic() - since):
            return ""
        counts = results.counts()
        report = code_speech.TestReport(
            counts.get("passed", 0),
            counts.get("failed", 0),
            counts.get("skipped", 0),
            [f"{c.name} in {Path(c.file).name}" if c.file else c.name for c in results.failures()],
        )
        return report.words()

    async def summary(self, task: Any, whole: bool = False) -> str:
        """What a turn (or, whole, the session) changed and how its tests went; "" for nothing."""
        files = set(task.files_changed if whole else task.turn_files)
        since = None if whole else (task.turn_started or None)
        tests = self.test_words(task, since)
        if not files:
            return tests
        changes = await asyncio.to_thread(diffspeak.collect, Path(task.cwd), files)
        words = code_speech.changes_words(Path(task.cwd), changes)
        return f"{words} {tests}".strip()

    def on_task_event(self, kind: str, data: dict[str, Any]) -> None:
        """hub.add_task_sink: a session's turn ended; in screen-reader mode, say what it did."""
        if kind != "task_finished" or data.get("task_kind") != "code" or not self.on():
            return
        if data.get("status") not in ("done", "failed"):
            return  # stopped by the owner: nothing to tell
        task = getattr(self.hub.tasks, "tasks", {}).get(data.get("id"))
        if task is None:
            return
        spawn = getattr(self.hub, "_spawn", None) or asyncio.ensure_future
        spawn(self.announce(task, data))

    async def announce(self, task: Any, data: dict[str, Any]) -> None:
        from ..proactive import Alert

        try:
            words = await self.summary(task)
        except Exception:  # noqa: BLE001 - git that failed: the card still says it finished
            log.exception("code_spoken: couldn't sum up session %s", getattr(task, "id", "?"))
            return
        if not words:
            return
        language = (
            "zh"
            if lang.is_zh(getattr(getattr(self.hub, "prefs", None), "language", "") or "")
            else "en"
        )
        head = (
            "Eden Code finished in {folder}."
            if data.get("status") == "done"
            else "Eden Code stopped with an error in {folder}."
        )
        text = (
            f"{lang.tr(head, language, folder=data.get('folder') or Path(task.cwd).name)} {words}"
        )
        self.hub.notify(
            Alert(
                f"code-spoken:{task.id}:{time.monotonic():.0f}", "task", "Eden Code changes", text
            )
        )

    # ── the tool ──

    def build(self) -> Any:
        @tool(
            "spoken_changes",
            "What an Eden Code session changed, said for the ear: how many files, then each file "
            "by the functions, classes or sections changed or added (no line numbers), then its "
            "tests: passed, failed, and the failing tests' names. session: its number (default: "
            "the one in focus, else the latest).",
            {"type": "object", "properties": {"session": {"type": "integer"}}},
        )
        async def spoken_changes(args):
            tasks = getattr(self.hub.tasks, "tasks", {})
            wanted = args.get("session")
            focus = getattr(getattr(self.hub, "voicecode", None), "focus", None)
            code = [t for t in tasks.values() if getattr(t, "kind", "") == "code"]
            task = (
                tasks.get(wanted)
                if wanted
                else tasks.get(focus)
                if focus in tasks
                else (code[-1] if code else None)
            )
            if task is None or getattr(task, "kind", "") != "code":
                return _text("There's no Eden Code session to sum up.", True)
            words = await self.summary(task, whole=True)
            return _text(
                words
                or f"Session {task.id} in {Path(task.cwd).name} hasn't changed any files or run tests yet."
            )

        return create_sdk_mcp_server(name="code_spoken", version="0.1.0", tools=[spoken_changes])


def install(hub: Any) -> None:
    feature = CodeSpoken(hub)
    hub.code_spoken = feature
    tasks = getattr(hub, "tasks", None)
    if tasks is not None and hasattr(tasks, "message_sinks"):
        tasks.message_sinks.append(feature.take)
    if hasattr(hub, "add_task_sink"):
        hub.add_task_sink(feature.on_task_event)
    hub.register_server("code_spoken", feature.build, prompt=PROMPT, labels=LABELS)
