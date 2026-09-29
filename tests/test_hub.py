import asyncio

import numpy as np
from conftest import CALENDAR_TURN, FakeClient, result

from jarvis.hub import Hub, tool_label


class Transcriber:
    def transcribe(self, _audio):
        return "what's on tomorrow"


def make_hub(settings, speaker, script=CALENDAR_TURN, recorder=None):
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
    )


def drain(queue):
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


async def test_ask_streams_turn_tools_reply_and_state(settings, quiet_speaker):
    hub = make_hub(settings, quiet_speaker)
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


async def test_error_result_is_reported(settings, quiet_speaker):
    hub = make_hub(settings, quiet_speaker, script=[result(is_error=True)])
    await hub.start()
    q = hub.subscribe()
    await hub.ask("hi")
    assert any(e["type"] == "error" for e in drain(q))
    assert hub.state == "idle"


async def test_approval_round_trip(settings, quiet_speaker):
    hub = make_hub(settings, quiet_speaker)
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


async def test_approval_denied(settings, quiet_speaker):
    hub = make_hub(settings, quiet_speaker)
    q = hub.subscribe()
    pending = asyncio.create_task(hub.confirm("Add event?"))
    await asyncio.sleep(0)
    approval = next(e for e in drain(q) if e["type"] == "approval")
    hub.resolve(approval["id"], "deny")
    assert await pending is False


async def test_listen_transcribes_then_asks(settings, quiet_speaker):
    def recorder(_silence, on_level):
        on_level(0.05)
        return np.zeros(1600, dtype=np.float32)

    hub = make_hub(settings, quiet_speaker, recorder=recorder)
    await hub.start()
    q = hub.subscribe()
    await hub.listen()
    events = drain(q)
    assert {"type": "heard", "text": "what's on tomorrow"} in events
    states = [e["value"] for e in events if e["type"] == "state"]
    assert states[:2] == ["listening", "transcribing"]
    assert hub.client.queries == ["what's on tomorrow"]


async def test_silence_does_not_ask(settings, quiet_speaker):
    hub = make_hub(settings, quiet_speaker, recorder=lambda *_: None)
    await hub.start()
    await hub.listen()
    assert hub.client.queries == []
    assert hub.state == "idle"


async def test_commands_mute_and_stop(settings, quiet_speaker):
    hub = make_hub(settings, quiet_speaker)
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
