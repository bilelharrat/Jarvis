"""Invitations that clash: a new invite on the calendar (one the owner hasn't answered) that
breaks one of their time rules ("no meetings before 10", "keep Fridays free", "nothing
after 6", "keep 12 to 1 free") or lands on something they're already going to raises a
heads-up, with a reply suggested: two free times that keep the rules, as a draft the owner
copies into their answer or opens in Mail. Nothing is ever sent.

- The rules are the owner's constraints (goals.py) that read as one of these: no meetings
  before a time or after one; none on some days (weekends, Fridays); a span of the day kept
  free; mornings, afternoons or evenings kept free (on some days, or every day). English
  and Chinese. A constraint that doesn't read as a time rule isn't judged: no model reads
  anyone's invitation.
- Double-booking: another event on the calendar at the same time that the owner made or
  accepted.
- Each invite is looked at once, when it arrives (moved to another time, it's a new one),
  from the calendar the proactive parts share; what was looked at is kept a month.
- The invite's title is someone else's words: quoted short, left out when it reads like
  instructions for an AI, and never sent to Claude with the heads-up (only when and why).

Window: the heads-up (kind "clash"), then {"type": "proactive", "clash": {key, reply,
mail}} for its card's Copy reply and Draft in Mail; {"type": "clash_reply", key} opens the
draft (to the organizer, when the calendar has their address).
Settings (prefs.features): clash_alerts (on).

Cost: no model calls.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from ... import jsonstore, lang, prefs
from ...lang import LazyPattern
from ...proactive import Alert, event_key
from .briefing import quote

log = logging.getLogger("jarvis")

AHEAD = timedelta(days=14)
KEEP_DAYS = 30
STATE_FILE = "clashes.json"
DAY_START, DAY_END = 9 * 60, 18 * 60  # where free times are looked for
STEP = 30  # minutes between the times tried
MORNING, AFTERNOON, EVENING = (0, 12 * 60), (12 * 60, 17 * 60), (17 * 60, 24 * 60)

prefs.register_feature_pref("clash_alerts", True)

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
ZH_DAYS = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}


@dataclass
class Rule:
    """A time rule: kind before|after|days|span; minutes of the day; days (0 = Monday) it
    holds on (all when empty); the constraint as the owner said it."""

    kind: str
    start: int = 0
    end: int = 0
    days: frozenset[int] = frozenset()
    text: str = ""

    def on(self, day: date) -> bool:
        return not self.days or day.weekday() in self.days


# ── reading the rules ──

_MEETINGS = r"(?:meetings?|calls?|events?|appointments?|anything|nothing|work)"
_NO = (
    r"(?:nothing|no|zero|never|don'?t\s+(?:book|schedule|put)\s+(?:me\s+|anything\s+)?|avoid)"
    rf"\s*{_MEETINGS}?"
)
_T = r"(?P<{name}>noon|midday|midnight|\d{{1,2}}(?:[:.]\d{{2}})?\s*(?:a\.?m\.?|p\.?m\.?)?)"
_DAY_WORD = r"(?:weekends?|weekdays?|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)"


def _days_en(name: str = "days") -> str:
    """Days said as a group named name ("Fridays", "Mondays and Wednesdays", "weekends")."""
    return rf"(?P<{name}>{_DAY_WORD}(?:\s*(?:,|and|or|&)\s*{_DAY_WORD})*)"


def _part_en(name: str = "part") -> str:
    return rf"(?P<{name}>mornings?|afternoons?|evenings?|nights?)"


def _time(text: str | None, rule: str = "") -> int | None:
    """Minutes of the day in a time said: "10", "10:30am", "6 pm", "noon". An hour with no
    am or pm from 1 to 6 is the afternoon (meetings "after 6" end the working day)."""
    if not text:
        return None
    said = text.strip().lower().replace(" ", "")
    for spelled, half in (("a.m.", "am"), ("p.m.", "pm"), ("a.m", "am"), ("p.m", "pm")):
        said = said.replace(spelled, half)
    said = said.rstrip(".").replace(".", ":")  # 10.30 is 10:30
    if said in ("noon", "midday"):
        return 12 * 60
    if said == "midnight":
        return 24 * 60 if rule == "after" else 0
    m = re.fullmatch(r"(\d{1,2})(?:[:.](\d{2}))?(am|pm)?", said)
    if not m:
        return None
    hour, minute, half = int(m.group(1)), int(m.group(2) or 0), m.group(3)
    if minute > 59 or hour > 23 or (half and not 1 <= hour <= 12):
        return None
    if half == "pm" and hour != 12:
        hour += 12
    elif half == "am" and hour == 12:
        hour = 0
    elif not half and 1 <= hour <= 6:
        hour += 12
    return hour * 60 + minute


def _days(text: str | None) -> frozenset[int]:
    found: set[int] = set()
    for word in re.findall(r"[a-z]+", (text or "").lower()):
        if word.startswith("weekend"):
            found |= {5, 6}
        elif word.startswith("weekday"):
            found |= {0, 1, 2, 3, 4}
        else:
            found |= {i for i, name in enumerate(WEEKDAYS) if name.startswith(word[:3])}
    return frozenset(found)


def _part(text: str | None) -> tuple[int, int]:
    word = (text or "").lower()
    if word.startswith("morning"):
        return MORNING
    if word.startswith("afternoon"):
        return AFTERNOON
    return EVENING


_EN_RULES: list[tuple[str, LazyPattern]] = [
    (
        "before",
        LazyPattern(
            rf"\b{_NO}\s+(?:before|until|till)\s+{_T.format(name='t')}"
            rf"(?:\s+on\s+{_days_en()})?",
            re.IGNORECASE,
        ),
    ),
    (
        "after",
        LazyPattern(
            rf"\b{_NO}\s+(?:after|past|later\s+than)\s+{_T.format(name='t')}"
            rf"(?:\s+on\s+{_days_en()})?"
            rf"|\b(?:done|finished|off|out)\s+by\s+{_T.format(name='t2')}",
            re.IGNORECASE,
        ),
    ),
    (
        "span",
        LazyPattern(
            rf"\b(?:{_NO}|keep|block|protect|hold)\s+(?:(?:from|between)\s+)?"
            rf"{_T.format(name='a')}\s*(?:-|–|to|and|until)\s*{_T.format(name='b')}"
            rf"(?:\s+(?:free|clear|open|blocked|for\s+\w+))?(?:\s+on\s+{_days_en()})?",
            re.IGNORECASE,
        ),
    ),
    (
        "part",
        LazyPattern(
            rf"\b(?:keep|protect|block|hold)\s+(?:my\s+)?(?:{_days_en()}\s+)?{_part_en()}\s+"
            rf"(?:free|clear|open|for\s+\w+|meeting[\s-]free)"
            rf"|\b{_NO}\s+(?:in\s+the\s+|on\s+)?(?:{_days_en('days2')}\s+)?{_part_en('part2')}\b",
            re.IGNORECASE,
        ),
    ),
    (
        "days",
        LazyPattern(
            rf"\b{_NO}\s+(?:on\s+)?{_days_en()}\b(?!\s+(?:mornings?|afternoons?|evenings?))"
            rf"|\b(?:keep|protect|block)\s+(?:my\s+)?{_days_en('days2')}\s+(?:free|clear|open|"
            rf"meeting[\s-]free)|\b{_days_en('days3')}\s+(?:are|stay)\s+(?:free|meeting[\s-]free|off)",
            re.IGNORECASE,
        ),
    ),
]

_ZH_NUM = r"[0-9零一二两三四五六七八九十]+"
_ZH_T = rf"(?:(?P<{{h}}>上午|早上|中午|下午|晚上)?(?P<{{n}}>{_ZH_NUM})(?:点|:|：)(?P<{{m}}>半|{_ZH_NUM}分?)?)"
_ZH_DAYS = r"(?P<days>(?:周|星期|礼拜)[一二三四五六日天](?:(?:、|和|跟|或)(?:周|星期|礼拜)?[一二三四五六日天])*|周末|工作日)"
_ZH_NOT = (
    r"(?:不(?:要)?(?:开会|安排|约|排)|别(?:安排|约|排)|不接(?:会议|电话)|(?:留|空)(?:出来|着)?)"
)


def _zh_time(prefix: str | None, number: str | None, minutes: str | None) -> int | None:
    hour = lang._zh_int(number or "")
    if hour is None or hour > 24:
        return None
    minute = 0
    if minutes == "半":
        minute = 30
    elif minutes:
        value = lang._zh_int(minutes.rstrip("分"))
        if value is None or value > 59:
            return None
        minute = value
    if prefix in ("下午", "晚上") and hour < 12:
        hour += 12
    elif prefix == "中午" and hour < 6:
        hour += 12
    elif not prefix and 1 <= hour <= 6:
        hour += 12
    return hour * 60 + minute


def _zh_days(text: str | None) -> frozenset[int]:
    if not text:
        return frozenset()
    if text == "周末":
        return frozenset({5, 6})
    if text == "工作日":
        return frozenset({0, 1, 2, 3, 4})
    return frozenset(ZH_DAYS[c] for c in re.findall(r"[一二三四五六日天]", text))


_ZH_RULES: list[tuple[str, LazyPattern]] = [
    (
        "span",
        LazyPattern(
            rf"{_ZH_DAYS}?(?:的)?(?:从)?{_ZH_T.format(h='ha', n='na', m='ma')}\s*(?:到|至|-|–)\s*"
            rf"{_ZH_T.format(h='hb', n='nb', m='mb')}(?:之间)?(?:都|也)?{_ZH_NOT}"
        ),
    ),
    (
        "before",
        LazyPattern(
            rf"{_ZH_DAYS}?{_ZH_T.format(h='h', n='n', m='m')}(?:之前|以前|前)(?:都|也)?{_ZH_NOT}"
        ),
    ),
    (
        "after",
        LazyPattern(
            rf"{_ZH_DAYS}?{_ZH_T.format(h='h', n='n', m='m')}(?:之后|以后|后)(?:都|也)?{_ZH_NOT}"
        ),
    ),
    ("part", LazyPattern(rf"{_ZH_DAYS}?(?:的)?(?P<part>上午|下午|晚上)(?:都|也)?{_ZH_NOT}")),
    ("days", LazyPattern(rf"{_ZH_DAYS}(?:都|也)?{_ZH_NOT}")),
]
_ZH_PARTS = {"上午": MORNING, "下午": AFTERNOON, "晚上": EVENING}


def read_rule(text: str) -> Rule | None:
    """A constraint as a time rule; None when it isn't one this part knows."""
    said = " ".join(str(text or "").split())
    if not said:
        return None
    for kind, pattern in _EN_RULES:
        m = pattern.search(said)
        if not m:
            continue
        found = m.groupdict()
        days = _days(found.get("days") or found.get("days2") or found.get("days3"))
        if kind == "before":
            t = _time(found.get("t"), "before")
            return Rule("before", start=t, days=days, text=said) if t is not None else None
        if kind == "after":
            t = _time(found.get("t") or found.get("t2"), "after")
            return Rule("after", start=t, days=days, text=said) if t is not None else None
        if kind == "span":
            a, b = _time(found.get("a")), _time(found.get("b"))
            if a is None or b is None:
                return None
            if b <= a:
                b += 12 * 60 if b + 12 * 60 > a else 24 * 60
            return Rule("span", start=a, end=min(b, 24 * 60), days=days, text=said)
        if kind == "part":
            start, end = _part(found.get("part") or found.get("part2"))
            return Rule("span", start=start, end=end, days=days, text=said)
        if kind == "days":
            return Rule("days", days=days, text=said) if days else None
    simplified = lang.to_simplified(said)
    for kind, pattern in _ZH_RULES:
        m = pattern.search(simplified)
        if not m:
            continue
        found = m.groupdict()
        days = _zh_days(found.get("days"))
        if kind == "span":
            a = _zh_time(found.get("ha"), found.get("na"), found.get("ma"))
            b = _zh_time(found.get("hb") or found.get("ha"), found.get("nb"), found.get("mb"))
            if a is None or b is None:
                return None
            if b <= a:
                b += 12 * 60
            return Rule("span", start=a, end=min(b, 24 * 60), days=days, text=said)
        if kind in ("before", "after"):
            t = _zh_time(found.get("h"), found.get("n"), found.get("m"))
            return Rule(kind, start=t, days=days, text=said) if t is not None else None
        if kind == "part":
            start, end = _ZH_PARTS[found["part"]]
            return Rule("span", start=start, end=end, days=days, text=said)
        if kind == "days":
            return Rule("days", days=days, text=said) if days else None
    return None


