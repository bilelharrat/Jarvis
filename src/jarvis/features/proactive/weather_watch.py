"""Weather that matters, said before it matters: severe weather warnings, the air, and big
temperature swings as heads-ups, and the same facts in the morning briefing's Weather.

- Severe weather. In the US: the National Weather Service's active alerts for where the Mac
  is (api.weather.gov; free, no key), the Extreme and Severe ones (a Tornado Warning, a
  Severe Thunderstorm Warning, a Winter Storm Warning…): a heads-up for each, none for an
  update of one already said, and one that's extreme and happening now is said even in
  quiet hours. Elsewhere there is no such feed to read (Open-Meteo publishes no warnings),
  so severe weather is read from Open-Meteo's forecast for the next twelve hours:
  thunderstorms, freezing rain, heavy snow, violent showers and damaging gusts, and extreme
  heat or cold today; once a day each.
- The air: Open-Meteo's air quality (the US AQI in the US, the European AQI elsewhere). A
  heads-up the first time in a day it reaches the level set in Settings (unhealthy for
  sensitive groups, or unhealthy), and again when it gets worse.
- Temperature swings: tomorrow's high 8 °C (15 °F) or more above or below today's, said
  once, from 5 PM. The morning briefing says how today compares with yesterday.

Where: the Mac's location while Settings uses it, else the weather city (found once with
Open-Meteo's geocoder). A point sent anywhere is rounded to two decimals, about a
kilometre. With neither, or with all three kinds off, nothing is fetched.

Window: the "proactive" event's "weather" part: {place, warnings: [text], air: {aqi,
scale, level, words} | None, today: {high, yesterday, unit} | None, checked (epoch
seconds), error}. Settings (prefs.features): weather_severe (on), weather_air ("sensitive"
| "unhealthy" | "off"), weather_swings (on).
Tools (server "weather_watch"): weather_warnings. Loop: "weather_watch": every
CHECK_EVERY, the NWS alerts (in the US) and, at most every FETCH_EVERY, the forecast and
the air.

Cost: no model calls. Network while the app runs: api.weather.gov (in the US) at most 4
requests an hour, api.open-meteo.com and air-quality-api.open-meteo.com at most 2 each.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from ... import jsonstore, lang, prefs
from ... import weather as forecasts
from ...proactive import Alert
from ...timers import clock

log = logging.getLogger("jarvis")

SERVER_NAME = "weather_watch"
NWS_ALERTS = "https://api.weather.gov/alerts/active"
AIR = "https://air-quality-api.open-meteo.com/v1/air-quality"
# api.weather.gov asks every caller to name itself in the User-Agent.
USER_AGENT = "JARVIS personal assistant (macOS; weather alerts)"
CHECK_EVERY = 15 * 60
FETCH_EVERY = 30 * 60  # the forecast and the air
AHEAD_H = 12  # forecast warnings: this far ahead
SEVERITIES = ("Extreme", "Severe")
MAX_WARNINGS = 5
KEEP_DAYS = 3  # heads-ups said are remembered this long (none twice after a restart)
EVENING_HOUR = 17  # a swing tomorrow is said from this hour on
STATE_FILE = "weather_watch.json"

# Limits in the forecast's own units: °C and km/h, or °F and mph.
LIMITS = {
    False: {"heat": 35, "cold": -15, "swing": 8, "compare": 4, "gusts": 75},
    True: {"heat": 95, "cold": 5, "swing": 15, "compare": 7, "gusts": 47},
}
# WMO weather codes worth a warning.
SEVERE_CODES = {95: "storm", 96: "hail", 99: "hail", 66: "freezing", 67: "freezing"}
SEVERE_CODES |= {75: "snow", 86: "snow", 82: "showers"}
# The air: (the band's top, level, words) on each scale. Level 2 is "unhealthy for
# sensitive groups" (the European AQI's "poor"), 3 "unhealthy" ("very poor").
US_BANDS = (
    (50, 0, "good"),
    (100, 1, "moderate"),
    (150, 2, "unhealthy for sensitive groups"),
    (200, 3, "unhealthy"),
    (300, 4, "very unhealthy"),
    (math.inf, 5, "hazardous"),
)
EU_BANDS = (
    (20, 0, "good"),
    (40, 0, "fair"),
    (60, 1, "moderate"),
    (80, 2, "poor"),
    (100, 3, "very poor"),
    (math.inf, 4, "extremely poor"),
)
AIR_LEVELS = {"sensitive": 2, "unhealthy": 3}


def clean_air(value: Any) -> str | None:
    return value if value in ("off", "sensitive", "unhealthy") else None


prefs.register_feature_pref("weather_severe", True)
prefs.register_feature_pref("weather_air", "sensitive", clean_air)
prefs.register_feature_pref("weather_swings", True)

# The National Weather Service's warnings said most, in Chinese (others keep their name).
EVENTS_ZH = {
    "Tornado Warning": "龙卷风警报",
    "Tornado Watch": "龙卷风警戒",
    "Severe Thunderstorm Warning": "强雷暴警报",
    "Severe Thunderstorm Watch": "强雷暴警戒",
    "Flash Flood Warning": "山洪警报",
    "Flood Warning": "洪水警报",
    "Winter Storm Warning": "冬季风暴警报",
    "Blizzard Warning": "暴风雪警报",
    "Ice Storm Warning": "冰暴警报",
    "Excessive Heat Warning": "高温警报",
    "Extreme Heat Warning": "极端高温警报",
    "Extreme Cold Warning": "极端低温警报",
    "High Wind Warning": "大风警报",
    "Red Flag Warning": "火险红色警报",
    "Hurricane Warning": "飓风警报",
    "Tropical Storm Warning": "热带风暴警报",
    "Storm Surge Warning": "风暴潮警报",
    "Tsunami Warning": "海啸警报",
    "Dust Storm Warning": "沙尘暴警报",
}
AIR_ZH = {
    "good": "良好",
    "fair": "尚可",
    "moderate": "中等",
    "unhealthy for sensitive groups": "对敏感人群不健康",
    "poor": "较差",
    "unhealthy": "不健康",
    "very poor": "很差",
    "very unhealthy": "非常不健康",
    "extremely poor": "极差",
    "hazardous": "危险",
}
TEXTS = {
    "Severe weather": "恶劣天气",
    "Air quality": "空气质量",
    "Temperature swing": "气温骤变",
    "{event} for your area until {time}.": "{event}：你所在的地区，持续到{time}。",
    "{event} for your area.": "{event}：你所在的地区。",
    "Thunderstorms likely around {time}.": "{time}左右可能有雷暴。",
    "Thunderstorms with hail likely around {time}.": "{time}左右可能有雷暴和冰雹。",
    "Freezing rain likely around {time}: roads may be icy.": "{time}左右可能有冻雨，路面可能结冰。",
    "Heavy snow likely around {time}.": "{time}左右可能有大雪。",
    "Violent rain showers likely around {time}.": "{time}左右可能有强降雨。",
    "Gusts up to {speed} around {time}.": "{time}左右阵风可达{speed}。",
    "Extreme heat today: a high of {temp}.": "今天酷热，最高{temp}。",
    "Extreme cold today: down to {temp}.": "今天极寒，最低{temp}。",
    "The air is {words} right now (AQI {aqi}): maybe keep the windows closed.": (
        "现在空气质量{words}（AQI {aqi}），最好关上窗户。"
    ),
    "The air is {words} right now (AQI {aqi}): best to limit time outside.": (
        "现在空气质量{words}（AQI {aqi}），尽量少待在户外。"
    ),
    "Tomorrow will be much colder: a high of {temp}, {diff} degrees below today.": (
        "明天会冷很多：最高{temp}，比今天低{diff}度。"
    ),
    "Tomorrow will be much warmer: a high of {temp}, {diff} degrees above today.": (
        "明天会暖和很多：最高{temp}，比今天高{diff}度。"
    ),
}
lang.add_texts(TEXTS)

FORECAST_TEXTS = {
    "storm": "Thunderstorms likely around {time}.",
    "hail": "Thunderstorms with hail likely around {time}.",
    "freezing": "Freezing rain likely around {time}: roads may be icy.",
    "snow": "Heavy snow likely around {time}.",
    "showers": "Violent rain showers likely around {time}.",
    "gusts": "Gusts up to {speed} around {time}.",
    "heat": "Extreme heat today: a high of {temp}.",
    "cold": "Extreme cold today: down to {temp}.",
}


@dataclass
class WeatherAlert(Alert):
    """A weather heads-up: breakthrough (with urgent) says an extreme warning that's
    happening now even in quiet hours, and sends it to chats and the phone as urgent."""

    breakthrough: bool = False
    urgent: bool = False


# ── reading the answers ──


def _number(values: Any, index: int) -> float | None:
    if not isinstance(values, list) or index >= len(values):
        return None
    value = values[index]
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return float(value)


def _moment(stamp: Any) -> datetime | None:
    """An NWS time (with its offset) on this Mac's clock."""
    try:
        at = datetime.fromisoformat(str(stamp))
    except ValueError:
        return None
    return at.astimezone().replace(tzinfo=None) if at.tzinfo is not None else at


