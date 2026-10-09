"""Eden Code's split view, its setting (features/code_split.py): the two sessions side by
side, the divider and the focused pane, kept in prefs so the window can put the split back after
a reload or a restart. Its window side is tested in tests/web/code-split.test.mjs."""

import json

from conftest import FakeClient

from jarvis import prefs
from jarvis.features import code_split
from jarvis.hub import Hub

GOOD = {
    "on": True,
    "ratio": 0.62,
    "focus": "right",
    "left": {"id": 3, "key": "a1b2c3d4e5f60718"},
    "right": {"id": 7, "key": "0f1e2d3c4b5a6978"},
    "hub": "abcdef012345",
}


def test_a_split_is_kept_as_the_window_gave_it():
    assert code_split.clean(GOOD) == GOOD
    # Off, with its divider remembered for next time.
    off = code_split.clean({"on": False, "ratio": 0.3})
    assert off["on"] is False and off["ratio"] == 0.3
    assert off["left"] == {"id": None, "key": ""} and off["focus"] == "left"


def test_odd_values_are_made_safe_or_refused():
    assert code_split.clean("split") is None
    assert code_split.clean(None) is None
    odd = code_split.clean(
        {
            "on": "yes",  # only true is on
            "ratio": float("nan"),
            "focus": "middle",
            "left": {"id": True, "key": "x" * 65},
            "right": {"id": -4, "key": "bad\nkey"},
            "hub": 12,
        }
    )
    assert odd == {
        "on": False,
        "ratio": 0.5,
        "focus": "left",
        "left": {"id": None, "key": ""},
        "right": {"id": None, "key": ""},
        "hub": "",
    }
    # The divider never leaves the room each pane needs.
    assert code_split.clean({"ratio": 0.01})["ratio"] == 0.2
    assert code_split.clean({"ratio": 7})["ratio"] == 0.8
    assert code_split.clean({"ratio": "0.4"})["ratio"] == 0.5


def test_the_window_keeps_it_in_prefs(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    assert hub.prefs.feature(code_split.PREF) == {}  # nothing split yet
    hub.set_feature_prefs({code_split.PREF: {**GOOD, "extra": "dropped"}})
    assert hub.prefs.feature(code_split.PREF) == GOOD
    # Something that isn't a split leaves the one kept.
    hub.set_feature_prefs({code_split.PREF: ["left", "right"]})
    assert hub.prefs.feature(code_split.PREF) == GOOD

    saved = json.loads(isolated["prefs_store"].path.read_text())
    assert saved["features"][code_split.PREF] == GOOD
    assert prefs.PrefsStore(isolated["prefs_store"].path).prefs.feature(code_split.PREF) == GOOD
