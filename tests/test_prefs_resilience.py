"""Settings take effect even when they can't be saved: switching the microphone, the
screen watching or the phone companion off never depends on a full disk."""

from test_hub import drain, make_hub


async def test_switching_off_works_even_when_saving_fails(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.prefs.screen_aware = True
    hub.screen_watch.start()
    stopped = []
    hub.screen_watch.stop = lambda: stopped.append("screen")

    def full_disk():
        raise OSError(28, "No space left on device")

    hub.prefs_store.save = full_disk
    q = hub.subscribe()
    hub.set_prefs({"screen_aware": False})
    events = drain(q)
    assert stopped == ["screen"] and hub.prefs.screen_aware is False
    assert any(e["type"] == "error" and "couldn't save" in e["text"] for e in events)
    assert any(e["type"] == "prefs" for e in events)


async def test_turning_hands_free_off_in_a_meeting_stops_the_notes(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    stops = []

    async def stop_meeting():
        stops.append(True)

    hub._stop_meeting_from_window = stop_meeting
    hub.meeting = object()
    hub.prefs.hands_free = True
    hub.set_prefs({"pay_limit_day": 123})  # an unrelated change never touches the meeting
    hub.set_prefs({"hands_free": False})
    import asyncio

    await asyncio.sleep(0)
    assert stops == [True]
    hub.meeting = None