def _place_time(stamp: Any, offset: float) -> datetime | None:
    """An Open-Meteo time (on the place's own clock, offset seconds from UTC) on this Mac's
    clock."""
    try:
        at = datetime.fromisoformat(str(stamp))
    except ValueError:
        return None
    if at.tzinfo is not None:
        return at.astimezone().replace(tzinfo=None)
    utc = (at - timedelta(seconds=offset)).replace(tzinfo=UTC)
    return utc.astimezone().replace(tzinfo=None)


def place_today(offset: float, now: datetime | None = None) -> date:
    """Today on the place's own clock (the forecast's days are its days)."""
    moment = (now or datetime.now()).astimezone().astimezone(UTC)
    return (moment + timedelta(seconds=offset)).date()


def event_name(value: Any) -> str:
    """An NWS event's name as said ("Severe Thunderstorm Warning"): letters only, short."""
    return " ".join(re.sub(r"[^A-Za-z /-]", " ", str(value or "")).split())[:60]


def nws_warnings(data: Any, now: datetime) -> list[dict[str, Any]]:
    """The Extreme and Severe alerts in force in api.weather.gov's answer, the most severe
    first: [{id, event, severity, urgency, ends, refs}]."""
    features = data.get("features") if isinstance(data, dict) else None
    out = []
    for feature in features if isinstance(features, list) else []:
        props = feature.get("properties") if isinstance(feature, dict) else None
        if not isinstance(props, dict):
            continue
        if props.get("status") != "Actual" or props.get("messageType") == "Cancel":
            continue
        if props.get("severity") not in SEVERITIES:
            continue
        event = event_name(props.get("event"))
        ends = _moment(props.get("ends")) or _moment(props.get("expires"))
        if not event or (ends is not None and ends <= now):
            continue
        refs = props.get("references") if isinstance(props.get("references"), list) else []
        out.append(
            {
                "id": str(props.get("id") or props.get("@id") or "")[:200],
                "event": event,
                "severity": props["severity"],
                "urgency": str(props.get("urgency") or ""),
                "ends": ends,
                "refs": [
                    str(r["identifier"])[:200]
                    for r in refs[:20]
                    if isinstance(r, dict) and r.get("identifier")
                ],
            }
        )
    out.sort(key=lambda w: (SEVERITIES.index(w["severity"]), w["ends"] or datetime.max))
    return [w for w in out if w["id"]][:MAX_WARNINGS]


