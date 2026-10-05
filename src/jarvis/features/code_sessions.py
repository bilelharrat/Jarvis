"""Jarvis Code sessions that outlast a restart, and the tools for keeping many of them.

- Every session the list shows is kept (session_store): after a restart the open ones come
  back "resting", with their settings, queue, draft, latest permission decisions, sidebar
  filing and goal. None starts Claude Code by itself: a resting session reads its
  conversation back when it's opened, and resumes (within TaskManager's cap on open
  processes) when it's sent a message, or when it's opened with messages waiting. One
  that was waiting out Claude's usage limit still waits (code_limit), and carries on when
  the limit resets, as it would have.
- Kept sessions let go from the list are held as their lines in the history alone; the
  whole record is read back from disk when one is reopened.
- Rewind in place: the conversation goes back to just before one of the user's messages
  (Claude Code resumes the same session at that point: ClaudeAgentOptions.resume_session_at,
  without forking), the files too if asked, and edit-and-resend sends new words from there
  (or from a fork, leaving the original as it was).
- The agent board's figures (lines changed, branch, last activity), the sidebar's pins,
  archive and groups, per-session drafts, /btw and /goal (code_asides), and projects beyond
  the projects folder with their own defaults (code_projects).

Claude cost policy: see code_asides (Haiku only, on the user's /btw and while a goal of
theirs is on, each capped per hour); nothing else here calls a model.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from .. import code_asides, code_projects, prefs, worktrees
from ..hub import _msg_int
from ..session_store import (
    AUDIT_KEEP,
    FILES_KEEP,
    KEEP_LIMIT,
    QUEUE_KEEP,
    REMEMBERED_LIMIT,
    TEXT_LIMIT,
    SessionStore,
)
from ..tasks import MAX_ENDED, ClaudeTask, auto_capable, session_history

log = logging.getLogger("jarvis")

prefs.register_feature_pref(
    "code_project_roots", [], code_projects.clean_folders(code_projects.ROOTS_MAX)
)
prefs.register_feature_pref(
    "code_project_folders", [], code_projects.clean_folders(code_projects.FOLDERS_MAX)
)
prefs.register_feature_pref("code_project_defaults", {}, code_projects.clean_defaults)
prefs.register_feature_pref("code_snippets", [], code_projects.clean_snippets)
prefs.register_feature_pref("code_groups", [], code_projects.clean_groups)

SAVE_DELAY = 1.0  # a burst of changes is saved once, this long after it starts
PARKED_DAYS = 14  # a session whose folder isn't there is kept this long, in case it's back
# The board's line counts for a session, reused this long: past the open board's own poll
# (every 15 s, web/features/code-board.js), so git runs at most every other one.
BOARD_TTL = 25.0
# Commands that await a while (a model's answer, git, Claude Code, the projects' list):
# the hub runs them in the background, never holding up the window's next command.
SLOW = {
    "code_session_open", "code_rewind", "code_board", "code_btw", "code_goal",
    "code_goal_new", "code_project_add", "code_project_remove",
}  # fmt: skip
BRANCH_TTL = 30.0
BTW_AT_ONCE = 2


def install(hub: Any) -> None:
    CodeSessions(hub).install()


class CodeSessions:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.tm = hub.tasks
        self.store = SessionStore(hub.feature_path("code_sessions"))
        self.projects = code_projects.Projects(hub.settings, lambda: hub.prefs)
        self.keys: dict[int, str] = {}  # task id -> its session's key, the same across restarts
        self.meta: dict[str, dict[str, Any]] = {}  # key -> what the sidebar and composer keep
        self.remembered: dict[str, dict[str, Any]] = {}  # Claude session id -> how it was set
        self.armed = False  # the kept sessions have been read back: saving may begin
        self.frozen = False  # the app is quitting: what was saved stands
        self._timer: asyncio.TimerHandle | None = None
        self._saving = False
        self._again = False
        self._writers: set[asyncio.Future] = set()
        self._printed: dict[str, tuple] = {}  # key -> what its last save was made from
        self.parked: set[str] = set()  # kept sessions whose folder isn't there just now
        # Kept sessions let go from the list (older than the MAX_ENDED ended ones it shows):
        # key -> their line in the history (_line), on disk whole, to reopen as they were.
        # Thousands of them, each with its permission decisions: only the line is held.
        self.dormant: dict[str, dict[str, Any]] = {}
        # Ones let go just now: key -> the whole record, ended, until it's saved so.
        self.letting_go: dict[str, dict[str, Any]] = {}
        self.last_record: dict[str, dict[str, Any]] = {}  # key -> its record as last saved
        self._remembered_saved: dict[str, dict[str, Any]] = {}
        self.btw_hour = code_asides.Rate(code_asides.BTW_PER_HOUR, 3600)
        self.btw_day = code_asides.Rate(code_asides.BTW_PER_DAY, 86400)
        self.checks_hour = code_asides.Rate(code_asides.CHECKS_PER_HOUR, 3600)
        self._btw_running = 0
        self._checking: set[int] = set()
        self.native_goal: bool | None = None  # Claude Code has a /goal of its own (None: unknown)
        self._lines: dict[int, tuple[float, tuple, tuple[int, int]]] = {}
        self._branches: dict[str, tuple[float, str]] = {}

    # ── wiring ──

    def install(self) -> None:
        hub, tm = self.hub, self.tm
        hub.code_sessions = self  # for other features (the voice supervisor, say)
        tm.more_projects = self.projects.more
        tm.start_defaults = self.start_defaults
        tm.turn_note = self.turn_note
        tm.revive = self.revive
        tm.more_history = self.more_history
        hub.add_task_sink(self.heard)  # every event of the sessions, as the windows get it
        # At quit, saved before anything is stopped: as it was.
        tm.before_close.append(lambda: self.flush(final=True))
        for kind, handler in {
            "code_meta_get": self._cmd_meta,
            "code_session_open": self._cmd_open,
            "code_draft": self._cmd_draft,
            "code_meta_set": self._cmd_meta_set,
            "code_group": self._cmd_group,
            "code_rewind": self._cmd_rewind,
            "code_board": self._cmd_board,
            "code_btw": self._cmd_btw,
            "code_goal": self._cmd_goal,
            "code_goal_new": self._cmd_goal_new,
            "code_project_add": self._cmd_project_add,
            "code_project_remove": self._cmd_project_remove,
        }.items():
            hub.register_command(kind, handler, slow=kind in SLOW)
        hub.register_loop("code_sessions", self.restore)

    def heard(self, kind: str, data: dict[str, Any]) -> None:
        """Every event of the sessions (TaskManager.emit)."""
        if kind == "tasks":
            self.save_soon()
        elif kind == "task_finished" and data.get("task_kind") == "code":
            self._turn_ended(data)
            self.save_soon()
        elif kind == "task_log" and (data.get("entry") or {}).get("role") == "user":
            goal = self._goal_of(data.get("id"))
            if goal is not None:
                goal["nudges"] = 0  # the user said something: the tries count again

    def _code_tasks(self) -> list[ClaudeTask]:
        return [t for t in self.tm.tasks.values() if t.kind == "code"]

    def _task(self, msg: dict[str, Any]) -> ClaudeTask | None:
        task = self.tm.tasks.get(_msg_int(msg, "id"))
        return task if task is not None and task.kind == "code" else None

    def key_for(self, task: ClaudeTask) -> str:
        key = self.keys.get(task.id)
        if key is None:
            key = self.keys[task.id] = uuid.uuid4().hex[:16]
            self.meta[key] = self._blank_meta(task.started.isoformat(timespec="seconds"))
        return key

    @staticmethod
    def _blank_meta(created: str) -> dict[str, Any]:
        return {
            "created": created,
            "updated": created,
            "pinned": False,
            "archived": False,
            "group": "",
            "draft": "",
            "goal": None,
            "version": 0,
        }

    def _meta_of(self, task: ClaudeTask) -> dict[str, Any]:
        return self.meta[self.key_for(task)]

    def _goal_of(self, task_id: Any) -> dict[str, Any] | None:
        key = self.keys.get(task_id) if isinstance(task_id, int) else None
        goal = self.meta.get(key, {}).get("goal") if key else None
        return goal if isinstance(goal, dict) else None

    def _touched(self, meta: dict[str, Any]) -> None:
        meta["version"] = meta.get("version", 0) + 1
        self.save_soon()

    def emit_meta(self, full: bool = False) -> None:
        self.hub.emit("code_meta", **self.meta_event(full))

    def meta_event(self, full: bool = False) -> dict[str, Any]:
        items: dict[str, dict[str, Any]] = {}
        for task in self._code_tasks():
            key = self.key_for(task)
            meta = self.meta[key]
            item = {
                "key": key,
                "pinned": meta["pinned"],
                "archived": meta["archived"],
                "group": meta["group"],
                "goal": meta["goal"],
                "resting": task.status == "resting",
                "history": task.history_read or not task.session_id,
                "updated": meta["updated"],
            }
            if full and meta["draft"]:
                item["draft"] = meta["draft"]
            items[str(task.id)] = item
        return {"items": items, "full": full, "native_goal": self.native_goal}

    # ── keeping sessions across a restart ──

    async def restore(self) -> int:
        """Bring back the kept sessions, resting (the hub's loop, once, at startup). Saving
        starts only after this: before it, a save would drop them all."""
        if self.armed:
            return 0
        try:
            records = await asyncio.to_thread(self.store.load)
        except Exception:
            log.exception("Jarvis Code: couldn't read the kept sessions")
            records = []
        # Read on its own: the sessions read above count as read (the store saves over and
        # lets go of what it has read), so dropping them for this file's sake had the next
        # save delete every kept session. A remembered.json that can't be read stays as it is.
        try:
            self.remembered = await asyncio.to_thread(self.store.load_remembered)
        except Exception:
            log.exception("Jarvis Code: couldn't read how past sessions were set")
            self.store.remembered_unreadable = "it couldn't be read"
        self._remembered_saved = dict(self.remembered)
        restored = 0
        self._ids_past(records)
        # The open ones come back, and the newest MAX_ENDED ended ones the list shows; the
        # rest stay kept, in the history, until one is reopened (revive).
        ended = [r for r in records if r["ended"]]
        for record in ended[: max(0, len(ended) - MAX_ENDED)]:
            self.dormant[record["key"]] = _line(record)  # (saved ended already)
        records = [r for r in records if r["key"] not in self.dormant]
        for record in records:
            try:
                restored += self._restore_one(record)
            except Exception:
                log.exception("Jarvis Code: couldn't bring back session %s", record.get("key"))
        self.armed = True
        if restored:
            self.tm._changed()
            self.emit_meta(full=True)
        return restored

    def _ids_past(self, records: list[dict[str, Any]]) -> None:
        """New sessions' ids start past every kept one's, so a kept one's id is its own
        whenever it comes back: the window's selection outlasts a restart."""
        top = max((r["id"] for r in records), default=0)
        nxt = next(self.tm._ids)
        self.tm._ids = itertools.count(max(nxt, top + 1))

    def _new_id(self, record: dict[str, Any]) -> int:
        own = record.get("id") or 0
        if own and own not in self.tm.tasks:
            return own
        return next(self.tm._ids)

    def revive(self, session_id: str) -> int | None:
        """A kept session let go from the list, reopened from the history: back resting,
        with its own id, settings, queue and filing (not a bare resume elsewhere: one in
        an isolated copy resumes in its copy). None: not one of the kept ones."""
        key = next((k for k, r in self.dormant.items() if r["session_id"] == session_id), None)
        if key is None:
            return None
        # Whole: as it was let go (not saved yet), else read back from its file.
        record = self.letting_go.get(key) or self.store.read(key)
        if record is None:
            return None  # (its file can't be read just now: kept, in the history)
        line = self.dormant.pop(key)
        try:
            if self._restore_one(record):
                self.letting_go.pop(key, None)
                self.tm._changed()
                self.emit_meta(full=True)
                return next((i for i, k in self.keys.items() if k == key), None)
        except Exception:
            log.exception("Jarvis Code: couldn't reopen kept session %s", key)
        self.dormant[key] = line  # (kept all the same)
        return None

    def more_history(self) -> list[dict[str, Any]]:
        """The kept sessions let go from the list, as history entries (tasks.recent_sessions),
        under the project they belong to (a copy's, its project's). Read in a thread, while
        the loop may let more go: the kept ones as they are when it starts."""
        copies: dict[Path, str] | None = None
        out = []
        for record in list(self.dormant.values()):
            if not record["session_id"]:
                continue
            cwd = Path(record["cwd"])
            folder = cwd.name
            try:
                if copies is None:
                    copies = self._copy_projects()
                found = copies.get(cwd.resolve()) if copies else None
                if found is not None:
                    folder = found
            except Exception:  # no copies kept: the folder's own name
                pass
            try:
                when = datetime.fromisoformat(record["updated"])
            except ValueError:
                when = datetime.now()
            out.append(
                {
                    "session_id": record["session_id"],
                    "title": record["title"] or record["prompt"][:80],
                    "first_prompt": record["prompt"][:200],
                    "last_modified": when.isoformat(timespec="minutes"),
                    "modified": int(when.timestamp() * 1000),
                    "branch": "",
                    "folder": folder,
                    "kept": True,
                }
            )
        return out

    def _copy_projects(self) -> dict[Path, str]:
        """{each isolated copy's folder, followed on the disk: its project}, the first copy's
        where two share one (CopyStore.by_path's answer for each folder, with every copy's
        folder looked up once rather than once for each kept session: thousands of them)."""
        found: dict[Path, str] = {}
        for copy in worktrees.CopyStore(self.hub.feature_path("code_copies.json")).copies:
            with contextlib.suppress(OSError):
                found.setdefault(copy.cwd.resolve(), copy.project)
        return found

    def _restore_one(self, record: dict[str, Any]) -> int:
        tm = self.tm
        key = record["key"]
        if key in self.meta or (
            record["session_id"]
            and any(t.session_id == record["session_id"] for t in self._code_tasks())
        ):
            return 0  # already open here
        try:
            cwd = tm.resolve_dir(record["cwd"])
        except ValueError as exc:
            log.warning("Jarvis Code: not bringing back a session in %s (%s)", record["cwd"], exc)
            try:  # its folder may be back (a disk not there just now): kept a while
                age = datetime.now() - datetime.fromisoformat(record["updated"])
            except ValueError:
                return 0
            if age.days < PARKED_DAYS:
                self.parked.add(key)
            return 0
        notes: list[str] = []
        model, label, ref = record["model"], record["model_label"], record["model_ref"]
        env: dict[str, str] = {}
        settings = ""
        if ref.startswith("custom:") and getattr(self.hub, "providers", None) is not None:
            try:  # the key helper and routing, fresh from the store (none of it is kept)
                cfg = self.hub.providers.session_config(ref)
                model, label = cfg["model"] or model, cfg["label"] or label
                env, settings = dict(cfg["env"]), cfg.get("settings") or ""
            except ValueError:
                model, label, ref = "", "", ""
                notes.append("The model it was on isn't available any more: it uses the default.")
        mode = record["mode"]
        if mode == "smart" and not auto_capable(model or tm.model):
            mode = "ask"
        ended = record["ended"]
        task = ClaudeTask(
            id=self._new_id(record),
            prompt=record["prompt"],
            cwd=cwd,
            mode=mode,
            session_id=record["session_id"],
            title=record["title"],
            model=model,
            model_label=label,
            model_ref=ref,
            effort=record["effort"],
            env=env,
            provider_settings=settings,
            ultracode=record["ultracode"],
            add_dirs=list(record["add_dirs"]),
            plugins=list(record["plugins"]),
            disabled_mcp=set(record["disabled_mcp"]),
            status=record["status"] if ended else "resting",
            last_action={"stopped": "Stopped", "failed": "Failed"}.get(record["status"], "Stopped")
            if ended
            else "Resting",
            result=record["result"],
            plan=record["plan"],
            todos=list(record["todos"]),
            cost_usd=record["cost_usd"],
            files_changed=set(record["files_changed"]),
            commands=record["commands"],
            fork=record["fork"] and bool(record["session_id"]),
            resume_at=record["resume_at"],
            audit=list(record["audit"]),
        )
        try:
            task.started = datetime.fromisoformat(record["created"])
        except ValueError:
            pass
        for item in record["queue"]:
            task.inbox.put(item["text"], plain=item["plain"])
        tm.tasks[task.id] = task
        self.keys[task.id] = key
        self.last_record[key] = record
        meta = self._blank_meta(record["created"])
        goal = code_asides.clean_goal(record["goal"])
        if goal is not None and goal["native"] and goal["state"] == "active":
            # Claude Code's own goal lived in the process that's gone: set it again to go on.
            goal["state"], goal["note"] = "paused", "Paused by the restart."
        meta.update(
            updated=record["updated"],
            pinned=record["pinned"],
            archived=record["archived"],
            group=record["group"],
            draft=record["draft"],
            goal=goal,
        )
        self.meta[key] = meta
        if record["dropped"]:
            notes.append(
                "Pictures and files attached to a waiting message didn't outlast the restart."
            )
        waiting = getattr(self.hub, "code_limit", None)
        held = record["hold_until"] > 0 and not ended and waiting is not None
        if record["was_working"] and not ended and not held:
            notes.append(
                "JARVIS restarted while this session was working. Send a message to carry on."
            )
        elif not ended and not held:
            notes.append(
                "Back after the restart: it picks up where it left off with your next message."
            )
        for note in notes:
            tm._log(task, "system", note)
        if held:  # waiting out Claude's usage limit still: it carries on when that resets
            waiting.resume(task, record["hold_until"], record["held_since"])
        return 1

    def save_soon(self) -> None:
        if not self.armed or self.frozen or self._timer is not None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # no loop (a caller outside one): the next change saves
            return
        self._timer = loop.call_later(SAVE_DELAY, self._save_now)

    def _save_now(self) -> None:
        self._timer = None
        if not self.armed or self.frozen:
            return
        if self._saving:
            self._again = True  # one after this one
            return
        self._saving = True
        changed, keep, remembered = self.snapshot()
        writer = asyncio.ensure_future(self._write(changed, keep, remembered))
        self._writers.add(writer)
        writer.add_done_callback(self._writers.discard)

    async def _write(self, changed: dict, keep: set[str], remembered: dict) -> None:
        try:
            await asyncio.to_thread(self._write_all, changed, keep, remembered)
        except Exception as exc:  # a full disk: kept in memory, tried again at the next change
            log.warning("Jarvis Code: couldn't save the sessions (%s)", exc)
            for key in changed:
                self._printed.pop(key, None)
        else:
            self._saved(changed)
        finally:
            self._saving = False
            if self._again:
                self._again = False
                self.save_soon()

    def _write_all(self, changed: dict, keep: set[str], remembered: dict | None) -> None:
        self.store.save(changed, keep)
        if remembered is not None:
            self.store.save_remembered(remembered)

    async def flush(self, final: bool = False) -> None:
        """Save now (at quit, final: what's saved is how things were before anything
        stopped; nothing is saved after it)."""
        if not self.armed or self.frozen:
            return
        if final:
            self.frozen = True
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
        if self._writers:  # a save under way finishes first: this one is the newer
            await asyncio.gather(*list(self._writers), return_exceptions=True)
        changed, keep, remembered = self.snapshot()
        try:
            await asyncio.to_thread(self._write_all, changed, keep, remembered)
        except Exception as exc:
            log.warning("Jarvis Code: couldn't save the sessions (%s)", exc)
        else:
            self._saved(changed)

    def _saved(self, changed: dict[str, dict[str, Any]]) -> None:
        """The records of sessions let go from the list are on disk, ended: only their lines
        are held from now on."""
        for key, record in changed.items():
            if self.letting_go.get(key) is record:
                del self.letting_go[key]

    def snapshot(self) -> tuple[dict[str, dict[str, Any]], set[str], dict | None]:
        """(the records changed since the last save, every key kept, the remembered
        settings when they changed), from the sessions as they are now."""
        tasks = self._code_tasks()
        live = {t.id for t in tasks}
        for task_id in [i for i in self.keys if i not in live]:
            key = self.keys.pop(task_id)  # let go from the list (pruned): kept, never lost
            self.meta.pop(key, None)
            record = self.last_record.pop(key, None)
            if record is not None:
                record = {**record, "ended": True, "status": record["status"] or "stopped"}
                self.letting_go[key] = record
                self.dormant[key] = _line(record)
        # Every session the list shows, however many: the list itself lets the ended ones go
        # (TaskManager._prune, past MAX_ENDED), and those are kept above, as dormant. Cut
        # here, a listed one would be neither, and the store would delete its file: open
        # sessions come back resting at each restart and are never pruned, so past
        # STORE_LIMIT of them the oldest (drafts, queues, goals) were lost.
        kept = [t for t in tasks if self._worth_keeping(t)]
        changed: dict[str, dict[str, Any]] = {}
        keep: set[str] = set()
        for task in kept:
            key = self.key_for(task)
            keep.add(key)
            self._remember(task)
            printed = self._print(task, self.meta[key])
            if self._printed.get(key) != printed:
                changed[key] = self.last_record[key] = self._record(task, key)
                self._printed[key] = printed
        for key in [k for k in self._printed if k not in keep]:
            del self._printed[key]
        keep |= self.parked  # (never rewritten: only not let go)
        if len(self.dormant) > KEEP_LIMIT:  # (the oldest past thousands, only then)
            oldest = sorted(self.dormant, key=lambda k: self.dormant[k]["updated"])
            for key in oldest[: len(self.dormant) - KEEP_LIMIT]:
                del self.dormant[key]
                self.letting_go.pop(key, None)
        keep.update(self.dormant)
        changed.update(self.letting_go)  # ended, as they're kept from now (till saved so)
        remembered = None
        if self.remembered != self._remembered_saved:
            remembered = dict(self.remembered)
            self._remembered_saved = dict(self.remembered)
        return changed, keep, remembered

    @staticmethod
    def _ended(task: ClaudeTask) -> bool:
        live = task.handle is not None and not task.handle.done()
        return task.ending or (not live and task.status in ("stopped", "failed"))

    def _worth_keeping(self, task: ClaudeTask) -> bool:
        meta = self.meta.get(self.keys.get(task.id, ""), {})
        return bool(
            task.session_id
            or not task.inbox.empty()
            or task.in_flight is not None
            or meta.get("draft")
            or meta.get("goal")
        )

    @staticmethod
    def _queue(task: ClaudeTask) -> tuple[list[dict[str, Any]], int]:
        """What's waiting, as it would go: messages sent into the step and not taken up, the
        one on its way, then the queue. Only words are kept; the app's own notes aren't."""
        waiting = [
            *task.steered_items,
            *([task.in_flight] if task.in_flight else []),
            *getattr(task.inbox, "_items", []),
        ]
        kept, dropped = [], 0
        for item in waiting:
            if item.get("note"):
                continue
            dropped += len(item.get("images") or [])
            text = str(item.get("text") or "")
            if text.strip():
                kept.append({"text": text[:TEXT_LIMIT], "plain": bool(item.get("plain"))})
        return kept[:QUEUE_KEEP], dropped

    @staticmethod
    def _print(task: ClaudeTask, meta: dict[str, Any]) -> tuple:
        """What a session's saved record depends on, cheaply: equal means nothing to write."""
        audit = task.audit[-1] if task.audit else {}
        last = task.transcript[-1] if task.transcript else {}
        return (
            task.status,
            task.last_action,
            task.busy,
            task.ending,
            task.session_id,
            task.title,
            task.mode,
            task.model,
            task.model_ref,
            task.effort,
            task.ultracode,
            tuple(task.add_dirs),
            tuple(task.plugins),
            tuple(sorted(task.disabled_mcp)),
            len(task.audit),
            audit.get("at"),
            audit.get("what"),
            tuple(i.get("id") for i in getattr(task.inbox, "_items", [])),
            id(task.in_flight),
            len(task.steered_items),
            task.cost_usd,
            len(task.files_changed),
            task.commands,
            task.fork,
            task.resume_at,
            task.hold_until,
            len(task.transcript),
            last.get("n"),
            meta.get("version"),
        )

    def _record(self, task: ClaudeTask, key: str) -> dict[str, Any]:
        meta = self.meta[key]
        if task.transcript:
            meta["updated"] = str(task.transcript[-1].get("at") or meta["updated"])
        queue, dropped = self._queue(task)
        ended = self._ended(task)
        return {
            "v": 1,
            "key": key,
            "id": task.id,
            "cwd": str(task.cwd),
            "session_id": task.session_id,
            "title": task.title,
            "prompt": task.prompt[:500],
            "mode": task.mode,
            "model": task.model,
            "model_label": task.model_label,
            "model_ref": task.model_ref,
            "effort": task.effort,
            "ultracode": task.ultracode,
            "add_dirs": list(task.add_dirs),
            "plugins": list(task.plugins),
            "disabled_mcp": sorted(task.disabled_mcp),
            "queue": queue,
            "dropped": dropped,
            "draft": meta["draft"],
            "audit": task.audit[-AUDIT_KEEP:],
            "ended": ended,
            "status": (task.status if task.status in ("stopped", "failed") else "stopped")
            if ended
            else "",
            "was_working": task.busy,
            "last_action": task.last_action[:200],
            "result": task.result[-2000:],
            "plan": task.plan[:4000],
            "todos": list(task.todos),
            "cost_usd": task.cost_usd,
            "files_changed": sorted(task.files_changed)[:FILES_KEEP],
            "commands": task.commands,
            "fork": task.fork,
            "resume_at": task.resume_at,
            **self._held(task, ended),
            "created": meta["created"],
            "updated": meta["updated"],
            "pinned": meta["pinned"],
            "archived": meta["archived"],
            "group": meta["group"],
            "goal": meta["goal"],
        }

    def _held(self, task: ClaudeTask, ended: bool) -> dict[str, float]:
        """Until when a session waits out Claude's usage limit, and since when (code_limit):
        kept, so after a restart it still waits, and carries on when the limit resets."""
        waiting = getattr(self.hub, "code_limit", None)
        if ended or waiting is None or task.hold_until <= 0:
            return {"hold_until": 0.0, "held_since": 0.0}
        return {"hold_until": task.hold_until, "held_since": waiting.since.get(task.id, 0.0)}

    def _remember(self, task: ClaudeTask) -> None:
        """How a session is set, by its Claude Code session id: resumed later from the
        history, it starts that way again (Bypass permissions aside: that's chosen afresh)."""
        if not task.session_id or task.fork:
            return
        settings = {
            "mode": task.mode if task.mode != "auto" else "",
            "model": task.model_ref or task.model,
            "effort": task.effort,
            "ultracode": task.ultracode,
            "add_dirs": list(task.add_dirs),
            "plugins": list(task.plugins),
        }
        settings = {k: v for k, v in settings.items() if v not in ("", [])}
        if self.remembered.get(task.session_id) != settings:
            self.remembered.pop(task.session_id, None)
            self.remembered[task.session_id] = settings  # newest last
            for stale in list(self.remembered)[:-REMEMBERED_LIMIT]:
                del self.remembered[stale]

    # ── TaskManager's hooks ──

    def start_defaults(self, path: Path, session_id: str) -> dict[str, Any]:
        """A new session in this project: the project's own defaults; resumed from the
        history, as that session last ran."""
        found = self.projects.defaults(path)
        found.update(self.remembered.get(session_id, {}) if session_id else {})
        return found

    def turn_note(self, task: ClaudeTask) -> str:
        return code_asides.turn_note(self._goal_of(task.id))

    # ── window commands ──

    def _cmd_meta(self, _msg: dict[str, Any]) -> None:
        self.emit_meta(full=True)
        self.hub.emit("code_projects", **self.projects_event())

    def projects_event(self) -> dict[str, Any]:
        """Settings › Projects: where projects are listed from, and what's left off."""
        return {
            "main": str(self.hub.settings.projects_dir),
            "roots": [str(p) for p in self.projects.roots()],
            "folders": [str(p) for p in self.projects.folders()],
            "hidden": self.projects.hidden(),
        }

    async def _cmd_open(self, msg: dict[str, Any]) -> None:
        """A session was opened in the window: a resting one reads its conversation back
        (no Claude Code yet), and resumes if messages are waiting for it."""
        task = self._task(msg)
        if task is None:
            return
        idle = task.handle is None or task.handle.done()
        if idle and not task.history_read and task.session_id:
            await self.tm._read_history(task)
            self.emit_meta()
        held = task.hold_until > time.time()  # (waiting out Claude's limit: it carries on then)
        if idle and task.status == "resting" and not task.inbox.empty() and not held:
            self._wake(task)

    def _wake(self, task: ClaudeTask) -> None:
        if task.handle is None or task.handle.done():
            task.status, task.restarts = "running", 0
            task.handle = asyncio.create_task(self.tm._session(task))
            self.tm._changed()

    def _cmd_draft(self, msg: dict[str, Any]) -> None:
        task, text = self._task(msg), msg.get("text")
        if task is None or not isinstance(text, str):
            return
        meta = self._meta_of(task)
        if meta["draft"] != text[:TEXT_LIMIT]:
            meta["draft"] = text[:TEXT_LIMIT]
            self._touched(meta)

    def _cmd_meta_set(self, msg: dict[str, Any]) -> None:
        """Pin, archive or file a session in a group (the sidebar's menu)."""
        task = self._task(msg)
        if task is None:
            return
        meta = self._meta_of(task)
        if isinstance(msg.get("pinned"), bool):
            meta["pinned"] = msg["pinned"]
        if isinstance(msg.get("archived"), bool):
            meta["archived"] = msg["archived"]
            if msg["archived"]:
                meta["pinned"] = False
        if isinstance(msg.get("group"), str):
            group = " ".join(msg["group"].split())[:40]
            groups = list(self.hub.prefs.feature("code_groups") or [])
            if group and group.lower() not in {g.lower() for g in groups}:
                if len(groups) >= code_projects.GROUPS_MAX:
                    self._note("That's as many groups as the sidebar keeps.")
                    return
                self.hub.set_feature_prefs({"code_groups": [*groups, group]})
            else:
                group = next((g for g in groups if g.lower() == group.lower()), group)
            meta["group"] = group
        self._touched(meta)
        self.emit_meta()

    def _cmd_group(self, msg: dict[str, Any]) -> None:
        """Add, rename or remove a sidebar group; its sessions follow a rename, and go back
        to no group when it's removed."""
        action = msg.get("action")
        name = " ".join(str(msg.get("name") or "").split())[:40]
        to = " ".join(str(msg.get("to") or "").split())[:40]
        groups = list(self.hub.prefs.feature("code_groups") or [])
        lowered = [g.lower() for g in groups]
        if action == "add" and name and name.lower() not in lowered:
            groups.append(name)
        elif action == "rename" and name in groups and to and to.lower() not in lowered:
            groups[groups.index(name)] = to
            for meta in self.meta.values():
                if meta["group"] == name:
                    meta["group"] = to
                    self._touched(meta)
        elif action == "remove" and name in groups:
            groups.remove(name)
            for meta in self.meta.values():
                if meta["group"] == name:
                    meta["group"] = ""
                    self._touched(meta)
        else:
            return
        self.hub.set_feature_prefs({"code_groups": groups})
        self.emit_meta()

    def _note(self, text: str) -> None:
        self.hub.emit("code_note", text=text)

    # ── rewinding the conversation in place ──

    async def _cmd_rewind(self, msg: dict[str, Any]) -> None:
        """Back to just before one of the user's messages: in place (the files too, if
        asked), or in a fork; with new words to send from there, if given."""
        task = self._task(msg)
        target = str(msg.get("uuid") or "")
        text = str(msg.get("text") or "").strip()[:TEXT_LIMIT]
        if task is None or not target:
            return
        if msg.get("fork") is True:
            fork = self.tm.fork(task.id, target)
            if fork is None:
                return  # (fork says why, in the session)
            if text:
                self.tm.send(fork.id, text)
            self.hub.emit("show_session", id=fork.id)
            return
        ok, reply = await self.rewind_in_place(task, target, files=msg.get("files") is True)
        # (the window says why it couldn't, where the message is being edited)
        self.hub.emit("code_rewound", id=task.id, uuid=target, ok=ok, text=reply)
        if ok and text:
            self.tm.send(task.id, text)

    async def rewind_in_place(self, task: ClaudeTask, target: str, files: bool) -> tuple[bool, str]:
        tm = self.tm
        if task.busy:
            return False, "It's still working. Stop it first, then rewind."
        if not task.session_id:
            return False, "There's no conversation to rewind yet."
        if not task.history_read and (task.handle is None or task.handle.done()):
            await tm._read_history(task)  # a resting session: its messages to go back to
        if target not in task.fork_points:
            return False, "Couldn't rewind to that message: it's too far back."
        point = task.fork_points[target]
        if files:
            if target not in task.checkpoints:
                return False, (
                    "Couldn't put the files back to before that message: it's too far back, "
                    "or they already are."
                )
            reply = await tm._rewind(task, target)
            if not reply.startswith("Rewound"):
                return False, reply
            if task.busy:
                return False, (
                    "The files are back as they were, but it started working again, so the "
                    "conversation wasn't rewound."
                )
        said = next(
            (e for e in task.transcript if e.get("role") == "user" and e.get("uuid") == target),
            None,
        )
        words = str(said.get("text") or "") if said is not None else ""
        if said is not None:
            del task.transcript[task.transcript.index(said) :]
        else:  # further back than the entries kept: read up to the point again
            past = (
                await asyncio.to_thread(session_history, task.session_id, task.cwd, point)
                if point
                else {"entries": []}
            )
            task.transcript[:] = past["entries"]
            for n, entry in enumerate(task.transcript, 1):
                entry["n"] = n
            task.seq = max(task.seq, len(task.transcript))
        if target in task.checkpoints:
            at = task.checkpoints.index(target)
            for gone in task.checkpoints[at:]:
                task.checkpoint_files.pop(gone, None)
            del task.checkpoints[at:]
        else:  # older than every checkpoint kept: they all came after it
            task.checkpoints.clear()
            task.checkpoint_files.clear()
        points = list(task.fork_points)
        for gone in points[points.index(target) :]:
            del task.fork_points[gone]
        task.last_uuid = point
        task.result = next(
            (e["text"] for e in reversed(task.transcript) if e.get("role") == "assistant"), ""
        )
        task.plan = next(
            (e["text"] for e in reversed(task.transcript) if e.get("role") == "plan"), ""
        )
        task.todos = next(
            (e.get("todos", []) for e in reversed(task.transcript) if e.get("role") == "todos"),
            [],
        )
        if not point:  # before the very first message: this session starts afresh
            task.session_id, task.resume_at, task.fork = "", "", False
        else:
            task.resume_at = point  # (a fork not yet started forks from further back)
        task.rewound = True  # the next connection starts there, even with nothing else new
        if task.client is not None:
            task.reopen, task.reopen_now, task.reopen_at = True, True, time.monotonic()
            task.stirred.set()
        short = " ".join(words.split())
        short = f"“{short[:60]}{'…' if len(short) > 60 else ''}”" if short else "that message"
        reply = (
            f"Rewound to before {short}: the conversation and the files are as they were then."
            if files
            else f"Rewound the conversation to before {short}. The files are as they are now."
        )
        tm._log(task, "system", reply)
        tm.emit("task_transcript", id=task.id, entries=list(task.transcript))
        tm._changed()
        return True, reply

    # ── the agent board ──

    async def _cmd_board(self, _msg: dict[str, Any]) -> None:
        """Figures for the board's cards: lines added and removed in the files each session
        changed, the branch, and when it last did something."""
        items: dict[str, dict[str, Any]] = {}
        for task in self._code_tasks():
            meta = self._meta_of(task)
            added, removed = await self._line_counts(task)
            updated = str(task.transcript[-1].get("at")) if task.transcript else meta["updated"]
            items[str(task.id)] = {
                "added": added,
                "removed": removed,
                "branch": str(getattr(task, "branch", "") or await self._branch(task.cwd)),
                "updated": updated,
            }
        self.hub.emit("code_board", items=items)

    async def _branch(self, cwd: Path) -> str:
        now = time.monotonic()
        cached = self._branches.get(str(cwd))
        if cached is not None and now - cached[0] < BRANCH_TTL:
            return cached[1]
        branch = await self.hub._git(cwd, "rev-parse", "--abbrev-ref", "HEAD", timeout=5)
        self._branches[str(cwd)] = (now, branch)
        return branch

    async def _line_counts(self, task: ClaudeTask) -> tuple[int, int]:
        root = task.cwd.resolve()
        files = tuple(
            sorted(
                f for f in task.files_changed if Path(f).is_absolute() and root in Path(f).parents
            )
        )[:FILES_KEEP]
        if not files:
            return 0, 0
        now = time.monotonic()
        cached = self._lines.get(task.id)
        if cached is not None and cached[1] == files and now - cached[0] < BOARD_TTL:
            return cached[2]
        added = removed = 0
        tracked: set[str] = set()
        out = await self.hub._git(task.cwd, "diff", "--numstat", "HEAD", "--", *files, timeout=10)
        for line in out.splitlines():
            parts = line.split("\t", 2)
            if len(parts) == 3:
                tracked.add(str(root / parts[2]))
                added += int(parts[0]) if parts[0].isdigit() else 0
                removed += int(parts[1]) if parts[1].isdigit() else 0
        others = await self.hub._git(
            task.cwd, "ls-files", "--others", "--exclude-standard", "--", *files, timeout=10
        )
        new = [str(root / p) for p in others.splitlines() if p and str(root / p) not in tracked]
        added += await asyncio.to_thread(_count_lines, new[:200])
        self._lines[task.id] = (now, files, (added, removed))
        return added, removed

    # ── /btw and /goal ──

    async def _cmd_btw(self, msg: dict[str, Any]) -> None:
        task = self._task(msg)
        question = str(msg.get("question") or "").strip()[:4000]
        ref = str(msg.get("ref") or "")[:40]
        if task is None or not question:
            return
        say = {"id": task.id, "ref": ref, "question": question}
        if self._btw_running >= BTW_AT_ONCE:
            self.hub.emit(
                "code_btw",
                **say,
                state="error",
                text="One side question at a time, please: one is still being answered.",
            )
            return
        if not (self.btw_hour.allow() and self.btw_day.allow()):
            self.hub.emit(
                "code_btw",
                **say,
                state="error",
                text="That's the most side questions for now (30 an hour, 150 a day).",
            )
            return
        self._btw_running += 1
        self.hub.emit("code_btw", **say, state="working")
        try:
            answer = await code_asides.one_shot(
                self.tm.client_factory,
                code_asides.btw_options(task.cwd),
                code_asides.btw_prompt(task, question),
                code_asides.BTW_SECONDS,
            )
        except TimeoutError:
            self.hub.emit("code_btw", **say, state="error", text="That took too long to answer.")
        except Exception as exc:
            log.warning("Jarvis Code: a side question failed (%s)", exc)
            self.hub.emit("code_btw", **say, state="error", text="Couldn't answer that just now.")
        else:
            self.hub.emit("code_btw", **say, state="done", text=answer or "No answer came back.")
        finally:
            self._btw_running -= 1

    async def native_goal_for(self, task: ClaudeTask) -> bool:
        """Whether this Claude Code has a /goal of its own (from its init answer, which lists
        its commands). Unknown until a session is connected: then Jarvis keeps the goal."""
        if self.native_goal is not None:
            return self.native_goal
        client = task.client
        if client is None or not hasattr(client, "get_server_info"):
            return False
        try:
            info = await client.get_server_info()
        except Exception:
            return False
        if not isinstance(info, dict):
            return False
        self.native_goal = code_asides.native_goal_command(info.get("commands"))
        return self.native_goal

    async def _cmd_goal(self, msg: dict[str, Any]) -> None:
        """/goal: set, edit, pause, resume, complete or clear a session's goal."""
        task = self._task(msg)
        if task is None:
            return
        action = msg.get("action")
        typed = str(msg.get("text") or "").strip()[: code_asides.GOAL_LIMIT]
        text = code_asides.one_line(typed)  # as it rides in the note, on one line
        meta = self._meta_of(task)
        goal = meta["goal"]
        idle = not task.busy and task.inbox.empty()
        if action == "set" or (action == "edit" and goal is None):
            if not text:
                return
            native = await self.native_goal_for(task)
            meta["goal"] = code_asides.new_goal(text, native)
            self.tm.send(task.id, f"/goal {text}" if native else typed, plain=native)
        elif goal is None:
            return
        elif action == "edit" and text:
            goal.update(text=text, state="active", nudges=0, checks=0, note="")
            if goal["native"]:
                self.tm.send(task.id, f"/goal {text}", plain=True)
        elif action == "pause" and goal["state"] == "active":
            goal.update(state="paused", note="Paused.")
            if goal["native"]:
                self.tm.send(task.id, "/goal clear", plain=True)
        elif action == "resume" and goal["state"] != "active":
            goal.update(state="active", nudges=0, note="")
            if goal["native"]:
                self.tm.send(task.id, f"/goal {goal['text']}", plain=True)
            elif idle:
                self.tm.send(task.id, "Carry on toward the goal.")
        elif action == "complete":
            if goal["native"] and goal["state"] == "active":
                self.tm.send(task.id, "/goal clear", plain=True)
            goal.update(state="met", note="You marked it done.")
        elif action == "clear":
            if goal["native"] and goal["state"] == "active":
                self.tm.send(task.id, "/goal clear", plain=True)
            meta["goal"] = None
        else:
            return
        self._touched(meta)
        self.emit_meta()

    async def _cmd_goal_new(self, msg: dict[str, Any]) -> None:
        """/goal with no session open: a new one in the project, working toward it."""
        text = str(msg.get("text") or "").strip()
        if not text:
            return
        known = set(self.tm.tasks)
        await self.hub._handle(
            {"type": "task_new", "directory": str(msg.get("directory") or ""), "prompt": ""}
        )
        fresh = [t for i, t in self.tm.tasks.items() if i not in known and t.kind == "code"]
        if not fresh:
            return  # (task_new said why)
        await self._cmd_goal({"id": fresh[0].id, "action": "set", "text": text})
        self.hub.emit("show_session", id=fresh[0].id)

    def _turn_ended(self, data: dict[str, Any]) -> None:
        """A session's turn is over: its goal is met, or goes on, or pauses."""
        task = self.tm.tasks.get(data.get("id"))
        goal = self._goal_of(data.get("id"))
        if task is None or goal is None or goal["state"] != "active":
            return
        status = data.get("status")
        meta = self._meta_of(task)
        if status in ("stopped", "failed"):
            goal.update(
                state="paused",
                note="Paused: you stopped it."
                if status == "stopped"
                else "Paused: it stopped with an error.",
            )
        elif status != "done":
            return
        elif goal["native"]:
            if str(data.get("result") or "").lstrip().startswith("/goal"):
                # Claude Code wouldn't keep it (a workspace it doesn't trust, hooks off): Jarvis does.
                goal.update(
                    native=False,
                    note="Jarvis Code couldn't keep this goal itself here, so JARVIS checks it.",
                )
                self.tm.send(task.id, goal["text"])
            else:  # its check let the turn end only once the goal held
                goal.update(state="met", note="Jarvis Code kept at it until it held.")
                self.tm._log(task, "system", "Goal met.")
        else:
            files = [str(f) for f in data.get("files") or []]
            self.hub._spawn(self._check_goal(task.id, goal, files))
            return
        self._touched(meta)
        self.emit_meta()

    async def _check_goal(self, task_id: int, goal: dict[str, Any], files: list[str]) -> None:
        task = self.tm.tasks.get(task_id)
        if task is None or task_id in self._checking:
            return
        self._checking.add(task_id)
        try:
            await self._checked(task, goal, files)
        finally:
            self._checking.discard(task_id)

    async def _checked(self, task: ClaudeTask, goal: dict[str, Any], files: list[str]) -> None:
        tm = self.tm
        meta = self._meta_of(task)
        if goal["checks"] >= code_asides.CHECKS_PER_GOAL or not self.checks_hour.allow():
            goal.update(
                state="paused", note="Paused: that's as many checks as a goal gets for now."
            )
            tm._log(
                task,
                "system",
                "Goal paused: that's as many checks as it gets for now. Resume it to go on.",
            )
            self._touched(meta)
            self.emit_meta()
            return
        goal["checks"] += 1
        try:
            answer = await code_asides.one_shot(
                tm.client_factory,
                code_asides.check_options(task.cwd),
                code_asides.check_prompt(goal["text"], task, files),
                code_asides.CHECK_SECONDS,
            )
        except Exception as exc:
            log.warning("Jarvis Code: a goal check failed (%s)", exc)
            answer = ""
        found = code_asides.verdict(answer)
        if meta.get("goal") is not goal or goal["state"] != "active":
            return  # changed or cleared meanwhile
        if found is None:
            goal["note"] = "Couldn't check the goal just now."
        elif found[0]:
            goal.update(state="met", note=found[1])
            tm._log(task, "system", f"Goal met: {found[1]}" if found[1] else "Goal met.")
        elif task.busy or not task.inbox.empty():
            goal["note"] = found[1]  # the user has already sent it on
        elif goal["nudges"] >= code_asides.NUDGES:
            goal.update(state="paused", note=found[1])
            tm._log(
                task,
                "system",
                f"Goal not met yet{': ' + found[1] if found[1] else ''}. Paused after "
                f"{code_asides.NUDGES} tries: say what to do next, or resume the goal.",
            )
        else:
            goal["nudges"] += 1
            goal["note"] = found[1]
            tm._log(
                task,
                "system",
                f"Goal not met yet{': ' + found[1] if found[1] else ''}. Carrying on "
                f"({goal['nudges']} of {code_asides.NUDGES}).",
            )
            nudge = f"Not there yet: {found[1].rstrip('.')}." if found[1] else "Not there yet."
            tm.send(task.id, f"{nudge} Keep working toward the goal: {goal['text']}", note=True)
        self._touched(meta)
        self.emit_meta()

    # ── projects ──

    async def _cmd_project_add(self, msg: dict[str, Any]) -> None:
        """Open folder…: a folder in the home folder as a project (or, root, a folder of
        projects). One that already is a project is just opened."""
        root = msg.get("root") is True
        path, why = code_projects.folder_problem(msg.get("path"))
        if path is None:
            self._note(why)
            return
        main = self.hub.settings.projects_dir.resolve()
        roots = [r.resolve() for r in self.projects.roots()]
        if root:
            if path == main or path in roots:
                self._note("That folder is already where projects are listed from.")
                return
            if len(roots) >= code_projects.ROOTS_MAX:
                self._note("That's as many folders of projects as Jarvis Code lists.")
                return
            self.hub.set_feature_prefs({"code_project_roots": [*map(str, roots), str(path)]})
            await self._projects_changed()
            return
        if path == main or path in roots:
            self._note("That folder holds your projects: open one of the folders in it.")
            return
        extra = self.tm._more_projects()[0]
        name = (
            path.name
            if path.parent == main
            else next((n for n, p in extra.items() if p == path), "")
        )
        if not name:
            if path.name in self.tm.projects():
                self._note(
                    f"There's already a project called “{path.name}”. Rename one of the "
                    "folders to have both."
                )
                return
            folders = [str(f) for f in self.projects.folders()]
            if len(folders) >= code_projects.FOLDERS_MAX:
                self._note("That's as many folders as Jarvis Code keeps: remove one in Settings.")
                return
            self.hub.set_feature_prefs({"code_project_folders": [*folders, str(path)]})
            name = path.name
            await self._projects_changed()
        self.hub.emit("code_project_added", name=name, path=str(path))

    async def _cmd_project_remove(self, msg: dict[str, Any]) -> None:
        key = "code_project_roots" if msg.get("root") is True else "code_project_folders"
        target = str(msg.get("path") or "")
        kept = [p for p in self.hub.prefs.feature(key) or [] if p != target]
        self.hub.set_feature_prefs({key: kept})
        await self._projects_changed()

    async def _projects_changed(self) -> None:
        self.projects.forget()
        self.hub.emit("claude_projects", items=await self.hub._projects_overview())
        self.hub.emit("code_projects", **self.projects_event())


def _line(record: dict[str, Any]) -> dict[str, Any]:
    """A kept session let go from the list, as much of it as the history shows and finds it
    again by: the whole of it stays on disk (SessionStore.read)."""
    return {k: record[k] for k in ("key", "session_id", "title", "prompt", "cwd", "updated")}


def _count_lines(paths: list[str]) -> int:
    """Lines in new files (the first 2 MB of each; a file that can't be read counts none)."""
    total = 0
    for path in paths:
        try:
            with open(path, "rb") as handle:
                data = handle.read(2_000_000)
        except OSError:
            continue
        if b"\x00" not in data[:8000]:  # text, not a picture
            total += data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)
    return total
