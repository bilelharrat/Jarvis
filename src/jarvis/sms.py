"""Texts on the Jarvis number: the owner's Twilio number (Settings › Phone) takes SMS as well
as calls. JARVIS looks at the number's incoming texts through Twilio's own API (listing
them is free) and turns each new one into a heads-up. And an approval card left waiting on
the Mac can be answered by text from the owner's own phone, with a one-time code sent with
the question: "YES 4821". Anyone can put the owner's number on a text they send, so the
sender is never enough; the code is, and it can't be guessed in the tries allowed.

This module is the Twilio side and the rules (codes, answers, limits); features/sms_line.py
runs it for the hub. What people text is their words: shown, never taken as instructions.
"""

from __future__ import annotations

import re
import secrets
import time
import unicodedata
import urllib.parse
from collections import deque
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from .phone import API, _request

LOOK_EVERY = 30  # seconds between looks at the number's texts
KEEP = 200  # texts kept to show and to read
SEEN = 2000  # message ids remembered, so none is told twice
ASK_AFTER = 60  # seconds a card waits unanswered on the Mac before it's texted
CODE_TRIES = 3  # wrong codes for one card; past that it's answered on the Mac only
WRONG_PER_HOUR = 5  # wrong codes in an hour before answering by text stops for an hour
TEXTS_PER_HOUR = 10  # approval texts (and their confirmations) sent, at most
TEXTS_PER_DAY = 40
MAX_DETAIL = 200  # characters of a card's detail put in the text
MAX_BODY = 1000  # characters of a text kept


class SmsError(Exception):
    """Something to tell the owner, in words."""


# ── Twilio ──


def inbound(
    number: str, sid: str, token: str, since: datetime, request: Callable[..., dict] = _request
) -> list[dict[str, Any]]:
    """Texts to the number sent since that day, newest first (two pages at most): {sid,
    from, body, at}."""
    query = urllib.parse.urlencode(
        {
            "To": number,
            "DateSent>": (since - timedelta(days=1)).strftime("%Y-%m-%d"),
            "PageSize": 50,
        }
    )
    page = request("GET", f"{API}/Accounts/{sid}/Messages.json?{query}", sid, token)
    found: list[dict[str, Any]] = []
    for _ in range(2):
        for item in page.get("messages") or []:
            if not isinstance(item, dict) or item.get("direction") != "inbound":
                continue
            if not item.get("sid") or not item.get("from"):
                continue
            found.append(
                {
                    "sid": str(item["sid"]),
                    "from": str(item["from"]),
                    "body": str(item.get("body") or "")[:MAX_BODY],
                    "at": _when(item.get("date_sent") or item.get("date_created")),
                }
            )
        more = page.get("next_page_uri")
        if not more:
            break
        page = request("GET", f"https://api.twilio.com{more}", sid, token)
    return found


def send(
    to: str, sender: str, body: str, sid: str, token: str, request: Callable[..., dict] = _request
) -> str:
    """One text from the Twilio number. Twilio's id for it."""
    answer = request(
        "POST",
        f"{API}/Accounts/{sid}/Messages.json",
        sid,
        token,
        data={"To": to, "From": sender, "Body": body},
    )
    return str(answer.get("sid") or "")


def _when(value: Any) -> str:
    """Twilio's RFC 2822 date as local ISO time ("" when there's none)."""
    from email.utils import parsedate_to_datetime

    try:
        moment = parsedate_to_datetime(str(value))
    except (TypeError, ValueError, IndexError):
        return ""
    if moment.tzinfo is not None:
        moment = moment.astimezone().replace(tzinfo=None)
    return moment.isoformat(timespec="seconds")


# ── answers by text ──

_YES = r"yes|y|yep|ok|okay|allow|approved?|confirm(?:ed)?|go|sure|是的?|好的?|行|可以|同意|允许|确认|确定"
_NO = r"no|n|nope|deny|decline|don'?t|cancel|不是|不行|不用|不要|不|否|拒绝|取消"
_ANSWER = re.compile(
    rf"^\W*(?:(?P<a>{_YES}|{_NO})\W*(?P<c>[0-9]{{4}})|(?P<c2>[0-9]{{4}})\W*(?P<a2>{_YES}|{_NO}))\W*$",
    re.IGNORECASE,
)
_CODE = re.compile(r"(?<![0-9])[0-9]{4}(?![0-9])")


def _plain(text: str) -> str:
    """A text as typed on any phone read the one way: full-width letters and digits as
    ASCII (NFKC), the iPhone's curly apostrophe straight, spacing collapsed."""
    text = unicodedata.normalize("NFKC", str(text or "")).replace("\u2019", "'")
    return " ".join(text.split())


