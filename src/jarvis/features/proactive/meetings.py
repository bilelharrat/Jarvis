"""Meetings: an offer to take notes as a calendar meeting starts, and what follows the notes:
a follow-up email drafted from the action items (a draft only, never sent), and the action
items in Reminders (opt-in).

- The offer: when a meeting on the calendar starts (one with other people in it, or a call
  link), no notes are running and it wasn't declined, a card: "Standup is starting. Take
  notes?" with Take notes (the room's microphone), Notes on the call (the call's own sound
  too, when call notes are on: calls.py) and Not now. A card, never spoken; offered once
  per meeting, and gone after OFFER_MINUTES. Settings: meeting_offer (on).
- After a write-up (the hub's "meeting" event with the notes' path), its card gains Draft
  follow-up and Add to Reminders when it has action items.
  - Draft follow-up: a Mail draft (visible, for the owner to read, change and send; this
    never sends anything) to the meeting's other people as the calendar has them, with the
    summary and the action items. Which meeting it was comes from the calendar: the one the
    offer started, else the one on at the time with other people in it.
  - Add to Reminders: each action item on a Reminders list (meeting_reminders_list, "" for
    the default). With meeting_reminders on (off by default) they go there by themselves
    after each write-up. The items are words from the meeting, so any that read like
    instructions for an AI are left out.
  Only notes files in the meetings folder are ever read.

Window: events "meeting_offer" {key, title, starts, calls} and "proactive" {"meetings":
{followup: {path, title, actions, people, added}}}; commands {"type": "meeting_offer", key,
action: notes|call|dismiss} and {"type": "meeting_followup", path, action: email|reminders}.
Settings (prefs.features): meeting_offer, meeting_reminders, meeting_reminders_list.
Loop: "meeting_offer" (every OFFER_TICK seconds, from the calendar already read).

Cost: no model calls here (the write-up is the meeting notes' own one call, as before).
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from ... import lang, prefs, reminders_desk
from ...meeting import nothing_item
from ...proactive import event_key
from ...textclean import clean_text
from .briefing import quote

log = logging.getLogger("jarvis")

OFFER_TICK = 30
OFFER_EARLY = timedelta(minutes=1)  # offered from a minute before it starts…
OFFER_LATE = timedelta(minutes=5)  # …to five minutes after
OFFER_MINUTES = 15  # a card left this long goes
MAX_ITEMS = 20
MAX_PEOPLE = 20
NOTES_MAX = 400_000  # bytes of a notes file read at most
_CALL = re.compile(
    r"(zoom\.us|meet\.google|teams\.microsoft|teams\.live|webex|whereby|facetime|chime\.aws"
    r"|\bzoom\b|microsoft teams|google meet)",
    re.IGNORECASE,
)
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[A-Za-z]{2,}$")


def clean_list_name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return " ".join(clean_text(value).split())[:80]


prefs.register_feature_pref("meeting_offer", True)
prefs.register_feature_pref("meeting_reminders", False)
prefs.register_feature_pref("meeting_reminders_list", "", clean_list_name)

TEXTS = {
    "{title} is starting. Take notes?": "“{title}”要开始了。要记笔记吗？",
    "The draft is open in Mail for you to read and send.": "草稿已在“邮件”里打开，请你看过再发送。",
    "Mail didn't open the draft ({why}).": "“邮件”没能打开草稿（{why}）。",
    "Added {n} action items to Reminders.": "已把{n}条待办事项加到提醒事项。",
    "Added 1 action item to Reminders.": "已把1条待办事项加到提醒事项。",
    "Reminders didn't take them ({why}).": "提醒事项没能添加（{why}）。",
    "Those notes have no action items.": "这份笔记里没有待办事项。",
    "Those notes aren't there any more.": "那份笔记已经不在了。",
    "Follow-up: {title}": "跟进：{title}",
    "From the meeting “{title}”, {date}.": "来自会议“{title}”，{date}。",
}
lang.add_texts(TEXTS)

EMAIL = {
    "en": {
        "hello": "Hi all,",
        "thanks": "Thanks for today's “{title}”. A quick recap:",
        "actions": "Action items:",
        "bye": "Best,",
    },
    "zh": {
        "hello": "大家好，",
        "thanks": "感谢参加今天的“{title}”。简单回顾一下：",
        "actions": "待办事项：",
        "bye": "祝好，",
    },
}

# Mail's own draft: made visible for the owner, with a To line per address. Nothing sends it.
DRAFT_SCRIPT = """on run argv
    tell application "Mail"
        set m to make new outgoing message with properties {subject:item 1 of argv, content:item 2 of argv, visible:true}
        repeat with i from 3 to count of argv
            tell m to make new to recipient at end of to recipients with properties {address:(item i of argv)}
        end repeat
        activate
    end tell
