"""Eden's dictation on the Mac (jarvis.eden_dictation through mcp_endpoint's POST /transcribe):
a browser's recording (WebM/Opus as Firefox makes it, or WAV) decoded in memory and heard by a
stand-in Whisper, its words back; the token, the session and the owner's card as for a call; the
media type, the size and two minutes checked. No microphone, no real Whisper model."""

import io
import time
import wave

import av
import numpy as np
import pytest
from conftest import FakeClient
from starlette.testclient import TestClient

from jarvis import eden_dictation
from jarvis.hub import Hub
from jarvis.mcp_endpoint import Endpoint, build_app

SESSION = "a1b2c3d4e5f6a7b8"


class Ears:
    """Whisper's stand-in: what it heard, and how long each recording was."""

    def __init__(self, words="Book a table for two at eight"):
        self.words = words
        self.heard = []

    def transcribe(self, audio):
        self.heard.append(len(audio) / eden_dictation.SAMPLE_RATE)
        return self.words


def tone(seconds, rate=16_000):
    t = np.arange(int(seconds * rate)) / rate
    return (0.2 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)


def wav(seconds):
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16_000)
        w.writeframes((tone(seconds) * 32767).astype("<i2").tobytes())
    return out.getvalue()


def webm(seconds):
    """WebM/Opus, as Firefox's MediaRecorder records it."""
    out = io.BytesIO()
    container = av.open(out, "w", format="webm")
    stream = container.add_stream("libopus", rate=48_000)
    stream.layout = "mono"
    data = tone(seconds, 48_000)
    for at in range(0, len(data) - 959, 960):
        frame = av.AudioFrame.from_ndarray(
            data[at : at + 960].reshape(1, -1), format="flt", layout="mono"
        )
        frame.sample_rate = 48_000
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode(None):
        container.mux(packet)
    container.close()
    return out.getvalue()


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    made = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    made.set_feature_prefs({"mcp_ask": False})
    made._say = lambda *_a, **_k: None
    made.transcriber = Ears()
    return made


def client_for(hub):
    endpoint = Endpoint(hub, hub.feature_path("mcp"))
    endpoint.token = "the-token"
    return TestClient(build_app(endpoint)), endpoint


def post(client, body, kind="audio/webm;codecs=opus", **headers):
    return client.post(
        "/transcribe",
        content=body,
        headers={
            "Authorization": "Bearer the-token",
            "X-Jarvis-Session": SESSION,
            "X-Jarvis-Client": "Eden",
            "Content-Type": kind,
            **headers,
        },
    )


def test_a_firefox_recording_comes_back_as_its_words(hub):
    client, _ = client_for(hub)
    answer = post(client, webm(1.5))
    assert answer.status_code == 200, answer.text
    assert answer.json() == {"text": "Book a table for two at eight", "is_error": False}
    answer = post(client, wav(2.0), kind="audio/wav")
    assert answer.status_code == 200
    assert [round(s, 1) for s in hub.transcriber.heard] == [1.5, 2.0], "decoded at 16 kHz"


def test_what_isnt_a_recording_or_is_too_long_is_refused(hub, monkeypatch):
    client, _ = client_for(hub)
    assert post(client, wav(1), kind="application/json").status_code == 415
    unreadable = post(client, b"\x1aE\xdf\xa3 not really webm")
    assert unreadable.status_code == 415 and "couldn’t be read" in unreadable.json()["text"]
    assert post(client, b"").status_code == 400
    long = post(
        client, wav(eden_dictation.MAX_SECONDS + eden_dictation.SLACK_SECONDS + 3), "audio/wav"
    )
    assert long.status_code == 413 and "2 minutes" in long.json()["text"]
    monkeypatch.setattr(eden_dictation, "MAX_BYTES", 1000)
    assert post(client, wav(1), kind="audio/wav").status_code == 413
    assert hub.transcriber.heard == [], "nothing was heard"


def test_the_token_session_and_card_guard_it_like_a_call(hub):
    client, endpoint = client_for(hub)
    assert post(client, wav(1), "audio/wav", Authorization="Bearer wrong").status_code == 401
    assert post(client, wav(1), "audio/wav", **{"X-Jarvis-Session": "x"}).status_code == 400
    hub.set_feature_prefs({"mcp_ask": True})
    asked = []

    async def no(question, detail="", choices=None, **_kw):
        asked.append(question)
        return "deny"

    hub.request_approval = no
    refused = post(client, wav(1), "audio/wav")
    assert refused.status_code == 403 and "didn't allow" in refused.json()["text"]
    assert asked and "Eden" in asked[0]
    endpoint.sessions["b1b2c3d4e5f6a7b8"] = (True, time.monotonic() + 3600, "Eden")
    allowed = post(client, wav(1), "audio/wav", **{"X-Jarvis-Session": "b1b2c3d4e5f6a7b8"})
    assert allowed.status_code == 200 and hub.transcriber.heard == [1.0]


def test_whisper_failing_says_so_without_the_words(hub):
    class Broken:
        def transcribe(self, _audio):
            raise RuntimeError("model gone")

    hub.transcriber = Broken()
    client, _ = client_for(hub)
    failed = post(client, wav(1), "audio/wav")
    assert failed.status_code == 500 and failed.json()["text"] == (
        "Jarvis couldn’t transcribe that recording."
    )


def test_media_types():
    assert eden_dictation.audio_type("audio/webm;codecs=opus") == "audio/webm"
    assert eden_dictation.audio_type("Audio/MP4") == "audio/mp4"
    assert eden_dictation.audio_type("video/webm") is None
    assert eden_dictation.audio_type(None) is None
