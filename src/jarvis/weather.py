"""Current weather for the dashboards, from Open-Meteo (free, no key, no account)."""

from __future__ import annotations

import time
from typing import Any

GEOCODE = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST = "https://api.open-meteo.com/v1/forecast"
PLACE_SECONDS = 24 * 3600  # a weather city is looked up again after this long
PLACES_KEPT = 16

# Where each weather city is, as the geocoder last found it: city -> (when, lat, lon, place).
# Without a location of its own the hub asks for the weather every minute, and a city
# doesn't move: one lookup a day instead of one a minute.
_PLACES: dict[str, tuple[float, Any, Any, dict[str, Any]]] = {}
_TLS: Any = None  # see tls()


def tls() -> Any:
    """httpx's own default TLS settings (certifi's roots, or SSL_CERT_FILE or SSL_CERT_DIR),
    made once and shared by the clients the weather makes for itself: each new client would
    otherwise read and parse the whole bundle of root certificates again, milliseconds on
    the event loop every time. (Each connection sets its protocols on it: only clients
    that all speak HTTP/1.1, httpx's default, share it.)"""
    global _TLS
    if _TLS is None:
        import httpx

        _TLS = httpx.create_ssl_context()
    return _TLS


def _known_place(city: str) -> tuple[Any, Any, dict[str, Any]] | None:
    found = _PLACES.get(city)
    if found is None or time.monotonic() - found[0] >= PLACE_SECONDS:
        return None
    return found[1], found[2], dict(found[3])


def _keep_place(city: str, lat: Any, lon: Any, place: dict[str, Any]) -> None:
    _PLACES.pop(city, None)
    _PLACES[city] = (time.monotonic(), lat, lon, dict(place))
    while len(_PLACES) > PLACES_KEPT:  # the oldest go first
        del _PLACES[next(iter(_PLACES))]


# WMO weather codes -> words.
CODES = {
    0: "clear sky",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "fog",
    48: "fog",
    51: "light drizzle",
    53: "drizzle",
    55: "heavy drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    66: "freezing rain",
    67: "freezing rain",
    71: "light snow",
    73: "snow",
    75: "heavy snow",
    77: "snow grains",
    80: "rain showers",
    81: "rain showers",
    82: "violent rain showers",
    85: "snow showers",
    86: "snow showers",
    95: "thunderstorm",
    96: "thunderstorm with hail",
    99: "thunderstorm with hail",
}
IMPERIAL = {"US", "LR", "MM"}
DAYS = 7  # the forecast the weather panel shows
HOURS = 24  # the hourly strip in the weather panel
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def _round(value: Any) -> int | None:
    return round(value) if isinstance(value, int | float) else None


def _clock(stamp: Any) -> str:
    """'2026-09-29T07:03' -> '07:03'."""
    return stamp[-5:] if isinstance(stamp, str) and "T" in stamp else ""


def _weekday(day: str) -> str:
    from datetime import date

    try:
        return WEEKDAYS[date.fromisoformat(day).weekday()]
    except (TypeError, ValueError):
        return ""


def _details(now: dict[str, Any], imperial: bool) -> dict[str, Any]:
    """The weather panel's tiles: what the card has no room for."""
    direction = now.get("wind_direction_10m")
    visibility = now.get("visibility")  # metres, whatever the other units
    pressure = now.get("pressure_msl")  # hPa
    if isinstance(visibility, int | float):
        visibility = round(visibility / (1609.344 if imperial else 1000), 1)
    if isinstance(pressure, int | float):
        pressure = round(pressure * 0.02953, 2) if imperial else round(pressure)
    return {
        "gusts": _round(now.get("wind_gusts_10m")),
        "wind_dir": COMPASS[round(direction / 45) % 8]
        if isinstance(direction, int | float)
        else "",
        "wind_deg": _round(direction),
        "pressure": pressure if isinstance(pressure, int | float) else None,
        "pressure_unit": "inHg" if imperial else "hPa",
        "visibility": visibility if isinstance(visibility, int | float) else None,
        "visibility_unit": "mi" if imperial else "km",
        "clouds": _round(now.get("cloud_cover")),
        "uv": _round(now.get("uv_index")),
        "is_day": bool(now.get("is_day", 1)),
    }


