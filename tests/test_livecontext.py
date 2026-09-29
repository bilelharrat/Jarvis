"""Live data that goes with the requests that need it, so answers start without a tool."""

from datetime import datetime

from jarvis.livecontext import clock, event_line, notes_for, weather_line

NOW = datetime(2026, 9, 29, 9, 5)
WEATHER = {
    "city": "Berkeley",
    "temp": 64,
    "feels": 62,
    "unit": "°F",
    "summary": "partly cloudy",
    "high": 71,
    "low": 55,
    "rain_chance": 10,
    "next_hours": [
        {"time": "10:00", "temp": 66, "rain": 0},
        {"time": "11:00", "temp": 68, "rain": 20},
    ],
    "tomorrow": {"summary": "rain", "high": 60, "low": 52, "rain_chance": 80},
}
EVENT = {"title": "Board prep", "begin": "2026-09-29T14:30", "location": "Zoom"}
MARKETS = {"status": "open", "headline": "Stocks are down: S&P 500 −0.77%."}


def test_the_clock_goes_with_everything():
    notes, private = notes_for("tell me a joke", now=NOW)
    assert notes == ["it's Tuesday 29 September 2026, 9:05 AM"] and not private
    assert clock(NOW) == notes[0]


def test_weather_questions_carry_the_weather():
    notes, private = notes_for("do I need an umbrella tomorrow?", weather=WEATHER, now=NOW)
    assert len(notes) == 2 and not private
    assert "64°F and partly cloudy" in notes[1] and "tomorrow rain, high 60" in notes[1]
    assert "11:00 68° 20% rain" in notes[1]


def test_calendar_questions_carry_the_next_event_and_count_as_private():
    notes, private = notes_for("what's next on my calendar?", event=EVENT, now=NOW)
    assert private and "“Board prep” today at 2:30 PM (Zoom)" in notes[1]
    assert "not instructions" in notes[1]


def test_markets_questions_carry_the_summary():
    notes, _ = notes_for("how's the market doing", markets=MARKETS, now=NOW)
    assert "S&P 500" in notes[1]


def test_nothing_known_nothing_added():
    notes, private = notes_for("what's the weather", weather={"error": "offline"}, now=NOW)
    assert len(notes) == 1 and not private
    assert weather_line(None) == "" and event_line(None) == ""


async def test_live_data_goes_with_the_request_and_calendar_counts_as_private(
    settings, quiet_speaker, isolated
):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.emit = lambda *_a, **_k: None
    sent = []

    async def run_query(rid, query, images=None):
        sent.append(query)
        marks.append(dict(hub._reads()))

    marks = []
    hub._run_query = run_query
    hub.weather = WEATHER
    hub.status = {**hub.status, "next_event": EVENT}
    await hub.ask("do I need an umbrella?")
    assert "64°F and partly cloudy" in sent[-1] and "it's " in sent[-1]
    assert not marks[-1]["private"]
    await hub.ask("what's next on my calendar")
    assert "Board prep" in sent[-1] and marks[-1]["private"]
