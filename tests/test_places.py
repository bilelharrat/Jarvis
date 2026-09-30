"""Places and weather anywhere (jarvis.places, jarvis.forecast, maps.py's new helper parts and
the places feature's tools), with MapKit, Open-Meteo and Messages faked: nothing leaves the
Mac and nothing is sent."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from conftest import FakeClient

from jarvis import forecast, maps, places
from jarvis.features import places as feature
from jarvis.hub import Hub

# ── maps.py: the helper's plain parts ──


def test_distance_is_haversine():
    assert maps.distance_m(0, 0, 0, 0) == 0
    # One degree of latitude is about 111 km.
    assert maps.distance_m(37.0, -122.0, 38.0, -122.0) == pytest.approx(111_195, rel=0.001)


def _item(name="Blue Bottle", category="MKPOICategoryCafe", phone="+1 510", url="https://b.co"):
    coordinate = SimpleNamespace(latitude=37.8716, longitude=-122.2727)
    placemark = SimpleNamespace(
        coordinate=lambda: coordinate,
        subThoroughfare=lambda: "2118",
        thoroughfare=lambda: "Shattuck Ave",
        locality=lambda: "Berkeley",
        administrativeArea=lambda: "CA",
    )
    link = SimpleNamespace(absoluteString=lambda: url) if url else None
    return SimpleNamespace(
        name=lambda: name,
        placemark=lambda: placemark,
        pointOfInterestCategory=lambda: category,
        phoneNumber=lambda: phone,
        url=lambda: link,
    )


def test_a_map_item_becomes_a_row_with_its_distance():
    row = maps.place_row(_item(), (37.8716, -122.2827))
    assert row["name"] == "Blue Bottle" and row["category"] == "cafe"
    assert row["address"] == "2118 Shattuck Ave, Berkeley, CA"
    assert row["phone"] == "+1 510" and row["url"] == "https://b.co"
    assert 850 < row["meters"] < 900
    bare = maps.place_row(_item(category=None, phone=None, url=None))
    assert "category" not in bare and "phone" not in bare and "meters" not in bare
    assert maps._category("MKPOICategoryPublicTransport") == "public transport"


def test_the_helper_answers_a_bad_request_in_json(capsys):
    maps.main(["maps", "nearby", "north", "west", "coffee"])
    assert "error" in json.loads(capsys.readouterr().out)
    maps.main(["maps", "teleport"])
    assert "usage" in json.loads(capsys.readouterr().out)["error"]


# ── places.py ──


def test_directions_are_an_apple_maps_link_with_the_mode():
    url = places.directions_url("Ferry Building, SF", "transit")
    assert url == "maps://?daddr=Ferry%20Building%2C%20SF&dirflg=r"
    assert places.directions_url("Oakland", "rocket").endswith("dirflg=d")  # driving
    assert "saddr=Home" in places.directions_url("Oakland", "walking", "Home")


@pytest.mark.parametrize(
    ("said", "expected"),
    [
        ("16:30", datetime(2026, 9, 29, 16, 30)),
        ("4:30 pm", datetime(2026, 9, 29, 16, 30)),
        ("4pm", datetime(2026, 9, 29, 16, 0)),
        ("by 9 a.m.", datetime(2026, 9, 30, 9, 0)),  # already past today: tomorrow
        ("12 am", datetime(2026, 9, 30, 0, 0)),
        ("2026-10-02T09:15", datetime(2026, 10, 2, 9, 15)),
        ("下午4点半", datetime(2026, 9, 29, 16, 30)),
        ("晚上8点", datetime(2026, 9, 29, 20, 0)),
    ],
)
def test_an_arrival_time_is_its_next_coming(said, expected):
    now = datetime(2026, 9, 29, 10, 0)
    assert places.parse_arrival(said, now) == expected


@pytest.mark.parametrize("said", ["", "soon", "25:00", "4:75 pm"])
def test_an_arrival_that_isnt_a_time_says_so(said):
    with pytest.raises(ValueError):
        places.parse_arrival(said, datetime(2026, 9, 29, 10, 0))


def test_leave_by_uses_maps_own_departure_with_time_to_spare():
    arrive = datetime(2026, 9, 29, 16, 30)
    assert places.leave_by(arrive, 40) == datetime(2026, 9, 29, 15, 45)
    depart = datetime(2026, 9, 29, 15, 35).timestamp()  # traffic: Maps says leave earlier
    assert places.leave_by(arrive, 40, depart) == datetime(2026, 9, 29, 15, 30)


def test_distances_read_the_way_people_say_them():
    assert places.distance_words(420, imperial=False) == "420 m"
    assert places.distance_words(2300, imperial=False) == "2.3 km"
    assert places.distance_words(160, imperial=True) == "500 ft"
    assert places.distance_words(4000, imperial=True) == "2.5 mi"
    assert places.distance_words(None, imperial=True) == ""
    lines = places.place_lines(
        [{"name": "Peet's", "category": "cafe", "meters": 420, "address": "1 Main St"}], False
    )
    assert lines == "- Peet's (cafe) · 420 m away · 1 Main St"


def test_an_eta_message_in_either_language():
    now = datetime(2026, 9, 29, 15, 50)
    en = places.eta_message("the office", 18, now)
    assert en == "On my way to the office: about 18 minutes away, there around 4:08 PM."
    zh = places.eta_message("办公室", 18, now, "zh")
    assert zh == "我正在去办公室的路上，大约18分钟后到（下午4:08左右）。"


# ── forecast.py ──


@pytest.mark.parametrize(
    ("said", "expected"),
    [
        ("", date(2026, 9, 29)),
        ("tomorrow", date(2026, 9, 30)),
        ("Friday", date(2026, 10, 2)),
        ("next tuesday", date(2026, 9, 29)),  # today counts
        ("明天", date(2026, 9, 30)),
        ("周五", date(2026, 10, 2)),
        ("下周二", date(2026, 10, 6)),
        ("2026-10-09", date(2026, 10, 9)),
        ("yesterday", date(2026, 9, 28)),
    ],
)
def test_days_people_say(said, expected):
    assert forecast.parse_day(said, date(2026, 9, 29)) == expected  # a Tuesday


def test_a_day_out_of_the_forecasts_reach_says_so():
    today = date(2026, 9, 29)
    with pytest.raises(ValueError, match="15 days ahead"):
        forecast.check_range(today + timedelta(days=16), today)
    with pytest.raises(ValueError, match="30 days"):
        forecast.check_range(today - timedelta(days=31), today)
    forecast.check_range(today + timedelta(days=15), today)
    with pytest.raises(ValueError):
        forecast.parse_day("someday", today)


def test_aqi_bands():
    assert [forecast.aqi_band(v) for v in (12, 51, 101, 160, 250, 400)] == [
        "good",
        "moderate",
        "unhealthy for sensitive groups",
        "unhealthy",
        "very unhealthy",
        "hazardous",
    ]
    assert forecast.aqi_band(None) == ""


PARIS = {"city": "Paris", "region": "Île-de-France", "country": "FR", "lat": 48.85, "lon": 2.35}


def _mock(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_a_days_forecast_with_hours_through_the_day():
    def handler(request):
        params = request.url.params
        assert (params["start_date"], params["end_date"]) == ("2026-10-02", "2026-10-02")
        assert params["temperature_unit"] == "celsius"
        hours = [f"2026-10-02T{h:02d}:00" for h in range(24)]
        return httpx.Response(
            200,
            json={
                "daily": {
                    "temperature_2m_max": [19.6],
                    "temperature_2m_min": [11.2],
                    "precipitation_probability_max": [70],
                    "precipitation_sum": [4.26],
                    "weather_code": [63],
                    "wind_speed_10m_max": [22.4],
                    "wind_gusts_10m_max": [41],
                    "sunrise": ["2026-10-02T07:52"],
                    "sunset": ["2026-10-02T19:31"],
                    "uv_index_max": [3.1],
                },
                "hourly": {
                    "time": hours,
                    "temperature_2m": list(range(24)),
                    "precipitation_probability": [10] * 24,
                    "weather_code": [3] * 24,
                },
            },
        )

    async with _mock(handler) as client:
        day = await forecast.day_weather(PARIS, date(2026, 10, 2), client)
    assert (day["city"], day["weekday"], day["summary"]) == ("Paris", "Friday", "rain")
    assert (day["high"], day["low"], day["unit"], day["rain_chance"]) == (20, 11, "°C", 70)
    assert (day["rain_amount"], day["rain_unit"], day["gusts_max"]) == (4.26, "mm", 41)
    assert (day["sunrise"], day["sunset"], day["uv_max"]) == ("07:52", "19:31", 3)
    assert [h["time"] for h in day["hours"]] == [
        "06:00",
        "09:00",
        "12:00",
        "15:00",
        "18:00",
        "21:00",
    ]
    assert day["hours"][2] == {
        "time": "12:00",
        "temp": 12,
        "rain_chance": 10,
        "summary": "overcast",
    }


async def test_a_forecast_answer_with_holes_in_it_still_reads():
    def handler(_request):
        return httpx.Response(200, json={"daily": {"weather_code": ["x"]}, "hourly": {"time": [7]}})

    async with _mock(handler) as client:
        day = await forecast.day_weather(PARIS, date(2026, 10, 2), client)
    assert day["high"] is None and day["hours"] == [] and day["summary"] == ""


async def test_air_quality_now_and_a_coming_days_worst_hour():
    def handler(request):
        if "hourly" in request.url.params:
            return httpx.Response(
                200,
                json={
                    "hourly": {
                        "time": ["2026-10-01T08:00", "2026-10-01T17:00", "2026-10-01T20:00"],
                        "us_aqi": [40, 112, None],
                        "pm2_5": [8.0, 41.26, 3],
                        "pm10": [10, 50, 3],
                    }
                },
            )
        return httpx.Response(
            200,
            json={
                "current": {
                    "us_aqi": 57,
                    "pm2_5": 14.04,
                    "pm10": 20.0,
                    "ozone": 61.3,
                    "nitrogen_dioxide": 9.9,
                }
            },
        )

    today = date(2026, 9, 29)
    async with _mock(handler) as client:
        now = await forecast.air_quality(PARIS, None, today, client)
        later = await forecast.air_quality(PARIS, date(2026, 10, 1), today, client)
    assert (now["aqi"], now["band"], now["pm2_5"], now["no2"]) == (57, "moderate", 14.0, 9.9)
    assert (later["aqi"], later["band"], later["worst_hour"], later["pm2_5"]) == (
        112,
        "unhealthy for sensitive groups",
        "17:00",
        41.3,
    )


async def test_a_place_the_geocoder_doesnt_know():
    async with _mock(lambda _r: httpx.Response(200, json={})) as client:
        with pytest.raises(forecast.NotFound):
            await forecast.find_place("Atlantis", client)


# ── the feature's tools ──


@pytest.fixture
def desk(settings, quiet_speaker, isolated, monkeypatch):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    monkeypatch.setattr(feature, "create_sdk_mcp_server", lambda **k: k["tools"])
    desk = hub.places
    desk.now = lambda: datetime(2026, 9, 29, 15, 50)
    hub.location = {"lat": 37.87, "lon": -122.27, "city": "Berkeley", "country": "US"}
    desk.calls = []

    async def helper(*args):
        desk.calls.append(args)
        return desk.answers.get(args[0], {"error": "not faked"})

    desk.helper = helper
    desk.answers = {}
    desk.tools = {t.name: t.handler for t in feature.build_server(desk)}
    return desk


def _said(result):
    return result["content"][0]["text"]


async def test_nearby_places_around_here_or_a_named_place(desk):
    desk.answers["nearby"] = {
        "places": [{"name": "Peet's", "category": "cafe", "meters": 160, "address": "1 Main"}]
    }
    out = await desk.tools["nearby_places"]({"what": "coffee"})
    assert desk.calls[-1] == ("nearby", "37.87", "-122.27", "coffee", "5000", "8")
    assert _said(out) == "Coffee, as Apple Maps ranks them:\n- Peet's (cafe) · 500 ft away · 1 Main"
    desk.answers["geocode"] = {"name": "Union Square", "lat": 37.788, "lon": -122.407}
    out = await desk.tools["nearby_places"]({"what": "ramen", "near": "Union Square", "limit": 3})
    assert desk.calls[-2] == ("geocode", "Union Square", "37.87", "-122.27")
    assert desk.calls[-1] == ("nearby", "37.788", "-122.407", "ramen", "5000", "3")
    assert _said(out).startswith("Ramen near Union Square")
    assert (await desk.tools["nearby_places"]({"what": " "}))["is_error"]


async def test_without_a_location_it_uses_the_weather_city_or_says_why(desk, monkeypatch):
    desk.hub.prefs.use_location = False
    desk.hub.prefs.weather_city = ""
    out = await desk.tools["nearby_places"]({"what": "coffee"})
    assert out["is_error"] and "Weather city" in _said(out)
    desk.hub.prefs.weather_city = "Paris"

    def geo(_request):
        return httpx.Response(
            200, json={"results": [{"name": "Paris", "latitude": 48.85, "longitude": 2.35}]}
        )

    desk.http = lambda: _mock(geo)
    desk.answers["nearby"] = {"places": [{"name": "Café de Flore", "meters": 1200}]}
    out = await desk.tools["nearby_places"]({"what": "café"})
    assert desk.calls[-1][1:3] == ("48.85", "2.35") and "1.2 km" in _said(out)


async def test_directions_open_apple_maps(desk, monkeypatch):
    opened = []

    async def run(*cmd, **_k):
        opened.append(cmd)
        return ""

    monkeypatch.setattr(feature.mac_tools, "run_command", run)
    out = await desk.tools["open_directions"]({"destination": "SFO", "mode": "transit"})
    assert opened == [("open", "maps://?daddr=SFO&dirflg=r")]
    assert _said(out) == "Opened transit directions to SFO in Maps."


async def test_when_to_leave_counts_back_from_the_arrival(desk):
    arrive = datetime(2026, 9, 29, 17, 0)
    desk.answers["eta"] = {
        "minutes": 35,
        "km": 20.1,
        "miles": 12.5,
        "destination": "SFO",
        "depart": datetime(2026, 9, 29, 16, 20).timestamp(),
    }
    out = await desk.tools["when_to_leave"]({"destination": "SFO", "arrive_by": "5pm"})
    assert desk.calls[-1] == ("eta", "37.87", "-122.27", "SFO", "driving", str(arrive.timestamp()))
    assert _said(out) == (
        "Leave by 4:15 PM to reach SFO by 5:00 PM: about 35 minutes driving (12.5 mi), with 5 "
        "minutes to spare."
    )
    out = await desk.tools["when_to_leave"]({"destination": "SFO", "arrive_by": "whenever"})
    assert out["is_error"]
    desk.hub.prefs.use_location = False
    out = await desk.tools["when_to_leave"]({"destination": "SFO", "arrive_by": "5pm"})
    assert out["is_error"] and "location" in _said(out)


async def test_leaving_too_late_says_so(desk):
    desk.answers["eta"] = {"minutes": 90, "km": 100, "miles": 62, "destination": "Tahoe"}
    out = await desk.tools["when_to_leave"]({"destination": "Tahoe", "arrive_by": "16:00"})
    assert "already past" in _said(out)


async def test_sharing_an_eta_goes_through_the_send_card(desk):
    desk.answers["eta"] = {"minutes": 18, "destination": "Home"}
    sent, cards = [], []

    async def lookup(_q):
        return [
            {
                "name": "Ann Lee",
                "phones": [{"label": "mobile", "value": "+15105550100"}],
                "emails": [],
            }
        ]

    async def send(script, *argv):
        sent.append(argv)

    async def send_gate(question, detail, spoken=""):
        cards.append((question, detail, spoken))
        return desk.allow

    desk.lookup, desk.send = lookup, send
    desk.hub.send_gate = send_gate
    desk.allow = False
    out = await desk.tools["share_eta"]({"to": "Ann", "destination": "home"})
    assert out["is_error"] and sent == []
    message = "On my way to home: about 18 minutes away, there around 4:08 PM."
    assert cards[-1] == (
        "Send this to Ann Lee?",
        f"To Ann Lee (+15105550100):\n“{message}”",
        f"Here's your message to Ann Lee. {message} Do you want this message sent?",
    )
    desk.allow = True
    out = await desk.tools["share_eta"]({"to": "Ann", "destination": "home"})
    assert sent == [("+15105550100", message)]  # exactly what the card showed
    assert _said(out) == f"Sent Ann Lee your ETA: {message}"


async def test_sharing_an_eta_in_chinese(desk):
    desk.answers["eta"] = {"minutes": 5, "destination": "家"}
    desk.hub.prefs.language = "zh"
    cards = []

    async def lookup(_q):
        return [
            {"name": "安", "phones": [{"label": "mobile", "value": "+8613800000000"}], "emails": []}
        ]

    async def send_gate(question, detail, spoken=""):
        cards.append(detail)
        return False

    desk.lookup = lookup
    desk.hub.send_gate = send_gate
    await desk.tools["share_eta"]({"to": "安", "destination": "家"})
    assert "我正在去家的路上，大约5分钟后到（下午3:55左右）。" in cards[-1]


async def test_weather_for_a_named_place_and_day(desk):
    seen = []

    def handler(request):
        seen.append(request.url.host)
        if "geocoding" in request.url.host:
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "name": "Tokyo",
                            "country_code": "JP",
                            "latitude": 35.68,
                            "longitude": 139.69,
                        }
                    ]
                },
            )
        assert request.url.params["start_date"] == "2026-10-02"
        return httpx.Response(
            200,
            json={
                "daily": {
                    "temperature_2m_max": [24],
                    "temperature_2m_min": [18],
                    "weather_code": [1],
                }
            },
        )

    desk.http = lambda: _mock(handler)
    out = await desk.tools["weather_for"]({"place": "Tokyo", "date": "Friday"})
    found = json.loads(_said(out))
    assert (found["city"], found["date"], found["high"], found["summary"]) == (
        "Tokyo",
        "2026-10-02",
        24,
        "mainly clear",
    )
    out = await desk.tools["weather_for"]({"place": "Tokyo", "date": "2027-01-01"})
    assert out["is_error"] and "15 days ahead" in _said(out)


async def test_weather_here_uses_the_macs_location_and_a_down_service_is_said(desk):
    def handler(request):
        assert request.url.params["latitude"] == "37.87"
        assert request.url.params["temperature_unit"] == "fahrenheit"  # a US location
        return httpx.Response(503)

    desk.http = lambda: _mock(handler)
    out = await desk.tools["weather_for"]({})
    assert out["is_error"] and "didn't answer" in _said(out)


async def test_air_quality_here_now(desk):
    def handler(request):
        assert "air-quality" in request.url.host and "hourly" not in request.url.params
        return httpx.Response(200, json={"current": {"us_aqi": 22, "pm2_5": 5}})

    desk.http = lambda: _mock(handler)
    found = json.loads(_said(await desk.tools["air_quality"]({})))
    assert (found["city"], found["aqi"], found["band"]) == ("Berkeley", 22, "good")
    out = await desk.tools["air_quality"]({"date": "yesterday"})
    assert out["is_error"]


def test_the_server_is_registered_with_labels_and_quiet_results(desk):
    from jarvis import brain
    from jarvis.hub import tool_label

    assert "places" in desk.hub._extra_servers
    assert "nearby_places finds shops" in desk.hub._feature_prompt()
    assert tool_label("mcp__places__when_to_leave") == "Worked out when to leave"
    assert brain.result_kind("mcp__places__weather_for") == "none"
    assert brain.result_kind("mcp__places__nearby_places") == "private"  # it says where you are
