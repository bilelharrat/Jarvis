import pytest

from jarvis.wake import find_wake, is_echo, is_stop


def test_wake_word_with_command():
    assert find_wake("Eden, what's on my calendar?") == (True, "what's on my calendar")
    assert find_wake("hey eden play some music") == (True, "play some music")
    assert find_wake("Eden.") == (True, "")


def test_wake_word_anywhere():
    assert find_wake("What's the weather, Eden?") == (True, "What's the weather")
    assert find_wake("Okay Eden turn it up") == (True, "turn it up")
    assert find_wake("hey Eden") == (True, "")
    assert find_wake("what time is it")[0] is False


def test_the_old_name_no_longer_wakes_it():
    for said in ("Jarvis, what's on my calendar?", "Hey Jarvis", "What's the weather, Jarvis?"):
        assert find_wake(said)[0] is False, said


def test_stop_phrases():
    assert is_stop("Stop.")
    assert is_stop("okay stop")
    assert is_stop("hold on")
    assert not is_stop("stop the music in the kitchen and turn off the lights")
    assert not is_stop("")


def test_echo_detection():
    reply = "You have two meetings tomorrow, a design review at two and the dentist at four."
    assert is_echo("design review at two and the dentist", reply)
    assert not is_echo("cancel the dentist please eden", "Totally unrelated sentence here.")


def test_the_name_split_in_two_still_wakes_it():
    assert find_wake("E den, remind me to call Sam at 9.") == (True, "remind me to call Sam at 9")
    assert find_wake("E den,")[0]
    assert find_wake("Eden's here, play music") == (True, "here, play music")


def test_similar_words_do_not_wake():
    for text in [
        "Aiden is coming over",
        "I lived in Sweden",
        "even so",
        "we have eaten",
        "edit the file",
        "Joggers",
    ]:
        assert find_wake(text)[0] is False, text


def test_other_names_with_eden_in_them_do_not_wake_it():
    for text in [
        "open Ask Eden",
        "the garden of Eden",
        "Eden Messenger has a new message",
        "Eden Plus is on",
        "open the Eden app",
        "This Mac isn't linked to an Eden account.",
        "a call to the Eden number",
    ]:
        assert find_wake(text)[0] is False, text
    assert find_wake("Ask, Eden, what's the time?")[0] is True  # a pause makes it a call
    assert find_wake("Hey Eden, ask Eden to research it") == (True, "ask Eden to research it")


def test_hey_eden_and_its_mishearings():
    from jarvis.wake import find_wake

    for said, command in (
        ("Hey Eden, what time is it?", "what time is it"),
        ("Hey, Eden. What time is it?", "What time is it"),
        ("Hey Aiden, turn the lights off.", "turn the lights off"),
        ("Okay Edan, play some music", "play some music"),
        ("Hey Eden.", ""),
    ):
        assert find_wake(said) == (True, command), said
    for not_me in ("Aiden called me yesterday", "I told Aiden about it", "Eaton is a town"):
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
    # Eden says "Eden Code" itself (heads-ups, questions, entering code mode).
    assert find_wake("Eden Code finished in proj. All tests pass.")[0] is False
    assert not find_wake(
        "Voice coding in proj, ask first. Everything you say now goes to Eden Code, "
        "say exit code mode to stop."
    )[0]
    assert find_wake("Eden, code in proj")[0] is True  # said to it, with a pause
    assert find_wake("E den code now")[0] is False  # the name split in two, then "code"
    assert find_wake("E den, code now") == (True, "code now")


def test_the_panels_name_said_over_and_over_is_read_in_linear_time():
    import time

    def cpu(names: int) -> float:
        """This thread's CPU time to read the name said so many times: a busy Mac's other
        work doesn't count (it slowed the wall clock tenfold)."""
        started = time.thread_time()
        assert find_wake("eden code " * names) == (False, "")
        said = "Eden code " * names + "Eden, what time is it"
        assert find_wake(said) == (True, "what time is it")
        return time.thread_time() - started

    # The word after each name is looked up, not gathered again from all the rest (that
    # took 2 s): four times the names take about four times as long (0.06 s for 4,000
    # here), never sixteen. Each pair is timed back to back, the best of three: a busy Mac
    # moves a thread between fast and slow cores.
    pairs = [(cpu(1000), cpu(4000)) for _ in range(3)]
    assert min(large / small for small, large in pairs) < 8, pairs
    assert min(large for _small, large in pairs) < 0.5, pairs


def test_greetings_only_count_at_the_start():
    for not_me in ("We should plan a trip with Aiden.", "It was Edan's idea", "Hi Harris"):
        assert find_wake(not_me)[0] is False, not_me
    assert find_wake("Hey Aiden, turn the lights off.") == (True, "turn the lights off")


@pytest.mark.parametrize(
    "said",
    [
        "wake up daddy's home",
        "Wake up, daddy's home!",
        "wake up daddy is home",
        "wakeup daddys home",
        "wake up it's daddy's home",
        "wake up daddy's back",
    ],
)
def test_wake_up_daddys_home_wakes_jarvis(said):
    assert find_wake(said)[0] is True


def test_the_wake_phrase_carries_a_command_after_it():
    assert find_wake("wake up daddy's home, what's the weather?") == (True, "what's the weather")
    assert find_wake("wake up daddy's home") == (True, "")


@pytest.mark.parametrize(
    "said",
    [
        "wake up early, daddy is not home yet",  # "wake up" but not the phrase
        "daddy's home",  # the phrase needs "wake up", so this on its own doesn't
        "I woke up before daddy got home",
    ],
)
def test_ordinary_talk_does_not_trigger_the_wake_phrase(said):
    assert find_wake(said)[0] is False