def forecast_warnings(data: Any, now: datetime, imperial: bool) -> list[dict[str, Any]]:
    """Severe weather in an Open-Meteo forecast: in the next AHEAD_H hours, the first hour
    of each kind (thunderstorms, hail, freezing rain, heavy snow, violent showers, damaging
    gusts), and extreme heat or cold today. [{kind, at, value}]"""
    if not isinstance(data, dict):
        return []
    limits = LIMITS[imperial]
    offset = _number([data.get("utc_offset_seconds")], 0) or 0.0
    hourly = data.get("hourly") if isinstance(data.get("hourly"), dict) else {}
    found: dict[str, dict[str, Any]] = {}
    stamps = hourly.get("time") if isinstance(hourly.get("time"), list) else []
    for i, stamp in enumerate(stamps[:400]):
        at = _place_time(stamp, offset)
        if at is None or not now - timedelta(hours=1) < at <= now + timedelta(hours=AHEAD_H):
            continue
        code = _number(hourly.get("weather_code"), i)
        kind = SEVERE_CODES.get(int(code)) if code is not None else None
        if kind == "hail":
            found.pop("storm", None)
        if kind and kind not in found and not (kind == "storm" and "hail" in found):
            found[kind] = {"kind": kind, "at": at, "value": None}
        gust = _number(hourly.get("wind_gusts_10m"), i)
        if gust is not None and gust >= limits["gusts"] and "gusts" not in found:
            found["gusts"] = {"kind": "gusts", "at": at, "value": round(gust)}
    highs = day_highs(data, place_today(offset, now))
    if highs["today"] is not None and highs["today"] >= limits["heat"]:
        found["heat"] = {"kind": "heat", "at": None, "value": round(highs["today"])}
    low = highs["today_low"]
    if low is not None and low <= limits["cold"]:
        found["cold"] = {"kind": "cold", "at": None, "value": round(low)}
    return list(found.values())


