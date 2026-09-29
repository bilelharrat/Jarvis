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
