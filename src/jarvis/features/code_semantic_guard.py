"""Eden Code: the semantic conflict guard. Before the merge queue lands a piece of work, it
compares the symbols and contracts that work changed with what every other piece of work
in the same project changed, not just their lines.

git only stops a landing when two changes touch the same lines. Parallel sessions collide
in other ways too, and those land cleanly and break later: both changed what one function
does; one gave a function a new signature while the other wrote new calls to it the old
way; one removed or renamed something the other's new code still uses. code_semantic.py
reads each piece of work by the code index's symbol map (code_index.extract) and finds
those; this feature runs it where it matters:

- When: the merge queue (code_merge_queue.py) asks before it takes a waiting item, and
  asks again about an item it holds, each tick (a piece of work is read again only when
  its commit, its uncommitted files or the branch it lands in moved: a mark of those keeps
  what was read).
- Against what: the project's other queued items (isolated copies, pull requests), its
  other isolated copies with work in them (sessions working in parallel, queued or not),
  and what landed in the branch it goes into since it began (the collision is then already
  in that branch; that side has nobody to tell).
- A finding: the merge queue holds the item ("held": set aside like one sent back, so the
  ones behind it still land), the board's Merge queue card lists what collides, and the
  attention list has a heads-up. Both sessions get a message once for each new finding
  (the one about to land and the one it collides with, each told the other's session
  number so they can talk it over with jarvis_sessions' message_session); a copy whose
  session isn't open is opened again with it, as the queue does with a conflict. Not when
  code_mq_conflicts is "owner", for work from outside (a run a GitHub issue, Linear or
  Slack started), or for a pull request whose session isn't open: the owner's card says
  so.
- Resolved: the next look finds nothing (a session adapted its calls to the new signature,
  stopped using what was removed, or the work landed), and the item goes back in line by
  itself. Or overridden: "Land anyway" on its card, for those findings (a new one holds it
  again); "Check again" reads everything afresh.

Window commands: code_mq_item {id, action: override} (the queue's own command).
Settings (prefs.features): code_mq_semantic ("hold" | "warn" | "off", default "hold"):
"warn" tells and shows but never holds; "off" doesn't look.

Cost policy: the comparison calls no model (Python's parser, patterns and git on this
Mac). A message to a session is one turn of that session's own model, as the merge queue's
conflicts are (the owner's queueing is the ask); with code_mq_conflicts "owner" nothing is
sent.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .. import code_changes, code_semantic, lang, prefs, worktrees
from ..code_changes import git
from ..proactive import Alert
from .code_merge_queue import PREF_CONFLICTS

log = logging.getLogger("jarvis")

PREF = "code_mq_semantic"
MODES = ("hold", "warn", "off")
OTHERS_MAX = 12  # other pieces of work one item is compared with
SHOWN_MAX = 8  # findings on a card and in a message
CACHE_MAX = 64


def _mode_pref(value: Any) -> str | None:
    return value if value in MODES else None


prefs.register_feature_pref(PREF, "hold", _mode_pref)

ZH = {
    "this one": "这一项",
    "the isolated copy “{title}”": "独立副本“{title}”",
    "session {n} (“{title}”)": "会话 {n}（“{title}”）",
    "pull request {title}": "拉取请求 {title}",
    "what landed in {into} since it began": "它开始之后合并进 {into} 的内容",
    "{a} and {b} both changed {symbol} in {path}.": "{a}和{b}都改了 {path} 里的 {symbol}。",
    "{a} changed the signature of {symbol} in {path} ({detail}), and {b} adds calls to it that don't fit (first at {where}).": "{a}改了 {path} 里 {symbol} 的签名（{detail}），而{b}新加的调用不符合它（第一处在 {where}）。",
    "{a} removed {symbol} from {path}, and {b} still uses it (at {where}).": "{a}从 {path} 删掉了 {symbol}，而{b}还在用它（在 {where}）。",
    "{a} renamed {symbol} in {path} to {renamed}, and {b} still uses the old name (at {where}).": "{a}把 {path} 里的 {symbol} 改名为 {renamed}，而{b}还在用旧名字（在 {where}）。",
    "Held: it collides with {other} in {n} place(s) git doesn't see; both sessions were told.": "已暂缓：它和{other}有 {n} 处 git 看不出的冲突；已告诉两个会话。",
    "Held: it collides with {other} in {n} place(s) git doesn't see; over to you.": "已暂缓：它和{other}有 {n} 处 git 看不出的冲突；交给你处理。",
    "It collides with {other} in {n} place(s) git doesn't see; both sessions were told.": "它和{other}有 {n} 处 git 看不出的冲突；已告诉两个会话。",
    "It collides with {other} in {n} place(s) git doesn't see; over to you.": "它和{other}有 {n} 处 git 看不出的冲突；交给你处理。",
    "Overlapping changes": "重叠的改动",
}
lang.add_texts(ZH)


@dataclass
class Work:
    """One piece of work, as git sees it: what differs from base (its fork from the branch
    it lands in) to head (a commit; "" for its working tree, uncommitted work too)."""

    id: str  # copy:<slug> | pr:<key> | landed:<repo>:<into>
    kind: str  # copy | pr | landed
    ref: str
    title: str
    top: str  # where git runs for it
    base: str
    head: str
    mark: str  # what moving it would change: its commit, its files, its base
    project: str = ""  # the project's folder (where the code index is for)


def _status_mark(folder: str) -> str:
    """The uncommitted files in a checkout, with their size and time: a cheap stand-in for
    their contents (blocking: git)."""
    found = git(folder, "status", "--porcelain", "-z", "--untracked-files=all")
    parts = []
    for code, path in worktrees.status_entries(found.out) if found.ok else []:
        try:
            st = (Path(folder) / path).stat()
            parts.append(f"{code}{path}:{st.st_size}:{st.st_mtime_ns}")
        except OSError:
            parts.append(f"{code}{path}")
    return hashlib.sha1("\0".join(parts).encode()).hexdigest()[:16]


def copy_work(copy: worktrees.Copy) -> Work | None:
    """An isolated copy's work: its branch and uncommitted files since it forked from the
    branch it lands in (blocking: git)."""
    head = worktrees._rev(copy.checkout, "HEAD")
    tip = worktrees._rev(copy.repo, f"refs/heads/{copy.into}")
    if not head:
        return None
    fork = (code_changes.merge_base(Path(copy.checkout), head, tip) if tip else "") or copy.base
    return Work(f"copy:{copy.slug}", "copy", copy.slug, copy.title or copy.slug, copy.checkout,
                fork, "", f"{head}:{fork}:{_status_mark(copy.checkout)}",
                str(Path(copy.repo) / copy.prefix))  # fmt: skip


def pr_work(rec: Any) -> Work | None:
    """A pull request's branch since it forked from its base (blocking: git)."""
    repo = code_changes.repo_of(Path(rec.folder))
    if repo is None:
        return None
    top = repo.top
    head = worktrees._rev(top, f"refs/remotes/{rec.remote}/{rec.branch}") or worktrees._rev(
        top, f"refs/heads/{rec.branch}"
    )
    onto = worktrees._rev(top, f"refs/remotes/{rec.remote}/{rec.base}") or worktrees._rev(
        top, f"refs/heads/{rec.base}"
    )
    if not head or not onto:
        return None
    fork = code_changes.merge_base(top, head, onto)
    if not fork:
        return None
    return Work(f"pr:{rec.key}", "pr", rec.key, f"#{rec.number} {rec.title}", str(top), fork,
                head, f"{head}:{fork}", str(rec.folder))  # fmt: skip


