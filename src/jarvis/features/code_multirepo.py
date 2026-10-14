"""Eden Code: one task across several repositories (a change to an API and the app that
calls it, say), with linked pull requests and landing all or nothing.

Starting (code_multi_start {projects: [2 to MAX_REPOS names], prompt, title?, mode?,
model?, effort?}): each project gets an isolated copy (features/code_isolation.py's, on a
jarvis/ branch of its own), all made in one task folder, <code_groups>/<task>/<project>/,
and one session works in that folder: every repository is a subfolder, its own git
repository on its own branch. Its first message says so. Each copy's setup runs before
the session starts (features/code_setup.py; containers are per copy, so a multi-repo
session runs its commands on the Mac). The copies show in the Copies pane too, named
after the task; the sweeper never takes them while the task is there.

Landing (code_multi_land {group}): all or nothing. One card lists every repository (its
branch, what changed, any secrets in what it would commit). Before anything moves, each
copy's work is committed on its branch and checked: it merges without conflicts, and the
main folder has no uncommitted changes in the files it would overwrite. If any can't land,
none does, and the card's answer says why for each (conflicts go back to the session, as
a single copy's do). Then each lands in turn; only something that changes in the second
between the check and the landing (another app committing in a main folder) can stop one
midway, and then what landed and what didn't is said.

Pull requests (code_multi_prs {group, title, body, draft?}): one per repository, opened
together through features/code_pr.py (each push behind the Git panel's card, with its
secret scan), then each description rewritten to link all of them ("merge them
together"). One that can't be opened stops the rest; the ones already open are kept and
listed. Each is watched as any pull request is (failing checks and review comments go to
the task's session).
Merging (code_multi_merge {group}): every pull request must be open, not a draft,
mergeable and green on its latest commit before any is merged, then one card for all of
them, then each merged at that commit. GitHub can't merge across repositories at once:
one that fails midway (pushed to meanwhile) is said, with the ones that merged.
Discarding (code_multi_discard {group}): every copy discarded (kept 30 days as a recovery
ref, as a single copy is), the session ended, the task folder removed when it's empty.

Window commands: code_multis {}, code_multi_start, code_multi_land {group},
code_multi_prs, code_multi_merge {group}, code_multi_discard {group}, code_multi_open
{group} (the task's session, resumed when it has ended).
Events: code_multis {groups: [...]}.

Cost policy: nothing here calls a model. The session is the owner's, on the model they
pick (counted and capped as every session is); titles and descriptions are the owner's.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import shutil
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .. import github, jsonstore, lang, secret_scan, worktrees
from ..code_changes import git
from ..worktrees import _holder, _is_ancestor, _rev, status_entries
from .code_pr import FolderView

log = logging.getLogger("jarvis")

MAX_REPOS = 8
GROUP_PREFIX = "multi:"
GREEN = {"success", "neutral", "skipped"}
LINKS = "\n\n---\n"  # where a description's links to the other pull requests begin

ZH = {
    "Pick at least two projects for a multi-repo task.": "多仓库任务至少要选两个项目。",
    "A multi-repo task can span at most {n} repositories.": "一个多仓库任务最多涉及 {n} 个仓库。",
    "{project} is in the task twice.": "{project} 在任务里出现了两次。",
    "Give the task something to do first.": "先告诉任务要做什么。",
    "Couldn't make the task's copies: {error}": "没能为任务创建副本：{error}",
    "That multi-repo task isn't there any more.": "那个多仓库任务已经不在了。",
    "It's still working. Stop it first, then land.": "它还在工作。先停下它，再合并。",
    "It's still working. Stop it first, then discard.": "它还在工作。先停下它，再丢弃。",
    "Land {title} in all {n} repositories?": "要把 {title} 合并进全部 {n} 个仓库吗？",
    "Land all": "全部合并",
    "Land all anyway": "仍然全部合并",
    "Not now": "暂不",
    "Don't land": "不合并",
    "Not landed.": "没有合并。",
    "Nothing landed: {why}": "什么都没合并：{why}",
    "Landed {title} in all {n} repositories.": "已把 {title} 合并进全部 {n} 个仓库。",
    "Discard {title} in all {n} repositories?": "要丢弃 {title} 在全部 {n} 个仓库里的副本吗？",
    "Discard all": "全部丢弃",
    "Keep them": "保留",
    "Kept.": "已保留。",
    "Discarded {title}; each copy's work is kept for 30 days.": "已丢弃 {title}；每个副本的工作都会保留 30 天。",
    "Give the pull requests a title first.": "先给拉取请求起个标题。",
    "Open the task's session first (Open in the Multi-repo pane).": "请先打开任务的会话（在多仓库面板里点“打开”）。",
    "Opened {n} linked pull requests.": "已打开 {n} 个相互关联的拉取请求。",
    "Merge all {n} pull requests?": "要合并全部 {n} 个拉取请求吗？",
    "Merge all": "全部合并",
    "Nothing merged: {why}": "什么都没合并：{why}",
    "Merged all {n} pull requests.": "已合并全部 {n} 个拉取请求。",
    "There are no pull requests for this task yet.": "这个任务还没有拉取请求。",
    "Multi-repo task": "多仓库任务",
}
lang.add_texts(ZH)


@dataclass
class Group:
    slug: str
    title: str
    folder: str  # the task's folder, holding a copy of each repository
    copies: list[str]  # the copies' slugs, in the order the owner named the projects
    created: float = 0.0
    session_id: str = ""  # the task's Claude Code session, once it's known
    task_id: int = 0  # its session in this run of the app
    prs: list[dict[str, Any]] = field(default_factory=list)  # {project, repo, number, url}

    @classmethod
    def from_json(cls, raw: Any) -> Group | None:
        if not isinstance(raw, dict):
            return None
        try:
            group = cls(**{k: raw[k] for k in raw if k in cls.__dataclass_fields__})
        except TypeError:
            return None
        if not all(isinstance(v, str) and v for v in (group.slug, group.folder)):
            return None
        if not isinstance(group.copies, list) or not all(isinstance(s, str) for s in group.copies):
            return None
        group.prs = (
            [p for p in group.prs if isinstance(p, dict)] if isinstance(group.prs, list) else []
        )
        group.task_id = 0  # (a new run of the app numbers its sessions anew)
        return group


@dataclass
class Check:
    """What landing one copy would do, looked at before anything moves."""

    copy: Any
    problem: str = ""
    conflicts: list[str] = field(default_factory=list)


def landing_check(copy: worktrees.Copy) -> Check:
    """Whether a copy's branch (its work committed) would land: no conflicts with the
    branch it lands in, and nothing uncommitted in the main folder that it would overwrite
    (blocking: git)."""
    head = _rev(copy.repo, f"refs/heads/{copy.branch}")
    tip = _rev(copy.repo, f"refs/heads/{copy.into}")
    if not head:
        return Check(copy, f"the branch {copy.branch} is gone")
    if not tip:
        return Check(copy, f"the branch {copy.into} it lands in is gone")
    if head == tip or _is_ancestor(copy.repo, head, tip):
        return Check(copy)  # (already in: nothing to land)
    tree = head
    if not _is_ancestor(copy.repo, tip, head):
        merged = git(
            copy.repo, "merge-tree", "--write-tree", "--name-only", "--no-messages", tip, head,
            timeout=120,
        )  # fmt: skip
        if merged.code == 1:
            files = sorted({line for line in merged.out.splitlines()[1:] if line})
            return Check(copy, f"conflicts in {', '.join(files[:5])}", files)
        if not merged.ok:
            return Check(copy, f"git couldn't merge it: {merged.err.strip()[:200]}")
        tree = merged.out.splitlines()[0].strip()
    holder = _holder(copy.repo, copy.into)
    if holder:
        touched = set(git(copy.repo, "diff", "--name-only", tip, tree).out.split("\n")) - {""}
        status = git(holder, "status", "--porcelain", "-z", "--untracked-files=all")
        dirty = {path for _code, path in status_entries(status.out)}
        both = sorted(touched & dirty)
        if both:
            return Check(
                copy,
                f"the main folder has uncommitted changes in {', '.join(both[:5])} that "
                "landing would overwrite",
            )
    return Check(copy)


def links_body(body: str, prs: list[dict[str, Any]], mine: dict[str, Any]) -> str:
    """A pull request's description with the task's links at its end (any earlier ones
    replaced)."""
    own = body.split(LINKS, 1)[0].rstrip()
    lines = [
        f"Part of one change across {len(prs)} repositories (an Eden Code multi-repo task). "
        "Merge them together:"
    ]
    for pr in prs:
        here = (
            " (this one)" if pr["repo"] == mine["repo"] and pr["number"] == mine["number"] else ""
        )
        lines.append(f"- {pr['repo']}#{pr['number']}{here}")
    return (own + LINKS if own else "---\n") + "\n".join(lines)


class MultiDesk:
    """One hub's multi-repo tasks."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._groups: dict[str, Group] | None = None
        self.fresh: dict[int, list[str]] = {}  # session id -> copies whose setup is to run
        self.locks: dict[str, asyncio.Lock] = {}

    # ── plumbing ──

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    def caption(self, text: str) -> None:
        if text:
            self.hub.emit("caption", text=self.tr(text))

    async def ask(self, question: str, detail: str, choices: list[tuple[str, str]]) -> str:
        return await self.hub.request_approval(
            self.tr(question), self.tr(detail), [(c, self.tr(label)) for c, label in choices]
        )

    @property
    def desk(self) -> Any:
        return self.hub.code_desk

    def root(self) -> Path:
        return worktrees.root_for(self.hub.feature_path("code_groups"))

    def groups(self) -> dict[str, Group]:
        if self._groups is None:
            try:
                data = jsonstore.load_json(self.hub.feature_path("code_groups.json"), dict) or {}
            except jsonstore.Unreadable:
                data = {}
            self._groups = {
                g.slug: g for raw in data.values() if (g := Group.from_json(raw)) is not None
            }
        return self._groups

    def save(self) -> None:
        with contextlib.suppress(OSError):
            jsonstore.save_json(
                self.hub.feature_path("code_groups.json"),
                {s: asdict(g) for s, g in self.groups().items()},
            )

    def lock(self, key: str) -> asyncio.Lock:
        return self.locks.setdefault(key, asyncio.Lock())

    def copies(self, group: Group) -> list[worktrees.Copy]:
        store = self.desk.store()
        return [c for s in group.copies if (c := store.find(s)) is not None]

    def task_of(self, group: Group) -> Any:
        """The task's session in this run of the app, if it's listed."""
        task = self.hub.tasks.tasks.get(group.task_id) if group.task_id else None
        if task is None and group.session_id:
            task = self.hub.tasks._by_session(group.session_id)
        if task is not None and not group.session_id and task.session_id:
            group.session_id = task.session_id
            self.save()
        return task

    def held(self) -> set[str]:
        """Desk.holders: every task's copies stay while the task is there."""
        return {s for g in self.groups().values() for s in g.copies}

    def group_at(self, path: Path) -> Group | None:
        with contextlib.suppress(OSError):
            wanted = path.resolve()
            for group in self.groups().values():
                if Path(group.folder).resolve() == wanted:
                    return group
        return None

    # ── hooks the session manager calls ──

    def wrap_isolated_dir(self, original: Any) -> Any:
        def isolated_dir(directory: str) -> Path | None:
            found = original(directory) if original is not None else None
            raw = (directory or "").strip()
            if found is not None or not raw.startswith(("/", "~")):
                return found
            group = self.group_at(Path(raw).expanduser())
            if group is None or not Path(group.folder).is_dir():
                return None
            return Path(group.folder).resolve()  # a multi-repo task's own folder

        return isolated_dir

    def wrap_prepare(self, original: Any) -> Any:
        async def prepare(task: Any) -> None:
            if original is not None:
                await original(task)
            slugs = self.fresh.pop(task.id, None)
            if not slugs:
                return
            store = self.desk.store()
            for slug in slugs:
                copy = store.find(slug)
                for hook in list(self.desk.on_new_copy) if copy is not None else []:
                    try:
                        await hook(task, copy)
                    except Exception:
                        log.exception("a multi-repo copy's hook failed")
            task.last_action = "Starting"
            self.hub.tasks._changed()

        return prepare

    # ── starting ──

    async def start(self, msg: dict[str, Any]) -> str:
        names = msg.get("projects")
        names = [str(n)[:200] for n in names] if isinstance(names, list) else []
        prompt = str(msg.get("prompt") or "").strip()
        if len(names) < 2:
            return "Pick at least two projects for a multi-repo task."
        if len(names) > MAX_REPOS:
            return f"A multi-repo task can span at most {MAX_REPOS} repositories."
        if not prompt:
            return "Give the task something to do first."
        folders: list[Path] = []
        for name in names:
            try:
                path = self.hub.tasks.resolve_dir(name)
            except ValueError as exc:
                return str(exc)
            if path in folders or path.name in {f.name for f in folders}:
                return f"{path.name} is in the task twice."
            folders.append(path)
        title = " ".join(str(msg.get("title") or prompt).split())[:200]
        desk, store = self.desk, self.desk.store()
        if len(store.copies) + desk.making + len(folders) > worktrees.MAX_COPIES:
            return f"There are already {len(store.copies)} isolated copies; land or discard some."
        slug = worktrees.slug_for(title, set(self.groups()))
        folder = self.root() / slug
        made: list[worktrees.Copy] = []
        notes: list[str] = []
        env_names = set(self.hub.prefs.feature("code_iso_env") or [])
        linked = set(self.hub.prefs.feature("code_iso_link") or [])
        desk.making += len(folders)
        try:
            for path in folders:
                async with desk.lock(str(path)):
                    try:
                        copy, said = await asyncio.to_thread(
                            worktrees.create, path, desk.root, title,
                            taken=store.slugs() | {c.slug for c in made},
                            copy_env=path.name in env_names, link_deps=path.name in linked,
                            making=store.making, checkout_at=folder / path.name,
                        )  # fmt: skip
                    except worktrees.CopyError as exc:
                        for copy in made:
                            await asyncio.to_thread(worktrees.remove, copy, desk.root)
                            store.making.pop(copy.slug, None)
                        shutil.rmtree(folder, ignore_errors=True)
                        return f"Couldn't make the task's copies: {exc}"
                copy.group, copy.label = GROUP_PREFIX + slug, path.name
                made.append(copy)
                notes += [f"{path.name}: {n}" for n in said]
            for copy in made:
                store.copies.append(copy)
                store.making.pop(copy.slug, None)
        finally:
            desk.making -= len(folders)
        desk.save()
        group = Group(slug, title, str(folder), [c.slug for c in made], time.time())
        self.groups()[slug] = group
        self.save()
        where = "\n".join(
            f"- {c.label}/ : {c.project}, on its own branch {c.branch} (from {c.into} at "
            f"{c.base[:7]})"
            for c in made
        )
        first = (
            f"This task spans {len(made)} repositories. This folder holds an isolated copy of "
            f"each, its own git repository on its own branch:\n{where}\n"
            "Make the change across them, so they work together. Eden lands them all at "
            "once (or opens linked pull requests) when you're done.\n\n" + prompt
        )
        ref = str(msg.get("model") or self.hub.prefs.code_model or "")
        cfg = self.hub._model_config(ref)
        try:
            task = self.hub.tasks.start(
                "",  # (the first message goes in once the setup hooks know the session)
                str(folder),
                mode=str(msg.get("mode") or self.hub.prefs.code_mode or "ask"),
                title=title,
                model=cfg["model"] or "",
                model_label=cfg["label"] if cfg["model"] else "",
                model_ref=cfg["ref"],
                effort=str(msg.get("effort") or self.hub.prefs.code_effort or ""),
                env=cfg["env"],
                provider_settings=cfg.get("settings") or "",
                isolate=False,
            )
        except ValueError as exc:
            return str(exc)
        self.fresh[task.id] = list(group.copies)
        task.inbox.put(first, [])
        group.task_id = task.id
        for note in notes:
            self.hub.tasks._log(task, "system", note)
        self.hub.emit("show_session", id=task.id)
        self.desk.publish_soon()
        await self.publish()
        return ""

    # ── landing ──

    async def land(self, slug: str) -> str:
        group = self.groups().get(slug)
        copies = self.copies(group) if group is not None else []
        if group is None or not copies:
            return "That multi-repo task isn't there any more."
        task = self.task_of(group)
        if task is not None and task.busy:
            return "It's still working. Stop it first, then land."
        lines, findings_all = [], []
        for copy in copies:
            found = await asyncio.to_thread(worktrees.state, copy)
            findings = await asyncio.to_thread(self.desk._scan_copy, copy)
            lines.append(
                f"• {copy.label}: {copy.branch} → {copy.into}, {found.files} file"
                f"{'s' if found.files != 1 else ''} +{found.added} −{found.removed}"
            )
            if findings:
                findings_all.append(f"{copy.label}:\n{secret_scan.summary(findings)}")
        detail = (
            "\n".join(lines) + "\n\nAll of them land, or none does: each is checked first. "
            "Then the copies are removed and the task's session ends."
        )
        choices = [("land", "Land all"), ("deny", "Not now")]
        if findings_all:
            detail += "\n\nPossible secrets in the work it would commit:\n" + "\n".join(
                findings_all
            )
            choices = [("land", "Land all anyway"), ("deny", "Don't land")]
        question = f"Land {group.title} in all {len(copies)} repositories?"
        if await self.ask(question, detail, choices) != "land":
            return "Not landed."
        return await self.land_now(group, copies)

    async def land_now(self, group: Group, copies: list[worktrees.Copy]) -> str:
        repos = sorted({c.repo for c in copies})
        async with contextlib.AsyncExitStack() as stack:
            for repo in repos:  # (in one order always: two landings never wait on each other)
                await stack.enter_async_context(self.desk.lock(repo))
            message = f"Eden Code: {group.title or group.slug}"
            for copy in copies:
                problem = await asyncio.to_thread(worktrees.commit_all, copy, message)
                if problem:
                    return f"Nothing landed: {copy.label}: {problem}"
            checks = [await asyncio.to_thread(landing_check, c) for c in copies]
            bad = [c for c in checks if c.problem]
            if bad:
                for check in bad:
                    if check.conflicts:
                        self.desk.conflicts[check.copy.slug] = check.conflicts
                why = "; ".join(f"{c.copy.label}: {c.problem}" for c in bad)
                return f"Nothing landed: {why}."
            landed: list[worktrees.Copy] = []
            for copy in copies:
                done = await asyncio.to_thread(worktrees.land, copy, message)
                if not done.ok:
                    names = ", ".join(c.label for c in landed) or "none"
                    left = ", ".join(c.label for c in copies if c not in landed)
                    self.notify(group, f"{group.title}: {copy.label} couldn't land after all.")
                    return (
                        f"Landed {names}; {copy.label} couldn't land after all ({done.message}). "
                        f"Not landed: {left}. Land the rest from the Copies pane once that's fixed."
                    )
                landed.append(copy)
                self.desk.conflicts.pop(copy.slug, None)
            await self._end(group)
            for copy in copies:
                await self.desk.taking_away(copy.slug)
                try:
                    await asyncio.to_thread(worktrees.remove, copy, self.desk.root)
                finally:
                    self.desk.removing.discard(copy.slug)
        await self._forget(group, copies)
        return f"Landed {group.title} in all {len(copies)} repositories."

    def notify(self, group: Group, text: str) -> None:
        from ..proactive import Alert

        self.hub.notify(
            Alert(
                f"code-multi:{group.slug}:{time.time():.0f}",
                "task",
                self.tr("Multi-repo task"),
                self.tr(text),
            ),
            speak=False,
        )

    async def _end(self, group: Group) -> None:
        task = self.task_of(group)
        if task is not None:
            self.hub.tasks.cancel(task.id)
            if task.handle is not None and not task.handle.done():
                await asyncio.wait([task.handle], timeout=12)

    async def _forget(self, group: Group, copies: list[worktrees.Copy]) -> None:
        store = self.desk.store()
        for copy in copies:
            if copy in store.copies:
                store.copies.remove(copy)
            self.desk.gone(copy.slug)
        self.desk.save()
        self.groups().pop(group.slug, None)
        self.save()
        with contextlib.suppress(OSError):
            (Path(group.folder) / ".DS_Store").unlink(missing_ok=True)
            Path(group.folder).rmdir()  # (only when the session left nothing else there)
        self.desk.publish_soon()
        await self.publish()

    async def discard(self, slug: str) -> str:
        group = self.groups().get(slug)
        if group is None:
            return "That multi-repo task isn't there any more."
        copies = self.copies(group)
        task = self.task_of(group)
        if task is not None and task.busy:
            return "It's still working. Stop it first, then discard."
        question = f"Discard {group.title} in all {len(copies)} repositories?"
        detail = (
            "Each copy's work, uncommitted changes included, is kept for "
            f"{worktrees.TRASH_DAYS} days and can be brought back from the Copies pane. The "
            "task's session ends."
        )
        if (
            await self.ask(question, detail, [("discard", "Discard all"), ("deny", "Keep them")])
            != "discard"
        ):
            return "Kept."
        await self._end(group)
        for copy in copies:
            said = await self.desk.discard_now(copy)
            if not said.startswith("Discarded"):
                await self.publish()
                return said
        await self._forget(group, [])
        return f"Discarded {group.title}; each copy's work is kept for {worktrees.TRASH_DAYS} days."

    # ── pull requests ──

    async def open_prs(self, slug: str, msg: dict[str, Any]) -> str:
        group = self.groups().get(slug)
        copies = self.copies(group) if group is not None else []
        if group is None or not copies:
            return "That multi-repo task isn't there any more."
        title = " ".join(str(msg.get("title") or "").split())[:256]
        if not title:
            return "Give the pull requests a title first."
        task = self.task_of(group)
        if task is None:
            return "Open the task's session first (Open in the Multi-repo pane)."
        bodies = msg.get("bodies") if isinstance(msg.get("bodies"), dict) else {}
        body = str(msg.get("body") or "")[:50_000]
        prs = self.hub.code_pr
        opened: list[tuple[worktrees.Copy, Any, str]] = []
        for copy in copies:
            view = FolderView(
                task,
                copy.cwd,
                {"slug": copy.slug, "branch": copy.branch, "base": copy.base, "into": copy.into},
            )
            own = str(bodies.get(copy.label) or body)[:50_000]
            said = await prs.open(
                view, {"title": title, "body": own, "base": "", "draft": bool(msg.get("draft"))}
            )
            rec = next(
                (r for r in prs.store().items if r.folder == str(copy.cwd) and r.state == "open"),
                None,
            )
            if rec is None or not said.startswith(("Opened", "Linked")):
                got = ", ".join(f"{r.repo}#{r.number}" for _c, r, _b in opened) or "none"
                await self._remember_prs(group, opened)
                return (
                    f"Opened {got}; {copy.label}: {said or 'not opened'}. The rest weren't opened."
                )
            opened.append((copy, rec, own))
        await self._remember_prs(group, opened)
        listed = [{"repo": r.repo, "number": r.number} for _c, r, _b in opened]
        for _copy, rec, own in opened:
            text = links_body(own, listed, {"repo": rec.repo, "number": rec.number})
            try:
                await prs.client.update_pull(prs._ref(rec), rec.number, body=text)
            except github.GitHubError as exc:
                log.warning("couldn't link %s#%s: %s", rec.repo, rec.number, exc)
        await self.publish()
        return f"Opened {len(opened)} linked pull requests."

    async def _remember_prs(self, group: Group, opened: list[tuple[Any, Any, str]]) -> None:
        group.prs = [
            {"project": c.label, "repo": r.repo, "number": r.number, "url": r.url}
            for c, r, _b in opened
        ]
        self.save()
        await self.publish()

    async def merge(self, slug: str) -> str:
        group = self.groups().get(slug)
        if group is None:
            return "That multi-repo task isn't there any more."
        prs = self.hub.code_pr
        recs = [r for p in group.prs if (r := prs.store().find(p["repo"], int(p["number"])))]
        if not recs:
            return "There are no pull requests for this task yet."
        problems, ready = [], []
        for rec in recs:
            why, sha = await self._ready(rec)
            if why:
                problems.append(f"{rec.repo}#{rec.number}: {why}")
            else:
                ready.append((rec, sha))
        if problems:
            return f"Nothing merged: {'; '.join(problems)}."
        listed = "\n".join(f"• {r.repo}#{r.number}: {r.title}" for r, _s in ready)
        question = f"Merge all {len(ready)} pull requests?"
        detail = (
            f"{listed}\n\nEach is green and mergeable on its latest commit, and is merged at "
            "that commit. GitHub can't merge across repositories at once: if one is pushed to "
            "meanwhile, the ones before it stay merged and I say which."
        )
        if (
            await self.ask(question, detail, [("merge", "Merge all"), ("deny", "Not now")])
            != "merge"
        ):
            return "Not merged."
        merged: list[Any] = []
        for rec, sha in ready:
            rec.head_sha = sha
            said = await prs.merge(rec)
            if said:
                names = ", ".join(f"{r.repo}#{r.number}" for r in merged) or "none"
                self.notify(group, f"{group.title}: {rec.repo}#{rec.number} didn't merge.")
                return f"Merged {names}; then {said}"
            merged.append(rec)
        await self.publish()
        return f"Merged all {len(merged)} pull requests."

    async def _ready(self, rec: Any) -> tuple[str, str]:
        """Why a pull request can't be merged now ("" when it can), and its head commit."""
        client, ref = self.hub.code_pr.client, self.hub.code_pr._ref(rec)
        try:
            pull = await client.pull(ref, rec.number)
            if pull.get("merged") or pull.get("state") != "open":
                return "it isn't open", ""
            if pull.get("draft"):
                return "it's a draft", ""
            if pull.get("mergeable") is False or pull.get("mergeable_state") not in (
                "clean", "has_hooks", "unstable",
            ):  # fmt: skip
                return f"GitHub says it can't merge yet ({pull.get('mergeable_state')})", ""
            sha = str((pull.get("head") or {}).get("sha") or "")
            runs = await client.check_runs(ref, sha)
            statuses = await client.statuses(ref, sha)
        except github.GitHubError as exc:
            return str(exc), ""
        waiting = [r.get("name") for r in runs if r.get("status") != "completed"]
        failed = [
            r.get("name")
            for r in runs
            if r.get("status") == "completed" and r.get("conclusion") not in GREEN
        ]
        failed += [s.get("context") for s in statuses if s.get("state") in ("failure", "error")]
        waiting += [s.get("context") for s in statuses if s.get("state") == "pending"]
        if failed:
            return f"checks failing ({', '.join(str(n) for n in failed[:3])})", ""
        if waiting:
            return f"checks still running ({', '.join(str(n) for n in waiting[:3])})", ""
        return "", sha

    # ── the window ──

    async def publish(self) -> None:
        items = []
        for group in sorted(self.groups().values(), key=lambda g: -g.created):
            task = self.task_of(group)
            copies = self.copies(group)
            states = await asyncio.to_thread(lambda cs=copies: [worktrees.state(c) for c in cs])
            items.append(
                {
                    "slug": group.slug,
                    "title": group.title,
                    "folder": group.folder,
                    "session": task.id if task is not None else 0,
                    "busy": bool(task is not None and task.busy),
                    "repos": [
                        {
                            "project": c.label,
                            "slug": c.slug,
                            "branch": c.branch,
                            "into": c.into,
                            "state": s.public(),
                            "conflicts": self.desk.conflicts.get(c.slug, []),
                        }
                        for c, s in zip(copies, states, strict=True)
                    ],
                    "prs": group.prs,
                }
            )
        self.hub.emit("code_multis", groups=items, most=MAX_REPOS)

    async def resume(self, slug: str) -> str:
        group = self.groups().get(slug)
        if group is None or not Path(group.folder).is_dir():
            return "That multi-repo task isn't there any more."
        task = self.task_of(group)
        if task is None or task.handle is None or task.handle.done():
            try:
                task = self.hub.tasks.start(
                    "", group.folder, resume=group.session_id, title=group.title, isolate=False
                )
            except ValueError as exc:
                return str(exc)
            group.task_id = task.id
        self.hub.emit("show_session", id=task.id)
        return ""

    def _run(self, coro: Any) -> None:
        async def reply() -> None:
            said = await coro
            self.caption(said)
            await self.publish()

        self.hub._spawn(reply())

    def on_task_event(self, kind: str, _data: dict[str, Any]) -> None:
        """A task's session id is known after its first turn: kept, for resuming later."""
        if kind != "tasks":
            return
        for group in self.groups().values():
            task = self.hub.tasks.tasks.get(group.task_id) if group.task_id else None
            if task is not None and task.session_id and task.session_id != group.session_id:
                group.session_id = task.session_id
                self.save()


