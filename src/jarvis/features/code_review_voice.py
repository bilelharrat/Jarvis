"""Voice for reviewing a session's changes, in voice-code mode (voicecode.py), in English
and Mandarin. Each is recognized only as a whole, plainly phrased utterance (anything else
still goes to the session as a request):

  keep 1 and 3, undo 2 / 保留第一处和第三处，撤销第二处      keep and undo numbered changes
  undo change 2 / 撤销第二处改动                           undo one change (just that hunk)
  keep them all / 全部保留                                 keep every change
  on change 3, rename that variable / 第三处改动，把…        a comment on that change, to the session
  land it / 合并回去                                        land the session's isolated copy
  review this, deep review / 审查一下，深度审查              run a review
  commit with message fix the login / 提交，信息是修复登录   commit, the card and the secret scan still apply

The numbers are the ones the Changes pane shows. What JARVIS says back goes through
lang's templates. No Claude calls of its own: a review it starts is the Review button's
(see code_review.py for what that costs).
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from .. import code_changes, lang, voicecode
from ..voicecode import Intent

NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "first": 1, "second": 2, "third": 3,
    "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
    "last": -1,
}  # fmt: skip
_VERBS = {
    "keep": "keep", "accept": "keep", "undo": "undo", "revert": "undo", "reject": "undo",
    "drop": "undo",
}  # fmt: skip
_FILLER = {
    "change", "changes", "hunk", "hunks", "the", "and", "number", "numbers", "then", "but",
    "also", "please", "edit", "edits", "ones",
}  # fmt: skip
_EVERY = {"all", "everything", "them", "every"}
_NUM = r"(?:\d{1,3}(?:st|nd|rd|th)?|" + "|".join(NUMBER_WORDS) + r")"
_LEAD = r"^\W*(?:(?:please|okay|ok|so|now|and|jarvis|jervis)\W+)*"
_ON_CHANGE = re.compile(
    _LEAD + r"(?:on|for|in|about|at)\s+(?:the\s+)?(?:(?P<pre>change|hunk|edit)\s+(?:number\s+)?)?"
    rf"(?P<n>{_NUM})(?:\s+(?P<post>change|hunk|edit)s?)?\s*[,:;.—-]?\s+(?P<text>\S.*)$",
    re.IGNORECASE | re.DOTALL,
)
_COMMIT = re.compile(
    _LEAD + r"commit(?:\s+(?:this|that|it|everything|(?:the|my|your|these|those)\s+changes))?"
    r"\s*[,:]?\s*(?:with\s+)?(?:the\s+|a\s+)?(?:commit\s+)?message\b\s*(?:is\s+|saying\s+)?[:,]?\s*"
    r"(?P<m>\S.*)$",
    re.IGNORECASE | re.DOTALL,
)
_LAND = re.compile(
    r"(land|merge)( it| this| that| the (changes|copy|branch|work))?( back)?"
    r"( in(to)? (main|master|the main branch))?( please)?"
)
_REVIEW = re.compile(
    r"(code )?review( this| it| that| (the|my|your|these|those) changes| the diff| the code"
    r"| (what|everything) you (did|changed))?( please)?"
    r"|(do|run|give me) a (quick )?(code )?review( please)?"
)
_DEEP = re.compile(
    r"(do |run )?(a )?deep (code )?review( please)?"
    r"|review( this| it| that| (the|my|your) changes| the code)? (deeply|in depth|thoroughly)( please)?"
)

# ── Mandarin, in lang.py's style ──

_ZH_DIGITS = {
    "零": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
_ZH_NUM = r"(?:\d{1,3}|[一二两三四五六七八九十]{1,3}|最后)"
_ZH_KEEP = ("保留", "接受")
_ZH_UNDO = ("撤销", "撤回", "还原", "去掉", "不要")
_ZH_VERB = re.compile("(" + "|".join(_ZH_KEEP + _ZH_UNDO) + ")")
# What else a clause of numbers may hold: 第, 处/个/项/条, "and", commas, 改动…
_ZH_ALLOWED = re.compile(
    r"(?:第|处|个|项|条|和|跟|与|及|、|,|，|;|；|的|这些|那些|改动|修改|变更|更改|一下|一处|"
    + _ZH_NUM
    + r")*"
)
_ZH_EVERY = re.compile(
    r"^(?:把)?(?:全部|所有|都)(?:的)?(?:改动|修改|变更)?(?:都)?保留$|^保留(?:全部|所有)(?:的)?(?:改动|修改|变更)?$"
)
_ZH_ON = re.compile(
    rf"^(?:在|对|关于)?第?(?P<n>{_ZH_NUM})(?:处|个|项|条)?(?:改动|修改|变更|更改)"
    r"(?:这里|那里|上|里|中)?[，,:：]\s*(?P<text>.+)$",
    re.DOTALL,
)
_ZH_LAND = re.compile(
    r"^(?:把)?(?:它|这个|这个副本|副本|这些改动|改动|工作)?(?:都)?合并(?:回去|回来|进去|吧)?"
    r"(?:(?:进|到)(?:主分支|main|master))?(?:吧)?$"
)
_ZH_REVIEW = re.compile(
    r"^(?:帮我|请|给我)?(?:审查|审核|代码审查|review)(?:一下)?(?:这些|这个|我的|你的)?"
    r"(?:改动|修改|代码|变更)?(?:吧)?$"
)
_ZH_DEEP = re.compile(
    r"^(?:帮我|请|给我)?(?:做个|做一次)?(?:深度|仔细|彻底|认真)(?:地)?(?:审查|审核)(?:一下)?"
    r"(?:这些|这个|我的|你的)?(?:改动|修改|代码|变更)?(?:吧)?$"
)
_ZH_COMMIT = re.compile(
    r"^(?:请|帮我)?提交(?:改动|修改|一下)?[，,：:]?\s*(?:提交)?(?:信息|说明|消息)"
    r"(?:是|写|为|用)?[：:，,]?\s*(?P<m>.+)$",
    re.DOTALL,
)
_ZH_COMMIT_USING = re.compile(
    r"^(?:请|帮我)?用[“\"「]?(?P<m>.+?)[”\"」]?(?:作为|当作)提交(?:信息|说明)(?:来)?提交$",
    re.DOTALL,
)

ZH = {
    "Kept change {n}.": "已保留第 {n} 处改动。",
    "Kept changes {list}.": "已保留第 {list} 处改动。",
    "Kept every change.": "已保留全部改动。",
    "There's no change {n}: there are {count}.": "没有第 {n} 处改动：一共只有 {count} 处。",
    "There are no changes to go by yet.": "还没有可以操作的改动。",
    "Sent your note on change {n}.": "已把你对第 {n} 处改动的意见发过去了。",
    "This session isn't in an isolated copy, so there's nothing to land.": "这个会话不在独立副本里，所以没什么可合并的。",
    "Reviewing; I'll say when it's done.": "正在审查；好了我会告诉你。",
    "Reviewing deeply; it takes a few minutes. I'll say when it's done.": "正在深度审查，要几分钟。好了我会告诉你。",
    "The review found {n} problem, {serious} of them serious. It's on screen.": "审查发现 {n} 个问题，其中 {serious} 个严重。都在屏幕上。",
    "The review found {n} problems, {serious} of them serious. They're on screen.": "审查发现 {n} 个问题，其中 {serious} 个严重。都在屏幕上。",
    "Committed.": "已提交。",
}
lang.add_texts(ZH)


def _number(word: str) -> int | None:
    m = re.fullmatch(r"(\d{1,3})(?:st|nd|rd|th)?", word)
    if m:
        return int(m.group(1))
    return NUMBER_WORDS.get(word)


def zh_number(text: str) -> int | None:
    """二 -> 2, 十二 -> 12, 二十三 -> 23, 7 -> 7, 最后 -> -1 (up to 99)."""
    if text == "最后":
        return -1
    if text.isdigit():
        return int(text)
    if "十" in text:
        tens, _, ones = text.partition("十")
        high = _ZH_DIGITS.get(tens, 1) if tens else 1
        low = _ZH_DIGITS.get(ones, 0) if ones else 0
        return high * 10 + low if tens in ("", *_ZH_DIGITS) and ones in ("", *_ZH_DIGITS) else None
    if len(text) == 1:
        return _ZH_DIGITS.get(text)
    return None


def _hunks(keep: list[int], undo: list[int], every: bool = False) -> Intent:
    return Intent("code_hunks", {"keep": keep, "undo": undo, "keep_all": every})


def parse_hunks_en(said: str) -> Intent | None:
    """ "keep 1 and 3, undo 2", "undo the second change", "keep them all"."""
    words = said.split()
    if not words or words[0] not in _VERBS or len(words) > 16:
        return None
    keep: list[int] = []
    undo: list[int] = []
    every: set[str] = set()
    verb, previous = "", ""
    for word in words:
        n = _number(word)
        if word in _VERBS:
            verb = _VERBS[word]
        elif word == "one" and previous and _number(previous) not in (None, 1):
            pass  # "the second one"
        elif n is not None:
            (keep if verb == "keep" else undo).append(n)
        elif word in _EVERY:
            every.add(verb)
        elif word not in _FILLER:
            return None
        previous = word
    if "undo" in every:
        return None  # undoing everything by voice is Claude's to ask about, not ours
    if not keep and not undo and "keep" not in every:
        return None
    return _hunks(keep, undo, "keep" in every)


def parse_hunks_zh(text: str) -> Intent | None:
    """保留第一处和第三处，撤销第二处 / 撤销第2个修改 / 全部保留."""
    if _ZH_EVERY.fullmatch(text):
        return _hunks([], [], True)
    if not _ZH_VERB.match(text):
        return None
    keep: list[int] = []
    undo: list[int] = []
    for m in re.finditer(_ZH_VERB.pattern + r"([^保接撤还去不]*)", text):
        verb, tail = m.group(1), m.group(2)
        if not _ZH_ALLOWED.fullmatch(tail):
            return None
        numbers = [zh_number(n) for n in re.findall(_ZH_NUM, tail)]
        if not numbers or any(n is None for n in numbers):
            return None
        (keep if verb in _ZH_KEEP else undo).extend(n for n in numbers if n is not None)
    return _hunks(keep, undo) if keep or undo else None


def _zh(raw: str) -> str:
    """An utterance for the Mandarin patterns: simplified, no wake word, no spaces or
    closing punctuation."""
    text = lang.to_simplified(raw).strip()
    text = re.sub(r"^(?:贾维斯|加维斯|jarvis)[，,\s]*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^(?:请|麻烦|那|好的?)[，,\s]*", "", text)
    return re.sub(r"[。！!？?\s]+$", "", text).replace(" ", "")


def parse(said: str, raw: str) -> Intent | None:
    """This module's intents, English or Mandarin; None for anything else."""
    n_words = len(said.split())
    if said and n_words <= 16:
        found = parse_hunks_en(said)
        if found is not None:
            return found
        if n_words <= 10 and _DEEP.fullmatch(said):
            return Intent("code_review", True)
        if n_words <= 10 and _REVIEW.fullmatch(said):
            return Intent("code_review", False)
        if n_words <= 10 and _LAND.fullmatch(said):
            return Intent("code_land")
    m = _ON_CHANGE.match(raw.strip())
    if m and (m.group("pre") or m.group("post")):
        n = _number(m.group("n").lower())
        if n is not None:
            return Intent("code_note", n, m.group("text").strip())
    m = _COMMIT.match(raw.strip())
    if m:
        return Intent("code_commit", text=_message(m.group("m")))
    if not lang.has_cjk(raw):
        return None
    text = _zh(raw)
    found = parse_hunks_zh(text)
    if found is not None:
        return found
    if _ZH_DEEP.fullmatch(text):
        return Intent("code_review", True)
    if _ZH_REVIEW.fullmatch(text):
        return Intent("code_review", False)
    if _ZH_LAND.fullmatch(text):
        return Intent("code_land")
    m = _ZH_ON.match(text)
    if m:
        n = zh_number(m.group("n"))
        if n is not None:
            return Intent("code_note", n, m.group("text").strip())
    m = _ZH_COMMIT.match(text) or _ZH_COMMIT_USING.match(text)
    if m:
        return Intent("code_commit", text=_message(m.group("m")))
    return None


