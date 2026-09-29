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


async def current_weather(city: str, client: Any = None) -> dict[str, Any] | None:
    """{'city', 'region', 'temp', 'feels', 'humidity', 'wind', 'unit', 'wind_unit', 'summary', 'code'}."""
    import httpx

    city = city.strip()
    if not city:
        return None
    own = client is None
    client = client or httpx.AsyncClient(timeout=15)
    try:
        geo = await client.get(GEOCODE, params={"name": city, "count": 1, "language": "en"})
        geo.raise_for_status()
        places = geo.json().get("results") or []
        if not places:
            return {"city": city, "error": "I couldn't find that place."}
        place = places[0]
        imperial = place.get("country_code") in IMPERIAL
        forecast = await client.get(
            FORECAST,
            params={
                "latitude": place["latitude"],
                "longitude": place["longitude"],
                "current": "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code",
                "temperature_unit": "fahrenheit" if imperial else "celsius",
                "wind_speed_unit": "mph" if imperial else "kmh",
            },
        )
        forecast.raise_for_status()
        now = forecast.json()["current"]
    finally:
        if own:
            await client.aclose()
    code = int(now.get("weather_code", 0))
    return {
        "city": place.get("name", city),
        "region": ", ".join(p for p in (place.get("admin1"), place.get("country_code")) if p),
        "temp": round(now["temperature_2m"]),
        "feels": round(now["apparent_temperature"]),
        "humidity": round(now["relative_humidity_2m"]),
        "wind": round(now["wind_speed_10m"]),
        "unit": "°F" if imperial else "°C",
        "wind_unit": "mph" if imperial else "km/h",
        "code": code,
        "summary": CODES.get(code, "weather"),
    }
