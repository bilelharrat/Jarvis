"""The Jarvis number speaks in the voice the Mac speaks with: the Twilio Function's voice
step (src/jarvis/twilio/line.js) asks the voice service what the Mac asks it, and makes the
phone's audio from it the way the Mac makes a call's (speech.ai_voice_effect, then
phone.to_phone_rate, then speech.wav_bytes). Run in Node, with the service faked."""

from __future__ import annotations

import json
import shutil
import subprocess

import numpy as np
import pytest

from jarvis.answering import CODE
from jarvis.phone import PHONE_RATE, to_phone_rate
from jarvis.speech import ai_voice_effect, read_wav, wav_bytes

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="needs Node")

# Runs the Function's voice step once, with https faked: the voice service answers with the
# PCM in argv[2]. Prints what was asked of it, and writes the WAV the step sent to argv[3].
HARNESS = r"""
const fs = require('fs');
const https = require('https');
const { EventEmitter } = require('events');
const [, , pcmPath, outPath, contextJson, eventJson] = process.argv;
const asked = [];
https.request = (options, onResponse) => {
  const req = new EventEmitter();
  let body = '';
  req.write = (chunk) => { body += chunk; };
  req.destroy = (err) => req.emit('error', err);
  req.end = () => {
    asked.push({ host: options.host, path: options.path, headers: options.headers, body: body ? JSON.parse(body) : null });
    const res = new EventEmitter();
    res.statusCode = 200;
    setImmediate(() => {
      onResponse(res);
      res.emit('data', fs.readFileSync(pcmPath));
      res.emit('end');
    });
  };
  return req;
};
const source = fs.readFileSync(process.env.LINE_JS, 'utf8');
const mod = { exports: {} };
new Function('exports', 'require', 'module', source.replace('__SYNC__', 'IS123'))(mod.exports, require, mod);
mod.exports.handler(JSON.parse(contextJson), JSON.parse(eventJson), (err, wav) => {
  if (err) throw err;
  fs.writeFileSync(outPath, wav);
  console.log(JSON.stringify(asked));
});
"""

VOICE = {
    "ACCOUNT_SID": "AC1",
    "AUTH_TOKEN": "secret",
    "DOMAIN_NAME": "jarvis-line-1-line.twil.io",
    "PATH": "/call",
    "VOICE_PROVIDER": "fish",
    "VOICE_KEY": "fish-key",
    "VOICE_ID": "jarvis-model-id",
    "VOICE_MODEL": "s2.1-pro",
}


def speech(rate: int, seconds: float = 1.3) -> np.ndarray:
    """Something voice-like: a few harmonics that glide, and a little breath."""
    t = np.arange(int(rate * seconds)) / rate
    f0 = 110 + 30 * np.sin(2 * np.pi * 0.8 * t)
    phase = 2 * np.pi * np.cumsum(f0) / rate
    voiced = sum(np.sin(k * phase) / k for k in range(1, 12))
    breath = np.random.default_rng(0).normal(0, 0.05, t.size)
    audio = 0.35 * voiced + breath
    return np.clip(audio / np.max(np.abs(audio)) * 0.8, -1, 1)


def run_step(tmp_path, context, pcm: bytes, text="Good evening. How may I help?"):
    (tmp_path / "harness.js").write_text(HARNESS)
    (tmp_path / "voice.pcm").write_bytes(pcm)
    out = tmp_path / "out.wav"
    done = subprocess.run(
        [
            "node",
            str(tmp_path / "harness.js"),
            str(tmp_path / "voice.pcm"),
            str(out),
            json.dumps(context),
            json.dumps({"step": "voice", "v": "x", "say": text}),
        ],
        capture_output=True,
        text=True,
        timeout=60,
        env={"LINE_JS": str(CODE), "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"},
        check=True,
    )
    return json.loads(done.stdout), out.read_bytes()


def the_macs(pcm: bytes, rate: int, effect: bool) -> bytes:
    """What the Mac makes of the same answer for a call (hub._call_voice, phone.phone_audio)."""
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    if effect:
        audio = ai_voice_effect(audio, rate)
    return wav_bytes(to_phone_rate(audio, rate), PHONE_RATE)


def assert_same_audio(ours: bytes, macs: bytes) -> None:
    assert ours[:44] == macs[:44]  # the same WAV: 8 kHz, 16-bit, mono, as long
    a, rate = read_wav(ours)
    b, _ = read_wav(macs)
    assert rate == PHONE_RATE and a.size == b.size > 0
    # The same samples, give or take the last bit of rounding (float32 sums in another order).
    assert np.max(np.abs(a - b)) <= 2 / 32768


@pytest.mark.parametrize("effect", [False, True])
def test_the_line_sounds_as_the_mac_does_with_fish_audio(tmp_path, effect):
    pcm = (speech(24000) * 32767).astype("<i2").tobytes()
    context = {**VOICE, "VOICE_EFFECT": "1" if effect else ""}
    asked, wav = run_step(tmp_path, context, pcm)
    # The request speech.CloudVoice makes: the owner's voice model, 24 kHz, low latency.
    [request] = asked
    assert (request["host"], request["path"]) == ("api.fish.audio", "/v1/tts")
    assert request["headers"]["Authorization"] == "Bearer fish-key"
    assert request["headers"]["model"] == "s2.1-pro"
    assert request["body"] == {
        "text": "Good evening. How may I help?",
        "reference_id": "jarvis-model-id",
        "format": "pcm",
        "sample_rate": 24000,
        "latency": "low",
    }
    assert_same_audio(wav, the_macs(pcm, 24000, effect))


def test_the_line_sounds_as_the_mac_does_with_elevenlabs(tmp_path):
    pcm = (speech(22050) * 32767).astype("<i2").tobytes()
    context = {**VOICE, "VOICE_PROVIDER": "elevenlabs", "VOICE_MODEL": "", "VOICE_EFFECT": "1"}
    asked, wav = run_step(tmp_path, context, pcm, "Right away.")
    [request] = asked
    assert request["host"] == "api.elevenlabs.io"
    assert request["path"] == "/v1/text-to-speech/jarvis-model-id?output_format=pcm_22050"
    assert request["headers"]["xi-api-key"] == "fish-key"
    assert request["body"] == {"text": "Right away.", "model_id": "eleven_flash_v2_5"}
    assert_same_audio(wav, the_macs(pcm, 22050, True))
