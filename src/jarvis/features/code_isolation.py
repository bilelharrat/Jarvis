"""Jarvis Code: sessions in isolated copies of their project (worktrees.py).

A session can run in its own git worktree of the project. The composer's "Isolated copy"
switch asks for one per session (its default is the Jarvis Code setting
code_isolate_default, off); a session started some other way (by voice) while another is
working in the same folder is offered one on a card. A session resumed later runs in its
copy again. Land merges a copy back and removes it; Discard keeps a recovery ref for 30
days; the sweeper (at startup and daily) removes only spent copies and lists the rest.

Window commands: code_copies {}, code_copy {slug, action: land|discard|restore|resume|
resolve}.
Events: code_copies.
Settings (prefs.features): code_isolate_default (bool), code_iso_env and code_iso_link
(project names whose .env files are copied, and whose node_modules/.venv are linked).
Loop: code_copies_sweeper.

No Claude calls here: none of this costs anything.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

from .. import code_changes, lang, prefs, secret_scan, worktrees
from ..proactive import Alert

log = logging.getLogger("jarvis")

PREF_DEFAULT = "code_isolate_default"
PREF_ENV = "code_iso_env"
PREF_LINK = "code_iso_link"
OFFER_SECONDS = 90  # a card offering a copy waits this long, then the session shares
SWEEP_EVERY = 24 * 3600
SWEEP_FIRST = 30  # after startup, once the app has settled


def _project_names(value: Any) -> list[str] | None:
    """A list of project folder names (a setting's value), or None for anything else."""
    if not isinstance(value, list):
        return None
    names = [v for v in value if isinstance(v, str) and 0 < len(v) <= 200 and "/" not in v]
    return list(dict.fromkeys(names))[:200]


# What this shows and says, in Chinese (lang.translate() and tr() know them from here on).
ZH = {
    "Another session is working in {project}. Give this one an isolated copy?": "另一个会话正在 {project} 里工作。要给这个会话一个独立副本吗？",
    "An isolated copy is the project on a branch of its own, so the two sessions never edit the same files. Land it when it's done to bring the work back.": "独立副本是项目在自己分支上的一份拷贝，这样两个会话就不会改同一批文件。完成后合并它，就能把工作带回来。",
    "Isolated copy": "独立副本",
    "Share the folder": "共用文件夹",
    "Land {branch} in {into}?": "要把 {branch} 合并进 {into} 吗？",
    "{n} file changed, +{added} −{removed}. This merges the copy into {into} in the main folder, then removes the copy and ends its sessions.": "改动了 {n} 个文件，+{added} −{removed}。这会把副本合并进主文件夹的 {into}，然后删除副本并结束它的会话。",
    "{n} files changed, +{added} −{removed}. This merges the copy into {into} in the main folder, then removes the copy and ends its sessions.": "改动了 {n} 个文件，+{added} −{removed}。这会把副本合并进主文件夹的 {into}，然后删除副本并结束它的会话。",
    "Possible secrets in the work it would commit:": "它要提交的内容里可能有密钥：",
    "• {kind} in {path} line {line} ({preview})": "• {path} 第 {line} 行：{kind}（{preview}）",
    "• {kind} in {path}": "• {path}：{kind}",
    "…and {n} more.": "……还有 {n} 处。",
    "Land": "合并",
    "Not now": "暂不",
    "Land anyway": "仍然合并",
    "Don't land": "不合并",
    "Discard the isolated copy {branch}?": "要丢弃独立副本 {branch} 吗？",
    "Its work, uncommitted changes included, is kept for 30 days as {ref}, and can be brought back from the Copies pane until then. Its sessions end.": "它的工作（包括未提交的改动）会以 {ref} 保留 30 天，在此之前可以从副本面板找回。它的会话会结束。",
    "Discard": "丢弃",
    "Keep it": "保留",
    "That isolated copy isn't there any more.": "那个独立副本已经不在了。",
    "It's still working. Stop it first, then land.": "它还在工作。先停下它，再合并。",
    "It's still working. Stop it first, then discard.": "它还在工作。先停下它，再丢弃。",
    "Not landed.": "没有合并。",
    "Kept.": "已保留。",
    "Landed {branch} in {into} (fast-forward).": "已把 {branch} 合并进 {into}（快进）。",
    "Landed {branch} in {into} (a merge commit).": "已把 {branch} 合并进 {into}（合并提交）。",
    "Everything in {branch} is already in {into}.": "{branch} 里的内容已经都在 {into} 里了。",
    "Landing {branch} in {into} hits conflicts in {files}.": "把 {branch} 合并进 {into} 时，这些文件有冲突：{files}。",
    "The main folder has uncommitted changes in {files} that landing would overwrite. Commit or stash them, then land again.": "主文件夹里 {files} 有未提交的改动，合并会覆盖它们。先提交或暂存，再合并一次。",
    "git doesn't know who's committing here: set user.name and user.email first.": "git 不知道是谁在提交：请先设置 user.name 和 user.email。",
    "The branch {branch} is gone, so there's nothing to land.": "分支 {branch} 已经不在了，没什么可合并的。",
    "The branch {into} it lands in is gone.": "要合并进去的分支 {into} 已经不在了。",
    "{into} moved while landing; land again.": "合并时 {into} 发生了变化，请再合并一次。",
    "Couldn't stage the copy's work: {error}": "没能暂存副本里的工作：{error}",
    "Couldn't commit the copy's work: {error}": "没能提交副本里的工作：{error}",
    "Couldn't merge: {error}": "没能合并：{error}",
    "Couldn't make the merge commit: {error}": "没能创建合并提交：{error}",
    "Couldn't update {into}: {error}": "没能更新 {into}：{error}",
    "Couldn't keep a recovery copy, so nothing was discarded: {error}": "没能保留恢复副本，所以什么都没丢弃：{error}",
    "Discarded {branch}; its work is kept for 30 days.": "已丢弃 {branch}；它的工作会保留 30 天。",
    "Brought it back as {branch}.": "已找回，分支为 {branch}。",
    "That discarded copy isn't there any more.": "那个丢弃的副本已经不在了。",
    "Couldn't bring it back: {error}": "没能找回：{error}",
    "Sent the conflicts to the session.": "已把冲突交给会话。",
    "Opened the session with the conflicts.": "已打开会话并交给它冲突。",
    "There are no conflicts to resolve there.": "那里没有需要解决的冲突。",
    "Isolated copies": "独立副本",
    "1 isolated copy has work that isn't landed. Land or discard it in Jarvis Code's Copies pane.": "有 1 个独立副本的工作还没合并。请在 Jarvis Code 的副本面板里合并或丢弃它。",
    "{n} isolated copies have work that isn't landed. Land or discard them in Jarvis Code's Copies pane.": "有 {n} 个独立副本的工作还没合并。请在 Jarvis Code 的副本面板里合并或丢弃它们。",
}
lang.add_texts(ZH)

prefs.register_feature_pref(PREF_DEFAULT, False)
prefs.register_feature_pref(PREF_ENV, [], _project_names)
prefs.register_feature_pref(PREF_LINK, [], _project_names)


class Desk:
    """One hub's isolated copies."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._store: worktrees.CopyStore | None = None
        self.prepared: set[int] = set()  # sessions whose copy has been sorted out
        self.bound: dict[int, str] = {}  # session id -> the slug of the copy it runs in
        self.conflicts: dict[str, list[str]] = {}  # slug -> files a landing conflicted on
        self.leftovers: list[str] = []
        self._locks: dict[str, asyncio.Lock] = {}
        self._told: set[str] = set()  # leftovers already mentioned in a heads-up

    # ── the list of copies ──

    @property
    def root(self) -> Path:
        return self.hub.feature_path("worktrees")

    def store(self) -> worktrees.CopyStore:
        if self._store is None:
            self._store = worktrees.CopyStore(self.hub.feature_path("code_copies.json"))
        return self._store

    def save(self) -> None:
        try:
            self.store().save()
        except OSError as exc:  # a full disk: the list is kept for this run
            log.warning("couldn't save the isolated copies (%s)", exc)

    def lock(self, key: str) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())

    def tasks_in(self, copy: worktrees.Copy) -> list[Any]:
        """The sessions running in a copy (any still listed)."""
        return [
            t
            for tid, slug in self.bound.items()
            if slug == copy.slug and (t := self.hub.tasks.tasks.get(tid)) is not None
        ]

    def live_slugs(self) -> set[str]:
        """Copies with a session that hasn't ended in them."""
        return {
            slug
            for tid, slug in self.bound.items()
            if (t := self.hub.tasks.tasks.get(tid)) is not None
            and t.handle is not None
            and not t.handle.done()
        }

    def note_sessions(self) -> None:
        """Remember which Claude Code sessions ran in which copy (a session's id is known
        once its first turn ends), so resuming one later finds its copy."""
        store, changed = self.store(), False
        for tid, slug in list(self.bound.items()):
            task = self.hub.tasks.tasks.get(tid)
            copy = store.find(slug)
            if task is None or copy is None or not task.session_id:
                continue
            if task.session_id not in copy.sessions:
                copy.sessions = [*copy.sessions, task.session_id][-20:]
                changed = True
        if changed:
            self.save()

    # ── hooks the session manager calls ──

    def isolated_dir(self, directory: str) -> Path | None:
        """A copy's folder, named by its path (a session in it resumed, /clear in it)."""
        raw = (directory or "").strip()
        if not raw.startswith(("/", "~")):
            return None
        copy = self.store().by_path(Path(raw).expanduser())
        if copy is None or not copy.cwd.is_dir():
            return None
        return copy.cwd.resolve()

    async def prepare(self, task: Any) -> None:
        """Before a session's first connection: into its copy if it has one (a resume, a
        fork, /clear there), a new copy if asked for, or offered one when another session
        is already working in the same folder. Never fails the session: a copy that can't
        be made leaves it in the folder, with a note saying why."""
        if task.kind != "code" or task.id in self.prepared:
            return
        self.prepared.add(task.id)
        try:
            await self._prepare(task)
        except Exception:
            log.exception("couldn't sort out an isolated copy for session %s", task.id)

    async def _prepare(self, task: Any) -> None:
        store = self.store()
        copy = store.by_path(task.cwd)
        if copy is None and task.session_id:
            found = store.by_session(task.session_id)
            copy = found if found is not None and found.cwd.is_dir() else None
        if copy is not None:
            self.bind(task, copy)
            return
        if task.session_id or task.fork:
            return  # resuming or forking a session of the shared folder: it stays there
        want = task.isolate
        if want is None:
            want = bool(self.hub.prefs.feature(PREF_DEFAULT))
            if not want and self.others_working(task):
                want = await self.offer(task)
        if want:
            await self.isolate(task)

    def others_working(self, task: Any) -> list[Any]:
        """Other sessions at work in the same folder right now (not in copies of their
        own). An idle one (the session /clear started afresh from) doesn't count."""
        return [
            t
            for t in self.hub.tasks.tasks.values()
            if t is not task
            and t.kind == "code"
            and t.cwd == task.cwd
            and not t.workspace
            and t.busy
        ]

    async def offer(self, task: Any) -> bool:
        project = task.cwd.name
        question = f"Another session is working in {project}. Give this one an isolated copy?"
        detail = (
            "An isolated copy is the project on a branch of its own, so the two sessions "
            "never edit the same files. Land it when it's done to bring the work back."
        )
        speak = self.hub.voicecode.focus == task.id
        try:
            choice = await asyncio.wait_for(
                self.ask(
                    question,
                    detail,
                    [("isolate", "Isolated copy"), ("share", "Share the folder")],
                    speak,
                ),
                OFFER_SECONDS,
            )
        except TimeoutError:
            return False
        return choice == "isolate"

    async def isolate(self, task: Any) -> None:
        """Make the session a copy of its own and move it in."""
        project_dir = task.cwd
        task.last_action = "Making an isolated copy…"
        self.hub.tasks._changed()
        names = set(self.hub.prefs.feature(PREF_ENV) or [])
        linked = set(self.hub.prefs.feature(PREF_LINK) or [])
        store = self.store()
        if len(store.copies) >= worktrees.MAX_COPIES:
            self.hub.tasks._log(
                task,
                "system",
                f"There are already {len(store.copies)} isolated copies; land or discard some. "
                "This session works in the project folder itself.",
            )
            return
        async with self.lock(str(project_dir)):
            try:
                copy, notes = await asyncio.to_thread(
                    worktrees.create,
                    project_dir,
                    self.root,
                    task.title or task.prompt or "session",
                    taken=store.slugs(),
                    copy_env=project_dir.name in names,
                    link_deps=project_dir.name in linked,
                )
            except worktrees.CopyError as exc:
                self.hub.tasks._log(
                    task, "system", f"{exc} This session works in the project folder itself."
                )
                task.last_action = "Starting"
                return
        store.copies.append(copy)
        self.save()
        self.bind(task, copy)
        self.hub.tasks._log(
            task,
            "system",
            f"Working in an isolated copy on {copy.branch}, from {copy.into} at {copy.base[:7]}. "
            "Land it to bring the work back.",
        )
        for note in notes:
            self.hub.tasks._log(task, "system", note)
        task.last_action = "Starting"
        self.hub.tasks._changed()
        self.publish_soon()

    def bind(self, task: Any, copy: worktrees.Copy) -> None:
        task.cwd = copy.cwd
        task.workspace = {
            "slug": copy.slug,
            "branch": copy.branch,
            "base": copy.base,
            "into": copy.into,
        }
        self.bound[task.id] = copy.slug
        if task.session_id and task.session_id not in copy.sessions:
            copy.sessions = [*copy.sessions, task.session_id][-20:]
            self.save()
        self.hub.tasks._changed()

    # ── asking ──

    def tr(self, text: str) -> str:
        """A sentence of this feature's in the owner's language."""
        return lang.translate(text, self.hub.language)

    async def ask(
        self, question: str, detail: str, choices: list[tuple[str, str]], speak: bool = False
    ) -> str:
        """A card (and, when asked by voice, the question out loud first: an answer in the
        next minute counts). Always the last choice when nobody answers."""
        question, detail = self.tr(question), self.tr(detail)
        choices = [(choice, self.tr(label)) for choice, label in choices]
        if speak:
            self.hub._say(question)
        return await self.hub.request_approval(question, detail, choices)

    def caption(self, text: str) -> None:
        self.hub.emit("caption", text=self.tr(text))

    # ── copies: the list, landing, discarding ──

    def cmd_copies(self, _msg: dict[str, Any]) -> None:
        self.hub._spawn(self.publish())

    def publish_soon(self) -> None:
        self.hub._spawn(self.publish())

    async def publish(self) -> None:
        self.note_sessions()
        store = self.store()
        copies = list(store.copies)
        sessions = {c.slug: [t.id for t in self.tasks_in(c)] for c in copies}
        busy = {c.slug: any(t.busy for t in self.tasks_in(c)) for c in copies}
        states = await asyncio.to_thread(lambda: {c.slug: worktrees.state(c) for c in copies})
        live = self.live_slugs()
        items = []
        for copy in sorted(copies, key=lambda c: -c.created):
            found = states.get(copy.slug)
            items.append(
                copy.public()
                | {
                    "state": found.public() if found else {},
                    "sessions": sessions.get(copy.slug, []),
                    "resumable": bool(copy.sessions),
                    "live": copy.slug in live,
                    "busy": busy.get(copy.slug, False),
                    "leftover": copy.slug in self.leftovers and copy.slug not in live,
                    "conflicts": self.conflicts.get(copy.slug, []),
                }
            )
        trash = [
            {k: t.get(k) for k in ("slug", "project", "title", "at", "into")}
            | {"restorable": bool(t.get("ref"))}
            for t in sorted(store.trash, key=lambda t: -float(t.get("at") or 0))[:30]
        ]
        self.hub.emit("code_copies", copies=items, trash=trash, root=str(self.root))

    def cmd_copy(self, msg: dict[str, Any]) -> None:
        action = str(msg.get("action") or "")
        slug = str(msg.get("slug") or "")[:80]
        runs = {
            "land": self.land,
            "discard": self.discard,
            "restore": self.restore,
            "resume": self.resume,
            "resolve": self.resolve,
        }
        if action in runs:
            self.hub._spawn(self._reply(runs[action](slug)))

    async def _reply(self, coro: Any) -> None:
        said = await coro
        if said:
            self.caption(said)
        await self.publish()

    def _scan_copy(self, copy: worktrees.Copy) -> list[secret_scan.Finding]:
        """What landing would commit (the copy's uncommitted work), checked for secrets."""
        repo = code_changes.repo_of(Path(copy.checkout))
        if repo is None:
            return []
        head = code_changes.head_commit(repo.top) or code_changes.EMPTY_TREE
        return secret_scan.scan(code_changes.diff_files(repo, head), repo.shown)

    async def land(self, slug: str, by_voice: bool = False) -> str:
        """Land a copy: a card first (with any secrets its uncommitted work holds), then
        its work committed and merged into the branch it came from, its sessions ended and
        the copy removed. A conflict changes nothing: the files are listed, for the
        session to resolve."""
        copy = self.store().find(slug)
        if copy is None:
            return "That isolated copy isn't there any more."
        inside = self.tasks_in(copy)
        if any(t.busy for t in inside):
            return "It's still working. Stop it first, then land."
        found = await asyncio.to_thread(worktrees.state, copy)
        findings = await asyncio.to_thread(self._scan_copy, copy)
        question = f"Land {copy.branch} in {copy.into}?"
        detail = (
            f"{found.files} file{'s' if found.files != 1 else ''} changed, +{found.added} "
            f"−{found.removed}. This merges the copy into {copy.into} in the main folder, "
            "then removes the copy and ends its sessions."
        )
        choices = [("land", "Land"), ("deny", "Not now")]
        if findings:
            detail += "\n\nPossible secrets in the work it would commit:\n" + secret_scan.summary(
                findings
            )
            choices = [("land", "Land anyway"), ("deny", "Don't land")]
        if await self.ask(question, detail, choices, speak=by_voice) != "land":
            return "Not landed."
        message = f"Jarvis Code: {copy.title or copy.slug}"
        async with self.lock(copy.repo):
            landed = await asyncio.to_thread(worktrees.land, copy, message)
            if not landed.ok:
                if landed.conflicts:
                    self.conflicts[copy.slug] = landed.conflicts
                return landed.message
            self.conflicts.pop(copy.slug, None)
            for task in inside:
                self.hub.tasks.cancel(task.id)
            await self._ended(inside)
            problem = await asyncio.to_thread(worktrees.remove, copy, self.root)
        if copy in self.store().copies:
            self.store().copies.remove(copy)
        self.save()
        for task in inside:
            self.bound.pop(task.id, None)
        if problem:
            log.warning("a landed copy left something behind: %s", problem)
        return landed.message

    async def _ended(self, tasks: list[Any]) -> None:
        handles = [t.handle for t in tasks if t.handle is not None and not t.handle.done()]
        if handles:
            await asyncio.wait(handles, timeout=12)

    async def discard(self, slug: str, by_voice: bool = False) -> str:
        copy = self.store().find(slug)
        if copy is None:
            return "That isolated copy isn't there any more."
        inside = self.tasks_in(copy)
        if any(t.busy for t in inside):
            return "It's still working. Stop it first, then discard."
        question = f"Discard the isolated copy {copy.branch}?"
        detail = (
            f"Its work, uncommitted changes included, is kept for {worktrees.TRASH_DAYS} days "
            f"as refs/jarvis/trash/{copy.slug}, and can be brought back from the Copies pane "
            "until then. Its sessions end."
        )
        choices = [("discard", "Discard"), ("deny", "Keep it")]
        if await self.ask(question, detail, choices, speak=by_voice) != "discard":
            return "Kept."
        async with self.lock(copy.repo):
            for task in inside:
                self.hub.tasks.cancel(task.id)
            await self._ended(inside)
            try:
                item = await asyncio.to_thread(worktrees.discard, copy, self.root)
            except worktrees.CopyError as exc:
                return str(exc)
        store = self.store()
        if copy in store.copies:
            store.copies.remove(copy)
        store.trash.append(item)
        self.save()
        self.conflicts.pop(copy.slug, None)
        for task in inside:
            self.bound.pop(task.id, None)
        return f"Discarded {copy.branch}; its work is kept for {worktrees.TRASH_DAYS} days."

    async def restore(self, slug: str) -> str:
        store = self.store()
        item = next((t for t in store.trash if t.get("slug") == slug), None)
        if item is None:
            return "That discarded copy isn't there any more."
        async with self.lock(str(item.get("repo"))):
            try:
                copy = await asyncio.to_thread(worktrees.restore, item, self.root, store.slugs())
            except worktrees.CopyError as exc:
                return str(exc)
        store.trash.remove(item)
        store.copies.append(copy)
        self.save()
        return f"Brought it back as {copy.branch}."

    async def resume(self, slug: str) -> str:
        """Open a session in a copy: its latest one again when there is one."""
        copy = self.store().find(slug)
        if copy is None or not copy.cwd.is_dir():
            return "That isolated copy isn't there any more."
        open_here = [t for t in self.tasks_in(copy) if t.handle is not None and not t.handle.done()]
        if open_here:
            self.hub.emit("show_session", id=open_here[-1].id)
            return ""
        session = copy.sessions[-1] if copy.sessions else ""
        try:
            task = self.hub.tasks.start(
                "", str(copy.cwd), resume=session, title=copy.title if session else ""
            )
        except ValueError as exc:
            return str(exc)
        self.hub.emit("show_session", id=task.id)
        return ""

    async def resolve(self, slug: str) -> str:
        """Hand a landing's conflicts back to the session: merge the branch it lands in
        into the copy's, fix the conflicts, commit. (Then land again.)"""
        copy = self.store().find(slug)
        files = self.conflicts.get(slug, [])
        if copy is None or not files:
            return "There are no conflicts to resolve there."
        text = (
            f"Landing this branch ({copy.branch}) in {copy.into} hits conflicts in "
            f"{', '.join(files[:20])}. Merge {copy.into} into this branch (git merge "
            f"{copy.into}), resolve the conflicts keeping both sides' intent, make sure it "
            "still builds and its tests pass, and commit the merge. Then tell me it's ready "
            "to land."
        )
        open_here = [t for t in self.tasks_in(copy) if t.handle is not None and not t.handle.done()]
        if open_here:
            self.hub.tasks.send(open_here[-1].id, text)
            self.hub.emit("show_session", id=open_here[-1].id)
            return "Sent the conflicts to the session."
        session = copy.sessions[-1] if copy.sessions else ""
        try:
            task = self.hub.tasks.start(text, str(copy.cwd), resume=session)
        except ValueError as exc:
            return str(exc)
        self.hub.emit("show_session", id=task.id)
        return "Opened the session with the conflicts."

    # ── the sweeper ──

    async def sweeper(self) -> None:
        await asyncio.sleep(SWEEP_FIRST)
        while True:
            await self.sweep()
            await asyncio.sleep(SWEEP_EVERY)

    async def sweep(self, now: float | None = None) -> worktrees.Swept:
        store = self.store()
        live = self.live_slugs()
        async with self.lock("sweep"):
            report = await asyncio.to_thread(worktrees.sweep, store, self.root, live, now)
        self.save()
        self.leftovers = report.leftovers
        fresh = [s for s in report.leftovers if s not in self._told]
        if fresh:
            self._told.update(fresh)
            n = len(report.leftovers)
            text = (
                f"{n} isolated copies have work that isn't landed. Land or discard them in "
                "Jarvis Code's Copies pane."
                if n != 1
                else "1 isolated copy has work that isn't landed. Land or discard it in Jarvis "
                "Code's Copies pane."
            )
            self.hub.notify(
                Alert(
                    f"code-copies:{time.monotonic():.0f}",
                    "task",
                    self.tr("Isolated copies"),
                    self.tr(text),
                ),
                speak=False,
            )
        await self.publish()
        return report

    # ── helpers ──

    def _task(self, msg: dict[str, Any]) -> Any:
        try:
            task = self.hub.tasks.tasks.get(int(msg.get("id") or 0))
        except (TypeError, ValueError):
            return None
        return task if task is not None and task.kind == "code" else None


def install(hub: Any) -> None:
    desk = Desk(hub)
    hub.code_desk = desk  # (for the other Jarvis Code features and the tests)
    hub.tasks.prepare = desk.prepare
    hub.tasks.isolated_dir = desk.isolated_dir
    hub.register_command("code_copies", desk.cmd_copies)
    hub.register_command("code_copy", desk.cmd_copy)
    hub.register_loop("code_copies_sweeper", desk.sweeper)
