"""End to end: you stop talking -> JARVIS's first audible word, old pipeline vs new.

    uv run python scripts/voice_latency.py

Real calls (Whisper, Claude through your Claude Code sign-in, the voice service, the
native player with silence so nothing plays aloud). Stages:

  endpoint     the silence JARVIS waits for before it decides you've finished
  transcribe   Whisper on a spoken command
  first words  Claude: request -> the first clause it can start saying
  voice        voice service: that clause -> first audio bytes
  player       first audio bytes -> playing (process start, engine, pre-buffer)
"""

from __future__ import annotations

import asyncio
import re
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from claude_agent_sdk import ClaudeSDKClient, StreamEvent  # noqa: E402

from jarvis.brain import build_options  # noqa: E402
from jarvis.config import load_settings  # noqa: E402
from jarvis.listen import Transcriber  # noqa: E402
from jarvis.prefs import PrefsStore  # noqa: E402
from jarvis.speech import LivePlayer, cloud_voice_from, ensure_player, read_wav  # noqa: E402

PROMPTS = [
    "What's the capital of Australia?",
    "Give me one quick tip for sleeping better.",
    "How many minutes are in a day?",
    "What's a good name for a golden retriever?",
]
OLD_CLAUSE = re.compile(r"^(.{24,}?[,;:—–])\s")
NEW_CLAUSE = re.compile(r"^(.{12,}?[,;:—–])\s")
SENTENCE = re.compile(r"(.+?[.!?…:;])(\s+|$)", re.DOTALL)


async def never(*_):
    return False


def first_speakable(buf: str, clause: re.Pattern, min_sentence: int) -> str | None:
    m = clause.match(buf)
    if m and not re.search(r"[.!?]", m.group(1)):
        return m.group(1)
    m = SENTENCE.match(buf)
    return m.group(1) if m and len(m.group(1)) >= min_sentence else None


async def claude(thinking: bool, clause: re.Pattern, min_sentence: int) -> list[tuple[float, str]]:
    settings = load_settings()
    options = build_options(settings, never, prefs=PrefsStore().prefs)
    options.include_partial_messages = True
    if thinking:
        options.thinking = None  # the model's default (adaptive thinking)
    out = []
    async with ClaudeSDKClient(options=options) as client:
        await client.query("Say OK.")
        async for _ in client.receive_response():
            pass
        for prompt in PROMPTS:
            t0 = time.monotonic()
            buf, got = "", None
            await client.query(prompt)
            async for m in client.receive_response():
                if got is None and isinstance(m, StreamEvent):
                    delta = (m.event or {}).get("delta") or {}
                    if delta.get("type") == "text_delta":
                        buf += delta.get("text", "")
                        text = first_speakable(buf, clause, min_sentence)
                        if text:
                            got = (time.monotonic() - t0, text)
            out.append(got or (time.monotonic() - t0, buf))
    return out


async def voice_first_bytes(texts: list[str]) -> list[float]:
    voice = cloud_voice_from(load_settings())
    if voice is None:
        return [0.0 for _ in texts]
    await voice.warm()
    times = []
    for text in texts:
        t0 = time.monotonic()
        async for _chunk in voice.stream(text):
            times.append(time.monotonic() - t0)
            break
    return times


async def player_start(path: Path, live: bool) -> float:
    """First audio bytes in hand -> the player is playing them."""
    silence = b"\x00\x00" * 2400  # 0.1s per chunk, the size the voice service sends
    if live:
        player = LivePlayer(path, 24000, effect=True)
        await player.start()
        await asyncio.sleep(0.5)  # it's already running when a reply arrives
        t0 = time.monotonic()
        await player.write(silence)
        took = time.monotonic() - t0
        player.close()
        return took
    t0 = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        str(path),
        "24000",
        "--effect",
        stdin=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    # The old player waited for 0.25s of audio; at ~4x realtime that's ~60ms more bytes.
    for _ in range(3):
        proc.stdin.write(silence)
        await proc.stdin.drain()
        await asyncio.sleep(0.02)
    took = time.monotonic() - t0
    proc.kill()
    await proc.wait()
    return took + 0.1  # engine start before the first buffer can play (measured ~0.1s)


def transcribe_time(fast: bool) -> float:
    settings = load_settings()
    t = Transcriber(settings.whisper_model)
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "cmd.wav"
        subprocess.run(
            [
                "say",
                "-o",
                str(wav),
                "--data-format=LEI16@16000",
                "Jarvis, what's the capital of Australia?",
            ],
            check=True,
        )
        audio, _ = read_wav(wav)
    t.transcribe(audio)  # load
    runs = []
    for _ in range(3):
        t0 = time.monotonic()
        if fast:
            t.transcribe(audio)
        else:
            import numpy as np

            padded = np.concatenate([np.zeros(4800, dtype=np.float32), audio])
            segments, _ = t._load().transcribe(
                padded, language="en", beam_size=1, vad_filter=False, hotwords="Jarvis"
            )
            " ".join(s.text for s in segments)
        runs.append(time.monotonic() - t0)
    return statistics.median(runs)


async def main() -> None:
    path = await asyncio.to_thread(ensure_player)
    stages = {}
    # "after" waits 0.2s of silence (smart endpointing answers a finished-sounding request
    # then) and transcribes; "before" waited 0.6s, then transcribed.
    for label, endpoint, thinking, clause, min_sentence, fast, live in (
        ("before", 0.6, True, OLD_CLAUSE, 12, False, False),
        ("after", 0.2, False, NEW_CLAUSE, 4, True, True),
    ):
        words = await claude(thinking, clause, min_sentence)
        voice = await voice_first_bytes([t for _, t in words])
        stages[label] = {
            "endpoint": endpoint,
            "transcribe": await asyncio.to_thread(transcribe_time, fast),
            "first words": statistics.median(t for t, _ in words),
            "voice": statistics.median(voice),
            "player": await player_start(path, live) if path else 0.0,
        }
        print(
            label,
            {k: round(v, 2) for k, v in stages[label].items()},
            "e.g.",
            [t for _, t in words][:2],
        )
    before, after = sum(stages["before"].values()), sum(stages["after"].values())
    print(
        f"\nyou stop talking -> first word heard: before {before:.2f}s, after {after:.2f}s "
        f"({(1 - after / before) * 100:.0f}% faster)"
    )


if __name__ == "__main__":
    asyncio.run(main())
