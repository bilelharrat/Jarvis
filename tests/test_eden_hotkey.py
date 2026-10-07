"""Ask Eden from anywhere (features/eden_hotkey.py): its two settings, off by default, with
keys checked as JARVIS's other global shortcuts are."""

from jarvis.features import eden_hotkey
from jarvis.prefs import Prefs, clean_feature_values


def test_off_by_default_with_control_option_space():
    prefs = Prefs()
    assert prefs.feature(eden_hotkey.ON_KEY) is False
    assert prefs.feature(eden_hotkey.KEYS_KEY) == "Control+Alt+Space"


def test_keys_are_checked_like_the_other_shortcuts():
    kept = clean_feature_values({
        eden_hotkey.ON_KEY: True,
        eden_hotkey.KEYS_KEY: "Shift+Alt+E",
    })
    assert kept == {eden_hotkey.ON_KEY: True, eden_hotkey.KEYS_KEY: "Alt+Shift+E"}
    # macOS's own, a bare letter, or not a switch: left out (the old value stays)
    assert clean_feature_values({eden_hotkey.KEYS_KEY: "Command+Control+Space"}) == {}
    assert clean_feature_values({eden_hotkey.KEYS_KEY: "J"}) == {}
    assert clean_feature_values({eden_hotkey.ON_KEY: "yes"}) == {}
