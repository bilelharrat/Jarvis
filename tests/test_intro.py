"""What the first-run intro (web/features/intro.js) needs from the backend: the live
microphone meter (ops_mic_meter), and the accounts cards' walkthroughs, which come from
connectors.CATALOG with their Chinese in web/i18n/intro.json. No microphone is opened here:
the hands-free listener is a stand-in, and the recorder a function."""

import asyncio

import numpy as np
import pytest
from conftest import FakeClient

from jarvis import connectors
from jarvis.features import ops
from jarvis.hub import Hub
from jarvis.server import zh_strings


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


class Listener:
    """Hands-free's stream, as the meter sees it: running, with a level callback."""

    def __init__(self):
        self.running = True
        self.seen = []
        self.on_level = self.seen.append


async def events(queue, kind, until, timeout=5.0):
    out = []
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        while not queue.empty():
            event = queue.get_nowait()
            if event["type"] == kind:
                out.append(event)
                if until(event):
                    return out
        await asyncio.sleep(0.01)
    raise AssertionError(f"no end to {kind}: {out}")


async def test_the_meter_reads_hands_free_stream_and_gives_it_back(hub):
    desk = ops.desk_for(hub)
    desk.meter_seconds = 0.3
    listener = Listener()
    original = listener.on_level
    hub._listener = listener
    hub.prefs.hands_free = True
    queue = hub.subscribe()
    await hub._handle({"type": "ops_mic_meter"})
    await asyncio.sleep(0.02)
    assert listener.on_level is not original  # tapped
    listener.on_level(0.05)  # as the microphone's thread would
    await hub._handle({"type": "ops_mic_meter"})  # a second press while it runs: one meter
    seen = await events(queue, "ops_mic", lambda e: e["state"] == "metered")
    states = [e["state"] for e in seen]
    assert states[0] == "listening" and states.count("listening") == 1
    assert {"state": "level", "level": 0.6} in [
        {k: e[k] for k in ("state", "level") if k in e} for e in seen
    ]
    assert seen[-1]["peak"] == 0.6
    assert listener.seen == [0.05]  # the hub's own level callback still had it
    assert listener.on_level == original  # and has its stream back
    # nothing was recorded or transcribed: no utterance, no "heard"
    assert "heard" not in states


async def test_without_hands_free_the_meter_is_the_microphone_test(hub):
    class Stt:
        def transcribe(self, audio):
            return "hello there"

    def recorder(silence, on_level):
        on_level(0.02)
        return np.zeros(16000, dtype=np.float32)

    hub.recorder, hub.transcriber = recorder, Stt()
    hub.prefs.hands_free = False
    queue = hub.subscribe()
    await hub._handle({"type": "ops_mic_meter"})
    seen = await events(queue, "ops_mic", lambda e: e["state"] in ("heard", "error"))
    assert [e["state"] for e in seen][0] == "listening"
    assert seen[-1] == {"type": "ops_mic", "state": "heard", "text": "hello there"}


async def test_hands_free_whose_microphone_never_opened_meters_silence(hub):
    hub.prefs.hands_free = True
    hub._listener = None
    queue = hub.subscribe()
    await hub._handle({"type": "ops_mic_meter"})
    seen = await events(queue, "ops_mic", lambda e: e["state"] == "metered")
    assert seen == [{"type": "ops_mic", "state": "metered", "peak": 0.0}]


def test_every_account_that_needs_more_than_a_sign_in_has_a_walkthrough():
    for entry in connectors.CATALOG:
        if entry.auth == "oauth":
            continue
        assert len(entry.steps) >= 3, entry.id
        if entry.auth == "own_app":  # its developer console needs the redirect URI
            assert sum(s.count("{redirect_uri}") for s in entry.steps) == 1, entry.id
    google = [e for e in connectors.CATALOG if e.category == "Google"]
    assert google and all(e.steps == connectors.GOOGLE_STEPS for e in google)


def test_the_window_gets_the_walkthroughs_and_the_redirect_uri(tmp_path):
    manager = connectors.ConnectorManager.__new__(connectors.ConnectorManager)
    manager.connections = {}
    public = connectors.ConnectorManager.public(manager)
    asana = next(e for e in public["catalog"] if e["id"] == "asana")
    assert list(asana["steps"]) and any("{redirect_uri}" in s for s in asana["steps"])
    assert public["redirect_uri"] == connectors.REDIRECT_URI


def test_every_walkthrough_step_has_its_chinese():
    """The window shows each step's text around the redirect URI as its own sentence."""
    merged = zh_strings()["strings"]
    missing = []
    for entry in connectors.CATALOG:
        for step in entry.steps:
            for piece in step.split("{redirect_uri}"):
                piece = " ".join(piece.split())
                if piece and piece not in merged:
                    missing.append(piece)
    assert missing == []
