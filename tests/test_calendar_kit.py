from datetime import datetime

from jarvis import calendar_kit, mac_tools


def test_parse_and_format_eventkit_events():
    events = calendar_kit.parse(
        [
            {
                "title": "Board meeting",
                "begin": "2026-09-29T15:00",
                "end": "2026-09-29T16:00",
                "all_day": False,
                "location": "1 Market St, San Francisco",
                "calendar": "Work",
            },
            {"title": "broken", "begin": "not a date", "end": ""},
        ]
    )
    assert len(events) == 1 and events[0]["begin"] == datetime(2026, 9, 29, 15, 0)
    text = mac_tools.format_events(events, datetime(2026, 9, 29))
    assert text == "- Tue 29 Sep 15:00–16:00: Board meeting at 1 Market St, San Francisco [Work]"


async def test_list_events_falls_back_to_applescript(monkeypatch):
    async def denied(*_a, **_k):
        return {"error": calendar_kit.NO_ACCESS}

    async def applescript(*_a, **_k):
        return "3600\t7200\tfalse\tHome\tDentist"

    monkeypatch.setattr(calendar_kit, "fetch", denied)
    monkeypatch.setattr(mac_tools, "run_applescript", applescript)
    out = await mac_tools.list_events.handler({})
    assert "Dentist [Home]" in out["content"][0]["text"]
