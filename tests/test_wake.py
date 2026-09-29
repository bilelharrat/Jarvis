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


def test_hey_jarvis_and_its_mishearings():
    from jarvis.wake import find_wake

    for said, command in (
        ("Hey Jarvis, what time is it?", "what time is it"),
        ("Hey, Jarvis. What time is it?", "What time is it"),
        ("Hey Travis, turn the lights off.", "turn the lights off"),
        ("Okay Marvis, play some music", "play some music"),
        ("Hey Jarvis.", ""),
    ):
        assert find_wake(said) == (True, command), said
    for not_me in ("Travis called me yesterday", "I told Travis about it", "Harvest time is here"):
        assert find_wake(not_me)[0] is False, not_me


def test_a_no_anywhere_is_a_no_and_a_wait_is_not_a_yes():
    from jarvis.wake import yes_no

    assert yes_no("Okay, no, don't send it.") is False
    assert yes_no("OK, cancel.") is False and yes_no("Okay stop") is False
    assert yes_no("Sure, actually no.") is False
    assert yes_no("Yes, but wait.") is None  # the question stays open
    assert yes_no("Don’t send it") is False  # a curly apostrophe, as Whisper writes it
    assert yes_no("Okay.") is True and yes_no("Um, yes please") is True
    assert yes_no("No problem, go ahead") is not False


def test_jarvis_code_is_the_panel_not_the_wake_word():
    # JARVIS says "Jarvis Code" itself (heads-ups, questions, entering code mode).
    assert find_wake("Jarvis Code finished in proj. All tests pass.")[0] is False
    assert not find_wake(
        "Voice coding in proj, ask first. Everything you say now goes to Jarvis Code, "
        "say exit code mode to stop."
    )[0]
    assert find_wake("Jarvis, code in proj")[0] is True  # said to it, with a pause


def test_greetings_only_count_at_the_start():
    for not_me in ("We should plan a Paris trip.", "It was a harvest moon", "Hi Harris"):
        assert find_wake(not_me)[0] is False, not_me
    assert find_wake("Hey Travis, turn the lights off.") == (True, "turn the lights off")
