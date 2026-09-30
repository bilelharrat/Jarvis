"""Weather for any place and any day, and the air quality, from Open-Meteo (free, no key,
no account; the same service as weather.py's panel).

A place is found with Open-Meteo's geocoder; a day is any from a month back to fifteen
days ahead (what the forecast service keeps). Air quality comes from Open-Meteo's
air-quality service: the US AQI with its band, and the particles behind it; a day's
forecast (about five days ahead) is its worst hour.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any

import httpx

from .weather import CODES, FORECAST, GEOCODE, IMPERIAL

AIR = "https://air-quality-api.open-meteo.com/v1/air-quality"
MAX_AHEAD = 15  # days after today the forecast reaches
MAX_BACK = 30  # days before today still kept in the forecast service
AIR_AHEAD = 4  # the air-quality forecast's reach
DAY_HOURS = (6, 9, 12, 15, 18, 21)  # the hours a day's forecast mentions
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
WEEKDAYS_ZH = ["一", "二", "三", "四", "五", "六", "日"]
# US AQI bands (EPA): the top of each and its name.
AQI_BANDS = [
    (50, "good"),
    (100, "moderate"),
    (150, "unhealthy for sensitive groups"),
    (200, "unhealthy"),
    (300, "very unhealthy"),
    (10_000, "hazardous"),
]
_CLOCK = re.compile(r"\d{4}-\d\d-\d\dT(\d\d):(\d\d)")


class NotFound(ValueError):
    pass


def aqi_band(aqi: float | None) -> str:
    if aqi is None:
        return ""
    return next(name for top, name in AQI_BANDS if aqi <= top)


def parse_day(text: str | None, today: date) -> date:
    """The day someone means: "", today, tomorrow, yesterday, a weekday (the next one, today
    counting), 明天, 周三, or 2026-10-02. ValueError when it isn't one."""
    raw = str(text or "").strip().lower()
    if raw in ("", "today", "now", "tonight", "今天", "今晚", "现在"):
        return today
    if raw in ("tomorrow", "明天"):
        return today + timedelta(days=1)
    if raw in ("day after tomorrow", "后天"):
        return today + timedelta(days=2)
    if raw in ("yesterday", "昨天"):
        return today - timedelta(days=1)
    words = raw.removeprefix("this ").removeprefix("next ").removeprefix("on ")
    if words in WEEKDAYS:
        return today + timedelta(days=(WEEKDAYS.index(words) - today.weekday()) % 7)
    m = re.fullmatch(r"(?:下?(?:周|星期|礼拜))([一二三四五六日天])", raw)
    if m:
        wanted = WEEKDAYS_ZH.index("日" if m.group(1) == "天" else m.group(1))
        ahead = (wanted - today.weekday()) % 7
        if raw.startswith("下"):
            ahead = ahead or 7
        return today + timedelta(days=ahead)
    return date.fromisoformat(raw[:10])


def check_range(day: date, today: date, ahead: int = MAX_AHEAD, back: int = MAX_BACK) -> None:
    if day > today + timedelta(days=ahead):
        raise ValueError(f"The forecast only reaches {ahead} days ahead.")
    if day < today - timedelta(days=back):
        raise ValueError(f"I only have the last {back} days.")


async def find_place(name: str, client: httpx.AsyncClient) -> dict[str, Any]:
    """The first place Open-Meteo's geocoder has for a name: {city, region, country, lat,
    lon}. NotFound when it has none."""
    response = await client.get(GEOCODE, params={"name": name, "count": 1, "language": "en"})
    response.raise_for_status()
    places = response.json().get("results") or []
    if not places:
        raise NotFound(f"I couldn't find {name}.")
    found = places[0]
    return {
        "city": str(found.get("name") or name),
        "region": str(found.get("admin1") or ""),
        "country": str(found.get("country_code") or ""),
        "lat": float(found["latitude"]),
        "lon": float(found["longitude"]),
    }


def _at(values: Any, i: int) -> Any:
    return values[i] if isinstance(values, list) and i < len(values) else None


def _num(value: Any, digits: int = 0) -> float | int | None:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return None
    return round(value, digits) if digits else round(value)


def _where(place: dict[str, Any]) -> dict[str, Any]:
    return {
        "city": place.get("city") or "",
        "region": ", ".join(p for p in (place.get("region"), place.get("country")) if p),
    }


