"""Eden Code: "Keep it green", a pull request that looks after itself until it's merged.

A switch for each pull request (in its PR pane, off until the owner turns it on, on a card
with the whole scope). While it's on, code_pr.py's watcher goes further than its own "fix
failing checks" (at most FIX_ATTEMPTS a pull request):

- failing checks: their logs, trimmed and marked as data, go to the session as before, for
  up to the owner's rounds for this pull request (ROUNDS_DEFAULT, at most ROUNDS_MAX);
- review comments from people GitHub says can write to the repository go to the session
  as before (marked as data, batched), and once its answer is pushed, a fixed line goes back
  on the pull request saying which commit answers whom (never the session's own words).
  The round-1/2 trust rules stand: those comments are outside text, never sent by
  themselves to a session in Bypass permissions or Auto (code_pr holds them, and says so),
  and anyone else's are listed in the pane with a Send button;
- a conflict with the base: the base is fetched and the session asked to merge it and
  resolve, as before (once for each base commit);
- a preview link, when the project has one: the newest successful GitHub deployment's
  environment_url for the pull request's head (Vercel, Netlify and Cloudflare Pages make
  one), else a preview address a check run or status of theirs names (*.vercel.app,
  *.netlify.app, *.pages.dev, *.workers.dev); or the dev server through a tunnel, only if
  the owner pasted that tunnel's https address for this pull request. Each is posted on the
  pull request once, and shown in the pane;
- every push is behind the Git panel's card, unless the owner chose "push fixes without
  asking" for this pull request (a card of its own): then the session's work goes straight
  to its branch after each round, except when something in it looks like a secret, which
  still asks (code_git.push's unasked).

Caps: rounds for this pull request (the owner's, default ROUNDS_DEFAULT), a spending
ceiling for it (the owner's, default $SPEND_DEFAULT: what the session's turns after its
follow-ups cost, as Claude Code reports each), DAY_ROUNDS rounds a day across every pull
request and DAY_SPEND dollars a day. A pull request past its rounds or ceiling stops by
itself (the owner hears why); past a day's cap it waits for tomorrow. Stop (in the pane)
turns it off at once, ends a round under way (the session's turn is interrupted), and
stops this pull request's automatic follow-ups altogether until it's turned on again: its
review comments wait in the pane, and its fixes and conflicts are the owner's to send.

The PR pane shows the switch, Stop, the caps and what's left, the preview link, and a log of
what it did (sent, pushed, posted, held, stopped, and why).

Window commands: code_pr_green {id, on?, push_unasked?, rounds?, spend_cap?, tunnel?},
code_pr_green_stop {id}.
Events: the code_pr event carries green (this pull request's state, or None).
Settings: none; each pull request's own state is in code_pr_green.json.

Cost policy: no model of its own. Each round is a turn of the pull request's session on the
model it already runs (the owner's), counted against this pull request's rounds and ceiling
and the day's DAY_ROUNDS and DAY_SPEND, besides code_pr's own FOLLOW_UP_CAPS and the
owner's Eden Code usage caps (code_usage, which every session turn is under). Looking for a
preview link is two GitHub calls at most, only for a pull request it's on for, once per
head commit; posting a line is one.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
from datetime import date
from typing import Any
from urllib.parse import urlsplit

from .. import code_ai, github, jsonstore, lang
from ..code_changes import git
from ..code_prs import FIX_ATTEMPTS, PullRecord
from ..proactive import Alert

log = logging.getLogger("jarvis")

ROUNDS_DEFAULT, ROUNDS_MAX = 8, 20
SPEND_DEFAULT, SPEND_MAX = 5.0, 50.0
DAY_ROUNDS = 30  # rounds a day, every pull request together
DAY_SPEND = 20.0  # dollars a day, every pull request together
LOG_KEPT = 40
URL_MAX = 300
# Preview addresses a check run or status may name (the hosting services' own domains).
PREVIEW_HOSTS = (".vercel.app", ".netlify.app", ".pages.dev", ".workers.dev")
_URL = re.compile(r"https://[A-Za-z0-9.-]+(?::\d+)?(?:/[^\s<>\"')\]]*)?")
_HOST = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
_AUTHOR = re.compile(r'<review-comment author="([^"]{1,80})"')
KINDS = ("fix", "review", "conflict")  # the automatic follow-ups it counts and can stop

ZH = {
    "Keep pull request #{n} green?": "要让拉取请求 #{n} 保持全绿吗？",
    "While it's open I keep watching it. Failing checks go to its session with their logs (marked as data), for up to {rounds} rounds. Review comments from people who can write to the repository go to it too (never by themselves to a session in Bypass permissions or Auto), and a line on the pull request says which commit answers them. A conflict with {base} is merged and resolved. A preview link is posted when the project has one.": "在它关闭之前，我会一直盯着它。失败的检查会连同日志（只当作数据）交给它的会话，最多 {rounds} 轮。有仓库写权限的人留下的审查意见也会交给会话（如果会话处于“绕过权限”或“自动”模式，就不会自动发送），拉取请求上会有一行说明哪个提交回应了这些意见。与 {base} 的冲突会被合并并解决。项目有预览链接时会贴出来。",
    "It stops by itself at {rounds} rounds or ${spend} for this pull request, and waits for tomorrow past {day} rounds or ${day_spend} a day for all of them. Every push asks first, unless you choose to push its fixes without asking.": "这个拉取请求达到 {rounds} 轮或花费 ${spend} 时会自己停下；所有拉取请求每天合计超过 {day} 轮或 ${day_spend} 时，要等到第二天。每次推送都会先问你，除非你选择不经询问直接推送修复。",
    "Keep it green": "保持全绿",
    "Not now": "暂不",
    "Not turned on.": "没有开启。",
    "Push the fixes for pull request #{n} without asking?": "要不经询问直接推送拉取请求 #{n} 的修复吗？",
    "After each round, its session's work goes straight to {branch} on GitHub, without the push card. Anything in it that looks like a key or token still asks first. Turn it off in the pull request pane any time.": "每一轮结束后，会话的改动会直接推送到 GitHub 上的 {branch}，不再弹出推送卡片。看起来像密钥或令牌的内容仍然会先问你。你随时可以在拉取请求面板里关掉。",
    "Push without asking": "直接推送",
    "Keeping pull request #{n} green.": "正在让拉取请求 #{n} 保持全绿。",
    "Stopped keeping pull request #{n} green.": "已停止让拉取请求 #{n} 保持全绿。",
    "Saved.": "已保存。",
    "A tunnel's address starts with https:// and has no spaces.": "隧道地址要以 https:// 开头，不能有空格。",
    "Turned on: up to {rounds} rounds and ${spend}.": "已开启：最多 {rounds} 轮、${spend}。",
    "Fixes are pushed without asking now.": "现在修复会直接推送，不再询问。",
    "Pushes ask first again.": "推送前会重新先问你。",
    "Sent the failing checks (round {k} of {total}).": "已发送失败的检查（第 {k} 轮，共 {total} 轮）。",
    "Sent the review comments from {who} (round {k} of {total}).": "已发送 {who} 的审查意见（第 {k} 轮，共 {total} 轮）。",
    "Sent the conflicts with {base} (round {k} of {total}).": "已发送与 {base} 的冲突（第 {k} 轮，共 {total} 轮）。",
    "The round cost ${cost}; ${spent} of ${cap} so far.": "这一轮花费 ${cost}；目前共 ${spent}，上限 ${cap}。",
    "Pushed {sha}.": "已推送 {sha}。",
    "Posted on the pull request: {sha} answers {who}.": "已在拉取请求上说明：{sha} 回应了 {who}。",
    "Posted the preview link: {url}": "已贴出预览链接：{url}",
    "Stopped: you pressed Stop.": "已停止：你按了停止。",
    "Stopped: {rounds} rounds were used.": "已停止：{rounds} 轮已经用完。",
    "Stopped: it spent ${spent}, its ceiling.": "已停止：已花费 ${spent}，达到上限。",
    "Today's {n} rounds are used; it carries on tomorrow.": "今天的 {n} 轮已经用完；明天继续。",
    "Today's ${n} are spent; it carries on tomorrow.": "今天的 ${n} 已经花完；明天继续。",
    "Pull request #{n} stopped keeping itself green: {why}": "拉取请求 #{n} 不再自动保持全绿：{why}",
    "Ended the round under way.": "已结束正在进行的一轮。",
}
lang.add_texts(ZH)


def safe_url(text: Any, hosts: tuple[str, ...] = ()) -> str:
    """An https address fit to show and post ("" when it isn't): no credentials, a plain
    host name (with hosts, one of those domains), no spaces or control characters, at most
    URL_MAX characters."""
    url = str(text or "").strip()
    if not url or len(url) > URL_MAX or re.search(r"[\s\x00-\x1f\x7f<>\"'`]", url):
        return ""
    try:
        parts = urlsplit(url)
    except ValueError:
        return ""
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or parts.username or parts.password or not _HOST.match(host):
        return ""
    if hosts and not any(host.endswith(h) for h in hosts):
        return ""
    return url


def preview_from(
    deployments: list[tuple[dict[str, Any], list[dict[str, Any]]]],
    runs: list[dict[str, Any]],
    statuses: list[dict[str, Any]],
) -> str:
    """The preview address for a commit: the newest successful deployment's environment_url
    (or its status's target_url, when that's on a preview host); else a preview host's
    address a check run or status names. "" when there's none."""
    for _deployment, rows in deployments:
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict) or row.get("state") != "success":
                continue
            found = safe_url(row.get("environment_url")) or safe_url(
                row.get("target_url"), PREVIEW_HOSTS
            )
            if found:
                return found
    texts: list[str] = []
    for run in runs if isinstance(runs, list) else []:
        if not isinstance(run, dict) or run.get("conclusion") not in ("success", "neutral"):
            continue
        output = run.get("output") if isinstance(run.get("output"), dict) else {}
        texts += [str(run.get("details_url") or ""), str(output.get("summary") or "")[:4000],
                  str(output.get("text") or "")[:4000], str(output.get("title") or "")]  # fmt: skip
    for row in statuses if isinstance(statuses, list) else []:
        if isinstance(row, dict) and row.get("state") == "success":
            texts += [str(row.get("target_url") or ""), str(row.get("description") or "")]
    for text in texts:
        for match in _URL.findall(text):
            found = safe_url(match.rstrip(".,;:"), PREVIEW_HOSTS)
            if found:
                return found
    return ""


