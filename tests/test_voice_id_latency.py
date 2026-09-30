"""Owner voice recognition adds no latency: the time from the end of a hands-free
utterance to the first spoken sentence of the answer, with the check on and off.

The fakes are realistic: the speaker embedding takes 30 ms (the ONNX model's order on
Apple silicon), Whisper 150 ms for a short command, and Claude 300 ms to its first words.
The check runs beside the transcription and the request, so both columns are equal.
While someone talks, look-ahead checks of what they've said so far run too, so the
verdict is ready even when the words are (Apple's live recognizer, no transcription wait).
Run with -s to see the numbers."""

import asyncio
import statistics
import time

import pytest
from claude_agent_sdk import AssistantMessage, TextBlock
from conftest import FakeClient, result
from test_hub import Listener
from test_voice_id import Words, enrolled_guard, speech

from jarvis.hub import Hub

MODEL_SECONDS = 0.3
EMBED_SECONDS = 0.03
RUNS = 3


class SlowClient(FakeClient):
    script = [
        AssistantMessage(content=[TextBlock(text="Two meetings tomorrow.")], model="m"),
        result(),
    ]

    async def receive_response(self):
        await asyncio.sleep(MODEL_SECONDS)  # Claude thinking before its first words
        for message in self.script:
            yield message


async def first_words(settings, speaker, isolated, check: bool, stt_seconds: float) -> float:
    hub = Hub(settings, client_factory=SlowClient, speaker=speaker, transcriber=Words("Jarvis, what's on tomorrow?", stt_seconds), poll=False, **isolated)  # fmt: skip
    hub.listener_factory = Listener
    await hub.start()
    hub.set_prefs({"hands_free": True})
    if check:
        enrolled_guard(hub, "all", EMBED_SECONDS)
    spoken = asyncio.get_running_loop().create_future()
    speak = hub._speak

    def first(text):
        if not spoken.done():
            spoken.set_result(time.perf_counter())
        speak(text)

    hub._speak = first
    # The microphone's blocks as they're said (the look-ahead hears them), then the 0.2 s
    # of quiet after which the listener hands the utterance over: timed from then.
    audio = speech("owner")
    guard = hub.voice_guard
    guard.attach(hub._listener)
    block = int(0.05 * 16000)
    for i in range(0, audio.size, block):
        hub._listener.on_block(audio[i : i + block], True)
    await asyncio.sleep(0.2)
    ended = time.perf_counter()
    hub._heard.put_nowait(("full", time.monotonic(), audio))
    at = await asyncio.wait_for(spoken, 5)
    await asyncio.sleep(0.05)
    hub._heard.put_nowait(None)
    return at - ended


@pytest.mark.parametrize("stt_seconds", [0.15, 0.0], ids=["whisper", "live-words"])
async def test_time_to_first_reply_is_the_same_with_the_check_on(
    settings, quiet_speaker, isolated, stt_seconds, tmp_path
):
    times = {False: [], True: []}
    for run in range(RUNS * 2):
        check = bool(run % 2)
        folder = tmp_path / str(run)
        folder.mkdir()
        mine = {**isolated}
        from jarvis.prefs import PrefsStore

        mine["prefs_store"] = PrefsStore(folder / "prefs.json")
        times[check].append(await first_words(settings, quiet_speaker, mine, check, stt_seconds))
    off, on = statistics.median(times[False]), statistics.median(times[True])
    print(
        f"\nvoice check latency ({'Whisper 150 ms' if stt_seconds else 'words already heard'}, "
        f"embedding {EMBED_SECONDS * 1000:.0f} ms, model {MODEL_SECONDS * 1000:.0f} ms): "
        f"off {off * 1000:.1f} ms, on {on * 1000:.1f} ms, difference {(on - off) * 1000:+.1f} ms"
    )
    assert on - off < 0.01  # within timer noise: the check never sits in the path
