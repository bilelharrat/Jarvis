import asyncio

import numpy as np
from conftest import CALENDAR_TURN, FakeClient, result

from jarvis.hub import Hub, tool_label


class Transcriber:
    def transcribe(self, _audio):
        return "what's on tomorrow"


def make_hub(settings, speaker, script=CALENDAR_TURN, recorder=None, isolated=None):
    class Client(FakeClient):
        pass

    Client.script = script
    return Hub(
        settings,
        client_factory=Client,
        speaker=speaker,
        transcriber=Transcriber(),
        recorder=recorder,
        poll=False,
        **isolated,
    )


def drain(queue):
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


async def test_ask_streams_turn_tools_reply_and_state(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub.ask("what's on tomorrow?")
    events = drain(q)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "turn" and kinds[-1] == "turn_done"
    tools = [e for e in events if e["type"] == "tool"]
    assert [t["status"] for t in tools] == ["running", "done"]
    assert tools[0]["label"] == "Checked your calendar"
    assert [e["text"] for e in events if e["type"] == "reply"] == ["Two meetings tomorrow."]
    assert [e["value"] for e in events if e["type"] == "state"] == [
        "thinking",
        "speaking",
        "thinking",
        "idle",
    ]
    assert hub.activity[0]["status"] == "done"
    assert hub.client.queries == ["what's on tomorrow?"]


async def test_error_result_is_reported(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, script=[result(is_error=True)], isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub.ask("hi")
    assert any(e["type"] == "error" for e in drain(q))
    assert hub.state == "idle"


async def test_approval_round_trip(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    q = hub.subscribe()
    pending = asyncio.create_task(hub.confirm("Quit Safari?"))
    await asyncio.sleep(0)
    approval = next(e for e in drain(q) if e["type"] == "approval")
    assert approval["question"] == "Quit Safari?"
    assert not hub.resolve(approval["id"], "launch_missiles")  # not an offered choice
    assert hub.resolve(approval["id"], "allow")
    assert await pending is True
    assert hub.approvals == {}
    assert any(e["type"] == "approval_resolved" for e in drain(q))


async def test_approval_denied(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    q = hub.subscribe()
    pending = asyncio.create_task(hub.confirm("Add event?"))
    await asyncio.sleep(0)
    approval = next(e for e in drain(q) if e["type"] == "approval")
    hub.resolve(approval["id"], "deny")
    assert await pending is False


async def test_listen_transcribes_then_asks(settings, quiet_speaker, isolated):
    def recorder(_silence, on_level):
        on_level(0.05)
        return np.zeros(1600, dtype=np.float32)

    hub = make_hub(settings, quiet_speaker, recorder=recorder, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub.listen()
    events = drain(q)
    assert {"type": "heard", "text": "what's on tomorrow"} in events
    states = [e["value"] for e in events if e["type"] == "state"]
    assert states[:2] == ["listening", "transcribing"]
    assert hub.client.queries == ["what's on tomorrow"]


async def test_silence_does_not_ask(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, recorder=lambda *_: None, isolated=isolated)
    await hub.start()
    await hub.listen()
    assert hub.client.queries == []
    assert hub.state == "idle"


async def test_commands_mute_and_stop(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub.handle({"type": "mute", "value": False})
    assert quiet_speaker.muted is False
    assert drain(q)[-1] == {"type": "muted", "value": False}
    await hub.handle({"type": "bogus"})
    await hub.handle({"type": "stop"})
    snap = hub.snapshot()
    assert snap["type"] == "hello" and snap["muted"] is False


def test_tool_labels():
    assert tool_label("mcp__bsh__portfolio_dashboard") == "Checked the portfolio"
    assert tool_label("WebSearch") == "Searched the web"
    assert tool_label("mcp__x__do_thing") == "Do thing"


class Listener:
    def __init__(self, *args):
        self.running = False

    def start(self):
        self.running = True

    def stop(self):
        self.running = False


async def test_hands_free_wake_word_asks(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.listener_factory = Listener
    await hub.start()
    hub.set_prefs({"hands_free": True})
    assert hub._listener.running
    await hub.on_heard("Jarvis, what's on tomorrow?")
    await asyncio.sleep(0.01)
    assert hub.client.queries == ["what's on tomorrow"]
    await hub.on_heard("just chatting with a friend about lunch")
    await asyncio.sleep(0.01)
    assert hub.client.queries == ["what's on tomorrow"]


async def test_bare_wake_word_arms_then_next_utterance_asks(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.listener_factory = Listener
    await hub.start()
    await hub.on_heard("Jarvis.")
    assert hub.state == "listening"
    await hub.on_heard("dim the lights")
    await asyncio.sleep(0.01)
    assert hub.client.queries == ["dim the lights"]


async def test_barge_in_stops_speech(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.state = "speaking"
    hub.turn = {"reply": "You have two meetings tomorrow at two and four."}
    await hub.on_heard("two meetings tomorrow at two")  # its own voice: ignored
    assert not hub._stopping
    await hub.on_heard("stop")
    assert hub._stopping


async def test_style_note_and_model_switch(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.client.set_model_calls = []

    async def set_model(model):
        hub.client.set_model_calls.append(model)

    hub.client.set_model = set_model
    hub.set_prefs({"humor": 95, "model": "sonnet"})
    await asyncio.sleep(0.01)
    assert hub.client.set_model_calls == ["claude-sonnet-5-5"]
    await hub.ask("hello")
    assert hub.client.queries[-1].startswith("[Note from the app:")
    assert "Humor 95 percent" in hub.client.queries[-1]
    await hub.ask("again")
    assert hub.client.queries[-1] == "again"


async def test_briefing_window(settings, quiet_speaker, isolated):
    from datetime import datetime

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    assert hub.briefing_due(datetime(2026, 9, 29, 8, 30))
    assert not hub.briefing_due(datetime(2026, 9, 29, 7, 59))
    assert not hub.briefing_due(datetime(2026, 9, 29, 16, 0))
    hub.prefs.last_briefing = "2026-09-29"
    assert not hub.briefing_due(datetime(2026, 9, 29, 8, 30))


async def test_search_notes_emits_sources(settings, quiet_speaker, isolated):
    from jarvis.knowledge import Note

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.kb.build(
        {
            "files": [
                Note(
                    id="files:1",
                    source="files",
                    title="Lisbon trip",
                    text="Flights to Lisbon in May",
                    ref="x",
                )
            ]
        }
    )
    q = hub.subscribe()
    text = hub.search_notes("lisbon flights")
    assert text.startswith("[files:1] Lisbon trip")
    event = q.get_nowait()
    assert event["type"] == "sources" and event["items"][0]["title"] == "Lisbon trip"
