"""Eden Code: a request to fix bugs is offered to Exterminator Mode first (the owner's ask,
2026-10-13: "I want bug fixes to be Exterminator Mode").

A message to Eden Code that is plainly a bug hunt for the project ("fix the bugs", "find and
fix bugs", "fix this bug", "debug this", "why is the login broken, fix it", "run the tests
and fix failures", "make it production ready", "bug sweep"; and in Chinese, "修复这些 bug",
"调试一下", "排查问题"…) is held on a card before it goes: "This looks like a bug fix. Run
Exterminator Mode on <project>?", with "Exterminator Mode" and "Just this fix".

- Exterminator Mode: features/code_bugfix.py starts exactly as its switch does, its own start
  card first (the rounds, the models, the spending ceiling, the isolated copy), with the
  owner's words as the run's focus (code_bugfix.clean_focus / focus_block: data the
  auditors look at first, never instructions). The message itself isn't sent anywhere.
  When that start card's answer is "Not now" (or the run can't start), the words go back
  in the composer (code_exterminate_draft), so nothing typed is lost.
- Just this fix (and a card left unanswered, which falls to its last choice): the message
  goes on exactly as it came, to every other feature and the hub (marked so it isn't held
  twice), and that session is never asked again.

Which messages: only the composer's own (the window's code-exterminate.js marks task_new
and task_send with bugfix_offer), a new session's first message or one to a session that's
idle. Never a resumed session's, a cloud or Spec start, a slash command, a mention of
another session, a plain wording (/init), an ACP agent's session (Exterminator Mode is
Claude Code's), an Exterminator run's own session, an unattended, issue, Linear, Slack,
routine or queue run (those never come with the mark, and their sessions are skipped
besides), a project with a run on or its start card up, or a session asked once already.
Messages to the same session or project while a card is up wait behind it, in order.

Voice: "Eden, fix the bugs in <project>" (or "fix the bugs" while voice coding, for the
focused session's project; "修复 <project> 的 bug") offers it the same way, by an instant
(hub.register_instant) and a voicecode hook. Both cards are answerable by voice, as
Exterminator Mode's own is; landing still needs a tap and Touch ID, and the S9 voice gates
are untouched (someone else's voice isn't offered anything: the words go on as before).

Window commands: task_new, task_send (with bugfix_offer; the rest are left alone).
Events: code_exterminate_draft {id?, directory, text} (the words back in the composer).
Settings (prefs.features): code_bugfix_offer (on by default), Eden Code settings › General
› "Offer Exterminator Mode for bug fixes".

Cost policy: nothing here calls a model. The detection is local word rules (looks_like_bug_fix),
English and Chinese; what Exterminator Mode spends is its own, behind its own ceiling and card.
Not Labs-gated: it's how the owner asked bug fixes to go.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any

from .. import codesupervisor as cs
from .. import lang, launches, prefs

log = logging.getLogger("jarvis")

PREF = "code_bugfix_offer"
MARK = "bugfix_offer"  # the composer's own messages carry it (web/features/code-exterminate.js)
_DONE = "_code_exterminate"  # set on a message once it has been offered (or needn't be)
SCAN = 400  # characters of a message the rules read: a pasted stack trace comes after

prefs.register_feature_pref(PREF, True)

# ── is it a bug hunt? (local word rules, no model) ──

_EN_YES = [
    re.compile(p, re.I)
    for p in (
        # "fix the bugs", "fix all the bugs", "fix this bug", "fix any bugs you find"
        r"\b(?:fix|squash|kill|hunt(?:\s+down)?|exterminate|find\s+and\s+fix|find\s+&\s+fix)\s+"
        r"(?:(?:all|any|every|each|the|these|those|this|that|some|a|my|our|remaining|other|"
        r"obvious|known|reported|open|outstanding|critical|nasty|weird)\s+){0,3}"
        r"(?:\w+\s+)?bugs?\b",
        r"\bfind\s+(?:the\s+|any\s+|all\s+(?:the\s+)?)?bugs?\b[^.?!]{0,30}\b(?:and|then|&)\s+fix",
        r"\bbugs?\s+(?:sweep|hunt|hunting|bash|squash(?:ing)?|fix(?:ing)?\s+pass)\b",
        r"\bexterminat(?:e|or)\b",
        r"^\s*debug\b(?!\s+(?:mode|log|logs|logging|flag|flags|print|prints|build|menu|panel|output|level|statements?)\b)",
        r"\bdebug\s+(?:this|it|that|why|the\s+(?:crash|failure|error|issue|problem|bug|app|code|tests?))\b",
        r"\b(?:run|rerun|re-run)\s+(?:the\s+|all\s+(?:the\s+)?)?tests?\b[^.?!]{0,30}\b(?:and|then|&)\s+fix",
        r"\bfix\s+(?:the\s+|all\s+(?:the\s+)?|any\s+)?(?:failing|failed|broken|red)\s+tests?\b",
        r"\bfix\s+(?:the\s+|all\s+(?:the\s+)?)?(?:test\s+)?failures\b",
        r"\bmake\s+(?:the\s+)?(?:tests?|suite|ci|build)\s+(?:pass|green)\b",
        r"\b(?:make|get)\s+(?:\w+\s+){0,3}production[-\s]ready\b",
        r"\bwhat'?s\s+(?:broken|wrong)\b[^.?!]{0,40}\bfix\b",
    )
]
# "why is X broken, fix it": something wrong, and a fix asked for
_EN_WRONG = re.compile(
    r"\b(?:broken|not\s+working|doesn'?t\s+work|does\s+not\s+work|isn'?t\s+working|crash(?:es|ed|ing)?|"
    r"fail(?:s|ed|ing)?|errors?|exceptions?|stack\s*trace|traceback|regression|buggy|glitch(?:y|es)?)\b",
    re.I,
)
_EN_FIX = re.compile(r"\b(?:fix|repair|sort\s+(?:it|this)\s+out)\b", re.I)
# A specific small change, not a hunt: no card unless it says "bug" outright as a hunt.
_EN_SMALL = re.compile(
    r"^\s*(?:please\s+)?(?:rename|add|create|make\s+a|implement|build\s+a|write\s+(?:a|the|docs|"
    r"documentation|a\s+readme)|explain|document|refactor|translate|style|restyle|format|move|"
    r"remove|delete|update|upgrade|bump|change|replace|show|tell\s+me|what\s+is|how\s+do)\b",
    re.I,
)
_EN_STRONG = re.compile(
    r"\b(?:find\s+and\s+fix|fix\s+(?:all\s+)?(?:the\s+)?bugs|bugs?\s+(?:sweep|hunt|bash)|"
    r"production[-\s]ready|exterminat)",
    re.I,
)
_EN_NO = re.compile(
    r"\b(?:don'?t|do\s+not|never|no\s+need\s+to|without)\s+(?:\w+\s+){0,2}fix(?:ing)?\b|"
    r"\b(?:bug\s+(?:report|template|tracker|label|bounty)|file\s+a\s+bug|typos?|spelling|lint(?:er|ing)?\s+"
    r"warnings?|indentation|error\s+(?:messages?|text|copy|wording|strings?))\b",
    re.I,
)

_ZH_FIX = r"(?:修复|修掉|修好|修一下|修)"
_ZH_YES = [
    re.compile(p, re.I)
    for p in (
        r"修\s*(?:一下\s*)?(?:这个|这些|那个|那些|所有|全部|项目里?的|代码里?的)?\s*(?:的\s*)?bug",
        r"(?:修复|修掉|修好|改掉)[^。！？]{0,12}(?:bug|缺陷|漏洞|错误|报错|崩溃|故障|问题)",
        r"解决[^。！？]{0,12}(?:bug|报错|崩溃|故障)",
        r"(?:bug|缺陷|报错|崩溃|故障)[^。！？]{0,8}" + _ZH_FIX,
        r"(?:找出|查找|排查|找)[^。！？]{0,10}(?:bug|问题|错误)[^。！？]{0,6}" + _ZH_FIX,
        r"调试(?!模式|日志|信息|输出|器|开关)",
        r"排查(?:一下)?(?:问题|故障|bug|错误|报错)",
        r"(?:捉虫|抓虫|灭虫|除虫)",
        r"(?:跑|运行)(?:一下|一遍)?(?:所有的?|全部)?测试[^。！？]{0,10}" + _ZH_FIX,
        r"修复?(?:一下)?(?:失败|挂掉|没过|不通过)的测试",
        r"(?:让|使)(?:测试|测试套件)(?:全部)?(?:通过|变绿)",
        r"(?:生产就绪|达到上线标准)",
        r"(?:为什么|怎么)[^。！？]{0,20}(?:坏了|不工作|不能用|没反应|崩溃|报错|失败)[^。！？]{0,12}修",
    )
]
_ZH_SMALL = re.compile(
    r"^\s*(?:请)?(?:重命名|改名|添加|加一个|加个|新增|创建|实现|写一个|解释|翻译|删除|移除|更新|升级)"
)
_ZH_STRONG = re.compile(
    r"(?:找出?\s*(?:bug|问题)?\s*并修复|所有\s*(?:的)?\s*bug|全部\s*(?:的)?\s*bug|灭虫|生产就绪)",
    re.I,
)
_ZH_NO = re.compile(
    r"(?:不要|别|先别|不用|无需)修|bug\s*(?:报告|模板)|错别字|拼写|调试(?:模式|日志|信息|输出)"
)


def looks_like_bug_fix(text: str) -> bool:
    """Whether a message is plainly a bug hunt for the project (English or Chinese), by word
    rules only: a hunting phrase, or something wrong said with a fix asked for, and none of
    the negative rules (a specific small change unless it says "find and fix" or the like,
    "don't fix", a bug report, a typo). A slash command, a !command, a # note and an
    @mention of another session are never one."""
    words = " ".join(str(text or "").split())[:SCAN]
    if not words or words[0] in "/!#@":
        return False
    if _EN_NO.search(words) or _ZH_NO.search(words):
        return False
    if (_EN_SMALL.search(words) and not _EN_STRONG.search(words)) or (
        _ZH_SMALL.search(words) and not _ZH_STRONG.search(words)
    ):
        return False
    if any(p.search(words) for p in _EN_YES) or any(p.search(words) for p in _ZH_YES):
        return True
    return bool(_EN_WRONG.search(words) and _EN_FIX.search(words))


# ── what's said ──

ZH = {
    "This looks like a bug fix. Run Exterminator Mode on {project}?": "这看起来是在修 bug。要在 {project} 上运行灭虫模式吗？",
    "Exterminator Mode runs your bug protocol on {project}: 3 rounds of sweep, break and fix in an isolated copy, within a spending ceiling, hunting what you described first. It asks first, with the ceiling and the models. Just this fix sends your message as it is.": "灭虫模式会在 {project} 上运行你的修 bug 流程：在独立副本里做 3 轮“排查、破坏测试、修复”，有花费上限，并先查你说的问题。它会先问你，列出花费上限和模型。“只修这一个”会照原样发送你的消息。",
    "Exterminator Mode": "灭虫模式",
    "Just this fix": "只修这一个",
    "Your message is back in the composer.": "你的消息已放回输入框。",
    "Sent it to a new Eden Code session in {project}.": "已发到 {project} 里一个新的 Eden Code 会话。",
}
lang.add_texts(ZH)

_V_EN = re.compile(
    r"^(?:hey\s+)?(?:eden[,!.]?\s+)?(?:please\s+)?(?:can\s+you\s+|could\s+you\s+)?"
    r"(?:find\s+and\s+)?fix\s+(?:all\s+)?(?:the\s+|any\s+)?bugs"
    r"(?:\s+(?:in|on|for)\s+(?:the\s+)?(?:project\s+)?(?P<project>.+?)(?:\s+project)?)?"
    r"(?:,?\s+please)?[.!?]*$",
    re.I,
)
_V_ZH = re.compile(
    r"^(?:伊甸[，,]?\s*)?(?:请|帮我)?\s*(?:"
    r"(?:修复?|修一下|修掉|修好)\s*(?:一下)?\s*(?P<a>.+?)?\s*(?:的|里的|里面的)?\s*(?:所有\s*)?(?:bug|BUG|Bug)"
    r"|(?:把\s*)?(?P<b>.+?)?\s*(?:的|里的|里面的)?\s*(?:bug|BUG|Bug)\s*(?:都|全部)?\s*(?:修复?|修一下|修掉|修好)(?:一下)?"
    r")\s*(?:吧)?[。！!]?$",
    re.I,
)


class Exterminate:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.asked: set[int] = set()  # sessions offered once already (either answer)
        # …and the launch tokens of the sessions it started itself, by them however late
        # they start (a held task_new): "whichever is new" took another's (REL3-10).
        self.asked_tokens: set[str] = set()
        self.queues: dict[tuple[str, Any], asyncio.Task] = {}
        self.last_said = ""  # what Exterminator Mode's start last said (the voice reply)

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    def say(self, template: str, **values: Any) -> str:
        return lang.tr(template, self.hub.language, **values)

    @property
    def desk(self) -> Any:
        return getattr(self.hub, "code_bugfix", None)

    def on(self) -> bool:
        return self.hub.prefs.feature(PREF) is not False

    # ── where a message is going, and whether it may be offered ──

    def project_of(self, task: Any) -> str:
        """The project a session works on: its folder, or for an isolated copy the project
        it's a copy of (Exterminator Mode makes its own copy of that)."""
        slug = (getattr(task, "workspace", None) or {}).get("slug")
        desk = getattr(self.hub, "code_desk", None)
        if slug and desk is not None:
            try:
                copy = desk.store().find(slug)
            except Exception:
                copy = None
            if copy is not None:
                return str(Path(copy.repo) / copy.prefix.rstrip("/")).rstrip("/")
        return str(task.cwd)

    def name_of(self, project: str) -> str | None:
        try:
            return self.hub.tasks.resolve_dir(project).name
        except (ValueError, OSError):
            return None

    def session_skipped(self, task: Any) -> bool:
        """A session that's never offered: an ACP agent's, an Exterminator run's own, an
        unattended (issue, Linear, Slack, routine) run's, or one asked once already."""
        if (
            task is None
            or getattr(task, "kind", "") != "code"
            or task.id in self.asked
            or (getattr(task, "launch_token", "") or None) in self.asked_tokens
        ):
            return True
        if str(getattr(task, "model", "") or "").startswith("acp:"):
            return True
        desk = self.desk
        if desk is not None and (
            task.id in desk.active
            or any(
                r.task_id == task.id or (r.folder and r.folder == str(task.cwd)) for r in desk.runs
            )
        ):
            return True
        runs = getattr(self.hub, "code_runs", None)
        if runs is not None:
            try:
                if runs.run_of(task) is not None:
                    return True
            except Exception:
                return True
        return False

    def project_free(self, name: str | None) -> bool:
        """Exterminator Mode can be offered there: it's installed, isolated copies are, and
        it isn't on (running, or its start card up) for that project."""
        desk = self.desk
        if not name or desk is None or getattr(self.hub, "code_desk", None) is None:
            return False
        return name not in desk.asking and not self.running_in(name)

    def running_in(self, name: str) -> bool:
        """A run of Exterminator Mode is on for that project now (its desk's active runs:
        BugFix keeps no lookup of its own for this, REL-19 took its unused one away)."""
        desk = self.desk
        return desk is not None and any(r.project == name for r in desk.active.values())

    def offer_for(self, msg: dict[str, Any], kind: str) -> tuple[str, str, Any] | None:
        """(the words, the project, the session or None) when this message is to be
        offered; None when it goes on as it is."""
        if msg.get(_DONE) or msg.get(MARK) is not True or not self.on():
            return None
        if kind == "new":
            if msg.get("session_id") or msg.get("cloud") or msg.get("spec"):
                return None
            if str(msg.get("model") or "").startswith("acp:"):
                return None
            text, project, task = (
                str(msg.get("prompt") or ""),
                str(msg.get("directory") or ""),
                None,
            )
        else:
            from ..hub import _msg_int

            task = self.hub.tasks.tasks.get(_msg_int(msg, "id"))
            if msg.get("plain") is True or self.session_skipped(task) or task.busy:
                return None
            text, project = str(msg.get("text") or ""), self.project_of(task)
        if not looks_like_bug_fix(text) or not self.project_free(self.name_of(project)):
            return None
        return text, project, task

    # ── the composer's messages ──

    def on_new(self, msg: dict[str, Any]) -> bool | None:
        return self._take(msg, "new", ("new", str(msg.get("directory") or "")))

    def on_send(self, msg: dict[str, Any]) -> bool | None:
        from ..hub import _msg_int

        return self._take(msg, "send", ("send", _msg_int(msg, "id")))

    def _take(self, msg: dict[str, Any], kind: str, key: tuple[str, Any]) -> bool | None:
        """False: it goes on now (not ours, and nothing held ahead of it); None: held."""
        if msg.get(_DONE):
            return False
        before = self.queues.get(key)
        found = self.offer_for(msg, kind)
        if found is None and before is None:
            return False
        task = self.hub._spawn(self._hold(msg, kind, found, before))
        self.queues[key] = task
        task.add_done_callback(
            lambda t: self.queues.pop(key) if self.queues.get(key) is t else None
        )
        return None

    async def _hold(self, msg: dict[str, Any], kind: str, found: Any, before: Any) -> None:
        if before is not None:
            await asyncio.wait([before])  # (in order: the one ahead of it first)
            found = self.offer_for(msg, kind)  # (asked once already, maybe, by now)
        if found is None:
            await self.onward(msg, kind, None)
            return
        text, project, task = found
        if task is not None:
            self.asked.add(task.id)
        if await self.ask(project) == "exterminate":
            started = await self.exterminate(project, text)
            if not started:  # its own card said not now: the words back where they were
                self.hub.emit(
                    "code_exterminate_draft",
                    id=task.id if task is not None else None,
                    directory=str(msg.get("directory") or ""),
                    text=text,
                )
                self.hub.emit("caption", text=self.tr("Your message is back in the composer."))
            return
        await self.onward(msg, kind, task)

    async def onward(self, msg: dict[str, Any], kind: str, task: Any) -> None:
        """The message as it came, to the features after this one and the hub; a new
        session it starts is never asked again."""
        if kind != "new":
            await self.hub._handle_logged({**msg, _DONE: True})
            return
        token = str(msg.get(launches.KEY) or "") or launches.token()
        self.asked_tokens.add(token)
        await self.hub._handle_logged({**msg, launches.KEY: token, _DONE: True})

    async def ask(self, project: str, speak: bool = False) -> str:
        name = self.name_of(project) or project
        question = self.say(
            "This looks like a bug fix. Run Exterminator Mode on {project}?", project=name
        )
        if speak:
            self.hub._say(question)
        return await self.hub.request_approval(
            question,
            self.say(
                "Exterminator Mode runs your bug protocol on {project}: 3 rounds of sweep, break and fix in an isolated copy, within a spending ceiling, hunting what you described first. It asks first, with the ceiling and the models. Just this fix sends your message as it is.",
                project=name,
            ),
            [("exterminate", self.tr("Exterminator Mode")), ("plain", self.tr("Just this fix"))],
        )

    async def exterminate(self, project: str, text: str, speak: bool = False) -> bool:
        """Exterminator Mode, started as its switch starts it (its own card first), with the
        words as its focus; whether a run is on for the project now."""
        desk = self.desk
        said = await desk.request(project, speak=speak, focus=text)
        self.hub.emit("caption", text=said)
        desk.publish()
        self.last_said = said
        return self.running_in(self.name_of(project) or "")

    # ── voice ──

    async def project_named(self, spoken: str) -> str | None:
        key = "".join(cs.folder_words(spoken))
        if not key:
            return None
        projects = await asyncio.to_thread(self.hub.tasks.projects)
        return next((p for p in projects if "".join(cs.folder_words(p)) == key), None)

    @staticmethod
    def spoken_ask(text: str) -> tuple[bool, str]:
        """(it's "fix the bugs [in <project>]", the project as said or "")."""
        words = " ".join(str(text or "").split())
        m = _V_EN.match(words)
        if m:
            return True, (m.group("project") or "").strip()
        m = _V_ZH.match(words)
        if m:
            return True, (m.group("a") or m.group("b") or "").strip()
        return False, ""

    async def instant(self, text: str) -> str | None:
        """ "Eden, fix the bugs in <project>": the offer, out loud. Not a project's name (or
        none, with no session in voice focus): not for this feature."""
        ours, spoken = self.spoken_ask(text)
        if not ours or not self.on():
            return None
        focus = getattr(getattr(self.hub, "voicecode", None), "task", None)
        if spoken:
            project = await self.project_named(spoken)
        elif focus is not None and not self.session_skipped(focus):
            project = self.project_of(focus)
        else:
            project = None
        if project is None or not self.project_free(self.name_of(project)):
            return None
        if not await self.hub._voice_allows():
            return None  # (someone else's voice: the words go on as they would have)
        if focus is not None:
            self.asked.add(focus.id)
        if await self.ask(project, speak=True) == "exterminate":
            await self.exterminate(project, text, speak=True)
            return self.last_said
        return await self.plain_by_voice(project, text, focus)

    async def plain_by_voice(self, project: str, text: str, focus: Any) -> str:
        """Just this fix, said: to the session in voice focus when it's in that project
        (as voice coding sends it), else a new session there."""
        vc = getattr(self.hub, "voicecode", None)
        if focus is not None and self.name_of(self.project_of(focus)) == self.name_of(project):
            from ..voicecode import parse as voice_command

            await vc.handle(text, focus, intent=voice_command(text))
            return ""
        token = launches.token()
        self.asked_tokens.add(token)
        await self.hub._handle_logged(
            {
                "type": "task_new",
                "directory": project,
                "prompt": text,
                launches.KEY: token,
                _DONE: True,
            }
        )
        fresh = launches.find(self.hub.tasks, token)
        if fresh is not None:  # (one held back shows itself when it starts)
            self.asked.add(fresh.id)
            self.hub.emit("show_session", id=fresh.id)
        return self.say(
            "Sent it to a new Eden Code session in {project}.",
            project=self.name_of(project) or project,
        )

    async def voice_hook(self, text: str, task: Any) -> bool:
        """Voice coding: "fix the bugs" (or any bug hunt said to the focused session) is
        offered for its project; otherwise voicecode carries on with it."""
        if not self.on() or self.session_skipped(task) or task.busy:
            return False
        ours, spoken = self.spoken_ask(text)
        if not ours and not looks_like_bug_fix(text):
            return False
        project = (await self.project_named(spoken)) if spoken else None
        project = project or self.project_of(task)
        if not self.project_free(self.name_of(project)):
            return False
        if not await self.hub._voice_allows():
            return False
        self.asked.add(task.id)
        self.hub._spawn(self._voice_offer(project, text, task))
        return True

    async def _voice_offer(self, project: str, text: str, task: Any) -> None:
        if await self.ask(project, speak=True) == "exterminate":
            await self.exterminate(project, text, speak=True)
            return
        said = await self.plain_by_voice(project, text, task)
        if said:
            self.hub.say(said)


def install(hub: Any) -> None:
    offer = Exterminate(hub)
    hub.code_exterminate = offer  # (for the tests)
    hub.register_command("task_new", offer.on_new)
    hub.register_command("task_send", offer.on_send)
    hub.register_instant(offer.instant)
    voicecode = getattr(hub, "voicecode", None)
    if voicecode is not None:
        voicecode.hooks.append(offer.voice_hook)
