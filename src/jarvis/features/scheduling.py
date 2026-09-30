"""The calendar with other people: invitations, finding a time that suits everyone, and the
conversations JARVIS holds for the owner turning into events.

- send_invite adds people to one of the owner's own events through Calendar's script, so
  Calendar sends them the invitation; a card shows exactly who gets invited first ("Send
  the invite").
- find_meeting_time looks for open times across the owner's calendars and, when the Google
  Calendar connector offers free/busy, the other people's too; for anyone it can't see, it
  says so, to ask them (or to let a conversation settle it).
- A conversation (delegate.py) that agrees a time hands it here: a card asks to book it,
  and only a yes puts it in the calendar. One that goes quiet after our message gets one
  gentle nudge after Settings' delay (24 hours unless changed; never, at 0).

create_event itself (notes, alerts, repeats, all-day, a link) is mac_tools' own, made
through EventKit (calendar_kit.create); its card is the permission policy's.

Claude cost policy: nothing here calls a model. The nudge is a fixed sentence; a booking
is a card and an EventKit call; free/busy is the owner's own connector's read-only tool.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import calendar_kit, lang, mac_tools, messaging, prefs

log = logging.getLogger("jarvis")

SERVER_NAME = "calendar"
MAX_INVITEES = 20
MAX_PEOPLE = 8  # people a meeting time is looked for across
NUDGE_CHOICES = (0, 12, 24, 48, 72)
GCAL = "gcal"  # the Google Calendar connector's id (connectors.CATALOG)


def _nudge_hours(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    hours = int(value)
    return hours if 0 <= hours <= 168 else None


prefs.register_feature_pref("delegate_nudge_hours", 24, _nudge_hours)

PROMPT = (
    "\n- Calendar with people: create_event can carry notes, alerts, repeats, all-day days "
    "and a link (a video call's); send_invite then invites people to it by name or address, "
    "after the user sees who. find_meeting_time finds times that suit the user and the "
    "people named (their free/busy through Google Calendar where it's connected and "
    "shared); for anyone it can't see, offer the times and ask them, or use "
    "delegate_conversation to settle it. A time a conversation agrees is offered to the "
    "user to book on a card by itself."
)

LABELS = {
    "send_invite": "Sent calendar invitations",
    "find_meeting_time": "Looked for a time that suits everyone",
}

INVITE_SCRIPT = """on run argv
    set calName to item 1 of argv
    set evUid to item 2 of argv
    set evTitle to item 3 of argv
    set d to current date
    set day of d to 1
    set year of d to (item 4 of argv) as integer
    set month of d to (item 5 of argv) as integer
    set day of d to (item 6 of argv) as integer
    set hours of d to (item 7 of argv) as integer
    set minutes of d to (item 8 of argv) as integer
    set seconds of d to 0
    set addrs to paragraphs of (item 9 of argv)
    tell application "Calendar"
        tell calendar calName
            set hits to (every event whose uid is evUid)
            if (count of hits) is 0 then set hits to (every event whose summary is evTitle and start date is d)
            if (count of hits) is 0 then error "That event isn't in Calendar any more."
            set ev to item 1 of hits
            repeat with a in addrs
                if (contents of a) is not "" then make new attendee at end of attendees of ev with properties {email:(contents of a)}
            end repeat
        end tell
    end tell
