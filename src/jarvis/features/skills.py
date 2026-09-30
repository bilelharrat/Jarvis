"""Skills for JARVIS itself (jarvis.skills) and the Skill Workshop (jarvis.skill_workshop).

What it registers:
- the "skills" tool server: list_skills, use_skill and read_skill_file (their results are
  skill authors' words: "web" to the turn gate) and make_skill (JARVIS's own words);
- its part of the brain's instructions: the skills switched on and usable on this Mac;
- window commands (each answered with a "skills" event: the list, the proposals, a note):
  skills_state, skills_toggle {name, on}, skills_preview {name} (-> skills_preview),
  skills_remove {name}, skills_install_folder {path}, skills_install_git {url} (a card
  first, then the clone), skills_accept {id}, skills_discard {id}, skills_offer {on};
- the Workshop's turn sink (hub.add_turn_sink): long requests weighed as skills;
- instant words: "make that a skill" (做成技能), drafted without asking Claude;
- the setting skills_offer (prefs.features): offer to keep long requests as skills.

A change to which skills are on reloads the brain's tools and instructions, keeping the
conversation (hub._tools_changed).

Cost policy: the skills themselves call no model. The Workshop's calls are stated in
jarvis.utility_model (skill_triage: the utility model, 20 a day; skill_draft: Sonnet 5.5,
8 a day), drafted after a long request only with the app running.
"""

from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import lang, skills, utility_model
from ..prefs import register_feature_pref
from ..proactive import Alert
from ..skill_workshop import Proposals, Workshop

log = logging.getLogger("jarvis")

register_feature_pref("skills_offer", True)

# "Make that a skill", "turn this into a skill", "save that as a skill", "把刚才的做成技能".
_MAKE = re.compile(
    r"^(?:(?:ok(?:ay)?|hey|please|jarvis)[\s,]+)*(?:please\s+)?"
    r"(?:make|turn|save|keep|remember)\s+(?:that|this|it|what\s+you\s+(?:just\s+)?did)\s+"
    r"(?:as\s+|into\s+|in(?:to)?\s+)?(?:a\s+|an\s+)?(?:new\s+)?skill(?:\s+for\s+next\s+time)?"
    r"[\s,.!]*(?:please|thanks|thank\s+you)?[\s.!]*$",
    re.IGNORECASE,
)
_MAKE_ZH = re.compile(
    r"^(?:好的|请|麻烦|帮我|贾维斯)?[，,\s]*(?:把)?(?:刚才的?|这个|那个|刚刚的?)(?:任务|操作|事情|步骤)?"
    r"(?:做成|存成|保存成|变成|记成)(?:一个)?技能(?:吧|吗)?[。！!]*$"
)

