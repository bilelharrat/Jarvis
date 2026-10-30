"""Eden Calendar (`askedencalendar.com` / `askeden/calendar-worker`) client for Eden Secretary & Eden Code.

When configured via environment variables (or `~/.eden_code/config.json` / `~/.jarvis/config.json`):
  - `EDEN_CALENDAR_URL` (default `https://askedencalendar.com` when `EDEN_CALENDAR_LINK_SECRET` and
    `EDEN_CALENDAR_USER` are set)
  - `EDEN_CALENDAR_LINK_SECRET` (shared 32+ char HMAC secret matching the Worker's `EDEN_LINK_SECRET`)
  - `EDEN_CALENDAR_USER` (the owner's Eden Calendar account email)

`calendar_kit` merges Eden Calendar events and calendars with the Mac's EventKit (or Windows `wincal`)
and routes create/edit/remove/add calls targeting an Eden Calendar (`Eden Calendar`, `Eden`, or any
calendar present on the Eden Calendar Worker) directly to `/api/v1/*` with a 60-second signed Bearer
token. Every write still passes through Eden Secretary's owner confirmation card before `calendar_kit`
executes it.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime, timedelta
import hashlib
import hmac
import json
import os
import re
import time
from typing import Any
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_URL = "https://askedencalendar.com"
TIMEOUT_S = 10.0
_LOOPBACK_HTTP = re.compile(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$")
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+$")


@dataclass(frozen=True)
class EdenCalConfig:
    url: str
    secret: str
    user: str


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _load_file_defaults() -> dict[str, str]:
    if "PYTEST_CURRENT_TEST" in os.environ:
        return {}
    from pathlib import Path

    for candidate in (
        Path.home() / "Library" / "Application Support" / "Eden Code" / "edencal.json",
        Path.home() / "Library" / "Application Support" / "Jarvis" / "edencal.json",
        Path(__file__).resolve().parents[3] / "askeden" / "calendar-worker" / ".dev.vars",
    ):
        try:
            if not candidate.is_file():
                continue
            text = candidate.read_text(encoding="utf-8")
            if candidate.suffix == ".json":
                data = json.loads(text)
                if isinstance(data, dict):
                    return {str(k): str(v) for k, v in data.items() if v is not None}
            else:
                kv: dict[str, str] = {}
                for line in text.splitlines():
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        kv[k.strip()] = v.strip()
                if kv:
                    return kv
        except Exception:
            continue
    return {}


def load_config(env: dict[str, str] | None = None) -> EdenCalConfig | None:
    """Return the active Eden Calendar config, or None when not configured."""
    source = env if env is not None else {**_load_file_defaults(), **os.environ}
    secret = (source.get("EDEN_CALENDAR_LINK_SECRET") or "").strip()
    user = (source.get("EDEN_CALENDAR_USER") or "").strip().lower()
    url = (source.get("EDEN_CALENDAR_URL") or "").strip().rstrip("/")
    if not url and secret and user:
        url = DEFAULT_URL
    if not url or len(secret) < 32 or not _EMAIL_RE.match(user):
        return None
    if url.startswith("http://") and not _LOOPBACK_HTTP.match(url):
        return None
    if not (url.startswith("https://") or url.startswith("http://")):
        return None
    return EdenCalConfig(url=url, secret=secret, user=user)


def link_token(cfg: EdenCalConfig, now_s: int | None = None) -> str:
    """Mint a 60-second HMAC-SHA256 Bearer token for `calendar-worker` `/api/v1/*`."""
    ts = int(time.time()) if now_s is None else int(now_s)
    payload = json.dumps(
        {"sub": cfg.user, "aud": "eden-calendar", "exp": ts + 60},
        separators=(",", ":"),
    ).encode("utf-8")
    body = _b64url(payload)
    sig = _b64url(hmac.new(cfg.secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{sig}"


def request_json(
    cfg: EdenCalConfig,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    timeout: float = TIMEOUT_S,
) -> tuple[int, dict[str, Any]]:
    """Call `calendar-worker` with a fresh link token and return `(status_code, parsed_json)`."""
    url = f"{cfg.url}{path}"
    headers = {
        "Authorization": f"Bearer {link_token(cfg)}",
        "Accept": "application/json",
        "User-Agent": "EdenSecretary/1.0",
    }
    data: bytes | None = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            parsed = json.loads(raw) if raw.strip() else {}
            return resp.status, parsed if isinstance(parsed, dict) else {"data": parsed}
    except urllib.error.HTTPError as exc:
        raw = ""
        try:
            raw = exc.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        try:
            parsed = json.loads(raw) if raw.strip() else {}
        except ValueError:
            parsed = {"error": raw or f"HTTP {exc.code}"}
        return exc.code, parsed if isinstance(parsed, dict) else {"error": str(parsed)}
    except Exception as exc:
        return 502, {"error": f"Eden Calendar couldn't be reached ({exc})."}


def _parse_iso_local(value: str) -> tuple[datetime, bool]:
    """Parse an Eden Calendar ISO string (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM...`) into naive local datetime."""
    text = str(value or "").strip()
    if len(text) == 10 and text[4] == "-" and text[7] == "-":
        return datetime.fromisoformat(text), True
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt.replace(second=0, microsecond=0), False


def _to_worker_iso(moment: datetime, all_day: bool) -> str:
    if all_day:
        return moment.date().isoformat()
    local_dt = moment.astimezone() if moment.tzinfo is not None else moment.astimezone()
    return local_dt.isoformat(timespec="seconds")


def _worker_event_to_row(
    ev: dict[str, Any],
    cal_map: dict[str, dict[str, Any]],
    details: bool = False,
) -> dict[str, Any] | None:
    """Convert a `calendar-worker` `/api/v1/events` item into `calendar_kit._row` format."""
    if str(ev.get("status") or "").lower() == "cancelled":
        return None
    try:
        begin_dt, all_day_start = _parse_iso_local(str(ev.get("start") or ""))
        end_raw = str(ev.get("end") or "")
        end_dt, _ = _parse_iso_local(end_raw) if end_raw else (begin_dt + timedelta(hours=1), all_day_start)
    except ValueError:
        return None
    all_day = bool(ev.get("allDay", all_day_start))
    cal_id = str(ev.get("calendarId") or "default")
    cal_info = cal_map.get(cal_id, {})
    cal_name = str(cal_info.get("title") or cal_info.get("name") or ev.get("calendar") or "Eden Calendar")
    raw_attendees = ev.get("attendees") if isinstance(ev.get("attendees"), list) else []
    attendees: list[str] = []
    emails: list[str] = []
    for person in raw_attendees:
        if isinstance(person, dict):
            name = str(person.get("name") or person.get("email") or "").strip()
            email = str(person.get("email") or "").strip()
            if name:
                attendees.append(name)
            if email:
                emails.append(email)
        elif isinstance(person, str) and person.strip():
            attendees.append(person.strip())
    location = str(ev.get("location") or "")
    description = str(ev.get("description") or ev.get("notes") or "")
    url = str(ev.get("url") or "")
    from . import calendar_kit

    call = calendar_kit.call_link(url, location, description)
    row: dict[str, Any] = {
        "attendees": attendees[:10],
        "title": str(ev.get("title") or ev.get("summary") or "Untitled"),
        "begin": begin_dt.isoformat(timespec="minutes"),
        "end": end_dt.isoformat(timespec="minutes"),
        "all_day": all_day,
        "location": location,
        "calendar": cal_name,
        "calendarId": cal_id,
        "source": "eden",
        "id": str(ev.get("uid") or ev.get("id") or ""),
        "reply": "",
        "emails": emails[:20],
        "organizer_email": "",
        "online": bool(call),
        "link": call,
    }
    if details:
        row |= {
            "writable": not bool(cal_info.get("readOnly", False)),
            "repeats": bool(ev.get("rrule") or ev.get("recurring")),
            "mine": True,
            "organizer": "",
            "notes": description,
            "url": url if url.lower().startswith(("https://", "http://")) else "",
            "alerts": [int(a) for a in (ev.get("alerts") or []) if isinstance(a, int | float)],
        }
    return row


def _worker_event_to_json_event(
    ev: dict[str, Any],
    cal_map: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    """Convert a `calendar-worker` event into `calendar_kit.json_event` format (`between()`)."""
    row = _worker_event_to_row(ev, cal_map, details=True)
    if row is None:
        return None
    begin_dt = datetime.fromisoformat(row["begin"])
    end_dt = datetime.fromisoformat(row["end"])
    from . import calendar_kit

    start_iso, end_iso = calendar_kit.iso_span(
        begin_dt.timestamp(), end_dt.timestamp(), row["all_day"], None
    )
    cal_id = str(ev.get("calendarId") or "default")
    cal_info = cal_map.get(cal_id, {})
    return {
        "id": row["id"],
        "calendarId": f"edencal:{cal_id}",
        "calendar": row["calendar"],
        "color": str(cal_info.get("color") or "#0a84ff"),
        "source": "eden",
        "title": row["title"],
        "start": start_iso,
        "end": end_iso,
        "allDay": row["all_day"],
        "status": str(ev.get("status") or "confirmed"),
        "selfStatus": None,
        "organizer": None,
        "location": row["location"],
        "notes": row["notes"][:4000],
        "url": (row["link"] or row["url"])[:2000],
        "eventUrl": row["url"][:2000],
        "alerts": row["alerts"],
        "attendees": [],
        "recurring": row["repeats"],
        "writable": row["writable"],
    }


def list_calendars(cfg: EdenCalConfig) -> list[dict[str, Any]]:
    status, data = request_json(cfg, "GET", "/api/v1/calendars")
    if status != 200:
        return []
    cals = data.get("calendars")
    return [c for c in cals if isinstance(c, dict) and c.get("id")] if isinstance(cals, list) else []


def fetch_events(
    cfg: EdenCalConfig,
    start: datetime,
    end: datetime,
    details: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    cals = list_calendars(cfg)
    cal_map = {str(c["id"]): c for c in cals}
    start_iso = _to_worker_iso(start, False)
    end_iso = _to_worker_iso(end, False)
    q = urllib.parse.urlencode(
        {
            "start": start_iso,
            "end": end_iso,
            "from": start.date().isoformat(),
            "to": (end.date() + timedelta(days=1)).isoformat(),
        }
    )
    status, data = request_json(cfg, "GET", f"/api/v1/events?{q}")
    if status != 200:
        return [], cal_map
    raw_events = data.get("events") if isinstance(data.get("events"), list) else []
    out: list[dict[str, Any]] = []
    for ev in raw_events:
        if not isinstance(ev, dict):
            continue
        row = _worker_event_to_row(ev, cal_map, details=details)
        if row is None:
            continue
        ev_start = datetime.fromisoformat(row["begin"])
        ev_end = datetime.fromisoformat(row["end"])
        if ev_end > start and ev_start < end:
            out.append(row)
    return out, cal_map


def between(cfg: EdenCalConfig, start: str, end: str) -> dict[str, Any]:
    first, last = datetime.fromisoformat(start), datetime.fromisoformat(end)
    cals = list_calendars(cfg)
    cal_map = {str(c["id"]): c for c in cals}
    q = urllib.parse.urlencode(
        {
            "start": _to_worker_iso(first, False),
            "end": _to_worker_iso(last, False),
            "from": first.date().isoformat(),
            "to": (last.date() + timedelta(days=1)).isoformat(),
        }
    )
    status, data = request_json(cfg, "GET", f"/api/v1/events?{q}")
    if status != 200:
        return {"events": [], "calendars": []}
    raw_events = data.get("events") if isinstance(data.get("events"), list) else []
    events: list[dict[str, Any]] = []
    for ev in raw_events:
        if not isinstance(ev, dict):
            continue
        item = _worker_event_to_json_event(ev, cal_map)
        if item is not None:
            events.append(item)
    calendars = [
        {
            "id": f"edencal:{c['id']}",
            "title": str(c.get("title") or c.get("name") or "Eden Calendar"),
            "color": str(c.get("color") or "#0a84ff"),
            "writable": not bool(c.get("readOnly", False)),
            "source": "eden",
        }
        for c in cals
    ]
    return {"events": events, "calendars": calendars}


def at(cfg: EdenCalConfig, start: str) -> list[dict[str, Any]]:
    from . import calendar_kit

    moment, day_only = calendar_kit.when(start)
    midnight = moment.hour == 0 and moment.minute == 0
    begin = moment.replace(hour=0, minute=0) if day_only else moment - timedelta(minutes=1)
    end = begin + (timedelta(days=1) if day_only or midnight else timedelta(days=1))
    rows, _ = fetch_events(cfg, begin, end, details=True)
    matched: list[dict[str, Any]] = []
    for row in rows:
        starts = datetime.fromisoformat(row["begin"])
        if row["all_day"]:
            if (day_only or midnight) and starts.date() == moment.date():
                matched.append(row)
        elif not day_only and starts == moment:
            matched.append(row)
    return matched


def ensure_default_calendar(cfg: EdenCalConfig) -> dict[str, Any] | None:
    """Ensure at least one writable calendar exists on Eden Calendar."""
    cals = list_calendars(cfg)
    for c in cals:
        if not c.get("readOnly"):
            return c
    from . import calendar_kit

    status, data = request_json(
        cfg,
        "POST",
        "/api/v1/calendars",
        {
            "id": "default",
            "title": "Eden Calendar",
            "color": "#0a84ff",
            "timeZone": calendar_kit.mac_zone(),
        },
    )
    if status in (200, 201) and isinstance(data.get("calendar"), dict):
        return data["calendar"]
    return cals[0] if cals else None


def matches_calendar(cfg: EdenCalConfig, calendar_name: str) -> dict[str, Any] | None:
    """Return the matching Eden Calendar dict if `calendar_name` names an Eden Calendar."""
    wanted = " ".join(str(calendar_name or "").casefold().split())
    cals = list_calendars(cfg)
    if wanted in ("eden", "eden calendar", "askedencalendar", "askedencalendar.com"):
        for c in cals:
            if not c.get("readOnly"):
                return c
        return ensure_default_calendar(cfg)
    for c in cals:
        name = " ".join(str(c.get("title") or c.get("name") or "").casefold().split())
        cid = str(c.get("id") or "").casefold()
        if wanted and (wanted == name or wanted == cid or wanted == f"edencal:{cid}"):
            return c
    return None


def _spec_to_rrule(rule: dict[str, Any] | None) -> str | None:
    if not isinstance(rule, dict) or not rule.get("frequency"):
        return None
    freq = str(rule["frequency"]).upper()
    parts = [f"FREQ={freq}"]
    every = int(rule.get("every") or 1)
    if every > 1:
        parts.append(f"INTERVAL={every}")
    weekdays = rule.get("weekdays")
    if isinstance(weekdays, list) and weekdays:
        names = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
        days = [names[int(d)] for d in weekdays if isinstance(d, int) and 0 <= int(d) <= 6]
        if days:
            parts.append(f"BYDAY={','.join(days)}")
    if rule.get("count"):
        parts.append(f"COUNT={int(rule['count'])}")
    elif rule.get("until"):
        until_str = str(rule["until"]).replace("-", "")
        parts.append(f"UNTIL={until_str}T235959Z")
    return ";".join(parts)


def create(cfg: EdenCalConfig, spec: dict[str, Any], target_cal: dict[str, Any] | None = None) -> dict[str, Any]:
    from . import calendar_kit

    title = str(spec.get("title") or "").strip()
    if not title:
        return {"error": "Give the event a title."}
    try:
        begin, day_only = calendar_kit.when(spec.get("start") or "")
    except ValueError:
        return {"error": "Give the start like 2026-09-30T15:00 (or 2026-09-30 for all day)."}
    all_day = bool(spec.get("all_day")) or day_only
    if all_day:
        start_val = begin.date().isoformat()
        days = max(1, int(spec.get("days") or 1))
        end_dt = begin.replace(hour=0, minute=0) + timedelta(days=days)
        end_val = end_dt.date().isoformat()
    else:
        minutes = int(spec.get("duration_minutes") or 60)
        end_dt = begin + timedelta(minutes=minutes)
        start_val = _to_worker_iso(begin, False)
        end_val = _to_worker_iso(end_dt, False)

    cal = target_cal or matches_calendar(cfg, str(spec.get("calendar") or "eden")) or ensure_default_calendar(cfg)
    cal_id = str(cal["id"]) if cal else "default"
    cal_map = {cal_id: cal} if cal else {}

    payload: dict[str, Any] = {
        "calendarId": cal_id,
        "title": title,
        "start": start_val,
        "end": end_val,
        "allDay": all_day,
        "location": str(spec.get("location") or ""),
        "description": str(spec.get("notes") or ""),
        "url": str(spec.get("url") or ""),
        "alerts": [int(m) for m in (spec.get("alerts") or [])],
    }
    rrule = _spec_to_rrule(spec.get("repeat"))
    if rrule:
        payload["rrule"] = rrule
    status, data = request_json(cfg, "POST", "/api/v1/events", payload)
    if status not in (200, 201):
        return {"error": str(data.get("error") or f"Eden Calendar answered {status}.")}
    ev = data.get("event") if isinstance(data.get("event"), dict) else payload | {"uid": data.get("uid", "")}
    row = _worker_event_to_row(ev, cal_map, details=True)
    return {"created": row} if row else {"error": "Eden Calendar didn't return the created event."}


def edit(
    cfg: EdenCalConfig,
    start: str,
    event_id: str,
    calendar: str,
    future: bool,
    changes: dict[str, Any],
) -> dict[str, Any]:
    from . import calendar_kit

    hits = [
        r
        for r in at(cfg, start)
        if r["id"] == event_id and (not calendar or r["calendar"].casefold() == calendar.casefold())
    ]
    if len(hits) != 1:
        return {"error": "That event isn't on Eden Calendar any more (or changed just now)."}
    before = dict(hits[0])
    cal_id = str(before.get("calendarId") or "default")
    scope = "this-and-future" if (future and before.get("repeats")) else ("this" if before.get("repeats") else "all")
    payload: dict[str, Any] = {
        "calendarId": cal_id,
        "scope": scope,
        "recurrenceId": _to_worker_iso(datetime.fromisoformat(before["begin"]), before["all_day"]),
    }
    if changes.get("title") is not None and str(changes["title"]).strip():
        payload["title"] = str(changes["title"]).strip()
    if changes.get("location") is not None:
        payload["location"] = str(changes["location"])
    if changes.get("notes") is not None:
        payload["description"] = str(changes["notes"])
    if changes.get("url") is not None:
        payload["url"] = str(changes["url"])
    if changes.get("alerts") is not None:
        payload["alerts"] = [int(m) for m in changes["alerts"]]
    if changes.get("start") or changes.get("duration_minutes") is not None:
        old_start = datetime.fromisoformat(before["begin"])
        old_end = datetime.fromisoformat(before["end"])
        new_start, day_only = (
            calendar_kit.when(changes["start"]) if changes.get("start") else (old_start, False)
        )
        if before["all_day"] or day_only:
            span = old_end - old_start if before["all_day"] and old_end > old_start else timedelta(days=1)
            payload["allDay"] = True
            payload["start"] = new_start.date().isoformat()
            payload["end"] = (new_start + span).date().isoformat()
        else:
            if changes.get("duration_minutes") is not None:
                minutes = int(changes["duration_minutes"])
                if not 1 <= minutes <= 24 * 60:
                    return {"error": "Duration must be between 1 minute and 24 hours."}
                new_end = new_start + timedelta(minutes=minutes)
            else:
                new_end = new_start + (old_end - old_start)
            payload["allDay"] = False
            payload["start"] = _to_worker_iso(new_start, False)
            payload["end"] = _to_worker_iso(new_end, False)

    uid_enc = urllib.parse.quote(event_id, safe="")
    status, data = request_json(cfg, "PATCH", f"/api/v1/events/{uid_enc}", payload)
    if status != 200:
        return {"error": str(data.get("error") or f"Eden Calendar answered {status}.")}
    cals = {str(c["id"]): c for c in list_calendars(cfg)}
    ev = data.get("event") if isinstance(data.get("event"), dict) else None
    if ev:
        edited = _worker_event_to_row(ev, cals, details=True)
    else:
        lookup_start = str(changes.get("start") or start)
        refreshed = [r for r in at(cfg, lookup_start) if r["id"] == event_id]
        edited = refreshed[0] if refreshed else dict(before, **{k: v for k, v in changes.items() if v is not None})
    return {
        "edited": edited,
        "was": before,
        "span": "future" if scope == "this-and-future" else "this",
    }


def remove(
    cfg: EdenCalConfig,
    start: str,
    event_id: str,
    calendar: str,
    future: bool,
) -> dict[str, Any]:
    hits = [
        r
        for r in at(cfg, start)
        if r["id"] == event_id and (not calendar or r["calendar"].casefold() == calendar.casefold())
    ]
    if len(hits) != 1:
        return {"error": "That event isn't on Eden Calendar any more (or changed just now)."}
    row = hits[0]
    cal_id = str(row.get("calendarId") or "default")
    scope = "this-and-future" if (future and row.get("repeats")) else ("this" if row.get("repeats") else "all")
    q = urllib.parse.urlencode(
        {
            "calendarId": cal_id,
            "scope": scope,
            "recurrenceId": _to_worker_iso(datetime.fromisoformat(row["begin"]), row["all_day"]),
        }
    )
    uid_enc = urllib.parse.quote(event_id, safe="")
    status, data = request_json(cfg, "DELETE", f"/api/v1/events/{uid_enc}?{q}")
    if status != 200:
        return {"error": str(data.get("error") or f"Eden Calendar answered {status}.")}
    return {"removed": row, "span": "future" if scope == "this-and-future" else "this"}


def add(cfg: EdenCalConfig, event: dict[str, Any]) -> dict[str, Any]:
    title = str(event.get("title") or "").strip()
    try:
        begin = datetime.fromisoformat(str(event.get("begin")))
        end = datetime.fromisoformat(str(event.get("end")))
    except ValueError:
        return {"error": "That event's time can't be read."}
    if not title or end < begin:
        return {"error": "That event can't be put back."}
    all_day = bool(event.get("all_day"))
    cal = matches_calendar(cfg, str(event.get("calendar") or "eden"))
    cal_id = str(cal["id"]) if cal else "default"
    payload = {
        "calendarId": cal_id,
        "title": title,
        "start": _to_worker_iso(begin, all_day),
        "end": _to_worker_iso(end, all_day),
        "allDay": all_day,
        "location": str(event.get("location") or ""),
    }
    status, data = request_json(cfg, "POST", "/api/v1/events", payload)
    if status not in (200, 201):
        return {"error": str(data.get("error") or f"Eden Calendar answered {status}.")}
    ev = data.get("event") if isinstance(data.get("event"), dict) else payload
    cals = {cal_id: cal} if cal else {}
    return {"added": _worker_event_to_row(ev, cals, details=False)}