async def day_weather(
    place: dict[str, Any], day: date, client: httpx.AsyncClient | None = None
) -> dict[str, Any]:
    """One day's forecast (or record) for a place with lat and lon: high, low, what it'll
    be like, rain, wind, sunrise and sunset, UV, and a few hours through the day."""
    imperial = place.get("country", "") in IMPERIAL
    params = {
        "latitude": place["lat"],
        "longitude": place["lon"],
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,"
        "precipitation_sum,weather_code,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset,"
        "uv_index_max",
        "hourly": "temperature_2m,precipitation_probability,weather_code",
        "start_date": day.isoformat(),
        "end_date": day.isoformat(),
        "timezone": "auto",
        "temperature_unit": "fahrenheit" if imperial else "celsius",
        "wind_speed_unit": "mph" if imperial else "kmh",
        "precipitation_unit": "inch" if imperial else "mm",
    }
    own = client is None
    client = client or httpx.AsyncClient(timeout=15)
    try:
        response = await client.get(FORECAST, params=params)
        response.raise_for_status()
        data = response.json()
    finally:
        if own:
            await client.aclose()
    daily, hourly = data.get("daily") or {}, data.get("hourly") or {}
    code = _at(daily.get("weather_code"), 0)
    hours = []
    for i, stamp in enumerate(hourly.get("time") or []):
        clock = _CLOCK.match(stamp) if isinstance(stamp, str) else None
        if clock is None or int(clock.group(1)) not in DAY_HOURS:
            continue
        hour_code = _at(hourly.get("weather_code"), i)
        hours.append(
            {
                "time": f"{clock.group(1)}:{clock.group(2)}",
                "temp": _num(_at(hourly.get("temperature_2m"), i)),
                "rain_chance": _num(_at(hourly.get("precipitation_probability"), i)),
                "summary": CODES.get(int(hour_code), "") if isinstance(hour_code, int) else "",
            }
        )
    sunrise, sunset = _at(daily.get("sunrise"), 0), _at(daily.get("sunset"), 0)
    sunrise = _CLOCK.match(sunrise) if isinstance(sunrise, str) else None
    sunset = _CLOCK.match(sunset) if isinstance(sunset, str) else None
    return {
        **_where(place),
        "date": day.isoformat(),
        "weekday": WEEKDAYS[day.weekday()].capitalize(),
        "summary": CODES.get(int(code), "weather") if isinstance(code, int) else "",
        "high": _num(_at(daily.get("temperature_2m_max"), 0)),
        "low": _num(_at(daily.get("temperature_2m_min"), 0)),
        "unit": "°F" if imperial else "°C",
        "rain_chance": _num(_at(daily.get("precipitation_probability_max"), 0)),
        "rain_amount": _num(_at(daily.get("precipitation_sum"), 0), 2),
        "rain_unit": "in" if imperial else "mm",
        "wind_max": _num(_at(daily.get("wind_speed_10m_max"), 0)),
        "gusts_max": _num(_at(daily.get("wind_gusts_10m_max"), 0)),
        "wind_unit": "mph" if imperial else "km/h",
        "sunrise": f"{sunrise.group(1)}:{sunrise.group(2)}" if sunrise else "",
        "sunset": f"{sunset.group(1)}:{sunset.group(2)}" if sunset else "",
        "uv_max": _num(_at(daily.get("uv_index_max"), 0)),
        "hours": hours,
    }


async def air_quality(
    place: dict[str, Any],
    day: date | None = None,
    today: date | None = None,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """The air now (day None or today) or a coming day's worst hour: the US AQI and its
    band, PM2.5, PM10, ozone and nitrogen dioxide (µg/m³)."""
    params: dict[str, Any] = {
        "latitude": place["lat"],
        "longitude": place["lon"],
        "timezone": "auto",
        "current": "us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide",
    }
    later = day is not None and today is not None and day != today
    if later:
        params["hourly"] = "us_aqi,pm2_5,pm10"
        params["start_date"] = params["end_date"] = day.isoformat()
    own = client is None
    client = client or httpx.AsyncClient(timeout=15)
    try:
        response = await client.get(AIR, params=params)
        response.raise_for_status()
        data = response.json()
    finally:
        if own:
            await client.aclose()
    if later:
        hourly = data.get("hourly") or {}
        values = hourly.get("us_aqi") if isinstance(hourly.get("us_aqi"), list) else []
        readings = [(v, i) for i, v in enumerate(values) if _num(v) is not None]
        if not readings:
            raise NotFound("There's no air-quality forecast for that day yet.")
        top, worst = max(readings)
        aqi = _num(top)
        stamp = _at(hourly.get("time"), worst)
        clock = _CLOCK.match(stamp) if isinstance(stamp, str) else None
        return {
            **_where(place),
            "date": day.isoformat(),
            "aqi": aqi,
            "band": aqi_band(aqi),
            "worst_hour": f"{clock.group(1)}:{clock.group(2)}" if clock else "",
            "pm2_5": _num(_at(hourly.get("pm2_5"), worst), 1),
            "pm10": _num(_at(hourly.get("pm10"), worst), 1),
        }
    now = data.get("current") or {}
    aqi = _num(now.get("us_aqi"))
    if aqi is None:
        raise NotFound("There's no air-quality reading for that place right now.")
    return {
        **_where(place),
        "date": (today or date.today()).isoformat(),
        "aqi": aqi,
        "band": aqi_band(aqi),
        "pm2_5": _num(now.get("pm2_5"), 1),
        "pm10": _num(now.get("pm10"), 1),
        "ozone": _num(now.get("ozone"), 1),
        "no2": _num(now.get("nitrogen_dioxide"), 1),
    }
