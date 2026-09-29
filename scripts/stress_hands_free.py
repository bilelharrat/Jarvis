"""Stress test for hands-free listening: synthetic speech through the real pipeline.

Speech is generated with macOS voices, mixed into room noise at several volumes, fed
block by block through the Segmenter, transcribed with the real Whisper model, and run
through the wake-word rules. Prints detection rates. No microphone, no Claude calls.

    uv run python scripts/stress_hands_free.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jarvis.listen import BLOCK_SECONDS, SAMPLE_RATE, Segmenter, Transcriber  # noqa: E402
from jarvis.speech import read_wav  # noqa: E402
from jarvis.wake import find_wake  # noqa: E402

VOICES = ["Daniel", "Samantha", "Fred", "Karen", "Moira", "Rishi"]
WAKE_PHRASES = [
    ("Jarvis, what's on my calendar tomorrow?", True),
    ("Hey Jarvis, play some music.", True),
    ("What's the weather like today, Jarvis?", True),
    ("Jarvis.", True),
    ("Okay Jarvis, how many emails do I have?", True),
    ("Jarvis, remind me to call Sam at nine.", True),
]
NEGATIVE = [
    ("I think the meeting went pretty well today.", False),
    ("Can you pass me the salt please?", False),
    ("Travel plans are set for next week.", False),
]
VOLUMES = [1.0, 0.4, 0.15]  # 0.15 ~ speaking from across the room
NOISE = 0.004


def synth(text: str, voice: str, folder: Path) -> np.ndarray:
    path = folder / "u.wav"
    subprocess.run(
        ["say", "-v", voice, "--data-format=LEI16@16000", "-o", str(path), text],
        check=True,
        capture_output=True,
    )
    audio, rate = read_wav(path)
    assert rate == SAMPLE_RATE
    return audio


def stream_through(segmenter: Segmenter, audio: np.ndarray, rng) -> list[np.ndarray]:
    lead = rng.normal(0, NOISE, int(1.5 * SAMPLE_RATE)).astype(np.float32)
    tail = rng.normal(0, NOISE, int(2.0 * SAMPLE_RATE)).astype(np.float32)
    signal = np.concatenate(
        [lead, audio + rng.normal(0, NOISE, audio.size).astype(np.float32), tail]
    )
    block = int(SAMPLE_RATE * BLOCK_SECONDS)
    out = []
    for i in range(0, signal.size - block, block):
        chunk = signal[i : i + block]
        utterance = segmenter.feed(chunk, float(np.sqrt(np.mean(chunk**2))))
        if utterance is not None:
            out.append(utterance)
    return out


def main() -> None:
    rng = np.random.default_rng(3)
    transcriber = Transcriber("base.en")
    transcriber._load()
    available = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    voices = [v for v in VOICES if v in available]
    results = {"wake_hit": 0, "wake_total": 0, "false_wake": 0, "neg_total": 0, "no_segment": 0}
    misses: list[str] = []
    latencies = []
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        for voice in voices:
            for volume in VOLUMES:
                for text, should_wake in WAKE_PHRASES + NEGATIVE:
                    audio = synth(text, voice, folder) * volume
                    segmenter = Segmenter()
                    # warm the noise calibration like a real session would
                    stream_through(segmenter, np.zeros(0, np.float32), rng)
                    segments = stream_through(segmenter, audio, rng)
                    heard = []
                    for seg in segments:
                        t = time.monotonic()
                        heard.append(transcriber.transcribe(seg))
                        latencies.append(time.monotonic() - t)
                    text_heard = " ".join(heard)
                    woke = any(find_wake(h)[0] for h in heard)
                    if not segments:
                        results["no_segment"] += 1
                    if should_wake:
                        results["wake_total"] += 1
                        results["wake_hit"] += woke
                        if not woke:
                            misses.append(
                                f"{voice:9} vol {volume:<4} said {text!r:48} heard {text_heard!r}"
                            )
                    else:
                        results["neg_total"] += 1
                        results["false_wake"] += woke
                        if woke:
                            misses.append(f"FALSE WAKE {voice} {volume}: {text_heard!r}")
    rate = results["wake_hit"] / max(1, results["wake_total"])
    print(f"voices: {', '.join(voices)}")
    print(f"wake detected: {results['wake_hit']}/{results['wake_total']} ({rate:.0%})")
    print(f"false wakes:   {results['false_wake']}/{results['neg_total']}")
    print(f"no segment at all: {results['no_segment']}")
    if latencies:
        print(
            f"transcribe latency: median {np.median(latencies):.2f}s, p95 {np.percentile(latencies, 95):.2f}s"
        )
    for line in misses:
        print("  miss:", line)


if __name__ == "__main__":
    main()