# ── judging an invite ──


def _minutes(moment: datetime) -> int:
    return moment.hour * 60 + moment.minute


def broken(rule: Rule, begin: datetime, end: datetime) -> bool:
    """Does an event from begin to end break the rule (on a day it holds)?"""
    if not rule.on(begin.date()):
        return False
    start, finish = _minutes(begin), _minutes(end) if end.date() == begin.date() else 24 * 60
    if rule.kind == "before":
        return start < rule.start
    if rule.kind == "after":
        return finish > rule.start or start >= rule.start
    if rule.kind == "days":
        return True
    return start < rule.end and finish > rule.start  # span


def overlaps(invite: dict[str, Any], events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The owner's other events at the same time: theirs, or ones they accepted."""
    begin, end = invite["begin"], invite["end"]
    key = event_key(invite)
    return [
        e
        for e in events
        if not e.get("all_day")
        and event_key(e) != key
        and e.get("reply") in (None, "", "accepted", "tentative")
        and e["begin"] < end
        and e["end"] > begin
    ]


def free_times(
    invite: dict[str, Any],
    events: list[dict[str, Any]],
    rules: list[Rule],
    now: datetime,
    count: int = 2,
) -> list[datetime]:
    """Times the invite could move to that keep every rule and meet nothing else: the same
    day first, then the next working days, nearest its own time first."""
    length = max(timedelta(minutes=15), invite["end"] - invite["begin"])
    busy = [
        (e["begin"], e["end"])
        for e in events
        if not e.get("all_day")
        and event_key(e) != event_key(invite)
        and e.get("reply") != "declined"
    ]
    found: list[datetime] = []
    day = invite["begin"].date()
    tried = 0
    while len(found) < count and tried < 8:
        if day.weekday() < 5 or day == invite["begin"].date():
            start = datetime.combine(day, datetime.min.time())
            options = []
            for minute in range(DAY_START, DAY_END, STEP):
                at = start + timedelta(minutes=minute)
                until = at + length
                if at <= now or until.date() != day:
                    continue
                if any(broken(r, at, until) for r in rules):
                    continue
                if any(b < until and e > at for b, e in busy):
                    continue
                options.append(at)
            target = _minutes(invite["begin"])
            options.sort(key=lambda at: abs(_minutes(at) - target))
            for at in options:
                if len(found) < count and all(abs((at - f).total_seconds()) >= 3600 for f in found):
                    found.append(at)
        day += timedelta(days=1)
        tried += 1
    return sorted(found)


# ── words ──

TEXTS = {
    "Invitation clash": "邀请冲突",
    "“{title}” {when} clashes with your rule “{rule}”.": "“{title}”（{when}）与你的规则“{rule}”冲突。",
    "“{title}” {when} overlaps {other}.": "“{title}”（{when}）和{other}撞了。",
    "An invitation {when} clashes with your rule “{rule}”.": "一个{when}的邀请与你的规则“{rule}”冲突。",
    "An invitation {when} overlaps {other}.": "一个{when}的邀请和{other}撞了。",
    "The draft is open in Mail for you to read and send.": "草稿已在“邮件”里打开，请你看过再发送。",
    "Mail didn't open the draft ({why}).": "“邮件”没能打开草稿（{why}）。",
    "That invitation's reply isn't here any more.": "那个邀请的回复已经不在了。",
}
lang.add_texts(TEXTS)

REPLY = {
    "en": {
        "thanks": "Thanks for the invite.",
        "before": "I don't take meetings before {t}.",
        "after": "I don't take meetings after {t}.",
        "days": "I keep {days} free of meetings.",
        "span": "I keep {a} to {b} free.",
        "busy": "I already have something then.",
        "ask": "Would {one} or {two} work instead?",
        "ask_one": "Would {one} work instead?",
        "none": "Could we find another time?",
    },
    "zh": {
        "thanks": "谢谢邀请。",
        "before": "我{t}之前不开会。",
        "after": "我{t}之后不开会。",
        "days": "我{days}不安排会议。",
        "span": "我{a}到{b}不安排会议。",
        "busy": "那个时间我已经有安排了。",
        "ask": "改到{one}或{two}可以吗？",
        "ask_one": "改到{one}可以吗？",
        "none": "能换个时间吗？",
    },
}


def _clock(minutes: int, language: str) -> str:
    moment = datetime(2000, 1, 1) + timedelta(minutes=minutes % (24 * 60))
    if language == "zh":
        return lang.clock_zh(
            moment.hour % 12 or 12, moment.minute, "PM" if moment.hour >= 12 else "AM", spoken=False
        )
    return moment.strftime("%-I:%M %p").replace(":00 ", " ")


def _when(moment: datetime, now: datetime, language: str, lead: bool = False) -> str:
    """ "Thursday at 9 AM", "tomorrow at 2:30 PM" (周四上午9点, 明天下午2:30); lead: as it
    follows a title ("on Thursday at 9 AM", "tomorrow at 2:30 PM")."""
    days = (moment.date() - now.date()).days
    clock = _clock(_minutes(moment), language)
    if language == "zh":
        day = (
            "今天"
            if days == 0
            else "明天"
            if days == 1
            else f"周{'一二三四五六日'[moment.weekday()]}"
        )
        if days >= 7:
            day = f"{moment.month}月{moment.day}日"
        return f"{day}{clock}"
    if days == 0:
        return f"today at {clock}"
    if days == 1:
        return f"tomorrow at {clock}"
    on = "on " if lead else ""
    if days < 7:
        return f"{on}{moment:%A} at {clock}"
    return f"{on}{moment:%A %-d %B} at {clock}"


def _day_list(days: frozenset[int], language: str) -> str:
    if days == frozenset({5, 6}):
        return "周末" if language == "zh" else "weekends"
    if language == "zh":
        return "、".join(f"周{'一二三四五六日'[d]}" for d in sorted(days))
    names = [DAY_NAMES[d] + "s" for d in sorted(days)]
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def reply_text(
    rule: Rule | None, slots: list[datetime], now: datetime, language: str = "en"
) -> str:
    """The suggested reply: thanks, why (a rule, or already busy), and times that work."""
    words = REPLY["zh" if language == "zh" else "en"]
    parts = [words["thanks"]]
    if rule is None:
        parts.append(words["busy"])
    elif rule.kind in ("before", "after"):
        parts.append(words[rule.kind].format(t=_clock(rule.start, language)))
    elif rule.kind == "days":
        parts.append(words["days"].format(days=_day_list(rule.days, language)))
    else:
        parts.append(
            words["span"].format(a=_clock(rule.start, language), b=_clock(rule.end, language))
        )
    times = [_when(s, now, language) for s in slots]
    if len(times) >= 2:
        parts.append(words["ask"].format(one=times[0], two=times[1]))
    elif times:
        parts.append(words["ask_one"].format(one=times[0]))
    else:
        parts.append(words["none"])
    return ("" if language == "zh" else " ").join(parts)


# ── the part ──


class Clashes:
    """One hub's check of new invitations against the owner's time rules and calendar."""

    def __init__(self, hub: Any, look: Any) -> None:
        self.hub = hub
        self.look = look
        self.replies: dict[str, dict[str, Any]] = {}  # heads-up key: {reply, to, title}
        self._seen: dict[str, str] | None = None  # invite key: when looked at (ISO)
        self._saved: dict[str, str] = {}  # as last read or written: unchanged isn't saved
        self._now = datetime.now  # the clock (tests set their own)

    def install(self) -> None:
        self.look.listeners.append(self.on_calendar)
        self.hub.register_command("clash_reply", self.reply_command)

    def language(self) -> str:
        return "zh" if lang.is_zh(self.hub.prefs.language) else "en"

    def rules(self) -> list[Rule]:
        store = getattr(self.hub, "goal_store", None)
        if store is not None and hasattr(store, "_retry"):
            store._retry()  # a file that couldn't be read may be readable now
        constraints = getattr(store, "constraints", None) or []
        found = [read_rule(getattr(c, "text", "")) for c in constraints[:60]]
        return [r for r in found if r is not None]

    def on_calendar(self, events: list[dict[str, Any]]) -> list[Alert]:
        """A fresh read of the calendar: invites not looked at yet, judged once each."""
        if not self.hub.prefs.feature("clash_alerts"):
            return []
        now = self._now()
        seen = self._seen_keys()
        rules = self.rules()
        said = []
        for invite in events:
            if invite.get("reply") != "pending" or invite.get("all_day"):
                continue
            if not now < invite["begin"] <= now + AHEAD:
                continue
            key = event_key(invite)
            if key in seen:
                continue
            seen[key] = now.isoformat(timespec="minutes")
            alert = self.judge(invite, events, rules, now)
            if alert is not None:
                self.hub.notify(alert)
                self.hub.emit(
                    "proactive",
                    clash={
                        "key": alert.key,
                        "reply": self.replies[alert.key]["reply"],
                        "mail": bool(self.replies[alert.key]["to"]),
                    },
                )
                said.append(alert)
        self._save(now)
        return said

    def judge(
        self, invite: dict[str, Any], events: list[dict[str, Any]], rules: list[Rule], now: datetime
    ) -> Alert | None:
        """A heads-up when the invite breaks a rule or meets another event; else None."""
        begin, end = invite["begin"], invite["end"]
        rule = next((r for r in rules if broken(r, begin, end)), None)
        others = overlaps(invite, events)
        if rule is None and not others:
            return None
        language = self.language()
        say = lambda template, **v: lang.tr(template, language, **v)  # noqa: E731
        when = _when(begin, now, language, lead=True)
        title = quote(invite.get("title"), 60)
        if rule is not None:
            text = (
                say(
                    "“{title}” {when} clashes with your rule “{rule}”.",
                    title=title,
                    when=when,
                    rule=rule.text,
                )
                if title
                else say(
                    "An invitation {when} clashes with your rule “{rule}”.",
                    when=when,
                    rule=rule.text,
                )
            )
            note = f"an invitation for {_when(begin, now, 'en')} breaks the rule “{rule.text}”"
        else:
            other = quote(others[0].get("title"), 60) or (
                "另一个日程" if language == "zh" else "another event"
            )
            other = f"“{other}”" if quote(others[0].get("title"), 60) else other
            text = (
                say("“{title}” {when} overlaps {other}.", title=title, when=when, other=other)
                if title
                else say("An invitation {when} overlaps {other}.", when=when, other=other)
            )
            note = f"an invitation for {_when(begin, now, 'en')} overlaps another event"
        slots = free_times(invite, events, rules, now)
        key = f"clash:{event_key(invite)}"
        self.replies[key] = {
            "reply": reply_text(rule, slots, now, language),
            "to": str(invite.get("organizer_email") or ""),
            "title": title,
        }
        while len(self.replies) > 50:
            del self.replies[next(iter(self.replies))]
        return Alert(key, "clash", say("Invitation clash"), text, note=note)

    async def reply_command(self, msg: dict[str, Any]) -> None:
        """The card's Draft in Mail: the owner's own tap. A draft; Mail never sends it."""
        from ... import mac_tools
        from .meetings import DRAFT_SCRIPT

        found = self.replies.get(str(msg.get("key") or ""))
        say = lambda template, **v: lang.tr(template, self.language(), **v)  # noqa: E731
        if found is None:
            self.hub.emit("caption", text=say("That invitation's reply isn't here any more."))
            return
        subject = f"Re: {found['title']}" if found["title"] else "Re: your invitation"
        recipients = [found["to"]] if "@" in found["to"] else []
        try:
            await mac_tools.run_applescript(
                DRAFT_SCRIPT, subject, found["reply"], *recipients, timeout=30
            )
        except Exception as exc:  # Mail missing, Automation refused
            self.hub.emit(
                "caption", text=say("Mail didn't open the draft ({why}).", why=str(exc)[:120])
            )
            return
        self.hub.emit("caption", text=say("The draft is open in Mail for you to read and send."))

    # ── what was looked at ──

    def _seen_keys(self) -> dict[str, str]:
        if self._seen is None:
            self._seen = {}
            try:
                data = jsonstore.load_json(self.hub.feature_path(STATE_FILE), dict)
            except OSError as exc:
                log.info("clashes: what was looked at can't be read (%s)", exc)
                data = None
            seen = data.get("seen") if isinstance(data, dict) else None
            if isinstance(seen, dict):
                self._seen = {
                    str(k)[:300]: str(v)[:32]
                    for k, v in list(seen.items())[:2000]
                    if isinstance(v, str)
                }
            self._saved = dict(self._seen)
        return self._seen

    def _save(self, now: datetime) -> None:
        cutoff = (now - timedelta(days=KEEP_DAYS)).isoformat(timespec="minutes")
        self._seen = {k: v for k, v in self._seen_keys().items() if v >= cutoff}
        if self._seen == self._saved:
            return  # nothing new to keep
        try:
            jsonstore.save_json(self.hub.feature_path(STATE_FILE), {"seen": self._seen})
            self._saved = dict(self._seen)
        except OSError as exc:  # looked at again after a restart at worst
            log.info("clashes: couldn't save what was looked at (%s)", exc)
