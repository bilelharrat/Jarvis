"""Where the time goes between "you stop talking" and "JARVIS starts talking".

Measures each stage with real calls (Claude via your Claude Code sign-in, the configured
voice service) and nothing played aloud:

    uv run python scripts/latency_bench.py

  endpoint     silence Jarvis waits for before deciding you've finished (a setting)
  transcribe   Whisper on a spoken command
  first text   Claude: request sent -> first reply text ready to speak
  synthesize   voice service: that text -> audio ready to play
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

from claude_agent_sdk import AssistantMessage, ClaudeSDKClient, StreamEvent, TextBlock  # noqa: E402

from jarvis.brain import build_options  # noqa: E402
from jarvis.config import load_settings  # noqa: E402
from jarvis.listen import Transcriber  # noqa: E402
from jarvis.prefs import PrefsStore  # noqa: E402
from jarvis.speech import cloud_voice_from, read_wav  # noqa: E402

PROMPTS = [
    "What's the capital of Australia?",
    "Give me one quick tip for sleeping better.",
    "Tell me a short joke.",
    "How many minutes are in a day?",
]
SENTENCE_END = re.compile(r"[.!?](\s|$)")


async def never(*_):
    return False


async def claude_times(stream: bool) -> list[tuple[float, float, str]]:
    settings = load_settings()
    prefs = PrefsStore().prefs
    options = build_options(settings, never, prefs=prefs)
    options.include_partial_messages = stream
    out = []
    async with ClaudeSDKClient(options=options) as client:
        await client.query("Say OK.")  # warm the session like the app does at startup
        async for _ in client.receive_response():
            pass
        for prompt in PROMPTS:
            t0 = time.monotonic()
            first = None
            text = ""
            async for m in client.receive_response() if False else _ask(client, prompt):
                if stream and isinstance(m, StreamEvent):
                    ev = m.event
                    if (
                        ev.get("type") == "content_block_delta"
                        and ev["delta"].get("type") == "text_delta"
                    ):
                        text += ev["delta"]["text"]
                        if first is None and SENTENCE_END.search(text):
                            first = (
                                time.monotonic() - t0,
                                text[: SENTENCE_END.search(text).end()].strip(),
                            )
                elif isinstance(m, AssistantMessage):
                    for b in m.content:
                        if isinstance(b, TextBlock) and b.text.strip() and first is None:
                            first = (time.monotonic() - t0, b.text.strip())
            total = time.monotonic() - t0
            out.append((first[0] if first else total, total, first[1] if first else ""))
    return out


async def _ask(client, prompt):
    await client.query(prompt)
    async for m in client.receive_response():
        yield m


async def synth_time(text: str) -> float:
    settings = load_settings()
    cloud = cloud_voice_from(settings)
    t0 = time.monotonic()
    if cloud is not None:
        await cloud.synthesize(text)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(
                ["say", "-o", f"{tmp}/x.wav", "--data-format=LEI16@22050", text], check=True
            )
    return time.monotonic() - t0


def transcribe_time() -> float:
    tr = Transcriber("base.en")
    tr._load()
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            [
                "say",
                "-o",
                f"{tmp}/q.wav",
                "--data-format=LEI16@16000",
                "Jarvis, what's on my calendar tomorrow?",
            ],
            check=True,
        )
        audio, _ = read_wav(Path(f"{tmp}/q.wav"))
    times = []
    for _ in range(3):
        t0 = time.monotonic()
        tr.transcribe(audio)
        times.append(time.monotonic() - t0)
    return statistics.median(times)


async def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "both"
    endpoint_old, endpoint_new = 0.9, float(sys.argv[2]) if len(sys.argv) > 2 else 0.9
    tx = transcribe_time()
    print(f"transcribe: {tx:.2f}s")
    rows = {}
    for stream in [False, True] if mode == "both" else [mode == "stream"]:
        times = await claude_times(stream)
        synths = [await synth_time(t) for _, _, t in times]
        first = statistics.median(t for t, _, _ in times)
        syn = statistics.median(synths)
        rows[stream] = (first, syn)
        label = "sentence streaming" if stream else "whole text block"
        print(
            f"{label:20} first text {first:.2f}s · synth {syn:.2f}s · examples: {[t[2][:40] for t in times[:2]]}"
        )
    if len(rows) == 2:
        old = endpoint_old + tx + rows[False][0] + rows[False][1]
        new = endpoint_new + tx + rows[True][0] + rows[True][1]
        print(
            f"\nstop talking -> first sound: before {old:.2f}s, after {new:.2f}s ({(old - new) / old:.0%} faster)"
        )


if __name__ == "__main__":
    asyncio.run(main())