def _who(authors: list[str]) -> str:
    names = [f"@{a}" for a in authors[:5]]
    if len(authors) > 5:
        names.append(f"{len(authors) - 5} more")
    return ", ".join(names) or "the reviewers"


def _fresh() -> dict[str, Any]:
    return {
        "on": False, "push_unasked": False, "rounds_cap": ROUNDS_DEFAULT,
        "spend_cap": SPEND_DEFAULT, "rounds": 0, "spent": 0.0, "stopped": "", "since": 0.0,
        "preview": "", "preview_sha": "", "posted": [], "tunnel": "", "log": [],
        "pending": {}, "told_day": "",
    }  # fmt: skip


def _clean(raw: Any) -> dict[str, Any] | None:
    """A kept pull request's state, checked field by field (None when it can't be one)."""
    if not isinstance(raw, dict):
        return None
    st = _fresh()
    for key in ("on", "push_unasked"):
        st[key] = raw.get(key) is True
    for key, cap in (("rounds_cap", ROUNDS_MAX), ("rounds", 10_000)):
        value = raw.get(key)
        if type(value) is int and 0 <= value <= cap:
            st[key] = value
    st["rounds_cap"] = max(1, st["rounds_cap"])
    for key, cap in (("spend_cap", SPEND_MAX), ("spent", 1e6), ("since", 1e11)):
        value = raw.get(key)
        if isinstance(value, int | float) and not isinstance(value, bool) and 0 <= value <= cap:
            st[key] = float(value)
    st["spend_cap"] = max(0.5, st["spend_cap"])
    for key in ("stopped", "preview", "preview_sha", "tunnel", "told_day"):
        if isinstance(raw.get(key), str):
            st[key] = raw[key][:URL_MAX]
    st["preview"] = safe_url(st["preview"])
    st["tunnel"] = safe_url(st["tunnel"])
    if isinstance(raw.get("posted"), list):
        st["posted"] = [u for u in raw["posted"] if isinstance(u, str)][-20:]
    if isinstance(raw.get("log"), list):
        st["log"] = [
            {"at": float(e["at"]), "text": str(e["text"])[:400]}
            for e in raw["log"]
            if isinstance(e, dict) and isinstance(e.get("at"), int | float)
            and isinstance(e.get("text"), str)
        ][-LOG_KEPT:]  # fmt: skip
    pending = raw.get("pending")
    if isinstance(pending, dict) and type(pending.get("task")) is int:
        st["pending"] = {
            "task": pending["task"],
            "cost": float(pending.get("cost") or 0.0),
            "kind": str(pending.get("kind") or "")[:20],
            "authors": [a for a in pending.get("authors") or [] if isinstance(a, str)][:20],
        }
    return st