def day_highs(data: Any, today: date) -> dict[str, float | None]:
    """Yesterday's, today's and tomorrow's highs (and today's low) from a forecast asked for
    with past_days=1."""
    daily = data.get("daily") if isinstance(data, dict) else None
    daily = daily if isinstance(daily, dict) else {}
    days = daily.get("time") if isinstance(daily.get("time"), list) else []
    out: dict[str, float | None] = {"yesterday": None, "today": None, "tomorrow": None}
    out["today_low"] = None
    for i, stamp in enumerate(days[:20]):
        try:
            day = date.fromisoformat(str(stamp))
        except ValueError:
            continue
        name = {-1: "yesterday", 0: "today", 1: "tomorrow"}.get((day - today).days)
        if name:
            out[name] = _number(daily.get("temperature_2m_max"), i)
            if name == "today":
                out["today_low"] = _number(daily.get("temperature_2m_min"), i)
    return out


def air_band(aqi: float, scale: str) -> tuple[int, str]:
    """The air's level (0 good … 5 hazardous; 2 is unhealthy for sensitive groups) and its
    words on its own scale ("us" or "eu")."""
    for top, level, words in US_BANDS if scale == "us" else EU_BANDS:
        if aqi <= top:
            return level, words
    return 5, "hazardous"


def air_reading(data: Any, scale: str) -> dict[str, Any] | None:
    """The current AQI from Open-Meteo's air quality answer: {aqi, scale, level, words}."""
    current = data.get("current") if isinstance(data, dict) else None
    if not isinstance(current, dict):
        return None
    aqi = _number([current.get("us_aqi" if scale == "us" else "european_aqi")], 0)
    if aqi is None or aqi < 0:
        return None
    level, words = air_band(aqi, scale)
    return {"aqi": round(aqi), "scale": scale, "level": level, "words": words}


# ── the watch ──


