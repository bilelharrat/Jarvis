"""Eden Code's engine radar: does Eden Code get worse after Claude Code or the model is
updated? Measured from the owner's own sessions, per project, per engine version and per
model, with a heads-up when a shift is more than noise, and a one-click way back
(features.code_engines). The pane is web/features/code-radar.js; the Health pane shows its
verdict in one line.

What it keeps: eden_code_radar.jsonl beside prefs.json (features._router_log's EventLog:
append-only, written off the event loop, rotated at 5 MB with 3 files kept, RETENTION_DAYS,
readable by the owner alone). Its lines (features._radar_stats reads them):
- "turn", as each of a session's turns ends: the project (the SHA-256 of its folder, 12 hex,
  as the Model Router's log has it, so the two can be read together), the session (a salted
  hash, a fresh salt each run), the engine's version (what Claude Code says at the start of
  its connection, else what Eden runs: code_engines) and the SDK's, the model, whether the
  engine was pinned; how many files the turn read, looked through and edited, the edits
  made with no read of that file first in the session (a subagent's reads count for its
  own edits only, as Claude Code tracks them), the files it changed, its last test run
  (codesupervisor's TEST_COMMAND and counts), whether the owner stopped it or it failed,
  what Claude Code says it cost (its turn line), and how long it took.
- "outcome", later: the turn rewound (with its files or not), reverted (Undo, a file's
  Revert in the Changes pane, a hunk's Undo, within REVERT_SECONDS of the turn), or, in an
  isolated copy, landed or discarded with the copy.
- "review": seconds the owner spent with a review pane open (the Changes pane, a pull
  request, the reviews, Best of N), as the window measures them (code-ledger.js), for the
  weekly ledger (features.code_ledger).
Never prompt text, file names or paths: counts, versions, model ids and hashes.

Where it hears things: the transcript (add_task_sink: the owner's messages start a turn,
test runs, the user messages' ids for a rewind), Claude Code's messages (TaskManager.
message_sinks: its start, its tool calls, each turn's end), the owner's acts on their way
(task_interrupt, task_cancel, task_undo, task_revert, task_rewind, code_rewind: each
handler returns False, so the command still goes where it went), code_hunk_undone, and an
isolated copy landed or discarded (code_copy_outcome, from features.code_isolation).
Another agent over ACP isn't measured: its steps don't come as Claude Code's.

The verdict (features._radar_stats.changes): for each model family, in all projects and in
each project with enough turns, the newest engine-and-model pair against the one before,
each metric compared (Holm-corrected tests, a minimum sample and a minimum size of shift).
Looked at again every ANALYZE_EVERY turns (at most every ANALYZE_GAP seconds) and when the
pane or the Health pane asks. A shift for the worse gets one heads-up (code_radar_alerts,
on), never again for the same change and metric; the pane offers to go back to the engine
before it, or to pin the one now, and to dismiss it.

Settings (feature prefs, in Eden Code settings): code_radar_on (on: keep the log),
code_radar_alerts (on).

Window commands: cw_radar {fresh?} -> cw_radar {turns, since, changes, breakdown,
projects, names, dismissed, on}; cw_radar_dismiss {key}; cw_review_time {seconds, pane,
id?}.

Cost policy (Claude): nothing here calls a model. It counts what Eden's sessions already
did and does statistics on it.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
import os
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .. import jsonstore, lang
from ..codeplatform import other_agent, project_of
from ..codesupervisor import TEST_COMMAND, test_counts
from ..prefs import register_feature_pref
from ..proactive import Alert
from . import _radar_stats as stats
from ._router_log import EventLog, epoch_of, iso

log = logging.getLogger("jarvis")

EVENTS_FILE = "eden_code_radar.jsonl"
STATE_FILE = "eden_code_radar_state.json"
PREF_ON = "code_radar_on"
PREF_ALERTS = "code_radar_alerts"
RETENTION_DAYS = 400  # the ledger looks back a year
REVERT_SECONDS = 24 * 3600.0
TURNS_KEPT = 60  # per session, for late outcomes
SEEN_KEPT = 5000  # files read per session (and per subagent) remembered
ANALYZE_EVERY = 10
ANALYZE_GAP = 300.0
REVIEW_MAX = 900  # seconds in one report from the window
REVIEW_PANES = ("diff", "pr", "pr-reviews", "bestof")
NIGHTLY = (3, 50)
STATE_KEPT = 500

READ_TOOLS = {"Read", "NotebookRead"}
LOOK_TOOLS = {"Grep", "Glob", "LS"}
EDIT_TOOLS = {"Edit", "MultiEdit", "Write", "NotebookEdit"}
_RETRYABLE = ("task_undo", "task_revert", "task_rewind", "code_rewind")

ZH = {
    "Eden Code engine radar": "Eden Code 引擎雷达",
    "Since Claude Code {after} (from {before}), {where}got worse: {what}. Open Engine radar to go back or pin a version.": "自从 Claude Code {after}（之前是 {before}），{where}变差了：{what}。打开引擎雷达可以退回或固定一个版本。",
    "Since {after} (from {before}), {where}got worse: {what}. Open Engine radar to see more.": "自从 {after}（之前是 {before}），{where}变差了：{what}。打开引擎雷达查看更多。",
    "{family} in {project} ": "{project} 里的 {family} ",
    "{family} ": "{family} ",
    # (the metrics, as the heads-up names them: features._radar_stats.METRICS)
    "Reads per edit": "每次编辑前的读取次数",
    "Edits without a read first": "没有先读就编辑",
    "Turns you stopped": "你停下的轮次",
    "Turns rewound": "被回退的轮次",
    "Changes reverted": "被撤销的改动",
    "Test runs that passed": "通过的测试运行",
    "Cost per landed change": "每个落地改动的花费",
}
lang.add_texts(ZH)

register_feature_pref(PREF_ON, True)
register_feature_pref(PREF_ALERTS, True)


def project_hash(folder: str) -> str:
    """As the Model Router's log has it (code_router_events.project_hash)."""
    return hashlib.sha256(str(folder or "").encode("utf-8")).hexdigest()[:12]


