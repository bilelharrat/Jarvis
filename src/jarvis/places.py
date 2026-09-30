"""Places for JARVIS's tools: what's near, directions in Apple Maps, when to set off to be
somewhere on time, and an ETA put into words for a message. The MapKit calls themselves
are maps.py's helper; these are the plain parts around them, so they can be tested.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import quote, urlencode

MODES = {"driving": "d", "walking": "w", "transit": "r"}
LEAVE_BUFFER = 5  # minutes to spare when saying when to leave
_CLOCK = re.compile(
    r"^(?:at\s+|by\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$", re.IGNORECASE
)
_CLOCK_ZH = re.compile(r"^(早上|上午|中午|下午|晚上|傍晚)?(\d{1,2})(?:[:：点](\d{1,2}|半)?分?)?$")


def mode_of(value: Any) -> str:
    text = str(value or "").strip().lower()
    return text if text in MODES else "driving"


def directions_url(destination: str, mode: str = "driving", origin: str = "") -> str:
    """Apple Maps' own link for directions (from where the Mac is, unless origin says)."""
    params = {"daddr": destination.strip(), "dirflg": MODES[mode_of(mode)]}
    if origin.strip():
        params["saddr"] = origin.strip()
    return "maps://?" + urlencode(params, quote_via=quote)


def parse_arrival(text: str, now: datetime) -> datetime:
    """When to be somewhere: "2026-09-30T16:30", "16:30", "4:30 pm", "4pm", 下午4点半. A
    time alone is its next coming: today, or tomorrow once it has passed. ValueError when
    it isn't a time."""
    raw = " ".join(str(text or "").split())
    if not raw:
        raise ValueError("Say when you need to be there.")
    if re.match(r"^\d{4}-\d\d-\d\d", raw):
        return datetime.fromisoformat(raw.replace(" ", "T")[:16])
    hour = minute = None
    m = _CLOCK.match(raw)
    if m:
        hour, minute = int(m.group(1)), int(m.group(2) or 0)
        meridiem = (m.group(3) or "").replace(".", "").lower()
        if meridiem == "pm" and hour < 12:
            hour += 12
        elif meridiem == "am" and hour == 12:
            hour = 0
    else:
        z = _CLOCK_ZH.match(raw.replace(" ", ""))
        if z:
            hour = int(z.group(2))
            minute = 30 if z.group(3) == "半" else int(z.group(3) or 0)
            if z.group(1) in ("下午", "晚上", "傍晚") and hour < 12:
                hour += 12
            elif z.group(1) == "中午" and hour < 6:
                hour += 12
    if hour is None or minute is None or not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"“{raw}” isn't a time I can read; give it like 16:30.")
    moment = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return moment if moment > now else moment + timedelta(days=1)


def leave_by(arrive: datetime, minutes: int, depart: float | None = None) -> datetime:
    """When to set off: Apple Maps' own departure time for that arrival when it gave one,
    else the arrival less the trip; either way a few minutes to spare."""
    start = datetime.fromtimestamp(depart) if depart else arrive - timedelta(minutes=minutes)
    return start - timedelta(minutes=LEAVE_BUFFER)


def clock(moment: datetime) -> str:
    """4:05 PM (today), or Thu 4:05 PM for another day."""
    text = f"{moment.hour % 12 or 12}:{moment.minute:02d} {'AM' if moment.hour < 12 else 'PM'}"
    return text if moment.date() == datetime.now().date() else f"{moment:%a} {text}"


def distance_words(meters: float | None, imperial: bool) -> str:
    if meters is None:
        return ""
    if imperial:
        miles = meters / 1609.344
        return f"{round(meters * 3.28084 / 50) * 50:.0f} ft" if miles < 0.2 else f"{miles:.1f} mi"
    return f"{round(meters / 10) * 10:.0f} m" if meters < 1000 else f"{meters / 1000:.1f} km"


def place_lines(places: list[dict[str, Any]], imperial: bool) -> str:
    """Found places for Claude, one per line: name (kind), how far, address, phone, site."""
    rows = []
    for p in places:
        bits = [p.get("name") or "?"]
        if p.get("category"):
            bits[0] += f" ({p['category']})"
        far = distance_words(p.get("meters"), imperial)
        if far:
            bits.append(f"{far} away")
        for key in ("address", "phone", "url"):
            if p.get(key):
                bits.append(str(p[key]))
        rows.append("- " + " · ".join(bits))
    return "\n".join(rows)


def eta_message(destination: str, minutes: int, now: datetime, language: str = "en") -> str:
    """The message an ETA goes out as, in the owner's language."""
    from . import lang

    arrive = now + timedelta(minutes=minutes)
    if lang.is_zh(language):
        meridiem = "PM" if arrive.hour >= 12 else "AM"
        at = lang.clock_zh(arrive.hour % 12 or 12, arrive.minute, meridiem, spoken=False)
        return f"我正在去{destination}的路上，大约{minutes}分钟后到（{at}左右）。"
    at = f"{arrive.hour % 12 or 12}:{arrive.minute:02d} {'AM' if arrive.hour < 12 else 'PM'}"
    span = "about a minute" if minutes <= 1 else f"about {minutes} minutes"
    return f"On my way to {destination}: {span} away, there around {at}."
