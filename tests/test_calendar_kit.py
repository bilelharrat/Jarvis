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


def test_the_helper_processes_start_without_asyncio():
    """calendar_kit, maps and reminders_desk each run as a short helper process, tens of
    times an hour. asyncio was most of their own import time (~12 ms a start) and the
    helper never uses it: only the app's side of them imports it, when it's called."""
    import subprocess
    import sys

    probe = (
        "import sys, jarvis.calendar_kit, jarvis.maps, jarvis.reminders_desk; "
        "print('asyncio' in sys.modules)"
    )
    done = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "False"


async def test_the_apps_side_still_runs_the_helper(monkeypatch):
    import asyncio

    ran = []

    class Proc:
        returncode = 0

        async def communicate(self):
            return b'{"events": []}\n', b""

    async def spawn(*argv, **_kw):
        ran.append(argv[1:])
        return Proc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(calendar_kit, "_denied_until", 0.0)
    assert await calendar_kit.fetch(0, 4) == {"events": []}
    assert ran == [("-m", "jarvis.calendar_kit", "events", "0", "4")]