end run"""

# Fixed sentences JARVIS shows or says, with their Chinese.
lang.add_texts(
    {
        # mac_tools.creation_question: the card for create_event
        "Add “{title}” to your calendar, {when}, for {minutes} minutes?": "要把“{title}”加到日历吗？时间：{when}，时长{minutes}分钟。",
        "Add “{title}” to your calendar, {when}, for {minutes} minutes, at {place}?": "要把“{title}”加到日历吗？时间：{when}，时长{minutes}分钟，地点：{place}。",
        "Add the all-day “{title}” to your calendar, {when}?": "要把全天日程“{title}”加到日历吗？日期：{when}。",
        "Add the all-day “{title}” to your calendar, {when}, for {count} days?": "要把全天日程“{title}”加到日历吗？从{when}开始，共{count}天。",
        "It repeats every weekday.": "每个工作日重复。",
        "It repeats every week on {days}.": "每周的{days}重复。",
        "It repeats every {count} weeks on {days}.": "每{count}周的{days}重复。",
        "It repeats every day.": "每天重复。",
        "It repeats every {count} days.": "每{count}天重复一次。",
        "It repeats every month.": "每月重复。",
        "It repeats every {count} months.": "每{count}个月重复一次。",
        "It repeats every year.": "每年重复。",
        "It repeats every {count} years.": "每{count}年重复一次。",
        "Until {day}.": "直到{day}。",
        "{count} times in all.": "共{count}次。",
        "Alerts: {alerts}.": "提醒：{alerts}。",
        "At {place}.": "地点：{place}。",
        "Link: {url}": "链接：{url}",
        "Video call: {url}": "视频会议：{url}",
        "Notes: {text}": "备注：{text}",
        "On the {calendar} calendar.": "放在“{calendar}”日历中。",
        # send_invite
        "Send the invite for “{title}” to {people}?": "要把“{title}”的邀请发给{people}吗？",
        "Send the invite for {title}, {when}, to {people}?": "要把{title}（{when}）的邀请发给{people}吗？",
        "Send the invite": "发送邀请",
        # a conversation's agreed time
        "Book “{title}”, {when}, for {minutes} minutes?": "要预约“{title}”吗？时间：{when}，时长{minutes}分钟。",
        "{person} agreed to {when}. Shall I put “{title}” in your calendar?": "{person}同意了{when}。要把“{title}”放进你的日历吗？",
        "Booked “{title}”, {when}.": "已预约“{title}”，时间：{when}。",
        "I couldn't book “{title}”: {error}": "我没能预约“{title}”：{error}",
        "Don't book": "不预约",
        "Sent calendar invitations": "发送了日历邀请",
        "Looked for a time that suits everyone": "找了大家都方便的时间",
    }
)


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out


def _names(people: list[str]) -> str:
    if len(people) <= 2:
        return " and ".join(people)
    return f"{', '.join(people[:-1])} and {people[-1]}"


# ── free/busy through a connector ──


def _schema_keys(schema: Any) -> dict[str, str]:
    props = (schema or {}).get("properties") if isinstance(schema, dict) else None
    return {re.sub(r"[^a-z]", "", k.lower()): k for k in (props or {})}


def freebusy_args(schema: Any, emails: list[str], start: datetime, end: datetime) -> dict | None:
    """Arguments for a connector's free/busy tool, read off its input schema (Google's own
    names or the usual variants): a time range and whose calendars. None when the schema
    asks for something else."""
    keys = _schema_keys(schema)
    props = (schema or {}).get("properties") or {}

    def pick(*names: str) -> str | None:
        return next((keys[n] for n in names if n in keys), None)

    low, high = (
        pick("timemin", "start", "starttime", "from"),
        pick("timemax", "end", "endtime", "to"),
    )
    who = pick("items", "calendarids", "calendars", "emails", "attendees", "ids", "calendarid")
    if not (low and high and who):
        return None
    stamp = "%Y-%m-%dT%H:%M:%SZ"
    args: dict[str, Any] = {
        low: start.astimezone(UTC).strftime(stamp),
        high: end.astimezone(UTC).strftime(stamp),
    }
    field = props.get(who) or {}
    if field.get("type") == "array":
        inner = field.get("items") or {}
        args[who] = [{"id": e} for e in emails] if inner.get("type") == "object" else list(emails)
    elif len(emails) == 1:
        args[who] = emails[0]
    else:
        args[who] = ",".join(emails)
    zone = pick("timezone")
    if zone:
        args[zone] = "UTC"
    return args


def _local(value: Any) -> datetime | None:
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if moment.tzinfo is not None:
        moment = moment.astimezone().replace(tzinfo=None)
    return moment


def busy_from(result: Any, emails: list[str]) -> dict[str, list[tuple[datetime, datetime]] | None]:
    """Each person's busy times from a free/busy answer (Google's shape, {"calendars":
    {address: {"busy": [...], "errors": [...]}}}, or a list of them with ids); None for a
    calendar that came back with errors (not shared, not found). People it doesn't mention
    are left out."""
    texts = [
        c.get("text", "")
        for c in (result or {}).get("content") or []
        if isinstance(c, dict) and c.get("type") == "text"
    ]
    data: Any = None
    for text in texts:
        start = text.find("{")
        if start < 0:
            continue
        try:
            data, _end = json.JSONDecoder().raw_decode(text[start:])
            break
        except ValueError:
            continue
    wanted = {e.lower() for e in emails}
    found: dict[str, list[tuple[datetime, datetime]] | None] = {}

    def spans(rows: Any) -> list[tuple[datetime, datetime]]:
        out = []
        for row in rows if isinstance(rows, list) else []:
            if isinstance(row, dict):
                begin, end = _local(row.get("start")), _local(row.get("end"))
                if begin and end and end > begin:
                    out.append((begin, end))
        return out

    def walk(node: Any, key: str = "", depth: int = 0) -> None:
        if depth > 8:
            return
        if isinstance(node, dict):
            if isinstance(node.get("busy"), list):
                owner = key if key in wanted else ""
                for field in ("id", "email", "calendarId", "calendar_id"):
                    value = str(node.get(field) or "").lower()
                    if not owner and value in wanted:
                        owner = value
                if not owner and len(wanted) == 1:
                    owner = next(iter(wanted))
                if owner:
                    found[owner] = None if node.get("errors") else spans(node["busy"])
            for k, v in node.items():
                walk(v, str(k).lower(), depth + 1)
        elif isinstance(node, list):
            for v in node:
                walk(v, key, depth + 1)

    walk(data)
    return found


class Scheduler:
    """send_invite, find_meeting_time and the booking of a conversation's agreed time. What
    reaches the Mac or a service comes in as a callable (tests pass fakes)."""

    def __init__(
        self,
        hub: Any,
        *,
        run=None,
        events=None,
        create=None,
        lookup=None,
        event_at=None,
        now=datetime.now,
    ) -> None:
        offline = not getattr(hub, "poll", True)
        self.hub = hub
        self.run = run or (_refuse if offline else mac_tools.run_applescript)
        self.events = events or (_no_events if offline else mac_tools.fetch_events)
        self.create = create or (_no_calendar if offline else calendar_kit.create_at)
        self.lookup = lookup or (_no_contacts if offline else messaging.find_contacts)
        self.event_at = event_at or (_no_event if offline else mac_tools._one_event)
        self.now = now
        self._booking: set[asyncio.Task] = set()

    @property
    def language(self) -> str:
        return getattr(self.hub, "language", "en")

    # ── send_invite ──

    async def invite(self, args: dict[str, Any]) -> dict[str, Any]:
        wanted = args.get("invitees") or []
        wanted = [wanted] if isinstance(wanted, str) else wanted if isinstance(wanted, list) else []
        wanted = [str(w).strip() for w in wanted if str(w).strip()]
        if not wanted:
            return _text("Say who to invite: names or email addresses.", True)
        if len(wanted) > MAX_INVITEES:
            return _text(f"At most {MAX_INVITEES} people at a time.", True)
        found = await self.event_at(args)
        if "error" in found:
            return _text(found["error"], True)
        event = found["event"]
        if not event.get("mine"):
            return _text(
                "That's someone else's invitation: only its organizer can invite people.", True
            )
        people: list[tuple[str, str]] = []
        for who in wanted:
            got = await messaging.resolve(who, "email", self.lookup)
            if isinstance(got, str):
                return _text(got, True)
            if got[1].lower() not in {a.lower() for _n, a in people}:
                people.append(got)
        already = {str(a).lower() for a in event.get("attendees") or []}
        people = [
            (n, a) for n, a in people if a.lower() not in already and n.lower() not in already
        ]
        if not people:
            return _text("They're all invited already.")
        when = mac_tools.spoken_when(event["begin"], event["all_day"], self.language)
        names = _names([n for n, _a in people])
        listed = "\n".join(messaging.shown_person(n, a) for n, a in people)
        detail = (
            f"“{event['title']}”, {when} ({event['calendar']} calendar)\n\nInvitees:\n{listed}"
            "\n\nCalendar sends each of them an invitation from your account."
        )
        self.hub._say(f"Send the invite for {event['title']}, {when}, to {names}?")
        choice = await self.hub.request_approval(
            f"Send the invite for “{event['title']}” to {names}?",
            detail,
            [("allow", "Send the invite"), ("deny", "Don't send")],
        )
        if choice != "allow":
            return _text("The user said no. No one was invited.", True)
        begin = datetime.fromisoformat(event["begin"])
        try:
            await self.run(
                INVITE_SCRIPT,
                event["calendar"],
                str(event.get("id") or ""),
                event["title"],
                str(begin.year),
                str(begin.month),
                str(begin.day),
                str(begin.hour),
                str(begin.minute),
                "\n".join(a for _n, a in people),
                timeout=60,
            )
        except mac_tools.ToolFailure as exc:
            return _text(f"Calendar couldn't add them: {exc}", True)
        return _text(f"Invited {names} to “{event['title']}”; Calendar sends the invitations.")

    # ── find_meeting_time ──

    def _freebusy_tool(self) -> tuple[Any, Any] | None:
        """(the live connection, its free/busy tool), Google Calendar's first."""
        connectors = getattr(self.hub, "connectors", None)
        live = dict(getattr(connectors, "live", {}) or {})
        order = sorted(live.items(), key=lambda item: item[0] != GCAL)
        for _conn_id, conn in order:
            if getattr(conn, "status", "") != "connected":
                continue
            for t in getattr(conn, "tools", []) or []:
                if re.search(r"free.?busy", str(getattr(t, "name", "")), re.IGNORECASE):
                    return conn, t
        return None

    async def _their_busy(
        self, emails: list[str], start: datetime, end: datetime
    ) -> dict[str, list[tuple[datetime, datetime]] | None]:
        found = self._freebusy_tool()
        if found is None or not emails:
            return {}
        conn, t = found
        schema = getattr(t, "input_schema", None) or getattr(t, "inputSchema", None)
        args = freebusy_args(schema, emails, start, end)
        if args is None:
            log.info("scheduling: the free/busy tool takes something else")
            return {}
        try:
            result = await asyncio.wait_for(conn.call(t.name, args), 30)
        except Exception as exc:  # the service away, too slow
            log.info("scheduling: free/busy failed (%s)", type(exc).__name__)
            return {}
        if not isinstance(result, dict) or result.get("is_error"):
            return {}
        return busy_from(result, emails)

    async def meeting_time(self, args: dict[str, Any]) -> dict[str, Any]:
        wanted = args.get("people") or []
        wanted = [wanted] if isinstance(wanted, str) else wanted if isinstance(wanted, list) else []
        wanted = [str(w).strip() for w in wanted if str(w).strip()][:MAX_PEOPLE]
        try:
            duration = max(5, min(8 * 60, int(args.get("duration_minutes") or 30)))
            within = max(1, min(30, int(args.get("within_days") or 7)))
            hour0 = max(
                0,
                min(
                    22,
                    int(args.get("earliest_hour") if args.get("earliest_hour") is not None else 9),
                ),
            )
            hour1 = int(args.get("latest_hour") if args.get("latest_hour") is not None else 18)
            hour1 = max(hour0 + 1, min(24, hour1))
            limit = max(1, min(12, int(args.get("limit") or 6)))
        except (TypeError, ValueError):
            return _text("duration_minutes, within_days and the hours must be numbers.", True)
        people: list[tuple[str, str]] = []
        unknown: list[str] = []
        for who in wanted:
            got = await messaging.resolve(who, "email", self.lookup)
            if isinstance(got, str):
                unknown.append(who)
            else:
                people.append(got)
        now = self.now()
        end = mac_tools.midnight(within, now) + timedelta(days=1)
        try:
            mine = await self.events(0, within + 1)
        except mac_tools.ToolFailure as exc:
            return _text(f"I couldn't read your calendar: {exc}", True)
        busy = await self._their_busy([a for _n, a in people], now, end)
        seen = [n for n, a in people if isinstance(busy.get(a.lower()), list)]
        blind = [n for n, a in people if not isinstance(busy.get(a.lower()), list)] + unknown
        theirs = [
            {"begin": b, "end": e, "all_day": False, "title": "busy"}
            for a in {a.lower() for _n, a in people}
            for b, e in (busy.get(a) or [])
        ]
        windows = mac_tools.free_windows(mine + theirs, duration, now, end, hour0, hour1, now)
        # All-day events aren't busy time (a holiday, a birthday): said, as find_free_slots does,
        # so a day away isn't offered without a word.
        allday = sorted(
            {
                f"{ev['begin']:%-d %b} “{ev['title']}”"
                for ev in mine
                if ev.get("all_day") and ev["begin"].date() <= end.date() and ev["end"] > now
            }
        )
        who = "you" + (f" and {_names(seen)}" if seen else "")
        if not windows:
            head = (
                f"No time in the next {within} day(s) between {hour0}:00 and {hour1}:00 when "
                f"{who} are free for {duration} minutes."
            )
        else:
            rows = [f"- {s:%a %-d %b}, {s:%-I:%M %p} – {e:%-I:%M %p}" for s, e in windows[:limit]]
            head = f"Times when {who} are free for {duration} minutes:\n" + "\n".join(rows)
            if allday:
                head += f"\n(all-day events not counted as busy: {', '.join(allday)})"
        if blind:
            if self._freebusy_tool() is None:
                why = (
                    "I can only see your own calendars (Google Calendar's connector, in Tools "
                    "& Accounts, shows people's free/busy where they share it)"
                )
            else:
                why = f"I couldn't see {_names(blind)}'s calendar"
            head += (
                f"\n{why}: offer {_names(blind)} these times and ask, or delegate_conversation "
                "can settle one."
            )
        return _text(head)

    # ── a conversation's agreed time ──

    def agreed(self, d: Any) -> Any:
        """delegate.DelegateEngine.on_agreed: the booking card, in the background (the
        conversation carries on meanwhile)."""
        task = asyncio.ensure_future(self._book(d.id))
        self._booking.add(task)
        task.add_done_callback(self._booked)
        return None

    def _booked(self, task: asyncio.Task) -> None:
        self._booking.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("scheduling: booking failed", exc_info=task.exception())

    async def _book(self, key: str) -> None:
        from ..proactive import Alert

        engine = self.hub.delegate
        d = next((item for item in engine.store.items if item.id == key), None)
        if d is None or not d.meeting:
            return
        meeting = dict(d.meeting)
        engine.note_booking(d.id, "asked")
        start = datetime.fromisoformat(meeting["start"])
        minutes = int(meeting["minutes"])
        when = mac_tools.spoken_when(meeting["start"], False, self.language)
        channel = "iMessage" if d.channel == "imessage" else "email"
        heard = next((t["text"] for t in reversed(d.transcript) if t["from"] == "them"), "")
        detail = f"Agreed with {d.contact} by {channel}."
        place = " ".join(str(meeting.get("place") or "").split())[:200]
        if place:  # it becomes the event's location, and comes from what they wrote
            detail += f"\nAt {place}."
        if heard:
            detail += f"\n{d.contact} wrote: “{heard[:400]}”"
        clash = await self._clashes(start, start + timedelta(minutes=minutes))
        if clash:
            detail += f"\n\nIt overlaps {clash}."
        title = meeting["title"] or f"Meeting with {d.contact}"
        self.hub._say(f"{d.contact} agreed to {when}. Shall I put “{title}” in your calendar?")
        choice = await self.hub.request_approval(
            f"Book “{title}”, {when}, for {minutes} minutes?",
            detail,
            [("allow", "Book"), ("deny", "Don't book")],
        )
        if choice != "allow":
            engine.note_booking(d.id, "declined")
            return
        spec = mac_tools.clean_event(
            {
                "title": title,
                "start": meeting["start"],
                "duration_minutes": minutes,
                "location": meeting.get("place") or "",
                "notes": f"Arranged by Jarvis with {d.contact} by {channel}.",
            },
            # create_event's own default: the calendar named in the settings, if any
            str(getattr(getattr(self.hub, "settings", None), "calendar", "") or ""),
        )
        done = await self.create(spec)
        error = done.get("error") if "created" not in done else ""
        if error == calendar_kit.NO_ACCESS:  # Calendar's own script still adds a plain one
            try:
                argv = mac_tools.event_args(
                    spec["calendar"], title, spec["start"], minutes, spec["location"]
                )
                await self.run(mac_tools.CREATE_EVENT_SCRIPT, *argv, timeout=60)
                error = ""
            except mac_tools.ToolFailure as exc:
                error = str(exc)
        if error:
            text = f"I couldn't book “{title}”: {error}"
        else:
            engine.note_booking(d.id, "booked")
            text = f"Booked “{title}”, {when}."
        self.hub.notify(Alert(f"booked:{uuid.uuid4().hex[:8]}", "delegate", "Conversation", text))

    async def _clashes(self, start: datetime, end: datetime) -> str:
        """What's already on the calendar then, in a few words ("" when nothing, or when the
        calendar can't be read)."""
        now = self.now()
        offset = (start.date() - now.date()).days
        if offset < 0:
            return ""
        try:
            events = await self.events(offset, 1)
        except mac_tools.ToolFailure:
            return ""
        hits = [e for e in events if not e.get("all_day") and e["begin"] < end and e["end"] > start]
        return ", ".join(
            f"“{e['title']}” ({e['begin']:%-I:%M %p}–{e['end']:%-I:%M %p})" for e in hits[:3]
        )