def landed_work(work: Work, repo: str, into: str, ref: str = "") -> Work | None:
    """What landed in into (its tip: ref, else the local branch) since work forked from it
    (blocking: git)."""
    tip = worktrees._rev(repo, ref or f"refs/heads/{into}") if into else ""
    if not tip or tip == work.base or not worktrees._is_ancestor(repo, work.base, tip):
        return None
    return Work(f"landed:{repo}:{into}", "landed", into, into, repo, work.base, tip,
                f"{work.base}:{tip}", work.project)  # fmt: skip


class Guard:
    def __init__(self, hub: Any, queue: Any) -> None:
        self.hub = hub
        self.queue = queue
        self.read: dict[str, tuple[str, code_semantic.Change]] = {}  # work id -> (mark, change)

    def tr(self, text: str, **kw: Any) -> str:
        return self.queue.tr(text, **kw)

    def mode(self) -> str:
        try:
            value = self.hub.prefs.feature(PREF)
        except Exception:
            value = "hold"
        return value if value in MODES else "hold"

    @property
    def desk(self) -> Any:
        return getattr(self.hub, "code_desk", None)

    @property
    def prs(self) -> Any:
        return getattr(self.hub, "code_pr", None)

    # ── the queue's question ──

    async def hold(self, item: dict[str, Any]) -> str:
        """Whether an item may land now: "" (it may), else why it's held. Finds what it
        collides with, puts that on its card, and tells the sessions once."""
        if self.mode() == "off":
            for k in ("guard", "guard_keys"):
                item.pop(k, None)
            return ""
        me = await asyncio.to_thread(self._work_for, item)
        if me is None:
            return ""
        others = await self._others(item, me)
        index = self._index_for(me.project)
        found = await asyncio.to_thread(self._collisions, me, others, index)
        skip = set(item.get("overridden") or [])
        live = [(o, f) for o, f in found if f"{o.id}|{f.key()}" not in skip]
        item["guard"] = [self._public(o, f, f"{o.id}|{f.key()}" in skip) for o, f in found][:SHOWN_MAX]  # fmt: skip
        item["guard_keys"] = [f"{o.id}|{f.key()}" for o, f in found]
        if not live:
            return ""
        told = set(item.get("guard_told") or [])
        fresh = [(o, f) for o, f in live if f"{o.id}|{f.key()}" not in told]
        sent = bool(item.get("guard_sent"))
        if fresh:
            sent = await self._tell(item, me, fresh, index)
            item["guard_sent"] = sent
            item["guard_told"] = sorted(told | {f"{o.id}|{f.key()}" for o, f in fresh})[-200:]
        first = live[0][0]
        n = sum(1 for o, _f in live if o.id == first.id)
        other = self._label(first)
        if self.mode() == "warn":
            if fresh:
                text = ("It collides with {other} in {n} place(s) git doesn't see; "
                        + ("both sessions were told." if sent else "over to you."))  # fmt: skip
                self._alert(item, self.tr(text, other=other, n=n))
            return ""
        text = "Held: it collides with {other} in {n} place(s) git doesn't see; " + (
            "both sessions were told." if sent else "over to you."
        )
        return self.tr(text, other=other, n=n)

    # ── what's compared ──

    def _work_for(self, item: dict[str, Any]) -> Work | None:
        if item["kind"] == "copy":
            copy = self.desk.store().find(item["ref"]) if self.desk is not None else None
            return copy_work(copy) if copy is not None else None
        rec = self.queue._rec(item["ref"])
        return pr_work(rec) if rec is not None and rec.state == "open" else None

    async def _others(self, item: dict[str, Any], me: Work) -> list[Work]:
        """The project's other queued items, its other copies with work, and what landed
        in the branch it goes into since it began."""
        repo = item["repo"]
        refs: list[tuple[str, str]] = []
        for other in self.queue.queue_of(repo):
            if other is not item:
                refs.append((other["kind"], other["ref"]))
        if self.desk is not None:
            for copy in self.desk.store().copies:
                if (
                    copy.repo == repo
                    and ("copy", copy.slug) not in refs
                    and (item["kind"] != "copy" or copy.slug != item["ref"])
                ):
                    refs.append(("copy", copy.slug))

        def read() -> list[Work]:
            out: list[Work] = []
            for kind, ref in refs[:OTHERS_MAX]:
                w = self._work_for({"kind": kind, "ref": ref})
                if w is not None and w.id != me.id:
                    out.append(w)
            ref = ""
            if item["kind"] == "pr":
                rec = self.queue._rec(item["ref"])
                ref = f"refs/remotes/{rec.remote}/{rec.base}" if rec is not None else ""
            landed = landed_work(me, me.top if item["kind"] == "pr" else repo,
                                 item.get("into") or "", ref)  # fmt: skip
            if landed is not None:
                out.append(landed)
            return out

        return await asyncio.to_thread(read)

    def _index_for(self, project: str) -> Any:
        """The project's code index (its symbol map, as last saved), or None."""
        desk = getattr(self.hub, "code_index", None)
        if desk is None or not project:
            return None
        try:
            return desk.index_for(Path(project)) if desk.on() else None
        except Exception:
            return None

    def _change(self, work: Work, index: Any) -> code_semantic.Change:
        kept = self.read.get(work.id)
        if kept is not None and kept[0] == work.mark:
            return kept[1]
        change = code_semantic.read_work(work.top, work.base, work.head)
        if index is not None:

            def defined(name: str, touched: set[str]) -> bool:
                try:
                    found = index.lookup(name, limit=20)
                except Exception:
                    return False
                return any(
                    f["name"].split(".")[-1] == name
                    and not any(t.endswith(f["path"]) or f["path"].endswith(t) for t in touched)
                    for f in found
                )

            code_semantic.drop_defined_elsewhere(change, defined)
        if len(self.read) >= CACHE_MAX:
            self.read.pop(next(iter(self.read)))
        self.read[work.id] = (work.mark, change)
        return change

    def _collisions(self, me: Work, others: list[Work],
                    index: Any) -> list[tuple[Work, code_semantic.Finding]]:  # fmt: skip
        mine = self._change(me, index)
        if mine.empty():
            return []
        out: list[tuple[Work, code_semantic.Finding]] = []
        for other in others:
            try:
                theirs = self._change(other, index)
            except Exception:
                log.exception("semantic guard: couldn't read %s", other.id)
                continue
            out.extend((other, f) for f in code_semantic.compare(mine, theirs))
        return out

    # ── telling ──

    def _label(self, work: Work, plain: bool = False) -> str:
        tr = (lambda text, **kw: text.format(**kw)) if plain else self.tr
        if work.kind == "landed":
            return tr("what landed in {into} since it began", into=work.ref)
        task = self._open_task(work)
        if task is not None:
            return tr("session {n} (“{title}”)", n=task.id, title=work.title)
        if work.kind == "pr":
            return tr("pull request {title}", title=work.title)
        return tr("the isolated copy “{title}”", title=work.title)

    def _open_task(self, work: Work) -> Any:
        if work.kind == "copy" and self.desk is not None:
            copy = self.desk.store().find(work.ref)
            if copy is None:
                return None
            live = [t for t in self.desk.tasks_in(copy)
                    if t.handle is not None and not t.handle.done()]  # fmt: skip
            return live[-1] if live else None
        if work.kind == "pr" and self.prs is not None:
            rec = self.queue._rec(work.ref)
            task = self.prs.task_for(rec) if rec is not None else None
            if task is not None and task.handle is not None and not task.handle.done():
                return task
        return None

    def describe(self, f: code_semantic.Finding, a: str, b: str, plain: bool = False) -> str:
        """One finding in a sentence: a is the side it's told for, b the other. plain: in
        English, for a session (the queue's messages to sessions are)."""
        changer, other = (a, b) if f.by == 0 else (b, a)
        tr = (lambda text, **kw: text.format(**kw)) if plain else self.tr
        where = {"symbol": f.symbol, "path": f.path, "where": f.where}
        if f.kind == "body":
            return tr("{a} and {b} both changed {symbol} in {path}.", a=a, b=b, **where)
        if f.kind == "contract":
            return tr(
                "{a} changed the signature of {symbol} in {path} ({detail}), and {b} adds calls "
                "to it that don't fit (first at {where}).",
                a=changer, b=other, detail=f.detail, **where,
            )  # fmt: skip
        if f.detail:
            return tr(
                "{a} renamed {symbol} in {path} to {renamed}, and {b} still uses the old name "
                "(at {where}).",
                a=changer, b=other, renamed=f.detail, **where,
            )  # fmt: skip
        return tr(
            "{a} removed {symbol} from {path}, and {b} still uses it (at {where}).",
            a=changer, b=other, **where,
        )  # fmt: skip

    def _public(self, other: Work, f: code_semantic.Finding, overridden: bool) -> dict[str, Any]:
        return {"kind": f.kind, "symbol": f.symbol, "path": f.path, "line": f.line,
                "other": other.id, "text": self.describe(f, self.tr("this one"), self._label(other)),
                "overridden": overridden}  # fmt: skip

    def _can_tell(self, work: Work) -> bool:
        if work.kind == "landed":
            return False
        if self.hub.prefs.feature(PREF_CONFLICTS) == "owner":
            return False
        folder = work.project or work.top
        if self.queue._outside(folder):
            return False
        if work.kind == "pr":
            return self._open_task(work) is not None
        copy = self.desk.store().find(work.ref) if self.desk is not None else None
        return copy is not None and bool(copy.sessions or self.desk.tasks_in(copy))

    def _message(self, me: Work, them: Work, lines: list[str], landing: bool) -> str:
        """A message to them's session: me is the work about to land (them itself when
        landing), the one it collides with named so the two can talk it over."""
        other = them if landing else me
        task = self._open_task(other) if other.kind != "landed" else None
        talk = (
            f" You can talk it over with it: jarvis_sessions' message_session, session {task.id}."
            if task is not None
            else ""
        )
        about = (
            f"your work (“{me.title}”) before it lands: it and {self._label(other, True)}"
            if landing
            else f"{self._label(me, True)} before it lands: it and your work"
        )
        return (
            f"Eden Code's merge queue is holding {about}, worked on in parallel, changed the "
            "same code in ways git doesn't see as a conflict:\n"
            + "\n".join(f"- {line}" for line in lines[:SHOWN_MAX])
            + f"\n\nWork out which change is meant and make yours fit it.{talk} Don't land or "
            "discard anything yourself: commit when you're done, and the queue looks again. If "
            "nothing needs changing, say why; the owner can land it anyway."
        )

    async def _tell(self, item: dict[str, Any], me: Work,
                    fresh: list[tuple[Work, code_semantic.Finding]], index: Any) -> bool:  # fmt: skip
        """Both sides of each new finding get a message; True when the one about to land
        (and every other that has a session) did."""
        by_other: dict[str, tuple[Work, list[code_semantic.Finding]]] = {}
        for o, f in fresh:
            by_other.setdefault(o.id, (o, []))[1].append(f)
        told_me = False
        if self._can_tell(me):
            lines = [self.describe(f, "your work", self._label(o, True), True) for o, f in fresh]
            first = fresh[0][0]
            told_me = self._send(me, self._message(me, first, lines, landing=True))
        told_all = told_me
        for other, findings in by_other.values():
            if other.kind == "landed":
                continue
            if not self._can_tell(other):
                told_all = False
                continue
            theirs = await asyncio.to_thread(self._change, other, index)
            mine = await asyncio.to_thread(self._change, me, index)
            mirror = code_semantic.compare(theirs, mine) or findings
            lines = [self.describe(f, "your work", self._label(me, True), True) for f in mirror]
            told_all = (
                self._send(other, self._message(me, other, lines, landing=False)) and told_all
            )
        return told_all

    def _send(self, work: Work, text: str) -> bool:
        task = self._open_task(work)
        if task is not None:
            return bool(self.hub.tasks.send(task.id, text))
        if work.kind != "copy":
            return False
        copy = self.desk.store().find(work.ref)
        return copy is not None and self.queue._open_with(copy, text) == ""

    def _alert(self, item: dict[str, Any], text: str) -> None:
        self.hub.notify(
            Alert(f"code-mq-guard:{item['id']}:{len(item.get('guard_told') or [])}", "task",
                  self.tr("Merge queue"), f"{item['project']}: {item['title']}: {text}",
                  note="two Eden Code sessions changed the same code in ways git doesn't see"),
            speak=False,
        )  # fmt: skip


def install(hub: Any) -> None:
    queue = getattr(hub, "code_mq", None)
    if queue is None:
        return
    guard = Guard(hub, queue)
    hub.code_mq_guard = guard  # (for the tests)
    queue.guard = guard
