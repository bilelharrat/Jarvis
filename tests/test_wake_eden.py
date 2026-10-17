"""The shipped default wake word is "Eden": called by name ("Eden, what's on today?",
"Hey Eden"), never mid-sentence, and "Jarvis" is only a name the owner can add."""

import pytest

from jarvis import wake, wakewords

pytestmark = pytest.mark.eden_default


def test_by_default_it_is_eden():
    assert wakewords.defaults("jarvis") == ["Eden"]
    assert wakewords.defaults("friday") == ["Eden", "Friday"]
    assert wakewords.effective("jarvis", "en", None) == ["Eden"]
    assert wake.wake_names() == ("Eden",)


def test_eden_wakes_when_called_and_jarvis_does_not():
    assert wake.find_wake("Eden, what's on today?") == (True, "what's on today")
    assert wake.find_wake("Hey Eden") == (True, "")
    assert wake.find_wake("The Garden of Eden is a place") == (False, "")
    assert wake.find_wake("Jarvis, what's on today?")[0] is False


def test_the_owner_can_add_jarvis_back():
    def names():
        return wakewords.effective("jarvis", "en", {"added": ["Jarvis"], "removed": []})

    wake.configure(names)
    try:
        assert wake.find_wake("What's the weather, Jarvis?") == (True, "What's the weather")
        assert wake.find_wake("Eden, hello") == (True, "hello")
    finally:
        wake.configure(None)
