"""How the owner gets places: a commute profile, and the leave-time heads-ups and the
briefing's first trip that follow it.

- The profile (Settings › Weather and travel, or by voice): the usual way of getting about
  (travel_mode: driving, transit or walking), a way for particular places (travel_places:
  [{place, mode}]; a place matches an event whose location or title holds it as words:
  "office", "dentist", "1 Market St"), and minutes to arrive early (arrive_early, 0-60).
- Leave-time heads-ups: the heads-up watcher (proactive.Watcher) plans each trip in the
  next three hours through this profile (Watcher.plan): Apple Maps' travel time the way the
  owner goes, and for transit the timetable's departure that arrives in time ("arrive by"
  the start, less the minutes to arrive early). Without a profile it's by car, as before.
- The briefing's Commute: today's first event somewhere, how long it takes and when to
  leave (the owner's own calendar: private, as the turn gate weighs it).

Window: the "proactive" event's "commute" part: {mode, places, early}.
Settings (prefs.features): travel_mode, travel_places, arrive_early.
Tools (server "commute"): commute_profile, set_commute.

Cost: no model calls. Travel times come from Apple Maps on the Mac (a helper process), for
the trips the watcher already timed, and one for the briefing's first trip.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from ... import hub as hub_module
from ... import lang, maps, prefs
from ...proactive import is_travel
from ...textclean import clean_text
from .briefing import clock, quote

log = logging.getLogger("jarvis")

SERVER_NAME = "commute"
MODES = ("driving", "transit", "walking")
MAX_PLACES = 30
MAX_EARLY = 60
HOW = {"driving": "by car", "transit": "by transit", "walking": "on foot"}


def clean_mode(value: Any) -> str | None:
    return value if value in MODES else None


def clean_place(value: Any) -> str:
    return " ".join(clean_text(str(value or "")).split())[:60]


def clean_places(value: Any) -> list[dict[str, str]] | None:
    """[{place, mode}]: each place once (ignoring case), a known mode, MAX_PLACES at most."""
    if not isinstance(value, list):
        return None
    out: list[dict[str, str]] = []
    for item in value[: MAX_PLACES * 2]:
        if not isinstance(item, dict) or item.get("mode") not in MODES:
            continue
        place = clean_place(item.get("place"))
        if place and not any(p["place"].casefold() == place.casefold() for p in out):
            out.append({"place": place, "mode": item["mode"]})
    return out[:MAX_PLACES]


def clean_early(value: Any) -> int | None:
    ok = isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_EARLY
    return value if ok else None


prefs.register_feature_pref("travel_mode", "driving", clean_mode)
prefs.register_feature_pref("travel_places", [], clean_places)
prefs.register_feature_pref("arrive_early", 0, clean_early)

TEXTS = {
    "Change how you get around? {how}": "要修改你的出行方式吗？{how}",
    "usually {mode}": "平时{mode}",
    "{place}: {mode}": "{place}：{mode}",
    "forget {place}": "不再单独设置{place}",
    "arrive {minutes} minutes early": "提前{minutes}分钟到",
    "arrive on time": "准时到",
    "by car": "开车",
    "by transit": "坐公共交通",
    "on foot": "步行",
}
lang.add_texts(TEXTS)

_ZH = lang._ASK_LEAD_ZH
ASKED = {
    "commute_change": (
        r"(?:i|we)\s+(?:usually\s+|always\s+|normally\s+|mostly\s+)?(?:take|ride|catch|get)\s+"
        r"(?:the\s+|a\s+)?(?:bus|train|subway|metro|tube|bart|muni|transit|tram|ferry|caltrain)\b"
        r"|(?:i|we)\s+(?:usually\s+|always\s+|normally\s+|mostly\s+)?(?:walk|drive)\s+(?:to|there|everywhere)\b"
        r"|(?:i'?m|i\s+am)\s+(?:walking|driving|taking\s+(?:the\s+)?(?:bus|train|transit|subway))\b"
        r"|(?:i\s+(?:want|like|need)\s+to\s+|let\s+me\s+|make\s+me\s+)?arrive\s+(?:\d+|five|ten"
        r"|fifteen|twenty|thirty)\s+(?:minutes?\s+)?early\b"
        r"|(?:set|change|make|update)\s+(?:my\s+)?(?:commute|travel\s+mode|travel\s+profile|"
        r"usual\s+way)\b"
        rf"|{_ZH}(?:我(?:一般|平时|通常|都|经常)?(?:坐|乘|搭)(?:地铁|公交|公车|火车|轻轨|公共交通)"
        r"|我(?:一般|平时|通常|都|经常)?(?:走路|步行|开车)(?:去|到|上班)|提前[0-9一二三四五六七八九十]+分钟到"
        r"|(?:设置|修改|改)(?:一下)?(?:我的)?(?:通勤|出行方式))"
    ),
}
hub_module.FEATURE_ASKED.update({a: hub_module._asks(p) for a, p in ASKED.items()})


def matches(place: str, event: dict[str, Any]) -> bool:
    """A place in the profile matches an event whose location or title holds it as words."""
    text = f"{event.get('location') or ''} {event.get('title') or ''}".casefold()
    return bool(re.search(rf"(?<!\w){re.escape(place.casefold())}(?!\w)", text))


class Commute:
    """One hub's commute profile, the trips it plans, and the briefing's first trip."""

    def __init__(self, hub: Any, briefing: Any, look: Any) -> None:
        self.hub = hub
        self.briefing = briefing
        self.look = look
        self._now = datetime.now  # the clock (tests set their own)

    def install(self) -> None:
        hub = self.hub
        hub.register_server(
            SERVER_NAME,
            self.build_server,
            prompt=PROMPT,
            labels=LABELS,
            quiet=("set_commute",),  # its result is the owner's own settings, said back
        )
        watcher = getattr(hub, "watcher", None)
        if watcher is not None and hasattr(watcher, "plan"):
            watcher.plan = self.plan
        self.briefing.add_facts("commute", self.briefing_facts, private=True)

    # ── the profile ──

    def mode(self) -> str:
        return clean_mode(self.hub.prefs.feature("travel_mode")) or "driving"

    def places(self) -> list[dict[str, str]]:
        return clean_places(self.hub.prefs.feature("travel_places")) or []

    def early(self) -> int:
        found = clean_early(self.hub.prefs.feature("arrive_early"))
        return found if found is not None else 0

    def language(self) -> str:
        return "zh" if lang.is_zh(self.hub.prefs.language) else "en"

    def mode_for(self, event: dict[str, Any]) -> str:
        """How the owner gets to this event: a place of theirs it matches, else the usual."""
        for place in self.places():
            if matches(place["place"], event):
                return place["mode"]
        return self.mode()

    # ── trips ──

    async def plan(self, event: dict[str, Any]) -> dict[str, Any] | None:
        """Watcher.plan: the trip to an event the owner's way, {minutes, mode, early,
        depart}; None without a starting point or a travel time from Maps."""
        here = self.hub._travel_origin()
        if not here or not is_travel(str(event.get("location") or "")):
            return None
        mode, early = self.mode_for(event), self.early()
        args = [str(here["lat"]), str(here["lon"]), str(event["location"]), mode]
        if mode == "transit":  # the timetable: whatever arrives by the start, less early
            arrive = event["begin"] - timedelta(minutes=early)
            args.append(str(int(arrive.timestamp())))
        found = await maps.run_helper("eta", *args)
        minutes = found.get("minutes")
        if not isinstance(minutes, int | float) or isinstance(minutes, bool):
            return None
        depart = None
        if mode == "transit" and isinstance(found.get("depart"), int | float):
            depart = datetime.fromtimestamp(found["depart"])
        return {"minutes": round(minutes), "mode": mode, "early": early, "depart": depart}

    async def briefing_facts(self) -> str:
        """For the briefing's Commute: today's first event somewhere, and when to leave."""
        now = self._now()
        first = next(
            (
                e
                for e in self.look.timed()
                if e["begin"].date() == now.date()
                and e["begin"] > now
                and is_travel(str(e.get("location") or ""))
            ),
            None,
        )
        if first is None:
            return ""
        title = quote(first.get("title"))
        place = quote(str(first.get("location") or "").splitlines()[0])
        if not title or not place:
            return ""  # words someone else wrote that read like instructions: left out
        head = f"Today's first trip: {title} at {clock(first['begin'])}, at {place}."
        trip = await self.plan(first)
        if trip is None:
            return head
        leave = trip["depart"] or first["begin"] - timedelta(
            minutes=trip["minutes"] + trip["early"]
        )
        return (
            f"{head} It's {trip['minutes']} minutes {HOW[trip['mode']]}; leave by {clock(leave)}."
        )

    # ── the window ──

    def state(self) -> dict[str, Any]:
        return {"mode": self.mode(), "places": self.places(), "early": self.early()}

    def send(self) -> None:
        self.hub.emit("proactive", commute=self.state())

    def describe(self) -> str:
        places = "; ".join(f"{p['place']}: {p['mode']}" for p in self.places())
        early = self.early()
        return "\n".join(
            [
                f"Usually: {self.mode()}.",
                f"Places gone to another way: {places or '(none)'}.",
                f"Arrive: {f'{early} minutes early' if early else 'on time'}.",
            ]
        )

    # ── the brain's tools ──

    def build_server(self):
        return create_sdk_mcp_server(name=SERVER_NAME, version="0.1.0", tools=self.tools())

    def tools(self) -> list:
        @tool(
            "commute_profile",
            "How the user gets around, which leave-time heads-ups follow: their usual way "
            "(driving, transit or walking), places they get to another way, and how early "
            "they like to arrive.",
            {},
        )
        async def commute_profile(_args):
            return _text(self.describe())

        @tool(
            "set_commute",
            "Change how the user gets around, only as they said: mode (their usual way: "
            "driving, transit or walking), place with place_mode (a place they get to "
            "another way, as their calendar names it or its title: 'office', 'dentist'), "
            "forget (a place to go back to the usual way), arrive_early (minutes, 0-60).",
            {
                "type": "object",
                "properties": {
                    "mode": {"type": "string", "enum": list(MODES)},
                    "place": {"type": "string"},
                    "place_mode": {"type": "string", "enum": list(MODES)},
                    "forget": {"type": "string"},
                    "arrive_early": {"type": "integer"},
                },
            },
        )
        async def set_commute(args):
            try:
                changes, words = self.plan_changes(args)
            except ValueError as exc:
                return _text(str(exc), error=True)
            if not changes:
                return _text("That's how it's set already.\n" + self.describe())
            question = lang.tr(
                "Change how you get around? {how}", self.language(), how="; ".join(words)
            )
            if not await self.hub.feature_gate("commute_change", question):
                return _text("The user said no. Nothing changed.", error=True)
            self.hub.set_feature_prefs(changes)
            self.send()
            return _text(self.describe())

        return [commute_profile, set_commute]

    def plan_changes(self, args: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
        """set_commute's changes to the settings, and each said in the owner's language."""
        say = lambda template, **v: lang.tr(template, self.language(), **v)  # noqa: E731
        how = lambda mode: say(HOW[mode])  # noqa: E731
        changes: dict[str, Any] = {}
        words: list[str] = []
        mode = args.get("mode")
        if mode in MODES and mode != self.mode():
            changes["travel_mode"] = mode
            words.append(say("usually {mode}", mode=how(mode)))
        places = [dict(p) for p in self.places()]
        forget = clean_place(args.get("forget"))
        if forget:
            kept = [p for p in places if p["place"].casefold() != forget.casefold()]
            if len(kept) == len(places):
                raise ValueError(f"“{forget}” isn't one of the places. commute_profile lists them.")
            places = kept
            words.append(say("forget {place}", place=forget))
        place = clean_place(args.get("place"))
        if place:
            place_mode = args.get("place_mode")
            if place_mode not in MODES:
                raise ValueError("place_mode must be driving, transit or walking.")
            known = next((p for p in places if p["place"].casefold() == place.casefold()), None)
            if known is None:
                if len(places) >= MAX_PLACES:
                    raise ValueError(f"There are {MAX_PLACES} places already; forget one first.")
                places.append({"place": place, "mode": place_mode})
                words.append(say("{place}: {mode}", place=place, mode=how(place_mode)))
            elif known["mode"] != place_mode:
                known["mode"] = place_mode
                words.append(say("{place}: {mode}", place=place, mode=how(place_mode)))
        if places != self.places():
            changes["travel_places"] = places
        if "arrive_early" in args and args["arrive_early"] is not None:
            early = clean_early(args["arrive_early"])
            if early is None:
                raise ValueError(f"arrive_early is minutes, 0 to {MAX_EARLY}.")
            if early != self.early():
                changes["arrive_early"] = early
                words.append(
                    say("arrive {minutes} minutes early", minutes=early)
                    if early
                    else say("arrive on time")
                )
        return changes, words


LABELS = {
    "commute_profile": "Checked how you get around",
    "set_commute": "Changed how you get around",
}
PROMPT = (
    "\n- How the user gets around (leave-time heads-ups follow it): commute_profile says their "
    "usual way (driving, transit or walking), places they get to another way, and how early "
    "they like to arrive; set_commute changes it when they say so ('I take the train to the "
    "office', 'I like to arrive ten minutes early'). drive_time takes the same modes."
)


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out