def _message(said: str) -> str:
    """A commit message as said: no quotes around it or full stop after it, a capital."""
    text = said.strip().strip("\"'“”「」").strip()
    text = re.sub(r"[.。]$", "", text).strip()
    return (text[:1].upper() + text[1:])[:500]


def _list(numbers: list[int], zh: bool) -> str:
    items = [str(n) for n in numbers]
    if zh:
        return "、".join(items)
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


# ── carrying them out ──


async def _numbered(hub: Any, task: Any) -> tuple[str, code_changes.View | None]:
    """The view "change 3" counts in, and its name (the session's own, or the branch's
    when the session has none of its own yet)."""
    session = await asyncio.to_thread(code_changes.task_view, task, "session")
    if session is None or session.files:
        return "session", session
    return "branch", await asyncio.to_thread(code_changes.task_view, task, "branch")


async def on_hunks(hub: Any, task: Any, intent: Intent, say: Any) -> None:
    zh = lang.is_zh(hub.language)
    which, view = await _numbered(hub, task)
    numbered = view.numbered() if view is not None else []
    if not numbered:
        say(lang.tr("There are no changes to go by yet.", hub.language))
        return
    count = len(numbered)

    def pick(n: int) -> str | None:
        index = count if n == -1 else n
        found = view.by_number(index) if view is not None else None
        return found[1].id if found else None

    wanted = intent.arg
    for n in [*wanted["keep"], *wanted["undo"]]:
        if pick(n) is None:
            say(
                lang.tr("There's no change {n}: there are {count}.", hub.language, n=n, count=count)
            )
            return
    said: list[str] = []
    hunks = hub.code_hunks
    if wanted["keep_all"]:
        hunks.keep(task, [h.id for _n, _f, h in numbered])
        said.append(lang.tr("Kept every change.", hub.language))
    elif wanted["keep"]:
        hunks.keep(task, [pick(n) for n in wanted["keep"]])
        shown = [count if n == -1 else n for n in wanted["keep"]]
        template = "Kept change {n}." if len(shown) == 1 else "Kept changes {list}."
        said.append(lang.tr(template, hub.language, n=shown[0], list=_list(shown, zh)))
    if wanted["undo"]:
        result = await hunks.undo(task, which, [pick(n) for n in wanted["undo"]])
        said.append(lang.translate(result, hub.language))
    await hunks.changes({"id": task.id, "view": which})
    say(" ".join(said))


