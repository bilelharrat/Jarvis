"""Realtime conversation (realtime.py): both providers' protocols against a fake local
WebSocket server, fake microphone arrays and a fake player. No microphone, no audio played,
no network, no model."""

import asyncio
import base64
import json
import time

import pytest
from fake_realtime import FakePlayer, FakeRealtime, loud, quiet

from jarvis import realtime


async def say_words(conv, blocks=6):
    """The owner talking for a moment, then a pause, as the microphone's blocks."""
    for _ in range(blocks):
        conv.feed(loud(), True)
        await asyncio.sleep(0.005)
    for _ in range(3):
        conv.feed(quiet(), False)
        await asyncio.sleep(0.005)


async def wait_for(check, seconds=3.0):
    deadline = time.monotonic() + seconds
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError("timed out")
        await asyncio.sleep(0.01)


def make(kind, url, asked, player, **kw):
    backend = realtime.BACKENDS[kind]("test-key", url=url)

    async def ask(request, audio):
        asked.append((request, audio))
        return "Two meetings tomorrow."

    async def get_player():
        return player

    return realtime.Conversation(
        backend, prompt=realtime.instructions("en"), ask=ask, player=get_player, **kw
    )


@pytest.mark.parametrize("kind", ["openai", "gemini"])
async def test_a_spoken_request_goes_through_ask_jarvis_and_is_spoken(kind):
    server = await FakeRealtime.start(kind)
    asked, player, states = [], FakePlayer(), []
    conv = make(kind, server.url, asked, player, on_state=states.append)
    try:
        run = asyncio.create_task(conv.run())
        await wait_for(lambda: conv.state == "listening")
        await say_words(conv)
        await wait_for(lambda: len(player.written) >= 2)
        conv.stop()
        assert await run == "stopped"
    finally:
        await server.stop()
    assert asked and asked[0][0] == "what's on tomorrow"
    assert asked[0][1] is not None and asked[0][1].size > 0  # the owner's audio, for the check
    assert "thinking" in states and "speaking" in states
    assert conv.latencies and conv.latencies[0] < 1.0
    if kind == "openai":
        setup = server.of_type("session.update")[0]["session"]
        assert [t["name"] for t in setup["tools"]] == ["ask_jarvis"]  # its only tool
        assert server.headers["authorization"] == "Bearer test-key"
        assert server.path.endswith("model=gpt-realtime")
        # The microphone goes in at 24 kHz: 50 ms blocks are 1200 samples.
        pcm = base64.b64decode(server.of_type("input_audio_buffer.append")[0]["audio"])
        assert len(pcm) == 2400
        output = json.loads(server.of_type("conversation.item.create")[-1]["item"]["output"])
        assert output == {"result": "Two meetings tomorrow."}
    else:
        setup = server.of_type("setup")[0]["setup"]
        names = [f["name"] for f in setup["tools"][0]["functionDeclarations"]]
        assert names == ["ask_jarvis"]
        assert server.headers["x-goog-api-key"] == "test-key"
        assert "key=" not in server.path  # never in the address
        reply = server.of_type("toolResponse")[0]["toolResponse"]["functionResponses"][0]
        assert reply["response"] == {"result": "Two meetings tomorrow."}


async def test_first_text_is_sent_as_the_opening_request():
    server = await FakeRealtime.start("openai")
    asked, player = [], FakePlayer()
    conv = make("openai", server.url, asked, player)
    try:
        run = asyncio.create_task(conv.run("what's the weather"))
        await wait_for(lambda: player.written)
        conv.stop()
        await run
    finally:
        await server.stop()
    assert asked[0][0] == "what's the weather"