async def _refuse(*_args: Any, **_kwargs: Any) -> str:
    """A hub that doesn't poll (a test's) never runs a script on the real Mac."""
    raise mac_tools.ToolFailure("not on this hub")


async def _no_events(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
    return []


async def _no_calendar(_spec: dict[str, Any]) -> dict[str, Any]:
    return {"error": "not on this hub"}


async def _no_event(_args: dict[str, Any]) -> dict[str, Any]:
    return {"error": "not on this hub"}


async def _no_contacts(_query: str) -> list[dict[str, Any]]:
    return []


def build_tools(scheduler: Scheduler) -> list:
    @tool(
        "send_invite",
        "Invite people to one of the user's own calendar events: Calendar sends them the "
        "invitation from the user's account. Find the event with list_events (or add it with "
        "create_event first), then give its exact title and start (and its calendar if "
        "several share that time), and invitees: names or email addresses. The user sees who "
        "gets invited and says yes first. Only when the user asked to invite them.",
        {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "start": {"type": "string"},
                "calendar": {"type": "string"},
                "invitees": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["title", "start", "invitees"],
        },
    )
    async def send_invite(args):
        return await scheduler.invite(args)

    @tool(
        "find_meeting_time",
        "Find times that suit the user and other people for a meeting: the user's own "
        "calendars, and each person's free/busy where Google Calendar is connected and they "
        "share it. people: names or email addresses. duration_minutes (default 30), "
        "within_days (default 7), earliest_hour/latest_hour (default 9 and 18), limit. It "
        "says whose calendars it couldn't see: offer those people the times and ask them. "
        "Read-only; book with create_event and send_invite.",
        {
            "type": "object",
            "properties": {
                "people": {"type": "array", "items": {"type": "string"}},
                "duration_minutes": {"type": "integer"},
                "within_days": {"type": "integer"},
                "earliest_hour": {"type": "integer"},
                "latest_hour": {"type": "integer"},
                "limit": {"type": "integer"},
            },
            "required": ["people"],
        },
    )
    async def find_meeting_time(args):
        return await scheduler.meeting_time(args)

    return [send_invite, find_meeting_time]


def install(hub: Any) -> None:
    scheduler = Scheduler(hub)
    hub.scheduler = scheduler
    hub.register_server(
        SERVER_NAME,
        lambda: create_sdk_mcp_server(
            name=SERVER_NAME, version="0.1.0", tools=build_tools(scheduler)
        ),
        prompt=PROMPT,
        labels=LABELS,
        quiet=("send_invite",),
    )
    engine = getattr(hub, "delegate", None)
    if engine is not None:
        engine.on_agreed = scheduler.agreed
        engine.nudge_hours = lambda: hub.prefs.feature("delegate_nudge_hours")