async def on_note(hub: Any, task: Any, intent: Intent, say: Any) -> None:
    """ "On change 3, rename that": the comment goes to the session with the change quoted,
    as the Changes pane's comments do."""
    _which, view = await _numbered(hub, task)
    numbered = view.numbered() if view is not None else []
    n = len(numbered) if intent.arg == -1 else intent.arg
    found = view.by_number(n) if view is not None else None
    if found is None:
        say(
            lang.tr(
                "There's no change {n}: there are {count}.", hub.language, n=n, count=len(numbered)
            )
        )
        return
    f, h = found
    excerpt = next((t.strip() for tag, t in h.lines if tag == "+" and t.strip()), "")
    excerpt = excerpt or next((t.strip() for tag, t in h.lines if tag == "-" and t.strip()), "")
    quote = f" (`{excerpt[:80]}`)" if excerpt else ""
    text = f"Review comments:\n- {view.repo.shown(f.path)}:{h.first_changed}{quote} — {intent.text}"
    hub.tasks.send(task.id, text)
    say(lang.tr("Sent your note on change {n}.", hub.language, n=n), follow_up=False)


async def on_land(hub: Any, task: Any, intent: Intent, say: Any) -> None:
    slug = task.workspace.get("slug") if task.workspace else ""
    if not slug:
        say(
            lang.tr(
                "This session isn't in an isolated copy, so there's nothing to land.", hub.language
            )
        )
        return
    said = await hub.code_desk.land(slug, by_voice=True)
    say(lang.translate(said, hub.language), follow_up=False)