def answer(text: str) -> tuple[str, str] | None:
    """("allow" or "deny", the code) for a text that answers a card: a yes or no word and
    the four-digit code, either way round ("YES 4821", "4821 no", "是 4821", "好的 ４８２１").
    None for anything else: a message, a code alone, a yes alone, digits of another script."""
    m = _ANSWER.match(_plain(text))
    if m is None:
        return None
    word = (m.group("a") or m.group("a2")).lower()
    code = m.group("c") or m.group("c2")
    return ("allow" if re.fullmatch(_YES, word, re.IGNORECASE) else "deny"), code


def same_number(a: str, b: str) -> bool:
    digits_a, digits_b = re.sub(r"\D", "", a or ""), re.sub(r"\D", "", b or "")
    return len(digits_a) >= 7 and digits_a[-10:] == digits_b[-10:]


class Challenge:
    """One card texted to the owner: its code, and the wrong codes tried against it."""

    def __init__(self, approval_id: str, code: str, labels: dict[str, str]) -> None:
        self.approval_id = approval_id
        self.code = code
        self.labels = labels  # choice id -> the card's label ("Send", "Don't send")
        self.wrong = 0
        self.told_how = False  # a reply it couldn't read got how to answer, once


class Codes:
    """The codes out there, one per texted card, and how many wrong ones came back: each
    card takes CODE_TRIES wrong codes, and WRONG_PER_HOUR wrong ones in an hour stop
    answering by text for an hour (someone guessing with the owner's number)."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.open: dict[str, Challenge] = {}  # approval id -> its challenge
        self.wrong: deque[float] = deque()
        self.paused_until = 0.0

    def new(self, approval_id: str, labels: dict[str, str]) -> Challenge:
        taken = {c.code for c in self.open.values()}
        while True:
            code = f"{secrets.randbelow(9000) + 1000}"
            if code not in taken:
                break
        challenge = Challenge(approval_id, code, labels)
        self.open[approval_id] = challenge
        return challenge

    def drop(self, approval_id: str) -> None:
        self.open.pop(approval_id, None)

    def mentioned(self, text: str) -> Challenge | None:
        """The open card whose code is in this text, as four digits of its own."""
        for code in _CODE.findall(_plain(text)):
            hit = next(
                (c for c in self.open.values() if secrets.compare_digest(c.code, code)), None
            )
            if hit is not None:
                return hit
        return None

    @property
    def paused(self) -> bool:
        return self.clock() < self.paused_until

    def check(self, code: str) -> Challenge | str:
        """The challenge this code answers; else why not ("paused", "wrong", "spent")."""
        if self.paused:
            return "paused"
        hit = next((c for c in self.open.values() if secrets.compare_digest(c.code, code)), None)
        if hit is not None:
            del self.open[hit.approval_id]
            return hit
        now = self.clock()
        self.wrong.append(now)
        while self.wrong and now - self.wrong[0] > 3600:
            self.wrong.popleft()
        for challenge in list(self.open.values()):  # every open card counts a wrong guess
            challenge.wrong += 1
            if challenge.wrong >= CODE_TRIES:
                del self.open[challenge.approval_id]  # the Mac only, from now on
        if len(self.wrong) >= WRONG_PER_HOUR:
            self.paused_until = now + 3600
            self.wrong.clear()
            return "paused"
        return "wrong"


class Limit:
    """Texts sent: at most per hour and per day."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self.clock = clock
        self.sent: deque[float] = deque()

    def take(self) -> bool:
        now = self.clock()
        while self.sent and now - self.sent[0] > 86400:
            self.sent.popleft()
        if len(self.sent) >= TEXTS_PER_DAY:
            return False
        if sum(1 for t in self.sent if now - t < 3600) >= TEXTS_PER_HOUR:
            return False
        self.sent.append(now)
        return True


def card_text(card: dict[str, Any], code: str, language: str = "en") -> str:
    """The text that carries a card to the owner's phone: the question, a little of its
    detail, and how to answer with the code."""
    question = " ".join(str(card.get("question") or "").split())[:300]
    detail = " ".join(str(card.get("detail") or "").split())
    if len(detail) > MAX_DETAIL:
        detail = detail[: MAX_DETAIL - 1].rstrip() + "…"
    head = (
        f"Jarvis 需要你确认：{question}"
        if language == "zh"
        else f"Jarvis needs your OK: {question}"
    )
    return "\n".join(part for part in (head, detail, how_to_answer(code, language)) if part)


def how_to_answer(code: str, language: str = "en") -> str:
    if language == "zh":
        return f"回复“是 {code}”允许，“否 {code}”拒绝。"
    return f"Reply YES {code} to allow or NO {code} to decline."


def eligible(card: dict[str, Any]) -> bool:
    """A card that can be answered by text: a plain yes or no (its choices allow and deny),
    not a purchase (only "confirm purchase" on the Mac pays), not a Jarvis Code session's
    (they come too often to text)."""
    from .transactions import ASK_KIND

    ids = [c.get("id") for c in card.get("choices") or [] if isinstance(c, dict)]
    return (
        "allow" in ids
        and "deny" in ids
        and not card.get("task_id")
        and card.get("ask_kind") != ASK_KIND
    )
