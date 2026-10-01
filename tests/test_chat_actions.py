"""The main chat's reply actions (features/chat_actions.py): read aloud and feedback."""

from __future__ import annotations

from types import SimpleNamespace

from jarvis.features import chat_actions
from jarvis.features.conversation_branch import TRY_AGAIN


class Hub:
    def __init__(self, incognito=False):
        self.commands = {}
        self.spoken = []
        self.events = []
        self.facts = []
        self.incognito = incognito
        self.changed = 0
        self.memory = SimpleNamespace(add=self._add)

    def _add(self, text, **kw):
        self.facts.append((text, kw))
        return SimpleNamespace(text=text)

    def register_command(self, kind, handler):
        self.commands[kind] = handler

    def _speak(self, text):
        self.spoken.append(text)

    def _memory_changed(self):
        self.changed += 1

    def emit(self, kind, **values):
        self.events.append((kind, values))


def installed(**kw):
    hub = Hub(**kw)
    chat_actions.install(hub)
    return hub


def test_read_aloud_says_the_reply_again():
    hub = installed()
    hub.commands["chat_say"]({"type": "chat_say", "text": "  It's   18 degrees. "})
    assert hub.spoken == ["It's 18 degrees."]
    hub.commands["chat_say"]({"type": "chat_say", "text": ""})
    assert hub.spoken == ["It's 18 degrees."]


def test_a_bad_response_is_remembered_as_a_correction():
    hub = installed()
    hub.commands["chat_feedback"](
        {"good": False, "note": "  don't use bullet points for short answers. "}
    )
    assert hub.facts == [
        (
            "When answering: don't use bullet points for short answers.",
            {"category": "preferences", "source": "said"},
        )
    ]
    assert hub.changed == 1
    assert hub.events[-1][1]["text"] == "Got it. Jarvis won’t do that again."


def test_good_feedback_and_an_empty_note_remember_nothing():
    hub = installed()
    hub.commands["chat_feedback"]({"good": True})
    hub.commands["chat_feedback"]({"good": False, "note": "   "})
    assert hub.facts == [] and hub.chat_actions.good == 1


def test_nothing_is_kept_from_an_incognito_conversation():
    hub = installed(incognito=True)
    hub.commands["chat_feedback"]({"good": False, "note": "too long"})
    assert hub.facts == []
    assert "incognito" in hub.events[-1][1]["text"]


def test_try_again_is_a_phrase_the_branching_feature_answers():
    assert TRY_AGAIN.match("Give me a different answer.") or TRY_AGAIN.search(
        "Give me a different answer."
    )
