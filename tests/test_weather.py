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


async def test_the_weather_panel_gets_hours_days_and_details():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["forecast_days"] == "7"
        hours = [f"2026-09-29T{h:02d}:00" for h in range(24)] + [
            f"2026-09-30T{h:02d}:00" for h in range(24)
        ]
        return httpx.Response(
            200,
            json={
                "current": {
                    "time": "2026-09-29T13:15",
                    "temperature_2m": 81.7,
                    "relative_humidity_2m": 37,
                    "apparent_temperature": 84.0,
                    "wind_speed_10m": 3.2,
                    "wind_direction_10m": 8,
                    "wind_gusts_10m": 4.9,
                    "pressure_msl": 1009.6,
                    "cloud_cover": 0,
                    "visibility": 47300.0,
                    "uv_index": 6.2,
                    "is_day": 1,
                    "weather_code": 0,
                },
                "daily": {
                    "time": ["2026-09-29", "2026-09-30"],
                    "temperature_2m_max": [85.0, 88.5],
                    "temperature_2m_min": [51.6, 56.1],
                    "precipitation_probability_max": [0, 30],
                    "weather_code": [2, 61],
                    "sunrise": ["2026-09-29T07:03", "2026-09-30T07:04"],
                    "sunset": ["2026-09-29T18:55", "2026-09-30T18:53"],
                    "uv_index_max": [6.1, 6.05],
                },
                "hourly": {
                    "time": hours,
                    "temperature_2m": list(range(48)),
                    "precipitation_probability": [0] * 48,
                    "weather_code": [0] * 47 + [3],
                    "is_day": [1] * 19 + [0] * 29,
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        w = await current_weather(
            client=client, lat=37.6, lon=-122.4, place={"city": "Burlingame", "country": "US"}
        )
    d = w["details"]
    assert (d["gusts"], d["wind_dir"], d["uv"], d["clouds"]) == (5, "N", 6, 0)
    assert (d["pressure"], d["pressure_unit"]) == (29.81, "inHg")  # 1009.6 hPa
    assert (d["visibility"], d["visibility_unit"]) == (29.4, "mi")  # 47.3 km
    assert (w["sunrise"], w["sunset"], w["uv_max"], w["observed"]) == (
        "07:03",
        "18:55",
        6,
        "2026-09-29T13:15",
    )
    # The hours start at the next whole hour and run a day ahead; night hours say so.
    assert len(w["hours"]) == 24 and w["hours"][0]["at"] == "2026-09-29T14:00"
    assert w["hours"][5]["is_day"] is False and w["hours"][0]["summary"] == "clear sky"
    assert [(x["day"], x["high"], x["low"], x["rain"]) for x in w["days"]] == [
        ("Tue", 85, 52, 0),
        ("Wed", 88, 56, 30),  # 88.5 rounds to even
    ]
    assert w["days"][1]["summary"] == "light rain" and w["days"][1]["sunset"].endswith("18:53")


async def test_metric_places_get_kilometres_and_hectopascals():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "current": {
                    "time": "2026-09-29T13:00",
                    "temperature_2m": 20,
                    "relative_humidity_2m": 50,
                    "apparent_temperature": 20,
                    "wind_speed_10m": 10,
                    "wind_direction_10m": 225,
                    "pressure_msl": 1013.4,
                    "visibility": 24140,
                    "weather_code": 3,
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        w = await current_weather(client=client, lat=48.9, lon=2.35, place={"country": "FR"})
    d = w["details"]
    assert (d["pressure"], d["pressure_unit"], d["visibility"], d["visibility_unit"]) == (
        1013,
        "hPa",
        24.1,
        "km",
    )
    assert d["wind_dir"] == "SW" and d["uv"] is None and d["gusts"] is None
    assert w["hours"] == [] and w["days"] == [] and w["sunrise"] == ""


class Sky:
    """Open-Meteo, faked: the geocoder knows Paris and Hillsboro, the forecast answers."""

    def __init__(self) -> None:
        self.asked: list[httpx.Request] = []
        self.made: list[dict] = []  # the kwargs of each client the weather made itself

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.asked.append(request)
        if request.url.host == "geocoding-api.open-meteo.com":
            name = request.url.params["name"]
            found = {
                "Paris": {"name": "Paris", "latitude": 48.85, "longitude": 2.35,
                          "admin1": "Île-de-France", "country_code": "FR"},
                "Hillsboro": {"name": "Hillsboro", "latitude": 45.52, "longitude": -122.99,
                              "admin1": "Oregon", "country_code": "US"},
            }.get(name)  # fmt: skip
            return httpx.Response(200, json={"results": [found]} if found else {})
        p = request.url.params
        return httpx.Response(
            200,
            json={
                "current": {
                    "time": "2026-10-05T09:00",
                    "temperature_2m": float(p["latitude"]),
                    "relative_humidity_2m": 50,
                    "apparent_temperature": 20,
                    "wind_speed_10m": 10,
                    "weather_code": 3,
                },
            },
        )

    def client(self, real):
        def make(**kwargs):
            self.made.append(kwargs)
            return real(transport=httpx.MockTransport(self.handler))

        return make

    def geocoded(self) -> list[str]:
        return [
            r.url.params["name"] for r in self.asked if r.url.host == "geocoding-api.open-meteo.com"
        ]


async def test_a_weather_city_is_looked_up_once_a_day(monkeypatch):
    """The hub asks for the weather city's weather every minute while the Mac has no
    location: the city is found once, and every answer is the same as with a lookup each
    time."""
    from jarvis import weather

    sky = Sky()
    monkeypatch.setattr(httpx, "AsyncClient", sky.client(httpx.AsyncClient))
    monkeypatch.setattr(weather, "_PLACES", {})
    clock = [1000.0]
    monkeypatch.setattr(weather.time, "monotonic", lambda: clock[0])
    first = await current_weather("Paris")
    assert (first["city"], first["region"], first["temp"], first["unit"]) == (
        "Paris",
        "Île-de-France, FR",
        49,
        "°C",
    )
    for _minute in range(1, 60):
        clock[0] += 60
        assert await current_weather(" Paris ") == first
    assert sky.geocoded() == ["Paris"]
    assert sum(r.url.host == "api.open-meteo.com" for r in sky.asked) == 60  # each minute
    # Another city is its own; a day later the city is looked up again.
    assert (await current_weather("Hillsboro"))["unit"] == "°F"
    clock[0] += weather.PLACE_SECONDS
    assert await current_weather("Paris") == first
    assert sky.geocoded() == ["Paris", "Hillsboro", "Paris"]
    # A city that isn't found is asked about again next time (it may be found then).
    for _ in range(2):
        assert await current_weather("Atlantis") == {
            "city": "Atlantis",
            "error": "I couldn't find that place.",
        }
    assert sky.geocoded()[-2:] == ["Atlantis", "Atlantis"]
    # Every client it made for itself shares one TLS setup, httpx's own default.
    assert len(sky.made) == 64 and all(k["verify"] is weather.tls() for k in sky.made)
    tls = weather.tls()
    assert tls.check_hostname and tls.verify_mode.name == "CERT_REQUIRED"


async def test_a_callers_own_client_always_asks_the_geocoder(monkeypatch):
    from jarvis import weather

    sky = Sky()
    monkeypatch.setattr(weather, "_PLACES", {})
    async with httpx.AsyncClient(transport=httpx.MockTransport(sky.handler)) as client:
        for _ in range(3):
            assert (await current_weather("Paris", client))["city"] == "Paris"
    assert sky.geocoded() == ["Paris"] * 3 and weather._PLACES == {}
