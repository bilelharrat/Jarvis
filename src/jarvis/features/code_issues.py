"""Jarvis Code: GitHub issues labelled for Jarvis start sessions of their own.

The owner opts a repository in (Jarvis Code settings › GitHub): which project folder is its
checkout, the label that means "Jarvis, take this" (jarvis unless they say otherwise), the
commands its sessions may run, and a spending cap. Opting in asks first, on a card with
that whole scope: from then on, each time someone who can label issues there labels one
with it, a session starts on it (features/code_unattended.py: a run without the owner, in
an isolated copy). The issue's text is anyone's to write, so it goes to the session marked
as data, and that session runs with less than an ordinary one: without the owner's own
Claude Code settings and hooks, without any MCP server (JARVIS's browser, simulator and
sessions tools, connectors, the project's own), without web tools, and (unless the owner
turns it off for the repository) with its commands in Claude Code's sandbox, without
network access. When it's done, its pull request is drafted and waits in the PR pane for
the owner's OK: nothing is pushed or opened before that.

Only issues labelled after the repository was opted in count, each labelling once (the
repository's issue events: a label taken off and put back on starts it again). A loop
reads them every five minutes (with an ETag: an unchanged answer is free).

Sentry and Linear aren't triggers: their connectors are MCP servers whose tools, arguments
and answers are the servers' own to change and are written for a model to read, so
nothing here could rely on them to say, reliably, that a new issue is there.

Window commands: code_issues {}, code_issue_detect {project}, code_issue_add {project,
label, commands, spend_cap, sandbox}, code_issue_remove {repo}.
Events: code_issues {repos, connected}, code_issue_repo {project, repo, note}.
Settings (prefs.features): code_issue_repos (the repositories opted in).
Loop: code_issue_watch.

Cost policy: each labelled issue starts one session run without the owner (the model the
project's sessions use), capped at the repository's spending cap (default $5) and an
hour; at most ISSUE_RUNS_A_DAY (5) a day across repositories. Reading GitHub calls no
model.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
from datetime import datetime
from typing import Any

from .. import code_ai, code_prs, github, jsonstore, lang, prefs
from ..proactive import Alert
from .code_unattended import Scope

log = logging.getLogger("jarvis")

PREF = "code_issue_repos"
ISSUE_RUNS_A_DAY = 5
POLL_EVERY = 300.0
POLL_FIRST = 45.0
SEEN_KEPT = 400
REPOS_MAX = 20
LABEL = re.compile(r"^[^\x00-\x1f,]{1,50}$")

ZH = {
    "GitHub issues": "GitHub 议题",
    "Start a session for each issue labelled “{label}” in {repo}?": "要为 {repo} 里每个贴上“{label}”标签的议题开一个会话吗？",
    "Whoever can label issues in {repo} can then start one. Each runs without you, in an isolated copy of {project}: edits there go ahead, and it may run {commands}, the read-only commands and the project's own “don't ask again” rules; nothing else.": "这样一来，能在 {repo} 里给议题贴标签的人都能启动一个会话。每个会话都在 {project} 的独立副本里无人值守地运行：那里的修改会直接进行，它可以运行 {commands}、只读命令和项目自己的“不再询问”规则；其他都不行。",
    "Whoever can label issues in {repo} can then start one. Each runs without you, in an isolated copy of {project}: edits there go ahead, and it may run the read-only commands and the project's own “don't ask again” rules; nothing else.": "这样一来，能在 {repo} 里给议题贴标签的人都能启动一个会话。每个会话都在 {project} 的独立副本里无人值守地运行：那里的修改会直接进行，它可以运行只读命令和项目自己的“不再询问”规则；其他都不行。",
    "The issue's text is data: the session gets no web, browser or connector tools, none of your own settings, and its commands run without network access.": "议题的内容只当作数据：会话拿不到网页、浏览器或连接器工具，也拿不到你自己的设置，它的命令在没有网络的环境里运行。",
    "The issue's text is data: the session gets no web, browser or connector tools and none of your own settings. Its commands can reach the network, and they run code it may have changed.": "议题的内容只当作数据：会话拿不到网页、浏览器或连接器工具，也拿不到你自己的设置。它的命令可以联网，而且运行的代码可能被它改过。",
    "Each stops at ${spend} or after an hour; at most {n} a day. When one is done, its pull request waits for your OK.": "每个会话花费达到 ${spend} 或运行一小时后停下；每天最多 {n} 个。完成后，它的拉取请求会等你确认。",
    "Opt it in": "开启",
    "Not now": "暂不",
    "Not opted in.": "没有开启。",
    "Issues labelled “{label}” in {repo} now start a session.": "{repo} 里贴上“{label}”标签的议题现在会开启一个会话。",
    "{repo} is off the list: its issues start nothing now.": "{repo} 已移出列表：它的议题不会再开启会话。",
    "{project} isn't a folder Jarvis Code knows.": "{project} 不是 Jarvis Code 认识的文件夹。",
    "A label is up to 50 characters, without commas.": "标签最多 50 个字符，不能有逗号。",
    "{repo} is already on the list.": "{repo} 已经在列表里了。",
    "At most {n} repositories.": "最多 {n} 个仓库。",
    "Started a session on issue #{n} in {repo}.": "已为 {repo} 的议题 #{n} 开了一个会话。",
    "Issue #{n} in {repo} didn't start a session: {why}": "{repo} 的议题 #{n} 没能开启会话：{why}",
    "That's today's {n} sessions from GitHub issues; the rest wait until tomorrow.": "今天已经由 GitHub 议题开启了 {n} 个会话；其余的要等到明天。",
    "Issue #{n}: {title}": "议题 #{n}：{title}",
}
lang.add_texts(ZH)


def _repos(value: Any) -> list[dict[str, Any]] | None:
    """The repositories opted in, each checked (a setting's value)."""
    if not isinstance(value, list):
        return None
    kept: list[dict[str, Any]] = []
    for item in value[:REPOS_MAX]:
        if not isinstance(item, dict):
            continue
        repo, project = item.get("repo"), item.get("project")
        label = item.get("label") or "jarvis"
        if not (isinstance(repo, str) and re.fullmatch(r"[\w.-]+/[\w.-]+", repo)):
            continue
        if not (isinstance(project, str) and 0 < len(project) <= 500):
            continue
        if not (isinstance(label, str) and LABEL.match(label)):
            continue
        commands = item.get("commands") if isinstance(item.get("commands"), list) else []
        try:
            spend = min(50.0, max(0.5, float(item.get("spend_cap") or 5.0)))
            since = float(item.get("since") or 0.0)
        except (TypeError, ValueError):
            continue
        kept.append(
            {
                "repo": repo,
                "project": project,
                "label": label,
                "commands": [c for c in commands if isinstance(c, str)][:20],
                "spend_cap": spend,
                "sandbox": item.get("sandbox") is not False,
                "since": since,
            }
        )
    return kept


prefs.register_feature_pref(PREF, [], _repos)


def _when(stamp: Any) -> float:
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


class Issues:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._seen: dict[str, list[int]] | None = None
        self._caps: code_ai.Budget | None = None
        self._told_cap = ""

    # ── plumbing ──

    @property
    def client(self) -> github.Client:
        return self.hub.code_pr.client  # the one GitHub client the features share

    def repos(self) -> list[dict[str, Any]]:
        return _repos(self.hub.prefs.feature(PREF)) or []

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    def caption(self, text: str) -> None:
        if text:
            self.hub.emit("caption", text=self.tr(text))

    def notify(self, key: str, text: str, note: str) -> None:
        self.hub.notify(Alert(key, "task", self.tr("GitHub issues"), self.tr(text), note=note))

    @property
    def caps(self) -> code_ai.Budget:
        if self._caps is None:
            self._caps = code_ai.Budget(
                self.hub.feature_path("code_issue_runs.json"), {"issue": ISSUE_RUNS_A_DAY}
            )
        return self._caps

    def seen(self) -> dict[str, list[int]]:
        if self._seen is None:
            try:
                data = jsonstore.load_json(self.hub.feature_path("code_issues.json"), dict) or {}
            except jsonstore.Unreadable:
                data = {}
            raw = data.get("seen") if isinstance(data.get("seen"), dict) else {}
            self._seen = {
                k: [i for i in v if type(i) is int][-SEEN_KEPT:]
                for k, v in raw.items()
                if isinstance(k, str) and isinstance(v, list)
            }
        return self._seen

    def save(self) -> None:
        with contextlib.suppress(OSError):
            jsonstore.save_json(self.hub.feature_path("code_issues.json"), {"seen": self.seen()})

    async def publish(self) -> None:
        connected = await self.client.connected()
        self.hub.emit("code_issues", repos=self.repos(), connected=connected)

    # ── opting a repository in ──

    async def detect(self, project: str) -> None:
        """Which GitHub repository a project folder is, for the form."""
        note, full = "", ""
        try:
            folder = self.hub.tasks.resolve_dir(project)
        except (ValueError, OSError):
            folder = None
            note = self.tr(f"{project} isn't a folder Jarvis Code knows.")
        if folder is not None:
            remote, ref = await asyncio.to_thread(github.repo_for, folder)
            if ref is None:
                note = self.tr(
                    "There's no remote to push to."
                    if not remote
                    else "This project's remote isn't a github.com repository."
                )
            else:
                full = ref.full
        self.hub.emit("code_issue_repo", project=project, repo=full, note=note)

    async def add(self, msg: dict[str, Any]) -> str:
        project = str(msg.get("project") or "").strip()[:500]
        label = " ".join(str(msg.get("label") or "jarvis").split())
        if not LABEL.match(label):
            return "A label is up to 50 characters, without commas."
        try:
            folder = self.hub.tasks.resolve_dir(project)
        except (ValueError, OSError):
            return f"{project} isn't a folder Jarvis Code knows."
        remote, ref = await asyncio.to_thread(github.repo_for, folder)
        if ref is None:
            return (
                "There's no remote to push to."
                if not remote
                else "This project's remote isn't a github.com repository."
            )
        listed = self.repos()
        if any(r["repo"] == ref.full for r in listed):
            return f"{ref.full} is already on the list."
        if len(listed) >= REPOS_MAX:
            return f"At most {REPOS_MAX} repositories."
        runs = self.hub.code_runs
        scope = runs.scope_from(
            {
                "prompt": "(an issue)",
                "project": project,
                "commands": msg.get("commands") or [],
                "spend_cap": msg.get("spend_cap") or 5.0,
                "hours": 1.0,
            }
        )
        if isinstance(scope, str):
            return scope
        sandbox = msg.get("sandbox") is not False
        commands = ", ".join(scope.commands)
        lines = [
            (
                f"Whoever can label issues in {ref.full} can then start one. Each runs without "
                f"you, in an isolated copy of {folder.name}: edits there go ahead, and it may "
                f"run {commands}, the read-only commands and the project's own “don't ask "
                "again” rules; nothing else."
                if commands
                else f"Whoever can label issues in {ref.full} can then start one. Each runs "
                f"without you, in an isolated copy of {folder.name}: edits there go ahead, and "
                "it may run the read-only commands and the project's own “don't ask again” "
                "rules; nothing else."
            ),
            (
                "The issue's text is data: the session gets no web, browser or connector tools, "
                "none of your own settings, and its commands run without network access."
                if sandbox
                else "The issue's text is data: the session gets no web, browser or connector "
                "tools and none of your own settings. Its commands can reach the network, and "
                "they run code it may have changed."
            ),
            f"Each stops at ${scope.spend_cap:.2f} or after an hour; at most "
            f"{ISSUE_RUNS_A_DAY} a day. When one is done, its pull request waits for your OK.",
        ]
        question = f"Start a session for each issue labelled “{label}” in {ref.full}?"
        choice = await self.hub.request_approval(
            self.tr(question),
            self.tr("\n\n".join(lines)),
            [("add", self.tr("Opt it in")), ("deny", self.tr("Not now"))],
        )
        if choice != "add":
            return "Not opted in."
        entry = {
            "repo": ref.full,
            "project": project,
            "label": label,
            "commands": scope.commands,
            "spend_cap": scope.spend_cap,
            "sandbox": sandbox,
            "since": time.time(),
        }
        self.hub.set_feature_prefs({PREF: [*listed, entry]})
        await self.publish()
        return f"Issues labelled “{label}” in {ref.full} now start a session."

    async def remove(self, repo: str) -> str:
        listed = self.repos()
        kept = [r for r in listed if r["repo"] != repo]
        if len(kept) != len(listed):
            self.hub.set_feature_prefs({PREF: kept})
        await self.publish()
        return f"{repo} is off the list: its issues start nothing now."

    # ── watching ──

    async def watch(self) -> None:
        await asyncio.sleep(POLL_FIRST)
        while True:
            try:
                await self.tick()
            except Exception:
                log.exception("GitHub issues: a look at them failed")
            await asyncio.sleep(POLL_EVERY)

    async def tick(self) -> None:
        listed = self.repos()
        if not listed or self.client.low() or not await self.client.connected():
            return
        for entry in listed:
            try:
                await self.look(entry)
            except github.RateLimited:
                return
            except github.GitHubError as exc:
                log.info("GitHub issues: %s: %s", entry["repo"], exc)

    async def look(self, entry: dict[str, Any]) -> list[int]:
        """Issues newly labelled in one repository: a run started for each. The numbers."""
        owner, _, name = entry["repo"].partition("/")
        ref = github.RepoRef(owner, name)
        events = await self.client.issue_events(ref)
        seen = self.seen().setdefault(entry["repo"], [])
        fresh = []
        for event in reversed(events):  # oldest first
            if not isinstance(event, dict) or event.get("event") != "labeled":
                continue
            event_id = event.get("id")
            label = str((event.get("label") or {}).get("name") or "")
            if type(event_id) is not int or event_id in seen:
                continue
            if label.lower() != entry["label"].lower():
                continue
            if _when(event.get("created_at")) < entry["since"]:
                continue
            issue = event.get("issue") if isinstance(event.get("issue"), dict) else {}
            if issue.get("pull_request") or issue.get("state") == "closed":
                seen.append(event_id)
                continue
            fresh.append((event_id, int(issue.get("number") or 0), event))
        started: list[int] = []
        try:  # (what's seen is kept even when a rate limit stops the look)
            for event_id, number, event in fresh:
                if not number:
                    seen.append(event_id)
                    continue
                if not self.caps.left("issue"):
                    self._capped()
                    break  # not seen: tomorrow's look starts them
                try:
                    issue = await self.client.issue(ref, number)
                except github.RateLimited:
                    raise  # not seen: the next look reads it
                except github.GitHubError:
                    issue = event.get("issue") or {}  # as the event had it
                if issue.get("state") == "closed" or issue.get("pull_request"):
                    seen.append(event_id)
                    continue
                try:
                    self.caps.take("issue")
                except code_ai.OverBudget:
                    self._capped()
                    break
                seen.append(event_id)
                labeller = str((event.get("actor") or {}).get("login") or "")
                said = self.start(entry, issue, labeller)
                if not said:
                    started.append(number)
        finally:
            del seen[:-SEEN_KEPT]
            self.save()
        return started

    def _capped(self) -> None:
        """Today's sessions from issues are all started: said once a day."""
        marker = self.caps.day
        if self._told_cap != marker:
            self._told_cap = marker
            self.notify(
                f"issue-cap:{marker}",
                f"That's today's {ISSUE_RUNS_A_DAY} sessions from GitHub issues; the rest wait "
                "until tomorrow.",
                "GitHub issues are waiting for tomorrow's sessions",
            )

    def start(self, entry: dict[str, Any], issue: dict[str, Any], labeller: str) -> str:
        number = int(issue.get("number") or 0)
        title = " ".join(str(issue.get("title") or "").split())
        scope = Scope(
            prompt=code_prs.issue_prompt(entry["repo"], issue, entry["label"], labeller),
            project=entry["project"],
            title=lang.tr("Issue #{n}: {title}", self.hub.language, n=number, title=title)[:80],
            mode="edits",
            commands=list(entry["commands"]),
            spend_cap=entry["spend_cap"],
            hours=1.0,
        )
        run = self.hub.code_runs.start(
            scope,
            origin="issue",
            issue={
                "repo": entry["repo"],
                "number": number,
                "url": str(issue.get("html_url") or ""),
            },
            untrusted=True,
            sandbox=entry["sandbox"],
        )
        repo = entry["repo"]
        if isinstance(run, str):
            self.notify(
                f"issue:{repo}#{number}",
                f"Issue #{number} in {repo} didn't start a session: {run}",
                "a GitHub issue couldn't start a Jarvis Code session",
            )
            return run
        self.notify(
            f"issue:{repo}#{number}",
            f"Started a session on issue #{number} in {repo}.",
            "a GitHub issue started a Jarvis Code session (its text is on GitHub)",
        )
        return ""

    # ── window commands ──

    def _reply(self, coro: Any) -> None:
        async def run() -> None:
            self.caption(await coro)

        self.hub._spawn(run())

    def cmd_state(self, _msg: dict[str, Any]) -> None:
        self.hub._spawn(self.publish())

    def cmd_detect(self, msg: dict[str, Any]) -> None:
        self.hub._spawn(self.detect(str(msg.get("project") or "")[:500]))

    def cmd_add(self, msg: dict[str, Any]) -> None:
        self._reply(self.add(msg))

    def cmd_remove(self, msg: dict[str, Any]) -> None:
        self._reply(self.remove(str(msg.get("repo") or "")[:200]))


def install(hub: Any) -> None:
    issues = Issues(hub)
    hub.code_issues = issues  # (for the tests)
    hub.register_command("code_issues", issues.cmd_state)
    hub.register_command("code_issue_detect", issues.cmd_detect)
    hub.register_command("code_issue_add", issues.cmd_add)
    hub.register_command("code_issue_remove", issues.cmd_remove)
    hub.register_loop("code_issue_watch", issues.watch)
