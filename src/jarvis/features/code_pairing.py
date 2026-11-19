"""Eden Code: pairing mode. A session's isolated copy mirrored, live and both ways, into a
folder the owner opens in their own editor (pairsync.py is the sync).

On: from the Pairing pane (or code_pair {id, on: true, folder?}) for a session in an
isolated copy. The folder is the owner's pick, or ~/Eden Pairing/<project>-<copy>; it must
be empty (or a pairing folder of this same copy, which picks up where it left off), inside
the home folder, and none of the folders Eden Code never works in. The copy's files are
mirrored there at once; from then on, about every second:
- the session's changes go to the folder, and the owner's edits there come into the copy
  (the session's transcript lists the files that came in, so it knows);
- when both changed the same file between two syncs, neither is overwritten: the file is
  a conflict, listed in the pane with Keep mine and Keep Eden's, and left out of the sync
  until one is kept (or both sides are made the same);
- the session's changes to files that run by themselves (git hooks, .jarvis/, an editor's
  .vscode/ and the like) are held and listed until the owner brings them over: the folder
  is opened in the owner's editor, where those run.
Off: the sync stops; the folder stays as it is, and on again picks up where it left off.
Landing or discarding the copy ends the pairing too (the folder stays, the owner's). Before
the copy's files go, the desk waits for a sync in flight and no new one starts
(Desk.before_copy_gone, Desk.removing): a sync while git takes the copy away would see the
session's files vanish and delete them from the owner's folder. For the same reason the
sweeper never takes a paired copy (a holder), and pairsync itself refuses a copy whose git
can't list it, and holds more than DELETES_MAX deletions at once for the owner.

Window commands: code_pair {id, on, folder?}, code_pair_state {id}, code_pair_keep {id,
path, side: "mine" | "eden"}, code_pair_release {id}, code_pair_open {id, editor}.
Events: code_pair {id, slug, on, folder, conflicts, held, last, error}.
Loop: code_pairing (picks up the pairings that were on when the app quit).

Cost policy: nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from pathlib import Path
from typing import Any

from .. import code_editor, jsonstore, lang, mac_tools, osplat, pairsync, private_folders
from ..code_projects import in_app_data
from ..codeplatform import code_task
from ..computer import is_sensitive
from ..pairsync import CopyUnreadable, Pair, Syncer
from .code_workspace import unopenable

log = logging.getLogger("jarvis")

TICK = 1.0  # seconds between syncs
SAID_MAX = 12  # files named in a transcript note, at most

ZH = {
    "Pairing is for a session in an isolated copy: start one with Isolated copy on.": "结对模式只用于在独立副本里的会话：请打开“独立副本”再开始一个会话。",
    "That isolated copy is being taken away just now, so it can't be paired.": "那个独立副本正在被移除，所以不能结对。",
    "Pick a folder inside your home folder.": "请选择你的个人文件夹里的一个文件夹。",
    "That folder can't be a pairing folder: pick an empty folder of your own.": "那个文件夹不能用作结对文件夹：请选一个你自己的空文件夹。",
    "That folder isn't empty: pick an empty folder (or a new one) for pairing.": "那个文件夹不是空的：请为结对选一个空文件夹（或新文件夹）。",
    "Couldn't make the pairing folder: {error}": "没能创建结对文件夹：{error}",
    "Pairing on: {folder} mirrors this copy, both ways.": "结对已开启：{folder} 与这个副本双向同步。",
    "Pairing off. {folder} stays as it is.": "结对已关闭。{folder} 保持原样。",
    "Pairing stopped: the copy was landed or discarded. {folder} stays as it is.": "结对已停止：副本已合并或丢弃。{folder} 保持原样。",
    "Your edits came in from the pairing folder: {files}.": "你在结对文件夹里的修改已同步进来：{files}。",
    "{n} file changed on both sides; pick which to keep in the Pairing pane.": "有 {n} 个文件两边都改了；请在结对面板里选择保留哪一边。",
    "{n} files changed on both sides; pick which to keep in the Pairing pane.": "有 {n} 个文件两边都改了；请在结对面板里选择保留哪一边。",
    "Kept it.": "已保留。",
    "Couldn't keep it: it changed again just now. Try again.": "没能保留：它刚刚又变了。请再试一次。",
    "Brought {n} held files over.": "已把 {n} 个暂留的文件同步过去。",
    "Eden's session deleted {n} files at once; they're held in the Pairing pane, not deleted from your folder.": "Eden 的会话一次删除了 {n} 个文件；它们暂留在结对面板里，没有从你的文件夹删除。",
    "That editor isn't on this Mac.": "这台 Mac 上没有那个编辑器。",
    "Couldn't open it: {error}": "没能打开：{error}",
}
lang.add_texts(ZH)


class Pairing:
    """One hub's pairings."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._pairs: dict[str, Pair] | None = None
        self.syncers: dict[str, Syncer] = {}
        self.loops: dict[str, asyncio.Task] = {}
        self.last: dict[str, float] = {}
        self.errors: dict[str, str] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self.unreadable = False  # the saved pairings couldn't be read: never saved over

    # ── plumbing ──

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    def caption(self, text: str) -> None:
        if text:
            self.hub.emit("caption", text=self.tr(text))

    def _path(self) -> Path:
        return self.hub.feature_path("code_pairs.json")

    def pairs(self) -> dict[str, Pair]:
        if self._pairs is None:
            try:
                data = jsonstore.load_json(self._path(), dict) or {}
            except jsonstore.Unreadable:  # (never saved over: C9; this run's pairs are kept)
                log.warning("code_pairs.json can't be read; pairings aren't saved this run")
                self.unreadable = True
                data = {}
            self._pairs = {
                p.slug: p for raw in data.values() if (p := Pair.from_json(raw)) is not None
            }
        return self._pairs

    def save(self) -> None:
        if self.unreadable:
            return
        with contextlib.suppress(OSError):  # a full disk: kept for this run
            jsonstore.save_json(self._path(), {s: p.to_json() for s, p in self.pairs().items()})

    def lock(self, slug: str) -> asyncio.Lock:
        return self.locks.setdefault(slug, asyncio.Lock())

    def desk(self) -> Any:
        return getattr(self.hub, "code_desk", None)

    def copy_of(self, task: Any) -> Any:
        desk = self.desk()
        if desk is None or not task.workspace:
            return None
        return desk.store().find(task.workspace.get("slug", ""))

    def syncer(self, pair: Pair) -> Syncer:
        found = self.syncers.get(pair.slug)
        if found is None or found.pair is not pair:
            found = self.syncers[pair.slug] = Syncer(pair)
        return found

    # ── the folder ──

    def folder_problem(self, folder: Path, copy: Any) -> str:
        """Why a folder can't be this copy's pairing folder ("" when it can)."""
        home = Path.home().resolve()
        if unopenable(str(folder)):  # (a NUL, a name too long: pathlib raises on those)
            return "Pick a folder inside your home folder."
        try:
            path = folder.expanduser().resolve()
        except (OSError, RuntimeError, ValueError):
            return "Pick a folder inside your home folder."
        if home not in path.parents:
            return "Pick a folder inside your home folder."
        repo = Path(copy.repo).resolve()
        checkout = Path(copy.checkout).resolve()
        projects = self.hub.settings.projects_dir.resolve()
        near = (repo, checkout, self.desk().root.resolve(), projects)
        if (
            path in near
            or any(p in path.parents or path in p.parents for p in (repo, checkout))
            or (home / "Library") in path.parents
            or in_app_data(home, path)
            or is_sensitive(path)
            or private_folders.is_private(path)
        ):
            return "That folder can't be a pairing folder: pick an empty folder of your own."
        try:
            if path.exists():
                if not path.is_dir():
                    return (
                        "That folder can't be a pairing folder: pick an empty folder of your own."
                    )
                marker = path / pairsync.MARKER
                mine = False
                with contextlib.suppress(OSError, ValueError, AttributeError):
                    mine = json.loads(marker.read_text()).get("slug") == copy.slug
                if not mine and any(p.name != ".DS_Store" for p in path.iterdir()):
                    return (
                        "That folder isn't empty: pick an empty folder (or a new one) for pairing."
                    )
        except (OSError, ValueError):  # (unreadable, or a name the disk won't take)
            return "That folder can't be a pairing folder: pick an empty folder of your own."
        return ""

    def default_folder(self, copy: Any) -> Path:
        return Path.home() / "Eden Pairing" / f"{copy.project}-{copy.slug}"

    # ── on and off ──

    def going(self, slug: str) -> bool:
        """Whether the desk is taking a copy away just now: the sweeper removing it (going),
        or a land or discard (removing). A sync then would mirror its vanishing files into
        the owner's pairing folder as deletions (REL-20a)."""
        desk = self.desk()
        return desk is not None and (
            slug in getattr(desk, "going", ()) or slug in getattr(desk, "removing", ())
        )

    async def turn_on(self, task: Any, folder: str = "") -> str:
        copy = self.copy_of(task)
        if copy is None or not copy.cwd.is_dir():
            return "Pairing is for a session in an isolated copy: start one with Isolated copy on."
        if self.going(copy.slug):
            return "That isolated copy is being taken away just now, so it can't be paired."
        kept = self.pairs().get(copy.slug)
        wanted = Path(folder).expanduser() if folder.strip() else None
        if wanted is not None and not wanted.is_absolute():
            return "Pick a folder inside your home folder."
        where = wanted or (Path(kept.folder) if kept else self.default_folder(copy))
        problem = await asyncio.to_thread(self.folder_problem, where, copy)
        if problem:
            return problem
        where = where.expanduser().resolve()
        try:
            where.mkdir(parents=True, exist_ok=True)
            (where / pairsync.MARKER).write_text(
                json.dumps({"slug": copy.slug, "copy": str(copy.cwd), "by": "Eden Code"})
            )
        except OSError as exc:
            return f"Couldn't make the pairing folder: {exc.strerror or exc}"
        async with self.lock(copy.slug):
            if self.going(copy.slug):  # (it began while the folder was being looked at)
                return "That isolated copy is being taken away just now, so it can't be paired."
            if kept is None or Path(kept.folder) != where or kept.copy != str(copy.cwd):
                kept = Pair(copy.slug, str(copy.cwd), str(where))  # (a new folder: from scratch)
                self.pairs()[copy.slug] = kept
            kept.on = True
            self.save()
        self.start_loop(kept)
        await self.tick(kept)
        return f"Pairing on: {where} mirrors this copy, both ways."

    async def turn_off(self, task: Any) -> str:
        copy = self.copy_of(task)
        pair = self.pairs().get(copy.slug) if copy is not None else None
        if pair is None or not pair.on:
            return ""
        pair.on = False
        self.save()
        self.stop_loop(pair.slug)
        return f"Pairing off. {pair.folder} stays as it is."

    def start_loop(self, pair: Pair) -> None:
        running = self.loops.get(pair.slug)
        if running is None or running.done():
            self.loops[pair.slug] = asyncio.create_task(self.run(pair))

    def stop_loop(self, slug: str) -> None:
        running = self.loops.pop(slug, None)
        if running is not None and running is not asyncio.current_task():
            running.cancel()

    async def run(self, pair: Pair) -> None:
        while pair.on:
            await asyncio.sleep(TICK)
            if pair.on:
                await self.tick(pair)

    async def resume(self) -> None:
        """At startup: the pairings that were on, on again (their copies still there)."""
        await asyncio.sleep(5)
        for pair in list(self.pairs().values()):
            if pair.on:
                self.start_loop(pair)

    # ── a sync ──

    async def tick(self, pair: Pair) -> None:
        desk = self.desk()
        copy = desk.store().find(pair.slug) if desk is not None else None
        if copy is None or not copy.cwd.is_dir() or not Path(pair.folder).is_dir():
            await self.ended(pair)
            return
        async with self.lock(pair.slug):
            if not pair.on or self.going(pair.slug):
                return  # (its copy is being taken away: see before_gone, and the sweeper's)
            try:
                done = await asyncio.to_thread(self.syncer(pair).sync)
            except CopyUnreadable as exc:  # (the copy going, its .git gone: no sync at all)
                self.errors[pair.slug] = str(exc)[:200]
                self.publish(pair)
                return
            except Exception as exc:  # a folder gone mid-sync, a full disk: said, then again
                log.warning("pairing %s: the sync failed", pair.slug, exc_info=True)
                self.errors[pair.slug] = str(exc)[:200]
                self.publish(pair)
                return
            self.errors.pop(pair.slug, None)
            self.last[pair.slug] = time.time()
            if done.changed:
                self.save()
        if done.to_copy:
            names = ", ".join(done.to_copy[:SAID_MAX]) + (
                f" and {len(done.to_copy) - SAID_MAX} more" if len(done.to_copy) > SAID_MAX else ""
            )
            for task in self.tasks_in(copy):
                self.hub.tasks._log(
                    task, "system", self.tr(f"Your edits came in from the pairing folder: {names}.")
                )
        if done.mass_held:
            self.caption(
                f"Eden's session deleted {done.mass_held} files at once; they're held in the "
                "Pairing pane, not deleted from your folder."
            )
        if done.conflicts:
            n = len(pair.conflicts)
            self.caption(
                f"{n} file{'s' if n != 1 else ''} changed on both sides; pick which to keep in "
                "the Pairing pane."
            )
        if done.anything:
            self.publish(pair)

    def tasks_in(self, copy: Any) -> list[Any]:
        desk = self.desk()
        return desk.tasks_in(copy) if desk is not None else []

    async def ended(self, pair: Pair) -> None:
        """Its copy (or its folder) is gone: the pairing ends, the folder stays."""
        if pair.on:
            pair.on = False
            self.caption(
                f"Pairing stopped: the copy was landed or discarded. {pair.folder} stays as it is."
            )
        self.pairs().pop(pair.slug, None)
        self.syncers.pop(pair.slug, None)
        self.save()
        self.stop_loop(pair.slug)
        self.publish(pair)

    async def before_gone(self, slug: str) -> None:
        """The desk is about to take a copy's files away (Desk.removing has it now): a
        sync in flight is waited for, and none starts until it's done."""
        if slug in self.pairs():
            async with self.lock(slug):
                pass

    def held_copies(self) -> list[str]:
        """The copies the sweeper must leave: the ones paired just now."""
        return [slug for slug, pair in self.pairs().items() if pair.on]

    def on_copy_gone(self, slug: str) -> None:
        pair = self.pairs().get(slug)
        if pair is not None:
            self.hub._spawn(self.ended(pair))

    # ── the window ──

    def publish(self, pair: Pair | None, task: Any = None) -> None:
        tasks = [task] if task is not None else []
        if pair is not None and not tasks:
            desk = self.desk()
            copy = desk.store().find(pair.slug) if desk is not None else None
            tasks = self.tasks_in(copy) if copy is not None else []
        for each in tasks:
            self.hub.emit(
                "code_pair",
                id=each.id,
                **(pair.public() if pair else {"slug": "", "on": False, "folder": ""}),
                last=self.last.get(pair.slug, 0) if pair else 0,
                error=self.errors.get(pair.slug, "") if pair else "",
                copy=bool(each.workspace),
                suggested=str(self.default_folder(c))
                if (c := self.copy_of(each)) is not None
                else "",
            )

    def state(self, task: Any) -> None:
        copy = self.copy_of(task)
        self.publish(self.pairs().get(copy.slug) if copy is not None else None, task)

    async def keep(self, task: Any, rel: str, side: str) -> str:
        copy = self.copy_of(task)
        pair = self.pairs().get(copy.slug) if copy is not None else None
        if pair is None or rel not in pair.conflicts:
            return ""
        side = {"mine": "folder", "eden": "copy"}.get(side, "")
        async with self.lock(pair.slug):
            ok = await asyncio.to_thread(self.syncer(pair).keep, rel, side)
            self.save()
        self.publish(pair, task)
        return "Kept it." if ok else "Couldn't keep it: it changed again just now. Try again."

    async def release(self, task: Any) -> str:
        copy = self.copy_of(task)
        pair = self.pairs().get(copy.slug) if copy is not None else None
        if pair is None or not pair.held:
            return ""
        async with self.lock(pair.slug):
            done = await asyncio.to_thread(self.syncer(pair).release)
            self.save()
        self.publish(pair, task)
        return f"Brought {len(done)} held files over."

    async def open_in(self, task: Any, editor_id: str) -> str:
        copy = self.copy_of(task)
        pair = self.pairs().get(copy.slug) if copy is not None else None
        if pair is None:
            return ""
        folder = Path(pair.folder)
        if editor_id == "finder":
            command = ["open", str(folder)]
        else:
            workspace = getattr(self.hub, "code_workspace", None)
            editor = (
                await asyncio.to_thread(workspace.editors.get, editor_id) if workspace else None
            )
            if editor is None:
                return "That editor isn't on this Mac."
            command = code_editor.open_command(editor, folder)
        try:
            if osplat.IS_WIN:  # (started and left running: code_editor.launch)
                await asyncio.to_thread(code_editor.launch, command)
            else:
                await mac_tools.run_command(*command, timeout=20)
        except (mac_tools.ToolFailure, OSError, ValueError) as exc:
            return f"Couldn't open it: {exc}"
        return ""

    def _run(self, coro: Any, task: Any) -> None:
        async def reply() -> None:
            self.caption(await coro)
            self.state(task)

        self.hub._spawn(reply())

    def cmd_pair(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is None:
            return
        if msg.get("on") is True:
            self._run(self.turn_on(task, str(msg.get("folder") or "")[:1000]), task)
        elif msg.get("on") is False:
            self._run(self.turn_off(task), task)

    def cmd_state(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is not None:
            self.state(task)

    def cmd_keep(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is not None:
            path, side = str(msg.get("path") or "")[:1000], str(msg.get("side") or "")
            self._run(self.keep(task, path, side), task)

    def cmd_release(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is not None:
            self._run(self.release(task), task)

    def cmd_open(self, msg: dict[str, Any]) -> None:
        task = code_task(self.hub, msg)
        if task is not None:
            self._run(self.open_in(task, str(msg.get("editor") or "")[:80]), task)


def install(hub: Any) -> None:
    pairing = Pairing(hub)
    hub.code_pairing = pairing  # (for the tests)
    desk = getattr(hub, "code_desk", None)
    if desk is not None:
        desk.on_copy_gone.append(pairing.on_copy_gone)
        desk.holders.append(pairing.held_copies)
        if hasattr(desk, "before_copy_gone"):
            desk.before_copy_gone.append(pairing.before_gone)
    hub.register_command("code_pair", pairing.cmd_pair)
    hub.register_command("code_pair_state", pairing.cmd_state)
    hub.register_command("code_pair_keep", pairing.cmd_keep)
    hub.register_command("code_pair_release", pairing.cmd_release)
    hub.register_command("code_pair_open", pairing.cmd_open)
    hub.register_loop("code_pairing", pairing.resume)
