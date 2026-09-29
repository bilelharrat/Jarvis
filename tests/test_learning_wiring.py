"""The hub's side of speech that learns, interruptions that learn, suggestions and
documents: with fakes for Claude, the microphone and the stores in a temp folder. Skipped
until the hub wiring (the integration snippets) is in."""

import asyncio

import numpy as np
import pytest
from test_hub import drain, make_hub

from jarvis.hub import Hub

pytestmark = pytest.mark.skipif(
    not hasattr(Hub, "_transcribe"), reason="the learning features aren't wired into the hub yet"
)


class Ears:
    """A transcriber that says what it's told to, and records the hints it was given."""

    def __init__(self, *texts):
        self.texts = list(texts)
        self.hints = []

    def transcribe(self, _audio, hotwords=None):
        self.hints.append(hotwords)
        return self.texts.pop(0)


async def test_a_spoken_correction_is_learned_and_told_to_claude(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    ears = Ears("call akin about the lease", "no, I said Okin")
    hub.transcriber = ears
    audio = np.zeros(1600, dtype=np.float32)
    for _ in range(2):
        text = hub.hearing.fix(await asyncio.to_thread(hub._transcribe, hub.transcriber, audio))
        await hub.ask(text)
    assert ears.hints == [None, None]  # nothing learned yet: Whisper called as before
    assert "call Okin about the lease" in hub.client.queries[-1]  # the note, put right
    assert hub.hearing.apply("akin") == "Okin"
    # From now on Whisper is told the word, and what it mishears is put right.
    ears.texts = ["text akin I'm late"]
    text = hub.hearing.fix(await asyncio.to_thread(hub._transcribe, hub.transcriber, audio))
    assert text == "text Okin I'm late"
    assert ears.hints[-1].startswith("Jarvis ") and "Okin" in ears.hints[-1]


async def test_a_routine_teaches_nothing(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.hearing.fix("call akin")
    await hub.ask("call akin")
    await hub.ask("[Routine: x] no, I said Okin", display="Routine · x")
    assert hub.hearing.corrections == {}
    assert [h["t"] for h in hub.suggester.history] == ["call akin"]


async def test_suggestion_cards(settings, quiet_speaker, isolated):
    from jarvis.suggestions import Suggestion

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    card = Suggestion(
        key="habit:x:1", kind="suggestion", title="Your usual", text="…",
        request="what's on tomorrow?", topic="habit:x", suggestion="habit",
    )  # fmt: skip
    hub.suggester.open[card.key] = card
    hub._suggest(card)
    await hub._handle({"type": "suggestion_reaction", "key": card.key, "action": "accepted"})
    for _ in range(50):
        await asyncio.sleep(0.01)
        if hub.client and hub.client.queries:
            break
    events = drain(q)
    assert any(e["type"] == "suggestion" and e["request"] == card.request for e in events)
    assert hub.client.said[-1] == "what's on tomorrow?"


async def test_interruption_cards_teach_the_interrupter(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.interrupts.learner.announced("message:5", "message", 5, "+14155550101", "Bob Chen")
    await hub._handle({"type": "alert_reaction", "key": "interrupt:message:5", "action": "x"})
    assert not hub.interrupts.learner.pending["message:5"].dismissed
    await hub._handle(
        {"type": "alert_reaction", "key": "interrupt:message:5", "action": "dismissed"}
    )
    assert hub.interrupts.learner.pending["message:5"].dismissed


def test_the_new_tools_are_served(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    servers = hub._feature_servers()
    assert {"hearing", "documents", "suggestions"} <= set(servers)
    prompt = hub._feature_prompt()
    assert "write_document" in prompt and "learn_word" in prompt
