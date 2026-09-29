import io
import wave

import numpy as np

from jarvis.speech import CloudVoice, ai_voice_effect, available_voices, read_wav


def test_effect_is_finite_normalised_and_keeps_length():
    x = (np.sin(np.linspace(0, 400, 22050)) * 0.3).astype(np.float32)
    y = ai_voice_effect(x)
    assert np.isfinite(y).all()
    assert 0.8 < float(np.abs(y).max()) <= 0.9
    assert y.size >= x.size


def test_read_wav_bytes_downmixes():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes((np.array([[1000, 3000]] * 10, dtype="<i2")).tobytes())
    audio, rate = read_wav(buf.getvalue())
    assert rate == 24000 and audio.shape == (10,)
    assert abs(audio[0] - 2000 / 32768) < 1e-6


async def test_cloud_voice_sends_the_voice_id(monkeypatch):
    import httpx

    seen = {}
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(b"\x00\x00" * 100)

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["headers"] = request.headers
        seen["body"] = request.content
        return httpx.Response(200, content=buf.getvalue())

    real = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
    )
    audio, rate = await CloudVoice("fish", "k3y", "612b878b113047d9a770c069c8b4fdfe").synthesize(
        "Hello"
    )
    assert seen["url"] == "https://api.fish.audio/v1/tts"
    assert seen["headers"]["authorization"] == "Bearer k3y"
    assert b"612b878b113047d9a770c069c8b4fdfe" in seen["body"] and b'"format":"wav"' in seen[
        "body"
    ].replace(b" ", b"")
    assert rate == 24000 and audio.size == 100


def test_daniel_resolves_whatever_the_listing_format():
    assert "Daniel" in available_voices()


def test_read_wav_tolerates_streaming_placeholder_sizes():
    import struct

    samples = (np.arange(-50, 50, dtype="<i2") * 100).tobytes()
    fmt = struct.pack("<HHIIHH", 1, 1, 24000, 48000, 2, 16)
    wav = b"RIFF" + struct.pack("<I", 0xFFFFFF24) + b"WAVE" + b"fmt " + struct.pack("<I", 16) + fmt
    wav += b"data" + struct.pack("<I", 0xFFFFFF00) + samples + b"\x01"  # odd trailing byte
    audio, rate = read_wav(wav)
    assert rate == 24000 and audio.size == 100


def test_builtin_mic_is_preferred(monkeypatch):
    import sounddevice as sd

    from jarvis.listen import pick_input_device

    devices = [
        {"name": "Bilel's AirPods Pro", "max_input_channels": 1},
        {"name": "MacBook Air Microphone", "max_input_channels": 1},
    ]
    monkeypatch.setattr(sd, "query_devices", lambda *a: devices)
    assert pick_input_device("builtin") == 1
    assert pick_input_device("default") is None