class WeatherWatch:
    """One hub's weather heads-ups: where it is, what was last read, what was said."""

    def __init__(self, hub: Any, briefing: Any) -> None:
        self.hub = hub
        self.briefing = briefing
        self.place: dict[str, Any] | None = None
        self.nws: list[dict[str, Any]] = []
        self.forecast: dict[str, Any] | None = None
        self.air: dict[str, Any] | None = None
        self.checked = 0.0
        self.error = ""
        self._fetched: dict[str, float] = {}  # "forecast", "air": when (monotonic)
        self._geo: tuple[str, dict[str, Any] | None] | None = None  # (city, where it is)
        self._said: dict[str, str] | None = None  # key: when (ISO); read on first use
        self._saved: dict[str, str] = {}  # as last read or written: unchanged isn't saved
        self._now = datetime.now  # the clock (tests set their own)

    def install(self) -> None:
        self.hub.register_server(
            SERVER_NAME, self.build_server, prompt=PROMPT, labels=LABELS, quiet=tuple(LABELS)
        )
        self.hub.register_loop("weather_watch", self.loop)
        self.briefing.add_facts("weather", self.briefing_facts)

    # ── settings ──

    def settings(self) -> tuple[bool, str, bool]:
        feature = self.hub.prefs.feature
        air = clean_air(feature("weather_air")) or "sensitive"
        return bool(feature("weather_severe")), air, bool(feature("weather_swings"))

    def language(self) -> str:
        return "zh" if lang.is_zh(self.hub.prefs.language) else "en"

    def imperial(self) -> bool:
        return bool(self.place) and self.place["country"] in forecasts.IMPERIAL

    # ── where ──

    async def where(self, client: Any) -> dict[str, Any] | None:
        """The Mac's location (Settings › Location on), else the weather city, rounded."""
        hub = self.hub
        loc = hub.location if hub.prefs.use_location else None
        if isinstance(loc, dict) and all(
            isinstance(loc.get(k), int | float) and not isinstance(loc.get(k), bool)
            for k in ("lat", "lon")
        ):
            return {
                "lat": round(float(loc["lat"]), 2),
                "lon": round(float(loc["lon"]), 2),
                "country": str(loc.get("country") or "").upper()[:2],
                "name": " ".join(str(loc.get("city") or "").split())[:60],
            }
        city = " ".join(str(hub.prefs.weather_city or "").split())[:100]
        if not city:
            return None
        if self._geo is not None and self._geo[0] == city:
            return self._geo[1]
        answer = await client.get(
            forecasts.GEOCODE, params={"name": city, "count": 1, "language": "en"}
        )
        answer.raise_for_status()
        data = answer.json()
        results = data.get("results") if isinstance(data, dict) else None
        found = results[0] if isinstance(results, list) and results else None
        place = None
        if isinstance(found, dict):
            lat, lon = _number([found.get("latitude")], 0), _number([found.get("longitude")], 0)
            if lat is not None and lon is not None:
                place = {
                    "lat": round(lat, 2),
                    "lon": round(lon, 2),
                    "country": str(found.get("country_code") or "").upper()[:2],
                    "name": " ".join(str(found.get("name") or city).split())[:60],
                }
        self._geo = (city, place)
        return place

    # ── looking ──

    async def loop(self) -> None:
        for _ in range(30):  # the first look waits (a minute at most) for the Mac's location
            if self.hub.location is not None or not self.hub.prefs.use_location:
                break
            await asyncio.sleep(2)
        while True:
            try:
                await self.check()
            except Exception:  # one bad look never ends the watch
                log.exception("weather watch: the look failed")
            await asyncio.sleep(CHECK_EVERY)

    async def check(self, now: datetime | None = None, client: Any = None) -> list[Alert]:
        """One look: fetch what's due, then raise the heads-ups not said yet (returned)."""
        severe, air, swings = self.settings()
        if not (severe or air != "off" or swings):
            return []
        import httpx

        own = client is None
        if own:
            client = httpx.AsyncClient(timeout=15, headers={"User-Agent": USER_AGENT})
        try:
            await self._fetch(client, severe, air, swings)
        finally:
            if own:
                await client.aclose()
        now = now or self._now()
        fresh = self.due(now)
        said = self._said_keys()
        for alert in fresh:
            said[alert.key] = now.isoformat(timespec="minutes")
            self.hub.notify(alert)
        self._save(now)
        self.send()
        return fresh

    async def _fetch(self, client: Any, severe: bool, air: str, swings: bool) -> None:
        import httpx

        errors = []
        try:
            place = await self.where(client)
        except (httpx.HTTPError, ValueError) as exc:
            log.info("weather watch: no place (%s)", exc)
            self.error = "The weather city couldn't be found just now."
            return
        if place is None:
            self.place, self.nws, self.forecast, self.air = None, [], None, None
            self.error = ""
            return
        if self.place is None or (place["lat"], place["lon"]) != (
            self.place["lat"],
            self.place["lon"],
        ):
            self.nws, self.forecast, self.air, self._fetched = [], None, None, {}
        self.place = place
        mono = time.monotonic()
        if severe and place["country"] == "US":
            try:
                answer = await client.get(
                    NWS_ALERTS,
                    params={"point": f"{place['lat']:.2f},{place['lon']:.2f}"},
                    headers={"Accept": "application/geo+json"},
                )
                answer.raise_for_status()
                self.nws = nws_warnings(answer.json(), self._now())
            except (httpx.HTTPError, ValueError) as exc:
                log.info("weather watch: no NWS alerts (%s)", exc)
                errors.append("the National Weather Service")
        else:
            self.nws = []
        if mono - self._fetched.get("forecast", -math.inf) >= FETCH_EVERY:
            try:
                answer = await client.get(forecasts.FORECAST, params=self._forecast_params())
                answer.raise_for_status()
                data = answer.json()
                self.forecast = data if isinstance(data, dict) else None
                self._fetched["forecast"] = mono
            except (httpx.HTTPError, ValueError) as exc:
                log.info("weather watch: no forecast (%s)", exc)
                errors.append("the forecast")
        if air == "off":
            self.air = None
        elif mono - self._fetched.get("air", -math.inf) >= FETCH_EVERY:
            scale = "us" if place["country"] == "US" else "eu"
            try:
                answer = await client.get(
                    AIR,
                    params={
                        "latitude": place["lat"],
                        "longitude": place["lon"],
                        "current": "us_aqi,european_aqi",
                        "timezone": "auto",
                    },
                )
                answer.raise_for_status()
                self.air = air_reading(answer.json(), scale)
                self._fetched["air"] = mono
            except (httpx.HTTPError, ValueError) as exc:
                log.info("weather watch: no air quality (%s)", exc)
                errors.append("the air quality")
        self.checked = time.time()
        self.error = ("Couldn't reach " + " or ".join(errors) + ".") if errors else ""

    def _forecast_params(self) -> dict[str, Any]:
        assert self.place is not None
        imperial = self.imperial()
        return {
            "latitude": self.place["lat"],
            "longitude": self.place["lon"],
            "hourly": "weather_code,wind_gusts_10m",
            "daily": "temperature_2m_max,temperature_2m_min",
            "past_days": 1,
            "forecast_days": 2,
            "timezone": "auto",
            "temperature_unit": "fahrenheit" if imperial else "celsius",
            "wind_speed_unit": "mph" if imperial else "kmh",
        }

    # ── what to say ──

    def due(self, now: datetime) -> list[Alert]:
        """The heads-ups now that haven't been said: the warnings, the air, a swing."""
        severe, air, swings = self.settings()
        said = self._said_keys()
        out: list[Alert] = []
        if severe:
            out += self._nws_alerts(said, now)
            if self.place is not None and self.place["country"] != "US":
                out += self._forecast_alerts(now)
        if air != "off" and self.air is not None and self.air["level"] >= AIR_LEVELS[air]:
            out.append(self._air_alert(now))
        if swings and now.hour >= EVENING_HOUR:
            swing = self._swing_alert(now)
            if swing is not None:
                out.append(swing)
        return [a for a in out if a.key not in said]

    def _say(self, template: str, **values: Any) -> str:
        return lang.tr(template, self.language(), **values)

    def _clock(self, at: datetime) -> str:
        return clock(at.replace(second=0, microsecond=0), self.language())

    def _event(self, event: str) -> str:
        return EVENTS_ZH.get(event, event) if self.language() == "zh" else event

    def _nws_alerts(self, said: dict[str, str], now: datetime) -> list[Alert]:
        out = []
        for w in self.in_force(now):
            key = f"weather:nws:{w['id']}"
            if any(f"weather:nws:{ref}" in said for ref in w["refs"]):
                said.setdefault(key, now.isoformat(timespec="minutes"))
                continue  # an update of one already said
            ends = w["ends"]
            event = self._event(w["event"])
            text = (
                self._say(
                    "{event} for your area until {time}.", event=event, time=self._clock(ends)
                )
                if ends is not None
                else self._say("{event} for your area.", event=event)
            )
            now_extreme = w["severity"] == "Extreme" and w["urgency"] == "Immediate"
            until = f" until {ends:%-I:%M %p}" if ends is not None else ""
            out.append(
                WeatherAlert(
                    key,
                    "weather",
                    self._say("Severe weather"),
                    text,
                    note=f"a {w['event']} from the National Weather Service{until}",
                    breakthrough=now_extreme,
                    urgent=now_extreme,
                )
            )
        return out

    def _forecast_alerts(self, now: datetime) -> list[Alert]:
        imperial = self.imperial()
        unit = "°F" if imperial else "°C"
        speed_unit = "mph" if imperial else "km/h"
        out = []
        for w in forecast_warnings(self.forecast, now, imperial):
            values: dict[str, Any] = {}
            if w["at"] is not None:
                values["time"] = self._clock(w["at"])
            if w["kind"] == "gusts":
                values["speed"] = f"{w['value']} {speed_unit}"
            elif w["kind"] in ("heat", "cold"):
                values["temp"] = f"{w['value']}{unit}"
            text = self._say(FORECAST_TEXTS[w["kind"]], **values)
            out.append(
                WeatherAlert(
                    f"weather:{w['kind']}:{now.date().isoformat()}",
                    "weather",
                    self._say("Severe weather"),
                    text,
                    note=f"forecast: {FORECAST_TEXTS[w['kind']].format(**values)}",
                )
            )
        return out

    def _air_alert(self, now: datetime) -> Alert:
        assert self.air is not None
        level, aqi = self.air["level"], self.air["aqi"]
        words = self.air["words"]
        if self.language() == "zh":
            words = AIR_ZH.get(words, words)
        template = (
            "The air is {words} right now (AQI {aqi}): maybe keep the windows closed."
            if level <= 2
            else "The air is {words} right now (AQI {aqi}): best to limit time outside."
        )
        return WeatherAlert(
            f"weather:air:{now.date().isoformat()}:{level}",
            "weather",
            self._say("Air quality"),
            self._say(template, words=words, aqi=aqi),
            note=f"the air quality is {self.air['words']} (AQI {aqi})",
        )

    def _swing_alert(self, now: datetime) -> Alert | None:
        highs = self.highs(now)
        today, tomorrow = highs["today"], highs["tomorrow"]
        if today is None or tomorrow is None:
            return None
        diff = round(tomorrow - today)
        if abs(diff) < LIMITS[self.imperial()]["swing"]:
            return None
        unit = "°F" if self.imperial() else "°C"
        template = (
            "Tomorrow will be much colder: a high of {temp}, {diff} degrees below today."
            if diff < 0
            else "Tomorrow will be much warmer: a high of {temp}, {diff} degrees above today."
        )
        text = self._say(template, temp=f"{round(tomorrow)}{unit}", diff=abs(diff))
        return WeatherAlert(
            f"weather:swing:{now.date().isoformat()}",
            "weather",
            self._say("Temperature swing"),
            text,
            note=f"tomorrow's high is {round(tomorrow)}{unit}, {abs(diff)} degrees "
            + ("below" if diff < 0 else "above")
            + " today's",
        )

    def highs(self, now: datetime | None = None) -> dict[str, float | None]:
        offset = _number([(self.forecast or {}).get("utc_offset_seconds")], 0) or 0.0
        return day_highs(self.forecast, place_today(offset, now or self._now()))

    def in_force(self, now: datetime) -> list[dict[str, Any]]:
        """The NWS warnings last read that haven't ended by now."""
        return [w for w in self.nws if w["ends"] is None or w["ends"] > now]

    # ── the briefing and the window ──

    def warning_lines(self, now: datetime | None = None) -> list[str]:
        """The warnings in force, in English (for Claude and the briefing)."""
        now = now or self._now()
        lines = []
        for w in self.in_force(now):
            until = f" until {w['ends']:%-I:%M %p}" if w["ends"] is not None else ""
            lines.append(f"{w['event']}{until} (National Weather Service)")
        if self.place is not None and self.place["country"] != "US":
            imperial = self.imperial()
            for w in forecast_warnings(self.forecast, now, imperial):
                values: dict[str, Any] = {}
                if w["at"] is not None:
                    values["time"] = f"{w['at']:%-I %p}"
                if w["kind"] == "gusts":
                    values["speed"] = f"{w['value']} {'mph' if imperial else 'km/h'}"
                elif w["kind"] in ("heat", "cold"):
                    values["temp"] = f"{w['value']}{'°F' if imperial else '°C'}"
                lines.append(FORECAST_TEXTS[w["kind"]].format(**values).rstrip("."))
        return lines

    async def briefing_facts(self) -> str:
        """For the briefing's Weather: warnings, the air, today against yesterday."""
        parts = []
        warnings = self.warning_lines() if self.settings()[0] else []
        if warnings:
            parts.append("Warnings: " + "; ".join(warnings) + ".")
        if self.air is not None and self.air["level"] >= 1:
            parts.append(f"The air: {self.air['words']} (AQI {self.air['aqi']}).")
        highs = self.highs()
        today, yesterday = highs["today"], highs["yesterday"]
        if today is not None and yesterday is not None:
            diff = round(today - yesterday)
            if abs(diff) >= LIMITS[self.imperial()]["compare"]:
                unit = "°F" if self.imperial() else "°C"
                way = "warmer" if diff > 0 else "colder"
                parts.append(
                    f"Today's high of {round(today)}{unit} is {abs(diff)} degrees {way} "
                    "than yesterday's."
                )
        return " ".join(parts)

    def warning_texts(self, now: datetime | None = None) -> list[str]:
        """The warnings in force as the heads-ups say them (the owner's language)."""
        now = now or self._now()
        texts = []
        for w in self.in_force(now):
            event = self._event(w["event"])
            texts.append(
                self._say(
                    "{event} for your area until {time}.", event=event, time=self._clock(w["ends"])
                )
                if w["ends"] is not None
                else self._say("{event} for your area.", event=event)
            )
        if self.place is not None and self.place["country"] != "US":
            texts += [a.text for a in self._forecast_alerts(now)]
        return texts

    def state(self) -> dict[str, Any]:
        highs = self.highs()
        today = None
        if highs["today"] is not None:
            today = {
                "high": round(highs["today"]),
                "yesterday": round(highs["yesterday"]) if highs["yesterday"] is not None else None,
                "unit": "°F" if self.imperial() else "°C",
            }
        air = None
        if self.air is not None:
            words = self.air["words"]
            air = {
                **self.air,
                "words": AIR_ZH.get(words, words) if self.language() == "zh" else words,
            }
        return {
            "place": (self.place or {}).get("name", ""),
            "warnings": self.warning_texts(),
            "air": air,
            "today": today,
            "checked": self.checked,
            "error": self.error,
        }

    def send(self) -> None:
        self.hub.emit("proactive", weather=self.state())

    # ── what was said ──

    def _said_keys(self) -> dict[str, str]:
        if self._said is None:
            self._said = {}
            try:
                data = jsonstore.load_json(self.hub.feature_path(STATE_FILE), dict)
            except OSError as exc:
                log.info("weather watch: what was said can't be read (%s)", exc)
                data = None
            said = data.get("said") if isinstance(data, dict) else None
            if isinstance(said, dict):
                self._said = {
                    str(k)[:260]: str(v)[:32]
                    for k, v in list(said.items())[:500]
                    if isinstance(v, str)
                }
            self._saved = dict(self._said)
        return self._said

    def _save(self, now: datetime) -> None:
        cutoff = (now - timedelta(days=KEEP_DAYS)).isoformat(timespec="minutes")
        said = {k: v for k, v in self._said_keys().items() if v >= cutoff}
        self._said = said
        if said == self._saved:
            return  # nothing new to keep
        try:
            jsonstore.save_json(self.hub.feature_path(STATE_FILE), {"said": said})
            self._saved = dict(said)
        except OSError as exc:  # said again after a restart at worst
            log.info("weather watch: couldn't save what was said (%s)", exc)

    # ── the brain's tool ──

    def build_server(self):
        return create_sdk_mcp_server(name=SERVER_NAME, version="0.1.0", tools=self.tools())

    def tools(self) -> list:
        @tool(
            "weather_warnings",
            "Severe weather warnings in force where the user is (the National Weather "
            "Service in the US, the forecast elsewhere), the air quality, and how today's "
            "high compares with yesterday's, as last checked (every 15 minutes).",
            {},
        )
        async def weather_warnings(_args):
            if self.place is None:
                return _text(
                    "No place to watch: Settings needs Location on, or a weather city.",
                    error=True,
                )
            lines = [f"Watching {self.place['name'] or 'the weather city'}."]
            warnings = self.warning_lines()
            lines.append(
                "Warnings: " + "; ".join(warnings) + "." if warnings else "No warnings in force."
            )
            if self.air is not None:
                lines.append(f"The air: {self.air['words']} (AQI {self.air['aqi']}).")
            facts = await self.briefing_facts()
            if "yesterday's" in facts:
                lines.append(facts[facts.index("Today's high") :])
            if self.error:
                lines.append(self.error)
            return _text("\n".join(lines))

        return [weather_warnings]


LABELS = {"weather_warnings": "Checked weather warnings"}
PROMPT = (
    "\n- Weather warnings: weather_warnings says the severe weather warnings in force where "
    "the user is, the air quality and today against yesterday (JARVIS also says these as "
    "heads-ups by itself)."
)


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out
