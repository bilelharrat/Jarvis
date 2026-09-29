"""Current weather for the dashboards, from Open-Meteo (free, no key, no account)."""

from __future__ import annotations

from typing import Any

GEOCODE = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST = "https://api.open-meteo.com/v1/forecast"

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


async def current_weather(
    city: str = "",
    client: Any = None,
    *,
    lat: float | None = None,
    lon: float | None = None,
    place: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """Current conditions plus today's outlook, by coordinates (preferred) or city name."""
    import httpx

    own = client is None
    client = client or httpx.AsyncClient(timeout=15)
    try:
        if lat is None or lon is None:
            city = city.strip()
            if not city:
                return None
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
        place = place or {}
        imperial = place.get("country", "") in IMPERIAL
        forecast = await client.get(
            FORECAST,
            params={
                "latitude": lat,
                "longitude": lon,
                "current": "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code",
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,sunset",
                "hourly": "temperature_2m,precipitation_probability,weather_code",
                "forecast_days": 2,
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
    }
