"""The hub's own text paths: a sentence the voice can't take, or any failure in the hub's
handling of what Claude streams, never asks Claude again; and the user's own words are
read in linear time. Real Hub, FakeClient, temp stores."""

import time

from conftest import FakeClient, result
from test_hub import Transcriber, drain, stream_events

from jarvis import hub as hub_module
from jarvis.hub import Hub


def hub_with(settings, speaker, isolated, script, sent):
    class Client(FakeClient):
        async def query(self, text):
            sent.append(text)
            await super().query(text)

    Client.script = script
    return Hub(
        settings,
        client_factory=Client,
        speaker=speaker,
        transcriber=Transcriber(),
        poll=False,
        **isolated,
    )


def pieces(text, size):
    return [text[i : i + size] for i in range(0, len(text), size)]


# ── the voice's own failure never asks Claude again ──


async def test_a_sentence_the_voice_cant_take_is_skipped_not_asked_again(
    settings, quiet_speaker, isolated
):
    # The error reached ask(), which took it for a dead Claude Code: it reconnected, sent
    # the request again (a second model turn, its tools run twice) and showed an error.
    sent = []
    reply = "First part is fine. The second one breaks. Third is fine too. "
    hub = hub_with(
        settings, quiet_speaker, isolated, stream_events(pieces(reply, 4)) + [result()], sent
    )
    await hub.start()
    pushed = []

    def push(text):
        if "breaks" in text:
            raise ValueError("Exceeds the limit (4300 digits) for integer string conversion")
        pushed.append(text)

    hub.speech.push = push
    q = hub.subscribe()
    await hub.ask("read it to me")
    events = drain(q)
    assert len(sent) == 1
    assert not any(e["type"] == "error" for e in events)
    assert events[-1]["type"] == "turn_done" and hub.state == "idle"
    assert any("Third" in p for p in pushed)  # the rest of the reply is still voiced


async def test_a_failure_handling_the_stream_never_asks_again(settings, quiet_speaker, isolated):
    sent = []
    hub = hub_with(
        settings, quiet_speaker, isolated, stream_events(["Hello there."]) + [result()], sent
    )
    await hub.start()

    def broken(*_args):
        raise RuntimeError("a bug in the app's own handling")

    hub._on_stream = broken
    q = hub.subscribe()
    await hub.ask("hi")
    events = drain(q)
    assert len(sent) == 1 and not any(e["type"] == "error" for e in events)
    assert events[-1]["type"] == "turn_done" and hub.state == "idle"


async def test_a_chinese_reply_with_a_huge_number_is_asked_once(settings, quiet_speaker, isolated):
    sent = []
    text = "编号是第" + "7" * 4400 + "号。结果是1" + ",000" * 1500 + "。"
    hub = hub_with(settings, quiet_speaker, isolated, stream_events([text]) + [result()], sent)
    await hub.start()
    hub.prefs.language = "zh"
    hub._speak_language()
    said = []
    hub.speech.push = lambda t: said.append(hub.speaker.clean(t))
    q = hub.subscribe()
    await hub.ask("读一下编号")
    assert len(sent) == 1 and not any(e["type"] == "error" for e in drain(q))
    assert "七七七七" in "".join(said)


# ── the user's own words ──


def test_the_users_words_are_read_in_linear_time():
    # A clause's spaces are made single first: 4,000 of them took 0.8 s against the
    # patterns, each trying every way to split the run.
    said = "remember" + " " * 4000 + "when"
    patterns = [*hub_module.FEATURE_ASKED.values(), hub_module.CODE_ASKED, hub_module.MESSAGE_ASKED]
    started = time.perf_counter()
    assert not any(hub_module.user_asked(p, said) for p in patterns)
    assert time.perf_counter() - started < 0.1  # about 1 ms here
    remember = hub_module.FEATURE_ASKED["remember"]
    assert hub_module.user_asked(remember, "ok,   remember \t that I parked on level 3")
    assert not hub_module.user_asked(remember, "do you remember when we met")