end run"""


def is_call(event: dict[str, Any]) -> bool:
    """A call: a call link where the meeting is, or the calendar says it's online."""
    where = str(event.get("location") or "")
    return bool(event.get("online")) or bool(_CALL.search(where))


def is_meeting(event: dict[str, Any]) -> bool:
    """Worth offering notes for: others in it, or a call; not all day, not declined."""
    if event.get("all_day") or event.get("reply") == "declined":
        return False
    return bool(event.get("attendees")) or is_call(event)


def sections(notes: str) -> dict[str, list[str]]:
    """The write-up's bullets by section ("summary", "action items"…), up to the transcript."""
    out: dict[str, list[str]] = {}
    current = ""
    for line in notes.splitlines():
        if line.startswith("## "):
            current = line[3:].strip().lower()
            if current == "transcript":
                break
            out.setdefault(current, [])
            continue
        m = re.match(r"\s*[-*]\s+(?:\[[ xX]\]\s+)?(.*)", line)
        if current and m:
            item = " ".join(clean_text(m.group(1)).split())
            if not nothing_item(item):  # "*None*", "No action items.": not an item
                out[current].append(item[:300])
    return out


def covers(event: dict[str, Any] | None, moment: datetime) -> bool:
    """The event is on at this moment (from ten minutes before it starts)."""
    if event is None or not isinstance(event.get("begin"), datetime):
        return False
    end = event.get("end") if isinstance(event.get("end"), datetime) else event["begin"]
    return event["begin"] - timedelta(minutes=10) <= moment <= max(end, event["begin"])


def emails_of(event: dict[str, Any] | None) -> list[str]:
    found = []
    for address in (event or {}).get("emails") or []:
        address = str(address).strip()
        if _EMAIL.match(address) and address.lower() not in (a.lower() for a in found):
            found.append(address)
    return found[:MAX_PEOPLE]


