"""Eden Code: a merge queue, so many agents' work lands one after another instead of into
each other.

When several isolated copies (code_isolation.py) or pull requests (code_pr.py) are ready,
the owner puts them in their project's queue (one queue per repository, behind one card
each: what it does, in what order). Eden then takes them one at a time, in order (one
step at a time across projects too: two projects' test runs never contend for the Mac; a
pull request waiting for its checks on GitHub holds up nothing but its own queue):

- an isolated copy: its uncommitted work committed, its branch brought onto the newest tip
  of the branch it lands in (rebased; merged instead when its session already resolved a
  conflict by merging, since a rebase would drop that merge and hit the same conflict
  again), the project's tests run in the copy (Exterminator Mode's suite runner:
  code_bugfix.run_suites), and only then landed (code_isolation's own land path: its
  sessions' turns held from the first step to the last, a turn under way stopped and
  waited for, the copy removed). Landing after the update is a fast-forward. When the tip
  moved while the tests ran (something landed outside the queue), it's brought up to date
  and tested again, at most UPDATE_TRIES times.
- a pull request: its branch rebased onto the newest base in a scratch worktree
  (code_stack.restack; merged when it has merges of its own) and force-pushed with a
  lease, atomically (a branch someone pushed to meanwhile is left alone), its checks on
  GitHub waited for (they are its tests, re-run on the new head), then merged by code_pr
  (the method the pull request is set to, only at that head).

A conflict, or tests that fail, goes back to the session that owns the work, as a task: the
files, or the failures, and what to do (the copy's session is opened again, or the pull
request's follow-up goes to its session, within code_pr's caps). The item waits ("fixing")
and is taken again by itself once that session's turn is over and its branch moved. It's
marked for the owner instead when the setting code_mq_conflicts is "owner", when the work
came from outside (a run started by a GitHub issue, Linear or Slack: never opened again as
an ordinary session), or when there's no session to send it to. Either way the attention
list (a heads-up) and the board's Merge queue lane say so.

Order: each item gets a risk score when queued (files and lines changed; touching tests,
lockfiles or CI raises it) and goes in before the first waiting item that's riskier: small,
safe changes first, the ones that touch tests later. The owner can move any item up or
down (a moved item keeps its place), pause or resume one, pause a whole project's queue,
take an item off, or try one again.

Held: before a waiting item is taken, the semantic conflict guard (code_semantic_guard.py)
compares the symbols and contracts it changed with the project's other work; when they
collide in a way git doesn't see, the item is "held" (set aside, as one sent back is) until
the guard finds nothing or the owner lands it anyway (override).

Window commands: code_mq {}, code_mq_add {kind: copy|pr, slug | key}, code_mq_item {id,
action: up|down|remove|pause|resume|retry|override}, code_mq_project {repo, paused}.
Events: code_mq {queues: [{repo, project, paused, items}], attention}.
Settings (prefs.features): code_mq_conflicts ("session" | "owner").
Loop: code_merge_queue.

Cost policy: the queue itself calls no model. A conflict or failing tests sent back to a
session is one turn of that session's own model (the owner's queueing is the ask); a pull
request's goes through code_pr's follow-up caps. Its tests run on this Mac (the project's
own suite, as the Tests pane runs it); a pull request's run on GitHub.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any

from .. import code_changes, jsonstore, lang, prefs, worktrees
from ..code_changes import NO_HOOKS, git
from ..code_prs import FIX_ATTEMPTS
from ..proactive import Alert
from .code_stack import PUSH_ENV, PUSH_SECONDS, follow_local, restack

log = logging.getLogger("jarvis")

PREF_CONFLICTS = "code_mq_conflicts"
STORE = "code_merge_queue.json"
TICK = 20.0  # seconds between looks at the queues (a change wakes it sooner)
FIRST = 15.0
UPDATE_TRIES = 3
CHECKS_WAIT = 3 * 3600.0  # a pull request's checks waited for this long, then the owner hears
DONE_KEPT = 20
ITEMS_MAX = 100
WAITING = ("queued",)
OPEN = ("queued", "working", "checks", "fixing", "paused", "owner", "held")
_TESTS = re.compile(
    r"(^|/)(tests?|__tests__|spec|specs)/|(^|/)test_[^/]*$|_test\.\w+$|\.(test|spec)\.\w+$"
)
_RISKY = re.compile(
    r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|Cargo\.lock|"
    r"go\.sum|Gemfile\.lock|pyproject\.toml|package\.json)$|(^|/)\.github/|(^|/)migrations?/"
)


def _conflicts_pref(value: Any) -> str | None:
    return value if value in ("session", "owner") else None


prefs.register_feature_pref(PREF_CONFLICTS, "session", _conflicts_pref)

ZH = {
    "Merge queue": "合并队列",
    "Land {title} in order?": "要按顺序合并 {title} 吗？",
    "Merge pull request #{n} in order?": "要按顺序合并拉取请求 #{n} 吗？",
    "It joins the {project} queue at place {place} of {total}. When its turn comes, its work is committed, rebased onto the newest {into}, the project's tests are run in the copy, and it lands only if they pass. A conflict or a failing test goes back to its session.": "它会排进 {project} 的队列，第 {place} 位（共 {total} 个）。轮到它时，它的工作会被提交、变基到最新的 {into} 上，在副本里运行项目的测试，测试通过才合并。冲突或失败的测试会交回给它的会话。",
    "It joins the {project} queue at place {place} of {total}. When its turn comes, its branch is rebased onto the newest {base} and force-pushed (with a lease), its checks on GitHub are waited for, and it's merged ({method}) only if they pass. A conflict or a failing check goes back to its session.": "它会排进 {project} 的队列，第 {place} 位（共 {total} 个）。轮到它时，它的分支会变基到最新的 {base} 上并强制推送（带租约），等待 GitHub 上的检查，检查通过才合并（{method}）。冲突或失败的检查会交回给它的会话。",
    "Queue it": "加入队列",
    "Not now": "暂不",
    "Not queued.": "没有加入队列。",
    "Queued {title}.": "已把 {title} 加入队列。",
    "It's already in the queue.": "它已经在队列里了。",
    "That isolated copy isn't there any more.": "那个独立副本已经不在了。",
    "That pull request isn't open.": "那个拉取请求没有打开。",
    "The queue is full; land or remove some first.": "队列已满；先合并或移除一些。",
    "Waiting: its session is working.": "等待中：它的会话正在工作。",
    "Bringing it up to date with {into}…": "正在让它跟上 {into}……",
    "Running the tests…": "正在运行测试……",
    "Landing…": "正在合并……",
    "Waiting for its checks on GitHub…": "正在等待 GitHub 上的检查……",
    "Landed in {into}.": "已合并进 {into}。",
    "Merged into {base}.": "已合并进 {base}。",
    "Conflicts with {into} in {files}; sent to its session.": "与 {into} 在 {files} 有冲突；已交给它的会话。",
    "Conflicts with {into} in {files}; over to you.": "与 {into} 在 {files} 有冲突；交给你处理。",
    "Its tests fail on the newest {into}; sent to its session.": "在最新的 {into} 上它的测试失败；已交给它的会话。",
    "Its tests fail on the newest {into}; over to you.": "在最新的 {into} 上它的测试失败；交给你处理。",
    "Its checks failed; sent to its session.": "它的检查失败了；已交给它的会话。",
    "Its checks failed; over to you.": "它的检查失败了；交给你处理。",
    "Its checks didn't finish in 3 hours; over to you.": "它的检查 3 小时内没有完成；交给你处理。",
    "Possible secrets in its uncommitted work: land it from the Copies pane.": "它未提交的工作里可能有密钥：请在副本面板里合并它。",
    "Its tests couldn't run: {why}": "它的测试没能运行：{why}",
    "{into} kept moving while it was tested; try it again.": "测试期间 {into} 一直在变化；请再试一次。",
    "Paused.": "已暂停。",
    "Removed from the queue.": "已从队列移除。",
    "It's being landed just now; wait for it.": "它正在合并；请稍等。",
    "{project}: {title} needs you in the merge queue. {note}": "{project}：合并队列里的 {title} 需要你处理。{note}",
    "No tests found; landed on the update alone.": "没有找到测试；只凭更新就合并了。",
}
lang.add_texts(ZH)


# ── how risky a change is ──


def risk_of(paths: list[str], added: int, removed: int) -> tuple[float, list[str]]:
    """A change's risk score (lower lands first) and why, in a few words: its size, and
    whether it touches tests (they go later: a change to the tests is the one most likely
    to make the next ones' runs mean something else) or lockfiles, CI and migrations."""
    score = len(paths) + (added + removed) / 40.0
    why = [f"{len(paths)} file{'s' if len(paths) != 1 else ''}", f"+{added} −{removed}"]
    if any(_TESTS.search(p) for p in paths):
        score += 25
        why.append("touches tests")
    if any(_RISKY.search(p) for p in paths):
        score += 15
        why.append("touches dependencies or CI")
    return round(score, 2), why


def insert_at(items: list[dict[str, Any]], risk: float) -> int:
    """Where a new item goes in its project's queue: before the first waiting item that's
    riskier and that the owner hasn't placed by hand; else at the end."""
    for i, item in enumerate(items):
        if item.get("state") in WAITING and not item.get("moved") and item.get("risk", 0) > risk:
            return i
    return len(items)


def changed_paths(top: Path | str, base: str, head: str = "") -> tuple[list[str], int, int]:
    """The files changed from base (to head, else to the working tree, untracked files
    too), with lines added and removed (blocking: git)."""
    args = ["diff", "--numstat", "-z", base] + ([head] if head else [])
    stat = git(top, *args)
    paths, added, removed = [], 0, 0
    parts = stat.out.split("\0") if stat.ok else []
    i = 0
    while i < len(parts):
        cols = parts[i].split("\t")
        if len(cols) >= 3:
            name = cols[2]
            if not name and i + 2 < len(parts):  # a rename: old and new name follow
                name = parts[i + 2]
                i += 2
            paths.append(name)
            added += int(cols[0]) if cols[0].isdigit() else 0
            removed += int(cols[1]) if cols[1].isdigit() else 0
        i += 1
    if not head:
        status = git(top, "status", "--porcelain", "-z", "--untracked-files=all")
        for code, path in worktrees.status_entries(status.out) if status.ok else []:
            if code == "??" and path and path not in paths:
                paths.append(path)
                added += worktrees._lines_in(Path(top) / path)
    return paths, added, removed


# ── bringing a branch up to date ──


def _has_merges(top: Path | str, since: str, head: str) -> bool:
    found = git(top, "rev-list", "--merges", "--max-count=1", f"{since}..{head}")
    return bool(found.ok and found.out.strip())


def _conflicted(folder: Path | str) -> list[str]:
    return sorted(set(git(folder, "diff", "--name-only", "--diff-filter=U").out.split()))


def update_checkout(checkout: Path | str, tip: str) -> tuple[bool, list[str], str]:
    """The branch checked out in checkout (an isolated copy, its work committed) brought
    onto tip: rebased, or merged when it has merges of its own since they parted (a
    session that resolved a conflict by merging). (True, [], "") when it's on tip now;
    (False, the conflicting files, why) when not, with everything as it was (blocking)."""
    head = worktrees._rev(checkout, "HEAD")
    if not head or head == tip or worktrees._is_ancestor(checkout, tip, head):
        return True, [], ""
    fork = code_changes.merge_base(Path(checkout), head, tip)
    if fork and _has_merges(checkout, fork, head):
        done = git(checkout, *NO_HOOKS, "merge", "-q", "--no-edit", tip, timeout=180)
        if not done.ok:
            files = _conflicted(checkout)
            git(checkout, "merge", "--abort")
            return False, files, (done.err or done.out).strip()[:300]
        return True, [], ""
    done = git(checkout, *NO_HOOKS, "rebase", "-q", tip, timeout=180)
    if not done.ok:
        files = _conflicted(checkout)
        git(checkout, "rebase", "--abort")
        return False, files, (done.err or done.out).strip()[:300]
    return True, [], ""


def update_branch(top: Path, head: str, onto: str, scratch: Path) -> tuple[str, list[str], str]:
    """A pull request's head (a commit) brought onto onto, in a scratch worktree (no
    checkout of the owner's is touched): (the new head, [], "") or ("", files, why). Its
    head when it's already on onto (blocking)."""
    if head == onto or worktrees._is_ancestor(top, onto, head):
        return head, [], ""
    fork = code_changes.merge_base(top, head, onto)
    if fork and not _has_merges(top, fork, head):
        return restack(top, "", head, fork, onto, scratch)
    scratch.mkdir(parents=True, exist_ok=True)
    folder = scratch / f"mq-{uuid.uuid4().hex[:8]}"
    added = git(top, "worktree", "add", "-q", "--detach", str(folder), head, timeout=120)
    if not added.ok:
        return "", [], added.err.strip()[:300] or "couldn't make a scratch copy"
    try:
        done = git(folder, *NO_HOOKS, "merge", "-q", "--no-edit", onto, timeout=180)
        if not done.ok:
            files = _conflicted(folder)
            git(folder, "merge", "--abort")
            return "", files, (done.err or done.out).strip()[:300]
        return git(folder, "rev-parse", "HEAD").out.strip(), [], ""
    finally:
        git(top, "worktree", "remove", "--force", str(folder))
        git(top, "worktree", "prune")


def _names(files: list[str]) -> str:
    return ", ".join(files[:5]) + (f" and {len(files) - 5} more" if len(files) > 5 else "")


class MergeQueue:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.items: list[dict[str, Any]] = []
        self.paused: dict[str, bool] = {}  # repo -> its whole queue paused
        self.done: list[dict[str, Any]] = []
        self._loaded = False
        self._unreadable = False
        self._wake: asyncio.Event | None = None
        self._busy: set[str] = set()  # repos whose head item is being worked on now
        self._told: set[str] = set()  # "<id>:<state>" the owner heard about
        # The semantic conflict guard (code_semantic_guard.py), when it's installed: asked
        # before a waiting item is taken, and about a held one each tick.
        self.guard: Any = None
        # (Tests replace it.) The project's tests in a folder: {status: passed | failed |
        # error | none, summary, fix_message}.
        self.run_tests = self._run_tests

    # ── plumbing ──

    def tr(self, text: str, **kw: Any) -> str:
        return (
            lang.tr(text, self.hub.language, **kw)
            if kw
            else lang.translate(text, self.hub.language)
        )

    @property
    def desk(self) -> Any:
        return getattr(self.hub, "code_desk", None)

    @property
    def prs(self) -> Any:
        return getattr(self.hub, "code_pr", None)

    def path(self) -> Path:
        return self.hub.feature_path(STORE)

    def load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            data = jsonstore.load_json(self.path(), dict) or {}
        except jsonstore.Unreadable:
            log.warning("merge queue: %s can't be read; nothing is saved over it", self.path())
            self._unreadable = True
            data = {}
        rows = data.get("items") if isinstance(data.get("items"), list) else []
        for row in rows[:ITEMS_MAX]:
            if not (isinstance(row, dict) and row.get("kind") in ("copy", "pr") and row.get("id")):
                continue
            if row.get("state") == "working":  # (cut off by a quit: it starts over)
                row["state"], row["note"] = "queued", ""
            self.items.append(row)
        paused = data.get("paused") if isinstance(data.get("paused"), dict) else {}
        self.paused = {str(k): True for k, v in paused.items() if v is True}
        self.done = [d for d in (data.get("done") or []) if isinstance(d, dict)][-DONE_KEPT:]

    def save(self) -> None:
        self.load()
        if self._unreadable:
            return
        data = {"items": self.items, "paused": self.paused, "done": self.done[-DONE_KEPT:]}
        try:
            jsonstore.save_json(self.path(), data)
        except OSError as exc:
            log.info("merge queue: couldn't save (%s)", exc)

    def wake(self) -> None:
        if self._wake is not None:
            self._wake.set()

    def find(self, item_id: str) -> dict[str, Any] | None:
        return next((i for i in self.items if i["id"] == item_id), None)

    def queue_of(self, repo: str) -> list[dict[str, Any]]:
        return [i for i in self.items if i["repo"] == repo]

    def publish(self) -> None:
        self.load()
        repos = list(dict.fromkeys([*(i["repo"] for i in self.items), *self.paused]))
        queues = []
        for repo in repos:
            items = self.queue_of(repo)
            project = items[0]["project"] if items else Path(repo).name
            queues.append({"repo": repo, "project": project, "paused": bool(self.paused.get(repo)),
                           "items": [dict(i) for i in items]})  # fmt: skip
        attention = sum(1 for i in self.items if i.get("state") == "owner")
        self.hub.emit("code_mq", queues=queues, done=self.done[-DONE_KEPT:], attention=attention)

    def caption(self, text: str) -> None:
        if text:
            self.hub.emit("caption", text=self.tr(text))

    def attention(self, item: dict[str, Any]) -> None:
        """A heads-up for the attention list, once for each state an item reaches."""
        mark = f"{item['id']}:{item['state']}:{item.get('note', '')[:40]}"
        if mark in self._told:
            return
        self._told.add(mark)
        text = self.tr("{project}: {title} needs you in the merge queue. {note}",
                       project=item["project"], title=item["title"], note=self.tr(item.get("note", "")))  # fmt: skip
        if item["state"] == "fixing":
            text = f"{item['project']}: {item['title']}: {self.tr(item.get('note', ''))}"
        self.hub.notify(
            Alert(f"code-mq:{item['id']}:{item['state']}", "task", self.tr("Merge queue"), text,
                  note="an item in Eden Code's merge queue went back to its session or needs the owner"),
            speak=False,
        )  # fmt: skip

    # ── adding ──

    async def add(self, kind: str, ref: str) -> str:
        """Put an isolated copy (slug) or a pull request (code_pr key) in its project's
        queue, behind one card that says where it goes and what will happen."""
        self.load()
        if any(i["kind"] == kind and i["ref"] == ref for i in self.items):
            return "It's already in the queue."
        if len(self.items) >= ITEMS_MAX:
            return "The queue is full; land or remove some first."
        made = await (self._copy_item(ref) if kind == "copy" else self._pr_item(ref))
        if isinstance(made, str):
            return made
        item, question, detail = made
        mine = self.queue_of(item["repo"])
        place = insert_at(mine, item["risk"])
        detail = self.tr(detail[0], **detail[1], place=place + 1, total=len(mine) + 1)
        choices = [("queue", self.tr("Queue it")), ("deny", self.tr("Not now"))]
        if (
            await self.hub.request_approval(self.tr(question[0], **question[1]), detail, choices)
            != "queue"
        ):
            return "Not queued."
        if any(i["kind"] == kind and i["ref"] == ref for i in self.items):
            return "It's already in the queue."
        mine = self.queue_of(item["repo"])
        at = insert_at(mine, item["risk"])
        if at < len(mine):
            self.items.insert(self.items.index(mine[at]), item)
        else:
            self.items.append(item)
        self.save()
        self.publish()
        self.wake()
        return self.tr("Queued {title}.", title=item["title"])

    def _item(self, kind: str, ref: str, repo: str, project: str, title: str, branch: str,
              into: str, paths: list[str], added: int, removed: int) -> dict[str, Any]:  # fmt: skip
        risk, why = risk_of(paths, added, removed)
        return {"id": uuid.uuid4().hex[:10], "kind": kind, "ref": ref, "repo": repo,
                "project": project, "title": title[:120] or branch, "branch": branch, "into": into,
                "risk": risk, "risk_why": why, "state": "queued", "note": "", "moved": False,
                "added": time.time(), "tries": 0, "conflicts": [], "since": ""}  # fmt: skip

    async def _copy_item(self, slug: str) -> Any:
        desk = self.desk
        copy = desk.store().find(slug) if desk is not None else None
        if copy is None:
            return "That isolated copy isn't there any more."
        paths, added, removed = await asyncio.to_thread(changed_paths, copy.checkout, copy.base)
        item = self._item("copy", slug, copy.repo, copy.project, copy.title or copy.slug,
                          copy.branch, copy.into, paths, added, removed)  # fmt: skip
        question = ("Land {title} in order?", {"title": item["title"]})
        detail = (
            "It joins the {project} queue at place {place} of {total}. When its turn comes, "
            "its work is committed, rebased onto the newest {into}, the project's tests are run "
            "in the copy, and it lands only if they pass. A conflict or a failing test goes "
            "back to its session.",
            {"project": copy.project, "into": copy.into},
        )
        return item, question, detail

    async def _pr_item(self, key: str) -> Any:
        desk = self.prs
        rec = self._rec(key)
        if desk is None or rec is None or rec.state != "open":
            return "That pull request isn't open."
        repo = code_changes.repo_of(Path(rec.folder))
        top = repo.top if repo is not None else Path(rec.folder)
        base = f"{rec.remote}/{rec.base}"
        fork = await asyncio.to_thread(code_changes.merge_base, top, base, rec.branch)
        paths, added, removed = await asyncio.to_thread(
            changed_paths, top, fork or base, rec.branch
        )
        item = self._item("pr", key, str(top), rec.project, f"#{rec.number} {rec.title}",
                          rec.branch, rec.base, paths, added, removed)  # fmt: skip
        question = ("Merge pull request #{n} in order?", {"n": rec.number})
        detail = (
            "It joins the {project} queue at place {place} of {total}. When its turn comes, its "
            "branch is rebased onto the newest {base} and force-pushed (with a lease), its "
            "checks on GitHub are waited for, and it's merged ({method}) only if they pass. A "
            "conflict or a failing check goes back to its session.",
            {"project": rec.project, "base": rec.base, "method": rec.merge_method},
        )
        return item, question, detail

    def _rec(self, key: str) -> Any:
        desk = self.prs
        if desk is None:
            return None
        return desk.store().by_key(key)

    # ── the owner's hands on it ──

    def act(self, item_id: str, action: str) -> str:
        self.load()
        item = self.find(item_id)
        if item is None:
            return ""
        mine = self.queue_of(item["repo"])
        n = mine.index(item)
        if action in ("up", "down"):
            other = n - 1 if action == "up" else n + 1
            if 0 <= other < len(mine):
                a, b = self.items.index(mine[n]), self.items.index(mine[other])
                self.items[a], self.items[b] = self.items[b], self.items[a]
                item["moved"] = True
        elif action == "remove":
            if item["state"] == "working":
                return "It's being landed just now; wait for it."
            self.items.remove(item)
        elif action == "pause" and item["state"] in ("queued", "fixing", "owner", "held"):
            item["state"], item["note"] = "paused", "Paused."
        elif action in ("resume", "retry") and item["state"] in ("paused", "owner", "fixing",
                                                                 "held"):  # fmt: skip
            item["state"], item["note"], item["since"] = "queued", "", ""
        elif action == "override" and item["state"] in ("held", "queued", "paused"):
            # Land anyway: what the guard found so far no longer holds it (a new finding does).
            item["overridden"] = list(item.get("guard_keys") or [])
            if item["state"] == "held":
                item["state"], item["note"] = "queued", ""
        self.save()
        self.publish()
        self.wake()
        return "Removed from the queue." if action == "remove" else ""

    def pause_project(self, repo: str, paused: bool) -> None:
        self.load()
        if paused:
            self.paused[repo] = True
        else:
            self.paused.pop(repo, None)
        self.save()
        self.publish()
        self.wake()

    def copy_gone(self, slug: str) -> None:
        """code_isolation's on_copy_gone: a copy landed or discarded some other way (from
        the Copies pane, or by the queue itself) leaves the queue."""
        self.load()
        for item in [i for i in self.items if i["kind"] == "copy" and i["ref"] == slug]:
            if item["state"] != "working":
                self.items.remove(item)
                self.save()
                self.publish()

    # ── the loop ──

    async def loop(self) -> None:
        self._wake = asyncio.Event()
        await asyncio.sleep(FIRST)
        while True:
            try:
                await self.tick()
            except Exception:
                log.exception("the merge queue's tick failed")
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), TICK)
            except TimeoutError:
                pass

    async def tick(self) -> None:
        """Each project's queue: the items sent back that are ready again go back in line,
        and its first waiting item is taken (one at a time per project)."""
        self.load()
        changed = False
        for item in self.items:
            if item["state"] == "fixing" and await self._fixed(item):
                item["state"], item["note"], item["since"] = "queued", "", ""
                changed = True
            elif item["state"] == "held" and not await self._held(item):
                item["state"], item["note"] = "queued", ""
                changed = True
        if changed:
            self.save()
            self.publish()
        for repo in list(dict.fromkeys(i["repo"] for i in self.items)):
            if self.paused.get(repo) or repo in self._busy:
                continue
            head = None
            for waiting in [i for i in self.queue_of(repo) if i["state"] in ("queued", "checks")]:
                if waiting["state"] == "queued" and await self._held(waiting):
                    continue  # (held: set aside like an item sent back; the next one goes)
                head = waiting
                break
            if head is None:
                continue
            # Ahead of it, only items set aside (fixing, paused, the owner's): the queue
            # never lands past an item that's still being worked on.
            self._busy.add(repo)
            try:
                await (self.step_copy(head) if head["kind"] == "copy" else self.step_pr(head))
            finally:
                self._busy.discard(repo)

    async def _held(self, item: dict[str, Any]) -> bool:
        """Whether the semantic conflict guard holds an item: it then waits as "held", with
        what collides on its card, until the guard finds nothing or the owner overrides."""
        if self.guard is None:
            return False
        try:
            why = await self.guard.hold(item)
        except Exception:
            log.exception("the semantic conflict guard failed; the item isn't held")
            return False
        if not why:
            return False
        if item["state"] != "held" or item.get("note") != why:
            self._set(item, "held", why)
        return True

    def _finish(self, item: dict[str, Any], note: str) -> None:
        if item in self.items:
            self.items.remove(item)
        self.done.append({**item, "state": "landed", "note": note, "at": time.time()})
        self.done = self.done[-DONE_KEPT:]
        self.save()
        self.publish()
        self.hub.emit("caption", text=f"{item['title']}: {note}")

    def _set(self, item: dict[str, Any], state: str, note: str = "", **kw: Any) -> None:
        item.update(state=state, note=note, **kw)
        self.save()
        self.publish()
        if state in ("owner", "fixing", "held"):
            self.attention(item)

    # ── an isolated copy ──

    async def step_copy(self, item: dict[str, Any]) -> None:
        desk = self.desk
        copy = desk.store().find(item["ref"]) if desk is not None else None
        if copy is None:
            if item in self.items:
                self.items.remove(item)
                self.save()
                self.publish()
            return
        inside = desk.tasks_in(copy)
        if any(t.busy for t in inside) or desk.working_in(copy.slug):
            if item["note"] != "Waiting: its session is working.":
                self._set(item, "queued", "Waiting: its session is working.")
            return
        findings = await asyncio.to_thread(desk._scan_copy, copy)
        if findings:
            self._set(
                item,
                "owner",
                "Possible secrets in its uncommitted work: land it from the Copies pane.",
            )
            return
        item["tries"] = int(item.get("tries") or 0) + 1
        self._set(item, "working", self.tr("Bringing it up to date with {into}…", into=copy.into))
        desk.start_landing(copy.slug, Path(copy.checkout))
        try:
            await self._land_copy(item, copy)
        finally:
            desk.end_landing(copy.slug)
            if item.get("state") == "working":  # (stopped somewhere it shouldn't have)
                self._set(item, "owner", item.get("note") or "")

    async def _land_copy(self, item: dict[str, Any], copy: worktrees.Copy) -> None:
        desk = self.desk
        # From here its sessions' turns are held (start_landing); one already going is
        # stopped and waited for before anything is committed (as landing does: C5).
        if not await desk.quiet(desk.tasks_in(copy)):
            self._set(item, "queued", "Waiting: its session is working.")
            return
        message = f"Eden Code: {copy.title or copy.slug}"
        problem = await asyncio.to_thread(worktrees.commit_all, copy, message)
        if problem:
            self._set(item, "owner", problem)
            return
        tested = ""
        for _ in range(UPDATE_TRIES):
            tip = await asyncio.to_thread(worktrees._rev, copy.repo, f"refs/heads/{copy.into}")
            if not tip:
                self._set(item, "owner", f"The branch {copy.into} it lands in is gone.")
                return
            if tip == tested:
                break
            self._set(
                item, "working", self.tr("Bringing it up to date with {into}…", into=copy.into)
            )
            ok, files, why = await asyncio.to_thread(update_checkout, copy.checkout, tip)
            if not ok:
                if files:
                    desk.conflicts[copy.slug] = files
                    await self._send_back(item, copy, "conflict", files=files)
                else:
                    self._set(item, "owner", why or "Couldn't bring it up to date.")
                return
            self._set(item, "working", "Running the tests…")
            result = await self.run_tests(copy.cwd)
            status = str(result.get("status") or "error")
            if status == "failed":
                await self._send_back(
                    item,
                    copy,
                    "tests",
                    failures=str(result.get("fix_message") or result.get("summary") or ""),
                )
                return
            if status == "error":
                self._set(
                    item,
                    "owner",
                    self.tr(
                        "Its tests couldn't run: {why}", why=str(result.get("summary") or "")[:300]
                    ),
                )
                return
            item["tests"] = status
            tested = tip
        else:
            self._set(
                item,
                "owner",
                self.tr("{into} kept moving while it was tested; try it again.", into=copy.into),
            )
            return
        self._set(item, "working", "Landing…")
        ok, said = await desk._land_now(copy)
        if not ok:
            files = desk.conflicts.get(copy.slug) or []
            if files:
                await self._send_back(item, copy, "conflict", files=files)
            else:
                self._set(item, "owner" if "still working" not in said else "queued", said)
            return
        if item.get("tests") == "none":
            self._finish(item, self.tr("No tests found; landed on the update alone."))
        else:
            self._finish(item, self.tr("Landed in {into}.", into=copy.into))

    def _outside(self, folder: Path | str) -> bool:
        """Whether the work in a folder came from outside (a run a GitHub issue, Linear or
        Slack started): never opened again as an ordinary session."""
        runs = getattr(self.hub, "code_runs", None)
        if runs is None:
            return False
        runs.load()
        where = str(folder)
        return any(r.untrusted and r.folder and (r.folder == where or where.startswith(r.folder))
                   for r in getattr(runs, "runs", []))  # fmt: skip

    async def _send_back(self, item: dict[str, Any], copy: worktrees.Copy, why: str,
                         files: list[str] | None = None, failures: str = "") -> None:  # fmt: skip
        """A conflict or failing tests back to the copy's session, as a task, or to the
        owner (the setting, work from outside, nobody to send it to)."""
        files = files or []
        where = {"into": copy.into, "files": _names(files)}
        head = await asyncio.to_thread(worktrees._rev, copy.repo, f"refs/heads/{copy.branch}")
        item["conflicts"], item["since"] = files[:50], head
        to_owner = (
            self.hub.prefs.feature(PREF_CONFLICTS) == "owner"
            or self._outside(copy.cwd)
            or not (copy.sessions or self.desk.tasks_in(copy))
        )
        if why == "conflict":
            note = "Conflicts with {into} in {files}; " + (
                "over to you." if to_owner else "sent to its session."
            )
        else:
            note = "Its tests fail on the newest {into}; " + (
                "over to you." if to_owner else "sent to its session."
            )
        note = self.tr(note, **where)
        if to_owner:
            self._set(item, "owner", note)
            return
        if why == "conflict":
            said = await self.desk.resolve(copy.slug)
        else:
            text = (
                f"The merge queue brought this branch ({copy.branch}) onto the newest {copy.into} "
                "and the project's tests fail there. Fix the code (not the tests, unless a test "
                "is wrong), run the tests, and commit. The queue takes it again once you're "
                "done.\n\n" + failures[:6000]
            )
            said = self._open_with(copy, text)
        if said not in (
            "Sent the conflicts to the session.",
            "Opened the session with the conflicts.",
            "",
        ):
            self._set(item, "owner", said)
            return
        self._set(item, "fixing", note)

    def _open_with(self, copy: worktrees.Copy, text: str) -> str:
        open_here = [
            t for t in self.desk.tasks_in(copy) if t.handle is not None and not t.handle.done()
        ]
        if open_here:
            self.hub.tasks.send(open_here[-1].id, text)
            return ""
        session = copy.sessions[-1] if copy.sessions else ""
        try:
            self.hub.tasks.start(text, str(copy.cwd), resume=session)
        except ValueError as exc:
            return str(exc)
        return ""

    async def _fixed(self, item: dict[str, Any]) -> bool:
        """Whether an item sent back is ready to try again: its session's turn is over and
        its branch moved since (or, for a pull request, its head did)."""
        if item["kind"] == "pr":
            rec = self._rec(item["ref"])
            if rec is None or rec.state != "open":
                return True  # (taken again: it's then dropped, or done)
            task = self.prs.task_for(rec)
            busy = task is not None and getattr(task, "busy", False)
            return not busy and bool(rec.head_sha) and rec.head_sha != item.get("since")
        copy = self.desk.store().find(item["ref"]) if self.desk is not None else None
        if copy is None:
            return True
        if any(t.busy for t in self.desk.tasks_in(copy)):
            return False
        head = await asyncio.to_thread(worktrees._rev, copy.repo, f"refs/heads/{copy.branch}")
        dirty = await asyncio.to_thread(lambda: worktrees.state(copy).dirty)
        return head != item.get("since") or bool(dirty)

    async def _run_tests(self, folder: Path) -> dict[str, Any]:
        bugfix = getattr(self.hub, "code_bugfix", None)
        if bugfix is None:
            return {"status": "none", "summary": "no test runner"}
        return await bugfix.run_suites(Path(folder))

    # ── a pull request ──

    async def step_pr(self, item: dict[str, Any]) -> None:
        desk = self.prs
        rec = self._rec(item["ref"])
        if desk is None or rec is None or rec.state == "closed":
            if item in self.items:
                self.items.remove(item)
                self.save()
                self.publish()
            return
        if rec.state == "merged":
            self._finish(item, self.tr("Merged into {base}.", base=rec.base))
            return
        if item["state"] == "checks":
            await self._checks(item, rec)
            return
        task = desk.task_for(rec)
        if task is not None and getattr(task, "busy", False):
            if item["note"] != "Waiting: its session is working.":
                self._set(item, "queued", "Waiting: its session is working.")
            return
        item["tries"] = int(item.get("tries") or 0) + 1
        self._set(item, "working", self.tr("Bringing it up to date with {into}…", into=rec.base))
        said, files = await self._update_pr(rec)
        if files:
            await self._pr_back(item, rec, "conflict", files)
            return
        if said:
            self._set(item, "owner", said)
            return
        desk.poke(rec.key, after=5.0)
        self._set(
            item, "checks", "Waiting for its checks on GitHub…", since=rec.head_sha, at=time.time()
        )

    async def _update_pr(self, rec: Any) -> tuple[str, list[str]]:
        """Its branch onto the newest base and pushed with a lease (atomic: code_stack's
        push): ("", []) when done (or nothing to do), else why, or the conflicting files."""
        repo = code_changes.repo_of(Path(rec.folder))
        if repo is None:
            return f"{rec.folder} isn't a git checkout any more.", []
        top, remote = repo.top, rec.remote
        specs = [
            f"+refs/heads/{b}:refs/remotes/{remote}/{b}"
            for b in dict.fromkeys([rec.base, rec.branch])
        ]
        fetched = await asyncio.to_thread(
            git, top, "fetch", "-q", remote, *specs, env=PUSH_ENV, timeout=PUSH_SECONDS
        )
        if not fetched.ok:
            return f"Couldn't fetch {rec.base}: {fetched.err.strip()[:300]}", []
        head = await asyncio.to_thread(worktrees._rev, top, f"refs/remotes/{remote}/{rec.branch}")
        onto = await asyncio.to_thread(worktrees._rev, top, f"refs/remotes/{remote}/{rec.base}")
        if not head or not onto:
            return f"{rec.branch} or {rec.base} isn't on {remote}.", []
        scratch = self.hub.feature_path("code_mq_scratch")
        new, files, why = await asyncio.to_thread(update_branch, top, head, onto, scratch)
        if not new:
            return (why or "Couldn't bring it up to date."), files
        if new == head:
            rec.head_sha = rec.head_sha or head
            return "", []
        lease = f"--force-with-lease=refs/heads/{rec.branch}:{head}"
        pushed = await asyncio.to_thread(
            git, top, "push", "-q", "--atomic", lease, remote, f"{new}:refs/heads/{rec.branch}",
            env=PUSH_ENV, timeout=PUSH_SECONDS,
        )  # fmt: skip
        if not pushed.ok:
            why = re.sub(r"(\w+://)[^/@\s]+@", r"\1", pushed.err.strip())[-300:]
            return f"Couldn't push the rebased branch: {why}", []
        await asyncio.to_thread(self._follow, top, rec, head, new)
        rec.head_sha, rec.checks = new, "pending"
        self.prs.save()
        return "", []

    @staticmethod
    def _follow(top: Path, rec: Any, old: str, new: str) -> None:
        """The local branch follows the push when nothing is lost: not checked out
        (code_stack.follow_local), or checked out in the session's folder with the old head
        and nothing in the way (git reset --keep keeps uncommitted work, or refuses)."""
        if follow_local(top, rec.branch, old, new):
            return
        holder = worktrees._holder(str(top), rec.branch)
        if holder and worktrees._rev(holder, "HEAD") == old:
            git(holder, "reset", "-q", "--keep", new)

    async def _checks(self, item: dict[str, Any], rec: Any) -> None:
        if rec.head_sha != item.get("since"):
            if rec.head_sha:  # (pushed to since: brought up to date and checked again)
                self._set(item, "queued", "")
            return
        if rec.checks == "failed":
            await self._pr_back(item, rec, "checks", [])
            return
        if time.time() - float(item.get("at") or 0) > CHECKS_WAIT:
            self._set(item, "owner", "Its checks didn't finish in 3 hours; over to you.")
            return
        ready = rec.checks == "passed" or (
            rec.checks == "none" and rec.mergeable in ("clean", "has_hooks")
        )
        if not ready or rec.mergeable in ("dirty", "behind"):
            self.prs.poke(rec.key, after=30.0)
            return
        self._set(item, "working", "Landing…")
        said = await self.prs.merge(rec)
        if said:
            self._set(item, "owner", said)
            return
        self._finish(item, self.tr("Merged into {base}.", base=rec.base))

    async def _pr_back(self, item: dict[str, Any], rec: Any, why: str, files: list[str]) -> None:
        to_owner = (
            self.hub.prefs.feature(PREF_CONFLICTS) == "owner"
            or rec.issue
            or self._outside(rec.folder)
            or self.prs.task_for(rec) is None
            and not rec.session_id
        )
        item["conflicts"], item["since"] = files[:50], rec.head_sha
        if why == "conflict":
            note = self.tr("Conflicts with {into} in {files}; " + ("over to you." if to_owner else "sent to its session."),
                           into=rec.base, files=_names(files))  # fmt: skip
        else:
            note = "Its checks failed; " + ("over to you." if to_owner else "sent to its session.")
        if to_owner:
            self._set(item, "owner", note)
            return
        if why == "conflict":
            said = await self.prs.resolve(rec, manual=True)
        else:
            # Failing checks are code_pr's to send (its follow-up, within its caps and its
            # FIX_ATTEMPTS a pull request): the queue waits while it does, and hands it to
            # the owner when that's off or used up.
            said = (
                ""
                if rec.autofix and rec.fix_attempts < FIX_ATTEMPTS
                else "Its checks failed; over to you."
            )
        if said:
            self._set(item, "owner", said)
            return
        self._set(item, "fixing", note)

    # ── window commands ──

    def _reply(self, coro: Any) -> None:
        async def run() -> None:
            self.caption(await coro)

        self.hub._spawn(run())

    def cmd_state(self, _msg: dict[str, Any]) -> None:
        self.publish()

    def cmd_add(self, msg: dict[str, Any]) -> None:
        kind = str(msg.get("kind") or "")
        ref = str(msg.get("slug") if kind == "copy" else msg.get("key") or "")[:200]
        if kind in ("copy", "pr") and ref:
            self._reply(self.add(kind, ref))

    def cmd_item(self, msg: dict[str, Any]) -> None:
        action = str(msg.get("action") or "")
        if action in ("up", "down", "remove", "pause", "resume", "retry", "override"):
            self.caption(self.act(str(msg.get("id") or "")[:20], action))

    def cmd_project(self, msg: dict[str, Any]) -> None:
        repo = str(msg.get("repo") or "")[:1000]
        if repo:
            self.pause_project(repo, msg.get("paused") is True)


def install(hub: Any) -> None:
    queue = MergeQueue(hub)
    hub.code_mq = queue  # (for the other features and the tests)
    desk = getattr(hub, "code_desk", None)
    if desk is not None:
        desk.on_copy_gone.append(queue.copy_gone)
    hub.register_command("code_mq", queue.cmd_state)
    hub.register_command("code_mq_add", queue.cmd_add)
    hub.register_command("code_mq_item", queue.cmd_item)
    hub.register_command("code_mq_project", queue.cmd_project)
    hub.register_loop("code_merge_queue", queue.loop)
