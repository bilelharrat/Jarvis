"""The Jarvis Code composer's mic: what the user says is typed into the text box, never
asked; with hands-free on, its next utterance is the dictation."""

import numpy as np
from test_hub import drain, make_hub


async def test_dictation_types_what_was_said_and_asks_nothing(settings, quiet_speaker, isolated):
    def recorder(_silence, on_level):
        on_level(0.05)
        return np.zeros(1600, dtype=np.float32)

    hub = make_hub(settings, quiet_speaker, recorder=recorder, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub.dictate(True)
    events = drain(q)
    assert {"type": "dictation", "text": "what's on tomorrow", "done": True} in events
    assert not any(e["type"] == "heard" for e in events)
    assert hub.client is None or hub.client.queries == []
    assert hub.state == "idle"


async def test_silence_dictates_nothing(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, recorder=lambda *_: None, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub.dictate(True)
    assert {"type": "dictation", "text": "", "done": True} in drain(q)


async def test_with_hands_free_the_next_utterance_is_the_dictation(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()

    class Running:
        running = True

    hub._listener = Running()
    q = hub.subscribe()
    task = hub._spawn(hub.dictate(True))
    import asyncio

    for _ in range(50):
        if hub._dictating_until:
            break
        await asyncio.sleep(0.01)
    await hub.on_heard("rename the helper to parse_rows")
    events = drain(q)
    assert {"type": "dictation", "text": "rename the helper to parse_rows", "done": True} in events
    assert hub._dictating_until == 0.0
    assert hub.client is None or hub.client.queries == []
    task.cancel()
    hub._listener = None


async def test_pressing_the_mic_again_stops_it(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub._dictating_until = 10**9
    q = hub.subscribe()
    await hub.dictate(False)
    assert hub._dictating_until == 0.0
    assert {"type": "dictation", "text": "", "done": True} in drain(q)


async def test_stop_during_push_to_talk_asks_nothing(settings, quiet_speaker, isolated):
    import asyncio
    import time

    def slow_recorder(_silence, on_level):
        time.sleep(0.3)
        return np.zeros(1600, dtype=np.float32)

    hub = make_hub(settings, quiet_speaker, recorder=slow_recorder, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    listening = asyncio.create_task(hub.listen())
    await asyncio.sleep(0.05)
    await hub.stop()  # the orb tapped again
    await listening
    events = drain(q)
    assert {"type": "heard", "text": ""} in events
    assert hub.client.queries == [] and hub.state == "idle"


async def test_on_off_on_keeps_what_was_said_after_the_second_press(
    settings, quiet_speaker, isolated
):
    import asyncio
    import time

    def slow_recorder(_silence, on_level):
        time.sleep(0.2)
        return np.zeros(1600, dtype=np.float32)

    hub = make_hub(settings, quiet_speaker, recorder=slow_recorder, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    first = asyncio.create_task(hub.dictate(True))
    await asyncio.sleep(0.02)
    await hub.dictate(False)
    second = asyncio.create_task(hub.dictate(True))
    await asyncio.gather(first, second)
    texts = [e["text"] for e in drain(q) if e["type"] == "dictation"]
    assert texts == ["", "what's on tomorrow"]  # the off press, then the new recording's words
    assert hub.client.queries == []


async def test_a_stop_over_a_reply_is_not_typed_into_the_composer(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub._dictating_until = 10**12
    stopped = []

    async def stop():
        stopped.append(True)

    hub.stop = stop
    hub.state = "speaking"
    q = hub.subscribe()
    await hub.on_heard("Jarvis, stop")
    assert stopped and not any(e["type"] == "dictation" for e in drain(q))
