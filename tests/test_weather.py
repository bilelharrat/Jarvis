import httpx

from jarvis.weather import current_weather


async def test_weather_by_coordinates_with_outlook():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["latitude"] == "45.5"
        assert request.url.params["temperature_unit"] == "fahrenheit"
        return httpx.Response(
            200,
            json={
                "current": {
                    "time": "2026-09-28T21:00",
                    "temperature_2m": 56.4,
                    "relative_humidity_2m": 80,
                    "apparent_temperature": 54.2,
                    "wind_speed_10m": 6.1,
                    "weather_code": 61,
                },
                "daily": {
                    "temperature_2m_max": [68, 72],
                    "temperature_2m_min": [50, 51],
                    "precipitation_probability_max": [70, 10],
                    "weather_code": [61, 1],
                },
                "hourly": {
                    "time": ["2026-09-28T20:00", "2026-09-28T21:00", "2026-09-28T22:00"],
                    "temperature_2m": [57, 56, 55],
                    "precipitation_probability": [60, 65, 40],
                    "weather_code": [61, 61, 3],
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        w = await current_weather(
            client=client,
            lat=45.5,
            lon=-122.9,
            place={"city": "Hillsboro", "region": "OR", "country": "US", "from_location": True},
        )
    assert (w["city"], w["temp"], w["unit"], w["summary"]) == ("Hillsboro", 56, "°F", "light rain")
    assert (w["high"], w["low"], w["rain_chance"]) == (68, 50, 70)
    assert [h["time"] for h in w["next_hours"]] == ["21:00", "22:00"]
    assert w["tomorrow"]["summary"] == "mainly clear" and w["from_location"] is True
