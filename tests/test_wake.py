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


def test_near_misses_from_accents_and_distance():
    assert find_wake("Jarim Vis, remind me to call Sam at 9.") == (
        True,
        "remind me to call Sam at 9",
    )
    assert find_wake("What's the weather like today, Jaren Vist?") == (
        True,
        "What's the weather like today",
    )
    assert find_wake("Jari ves,")[0]
    assert find_wake("Jervis play music") == (True, "play music")


def test_similar_words_do_not_wake():
    for text in [
        "Travis is coming over",
        "call the service desk",
        "harvest festival",
        "Charles said hi",
        "Joggers",
    ]:
        assert find_wake(text)[0] is False, text