@dataclass
class Turn:
    key: str
    started: float
    n: int | None = None
    uuid: str = ""
    reads: int = 0
    looks: int = 0
    edits: int = 0
    blind: int = 0
    creates: int = 0
    tests: bool | None = None
    interrupted: bool = False
    ended: float | None = None
    files: frozenset[str] = frozenset()
    undone: bool = False  # reverted, rewound with its files, or discarded: said once


@dataclass
class Track:
    session: str
    seen: dict[str, set[str]] = field(default_factory=dict)  # agent ("" main) -> files read
    wrote: set[str] = field(default_factory=set)
    turns: deque[Turn] = field(default_factory=lambda: deque(maxlen=TURNS_KEPT))
    current: Turn | None = None
    tests: dict[str, str] = field(default_factory=dict)  # tool id -> test command
    engine: str = ""
    model: str = ""


def _path(task: Any, value: Any) -> str:
    raw = str(value or "")
    if not raw:
        return ""
    with contextlib.suppress(Exception):
        if not os.path.isabs(raw):
            raw = os.path.join(str(task.cwd), raw)
    return os.path.normpath(raw)


class Radar:
    def __init__(self, hub: Any, clock: Any = time.time) -> None:
        self.hub = hub
        self.clock = clock
        self.log = EventLog(hub.feature_path(EVENTS_FILE), days=RETENTION_DAYS, clock=clock)
        self.salt = secrets.token_hex(8)
        self.tracks: dict[int, Track] = {}
        self._n = 0
        self._new = 0  # turns written since the last look
        self._looked = 0.0
        self._looking: asyncio.Task | None = None
        self._cache: tuple[Any, dict[str, Any]] | None = None
        self._state: dict[str, Any] | None = None

    # ── basics ──

    def on(self) -> bool:
        return self.hub.prefs.feature(PREF_ON) is not False

    def tr(self, text: str, **kw: Any) -> str:
        return (
            lang.tr(text, self.hub.language, **kw)
            if kw
            else lang.translate(text, self.hub.language)
        )

    def measured(self, task: Any) -> bool:
        return task is not None and getattr(task, "kind", "") == "code" and not other_agent(task)

    def project(self, task: Any) -> str:
        try:
            return project_hash(project_of(self.hub, task))
        except Exception:
            return project_hash(str(getattr(task, "cwd", "")))

    def track(self, task: Any) -> Track:
        track = self.tracks.get(task.id)
        if track is None:
            session = hashlib.sha256(f"{self.salt}:{task.id}".encode()).hexdigest()[:12]
            track = self.tracks[task.id] = Track(session)
        return track

    def _turn(self, track: Track, n: Any = None) -> Turn:
        self._n += 1
        key = hashlib.sha256(f"{self.salt}:{track.session}:{self._n}".encode()).hexdigest()[:16]
        turn = Turn(key, self.clock(), n if isinstance(n, int) else None)
        track.current = turn
        return turn

    def _engine(self, track: Track) -> tuple[str, bool]:
        engines = getattr(self.hub, "code_engines", None)
        current: dict[str, Any] = {}
        with contextlib.suppress(Exception):
            current = engines.current() if engines is not None else {}
        version = track.engine or str(current.get("version") or "")
        return version, bool(current.get("pinned"))

    # ── the transcript (add_task_sink) ──

    def on_task_event(self, kind: str, data: dict[str, Any]) -> None:
        if not self.on():
            return
        try:
            if kind == "task_log":
                self._on_entry(data.get("id"), data.get("entry") or {})
            elif kind == "task_log_update":
                self._on_tool_result(data)
            elif kind == "task_entry_meta":
                self._on_meta(data)
            elif kind == "tasks":
                for gone in set(self.tracks) - set(self.hub.tasks.tasks):
                    self.tracks.pop(gone, None)
        except Exception:
            log.exception("Engine radar: couldn't take in a session event")

    def _on_entry(self, task_id: Any, entry: dict[str, Any]) -> None:
        task = self.hub.tasks.tasks.get(task_id) if isinstance(task_id, int) else None
        if not self.measured(task):
            return
        track = self.track(task)
        role = entry.get("role")
        if role == "user":
            if track.current is None:  # (a steer stays in the running turn)
                self._turn(track, entry.get("n"))
        elif role == "tool" and entry.get("tool") == "Bash" and entry.get("tool_id"):
            detail = str(entry.get("detail") or entry.get("text") or "")
            command = detail.removeprefix("$ ").removeprefix("Running ").strip()
            if TEST_COMMAND.search(command):
                track.tests[str(entry["tool_id"])] = command[:200]
                while len(track.tests) > 50:
                    del track.tests[next(iter(track.tests))]

    def _on_tool_result(self, data: dict[str, Any]) -> None:
        track = self.tracks.get(data.get("id"))
        if track is None or track.tests.pop(str(data.get("tool_id")), None) is None:
            return
        turn = track.current
        if turn is not None:
            _, failed = test_counts(str(data.get("output") or ""))
            turn.tests = data.get("status") == "done" and not failed

    def _on_meta(self, data: dict[str, Any]) -> None:
        track = self.tracks.get(data.get("id"))
        if track is None:
            return
        n = data.get("n")
        for turn in [track.current, *reversed(track.turns)]:
            if turn is not None and turn.n is not None and turn.n == n:
                turn.uuid = str(data.get("uuid") or "")[:100]
                return

    # ── Claude Code's messages (TaskManager.message_sinks) ──

    def on_message(self, task: Any, message: Any) -> None:
        if not self.on() or not self.measured(task):
            return
        try:
            name = type(message).__name__
            if name == "SystemMessage":
                self._on_system(task, message)
            elif name == "AssistantMessage":
                self._on_reply(task, message)
            elif name == "ResultMessage":
                self._on_result(task, message)
        except Exception:
            log.exception("Engine radar: couldn't take in a %s", type(message).__name__)

    def _on_system(self, task: Any, message: Any) -> None:
        if getattr(message, "subtype", "") != "init":
            return
        data = getattr(message, "data", None) or {}
        track = self.track(task)
        version = str(data.get("claude_code_version") or "")[:40]
        if version:
            track.engine = version
        model = str(data.get("model") or "")[:100]
        if model:
            track.model = model

    def _on_reply(self, task: Any, message: Any) -> None:
        track = self.track(task)
        turn = track.current or self._turn(track)  # (a turn Claude Code began by itself)
        agent = str(getattr(message, "parent_tool_use_id", None) or "")
        seen = track.seen.setdefault(agent, set())
        for block in getattr(message, "content", None) or []:
            if type(block).__name__ != "ToolUseBlock":
                continue
            name = str(getattr(block, "name", "") or "")
            args = getattr(block, "input", None)
            args = args if isinstance(args, dict) else {}
            if name in READ_TOOLS:
                turn.reads += 1
                path = _path(task, args.get("file_path") or args.get("notebook_path"))
                if path and len(seen) < SEEN_KEPT:
                    seen.add(path)
            elif name in LOOK_TOOLS:
                turn.looks += 1
            elif name in EDIT_TOOLS:
                turn.edits += 1
                path = _path(task, args.get("file_path") or args.get("notebook_path"))
                if not path or path in seen or path in track.wrote:
                    pass
                elif name == "Write" and not os.path.exists(path):
                    turn.creates += 1
                else:
                    turn.blind += 1
                if path and len(track.wrote) < SEEN_KEPT:
                    track.wrote.add(path)

    def _on_result(self, task: Any, message: Any) -> None:
        track = self.track(task)
        turn = track.current or self._turn(track)
        track.current = None
        reason = str(getattr(message, "terminal_reason", "") or "")
        if reason.startswith("aborted"):
            turn.interrupted = True
        error = bool(getattr(message, "is_error", False)) and not turn.interrupted
        turn.ended = self.clock()
        turn.files = frozenset(str(f) for f in list(getattr(task, "turn_files", ()) or ())[:500])
        engine, pinned = self._engine(track)
        model = track.model or str(getattr(task, "model", "") or "")
        record = {
            "v": 1,
            "kind": "turn",
            "ts": iso(turn.ended),
            "turn": turn.key,
            "session": track.session,
            "project": self.project(task),
            "engine": engine[:40],
            "sdk": _sdk(),
            "model": model[:100],
            "pinned": pinned,
            "reads": turn.reads,
            "looks": turn.looks,
            "edits": turn.edits,
            "blind": turn.blind,
            "creates": turn.creates,
            "files": len(turn.files),
            "tests": turn.tests,
            "interrupted": turn.interrupted,
            "error": error,
            "cost": _turn_cost(task),
            "seconds": max(0, int(turn.ended - turn.started)),
        }
        self.log.append(record)
        track.turns.append(turn)
        self._new += 1
        self.maybe_analyze()

    # ── the owner's acts, heard on their way (each handler returns False) ──

    def observer(self, kind: str) -> Any:
        def hear(msg: dict[str, Any]) -> bool:
            try:
                if self.on():
                    self.on_command(kind, msg)
            except Exception:
                log.exception("Engine radar: couldn't take in %s", kind)
            return False

        return hear

    def _task_of(self, msg: dict[str, Any]) -> Any:
        try:
            return self.hub.tasks.tasks.get(int(msg.get("id") or 0))
        except (TypeError, ValueError, OverflowError):
            return None

    def outcome(self, turn: Turn, what: str, **extra: Any) -> None:
        record = {
            "v": 1,
            "kind": "outcome",
            "ts": iso(self.clock()),
            "turn": turn.key,
            "what": what,
        }
        record.update(extra)
        self.log.append(record)

    def _latest_change(self, track: Track, path: str = "") -> Turn | None:
        now = self.clock()
        fresh = [
            t for t in reversed(track.turns)
            if t.files and not t.undone and now - (t.ended or t.started) <= REVERT_SECONDS
        ]  # fmt: skip
        if path:
            for t in fresh:
                if any(
                    f == path or f.endswith(os.sep + path) or path.endswith(os.sep + f)
                    for f in t.files
                ):
                    return t
        return fresh[0] if fresh else None

    def on_command(self, kind: str, msg: dict[str, Any]) -> None:
        task = self._task_of(msg)
        if not self.measured(task):
            return
        track = self.tracks.get(task.id)
        if track is None:
            return
        if kind in ("task_interrupt", "task_cancel"):
            if track.current is not None:
                track.current.interrupted = True
        elif kind in ("task_undo", "task_revert"):
            path = _path(task, msg.get("path")) if kind == "task_revert" else ""
            turn = self._latest_change(track, path)
            if turn is not None:
                turn.undone = True
                self.outcome(turn, "reverted", how="undo" if kind == "task_undo" else "file")
        elif kind in ("task_rewind", "code_rewind"):
            if kind == "code_rewind" and msg.get("fork") is True:
                return  # (a fork leaves this session as it was)
            files = kind == "task_rewind" or msg.get("files") is True
            for turn in self._from_uuid(track, str(msg.get("uuid") or "")):
                if files and turn.files:
                    turn.undone = True
                self.outcome(turn, "rewound", files=files)

    def _from_uuid(self, track: Track, uuid: str) -> list[Turn]:
        """The turns a rewind to before uuid takes back: that one and the later ones (or
        the latest, when uuid isn't one of them)."""
        turns = list(track.turns)
        for i, turn in enumerate(turns):
            if uuid and turn.uuid == uuid:
                return turns[i:]
        latest = turns[-1] if turns else None
        if latest is None or self.clock() - (latest.ended or latest.started) > REVERT_SECONDS:
            return []
        return [latest]

    def on_hunk_undone(self, data: dict[str, Any]) -> None:
        if not self.on() or data.get("undone") is not True or not isinstance(data.get("id"), int):
            return
        track = self.tracks.get(data["id"])
        task = self.hub.tasks.tasks.get(data["id"])
        if track is None or task is None:
            return
        turn = self._latest_change(track, _path(task, data.get("file")))
        if turn is not None:
            turn.undone = True
            self.outcome(turn, "reverted", how="hunk")

    def on_copy_outcome(self, data: dict[str, Any]) -> None:
        """An isolated copy landed or discarded (features.code_isolation): its sessions'
        changes with it."""
        what = data.get("outcome")
        if not self.on() or what not in ("landed", "discarded"):
            return
        for task_id in data.get("tasks") or []:
            track = self.tracks.get(task_id) if isinstance(task_id, int) else None
            if track is None:
                continue
            for turn in track.turns:
                if turn.files and not turn.undone:
                    turn.undone = what == "discarded"
                    self.outcome(turn, what)

    def cmd_review(self, msg: dict[str, Any]) -> None:
        """Seconds the owner spent with a review pane open (the window measures them)."""
        if not self.on():
            return
        seconds = msg.get("seconds")
        pane = msg.get("pane")
        if (
            isinstance(seconds, bool)
            or not isinstance(seconds, int | float)
            or pane not in REVIEW_PANES
        ):
            return
        seconds = int(max(0, min(REVIEW_MAX, seconds)))
        if not seconds:
            return
        task = self._task_of(msg)
        record = {
            "v": 1,
            "kind": "review",
            "ts": iso(self.clock()),
            "seconds": seconds,
            "pane": pane,
        }
        if task is not None and getattr(task, "kind", "") == "code":
            record["project"] = self.project(task)
        self.log.append(record)

    # ── the verdict ──

    def _key(self) -> Any:
        try:
            return tuple((str(p), p.stat().st_size, p.stat().st_mtime_ns) for p in self.log.files())
        except OSError:
            return None

    def analyze_now(self) -> dict[str, Any]:
        """(In a thread.) The whole log read and weighed."""
        turns = stats.fold(self.log.read(), epoch_of)
        counts: dict[str, int] = {}
        for t in turns:
            counts[t["project"]] = counts.get(t["project"], 0) + 1
        projects = sorted((p for p, n in counts.items() if p), key=lambda p: -counts[p])
        found: list[dict[str, Any]] = stats.changes(turns, "")
        for project in projects if len(projects) > 1 else []:  # (one project: all of them)
            if counts[project] >= 2 * stats.MIN_TURNS:
                found += stats.changes(turns, project)
        for item in found:
            item["key"] = change_key(item)
        breakdown = {"": stats.breakdown(turns, "")}
        for project in projects[:20]:
            breakdown[project] = stats.breakdown(turns, project)
        return {
            "turns": len(turns),
            "since": turns[0]["ts"] if turns else None,
            "changes": found,
            "breakdown": breakdown,
            "projects": [{"hash": p, "turns": counts[p]} for p in projects[:20]],
        }

    async def analysis(self, fresh: bool = False) -> dict[str, Any]:
        await self.log.flush()
        key = self._key()
        if not fresh and key is not None and self._cache is not None and self._cache[0] == key:
            return self._cache[1]
        try:
            result = await asyncio.to_thread(self.analyze_now)
        except Exception:
            log.exception("Engine radar: couldn't read its log")
            result = {
                "turns": 0,
                "since": None,
                "changes": [],
                "breakdown": {"": []},
                "projects": [],
            }
        self._cache = (key, result)
        self._looked = time.monotonic()
        self._new = 0
        self._alert(result)
        return result

    def maybe_analyze(self) -> None:
        if self._new < ANALYZE_EVERY or time.monotonic() - self._looked < ANALYZE_GAP:
            return
        if self._looking is not None and not self._looking.done():
            return
        with contextlib.suppress(RuntimeError):
            self._looking = asyncio.get_running_loop().create_task(self.analysis())

    # ── its state: what was said, what was dismissed ──

    def state(self) -> dict[str, Any]:
        if self._state is None:
            data = None
            with contextlib.suppress(Exception):
                data = jsonstore.load_json(self.hub.feature_path(STATE_FILE), dict)
            self._state = data if isinstance(data, dict) else {}
            for name in ("alerted", "dismissed"):
                if not isinstance(self._state.get(name), list):
                    self._state[name] = []
        return self._state

    def _save(self) -> None:
        state = self.state()
        for name in ("alerted", "dismissed"):
            state[name] = [str(x)[:300] for x in state[name]][-STATE_KEPT:]
        with contextlib.suppress(Exception):
            jsonstore.save_json(
                self.hub.feature_path(STATE_FILE), dict(state), indent=None, backup=False
            )

    def names(self) -> dict[str, str]:
        """The projects' hashes this run can put a name to (its open sessions')."""
        out: dict[str, str] = {}
        for task in list(self.hub.tasks.tasks.values()):
            if getattr(task, "kind", "") != "code":
                continue
            with contextlib.suppress(Exception):
                folder = project_of(self.hub, task)
                out[project_hash(folder)] = Path(folder).name or folder
        return out

    def _alert(self, result: dict[str, Any]) -> None:
        state = self.state()
        said = set(state["alerted"])
        fresh: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
        for item in result.get("changes") or []:
            if item.get("status") != "shift" or item["key"] in state["dismissed"]:
                continue
            rows = [r for r in item["rows"] if r["significant"] and r["worse"]]
            # Said once per update and metric: a project's shift that all projects' already
            # told of (the same engines and models) isn't told again.
            pair = item["key"].split("|", 1)[1]
            new = [r for r in rows if f"{pair}|{r['metric']}" not in said]
            if new:
                fresh.append((item, rows))
                said.update(f"{pair}|{r['metric']}" for r in new)
                state["alerted"] += [f"{pair}|{r['metric']}" for r in new]
        if not fresh:
            return
        self._save()
        if self.hub.prefs.feature(PREF_ALERTS) is False:
            return
        names = self.names()
        for item, rows in fresh[:3]:
            text = self.alert_text(item, rows, names)
            with contextlib.suppress(Exception):
                self.hub.notify(
                    Alert(
                        f"code-radar:{item['key']}",
                        "radar",
                        self.tr("Eden Code engine radar"),
                        text,
                    ),
                    speak_if_busy=False,
                )

    def alert_text(
        self, item: dict[str, Any], rows: list[dict[str, Any]], names: dict[str, str]
    ) -> str:
        what = "; ".join(
            f"{self.tr(r['label']).lower()} {_shown(r, 'before')} → {_shown(r, 'after')}"
            for r in rows[:3]
        )
        scope = item.get("scope") or ""
        family = item.get("family") or "?"
        where = (
            self.tr("{family} in {project} ", family=family, project=names.get(scope, scope))
            if scope
            else self.tr("{family} ", family=family)
        )
        before, after = item["before"], item["after"]
        if item.get("change") in ("engine", "both"):
            return self.tr(
                "Since Claude Code {after} (from {before}), {where}got worse: {what}. Open Engine radar to go back or pin a version.",
                after=after["engine"],
                before=before["engine"],
                where=where,
                what=what,
            )
        return self.tr(
            "Since {after} (from {before}), {where}got worse: {what}. Open Engine radar to see more.",
            after=after["model"],
            before=before["model"],
            where=where,
            what=what,
        )

    def health(self, result: dict[str, Any] | None) -> dict[str, Any] | None:
        """The Health pane's line: shifts not dismissed, and what's being watched."""
        if result is None:
            return None
        dismissed = set(self.state()["dismissed"])
        live = [c for c in result.get("changes") or [] if c["key"] not in dismissed]
        shifts = [c for c in live if c["status"] == "shift"]
        status = (
            "shift"
            if shifts
            else (
                "collecting"
                if any(c["status"] == "collecting" for c in live)
                else ("steady" if live else "empty")
            )
        )
        return {
            "status": status,
            "shifts": len(shifts),
            "turns": result.get("turns", 0),
            "on": self.on(),
        }

    # ── the window ──

    async def cmd_radar(self, msg: dict[str, Any]) -> None:
        result = await self.analysis(fresh=msg.get("fresh") is True)
        self.hub.emit(
            "cw_radar",
            **result,
            names=self.names(),
            dismissed=list(self.state()["dismissed"]),
            on=self.on(),
        )

    async def cmd_dismiss(self, msg: dict[str, Any]) -> None:
        key = str(msg.get("key") or "")[:300]
        if key:
            state = self.state()
            if msg.get("undo") is True:
                state["dismissed"] = [k for k in state["dismissed"] if k != key]
            elif key not in state["dismissed"]:
                state["dismissed"].append(key)
            self._save()
        await self.cmd_radar({})

    async def nightly(self) -> None:
        while True:
            now = datetime.now()
            at = now.replace(hour=NIGHTLY[0], minute=NIGHTLY[1], second=0, microsecond=0)
            if at <= now:
                at += timedelta(days=1)
            await asyncio.sleep(max(60.0, (at - now).total_seconds()))
            with contextlib.suppress(Exception):
                await asyncio.to_thread(self.log.prune)