class Green:
    """Keep it green for one hub's pull requests (code_pr's PullDesk calls in)."""

    def __init__(self, hub: Any, desk: Any) -> None:
        self.hub = hub
        self.desk = desk
        self.prs: dict[str, dict[str, Any]] = {}
        self.day = {"day": "", "spent": 0.0}
        self._loaded = False
        self._unreadable = False
        self._caps: code_ai.Budget | None = None

    # ── plumbing ──

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    def _path(self) -> Any:
        return self.hub.feature_path("code_pr_green.json")

    @property
    def caps(self) -> code_ai.Budget:
        if self._caps is None:
            self._caps = code_ai.Budget(
                self.hub.feature_path("code_pr_green_day.json"), {"rounds": DAY_ROUNDS}
            )
        return self._caps

    def load(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        try:
            data = jsonstore.load_json(self._path(), dict) or {}
        except jsonstore.Unreadable:
            # There but can't be read: never saved over (jsonstore's rule). Until it can,
            # nothing is on: no pull request keeps itself green on a guess.
            log.warning("keep it green: %s can't be read; nothing is saved over it", self._path())
            self._unreadable = True
            data = {}
        prs = data.get("prs") if isinstance(data.get("prs"), dict) else {}
        for key, raw in list(prs.items())[:500]:
            st = _clean(raw)
            if isinstance(key, str) and st is not None:
                self.prs[key[:200]] = st
        day = data.get("day") if isinstance(data.get("day"), dict) else {}
        if isinstance(day.get("day"), str) and isinstance(day.get("spent"), int | float):
            self.day = {"day": day["day"], "spent": float(day["spent"])}

    def save(self) -> None:
        self.load()
        if self._unreadable:
            return
        keep = {k: v for k, v in self.prs.items() if self.desk.store().by_key(k) is not None}
        try:
            jsonstore.save_json(self._path(), {"prs": keep, "day": self.day})
        except OSError as exc:
            log.info("keep it green: couldn't save (%s)", exc)

    def state(self, rec: PullRecord) -> dict[str, Any] | None:
        self.load()
        return self.prs.get(rec.key)

    def note(self, rec: PullRecord, text: str) -> None:
        """A line in the pull request's log (the pane shows the newest first)."""
        st = self.prs.setdefault(rec.key, _fresh())
        st["log"] = [*st["log"], {"at": time.time(), "text": text[:400]}][-LOG_KEPT:]

    def notify(self, key: str, text: str) -> None:
        self.hub.notify(Alert(key, "task", self.tr("Pull request"), self.tr(text),
                              note="a pull request update (Eden Code's pull request pane has it)"))  # fmt: skip

    def _today(self) -> str:
        return date.today().isoformat()

    def day_spent(self) -> float:
        if self.day["day"] != self._today():
            self.day = {"day": self._today(), "spent": 0.0}
        return float(self.day["spent"])

    def public(self, rec: PullRecord) -> dict[str, Any] | None:
        st = self.state(rec)
        if st is None:
            return None
        return {
            "on": st["on"], "push_unasked": st["push_unasked"], "stopped": st["stopped"],
            "rounds": st["rounds"], "rounds_cap": st["rounds_cap"],
            "spent": round(st["spent"], 2), "spend_cap": st["spend_cap"],
            "day_rounds_left": self.caps.left("rounds"),
            "day_spend_left": round(max(0.0, DAY_SPEND - self.day_spent()), 2),
            "preview": st["preview"], "tunnel": st["tunnel"],
            "busy": bool(st["pending"]) and bool(rec.followup),
            "log": [{"at": e["at"], "text": self.tr(e["text"])} for e in reversed(st["log"])],
        }  # fmt: skip

    def refresh(self, rec: PullRecord) -> None:
        self.save()
        self.desk._publish_rec(rec)

    # ── what code_pr asks ──

    def fix_limit(self, rec: PullRecord) -> int:
        st = self.state(rec)
        return st["rounds_cap"] if st is not None and st["on"] else FIX_ATTEMPTS

    def push_unasked(self, rec: PullRecord) -> bool:
        st = self.state(rec)
        return bool(st is not None and st["on"] and st["push_unasked"])

    def allows(self, rec: PullRecord, kind: str) -> bool:
        """Whether an automatic follow-up may go: always for a pull request it was never on
        for (code_pr as before) and for the owner's own @jarvis; never once it was stopped;
        while it's on, within this pull request's rounds and ceiling (past them it stops
        itself) and the day's (past those it waits for tomorrow)."""
        st = self.state(rec)
        if st is None or kind not in KINDS or (not st["on"] and not st["stopped"]):
            return True
        if not st["on"]:
            return False
        if st["rounds"] >= st["rounds_cap"]:
            self.stop(rec, "rounds")
            return False
        if st["spent"] >= st["spend_cap"]:
            self.stop(rec, "spend")
            return False
        today = self._today()
        if not self.caps.left("rounds") or self.day_spent() >= DAY_SPEND:
            if st["told_day"] != today:
                st["told_day"] = today
                self.note(rec, f"Today's {DAY_ROUNDS} rounds are used; it carries on tomorrow."
                          if not self.caps.left("rounds")
                          else f"Today's ${DAY_SPEND:.0f} are spent; it carries on tomorrow.")  # fmt: skip
                self.refresh(rec)
            return False
        return True

    def sent(self, rec: PullRecord, task: Any, kind: str, text: str, manual: bool = False) -> None:
        """code_pr sent the session a follow-up: while it's on, a round (the owner's own
        clicks aren't counted as one, but what their turn costs is)."""
        st = self.state(rec)
        if st is None or not st["on"] or kind == "jarvis":
            return
        authors = sorted(set(_AUTHOR.findall(text))) if kind == "review" else []
        st["pending"] = {"task": int(task.id), "cost": float(task.cost_usd or 0.0),
                         "kind": kind, "authors": authors}  # fmt: skip
        if manual:
            self.save()
            return
        st["rounds"] += 1
        with contextlib.suppress(code_ai.OverBudget):
            self.caps.take("rounds")
        k, total = st["rounds"], st["rounds_cap"]
        words = {
            "fix": f"Sent the failing checks (round {k} of {total}).",
            "review": f"Sent the review comments from {_who(authors)} (round {k} of {total}).",
            "conflict": f"Sent the conflicts with {rec.base} (round {k} of {total}).",
        }
        self.note(rec, words.get(kind, ""))
        self.save()

    def turn_over(self, rec: PullRecord, task: Any, status: str) -> None:
        """The session's turn after a follow-up is over: what it cost goes on the pull
        request and the day; past its ceiling it stops."""
        st = self.state(rec)
        if st is None or not st["pending"] or st["pending"].get("task") != task.id:
            return
        now = float(task.cost_usd or 0.0)
        before = float(st["pending"].get("cost") or 0.0)
        cost = max(0.0, now - before) if now >= before else now  # (a new session: from 0)
        st["spent"] = round(st["spent"] + cost, 4)
        self.day_spent()
        self.day["spent"] = round(self.day["spent"] + cost, 4)
        st["pending"] = {**st["pending"], "task": 0} if status == "done" else {}
        self.note(
            rec, f"The round cost ${cost:.2f}; ${st['spent']:.2f} of ${st['spend_cap']:.2f} so far."
        )
        if st["on"] and st["spent"] >= st["spend_cap"]:
            self.stop(rec, "spend")
            return
        self.save()

    async def pushed(self, rec: PullRecord, kind: str, plan: Any) -> None:
        """The session's work after a round is on GitHub: said in the log, and for review
        comments, a fixed line on the pull request naming the commit and whom it answers."""
        st = self.state(rec)
        if st is None or not st["on"]:
            return
        sha = (await asyncio.to_thread(git, plan.top, "rev-parse", "--short=7", "HEAD")).out.strip()
        self.note(rec, f"Pushed {sha}.")
        authors = list((st.get("pending") or {}).get("authors") or [])
        st["pending"] = {}
        if kind == "review" and authors and sha:
            who = _who(authors)
            body = f"Eden Code pushed {sha} to address the review comments from {who}."
            if await self.post(rec, body):
                self.note(rec, f"Posted on the pull request: {sha} answers {who}.")
        self.refresh(rec)

    async def post(self, rec: PullRecord, body: str) -> bool:
        """A fixed line on the pull request (in the owner's GitHub name). Its id is marked
        seen at once: code_pr never takes Eden's own line for a reviewer's comment."""
        try:
            made = await self.desk.client.comment(self.desk._ref(rec), rec.number, body)
        except github.GitHubError as exc:
            log.info("keep it green: couldn't comment on %s: %s", rec.key, exc)
            return False
        if type(made.get("id")) is int:
            rec.seen = [*rec.seen, made["id"]][-500:]
            self.desk.save()
        return True

    async def polled(
        self, rec: PullRecord, ref: github.RepoRef, runs: list, statuses: list
    ) -> None:
        """A look at the pull request: its preview link (once per head commit), posted once
        for each address; the owner's tunnel, once."""
        st = self.state(rec)
        if st is None or not st["on"] or not rec.head_sha:
            return
        changed = False
        if st["preview_sha"] != rec.head_sha:
            deployments: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
            try:
                for d in (await self.desk.client.deployments(ref, rec.head_sha))[:3]:
                    if isinstance(d, dict) and type(d.get("id")) is int:
                        rows = await self.desk.client.deployment_statuses(ref, d["id"])
                        deployments.append((d, rows))
            except github.GitHubError as exc:
                log.info("keep it green: deployments of %s: %s", rec.key, exc)
            found = preview_from(deployments, runs, statuses)
            if found:
                st["preview"], st["preview_sha"] = found, rec.head_sha
                changed = True
            elif not any(c.get("status") != "completed" for c in runs if isinstance(c, dict)):
                st["preview_sha"] = rec.head_sha  # (every check is done: nothing more is coming)
        for url, words in ((st["preview"], "Preview"),
                           (st["tunnel"], "Preview (the dev server, through the owner's tunnel)")):  # fmt: skip
            if url and url not in st["posted"]:
                if await self.post(rec, f"{words}: {url}"):
                    st["posted"] = [*st["posted"], url][-20:]
                    self.note(rec, f"Posted the preview link: {url}")
                    changed = True
        if changed:
            self.save()

    # ── turning it on, and off ──

    def stop(self, rec: PullRecord, why: str) -> None:
        st = self.prs.setdefault(rec.key, _fresh())
        st["on"], st["push_unasked"], st["stopped"] = False, False, why
        rec.autofix = False  # (code_pr's own fixer doesn't carry on in its place)
        words = {
            "owner": "Stopped: you pressed Stop.",
            "rounds": f"Stopped: {st['rounds_cap']} rounds were used.",
            "spend": f"Stopped: it spent ${st['spent']:.2f}, its ceiling.",
        }.get(why, "Stopped.")
        self.note(rec, words)
        if why != "owner":
            self.notify(f"pr-green-stop:{rec.key}:{time.time():.0f}",
                        f"Pull request #{rec.number} stopped keeping itself green: {words}")  # fmt: skip
        self.desk.save()
        self.refresh(rec)

    async def set(self, task: Any, rec: PullRecord, msg: dict[str, Any]) -> str:
        """The pane's switch and caps: turning it on asks on a card with the whole scope,
        so does pushing without asking; off is at once (as Stop)."""
        st = self.prs.setdefault(rec.key, _fresh())
        said = ""
        if "tunnel" in msg:
            raw = str(msg.get("tunnel") or "").strip()
            url = safe_url(raw)
            if raw and not url:
                return "A tunnel's address starts with https:// and has no spaces."
            st["tunnel"], said = url, "Saved."
        try:
            if "rounds" in msg:
                st["rounds_cap"] = min(ROUNDS_MAX, max(1, int(msg["rounds"])))
            if "spend_cap" in msg:
                st["spend_cap"] = round(min(SPEND_MAX, max(0.5, float(msg["spend_cap"]))), 2)
        except (TypeError, ValueError):
            pass
        if "on" in msg:
            want = msg.get("on") is True
            if want and not st["on"]:
                detail = "\n\n".join([
                    "While it's open I keep watching it. Failing checks go to its session "
                    "with their logs (marked as data), for up to "
                    f"{st['rounds_cap']} rounds. Review comments from people who can write "
                    "to the repository go to it too (never by themselves to a session in "
                    "Bypass permissions or Auto), and a line on the pull request says which "
                    f"commit answers them. A conflict with {rec.base} is merged and "
                    "resolved. A preview link is posted when the project has one.",
                    f"It stops by itself at {st['rounds_cap']} rounds or "
                    f"${st['spend_cap']:.2f} for this pull request, and waits for tomorrow "
                    f"past {DAY_ROUNDS} rounds or ${DAY_SPEND:.0f} a day for all of them. "
                    "Every push asks first, unless you choose to push its fixes without "
                    "asking.",
                ])  # fmt: skip
                choice = await self.desk.ask(
                    f"Keep pull request #{rec.number} green?", detail,
                    [("on", "Keep it green"), ("deny", "Not now")],
                )  # fmt: skip
                if choice != "on":
                    self.refresh(rec)
                    return "Not turned on."
                st.update(on=True, stopped="", rounds=0, spent=0.0, since=time.time(),
                          pending={}, told_day="")  # fmt: skip
                rec.autofix, rec.fix_attempts, rec.watch = True, 0, True
                rec.told_failed = ""
                self.note(
                    rec, f"Turned on: up to {st['rounds_cap']} rounds and ${st['spend_cap']:.2f}."
                )
                self.desk.save()
                self.desk.poke(rec.key, after=0)
                said = f"Keeping pull request #{rec.number} green."
            elif not want and st["on"]:
                return await self.halt(rec)
        if "push_unasked" in msg:
            want = msg.get("push_unasked") is True
            if want and not st["push_unasked"]:
                choice = await self.desk.ask(
                    f"Push the fixes for pull request #{rec.number} without asking?",
                    f"After each round, its session's work goes straight to {rec.branch} on "
                    "GitHub, without the push card. Anything in it that looks like a key or "
                    "token still asks first. Turn it off in the pull request pane any time.",
                    [("on", "Push without asking"), ("deny", "Not now")],
                )  # fmt: skip
                if choice == "on":
                    st["push_unasked"] = True
                    self.note(rec, "Fixes are pushed without asking now.")
                    said = said or "Saved."
                else:
                    said = said or "Not turned on."
            elif not want and st["push_unasked"]:
                st["push_unasked"] = False
                self.note(rec, "Pushes ask first again.")
                said = said or "Saved."
        self.refresh(rec)
        return said

    async def halt(self, rec: PullRecord) -> str:
        """Stop: off at once, its automatic follow-ups too, and a round under way ended."""
        st = self.prs.setdefault(rec.key, _fresh())
        under_way = rec.followup and rec.followup_task and st.get("pending")
        self.stop(rec, "owner")
        if under_way:
            with contextlib.suppress(Exception):
                if await self.hub.tasks.interrupt(rec.followup_task):
                    self.note(rec, "Ended the round under way.")
            st["pending"] = {}
            self.refresh(rec)
        return f"Stopped keeping pull request #{rec.number} green."

    # ── window commands ──

    def cmd_set(self, msg: dict[str, Any]) -> None:
        task, rec = self.desk._rec(msg)
        if rec is not None:
            self.desk._run(self.set(task, rec, msg))

    def cmd_stop(self, msg: dict[str, Any]) -> None:
        _task, rec = self.desk._rec(msg)
        if rec is not None:
            self.desk._run(self.halt(rec))


def install(hub: Any) -> None:
    desk = getattr(hub, "code_pr", None)
    if desk is None:  # (code_pr installs first, alphabetically)
        return
    green = Green(hub, desk)
    desk.green = green
    hub.code_pr_green = green  # (for the tests)
    hub.register_command("code_pr_green", green.cmd_set)
    hub.register_command("code_pr_green_stop", green.cmd_stop)
