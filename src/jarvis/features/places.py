"""Places and weather anywhere, for JARVIS's brain (the "places" tool server):

- nearby_places: shops, food and services near the owner, or near a place they name
  (MapKit's local search, through maps.py's helper);
- open_directions: Apple Maps opened on directions (an app opened, like open_app: no card);
- when_to_leave: when to set off to be somewhere by a time, from Apple Maps' travel time
  for that arrival (traffic-aware when driving);
- share_eta: an ETA texted to someone, through the same Send card as send_message (who,
  and the exact words, before a yes);
- weather_for: any place, any day from a month back to fifteen days ahead (Open-Meteo);
- air_quality: the air there now, or a coming day's worst hour (Open-Meteo).

Where "here" is: the Mac's location (Settings › Use my location), else the Weather city.

Cost policy (Claude): nothing here calls a model. MapKit runs on this Mac and asks Apple's
servers; Open-Meteo is free and keyless.
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime
from typing import Any

import httpx
from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import forecast, mac_tools, maps, messaging, places
from ..weather import IMPERIAL

log = logging.getLogger("jarvis")

SERVER = "places"
LABELS = {
    "nearby_places": "Found places nearby",
    "open_directions": "Opened directions in Maps",
    "when_to_leave": "Worked out when to leave",
    "share_eta": "Shared your ETA",
    "weather_for": "Checked a forecast",
    "air_quality": "Checked the air quality",
}
PROMPT = (
    "\n- Places: nearby_places finds shops, restaurants and services near the user (or near a "
    "place they name); open_directions opens Apple Maps with directions; when_to_leave says "
    "when to set off to be somewhere by a time; share_eta texts someone how far away the "
    "user is (they see the message and say yes first). weather_for gives the forecast for "
    "any place and day up to fifteen days ahead (or a past day this month); air_quality "
    "gives the air quality there."
)


def _text(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


def _error(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "is_error": True}


class Places:
    """The tools' work, with what reaches outside (the maps helper, Open-Meteo, Messages)
    held as attributes a test replaces."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.helper = maps.run_helper
        self.http = lambda: httpx.AsyncClient(timeout=15)
        self.lookup = messaging.find_contacts
        self.send = mac_tools.run_applescript
        self.now = datetime.now

    # ── where "here" is ──

    async def here(self) -> dict[str, Any] | None:
        """The Mac's position ({lat, lon, city, country}), when location is on and known."""
        hub = self.hub
        if not hub.prefs.use_location:
            return None
        if hub.location is None:
            await hub._refresh_location()
        return hub.location

    async def origin(self, near: str = "") -> dict[str, Any]:
        """The point a search is around: a place the owner named, else here, else the
        Weather city. {"error": why} when there's none."""
        here = await self.here()
        if near.strip():
            bias = [str(here["lat"]), str(here["lon"])] if here else []
            found = await self.helper("geocode", near.strip(), *bias)
            if found.get("error"):
                return {"error": f"I couldn't find {near.strip()} on the map."}
            country = (here or {}).get("country") or ""
            return {**found, "city": found.get("name", near), "country": country}
        if here:
            return here
        city = self.hub.prefs.weather_city.strip()
        if city:
            try:
                async with self.http() as client:
                    return await forecast.find_place(city, client)
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                log.info("places: the weather city didn't resolve (%s)", type(exc).__name__)
        return {
            "error": "I don't know where you are: allow Location for J.A.R.V.I.S., or set a "
            "Weather city in Settings."
        }

    @staticmethod
    def imperial(point: dict[str, Any] | None) -> bool:
        return bool(point) and str(point.get("country") or "") in IMPERIAL

    # ── the tools' work ──

    async def nearby(self, what: str, near: str = "", limit: int = 8) -> dict[str, Any]:
        what = " ".join(str(what or "").split())[:120]
        if not what:
            return _error("Say what to look for, like coffee or a pharmacy.")
        point = await self.origin(near)
        if point.get("error"):
            return _error(point["error"])
        found = await self.helper(
            "nearby", str(point["lat"]), str(point["lon"]), what, "5000", str(limit)
        )
        if found.get("error"):
            return _error(found["error"])
        rows = found.get("places") or []
        if not rows:
            return _text(f"Apple Maps found no {what} nearby.")
        where = f" near {near.strip()}" if near.strip() else ""
        head = f"{what.capitalize()}{where}, as Apple Maps ranks them:"
        return _text(head + "\n" + places.place_lines(rows, self.imperial(point)))

    async def directions(
        self, destination: str, mode: str = "", origin: str = ""
    ) -> dict[str, Any]:
        destination = " ".join(str(destination or "").split())[:200]
        if not destination:
            return _error("Say where to.")
        url = places.directions_url(destination, places.mode_of(mode), str(origin or "")[:200])
        try:
            await mac_tools.run_command("open", url)
        except mac_tools.ToolFailure as exc:
            return _error(f"Maps didn't open: {exc}")
        return _text(f"Opened {places.mode_of(mode)} directions to {destination} in Maps.")

    async def _eta(self, destination: str, mode: str, arrive: datetime | None = None):
        here = await self.here()
        if here is None:
            return None, (
                "I need your location for that; allow Location for J.A.R.V.I.S. in System "
                "Settings, and Use my location in Settings."
            )
        argv = [str(here["lat"]), str(here["lon"]), destination, mode]
        if arrive is not None:
            argv.append(str(arrive.timestamp()))
        found = await self.helper("eta", *argv)
        if found.get("error"):
            return None, str(found["error"])
        return found, ""

    async def leave_when(self, destination: str, arrive_by: str, mode: str = "") -> dict[str, Any]:
        destination = " ".join(str(destination or "").split())[:200]
        if not destination:
            return _error("Say where you're going.")
        now = self.now()
        try:
            arrive = places.parse_arrival(arrive_by, now)
        except ValueError as exc:
            return _error(str(exc))
        how = places.mode_of(mode)
        found, why = await self._eta(destination, how, arrive)
        if found is None:
            return _error(why)
        minutes = int(found.get("minutes") or 0)
        leave = places.leave_by(arrive, minutes, found.get("depart"))
        name = found.get("destination") or destination
        far = (
            f"{found['miles']} mi" if self.imperial(await self.here()) else f"{found.get('km')} km"
        )
        late = " That's already past: leave now, and you'll be late." if leave < now else ""
        return _text(
            f"Leave by {places.clock(leave, now)} to reach {name} by {places.clock(arrive, now)}: "
            f"about {minutes} minutes {how} ({far}), with {places.LEAVE_BUFFER} minutes to spare."
            + late
        )

    async def share(self, to: str, destination: str, mode: str = "") -> dict[str, Any]:
        destination = " ".join(str(destination or "").split())[:120]
        if not destination:
            return _error("Say where you're heading.")
        found, why = await self._eta(destination, places.mode_of(mode))
        if found is None:
            return _error(why)
        text = places.eta_message(
            destination, max(1, int(found.get("minutes") or 1)), self.now(), self.hub.language
        )
        person = await messaging.resolve(str(to or ""), "imessage", self.lookup)
        if isinstance(person, str):
            return _error(person)
        name, handle = person
        shown = name if name == handle else f"{name} ({handle})"
        if not await self.hub.send_gate(
            f"Send this to {name}?",
            f"To {shown}:\n“{text}”",
            f"Here's your message to {name}. {text} Do you want this message sent?",
        ):
            return _error("The user said no. It wasn't sent.")
        try:
            await self.send(messaging.SEND_IMESSAGE_SCRIPT, handle, text)  # what the card showed
        except mac_tools.ToolFailure as exc:
            return _error(f"Messages couldn't send it: {exc}")
        return _text(f"Sent {name} your ETA: {text}")

    def _day(self, when: str, ahead: int) -> tuple[date, date]:
        """(the day meant, today); ValueError with why when it's no day the service has."""
        today = self.now().date()
        day = forecast.parse_day(when, today)
        forecast.check_range(day, today, ahead=ahead)
        return day, today

    async def weather(self, place: str = "", when: str = "") -> dict[str, Any]:
        try:
            day, _today = self._day(when, forecast.MAX_AHEAD)
        except ValueError as exc:
            return _error(str(exc) or "Give the day as a date, like 2026-10-02.")
        try:
            async with self.http() as client:
                point = await self._point(place, client)
                if point.get("error"):
                    return _error(point["error"])
                found = await forecast.day_weather(point, day, client)
        except forecast.NotFound as exc:
            return _error(str(exc))
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            log.info("weather_for failed: %s", type(exc).__name__)
            return _error("The forecast service didn't answer. Try again in a moment.")
        return _text(json.dumps(found, ensure_ascii=False))

    async def air(self, place: str = "", when: str = "") -> dict[str, Any]:
        try:
            day, today = self._day(when, forecast.AIR_AHEAD)
        except ValueError as exc:
            return _error(str(exc) or "Give the day as a date, like 2026-10-02.")
        if day < today:
            return _error("I only have the air quality now and for the next few days.")
        try:
            async with self.http() as client:
                point = await self._point(place, client)
                if point.get("error"):
                    return _error(point["error"])
                found = await forecast.air_quality(point, day, today, client)
        except forecast.NotFound as exc:
            return _error(str(exc))
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            log.info("air_quality failed: %s", type(exc).__name__)
            return _error("The air-quality service didn't answer. Try again in a moment.")
        return _text(json.dumps(found, ensure_ascii=False))

    async def _point(self, place: str, client: httpx.AsyncClient) -> dict[str, Any]:
        """A named place (Open-Meteo's geocoder), else here, else the Weather city."""
        place = " ".join(str(place or "").split())[:120]
        if place:
            return await forecast.find_place(place, client)
        here = await self.here()
        if here:
            city = here.get("city") or here.get("neighborhood") or "Here"
            return {**here, "city": city}
        city = self.hub.prefs.weather_city.strip()
        if city:
            return await forecast.find_place(city, client)
        return {"error": "Say which place, or set a Weather city in Settings."}