async def on_review(hub: Any, task: Any, intent: Intent, say: Any) -> None:
    deep = bool(intent.arg)
    note = (
        "Reviewing deeply; it takes a few minutes. I'll say when it's done."
        if deep
        else "Reviewing; I'll say when it's done."
    )
    say(lang.tr(note, hub.language), follow_up=False)

    async def run() -> None:
        said = await hub.code_reviews.review(task, deep=deep)
        findings = (hub.code_reviews.results.get(task.id) or {}).get("findings") or []
        if findings:
            n = len(findings)
            serious = sum(1 for f in findings if f["severity"] == "high")
            template = (
                "The review found {n} problem, {serious} of them serious. It's on screen."
                if n == 1
                else "The review found {n} problems, {serious} of them serious. They're on screen."
            )
            said = lang.tr(template, hub.language, n=n, serious=serious)
        else:
            said = lang.translate(said, hub.language)
        say(said, follow_up=False)

    hub._spawn(run())


async def on_commit(hub: Any, task: Any, intent: Intent, say: Any) -> None:
    """Commit with the message said: what's staged, or with nothing staged, the session's
    own changes. The card (what goes in) and the secret scan apply as in the Git panel."""
    panel = hub.code_git
    repo = await asyncio.to_thread(code_changes.repo_of, task.cwd)
    if repo is not None:
        staged = await asyncio.to_thread(
            code_changes.diff_files, repo, "", cached=True, untracked=False
        )
        if not staged:
            await panel.stage_session(task)
    said = await panel.commit({"id": task.id, "message": intent.text}, by_voice=True)
    if said.startswith("Committed "):
        hub.emit("caption", text=said)
        said = "Committed."
    say(lang.translate(said, hub.language), follow_up=False)


# Registered when the module loads (the feature kit imports every module here): voicecode
# keeps them for every hub, and hands each handler its own.
voicecode.EXTRA_PARSERS["code_review_voice"] = parse
voicecode.EXTRA_HANDLERS.update(
    {
        "code_hunks": on_hunks,
        "code_note": on_note,
        "code_land": on_land,
        "code_review": on_review,
        "code_commit": on_commit,
    }
)
