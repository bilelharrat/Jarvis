from jarvis.wake import find_wake, is_echo, is_stop


def test_wake_word_with_command():
    assert find_wake("Jarvis, what's on my calendar?") == (True, "what's on my calendar")
    assert find_wake("hey jarvis play some music") == (True, "play some music")
    assert find_wake("Jarvis.") == (True, "")


def test_wake_word_anywhere():
    assert find_wake("What's the weather, Jarvis?") == (True, "What's the weather")
    assert find_wake("Okay Jarvis turn it up") == (True, "turn it up")
    assert find_wake("hey Jarvis") == (True, "")
    assert find_wake("what time is it")[0] is False


def test_stop_phrases():
    assert is_stop("Stop.")
    assert is_stop("okay stop")
    assert is_stop("hold on")
    assert not is_stop("stop the music in the kitchen and turn off the lights")
    assert not is_stop("")


def test_echo_detection():
    reply = "You have two meetings tomorrow, a design review at two and the dentist at four."
    assert is_echo("design review at two and the dentist", reply)
    assert not is_echo("cancel the dentist please jarvis", "Totally unrelated sentence here.")