def change_key(item: dict[str, Any]) -> str:
    b, a = item["before"], item["after"]
    return f"{item['scope']}|{item['family']}|{b['engine']}/{b['model']}>{a['engine']}/{a['model']}"


def _shown(row: dict[str, Any], side: str) -> str:
    value = row.get(side)
    if value is None:
        return "–"
    if row["kind"] == "share":
        return f"{round(value * 100)}%"
    if row["kind"] == "cost":
        return f"${value:.2f}"
    return f"{value:.1f}"


def _sdk() -> str:
    with contextlib.suppress(Exception):
        import claude_agent_sdk

        return str(getattr(claude_agent_sdk, "__version__", "") or "")[:40]
    return ""


def _turn_cost(task: Any) -> float | None:
    """The turn's cost as Claude Code priced it (its transcript's turn line)."""
    for entry in reversed(list(getattr(task, "transcript", []) or [])[-8:]):
        if entry.get("role") == "turn":
            cost = entry.get("cost")
            if isinstance(cost, int | float) and not isinstance(cost, bool):
                return round(max(0.0, float(cost)), 6)
            return None
    return None


def install(hub: Any) -> None:
    radar = Radar(hub)
    hub.code_radar = radar
    hub.add_task_sink(radar.on_task_event)
    hub.tasks.message_sinks.append(radar.on_message)
    hub.add_event_sink(["code_hunk_undone"], radar.on_hunk_undone)
    hub.add_event_sink(["code_copy_outcome"], radar.on_copy_outcome)
    for kind in ("task_interrupt", "task_cancel", *_RETRYABLE):
        hub.register_command(kind, radar.observer(kind))
    hub.register_command("cw_radar", lambda msg: hub._spawn(radar.cmd_radar(msg)))
    hub.register_command("cw_radar_dismiss", lambda msg: hub._spawn(radar.cmd_dismiss(msg)))
    hub.register_command("cw_review_time", radar.cmd_review)
    hub.register_loop("code_radar_nightly", radar.nightly)
    hub.add_quit_hook(radar.log.flush_now)
