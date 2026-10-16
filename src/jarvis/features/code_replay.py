"""Eden Code's step-by-step replay (code_replay), in the Replay pane (web/features/code-replay.js).

A past session played back one step at a time, with a scrubber: each message, the thinking,
each step with its input and output, each edit's diff, and the files as they were at each
of the owner's messages (Claude Code's own checkpoints), each turn's change to a file shown
as a diff from one checkpoint to the next.

- cw_replay {id, ref}: the session read whole from its record (as the full export reads it)
  -> cw_replay {ref, id, title, steps (each step's heading: n, kind, title, turn, tool, path,
  error), checkpoints [{uuid, n, files, changed}], copy (whether "with the files" can be
  offered: a git project)} or {ref, error}.
- cw_replay_step {id, n, ref}: one step whole (its text, input, output, diff) -> the same.
- cw_replay_file {id, uuid, path, ref}: a file at a checkpoint, and after its turn (at the
  next checkpoint, or as it is now after the last) -> {before, after, diff, ...}. Only a
  file a checkpoint names is read, and a copy only from the session's own folder.
- cw_replay_fork {id, n, files}: carry on from the end of step n's turn.
  Without files: a fork of the conversation (TaskManager.fork, as the transcript's Fork
  does), from just before the owner's next message, in the same folder.
  With files: a new session in an isolated copy of the project (worktrees: never the
  folder the original works in) with every file the session had changed put back as it was
  at that point, and a summary of the conversation so far as its first message's draft
  (the owner reads it, adds to it and sends it: nothing is sent for them). Claude Code's
  checkpoints hold only the files it changed: everything else is as the project's last
  commit, and the new session's note says so.

Cost policy (Claude): nothing here calls a model. A fork or a new session costs nothing
until the owner sends it a message.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from pathlib import Path
from typing import Any

from .. import code_records, code_replay, lang, worktrees
from ..hub import _msg_int
from .code_export import _entries
from .code_workspace import session_of

log = logging.getLogger("jarvis")

CACHE_KEEP = 4  # sessions whose replay is kept read (the panes open lately)
PENDING_KEEP = 20  # new sessions waiting for their copy, to have their files put back

ZH = {
    "Open a session to replay it.": "打开一个会话才能回放它。",
    "Couldn't read this session's record: {error}": "没能读取这个会话的记录：{error}",
    "That step isn't there any more: replay the session again.": "那一步已经不在了：请重新回放这个会话。",
    "That file isn't one this session changed.": "这个文件不是这个会话改过的。",
    "It's still working. Stop it first, then fork it.": "它还在工作。先停下它，再分叉。",
    "Putting the files back needs a git project, for an isolated copy to put them in.": "要把文件放回去，项目需要是 git 项目，才能放进一个独立副本里。",
    "There are already too many isolated copies: land or discard some first.": "独立副本已经太多了：先合并或丢弃一些。",
    "Couldn't fork from that step.": "没能从那一步分叉。",
}
lang.add_texts(ZH)


def _git_project(folder: Path) -> bool:
    return any((p / ".git").exists() for p in (folder, *folder.parents))


def _relative(path: str, roots: list[Path]) -> str:
    for root in roots:
        with contextlib.suppress(ValueError):
            return str(Path(path).relative_to(root))
    return path


class Replay:
    """One session's replay as read: its steps, checkpoints and record's session ids."""

    def __init__(self, task: Any) -> None:
        self.cwd = Path(task.cwd)
        self.roots = [self.cwd]
        with contextlib.suppress(OSError):
            if (resolved := self.cwd.resolve()) != self.cwd:
                self.roots.append(resolved)
        entries = _entries(task)
        self.steps = code_replay.steps_from(entries)
        record = code_records.record_path(task.session_id, task.cwd) if task.session_id else None
        self.snaps, sessions = code_replay.snapshots(record)
        if task.session_id and task.session_id not in sessions:
            sessions.insert(0, task.session_id)
        self.dirs = code_replay.history_dirs(sessions)

    def heads(self) -> list[dict[str, Any]]:
        keep = (
            "n",
            "kind",
            "title",
            "turn",
            "at",
            "uuid",
            "tool",
            "path",
            "error",
            "agent",
            "hidden",
        )
        out = []
        for s in self.steps:
            head = {k: s[k] for k in keep if k in s}
            if "path" in head:
                head["path"] = _relative(head["path"], self.roots)
            out.append(head)
        return out

    def checkpoints(self) -> list[dict[str, Any]]:
        out = []
        by_uuid = {s["uuid"]: s["n"] for s in self.steps if s["kind"] == "user" and s["uuid"]}
        for uid in self.snaps:
            if uid not in by_uuid:
                continue
            changed = sorted({s["path"] for s in self.steps if s["turn"] == uid and s.get("path")})
            out.append(
                {
                    "uuid": uid,
                    "n": by_uuid[uid],
                    "files": [
                        {"path": p, "name": _relative(p, self.roots)}
                        for p in sorted(code_replay.state_at(self.snaps, uid))[:500]
                    ],
                    "changed": [_relative(p, self.roots) for p in changed][:200],
                }
            )
        return out

    def next_message(self, n: int) -> dict[str, Any] | None:
        """The owner's first message after step n: the end of step n's turn."""
        return next((s for s in self.steps[n + 1 :] if s["kind"] == "user" and s["uuid"]), None)

    def file_at(self, uid: str, path: str) -> dict[str, Any]:
        """A file at checkpoint uid and after its turn (the next checkpoint, or now)."""
        state = code_replay.state_at(self.snaps, uid)
        if path not in state:
            raise ValueError("That file isn't one this session changed.")
        before, binary = code_replay.as_text(code_replay.read_copy(self.dirs, state[path]))
        order = list(self.snaps)
        later = next((u for u in order[order.index(uid) + 1 :] if path in self.snaps[u]), None)
        if later is not None:
            after_bytes = code_replay.read_copy(self.dirs, self.snaps[later][path])
        else:
            after_bytes = _read_now(Path(path))
        after, binary_after = code_replay.as_text(after_bytes)
        return {
            "path": path,
            "name": _relative(path, self.roots),
            "before": before,
            "after": after,
            "missing_before": state[path] is None,
            "missing_after": after_bytes is None,
            "binary": binary or binary_after,
            "after_is_now": later is None,
            "diff": ""
            if (binary or binary_after)
            else code_replay.file_change(before, after, _relative(path, self.roots)),
        }

    def files_for_fork(self, uid: str) -> list[tuple[str, bytes | None]]:
        """Every file the session had changed, as it was at uid (None: it wasn't there):
        what a new session from that point gets put back. Copies that are gone are left
        out (the file stays as the project's last commit has it)."""
        out: list[tuple[str, bytes | None]] = []
        for path, name in code_replay.state_at(self.snaps, uid).items():
            if name is None:
                out.append((path, None))
            elif (data := code_replay.read_copy(self.dirs, name)) is not None:
                out.append((path, data))
        return out


def _read_now(path: Path) -> bytes | None:
    try:
        if path.is_file():
            with path.open("rb") as f:
                return f.read(code_replay.FILE_BYTES + 1)
    except OSError:
        return None
    return None


def put_back(
    files: list[tuple[str, bytes | None]], roots: list[Path], into: Path
) -> tuple[int, int]:
    """The files written into a new copy (into), each at its place relative to the project
    (roots); one that wasn't there then is removed. Never outside the copy, never through a
    link. -> (put back, left as they are)."""
    done = skipped = 0
    base = into.resolve()
    for path, data in files:
        rel = _relative(path, roots)
        if rel == path or rel.startswith("..") or Path(rel).is_absolute():
            skipped += 1
            continue
        target = base / rel
        try:
            if target.is_symlink() or base not in target.resolve().parents:
                skipped += 1
                continue
            if data is None:
                if target.is_file():
                    target.unlink()
                done += 1
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if len(data) > code_replay.FILE_BYTES:
                skipped += 1  # (a copy read back cut short is never written as the file)
                continue
            target.write_bytes(data)
            done += 1
        except OSError:
            skipped += 1
    return done, skipped


class Replays:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.cache: dict[int, Replay] = {}
        # New sessions waiting for their isolated copy: id -> (files, the project's roots,
        # the point they start from, in words).
        self.pending: dict[int, tuple[list[tuple[str, bytes | None]], list[Path], str]] = {}

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    def _reply(self, kind: str, ref: str, **data: Any) -> None:
        self.hub.emit(kind, ref=ref, **data)

    async def _replay_of(self, task: Any, fresh: bool = False) -> Replay:
        if fresh or task.id not in self.cache:
            self.cache[task.id] = await asyncio.to_thread(Replay, task)
            for old in list(self.cache)[:-CACHE_KEEP]:
                del self.cache[old]
        return self.cache[task.id]

    async def cmd_replay(self, msg: dict[str, Any]) -> None:
        ref = str(msg.get("ref") or "")[:40]
        task = session_of(self.hub, msg)
        if task is None:
            self._reply("cw_replay", ref, error=self.tr("Open a session to replay it."))
            return
        try:
            replay = await self._replay_of(task, fresh=True)
        except OSError as exc:
            self._reply(
                "cw_replay",
                ref,
                error=self.tr(f"Couldn't read this session's record: {exc.strerror or exc}"),
            )
            return
        self._reply(
            "cw_replay",
            ref,
            id=task.id,
            title=task.title or task.prompt or "Eden Code session",
            steps=replay.heads(),
            checkpoints=replay.checkpoints(),
            copy=_git_project(Path(task.cwd)),
        )

    async def cmd_step(self, msg: dict[str, Any]) -> None:
        ref = str(msg.get("ref") or "")[:40]
        task = session_of(self.hub, msg)
        n = _msg_int(msg, "n")
        replay = self.cache.get(task.id) if task is not None else None
        if replay is None or n is None or not 0 <= n < len(replay.steps):
            self._reply(
                "cw_replay_step",
                ref,
                error=self.tr("That step isn't there any more: replay the session again."),
            )
            return
        step = dict(replay.steps[n])
        if step.get("path"):
            step["path"] = _relative(step["path"], replay.roots)
        self._reply("cw_replay_step", ref, id=task.id, step=step)

    async def cmd_file(self, msg: dict[str, Any]) -> None:
        ref = str(msg.get("ref") or "")[:40]
        task = session_of(self.hub, msg)
        replay = self.cache.get(task.id) if task is not None else None
        uid, path = str(msg.get("uuid") or ""), str(msg.get("path") or "")
        if replay is None or uid not in replay.snaps:
            self._reply(
                "cw_replay_file",
                ref,
                error=self.tr("That step isn't there any more: replay the session again."),
            )
            return
        try:
            found = await asyncio.to_thread(replay.file_at, uid, path)
        except ValueError as exc:
            self._reply("cw_replay_file", ref, error=self.tr(str(exc)))
            return
        self._reply("cw_replay_file", ref, id=task.id, uuid=uid, **found)

    async def cmd_fork(self, msg: dict[str, Any]) -> None:
        ref = str(msg.get("ref") or "")[:40]
        task = session_of(self.hub, msg)
        n = _msg_int(msg, "n")
        replay = self.cache.get(task.id) if task is not None else None
        if replay is None or n is None or not 0 <= n < len(replay.steps):
            self._reply(
                "cw_replay_fork",
                ref,
                error=self.tr("That step isn't there any more: replay the session again."),
            )
            return
        tm = self.hub.tasks
        later = replay.next_message(n)
        if msg.get("files") is not True:
            if task.busy:
                self._reply(
                    "cw_replay_fork",
                    ref,
                    error=self.tr("It's still working. Stop it first, then fork it."),
                )
                return
            if (
                later is not None
                and not task.history_read
                and (task.handle is None or task.handle.done())
            ):
                await tm._read_history(task)  # a resting session: its points to fork from
            fork = tm.fork(task.id, later["uuid"] if later is not None else "")
            if fork is None:  # (fork says why, in the session)
                self._reply("cw_replay_fork", ref, error=self.tr("Couldn't fork from that step."))
                return
            self._reply("cw_replay_fork", ref, ok=True, session=fork.id)
            self.hub.emit("show_session", id=fork.id)
            return
        await self._new_from(task, replay, n, later, ref)

    async def _new_from(
        self, task: Any, replay: Replay, n: int, later: dict[str, Any] | None, ref: str
    ) -> None:
        """A new session in an isolated copy, its files as they were at the end of step n's
        turn, its draft the conversation's summary up to there."""
        if not _git_project(Path(task.cwd)):
            self._reply(
                "cw_replay_fork",
                ref,
                error=self.tr(
                    "Putting the files back needs a git project, for an isolated copy to put them in."
                ),
            )
            return
        desk = getattr(self.hub, "code_desk", None)
        if desk is None or len(desk.store().copies) + desk.making >= worktrees.MAX_COPIES:
            self._reply(
                "cw_replay_fork",
                ref,
                error=self.tr(
                    "There are already too many isolated copies: land or discard some first."
                ),
            )
            return
        if later is not None:
            files = await asyncio.to_thread(replay.files_for_fork, later["uuid"])
        else:  # after the last turn: the files as they are now
            last = list(replay.snaps)[-1] if replay.snaps else ""
            paths = list(code_replay.state_at(replay.snaps, last)) if last else []
            files = [(p, await asyncio.to_thread(_read_now, Path(p))) for p in paths]
        changed = sorted(
            {_relative(s["path"], replay.roots) for s in replay.steps[: n + 1] if s.get("path")}
        )
        title = task.title or task.prompt or "Eden Code session"
        draft = code_replay.summary(title, replay.steps, n, changed)
        tm = self.hub.tasks
        fresh = tm.start_like(task.id)
        if fresh is None:
            self._reply("cw_replay_fork", ref, error=self.tr("Couldn't fork from that step."))
            return
        # (set before anything awaits: the new session's first connection makes its copy)
        fresh.isolate = True
        fresh.title = f"{title[:70]} (from step {n + 1})"
        self.pending[fresh.id] = (files, list(replay.roots), f"step {n + 1} of “{title[:80]}”")
        for old in list(self.pending)[:-PENDING_KEEP]:
            del self.pending[old]
        sessions = getattr(self.hub, "code_sessions", None)
        if sessions is not None:
            try:
                meta = sessions._meta_of(fresh)
                meta["draft"] = draft
                sessions._touched(meta)
                sessions.emit_meta(full=True)
            except Exception:  # (the draft is a help: the session starts without it)
                log.exception("couldn't give a replayed session its draft")
        self._reply("cw_replay_fork", ref, ok=True, session=fresh.id, files=len(files))
        self.hub.emit("show_session", id=fresh.id)

    async def on_new_copy(self, task: Any, copy: Any) -> None:
        """A new session's isolated copy is made, before it connects: the files it was
        started with go in."""
        waiting = self.pending.pop(task.id, None)
        if waiting is None:
            return
        files, roots, point = waiting
        done, skipped = await asyncio.to_thread(put_back, files, roots, Path(copy.cwd))
        left = f", {skipped} left as they are" if skipped else ""
        self.hub.tasks._log(
            task,
            "system",
            f"Started from {point}, in an isolated copy. The files that session changed are "
            f"as they were then ({done} put back{left}); everything else is as the project's "
            "last commit. Your draft sums up the conversation so far.",
        )


def install(hub: Any) -> None:
    replays = Replays(hub)
    hub.code_replay = replays
    desk = getattr(hub, "code_desk", None)
    if desk is not None:
        desk.on_new_copy.append(replays.on_new_copy)
    for kind, handler in (
        ("cw_replay", replays.cmd_replay),
        ("cw_replay_step", replays.cmd_step),
        ("cw_replay_file", replays.cmd_file),
        ("cw_replay_fork", replays.cmd_fork),
    ):
        hub.register_command(kind, lambda msg, h=handler: hub._spawn(h(msg)))