def build_server(desk: Places):
    @tool(
        "nearby_places",
        "Places near the user from Apple Maps: shops, restaurants, cafés, pharmacies, petrol "
        "or EV charging, anything. what: what to look for. near: a place to search around "
        "instead of where the user is (optional). limit: how many, default 8.",
        {
            "type": "object",
            "properties": {
                "what": {"type": "string"},
                "near": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["what"],
        },
    )
    async def nearby_places(args):
        try:
            limit = max(1, min(15, int(args.get("limit") or 8)))
        except (TypeError, ValueError):
            limit = 8
        return await desk.nearby(str(args.get("what") or ""), str(args.get("near") or ""), limit)

    @tool(
        "open_directions",
        "Open Apple Maps with directions to a place, from where the user is (or from origin). "
        "mode: driving (default), walking or transit.",
        {
            "type": "object",
            "properties": {
                "destination": {"type": "string"},
                "mode": {"type": "string"},
                "origin": {"type": "string"},
            },
            "required": ["destination"],
        },
    )
    async def open_directions(args):
        return await desk.directions(
            str(args.get("destination") or ""),
            str(args.get("mode") or ""),
            str(args.get("origin") or ""),
        )

    @tool(
        "when_to_leave",
        "When the user should set off to be somewhere by a time, from Apple Maps' travel time "
        "for that arrival (traffic-aware when driving). arrive_by: local time, like 16:30, "
        "4:30 pm or 2026-10-02T09:00. mode: driving (default), walking or transit.",
        {
            "type": "object",
            "properties": {
                "destination": {"type": "string"},
                "arrive_by": {"type": "string"},
                "mode": {"type": "string"},
            },
            "required": ["destination", "arrive_by"],
        },
    )
    async def when_to_leave(args):
        return await desk.leave_when(
            str(args.get("destination") or ""),
            str(args.get("arrive_by") or ""),
            str(args.get("mode") or ""),
        )

    @tool(
        "share_eta",
        "Text someone the user's ETA to a place (an iMessage like send_message: the user sees "
        "and hears the exact message and says yes before it goes). to: a contact name, phone "
        "number or email. destination: where the user is heading. mode: driving (default), "
        "walking or transit. Only when the user asked to share their ETA.",
        {
            "type": "object",
            "properties": {
                "to": {"type": "string"},
                "destination": {"type": "string"},
                "mode": {"type": "string"},
            },
            "required": ["to", "destination"],
        },
    )
    async def share_eta(args):
        return await desk.share(
            str(args.get("to") or ""),
            str(args.get("destination") or ""),
            str(args.get("mode") or ""),
        )

    @tool(
        "weather_for",
        "The weather for any place on any day: the high and low, what it'll be like, rain, "
        "wind, sunrise and sunset, UV and a few hours through the day. place: a city or town "
        "(omit for where the user is). date: today, tomorrow, a weekday or YYYY-MM-DD, up to "
        "15 days ahead or 30 days back.",
        {
            "type": "object",
            "properties": {"place": {"type": "string"}, "date": {"type": "string"}},
        },
    )
    async def weather_for(args):
        return await desk.weather(str(args.get("place") or ""), str(args.get("date") or ""))

    @tool(
        "air_quality",
        "The air quality in a place: the US AQI and its band (good, moderate, unhealthy…), "
        "PM2.5, PM10, ozone and nitrogen dioxide. place: omit for where the user is. date: "
        "omit for now, or a day in the next four (its worst hour).",
        {
            "type": "object",
            "properties": {"place": {"type": "string"}, "date": {"type": "string"}},
        },
    )
    async def air_quality(args):
        return await desk.air(str(args.get("place") or ""), str(args.get("date") or ""))

    return create_sdk_mcp_server(
        name=SERVER,
        version="0.1.0",
        tools=[
            nearby_places,
            open_directions,
            when_to_leave,
            share_eta,
            weather_for,
            air_quality,
        ],
    )


def install(hub: Any) -> None:
    desk = Places(hub)
    hub.places = desk
    hub.register_server(
        SERVER,
        lambda: build_server(desk),
        prompt=PROMPT,
        labels=LABELS,
        # Directions opened, a message sent: JARVIS's own words. A forecast and the air:
        # public facts (as weather_report is). Places near the owner and when they should
        # leave say where they are: the owner's own data.
        quiet=("open_directions", "share_eta", "weather_for", "air_quality"),
    )