async def current_weather(
    city: str = "",
    client: Any = None,
    *,
    lat: float | None = None,
    lon: float | None = None,
    place: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """Current conditions plus today's outlook, by coordinates (preferred) or city name.
    Without a client of the caller's, a city found is remembered for a day (_PLACES)."""
    import httpx

    own = client is None
    client = client or httpx.AsyncClient(timeout=15, verify=tls())
    try:
        if lat is None or lon is None:
            city = city.strip()
            if not city:
                return None
            known = _known_place(city) if own else None
            if known is not None:
                lat, lon, place = known
            else:
                geo = await client.get(GEOCODE, params={"name": city, "count": 1, "language": "en"})
                geo.raise_for_status()
                places = geo.json().get("results") or []
                if not places:
                    return {"city": city, "error": "I couldn't find that place."}
                found = places[0]
                lat, lon = found["latitude"], found["longitude"]
                place = {
                    "city": found.get("name", city),
                    "region": found.get("admin1", ""),
                    "country": found.get("country_code", ""),
                }
                if own:
                    _keep_place(city, lat, lon, place)
        place = place or {}
        imperial = place.get("country", "") in IMPERIAL
        forecast = await client.get(
            FORECAST,
            params={
                "latitude": lat,
                "longitude": lon,
                "current": "temperature_2m,relative_humidity_2m,apparent_temperature,"
                "wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover,"
                "visibility,uv_index,is_day,weather_code",
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,"
                "weather_code,sunrise,sunset,uv_index_max",
                "hourly": "temperature_2m,precipitation_probability,weather_code,is_day",
                "forecast_days": DAYS,
                "timezone": "auto",
                "temperature_unit": "fahrenheit" if imperial else "celsius",
                "wind_speed_unit": "mph" if imperial else "kmh",
            },
        )
        forecast.raise_for_status()
        data = forecast.json()
    finally:
        if own:
            await client.aclose()
    now = data["current"]
    daily = data.get("daily", {})
    hourly = data.get("hourly", {})
    code = int(now.get("weather_code", 0))
    start = next((i for i, t in enumerate(hourly.get("time", [])) if t >= now.get("time", "")), 0)
    next_hours = [
        {
            "time": hourly["time"][i][-5:],
            "temp": round(hourly["temperature_2m"][i]),
            "rain": hourly["precipitation_probability"][i],
            "summary": CODES.get(int(hourly["weather_code"][i]), ""),
        }
        for i in range(start, min(start + 6, len(hourly.get("time", []))))
    ]

    def hourly_at(key: str, i: int) -> Any:
        values = hourly.get(key) or []
        return values[i] if i < len(values) else None

    def daily_at(key: str, i: int) -> Any:
        values = daily.get(key) or []
        return values[i] if i < len(values) else None

    hours = [
        {
            "at": hourly["time"][i],
            "time": hourly["time"][i][-5:],
            "temp": _round(hourly_at("temperature_2m", i)),
            "rain": hourly_at("precipitation_probability", i),
            "code": int(hourly_at("weather_code", i) or 0),
            "summary": CODES.get(int(hourly_at("weather_code", i) or 0), ""),
            "is_day": bool(hourly_at("is_day", i) if hourly_at("is_day", i) is not None else 1),
        }
        for i in range(start, min(start + HOURS, len(hourly.get("time", []))))
    ]
    days = [
        {
            "date": day,
            "day": _weekday(day),
            "high": _round(daily_at("temperature_2m_max", i)),
            "low": _round(daily_at("temperature_2m_min", i)),
            "rain": daily_at("precipitation_probability_max", i),
            "code": int(daily_at("weather_code", i) or 0),
            "summary": CODES.get(int(daily_at("weather_code", i) or 0), ""),
            "sunrise": daily_at("sunrise", i) or "",
            "sunset": daily_at("sunset", i) or "",
        }
        for i, day in enumerate(daily.get("time") or [])
    ]
    return {
        "city": place.get("city", city),
        "region": ", ".join(p for p in (place.get("region"), place.get("country")) if p),
        "temp": round(now["temperature_2m"]),
        "feels": round(now["apparent_temperature"]),
        "humidity": round(now["relative_humidity_2m"]),
        "wind": round(now["wind_speed_10m"]),
        "unit": "°F" if imperial else "°C",
        "wind_unit": "mph" if imperial else "km/h",
        "code": code,
        "summary": CODES.get(code, "weather"),
        "high": round(daily["temperature_2m_max"][0]) if daily.get("temperature_2m_max") else None,
        "low": round(daily["temperature_2m_min"][0]) if daily.get("temperature_2m_min") else None,
        "rain_chance": daily["precipitation_probability_max"][0]
        if daily.get("precipitation_probability_max")
        else None,
        "tomorrow": {
            "high": round(daily["temperature_2m_max"][1]),
            "low": round(daily["temperature_2m_min"][1]),
            "rain_chance": daily["precipitation_probability_max"][1],
            "summary": CODES.get(int(daily["weather_code"][1]), ""),
        }
        if len(daily.get("temperature_2m_max", [])) > 1
        else None,
        "next_hours": next_hours,
        "from_location": place.get("from_location", False),
        # For the weather panel (the card opens it): more than the card and replies use.
        "observed": now.get("time", ""),
        "details": _details(now, imperial),
        "sunrise": _clock(daily_at("sunrise", 0)),
        "sunset": _clock(daily_at("sunset", 0)),
        "uv_max": _round(daily_at("uv_index_max", 0)),
        "hours": hours,
        "days": days,
    }
