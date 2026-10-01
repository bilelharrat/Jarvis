"""Jarvis Code: hand a session off to another machine the owner controls, over SSH (handoff.py).

Machines (Jarvis Code settings › Machines) are hosts in the owner's ~/.ssh/config, added by
their alias. Adding or testing one checks `ssh -o BatchMode=yes <alias> true`, then that git
and the Claude Code CLI are there (and whether the CLI can ask for permission over
stream-json, and whether tmux is). JARVIS keeps only the alias: the owner's own SSH config
and agent get it in, and no key is ever stored or asked for.

Continue on… (a session's More menu, or by voice) hands off a session that runs in an
isolated copy, always after a card that says what leaves the Mac: its uncommitted work is
committed (a secret scan first: a finding is on the card), the branch is pushed to the
project's remote when the machine can fetch it from there, else sent as a git bundle over
SSH, and checked out under ~/.jarvis-handoff/<copy> there. Claude Code then runs there
(`claude -p`, stream-json both ways) under tmux, or nohup without it, starting from a
summary of the session (its transcript can't move). Its output streams back into the same
session view; the owner's messages, Interrupt and permission answers go to it. Permission
requests come back as cards (the CLI's --permission-prompt-tool stdio); a CLI that can't
ask runs in Accept edits, and Bypass never goes to another machine. A dropped connection
leaves it running: JARVIS reconnects (backing off) and reads on from the line it reached,
after a restart too; requests it hadn't answered are asked again.

Bring back (a card) stops it there, commits what it changed with the remote's own git
identity (else Jarvis Code's), and fetches the branch past the commit handed off into the
isolated copy as a git bundle over SSH, ready to land; the session's next message here
carries a note of what happened there. The checkout there stays.

Window commands: code_machines {}, code_machine_add {alias}, code_machine_test {alias},
code_machine_remove {alias}, code_handoff {id, alias, instructions?}, code_handoff_back
{id | handoff}, code_handoff_stop {id | handoff}, code_handoff_forget {handoff}.
Events: code_handoffs {machines, hosts, handoffs}.
Tool server: jarvis_code_handoff (continue_on_machine, bring_back_from_machine,
handoff_status).
Wrapped: TaskManager.send, interrupt and reconnect (a handed-off session's messages go to
its machine), and turn_note once a session is brought back.
Loop: code_handoff_watch (reattaches the hand-offs that were running at startup).

Cost policy: no model calls here, nothing JARVIS pays for. A run on another machine uses
that machine's own Claude sign-in and is billed there; JARVIS's spending limits can't meter
it (its card and its bar say so). The cost its Claude Code reports is shown, not counted.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
import re
import shlex
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import code_changes, github, handoff, jsonstore, lang, secret_scan, tasks, worktrees
from ..code_changes import git
from ..handoff import Handoff, Machine

log = logging.getLogger("jarvis")

SERVER = "jarvis_code_handoff"
PUSH_ENV = {"GIT_SSH_COMMAND": "ssh -o BatchMode=yes", "GIT_ASKPASS": "", "SSH_ASKPASS": ""}
PUSH_SECONDS = 300.0
BACK_REF = "refs/jarvis/handoff/"
WRITE_TRIES = 3
RETRY_MAX = 60.0  # seconds between reconnection attempts, at most
SAVE_EVERY = 20  # lines read between saves of where it got to
_CREDENTIALS = re.compile(r"^\w+://[^/@\s]+@")  # https://user:token@host: never sent on

ZH = {
    "Machines": "机器",
    "{alias} isn't a host in your SSH config (~/.ssh/config).": "{alias} 不在你的 SSH 配置（~/.ssh/config）里。",
    "{alias} is already on the list.": "{alias} 已经在列表里了。",
    "There are already {n} machines; remove one first.": "已经有 {n} 台机器了；请先删除一台。",
    "{alias} is ready.": "{alias} 已就绪。",
    "{alias} is in use by a session handed off there: bring it back first.": "{alias} 正被转过去的会话使用：请先把它带回来。",
    "Removed {alias}.": "已删除 {alias}。",
    "ssh isn't available on this Mac.": "这台 Mac 上没有 ssh。",
    "{alias} didn't answer in time.": "{alias} 没有及时响应。",
    "{alias} can't be found: check its HostName in your SSH config.": "找不到 {alias}：请检查 SSH 配置里的 HostName。",
    "{alias} refused the key: add it to your SSH agent (ssh-add) and try again.": "{alias} 拒绝了密钥：请把它加到 SSH agent（ssh-add）后再试。",
    "{alias}'s host key isn't known yet: connect to it once from Terminal to accept it.": "还不认识 {alias} 的主机密钥：请先在终端里连它一次并接受。",
    "{alias} isn't reachable right now.": "现在连不上 {alias}。",
    "Couldn't reach {alias}: {why}": "连不上 {alias}：{why}",
    "git isn't installed on {alias}.": "{alias} 上没有安装 git。",
    "Jarvis Code needs the Claude Code CLI on {alias}: install it there and sign in.": "Jarvis Code 需要 {alias} 上有 Claude Code CLI：请在那里安装并登录。",
    "Only a session in an isolated copy can be handed off: start one with Isolated copy on.": "只有在独立副本里的会话才能转交：请打开“独立副本”再开始会话。",
    "That session's isolated copy isn't there any more.": "这个会话的独立副本已经不在了。",
    "It's in the middle of a step: wait for it, or interrupt it, then hand it off.": "它正在执行一步：等它做完或先中断，再转交。",
    "It's already on {alias}.": "它已经在 {alias} 上了。",
    "Add {alias} in Jarvis Code settings › Machines first.": "请先在 Jarvis Code 设置 › 机器 里添加 {alias}。",
    "Add a machine in Jarvis Code settings › Machines first.": "请先在 Jarvis Code 设置 › 机器 里添加一台机器。",
    "It's already being handed off.": "它正在转交中。",
    "The isolated copy's folder is missing.": "独立副本的文件夹不见了。",
    "The isolated copy isn't on its branch {branch} any more.": "独立副本已经不在它的分支 {branch} 上了。",
    "Continue this session on {alias}?": "要在 {alias} 上继续这个会话吗？",
    "Its {n} uncommitted files are committed first, on {branch}.": "先把它未提交的 {n} 个文件提交到 {branch}。",
    "{branch} goes to {alias}: pushed to {url} if that machine can fetch from there, else sent over SSH.": "{branch} 会发到 {alias}：如果那台机器能从 {url} 拉取就推送到那里，否则通过 SSH 发送。",
    "{branch} goes to {alias} over SSH, with the project's history.": "{branch} 会连同项目的历史一起通过 SSH 发到 {alias}。",
    "Claude Code runs there in {mode}, in ~/.jarvis-handoff, and keeps running if the connection drops.": "Claude Code 会在那里以“{mode}”模式运行，位置在 ~/.jarvis-handoff，连接断了也会继续运行。",
    "Its permission requests come back here as cards.": "它的权限请求会以卡片的形式回到这里。",
    "Claude Code there can't ask you from this Mac, so it runs in Accept edits: edits in its checkout go ahead, anything else that needs permission is refused.": "那里的 Claude Code 没法从这台 Mac 问你，所以会以“自动接受编辑”模式运行：它检出目录里的修改会直接进行，其他需要权限的操作一律拒绝。",
    "Bypass permissions never goes to another machine: there it runs in Manual, and each step asks you here.": "“绕过权限”不会带到别的机器：在那里会以“手动”模式运行，每一步都会在这里问你。",
    "Auto mode stays on this Mac: there it runs in Manual, and each step asks you here.": "“自动”模式只留在这台 Mac：在那里会以“手动”模式运行，每一步都会在这里问你。",
    "It starts from a summary of this session: the transcript itself can't move.": "它会从这个会话的摘要开始：对话记录本身没法搬过去。",
    "Cost: runs on {alias} use that machine's own Claude sign-in and are billed there. JARVIS's spending limits can't meter them.": "费用：在 {alias} 上的运行用的是那台机器自己的 Claude 登录，费用记在那里。JARVIS 的花费上限管不到它们。",
    "Possible secrets in what it would send:": "要发送的内容里可能有密钥：",
    "Continue on {alias}": "在 {alias} 上继续",
    "Continue anyway": "仍然继续",
    "Not now": "暂不",
    "Not handed off.": "没有转交。",
    "Handing off to {alias}…": "正在转交到 {alias}…",
    "Couldn't commit its work: {why}": "没能提交它的改动：{why}",
    "Couldn't make the bundle: {why}": "没能打包：{why}",
    "Couldn't send the branch to {alias}: {why}": "没能把分支发到 {alias}：{why}",
    "The checkout on {alias} has uncommitted work from an earlier hand-off: bring that back or clean it up there first.": "{alias} 上的检出目录里还有之前转交留下的未提交改动：请先把它带回来，或在那里清理掉。",
    "Couldn't set up the checkout on {alias}: {why}": "没能在 {alias} 上准备检出目录：{why}",
    "Couldn't start Claude Code on {alias}: {why}": "没能在 {alias} 上启动 Claude Code：{why}",
    "Handed off to {alias}: it carries on there, and its permission requests come here.": "已转交到 {alias}：它会在那里继续，权限请求会来到这里。",
    "Handed off to {alias}: it carries on there in Accept edits.": "已转交到 {alias}：它会在那里以“自动接受编辑”模式继续。",
    "Continued on {alias}, on {branch} ({how}). Runs there use that machine's own Claude sign-in: JARVIS's spending limits can't meter them.": "已在 {alias} 上继续，分支 {branch}（{how}）。在那里的运行用的是那台机器自己的 Claude 登录：JARVIS 的花费上限管不到它们。",
    "pushed to the project's remote": "推送到项目的远程仓库",
    "sent over SSH": "通过 SSH 发送",
    "Lost the connection to {alias}. It keeps running there; reconnecting…": "和 {alias} 的连接断了。它在那里继续运行；正在重新连接…",
    "Reconnected to {alias}.": "已重新连上 {alias}。",
    "Claude Code on {alias} ended (exit {code}).": "{alias} 上的 Claude Code 结束了（退出码 {code}）。",
    "Claude Code on {alias} isn't running any more.": "{alias} 上的 Claude Code 已经不在运行了。",
    "Its folder on {alias} is gone.": "它在 {alias} 上的文件夹不见了。",
    "Pictures don't go to {alias}; only the words were sent.": "图片不会发到 {alias}；只发了文字。",
    "Couldn't reach {alias}: the message wasn't sent. Try again when it's back.": "连不上 {alias}：消息没有发出去。等它恢复后再试。",
    "{alias} isn't on your machines any more: bring the session back, or add it again.": "{alias} 已经不在你的机器列表里了：请把会话带回来，或重新添加它。",
    "Allow this step on {alias}?": "允许在 {alias} 上执行这一步吗？",
    "Approve the plan on {alias}?": "批准在 {alias} 上的计划吗？",
    "Allow": "允许",
    "Deny": "拒绝",
    "Approve": "批准",
    "Keep planning": "继续规划",
    "Bring {branch} back from {alias}?": "要把 {branch} 从 {alias} 带回来吗？",
    "This stops Claude Code on {alias}, commits what it changed there, and brings the branch into this Mac's isolated copy, ready to land. The checkout there stays.": "这会停止 {alias} 上的 Claude Code，提交它在那里的改动，并把分支带回这台 Mac 的独立副本，随时可以合并。那里的检出目录会保留。",
    "Bring it back": "带回来",
    "Not brought back.": "没有带回来。",
    "That session isn't on another machine.": "这个会话不在别的机器上。",
    "The isolated copy it came from isn't on this Mac any more.": "它原来的独立副本已经不在这台 Mac 上了。",
    "On {alias} it isn't on {branch} any more: switch back there, then bring it back.": "在 {alias} 上它已经不在 {branch} 上了：请先切回去，再带回来。",
    "Couldn't bring it back: {why}": "没能带回来：{why}",
    "Brought back from {alias}: nothing new there.": "已从 {alias} 带回：那里没有新的改动。",
    "Brought back from {alias}: {n} commit in its isolated copy, ready to land.": "已从 {alias} 带回：独立副本里有 {n} 个提交，随时可以合并。",
    "Brought back from {alias}: {n} commits in its isolated copy, ready to land.": "已从 {alias} 带回：独立副本里有 {n} 个提交，随时可以合并。",
    "Brought back as {ref}: the copy changed meanwhile, so merge it there yourself.": "已带回为 {ref}：副本在这期间有变化，请自己在那里合并。",
    "Back from {alias}": "已从 {alias} 带回",
    "Stopped on {alias}. Send a message to carry on there, or bring it back.": "已在 {alias} 上停止。发一条消息可以在那里继续，或者把它带回来。",
    "Stopped it on {alias}.": "已在 {alias} 上停止。",
    "It isn't running on {alias}.": "它没有在 {alias} 上运行。",
    "Forgot it; the checkout on {alias} stays.": "已忘掉；{alias} 上的检出目录会保留。",
    "Bring it back or stop it first.": "请先把它带回来或停止它。",
    "Working on {alias}": "正在 {alias} 上工作",
    "Waiting for you on {alias}": "在 {alias} 上等你",
    "Ended on {alias}": "已在 {alias} 上结束",
    "Say which machine: {names}.": "请说是哪台机器：{names}。",
    "There's no Jarvis Code session to hand off.": "没有可以转交的 Jarvis Code 会话。",
    "No machines yet.": "还没有机器。",
    "Questions can't come to the Mac from there: ask the owner in your reply instead, then wait.": "问题没法从那里传回 Mac：请在你的回复里问主人，然后等待。",
}
lang.add_texts(ZH)

PROMPT = (
    "Jarvis Code sessions can move to another machine the user controls over SSH: "
    "continue_on_machine hands a session (in an isolated copy) off to a machine they added in "
    "Jarvis Code settings › Machines, after a card; bring_back_from_machine brings its branch "
    "back to the Mac; handoff_status lists the machines and what runs on them."
)


class Desk:
    """One hub's machines and hand-offs."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.ssh = handoff.ssh_binary()
        self.ssh_config = Path("~/.ssh/config").expanduser()
        self.machines: list[Machine] = []
        self.handoffs: list[Handoff] = []
        self._loaded = False
        self._followers: dict[str, asyncio.Task] = {}
        self._asks: dict[str, dict[str, asyncio.Task]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._lost: set[str] = set()
        self._notes: dict[int, str] = {}  # session -> a note for its next message
        self._busy: set[str] = set()
        self._interrupts = itertools.count(1)
        self.booted = time.time()

    # ── the kept list ──

    @property
    def path(self) -> Path:
        return self.hub.feature_path("code_handoff.json")

    def load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            data = jsonstore.load_json(self.path, dict) or {}
        except jsonstore.Unreadable:
            data = {}
        for raw in data.get("machines") or []:
            machine = handoff.from_raw(Machine, raw)
            if machine is not None and handoff.ALIAS.match(str(machine.alias)):
                self.machines.append(machine)
        for raw in data.get("handoffs") or []:
            rec = handoff.from_raw(Handoff, raw)
            if rec is not None and handoff.ALIAS.match(str(rec.alias)) and rec.id:
                rec.pending = [p for p in rec.pending if isinstance(p, dict)]
                self.handoffs.append(rec)

    def save(self) -> None:
        self.load()
        with contextlib.suppress(OSError):
            jsonstore.save_json(
                self.path,
                {
                    "machines": [asdict(m) for m in self.machines],
                    "handoffs": [asdict(r) for r in self.handoffs],
                },
            )

    def machine(self, alias: str) -> Machine | None:
        self.load()
        return next((m for m in self.machines if m.alias == alias), None)

    def config_hosts(self) -> list[str]:
        return handoff.config_hosts(self.ssh_config)

    # ── words ──

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    def caption(self, text: str) -> None:
        if text:
            self.hub.emit("caption", text=self.tr(text))

    def note(self, task: Any, text: str) -> None:
        if task is not None:
            self.hub.tasks._log(task, "system", self.tr(text))

    # ── which session is which ──

    def task_of(self, rec: Handoff) -> Any:
        tm = self.hub.tasks
        task = tm.tasks.get(rec.task_id) if rec.started >= self.booted else None
        if task is not None and task.kind == "code" and task.session_id == rec.session_id:
            return task
        if rec.session_id:
            task = tm._by_session(rec.session_id)
            if task is not None:
                rec.task_id = task.id
                return task
        return None

    def of_task(self, task: Any) -> Handoff | None:
        if task is None:
            return None
        self.load()
        return next((r for r in self.handoffs if self.task_of(r) is task), None)

    def publish(self) -> None:
        self.load()
        added = {m.alias for m in self.machines}
        items = []
        for rec in self.handoffs:
            task = self.task_of(rec)
            items.append(
                rec.public() | {"task_id": task.id if task else 0, "lost": rec.id in self._lost}
            )
        self.hub.emit(
            "code_handoffs",
            machines=[m.public() for m in self.machines],
            hosts=[h for h in self.config_hosts() if h not in added][:100],
            handoffs=items,
        )

    def lock(self, key: str) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())

    # ── machines ──

    async def add_machine(self, alias: str) -> str:
        self.load()
        alias = str(alias or "").strip()
        if not handoff.ALIAS.match(alias) or alias not in self.config_hosts():
            return f"{alias} isn't a host in your SSH config (~/.ssh/config)."
        if self.machine(alias) is not None:
            return f"{alias} is already on the list."
        if len(self.machines) >= handoff.MACHINES_MAX:
            return f"There are already {len(self.machines)} machines; remove one first."
        self.machines.append(Machine(alias=alias, added=time.time()))
        self.save()
        self.publish()
        return await self.test_machine(alias)

    async def test_machine(self, alias: str) -> str:
        machine = self.machine(alias)
        if machine is None:
            return f"Add {alias} in Jarvis Code settings › Machines first."
        await handoff.check(self.ssh, machine)
        self.save()
        self.publish()
        return machine.problem or f"{alias} is ready."

    def remove_machine(self, alias: str) -> str:
        machine = self.machine(alias)
        if machine is None:
            return ""
        if any(r.alias == alias and r.live for r in self.handoffs):
            return f"{alias} is in use by a session handed off there: bring it back first."
        self.machines.remove(machine)
        self.save()
        self.publish()
        return f"Removed {alias}."

    # ── handing off ──

    async def hand_off(
        self, task: Any, alias: str, instructions: str = "", by_voice: bool = False
    ) -> str:
        self.load()
        if task is None or task.kind != "code":
            return "There's no Jarvis Code session to hand off."
        current = self.of_task(task)
        if current is not None and current.live:
            return f"It's already on {current.alias}."
        machine = self.machine(alias)
        if machine is None:
            return f"Add {alias} in Jarvis Code settings › Machines first."
        if task.busy:
            return "It's in the middle of a step: wait for it, or interrupt it, then hand it off."
        slug = (task.workspace or {}).get("slug", "")
        if not slug:
            return "Only a session in an isolated copy can be handed off: start one with Isolated copy on."
        desk = getattr(self.hub, "code_desk", None)
        copy = desk.store().find(slug) if desk is not None else None
        if copy is None:
            return "That session's isolated copy isn't there any more."
        if slug in self._busy:
            return "It's already being handed off."
        await handoff.check(self.ssh, machine)
        self.save()
        self.publish()
        if not machine.ok:
            return machine.problem
        plan = await asyncio.to_thread(self._plan, copy)
        if isinstance(plan, str):
            return plan
        mode, mode_note = handoff.remote_mode(task.mode, machine.permissions)
        question, detail, choices = self._card(task, copy, machine, plan, mode, mode_note)
        question, detail = self.tr(question), self.tr(detail)
        if by_voice:
            self.hub._say(question)
        choice = await self.hub.request_approval(
            question,
            detail,
            [(c, self.tr(label)) for c, label in choices],
            context={"task_id": task.id, "tool": "handoff"},
        )
        if choice != "go":
            return "Not handed off."
        self._busy.add(slug)
        try:
            return await self._hand_off_now(task, copy, machine, plan, mode, instructions)
        finally:
            self._busy.discard(slug)

    def _plan(self, copy: worktrees.Copy) -> dict[str, Any] | str:
        """What would leave the Mac: the copy's uncommitted files, its commits since it was
        made, anything in them that looks like a secret, and the project's remote."""
        checkout = Path(copy.checkout)
        repo = code_changes.repo_of(checkout)
        if repo is None:
            return "The isolated copy's folder is missing."
        branch = git(repo.top, "symbolic-ref", "-q", "--short", "HEAD").out.strip()
        if branch != copy.branch:
            return f"The isolated copy isn't on its branch {copy.branch} any more."
        status = git(repo.top, "status", "--porcelain", "-z", "--untracked-files=all")
        dirty = len(worktrees.status_entries(status.out)) if status.ok else 0
        listed = git(repo.top, "log", "--format=%h %s", "--max-count=50", f"{copy.base}..HEAD")
        commits = [line[:120] for line in listed.out.splitlines() if line.strip()]
        head = code_changes.head_commit(repo.top) or code_changes.EMPTY_TREE
        files = list(code_changes.diff_files(repo, head))
        patch = git(
            repo.top, "log", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-textconv",
            "--format=", "--max-count=200", f"{copy.base}..HEAD", timeout=60,
        )  # fmt: skip
        files += code_changes.parse_patch(patch.out)
        findings = secret_scan.scan(files, repo.shown)
        remote, url = github.remote_for(checkout)
        if url and _CREDENTIALS.match(url):
            remote, url = "", ""  # an address with a password in it never goes to another machine
        return {
            "dirty": dirty,
            "commits": commits,
            "findings": findings,
            "remote": remote,
            "url": url,
        }

    def _card(
        self,
        task: Any,
        copy: worktrees.Copy,
        machine: Machine,
        plan: dict[str, Any],
        mode: str,
        mode_note: str,
    ) -> tuple[str, str, list[tuple[str, str]]]:
        alias, branch = machine.alias, copy.branch
        lines: list[str] = []
        if plan["dirty"]:
            lines.append(f"Its {plan['dirty']} uncommitted files are committed first, on {branch}.")
        if plan["url"]:
            url = re.sub(r"(\w+://)[^/@\s]+@", r"\1", plan["url"])
            lines.append(
                f"{branch} goes to {alias}: pushed to {url} if that machine can fetch from "
                "there, else sent over SSH."
            )
        else:
            lines.append(f"{branch} goes to {alias} over SSH, with the project's history.")
        lines.append(
            f"Claude Code runs there in {handoff.MODE_NAMES[mode]}, in ~/.jarvis-handoff, and "
            "keeps running if the connection drops."
        )
        lines.append(mode_note or "Its permission requests come back here as cards.")
        lines.append("It starts from a summary of this session: the transcript itself can't move.")
        lines += [
            "",
            f"Cost: runs on {alias} use that machine's own Claude sign-in and are billed there. "
            "JARVIS's spending limits can't meter them.",
        ]
        choices = [("go", f"Continue on {alias}"), ("deny", "Not now")]
        if plan["findings"]:
            lines += [
                "",
                "Possible secrets in what it would send:",
                secret_scan.summary(plan["findings"]),
            ]
            choices = [("go", "Continue anyway"), ("deny", "Not now")]
        return f"Continue this session on {alias}?", "\n".join(lines), choices

    async def _hand_off_now(
        self,
        task: Any,
        copy: worktrees.Copy,
        machine: Machine,
        plan: dict[str, Any],
        mode: str,
        instructions: str,
    ) -> str:
        alias = machine.alias
        tm = self.hub.tasks
        if task.handle is not None and not task.handle.done():  # its connection here closes
            tm.cancel(task.id)
            await asyncio.wait([task.handle], timeout=15)
        tm.tasks.setdefault(task.id, task)  # (an ended session may have been let go)
        task.status, task.last_action = "running", self.tr(f"Handing off to {alias}…")
        tm._changed()
        checkout = Path(copy.checkout)
        problem = await asyncio.to_thread(
            worktrees.commit_all, copy, f"Jarvis Code: hand off to {alias}"
        )
        if problem:
            return self._not_moved(task, f"Couldn't commit its work: {problem}")
        head = await asyncio.to_thread(code_changes.head_commit, checkout)
        rec = Handoff(
            id=re.sub(r"[^A-Za-z0-9-]", "-", copy.slug)[:60] or "session",
            alias=alias,
            slug=copy.slug,
            project=copy.project,
            branch=copy.branch,
            base=head,
            session_id=task.session_id,
            task_id=task.id,
            title=task.title or copy.title or task.prompt[:80],
            mode=mode,
            asks=machine.permissions,
            started=time.time(),
            model=task.model if task.model and not task.env and not task.provider_settings else "",
        )
        sent = await self._send_branch(rec, checkout, plan)
        if isinstance(sent, str):
            return self._not_moved(task, sent)
        source, url = sent
        setup = await handoff.run(
            self.ssh, alias, handoff.setup_script(rec, source, url), timeout=handoff.SETUP_SECONDS
        )
        if setup.code == 7:
            return self._not_moved(
                task,
                f"The checkout on {alias} has uncommitted work from an earlier hand-off: bring "
                "that back or clean it up there first.",
            )
        if not setup.ok or head not in setup.text:
            why = setup.err or setup.text.strip() or f"exit {setup.code}"
            return self._not_moved(task, f"Couldn't set up the checkout on {alias}: {why[-300:]}")
        commits = plan["commits"]
        first = handoff.summary(task, commits, alias, instructions)
        problem = await self._start(rec, machine, [handoff.init_line(), handoff.user_line(first)])
        if problem:
            return self._not_moved(task, problem)
        self.handoffs = [r for r in self.handoffs if r.id != rec.id] + [rec]
        self.save()
        how = "pushed to the project's remote" if rec.how == "push" else "sent over SSH"
        self.hub.tasks._log(
            task,
            "system",
            lang.tr(
                "Continued on {alias}, on {branch} ({how}). Runs there use that machine's own "
                "Claude sign-in: JARVIS's spending limits can't meter them.",
                self.hub.language,
                alias=alias,
                branch=rec.branch,
                how=self.tr(how),
            ),
        )
        mode_note = handoff.remote_mode(task.mode, rec.asks)[1]
        if mode_note:
            self.note(task, mode_note)
        task.busy, task.status = True, "running"
        task.last_action = self.tr(f"Working on {alias}")
        tm._changed()
        self._follow(rec)
        self.publish()
        if rec.asks:
            return f"Handed off to {alias}: it carries on there, and its permission requests come here."
        return f"Handed off to {alias}: it carries on there in Accept edits."

    def _not_moved(self, task: Any, why: str) -> str:
        """A hand-off that didn't happen: the session stays here, closed, to resume."""
        task.status, task.last_action, task.busy = "closed", "Closed", False
        self.note(task, why)
        self.hub.tasks._changed()
        return why

    async def _send_branch(
        self, rec: Handoff, checkout: Path, plan: dict[str, Any]
    ) -> tuple[str, str] | str:
        """The branch on its way there: pushed to the project's remote when the machine can
        fetch from it (a quick ls-remote there says), else as a bundle over SSH. The source
        its checkout fetches from, and the remote's address (for its origin)."""
        alias = rec.alias
        if plan["url"]:
            probe = await handoff.run(
                self.ssh,
                alias,
                "export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes'; "
                f"git ls-remote -q {shlex.quote(plan['url'])} >/dev/null 2>&1",
                timeout=60,
            )
            if probe.ok:
                pushed = await asyncio.to_thread(
                    git,
                    checkout,
                    "push",
                    "-q",
                    plan["remote"],
                    f"HEAD:refs/heads/{rec.branch}",
                    env=PUSH_ENV,
                    timeout=PUSH_SECONDS,
                )
                if pushed.ok:
                    rec.how = "push"
                    return shlex.quote(plan["url"]), plan["url"]
                log.info("hand-off push failed, sending a bundle instead: %s", pushed.err[-200:])
        folder = self.hub.feature_path("handoff")
        folder.mkdir(parents=True, exist_ok=True)
        folder.chmod(0o700)
        bundle = folder / f"{rec.id}.bundle"
        try:
            made = await asyncio.to_thread(
                git,
                checkout,
                "bundle",
                "create",
                str(bundle),
                f"refs/heads/{rec.branch}",
                timeout=300,
            )
            if not made.ok:
                return f"Couldn't make the bundle: {made.err.strip()[-300:]}"
            sent = await handoff.run(
                self.ssh,
                alias,
                f'umask 077; D={rec.folder}; mkdir -p "$D" && cat > "$D/handoff.bundle"',
                stdin=bundle,
                timeout=handoff.SETUP_SECONDS,
            )
        finally:
            with contextlib.suppress(OSError):
                bundle.unlink()
        if not sent.ok:
            return f"Couldn't send the branch to {alias}: {handoff.ssh_problem(alias, sent)}"
        rec.how = "bundle"
        return '"$D/handoff.bundle"', ""

    async def _start(
        self, rec: Handoff, machine: Machine, first: list[str], resume: str = ""
    ) -> str:
        """Claude Code started there with the first lines of its inbox ("" when it is)."""
        run_sh = handoff.runner(machine.claude, rec.mode, rec.asks, rec.model, resume)
        done = await handoff.run(
            self.ssh,
            rec.alias,
            handoff.start_script(rec, run_sh),
            stdin=handoff.inbox_bytes(first),
            timeout=60,
        )
        if not done.ok:
            why = done.err or handoff.ssh_problem(rec.alias, done)
            return f"Couldn't start Claude Code on {rec.alias}: {why[-300:]}"
        rec.keeper = "tmux" if "tmux" in done.text else "nohup"
        rec.state, rec.run_cost, rec.note = "working", 0.0, ""
        return ""

    # ── reading what it says ──

    def _follow(self, rec: Handoff) -> None:
        running = self._followers.get(rec.id)
        if running is not None and not running.done():
            return
        self._followers[rec.id] = self.hub._spawn(self._follow_loop(rec))

    async def _follow_loop(self, rec: Handoff) -> None:
        delay = 2.0
        while rec in self.handoffs and rec.state not in ("failed",):
            if await self._read(rec):
                return  # it ended there
            if rec not in self.handoffs:
                return
            if rec.id not in self._lost:
                self._lost.add(rec.id)
                self.note(
                    self.task_of(rec),
                    f"Lost the connection to {rec.alias}. It keeps running there; reconnecting…",
                )
                self.publish()
            await asyncio.sleep(delay)
            delay = min(RETRY_MAX, delay * 2)
            status = await handoff.run(
                self.ssh, rec.alias, handoff.status_script(rec), timeout=handoff.CHECK_SECONDS
            )
            if not status.ok:
                continue
            delay = 2.0
            said = status.text.strip()
            if rec.id in self._lost:
                self._lost.discard(rec.id)
                self.note(self.task_of(rec), f"Reconnected to {rec.alias}.")
                self.publish()
            await self._resend(rec)
            if said == "missing":
                rec.state, rec.note = "failed", f"Its folder on {rec.alias} is gone."
                self._idle_task(rec, f"Ended on {rec.alias}")
                self.note(self.task_of(rec), rec.note)
                self.save()
                self.publish()
                return
            if said == "gone":  # no process and no exit code: the machine restarted, say
                await self._ended(rec, "?")
                return

    async def _read(self, rec: Handoff) -> bool:
        """Its output from the line after the last one read; True once the run has ended."""
        try:
            proc = await asyncio.create_subprocess_exec(
                *handoff.ssh_argv(self.ssh, rec.alias, handoff.follow_script(rec)),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=handoff._env(),
                limit=32 * 1024 * 1024,
            )
        except OSError:
            return False
        unsaved = 0
        try:
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    return False
                if raw.startswith(b"JARVIS-BEAT"):
                    continue  # (it's still there)
                if raw.startswith(b"JARVIS-EXIT"):
                    await self._ended(rec, raw.decode("utf-8", "replace")[11:].strip())
                    return True
                if not raw.endswith(b"\n"):
                    return False  # cut off mid-line: it's read again from its start
                rec.seen += 1
                if rec.id in self._lost:
                    self._lost.discard(rec.id)
                    self.note(self.task_of(rec), f"Reconnected to {rec.alias}.")
                    self.publish()
                try:
                    turn_over = self._on_line(rec, raw.decode("utf-8", "replace"))
                except Exception:  # one odd line never stops the stream
                    log.exception("hand-off: couldn't take in a line from %s", rec.alias)
                    turn_over = False
                unsaved += 1
                if turn_over or unsaved >= SAVE_EVERY:
                    unsaved = 0
                    self.save()
        finally:
            if proc.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    proc.kill()
            with contextlib.suppress(Exception):
                await proc.wait()
            if unsaved:
                self.save()

    def _on_line(self, rec: Handoff, raw: str) -> bool:
        """One stream-json line from Claude Code there, into the session (True: a turn ended)."""
        data = handoff.parse_line(raw)
        if data is None:
            return False
        kind = data.get("type")
        task = self.task_of(rec)
        if kind == "system" and data.get("subtype") == "init":
            rec.remote_session = str(data.get("session_id") or rec.remote_session)[:80]
            rec.remote_cwd = str(data.get("cwd") or rec.remote_cwd)[:500]
            rec.model = str(data.get("model") or rec.model)[:80]
            return False
        if kind == "control_request":
            request = data.get("request") or {}
            if request.get("subtype") == "can_use_tool" and data.get("request_id"):
                item = {
                    "request_id": str(data["request_id"]),
                    "tool": str(request.get("tool_name") or ""),
                    "input": request.get("input") if isinstance(request.get("input"), dict) else {},
                }
                rec.pending.append(item)
                self.save()
                self._ask(rec, item)
            return False
        if kind == "control_cancel_request":
            self._drop_request(rec, str(data.get("request_id") or ""))
            return False
        if kind == "result":
            self._result(rec, task, data)
            return True
        if task is None:
            return False
        if kind == "assistant":
            self._assistant(rec, task, data)
        elif kind == "user":
            self._tool_results(task, data)
        return False

    def _assistant(self, rec: Handoff, task: Any, data: dict[str, Any]) -> None:
        tm = self.hub.tasks
        message = data.get("message") or {}
        parent = data.get("parent_tool_use_id") or None
        cwd = Path(rec.remote_cwd or "/")
        if not task.busy:
            task.busy, task.status = True, "running"
            rec.state = "working"
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            name = str(block.get("name") or "")
            given = block.get("input") if isinstance(block.get("input"), dict) else {}
            if parent:
                if kind == "tool_use":
                    tm._log(
                        task, "subtool", tasks.describe_tool(name, given), tool=name, parent=parent
                    )
                continue
            if kind == "thinking" and str(block.get("thinking") or "").strip():
                tm._log(task, "thinking", str(block["thinking"]).strip())
            elif kind == "text" and str(block.get("text") or "").strip():
                task.result = str(block["text"]).strip()
                tm._log(task, "assistant", task.result)
            elif kind == "tool_use" and name == "TodoWrite":
                task.todos = [
                    {"content": str(t.get("content", "")), "status": str(t.get("status", "pending")),
                     "active": str(t.get("activeForm", ""))}
                    for t in (given.get("todos") or [])[:30] if isinstance(t, dict)
                ]  # fmt: skip
                tm._log(task, "todos", "", todos=task.todos)
            elif kind == "tool_use":
                tool_id = str(block.get("id") or "")
                task.tool_ids[tool_id] = None
                if name == "Bash":
                    task.commands += 1
                if name in tasks.AGENT_TOOLS:
                    task.last_action = f"Agent: {given.get('description', 'working')}"
                    tm._log(
                        task, "tool", task.last_action, tool="Agent", tool_id=tool_id,
                        detail=str(given.get("prompt", ""))[:4000],
                        agent=str(given.get("subagent_type", "general-purpose")), status="running",
                    )  # fmt: skip
                    continue
                task.last_action = tasks.describe_tool(name, given)
                tm._log(
                    task, "tool", task.last_action, tool=name, tool_id=tool_id,
                    detail=tasks.approval_detail(name, given, cwd)[:4000], status="running",
                )  # fmt: skip
        tm._changed_soon()

    def _tool_results(self, task: Any, data: dict[str, Any]) -> None:
        content = (data.get("message") or {}).get("content")
        if not isinstance(content, list):
            return
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            tool_id = str(block.get("tool_use_id") or "")
            status = "failed" if block.get("is_error") else "done"
            output = handoff.tool_output(block.get("content"))
            shown = task.tool_ids.pop(tool_id, 0) is None
            for entry in reversed(task.transcript):
                if entry.get("tool_id") == tool_id:
                    entry["status"], entry["output"] = status, output
                    shown = True
                    break
            if shown:
                self.hub.tasks.emit(
                    "task_log_update", id=task.id, tool_id=tool_id, status=status, output=output
                )

    def _result(self, rec: Handoff, task: Any, data: dict[str, Any]) -> None:
        """A turn there ended: what Claude Code there says it cost (shown, never counted
        against JARVIS's limits), and it's the owner's turn again."""
        try:
            total = float(data.get("total_cost_usd") or 0.0)
        except (TypeError, ValueError):
            total = rec.run_cost
        rec.cost = round(rec.cost + max(0.0, total - rec.run_cost), 6)
        rec.run_cost = total
        rec.turns += 1
        rec.state = "idle"
        if task is not None:
            tm = self.hub.tasks
            subtype = str(data.get("subtype") or "")
            if data.get("is_error") and subtype in tasks._ENDED:
                tm._log(task, "system", tasks._ENDED[subtype])
            usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
            tokens = sum(
                int(usage.get(k) or 0)
                for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens",
                          "cache_read_input_tokens")
            )  # fmt: skip
            seconds = round(float(data.get("duration_ms") or 0) / 1000)
            tm._log(task, "turn", "", seconds=seconds, tokens=tokens, cost=0)
            self._idle_task(rec, f"Waiting for you on {rec.alias}")
            tm._turn_finished(task, "failed" if data.get("is_error") else "done")
        self.publish()

    def _idle_task(self, rec: Handoff, action: str) -> None:
        task = self.task_of(rec)
        if task is None:
            return
        task.busy, task.current, task.status = False, "", "waiting"
        task.last_action = self.tr(action)
        self.hub.tasks._changed()

    async def _ended(self, rec: Handoff, code: str) -> None:
        """The run there is over (stopped, finished with its input, crashed or the machine
        restarted): the session waits; a message starts it there again."""
        was = rec.state
        if rec.state != "stopped":
            rec.state = "ended"
        for asked in list(self._asks.pop(rec.id, {}).values()):
            asked.cancel()
        rec.pending = []
        self._lost.discard(rec.id)
        task = self.task_of(rec)
        if was != "stopped" and task is not None:
            if code == "?":
                self.note(task, f"Claude Code on {rec.alias} isn't running any more.")
            elif code not in ("0", ""):
                self.note(task, f"Claude Code on {rec.alias} ended (exit {code}).")
        self._idle_task(rec, f"Ended on {rec.alias}")
        self.save()
        self.publish()

    # ── permission requests ──

    def _ask(self, rec: Handoff, item: dict[str, Any]) -> None:
        asks = self._asks.setdefault(rec.id, {})
        if item["request_id"] in asks and not asks[item["request_id"]].done():
            return
        asks[item["request_id"]] = self.hub._spawn(self._ask_permission(rec, item))

    def _drop_request(self, rec: Handoff, request_id: str) -> None:
        asked = self._asks.get(rec.id, {}).pop(request_id, None)
        if asked is not None:
            asked.cancel()
        rec.pending = [p for p in rec.pending if p.get("request_id") != request_id]
        self.save()

    async def _ask_permission(self, rec: Handoff, item: dict[str, Any]) -> None:
        name, given = item["tool"], item["input"]
        task = self.task_of(rec)
        alias = rec.alias
        if name == "AskUserQuestion":
            choice = "deny"
            message = self.tr(
                "Questions can't come to the Mac from there: ask the owner in your reply "
                "instead, then wait."
            )
        else:
            if name == "ExitPlanMode":
                question = f"Approve the plan on {alias}?"
                detail = str(given.get("plan") or "")[:4000]
                choices = [("allow", "Approve"), ("deny", "Keep planning")]
            else:
                question = f"Allow this step on {alias}?"
                what = tasks.describe_tool(name, given)
                shown = tasks.approval_detail(name, given, Path(rec.remote_cwd or "/"))
                detail = f"{rec.project}: {what}\n{shown}"[:4000]
                choices = [("allow", "Allow"), ("deny", "Deny")]
            context: dict[str, Any] = {"tool": name}
            if task is not None:
                context["task_id"] = task.id
            choice = await self.hub.request_approval(
                self.tr(question),
                detail if name == "ExitPlanMode" else self.tr(detail),
                [(c, self.tr(label)) for c, label in choices],
                context=context,
            )
            choice, _, message = choice.partition(":")
        item["answer"] = handoff.answer_line(
            item["request_id"], choice == "allow", given, message.strip()
        )
        self.save()
        await self._send_answer(rec, item)

    async def _send_answer(self, rec: Handoff, item: dict[str, Any]) -> None:
        for attempt in range(WRITE_TRIES):
            if await self._write(rec, [item["answer"]]):
                rec.pending = [p for p in rec.pending if p is not item]
                self._asks.get(rec.id, {}).pop(item["request_id"], None)
                self.save()
                return
            await asyncio.sleep(2.0 * (attempt + 1))
        # Still unreachable: the answer is kept and goes when the connection is back.

    async def _resend(self, rec: Handoff) -> None:
        """Back in touch: answers that didn't get there go now; requests not answered yet
        (a restart in between) are asked again."""
        for item in list(rec.pending):
            if item.get("answer"):
                if await self._write(rec, [item["answer"]]):
                    rec.pending = [p for p in rec.pending if p is not item]
                    self.save()
            else:
                self._ask(rec, item)

    async def _write(self, rec: Handoff, lines: list[str]) -> bool:
        async with self.lock(rec.id):
            done = await handoff.run(
                self.ssh,
                rec.alias,
                handoff.write_script(rec),
                stdin=handoff.inbox_bytes(lines),
                timeout=handoff.WRITE_SECONDS,
            )
        return done.ok

    # ── the session's messages, while it's there ──

    def send_wrapper(self, inner: Any) -> Any:
        """TaskManager.send, wrapped: a handed-off session's messages go to its machine."""

        def send(task_id: int, text: str, images: Any = None, **kwargs: Any) -> bool:
            task = self.hub.tasks.tasks.get(task_id)
            rec = self.of_task(task) if task is not None and task.kind == "code" else None
            if rec is None:
                return inner(task_id, text, images, **kwargs)
            text = (text or "").strip()
            if not text:
                return False
            self.hub._spawn(self._send_remote(rec, task, text, bool(images)))
            return True

        return send

    async def _send_remote(self, rec: Handoff, task: Any, text: str, pictures: bool) -> None:
        tm = self.hub.tasks
        tm._log(task, "user", text)
        if pictures:
            self.note(task, f"Pictures don't go to {rec.alias}; only the words were sent.")
        if rec.live:
            if not await self._write(rec, [handoff.user_line(text)]):
                self.note(
                    task,
                    f"Couldn't reach {rec.alias}: the message wasn't sent. Try again when it's back.",
                )
                return
        else:
            machine = self.machine(rec.alias)
            if machine is None:
                self.note(
                    task,
                    f"{rec.alias} isn't on your machines any more: bring the session back, or add "
                    "it again.",
                )
                return
            first = [handoff.init_line(), handoff.user_line(text)]
            problem = await self._start(rec, machine, first, resume=rec.remote_session)
            if problem:
                self.note(task, problem)
                return
            self.save()
            self._follow(rec)
        rec.state = "working"
        task.busy, task.status = True, "running"
        task.last_action = self.tr(f"Working on {rec.alias}")
        tm._changed()
        self.publish()

    def interrupt_wrapper(self, inner: Any) -> Any:
        async def interrupt(task_id: int) -> bool:
            task = self.hub.tasks.tasks.get(task_id)
            rec = self.of_task(task) if task is not None else None
            if rec is None:
                return await inner(task_id)
            if not rec.live:
                return False
            return await self._write(rec, [handoff.interrupt_line(next(self._interrupts))])

        return interrupt

    def reconnect_wrapper(self, inner: Any) -> Any:
        def reconnect(task_id: int) -> str:
            task = self.hub.tasks.tasks.get(task_id)
            rec = self.of_task(task) if task is not None else None
            if rec is None:
                return inner(task_id)
            if rec.live:
                self._follow(rec)
            return "reopened"

        return reconnect

    def _wrap_note(self) -> None:
        """TaskManager.turn_note, wrapped (when a note is due, since another feature sets
        turn_note at install): the first message here after a bring-back says what happened
        on the other machine (its conversation stayed there)."""
        tm = self.hub.tasks
        inner = tm.turn_note
        if getattr(inner, "handoff_notes", False):
            return

        def note(task: Any) -> str:
            base = inner(task) if inner is not None else ""
            mine = self._notes.pop(task.id, "")
            return f"{base} {mine}".strip() if base and mine else base or mine

        note.handoff_notes = True  # type: ignore[attr-defined]
        tm.turn_note = note

    # ── bringing it back, stopping it ──

    def find(self, msg: dict[str, Any]) -> Handoff | None:
        self.load()
        key = str(msg.get("handoff") or "")
        if key:
            return next((r for r in self.handoffs if r.id == key), None)
        try:
            task = self.hub.tasks.tasks.get(int(msg.get("id") or 0))
        except (TypeError, ValueError):
            return None
        return self.of_task(task)

    async def bring_back(self, rec: Handoff | None, by_voice: bool = False) -> str:
        if rec is None:
            return "That session isn't on another machine."
        alias = rec.alias
        question = self.tr(f"Bring {rec.branch} back from {alias}?")
        detail = self.tr(
            f"This stops Claude Code on {alias}, commits what it changed there, and brings the "
            "branch into this Mac's isolated copy, ready to land. The checkout there stays."
        )
        if by_voice:
            self.hub._say(question)
        task = self.task_of(rec)
        choice = await self.hub.request_approval(
            question,
            detail,
            [("back", self.tr("Bring it back")), ("deny", self.tr("Not now"))],
            context={"task_id": task.id} if task is not None else None,
        )
        if choice != "back":
            return "Not brought back."
        return await self.bring_back_now(rec)

    async def bring_back_now(self, rec: Handoff) -> str:
        desk = getattr(self.hub, "code_desk", None)
        copy = desk.store().find(rec.slug) if desk is not None else None
        if copy is None:
            return "The isolated copy it came from isn't on this Mac any more."
        alias = rec.alias
        if rec.id in self._busy:
            return "It's already being handed off."
        self._busy.add(rec.id)
        try:
            stopped = await handoff.run(
                self.ssh, alias, handoff.stop_script(rec), timeout=handoff.CHECK_SECONDS
            )
            if not stopped.ok:
                return handoff.ssh_problem(alias, stopped)
            rec.state = "stopped"
            follower = self._followers.pop(rec.id, None)
            if follower is not None:
                follower.cancel()
            for asked in list(self._asks.pop(rec.id, {}).values()):
                asked.cancel()
            done = await handoff.run(
                self.ssh,
                alias,
                handoff.back_script(rec, f"Jarvis Code: work on {alias}"),
                timeout=handoff.SETUP_SECONDS,
            )
            if done.code == handoff.BACK_BRANCH:
                return f"On {alias} it isn't on {rec.branch} any more: switch back there, then bring it back."
            if done.code not in (0, handoff.BACK_NOTHING):
                why = done.err or handoff.ssh_problem(alias, done)
                return f"Couldn't bring it back: {why[-300:]}"
            said = ""
            commits: list[str] = []
            if done.code == 0:
                landed = await asyncio.to_thread(self._take_bundle, rec, copy, done.out)
                if isinstance(landed, str) and landed.startswith("!"):
                    return landed[1:]
                if isinstance(landed, str):
                    said = landed
                else:
                    commits = landed
        finally:
            self._busy.discard(rec.id)
        if rec in self.handoffs:
            self.handoffs.remove(rec)
        self._lost.discard(rec.id)
        self.save()
        task = self.task_of(rec)
        n = len(commits)
        if said:
            reply = said
        elif not n:
            reply = f"Brought back from {alias}: nothing new there."
        elif n == 1:
            reply = f"Brought back from {alias}: {n} commit in its isolated copy, ready to land."
        else:
            reply = f"Brought back from {alias}: {n} commits in its isolated copy, ready to land."
        if task is not None:
            task.busy, task.current, task.status = False, "", "closed"
            task.last_action = self.tr(f"Back from {alias}")
            self.note(task, reply)
            last = (task.result or "").strip()
            carried = (
                f"while the owner was away from this Mac, this session carried on on {alias} "
                "(its conversation there can't come back)."
            )
            if commits:
                carried += " Its commits, now in this checkout: " + "; ".join(commits[:15]) + "."
            if last:
                carried += f" Its last reply there: {last[:1500]}"
            self._notes[task.id] = carried
            self._wrap_note()
            self.hub.tasks._changed()
        self.publish()
        return reply

    def _take_bundle(self, rec: Handoff, copy: worktrees.Copy, data: bytes) -> list[str] | str:
        """The bundle from there, fetched into the copy and fast-forwarded: its commits, or
        why not (a leading "!": nothing changed here)."""
        checkout = Path(copy.checkout)
        folder = self.hub.feature_path("handoff")
        folder.mkdir(parents=True, exist_ok=True)
        folder.chmod(0o700)
        bundle = folder / f"{rec.id}-back.bundle"
        ref = BACK_REF + rec.id
        try:
            bundle.write_bytes(data)
            fetched = git(
                checkout, "fetch", "-q", str(bundle), f"+refs/heads/{rec.branch}:{ref}", timeout=300
            )
        finally:
            with contextlib.suppress(OSError):
                bundle.unlink()
        if not fetched.ok:
            return f"!Couldn't bring it back: {fetched.err.strip()[-300:]}"
        listed = git(checkout, "log", "--format=%h %s", "--max-count=50", f"{rec.base}..{ref}")
        commits = [line[:120] for line in listed.out.splitlines() if line.strip()]
        merged = git(checkout, "merge", "-q", "--ff-only", ref)
        if not merged.ok:
            return f"Brought back as {ref}: the copy changed meanwhile, so merge it there yourself."
        git(checkout, "update-ref", "-d", ref)
        return commits

    async def stop(self, rec: Handoff | None) -> str:
        if rec is None:
            return "That session isn't on another machine."
        if not rec.live:
            return f"It isn't running on {rec.alias}."
        done = await handoff.run(
            self.ssh, rec.alias, handoff.stop_script(rec), timeout=handoff.CHECK_SECONDS
        )
        if not done.ok:
            return handoff.ssh_problem(rec.alias, done)
        rec.state = "stopped"
        self.note(
            self.task_of(rec),
            f"Stopped on {rec.alias}. Send a message to carry on there, or bring it back.",
        )
        self._idle_task(rec, f"Ended on {rec.alias}")
        self.save()
        self.publish()
        return f"Stopped it on {rec.alias}."

    def forget(self, rec: Handoff | None) -> str:
        if rec is None:
            return ""
        if rec.live:
            return "Bring it back or stop it first."
        self.handoffs.remove(rec)
        task = self.task_of(rec)
        if task is not None:
            task.status, task.last_action = "closed", "Closed"
            self.hub.tasks._changed()
        self.save()
        self.publish()
        return f"Forgot it; the checkout on {rec.alias} stays."

    # ── at startup ──

    async def watch(self) -> None:
        """Hand-offs that were running when JARVIS quit: read on from where they got to,
        and ask again what nobody answered."""
        await asyncio.sleep(5)
        self.load()
        for rec in list(self.handoffs):
            if rec.live:
                task = self.task_of(rec)
                if task is not None:
                    working = rec.state != "idle"
                    task.busy = working
                    task.status = "running" if working else "waiting"
                    where = "Working on {}" if working else "Waiting for you on {}"
                    task.last_action = self.tr(where.format(rec.alias))
                    self.hub.tasks._changed()
                self._follow(rec)
                await self._resend(rec)
        self.publish()

    # ── window commands ──

    def _task(self, msg: dict[str, Any]) -> Any:
        try:
            task = self.hub.tasks.tasks.get(int(msg.get("id") or 0))
        except (TypeError, ValueError):
            return None
        return task if task is not None and task.kind == "code" else None

    def cmd_machines(self, _msg: dict[str, Any]) -> None:
        self.publish()

    async def cmd_add(self, msg: dict[str, Any]) -> None:
        self.caption(await self.add_machine(str(msg.get("alias") or "")))

    async def cmd_test(self, msg: dict[str, Any]) -> None:
        self.caption(await self.test_machine(str(msg.get("alias") or "")))

    def cmd_remove(self, msg: dict[str, Any]) -> None:
        self.caption(self.remove_machine(str(msg.get("alias") or "")))

    async def cmd_handoff(self, msg: dict[str, Any]) -> None:
        said = await self.hand_off(
            self._task(msg), str(msg.get("alias") or ""), str(msg.get("instructions") or "")[:4000]
        )
        self.caption(said)

    async def cmd_back(self, msg: dict[str, Any]) -> None:
        self.caption(await self.bring_back(self.find(msg)))

    async def cmd_stop(self, msg: dict[str, Any]) -> None:
        self.caption(await self.stop(self.find(msg)))

    def cmd_forget(self, msg: dict[str, Any]) -> None:
        self.caption(self.forget(self.find(msg)))

    # ── by voice ──

    def spoken_task(self, number: Any) -> Any:
        tm = self.hub.tasks
        with contextlib.suppress(TypeError, ValueError):
            if number:
                task = tm.tasks.get(int(number))
                return task if task is not None and task.kind == "code" else None
        focus = getattr(getattr(self.hub, "voicecode", None), "focus", None)
        if focus is not None and (task := tm.tasks.get(focus)) is not None:
            return task
        code = [t for t in tm.tasks.values() if t.kind == "code"]
        return max(code, key=lambda t: t.id) if code else None

    def build_server(self) -> Any:
        desk = self

        def text(said: str) -> dict[str, Any]:
            return {"content": [{"type": "text", "text": desk.tr(said)}]}

        @tool(
            "continue_on_machine",
            "Hand a Jarvis Code session off to another machine the user controls over SSH "
            '("continue this on the studio", "move it to my Linux box"): its branch goes there '
            "and Claude Code carries on there, streaming back into the same session; a card "
            "asks first. machine: a machine's alias from handoff_status. session: the "
            "session's number (default: the one in voice focus, else the latest). "
            "instructions: what to do there next, if the user said.",
            {
                "type": "object",
                "properties": {
                    "machine": {"type": "string"},
                    "session": {"type": "integer"},
                    "instructions": {"type": "string"},
                },
                "required": ["machine"],
            },
        )
        async def continue_on_machine(args):
            desk.load()
            alias = str(args.get("machine") or "").strip()
            if desk.machine(alias) is None:
                names = ", ".join(m.alias for m in desk.machines)
                return text(
                    f"Say which machine: {names}."
                    if names
                    else "Add a machine in Jarvis Code settings › Machines first."
                )
            task = desk.spoken_task(args.get("session"))
            return text(
                await desk.hand_off(
                    task, alias, str(args.get("instructions") or "")[:4000], by_voice=True
                )
            )

        @tool(
            "bring_back_from_machine",
            "Bring a handed-off Jarvis Code session's work back from the machine it runs on into "
            "its isolated copy on this Mac, ready to land (a card asks first). session: its "
            "number (default: the one in voice focus, else the latest).",
            {"type": "object", "properties": {"session": {"type": "integer"}}},
        )
        async def bring_back_from_machine(args):
            task = desk.spoken_task(args.get("session"))
            rec = desk.of_task(task)
            if rec is None and len(desk.handoffs) == 1 and not args.get("session"):
                rec = desk.handoffs[0]
            return text(await desk.bring_back(rec, by_voice=True))

        @tool(
            "handoff_status",
            "The machines added for Jarvis Code hand-offs (alias, ready or why not) and the "
            "sessions running on them (state, and the cost their own Claude reported there).",
            {"type": "object", "properties": {}},
        )
        async def handoff_status(_args):
            desk.load()
            lines = [
                f"{m.alias}: {'ready' if m.ok else m.problem or 'not checked'}"
                for m in desk.machines
            ] or ["No machines yet."]
            for rec in desk.handoffs:
                task = desk.task_of(rec)
                lines.append(
                    f"Session {task.id if task else '?'} ({rec.title}) on {rec.alias}: {rec.state}, "
                    f"${rec.cost:.2f} reported there (billed to {rec.alias}'s Claude sign-in, "
                    "outside JARVIS's limits)"
                )
            return {"content": [{"type": "text", "text": "\n".join(lines)}]}

        return create_sdk_mcp_server(
            SERVER, tools=[continue_on_machine, bring_back_from_machine, handoff_status]
        )


