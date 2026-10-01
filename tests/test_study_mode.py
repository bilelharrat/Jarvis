"""Study mode (features/study_mode.py): the tutor's note rides on requests while it's on."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from jarvis.features import study_mode


def installed(on):
    contexts = []
    hub = SimpleNamespace(
        prefs=SimpleNamespace(feature=lambda key: on if key == "study_mode" else None),
        add_request_context=contexts.append,
    )
    study_mode.install(hub)
    return contexts[0]


def test_the_tutors_note_goes_only_while_its_on():
    assert asyncio.run(installed(True)("explain recursion", None)) == {"note": study_mode.NOTE}
    assert asyncio.run(installed(False)("explain recursion", None)) is None


def test_words_someone_else_sent_on_dont_get_it():
    assert asyncio.run(installed(True)("from a link", "from a link")) is None


def test_its_off_until_switched_on():
    from jarvis.prefs import FEATURE_PREFS

    assert FEATURE_PREFS["study_mode"][0] is False
    assert "quiz" in study_mode.NOTE and "step by step" in study_mode.NOTE
