from jarvis.home import match_shortcut

NAMES = ["Movie Mode", "Lights Off", "Lights On", "Good Night", "Focus"]


def test_matches_the_named_shortcut_ignoring_filler():
    assert match_shortcut("movie mode", NAMES) == "Movie Mode"
    assert match_shortcut("Please run movie mode.", NAMES) == "Movie Mode"
    assert match_shortcut("turn the lights off", NAMES) == "Lights Off"
    assert match_shortcut("turn on the light", NAMES) == "Lights On"
    assert match_shortcut("good night", NAMES) == "Good Night"


def test_anything_more_goes_to_claude():
    assert match_shortcut("what's a good movie mode for tonight", NAMES) is None
    assert match_shortcut("lights", NAMES) is None
    assert match_shortcut("please", NAMES) is None
    assert match_shortcut("focus on the budget", NAMES) is None
