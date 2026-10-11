"""Eden Code's split view, its setting (features/code_split.py): up to six sessions side by
side, which pane is the window's own and which has the focus, and the dividers' shares, kept in
prefs so the window can put the split back after a reload or a restart; the two-pane split kept
before comes in as its panes. Split view is on for everyone (not a Lab). Its window side is
tested in tests/web/code-split.test.mjs."""

import json

from conftest import FakeClient

from jarvis import prefs
from jarvis.features import _labs, code_split
from jarvis.hub import Hub

GOOD = {
    "on": True,
    "panes": [
        {"id": 3, "key": "a1b2c3d4e5f60718"},
        {"id": 7, "key": "0f1e2d3c4b5a6978"},
        {"id": 9, "key": "1111222233334444"},
    ],
    "own": 1,
    "focus": 2,
    "cols": [0.25, 0.35, 0.4],
    "rows": [1.0],
    "hub": "abcdef012345",
}
OLD = {
    "on": True,
    "ratio": 0.62,
    "focus": "right",
    "left": {"id": 3, "key": "a1b2c3d4e5f60718"},
    "right": {"id": 7, "key": "0f1e2d3c4b5a6978"},
    "hub": "abcdef012345",
}


def test_a_split_is_kept_as_the_window_gave_it():
    assert code_split.clean(GOOD) == GOOD
    # Off, with its sizes remembered for next time.
    off = code_split.clean({"on": False, "panes": [], "cols": [0.3, 0.7]})
    assert off == {
        "on": False,
        "panes": [],
        "own": 0,
        "focus": 0,
        "cols": [0.3, 0.7],
        "rows": [],
        "hub": "",
    }
    assert code_split.clean({}) == {**off, "cols": []}


def test_the_two_pane_split_of_before_comes_in_as_its_panes():
    assert code_split.clean(OLD) == {
        "on": True,
        "panes": [OLD["left"], OLD["right"]],
        "own": 0,
        "focus": 1,
        "cols": [0.62, 0.38],
        "rows": [],
        "hub": "abcdef012345",
    }
    # Off, as it was kept then: its divider stays.
    old_off = code_split.clean({"on": False, "ratio": 0.3})
    assert old_off["on"] is False and old_off["cols"] == [0.3, 0.7] and old_off["panes"] == []
    assert code_split.clean({"ratio": 9, "left": {"id": 1}})["cols"] == [0.8, 0.2]
    # What's kept now is kept as it is (the window writes the new shape back).
    assert code_split.clean(code_split.clean(OLD)) == code_split.clean(OLD)


def test_odd_values_are_made_safe_or_refused():
    assert code_split.clean("split") is None
    assert code_split.clean(None) is None
    assert code_split.clean(["left", "right"]) is None
    odd = code_split.clean(
        {
            "on": "yes",  # only true is on
            "panes": [
                {"id": True, "key": "x" * 65},
                {"id": -4, "key": "bad\nkey"},
                "pane",
                {"id": 2**31},
            ],
            "own": 9,
            "focus": True,
            "cols": [0.5, float("nan")],
            "rows": "1",
            "hub": 12,
        }
    )
    assert odd == {
        "on": False,
        "panes": [{"id": None, "key": ""}] * 4,
        "own": 0,
        "focus": 0,
        "cols": [],
        "rows": [],
        "hub": "",
    }


def test_six_panes_at_most_and_the_shares_kept_in_range():
    many = code_split.clean({"on": True, "panes": [{"id": i} for i in range(1, 10)], "focus": 5})
    assert len(many["panes"]) == code_split.MAX_PANES == 6
    assert many["focus"] == 5 and many["on"] is True
    assert code_split.clean({"on": True, "panes": [{"id": 1}]})["on"] is False  # one isn't a split
    # Each share at least 5%, adding up to 1; three columns at most, a row a pane at most.
    assert code_split.clean({"panes": [], "cols": [0.01, 0.99]})["cols"] == [0.0481, 0.9519]
    assert code_split.clean({"panes": [], "cols": [0.25] * 4})["cols"] == []
    assert code_split.clean({"panes": [], "rows": [1] * 6})["rows"] == [0.1667] * 6
    assert code_split.clean({"panes": [], "rows": [1] * 7})["rows"] == []
    assert code_split.clean({"panes": [], "cols": [1, 0]})["cols"] == []
    assert code_split.clean({"panes": [], "cols": [True, 1]})["cols"] == []


def test_the_window_keeps_it_in_prefs(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    assert hub.prefs.feature(code_split.PREF) == {}  # nothing split yet
    hub.set_feature_prefs({code_split.PREF: {**GOOD, "extra": "dropped"}})
    assert hub.prefs.feature(code_split.PREF) == GOOD
    # Something that isn't a split leaves the one kept.
    hub.set_feature_prefs({code_split.PREF: ["left", "right"]})
    assert hub.prefs.feature(code_split.PREF) == GOOD
    # The two-pane shape a window of before sends comes in as its panes.
    hub.set_feature_prefs({code_split.PREF: OLD})
    assert hub.prefs.feature(code_split.PREF)["panes"] == [OLD["left"], OLD["right"]]
    hub.set_feature_prefs({code_split.PREF: GOOD})

    saved = json.loads(isolated["prefs_store"].path.read_text())
    assert saved["features"][code_split.PREF] == GOOD
    assert prefs.PrefsStore(isolated["prefs_store"].path).prefs.feature(code_split.PREF) == GOOD


def test_split_view_is_on_for_everyone(monkeypatch):
    monkeypatch.delenv("JARVIS_LABS", raising=False)
    assert "code_split" not in _labs.LABS and "code_split" in _labs.GRADUATED

    class Kept:  # a prefs file from when split view was a Lab, switched on
        def feature(self, key):
            return ["code_split", "code_acp"] if key == "labs" else None

    assert "code_split" not in _labs.skipped(Kept())
    assert _labs.enabled(Kept()) == {"code_acp"}
    assert "code-split" not in _labs.web_skipped(Kept()) and "code-split" not in _labs.web_skipped(
        None
    )
    assert _labs._clean(["code_split", "code_plugins"]) == ["code_plugins"]