def install(hub: Any) -> None:
    desk = getattr(hub, "code_desk", None)
    if desk is None:
        return  # (no isolated copies here: no multi-repo tasks either)
    multi = MultiDesk(hub)
    hub.code_multi = multi  # (for the tests)
    desk.holders.append(multi.held)
    hub.tasks.isolated_dir = multi.wrap_isolated_dir(hub.tasks.isolated_dir)
    hub.tasks.prepare = multi.wrap_prepare(hub.tasks.prepare)
    hub.add_task_sink(multi.on_task_event)
    group = lambda msg: str(msg.get("group") or "")[:80]  # noqa: E731
    hub.register_command("code_multis", lambda _msg: hub._spawn(multi.publish()))
    hub.register_command("code_multi_start", lambda msg: multi._run(multi.start(msg)))
    hub.register_command("code_multi_land", lambda msg: multi._run(multi.land(group(msg))))
    hub.register_command("code_multi_discard", lambda msg: multi._run(multi.discard(group(msg))))
    hub.register_command("code_multi_prs", lambda msg: multi._run(multi.open_prs(group(msg), msg)))
    hub.register_command("code_multi_merge", lambda msg: multi._run(multi.merge(group(msg))))
    hub.register_command("code_multi_open", lambda msg: multi._run(multi.resume(group(msg))))