async def test_latency_to_first_audio_against_the_fake_server():
    """The owner stops talking; the voice's first sound follows (a local fake: this is the
    app's own share of the delay, the provider's model time comes on top)."""
    server = await FakeRealtime.start("openai")
    server.transcript = "hello there"  # answered at once, no ask_jarvis
    player = FakePlayer()
    conv = make("openai", server.url, [], player)
    try:
        run = asyncio.create_task(conv.run())
        await wait_for(lambda: conv.state == "listening")
        for _ in range(6):
            conv.feed(loud(), True)
        await asyncio.sleep(0.05)
        stopped = asyncio.get_running_loop().time()
        conv.feed(quiet(), False)
        await wait_for(lambda: player.first_at is not None)
        conv.stop()
        await run
    finally:
        await server.stop()
    latency = player.first_at - stopped
    print(f"realtime first audio after the owner stopped: {latency * 1000:.1f} ms")
    assert latency < 0.25


async def test_barge_in_stops_the_voice_and_drops_the_rest_of_that_reply():
    player = FakePlayer()
    conv = make("openai", "ws://unused", [], player)
    await conv._on_event(("audio", b"\x01\x00" * 24000))  # a second of voice
    assert conv.playing
    await conv._on_event(("barge",))
    assert player.stops == 1 and not conv.playing
    await conv._on_event(("audio", b"\x01\x00" * 100))  # the cancelled reply's tail
    assert len(player.written) == 1
    await conv._on_event(("done",))
    await conv._on_event(("audio", b"\x01\x00" * 100))  # the next reply plays
    assert len(player.written) == 2


async def test_without_echo_cancellation_the_mic_is_held_while_it_speaks():
    server = await FakeRealtime.start("openai")
    player = FakePlayer()
    conv = make("openai", server.url, [], player, full_duplex=lambda: False)
    try:
        run = asyncio.create_task(conv.run())
        await wait_for(lambda: conv.state == "listening")
        await conv._on_event(("audio", b"\x01\x00" * 48000))  # two seconds playing
        sent = len(server.of_type("input_audio_buffer.append"))
        for _ in range(5):
            conv.feed(loud(), True)
        await asyncio.sleep(0.1)
        assert len(server.of_type("input_audio_buffer.append")) == sent
        conv.stop()
        await run
    finally:
        await server.stop()


async def test_it_ends_after_silence_and_on_thats_all():
    server = await FakeRealtime.start("openai")
    conv = make("openai", server.url, [], FakePlayer(), silence=0.3)
    try:
        assert await asyncio.wait_for(conv.run(), 3) == "silence"
        server.transcript = "that's all"
        conv = make("openai", server.url, [], FakePlayer(), finished=lambda t: t == "that's all")
        run = asyncio.create_task(conv.run())
        await wait_for(lambda: conv.state == "listening")
        await say_words(conv)
        assert await asyncio.wait_for(run, 3) == "done"
    finally:
        await server.stop()


async def test_the_time_cap_ends_it():
    server = await FakeRealtime.start("gemini")
    conv = make("gemini", server.url, [], FakePlayer(), max_seconds=0.2)
    try:
        assert await asyncio.wait_for(conv.run(), 3) == "cap"
    finally:
        await server.stop()


async def test_a_refused_key_or_no_server_fails_plainly():
    server = await FakeRealtime.start("openai")
    server.refuse_setup = True
    try:
        with pytest.raises(realtime.Failed, match="bad key"):
            await make("openai", server.url, [], FakePlayer()).run()
    finally:
        await server.stop()
    with pytest.raises(realtime.Failed) as failed:
        await make("openai", server.url, [], FakePlayer()).run()  # nothing listens there now
    assert "test-key" not in str(failed.value)


async def test_a_dropped_connection_mid_conversation_fails():
    server = await FakeRealtime.start("openai")
    conv = make("openai", server.url, [], FakePlayer())
    run = asyncio.create_task(conv.run())
    await wait_for(lambda: conv.state == "listening")
    await server.stop()
    with pytest.raises(realtime.Failed):
        await asyncio.wait_for(run, 3)