ZH = {
    "I'll draft a skill from that. It'll wait in Settings, under Skills, for you to look over.": "我会把刚才的做成一个技能草稿，放在设置的“技能”里等你看。",
    "There's nothing recent to make a skill from: ask me to do the task first.": "最近没有能做成技能的事：先让我把这件事做一遍吧。",
    "That's today's skill drafts done; try again tomorrow.": "今天的技能草稿已经写够了，明天再试吧。",
    "I drafted a skill from that: {name}. It's in Settings, under Skills, for you to review.": "我把刚才的做成了技能草稿：{name}。在设置的“技能”里，等你审阅。",
    "I couldn't draft that skill: {error}": "没能写出这个技能草稿：{error}",
    "Install skills from {where}?": "要从 {where} 安装技能吗？",
    "Install": "安装",
    "Don't install": "不安装",
    "Installed {n} skill, switched off until you turn it on: {names}.": "已安装 {n} 个技能，在你打开之前是关闭的：{names}。",
    "Installed {n} skills, switched off until you turn them on: {names}.": "已安装 {n} 个技能，在你打开之前都是关闭的：{names}。",
    "Nothing was installed.": "什么都没有安装。",
    "Not installed.": "没有安装。",
    "Skill drafted": "技能草稿",
    "Added {name} to your skills, switched on.": "已把 {name} 加入你的技能，并已打开。",
    "Moved {name} to the Trash.": "已把 {name} 移到废纸篓。",
    "Listed your skills": "列出了你的技能",
    "Used a skill": "用了一个技能",
    "Read a skill's file": "读了技能的一个文件",
    "Drafted a skill": "写了一个技能草稿",
    "That draft isn't there any more.": "那个草稿已经不在了。",
    "Couldn't save that; try again.": "没能保存，请再试一次。",
    # jarvis.skills: why a skill can't be read, used or installed
    "There's no skill like that; it may have been removed.": "没有这样的技能；它可能已经被删除了。",
    "I couldn't save that ({error}).": "没能保存（{error}）。",
    "I couldn't move {name} to the Trash ({error}).": "没能把 {name} 移到废纸篓（{error}）。",
    "That isn't a folder.": "那不是一个文件夹。",
    "That folder can't be read.": "那个文件夹读不了。",
    "There's no skill in that folder: a skill is a folder with a SKILL.md.": "那个文件夹里没有技能：技能是一个含有 SKILL.md 的文件夹。",
    "It has no SKILL.md.": "它没有 SKILL.md。",
    "Its SKILL.md can't be read ({error}).": "它的 SKILL.md 读不了（{error}）。",
    "Its SKILL.md is far too long.": "它的 SKILL.md 太长了。",
    "Its name isn't one a skill can have (lowercase letters, digits and hyphens).": "它的名字不符合技能的要求（小写字母、数字和连字符）。",
    "It has no description, so Jarvis couldn't tell when to use it.": "它没有描述，所以不知道什么时候该用它。",
    "Another skill has the same name.": "另一个技能用了同样的名字。",
    "It's made for {systems}, not macOS.": "它是为 {systems} 做的，不是 macOS。",
    "It needs {programs}, which this Mac doesn't have.": "它需要 {programs}，这台 Mac 上没有。",
    "It needs one of {programs}, and this Mac has none of them.": "它需要 {programs} 中的一个，这台 Mac 上一个都没有。",
    "It needs {variables} set, and it isn't.": "它需要设置 {variables}，但还没有设置。",
    "it's too big to be a skill (over 10 MB or 300 files)": "它太大了，不像一个技能（超过 10 MB 或 300 个文件）",
    "it's installed already (remove it first to install it again)": "它已经安装了（要重新安装，请先删除它）",
    "Give the repository's address, like https://github.com/owner/skills.": "请给出仓库的地址，比如 https://github.com/owner/skills。",
    "Only https addresses can be cloned, like https://github.com/owner/skills.": "只能克隆 https 地址，比如 https://github.com/owner/skills。",
    "Leave any user name or password out of the address.": "地址里不要包含用户名或密码。",
    "That doesn't look like a repository's address.": "这看起来不像仓库的地址。",
    "I couldn't clone it: {error}": "没能克隆它：{error}",
    "it took too long": "花的时间太长了",
    "the repository is too big (over 100 MB)": "仓库太大了（超过 100 MB）",
    "That skill has no name it can be saved under.": "这个技能没有可以用来保存的名字。",
    "There's a skill called {name} already.": "已经有一个叫 {name} 的技能了。",
    "I couldn't save it ({error}).": "没能保存它（{error}）。",
    "I couldn't keep the draft ({error}).": "没能保留这个草稿（{error}）。",
}
lang.add_texts(ZH)

PROMPT_MAKE = (
    "\n- Skill Workshop: when the owner says to make what you just did into a skill (or to "
    "save it for next time), call make_skill: it drafts one from their latest multi-step "
    "request for them to review in Settings. Never switch skills on yourself."
)


def git_card_detail(url: str) -> str:
    return (
        f"Jarvis clones {url} (its newest version) and installs the skills it finds, each "
        "switched off until you turn it on. Skills are their authors' words: read one before "
        "you turn it on. A skill guides how Jarvis works but never lets it do more: every "
        "action still asks as usual."
    )