class Meetings:
    """One hub's meeting offers and follow-ups."""

    def __init__(self, hub: Any, look: Any) -> None:
        self.hub = hub
        self.look = look
        self.offers: dict[str, dict[str, Any]] = {}  # key: {event, at}
        self.offered: dict[str, datetime] = {}  # keys offered already (today's)
        self.current: dict[str, Any] | None = None  # the calendar event notes are running for
        self.done: dict[str, dict[str, Any]] = {}  # notes path: {title, actions, summary, event}
        self.calls: Any = None  # calls.Calls, when call notes are installed
        self._now = datetime.now  # the clock (tests set their own)

    def install(self) -> None:
        hub = self.hub
        hub.register_command("meeting_offer", self.offer_command)
        hub.register_command("meeting_followup", self.followup_command)
        hub.register_loop("meeting_offer", self.loop)
        hub.add_event_sink(("meeting",), self.on_meeting)

    def language(self) -> str:
        return "zh" if lang.is_zh(self.hub.prefs.language) else "en"

    def say(self, template: str, **values: Any) -> str:
        return lang.tr(template, self.language(), **values)

    def notes_folder(self) -> Path:
        from ...knowledge import MEETINGS_DIR

        return Path(self.hub.meetings_dir or MEETINGS_DIR)

    # ── the offer ──

    def events(self) -> list[dict[str, Any]]:
        """The calendar as last read: the proactive parts' look, and the heads-up watcher's
        fresher few hours (a meeting added a minute ago), each once."""
        seen, out = set(), []
        watcher = getattr(self.hub, "watcher", None)
        fresh = watcher.known_events() if hasattr(watcher, "known_events") else []
        for e in [*fresh, *self.look.timed()]:
            if not isinstance(e.get("begin"), datetime):
                continue
            key = event_key(e)
            if key not in seen:
                seen.add(key)
                out.append(e)
        return out

    def due(self, now: datetime) -> list[dict[str, Any]]:
        """Meetings starting about now that haven't been offered."""
        if not self.hub.prefs.feature("meeting_offer") or self.hub.meeting is not None:
            return []
        return [
            e
            for e in self.events()
            if is_meeting(e)
            and e["begin"] - OFFER_EARLY <= now <= e["begin"] + OFFER_LATE
            and event_key(e) not in self.offered
        ]

    async def loop(self) -> None:
        while True:
            try:
                self.tick()
            except Exception:  # one bad look never ends the offers
                log.exception("meetings: the offer look failed")
            await asyncio.sleep(OFFER_TICK)

    def tick(self, now: datetime | None = None) -> list[dict[str, Any]]:
        now = now or self._now()
        cutoff = now - timedelta(days=1)
        self.offered = {k: v for k, v in self.offered.items() if v > cutoff}
        stale = now - timedelta(minutes=OFFER_MINUTES)
        self.offers = {k: v for k, v in self.offers.items() if v["at"] > stale}
        made = []
        for event in self.due(now):
            key = event_key(event)
            title = quote(event.get("title"), 80) or "Meeting"
            self.offered[key] = now
            self.offers[key] = {"event": event, "title": title, "at": now}
            calls = self.calls is not None and self.calls.on() and is_call(event)
            self.hub.emit(
                "meeting_offer",
                key=key,
                title=title,
                starts=event["begin"].isoformat(timespec="minutes"),
                calls=calls,
                ttl=OFFER_MINUTES * 60,
            )
            made.append(event)
        return made

    async def offer_command(self, msg: dict[str, Any]) -> None:
        """The offer card's buttons: the owner's own tap."""
        offer = self.offers.pop(str(msg.get("key") or ""), None)
        action = msg.get("action")
        if offer is None or action not in ("notes", "call"):
            return
        self.current = offer["event"]
        if action == "call" and self.calls is not None:
            text = await self.calls.start(offer["title"])
        else:
            text = await self.hub.start_meeting(offer["title"])
        self.hub.emit("caption", text=text)

    # ── after the write-up ──

    def event_at(self, started: datetime) -> dict[str, Any] | None:
        """The meeting on the calendar at this time, with other people in it."""
        return next((e for e in self.events() if e.get("attendees") and covers(e, started)), None)

    async def on_meeting(self, event: dict[str, Any]) -> None:
        """hub.add_event_sink: notes started (which meeting it is), or written up."""
        if event.get("active"):
            try:
                started = datetime.fromisoformat(str(event.get("started")))
            except ValueError:
                started = self._now()
            if not covers(self.current, started):  # not the one the offer started
                self.current = self.event_at(started)
            return
        if event.get("writing") or not event.get("path"):
            return
        meeting, self.current = self.current, None
        notes = await asyncio.to_thread(self.read_notes, str(event["path"]))
        if notes is None:
            return
        found = sections(notes)
        record = {
            "title": str(event.get("title") or "Meeting")[:80],
            "summary": found.get("summary", [])[:MAX_ITEMS],
            "actions": found.get("action items", [])[:MAX_ITEMS],
            "event": meeting,
            "date": self._now().date(),
        }
        self.done[str(event["path"])] = record
        while len(self.done) > 20:
            del self.done[next(iter(self.done))]
        added = 0
        if record["actions"] and self.hub.prefs.feature("meeting_reminders"):
            added, why = await self.to_reminders(record)
            if why:
                log.info("meetings: action items not added (%s)", why)
        self.hub.emit(
            "proactive",
            meetings={
                "followup": {
                    "path": str(event["path"]),
                    "title": record["title"],
                    "actions": len(record["actions"]),
                    "people": len(emails_of(meeting)),
                    "added": added,
                }
            },
        )

    def read_notes(self, path: str) -> str | None:
        """A notes file's text, only from the meetings folder (blocking: in a thread)."""
        try:
            folder = self.notes_folder().resolve()
            target = Path(path).resolve()
        except (OSError, RuntimeError):
            return None
        if target.parent != folder or target.suffix != ".md":
            return None
        try:
            with target.open("rb") as handle:
                return handle.read(NOTES_MAX).decode("utf-8", "replace")
        except OSError:
            return None

    async def record_for(self, path: str) -> dict[str, Any] | None:
        record = self.done.get(path)
        if record is not None:
            return record
        notes = await asyncio.to_thread(self.read_notes, path)
        if notes is None:
            return None
        found = sections(notes)
        title = next((line[2:].strip() for line in notes.splitlines() if line.startswith("# ")), "")
        return {
            "title": title[:80] or "Meeting",
            "summary": found.get("summary", [])[:MAX_ITEMS],
            "actions": found.get("action items", [])[:MAX_ITEMS],
            "event": None,
            "date": self._now().date(),
        }

    async def followup_command(self, msg: dict[str, Any]) -> None:
        """The notes card's Draft follow-up and Add to Reminders: the owner's own tap."""
        record = await self.record_for(str(msg.get("path") or ""))
        if record is None:
            self.hub.emit("caption", text=self.say("Those notes aren't there any more."))
            return
        if not record["actions"]:
            self.hub.emit("caption", text=self.say("Those notes have no action items."))
            return
        if msg.get("action") == "email":
            text = await self.draft(record)
        elif msg.get("action") == "reminders":
            added, why = await self.to_reminders(record)
            if why:
                text = self.say("Reminders didn't take them ({why}).", why=why)
            elif added == 1:
                text = self.say("Added 1 action item to Reminders.")
            else:
                text = self.say("Added {n} action items to Reminders.", n=added)
        else:
            return
        self.hub.emit("caption", text=text)

    def email(self, record: dict[str, Any]) -> tuple[str, str]:
        """The follow-up's subject and body, in the owner's language."""
        words = EMAIL[self.language()]
        title = " ".join(str(record["title"]).split())
        lines = [words["hello"], "", words["thanks"].format(title=title), ""]
        lines += [f"- {item}" for item in record["summary"]]
        lines += ["", words["actions"]]
        lines += [f"- {item}" for item in record["actions"]]
        lines += ["", words["bye"]]
        return self.say("Follow-up: {title}", title=title), "\n".join(lines)

    async def draft(self, record: dict[str, Any]) -> str:
        from ... import mac_tools

        subject, body = self.email(record)
        try:
            await mac_tools.run_applescript(
                DRAFT_SCRIPT, subject, body, *emails_of(record["event"]), timeout=30
            )
        except Exception as exc:  # Mail missing, Automation refused
            return self.say("Mail didn't open the draft ({why}).", why=str(exc)[:120])
        return self.say("The draft is open in Mail for you to read and send.")

    async def to_reminders(self, record: dict[str, Any]) -> tuple[int, str]:
        """Each action item in Reminders: (how many went in, why not, "" when all did)."""
        listed = clean_list_name(self.hub.prefs.feature("meeting_reminders_list")) or ""
        note = self.say(
            "From the meeting “{title}”, {date}.",
            title=record["title"],
            date=record["date"].isoformat(),
        )
        added = 0
        for item in record["actions"]:
            title = quote(item, 200)
            if not title:
                continue  # reads like instructions for an AI: left out
            try:
                spec = reminders_desk.clean_new({"title": title, "list": listed, "notes": note})
            except ValueError:
                continue
            done = await reminders_desk.add_reminder(spec)
            if "added" not in done:
                return added, str(done.get("error") or "Reminders didn't answer")[:160]
            added += 1
        return added, ""