def install(hub: Any) -> None:
    desk = Desk(hub)
    hub.code_handoff = desk  # (for the tests)
    tm = hub.tasks
    tm.send = desk.send_wrapper(tm.send)
    tm.interrupt = desk.interrupt_wrapper(tm.interrupt)
    tm.reconnect = desk.reconnect_wrapper(tm.reconnect)
    hub.register_command("code_machines", desk.cmd_machines)
    hub.register_command("code_machine_add", desk.cmd_add, slow=True)
    hub.register_command("code_machine_test", desk.cmd_test, slow=True)
    hub.register_command("code_machine_remove", desk.cmd_remove)
    hub.register_command("code_handoff", desk.cmd_handoff, slow=True)
    hub.register_command("code_handoff_back", desk.cmd_back, slow=True)
    hub.register_command("code_handoff_stop", desk.cmd_stop, slow=True)
    hub.register_command("code_handoff_forget", desk.cmd_forget)
    hub.register_loop("code_handoff_watch", desk.watch)
    hub.register_server(
        SERVER,
        desk.build_server,
        prompt=PROMPT,
        labels={
            "continue_on_machine": "Handed a session off",
            "bring_back_from_machine": "Brought a session back",
            "handoff_status": "Checked the machines",
        },
        quiet=("continue_on_machine", "bring_back_from_machine"),
    )