class SkillsDesk:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._store: skills.SkillStore | None = None
        self._proposals: Proposals | None = None
        self.workshop = Workshop(hub, lambda: self.proposals, lambda: self.store)
        self.workshop.on_change = self._drafted
        self.clone = skills.install_git  # tests put a stand-in here

    # Read at first use, never at install: installing only registers.
    @property
    def store(self) -> skills.SkillStore:
        if self._store is None:
            hub = self.hub
            self._store = skills.SkillStore(
                hub.feature_path("skills"), hub.feature_path("skills.json")
            )
        return self._store

    @property
    def proposals(self) -> Proposals:
        if self._proposals is None:
            self._proposals = Proposals(self.hub.feature_path("skill_proposals.json"))
        return self._proposals

    def tr(self, text: str, **values: Any) -> str:
        return lang.tr(text, self.hub.language, **values)

    # ── the window ──

    def payload(self, note: str = "", error: str = "") -> dict[str, Any]:
        return {
            "items": self.store.public(),
            "proposals": self.proposals.public(),
            "offer": bool(self.hub.prefs.feature("skills_offer")),
            "folder": str(self.store.folder),
            "note": note,
            "error": error,
        }

    async def publish(self, note: str = "", error: str = "") -> None:
        language = self.hub.language
        data = await asyncio.to_thread(
            self.payload, lang.translate(note, language), lang.translate(error, language)
        )
        for item in data["items"]:
            item["problems"] = [lang.translate(p, language) for p in item["problems"]]
        self.hub.emit("skills", **data)

    def _reload_brain(self) -> None:
        """The brain's list of skills changed: its instructions and tools again, keeping
        the conversation."""
        self.hub._tools_changed()

    async def state(self, _msg: dict[str, Any]) -> None:
        self.store.changed()
        await self.publish()

    async def toggle(self, msg: dict[str, Any]) -> None:
        try:
            await asyncio.to_thread(
                self.store.set_enabled, str(msg.get("name", "")), bool(msg.get("on"))
            )
        except ValueError as exc:
            await self.publish(error=str(exc))
            return
        self._reload_brain()
        await self.publish()

    async def preview(self, msg: dict[str, Any]) -> None:
        name = str(msg.get("name", ""))
        found = await asyncio.to_thread(self.store.instructions, name)
        if found is None:
            self.hub.emit("skills_preview", name=name, text="", files=[])
            return
        skill, body = found
        files = await asyncio.to_thread(skills.skill_files, skill.folder, 50)
        self.hub.emit(
            "skills_preview",
            name=skill.name,
            text=body[: skills.MAX_BODY],
            files=[f for f, _ in files],
        )

    async def remove(self, msg: dict[str, Any]) -> None:
        try:
            name = await asyncio.to_thread(self.store.remove, str(msg.get("name", "")))
        except ValueError as exc:
            await self.publish(error=str(exc))
            return
        self._reload_brain()
        await self.publish(note=self.tr("Moved {name} to the Trash.", name=name))

    def _installed_note(self, done: dict[str, Any]) -> tuple[str, str]:
        names = done["installed"]
        skipped = [
            f"{label}: {lang.translate(why, self.hub.language)}" for label, why in done["skipped"]
        ]
        if not names:
            why = "; ".join(skipped[:5])
            return "", self.tr("Nothing was installed.") + (f" {why}" if why else "")
        template = (
            "Installed {n} skill, switched off until you turn it on: {names}."
            if len(names) == 1
            else "Installed {n} skills, switched off until you turn them on: {names}."
        )
        more = f" ({'; '.join(skipped[:3])})" if skipped else ""
        return self.tr(template, n=len(names), names=", ".join(names)) + more, ""

    async def install_folder(self, msg: dict[str, Any]) -> None:
        """The owner picked the folder in Settings: that choice is their OK."""
        raw = str(msg.get("path", "")).strip()
        if not raw:
            return
        try:
            done = await asyncio.to_thread(self.store.install_folder, Path(raw), f"folder:{raw}")
        except ValueError as exc:
            await self.publish(error=str(exc))
            return
        note, error = self._installed_note(done)
        await self.publish(note=note, error=error)

    async def install_git(self, msg: dict[str, Any]) -> None:
        """A repository to clone: a card (and said) first, showing exactly what's fetched."""
        try:
            url = skills.clean_git_url(msg.get("url"))
        except ValueError as exc:
            await self.publish(error=str(exc))
            return
        where = re.sub(r"^https://", "", url)
        question = self.tr("Install skills from {where}?", where=where)
        self.hub._say(question)
        choice = await self.hub.request_approval(
            question,
            lang.translate(git_card_detail(url), self.hub.language),
            [("allow", self.tr("Install")), ("deny", self.tr("Don't install"))],
        )
        if choice != "allow":
            await self.publish(note=self.tr("Not installed."))
            return
        try:
            done = await self.clone(self.store, url)
        except ValueError as exc:
            await self.publish(error=str(exc))
            return
        note, error = self._installed_note(done)
        await self.publish(note=note, error=error)

    async def accept(self, msg: dict[str, Any]) -> None:
        """A proposal the owner read and added: saved as a skill and switched on (their
        click is the only way one is ever switched on)."""
        item = self.proposals.take(str(msg.get("id", "")))
        if item is None:
            await self.publish(error="That draft isn't there any more.")
            return
        try:
            name = await asyncio.to_thread(
                self.store.install_text, item["name"], item["text"], "drafted by Jarvis"
            )
            await asyncio.to_thread(self.store.set_enabled, name, True)
        except ValueError as exc:
            self.proposals.items.insert(0, item)
            await self.publish(error=str(exc))
            return
        try:
            self.proposals.save()
        except OSError:
            log.warning("skills: couldn't save the proposals after one was added")
        self._reload_brain()
        await self.publish(note=self.tr("Added {name} to your skills, switched on.", name=name))

    async def discard(self, msg: dict[str, Any]) -> None:
        try:
            self.proposals.discard(str(msg.get("id", "")))
        except OSError:
            await self.publish(error="Couldn't save that; try again.")
            return
        await self.publish()

    async def offer(self, msg: dict[str, Any]) -> None:
        self.hub.set_feature_prefs({"skills_offer": bool(msg.get("on"))})
        await self.publish()

    # ── the Workshop ──

    def _drafted(self, item: dict[str, Any]) -> None:
        """A draft is waiting: a heads-up on screen (said only when the owner asked for it)."""
        text = self.tr(
            "I drafted a skill from that: {name}. It's in Settings, under Skills, for you to review.",
            name=item["name"],
        )
        self.hub.notify(
            Alert(f"skill:{item['id']}", "skill", self.tr("Skill drafted"), text),
            speak=bool(item.get("asked")),
        )
        self.hub._spawn(self.publish())

    async def make(self, focus: str = "") -> str:
        """Draft a skill from the latest multi-step request, in the background; what to say."""
        turn = self.workshop.latest()
        if turn is None:
            return "There's nothing recent to make a skill from: ask me to do the task first."
        if utility_model.usage_for(self.hub).left("skill_draft") <= 0:
            return "That's today's skill drafts done; try again tomorrow."
        self.hub._spawn(self._make(turn, focus))
        return "I'll draft a skill from that. It'll wait in Settings, under Skills, for you to look over."

    async def _make(self, turn: dict[str, Any], focus: str) -> None:
        try:
            await self.workshop.draft(turn, focus=focus, asked=True)
        except utility_model.OverBudget:
            self.hub.emit(
                "notice",
                title="Skills",
                text=self.tr("That's today's skill drafts done; try again tomorrow."),
            )
        except Exception as exc:
            log.warning("skill workshop: the draft failed", exc_info=True)
            self.hub.emit(
                "notice",
                title="Skills",
                text=self.tr("I couldn't draft that skill: {error}", error=str(exc)[:200]),
            )

    async def instant(self, text: str) -> str | None:
        said = " ".join(str(text or "").split())
        if not (_MAKE.match(said) or _MAKE_ZH.match(said.replace(" ", ""))):
            return None
        return await self.make()

    # ── the brain ──

    def prompt(self) -> str:
        return self.store.prompt_block() + PROMPT_MAKE

    def build_server(self):
        desk = self

        @tool(
            "make_skill",
            "Draft a skill from the owner's latest multi-step request, when they ask to make "
            "what you just did into a skill. focus: optionally, what they want it to cover. "
            "It waits in Settings for them to review; it's never switched on by itself.",
            {"type": "object", "properties": {"focus": {"type": "string"}}},
        )
        async def make_skill(args):
            said = await desk.make(str(args.get("focus") or "")[:400])
            return {"content": [{"type": "text", "text": said}]}

        tools = [*skills.build_tools(self.store), make_skill]
        return create_sdk_mcp_server(name=skills.SERVER_NAME, version="0.1.0", tools=tools)


def install(hub: Any) -> None:
    desk = SkillsDesk(hub)
    hub.skills = desk
    hub.register_server(
        skills.SERVER_NAME,
        desk.build_server,
        prompt=desk.prompt,
        labels={**skills.LABELS, "make_skill": "Drafted a skill"},
        quiet=("make_skill",),
        web=("list_skills", "use_skill", "read_skill_file"),
    )
    for kind, handler in {
        "skills_state": desk.state,
        "skills_toggle": desk.toggle,
        "skills_preview": desk.preview,
        "skills_remove": desk.remove,
        "skills_install_folder": desk.install_folder,
        "skills_install_git": desk.install_git,
        "skills_accept": desk.accept,
        "skills_discard": desk.discard,
        "skills_offer": desk.offer,
    }.items():
        hub.register_command(kind, handler)
    hub.register_instant(desk.instant)
    hub.add_turn_sink(desk.workshop.heard)
