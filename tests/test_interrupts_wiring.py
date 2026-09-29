"""Texts in the hub: their words never ride along into the next request, and a VIP's
urgent message is said aloud even in quiet hours."""

from test_hub import make_hub

from jarvis.interrupts import Interruption


def message(**extra):
    return Interruption(
        "message:1", "message", "Ann Lee", "Ann Lee says it's urgent: call me back", **extra
    )


async def test_a_text_heads_up_never_carries_its_words(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.notify(message())
    note = hub._alert_notes[-1][1]
    assert "call me back" not in note and "Ann" not in note


async def test_a_vip_breaks_through_quiet_hours(settings, quiet_speaker, isolated, monkeypatch):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    said = []

    async def announce(text):
        said.append(text)

    hub._announce = announce
    monkeypatch.setattr("jarvis.hub.in_quiet_hours", lambda *_a: True)
    hub.notify(message())
    hub.notify(message(breakthrough=True, vip=True, urgent=True))
    for _ in range(20):
        import asyncio

        await asyncio.sleep(0)
    assert said == ["Ann Lee says it's urgent: call me back"]


async def test_in_meeting_reads_the_calendar(settings, quiet_speaker, isolated):
    from datetime import datetime, timedelta

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    now = datetime.now().astimezone()
    hub.watcher._events = [
        {
            "begin": (now - timedelta(minutes=5)).isoformat(),
            "end": (now + timedelta(minutes=25)).isoformat(),
        }
    ]
    assert hub._in_meeting()
    hub.watcher._events = [
        {
            "begin": (now - timedelta(hours=2)).isoformat(),
            "end": (now + timedelta(hours=2)).isoformat(),
            "all_day": True,
        }
    ]
    assert not hub._in_meeting()
