import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace

from jarvis import proactive
from jarvis.proactive import Watcher

NOW = datetime(2026, 9, 29, 14, 0)


def event(title, minutes, location="", all_day=False, id_=None):
    begin = NOW + timedelta(minutes=minutes)
    return {
        "title": title,
        "begin": begin,
        "end": begin + timedelta(hours=1),
        "location": location,
        "all_day": all_day,
        "id": id_ or title,
    }


def test_meeting_soon_only_for_events_in_the_next_ten_minutes_without_travel():
    events = [
        event("Standup", 8, "https://zoom.us/j/1"),
        event("Lunch", 8, "Tartine, 600 Guerrero St"),
        event("Later", 45),
        event("Holiday", 5, all_day=True),
    ]
    # No travel time for Lunch yet (location off, Maps unsure): it still gets a heads-up.
    assert [a.text for a in proactive.meeting_soon(events, NOW)] == [
        "Standup starts in 8 minutes.",
        "Lunch starts in 8 minutes.",
    ]
    # With a real travel time, time_to_leave covers Lunch instead.
    etas = {proactive.event_key(events[1]): 20}
    assert [a.title for a in proactive.meeting_soon(events, NOW, etas)] == ["Standup"]
    # A two-minute "trip" means you're there: back to the plain heads-up.
    near = {proactive.event_key(events[1]): 2}
    assert len(proactive.meeting_soon(events, NOW, near)) == 2
    assert proactive.time_to_leave(events, NOW, near) == []


def test_time_to_leave_uses_traffic():
    e = event("Board meeting", 50, "1 Market St, San Francisco, CA")
    key = proactive.event_key(e)
    assert proactive.time_to_leave([e], NOW, {key: 30}) == []  # 15 minutes to spare
    [alert] = proactive.time_to_leave([e], NOW, {key: 45})
    assert alert.text.startswith("Time to leave for Board meeting. It's 45 minutes to 1 Market St")
    assert "2:50 PM" in alert.text
    [late] = proactive.time_to_leave([e], NOW, {key: 55})
    assert "a little late" in late.text
    assert proactive.time_to_leave([e], NOW, {key: None}) == []


def test_virtual_locations_never_need_travel():
    for where in ("https://meet.google.com/abc", "Microsoft Teams Meeting", "Zoom", "Phone call"):
        assert not proactive.is_travel(where)
    assert proactive.is_travel("Blue Bottle, 66 Mint St")


def test_battery_and_rain():
    assert proactive.battery_alerts({"percent": 9, "plugged": False})[0].key == "battery:10"
    assert proactive.battery_alerts({"percent": 4, "plugged": False})[0].key == "battery:5"
    assert proactive.battery_alerts({"percent": 4, "plugged": True}) == []
    weather = {
        "summary": "Partly cloudy",
        "next_hours": [
            {"time": "14:00", "rain": 10},
            {"time": "15:00", "rain": 70},
            {"time": "16:00", "rain": 80},
        ],
    }
    [rain] = proactive.rain_alerts(weather, NOW)
    assert "15:00" in rain.text
    assert rain.key == "rain:20260929"  # once a day, however the window slides
    assert proactive.rain_alerts({**weather, "code": 63}, NOW) == []  # already raining
    assert proactive.rain_alerts({**weather, "code": 95}, NOW) == []  # a storm counts
    soon = {**weather, "next_hours": [{"time": "15:00", "rain": 80}]}
    assert proactive.rain_alerts(soon, NOW)  # the very next hour counts


def test_urgent_or_known_senders_only():
    mail = [
        SimpleNamespace(id="1", group="Newsletter Co", title="This week in AI — Newsletter Co"),
        SimpleNamespace(id="2", group="Bob Smith", title="URGENT: wire cutoff — Bob Smith"),
        SimpleNamespace(id="3", group="Ann Lee", title="Lunch? — Ann Lee"),
    ]
    alerts = proactive.urgent_mail(mail, set(), vip_text="Ann Lee is the user's co-founder.")
    assert [a.text for a in alerts] == [
        "Email from Bob Smith: URGENT: wire cutoff.",
        "Email from Ann Lee: Lunch?.",
    ]
    # Name parts match whole words only, and two-letter ones don't count.
    others = [
        SimpleNamespace(id="4", group="Annabel Leeds", title="Hi — Annabel Leeds"),
        SimpleNamespace(id="5", group="Li Ed", title="Hi — Li Ed"),
        SimpleNamespace(id="6", group="Promo", title="Important update to our terms — Promo"),
    ]
    vip = "Ann Lee is the user's co-founder; Ed likes Li's cooking."
    assert proactive.urgent_mail(others, set(), vip_text=vip) == []
    # Mail from before the watcher started is never news.
    old = SimpleNamespace(id="7", group="Bob", title="URGENT — Bob", modified="2026-09-29T09:00:00")
    assert proactive.urgent_mail([old], set(), since=datetime(2026, 9, 29, 10, 0)) == []


def test_quiet_hours_wrap_midnight():
    assert proactive.in_quiet_hours(datetime(2026, 9, 29, 23, 30), "22:00-07:00")
    assert proactive.in_quiet_hours(datetime(2026, 9, 29, 6, 59), "22:00-07:00")
    assert not proactive.in_quiet_hours(datetime(2026, 9, 29, 7, 0), "22:00-07:00")
    assert proactive.in_quiet_hours(datetime(2026, 9, 29, 13, 0), "12:00-14:00")


async def test_watcher_announces_each_thing_once_and_skips_old_mail():
    said = []
    inbox = [SimpleNamespace(id="old", group="Bob", title="URGENT old — Bob")]
    power = {"percent": 50, "plugged": False}

    async def events():
        return [event("Standup", 5, "Zoom")]

    async def eta(_where):
        return None

    async def mail():
        return list(inbox)

    w = Watcher(
        said.append,
        events=events,
        eta=eta,
        battery=lambda: power,
        weather=lambda: None,
        mail=mail,
    )
    await w.tick(NOW)
    assert [a.kind for a in said] == ["soon"]  # the old urgent email isn't news
    await w.tick(NOW + timedelta(minutes=1))
    assert len(said) == 1  # nothing twice
    inbox.append(SimpleNamespace(id="new", group="Bob", title="URGENT new — Bob"))
    power["percent"] = 8
    await w.tick(NOW + timedelta(minutes=3))
    assert [a.kind for a in said[1:]] == ["battery", "mail"]
    power.update(percent=60, plugged=True)
    await w.tick(NOW + timedelta(minutes=4))
    power.update(percent=9, plugged=False)
    await w.tick(NOW + timedelta(minutes=5))
    assert [a.kind for a in said].count("battery") == 2  # warned again after charging


async def test_hub_speaks_alerts_only_when_welcome(settings, quiet_speaker, isolated):
    from test_hub import drain, make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    spoken = []
    hub.speech.push = spoken.append
    hub.prefs.quiet_hours = "00:00-00:00"
    hub.notify(proactive.Alert("k", "rain", "Rain", "Rain's likely around 15:00."))
    await asyncio.sleep(0.5)
    assert any(e["type"] == "alert" for e in drain(q))
    assert spoken == ["Rain's likely around 15:00."]
    hub.meeting = object()  # taking meeting notes: cards only
    hub.notify(proactive.Alert("k2", "rain", "Rain", "More rain."))
    assert spoken == ["Rain's likely around 15:00."]
    hub.meeting = None
    await hub.ask("do I need an umbrella?")
    assert "Rain's likely around 15:00." in hub.client.queries[-1]  # it knows what it said