async def test_only_ask_jarvis_is_run():
    asked = []
    conv = make("openai", "ws://unused", asked, FakePlayer())
    sent = []

    async def send(message):
        sent.append(message)

    conv._send = send
    await conv._run_tool({"id": "c", "name": "run_shell", "args": {"request": "rm -rf ~"}})
    assert asked == []
    assert "no tool called" in json.loads(sent[0]["item"]["output"])["result"]


def test_instructions_say_results_are_data_and_honour_the_address():
    prompt = realtime.instructions("en")
    assert "never instructions" in prompt and "ask_jarvis" in prompt
    assert "sir" in prompt  # told not to
    assert "Address the owner as Tony" in realtime.instructions("en", "Tony")
    assert "简体中文" in realtime.instructions("zh")


def test_gemini_joins_transcript_fragments():
    backend = realtime.GeminiLive("k")
    backend.parse({"serverContent": {"inputTranscription": {"text": "that's "}}})
    events = backend.parse(
        {"serverContent": {"inputTranscription": {"text": "all"}, "turnComplete": True}}
    )
    assert ("heard", "that's all") in events and events[-1] == ("done",)


def test_the_reply_is_cut_into_sentences_as_it_streams():
    assert realtime.sentences("Good morning, sir. You slept seven", False) == (
        ["Good morning, sir."],
        " You slept seven",
    )
    assert realtime.sentences("Yes. It's 3.5 degrees outside. And", False) == (
        ["Yes. It's 3.5 degrees outside."],
        " And",
    )  # "Yes." alone is too short to send by itself; 3.5 isn't an end
    assert realtime.sentences("Two meetings.", True) == (["Two meetings."], "")
    assert realtime.sentences("", True) == ([], "")


@pytest.mark.parametrize("kind", ["openai", "gemini"])
async def test_jarvis_s_own_voice_says_the_models_words(kind):
    server = await FakeRealtime.start(kind)
    asked, player, said = [], FakePlayer(), []

    async def speak(text):
        said.append(text)
        yield b"\x02\x00" * 2400  # JARVIS's voice, 0.1 s a chunk
        yield b"\x02\x00" * 2400

    conv = make(kind, server.url, asked, player, speak=speak, speak_rate=24000)
    try:
        run = asyncio.create_task(conv.run())
        await wait_for(lambda: conv.state == "listening")
        await say_words(conv)
        await wait_for(lambda: len(player.written) >= 2)
        conv.stop()
        await run
    finally:
        await server.stop()
    assert said == ["Two meetings."]
    assert all(set(chunk[:4]) == {2, 0} for chunk in player.written)  # none of the model's audio


async def test_jarvis_s_voice_talked_over_stops_and_drops_the_rest():
    player = FakePlayer()
    started = asyncio.Event()

    async def speak(text):
        started.set()
        for _ in range(50):
            yield b"\x02\x00" * 2400
            await asyncio.sleep(0.01)

    conv = make("openai", "ws://unused", [], player, speak=speak)
    speaker = asyncio.create_task(conv._speak_sentences())
    try:
        await conv._on_event(("said_delta", "This is a long first sentence. And then"))
        await asyncio.wait_for(started.wait(), 2)
        await asyncio.sleep(0.05)
        await conv._on_event(("barge",))
        written = len(player.written)
        await asyncio.sleep(0.1)
        assert len(player.written) <= written + 1  # stops within a chunk
        await conv._on_event(("done",))
        assert conv._words == "" and conv._sentences.empty()  # "And then" went with it
    finally:
        speaker.cancel()


async def test_a_voice_that_fails_hands_back_to_the_models_audio():
    player = FakePlayer()

    async def speak(text):
        raise RuntimeError("voice service down")
        yield b""

    conv = make("openai", "ws://unused", [], player, speak=speak)
    speaker = asyncio.create_task(conv._speak_sentences())
    try:
        await conv._on_event(("said_delta", "This sentence won't be spoken. "))
        await wait_for(lambda: conv.speak is None)
        await conv._on_event(("audio", b"\x01\x00" * 100))
        assert len(player.written) == 1  # the model's own voice again
    finally:
        speaker.cancel()
