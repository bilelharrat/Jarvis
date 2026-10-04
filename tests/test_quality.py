"""Jarvis's quality numbers (features/quality.py): answer time, crash-free days, lost chats
and heads-ups a day, kept across runs."""

from types import SimpleNamespace as NS

from jarvis.features import quality


def hub(tmp_path):
    return NS(feature_path=lambda name: tmp_path / name)


def test_a_run_that_never_quit_counts_as_a_crash_and_missing_chats_count_as_lost(tmp_path):
    (tmp_path / "code_sessions").mkdir()
    for key in ("a", "b"):
        (tmp_path / "code_sessions" / f"{key}.json").write_text("{}")
    first = quality.Quality(hub(tmp_path))
    first.started()
    assert first.public()["crash_free_days"] == 1 and first.public()["lost_chats"] == 0
    (tmp_path / "code_sessions" / "b.json").unlink()  # (gone without the owner)
    again = quality.Quality(hub(tmp_path))  # the marker is still there: no clean quit
    again.started()
    q = again.public()
    assert q["crash_free_days"] == 0 and q["lost_chats"] == 1 and q["chats_kept"] == 1
    again.quit_cleanly()
    third = quality.Quality(hub(tmp_path))
    third.started()
    assert third.public()["lost_chats"] == 1  # (counted once)


def test_answer_time_is_from_the_end_of_the_words_to_the_first_spoken_word(tmp_path, monkeypatch):
    desk = quality.Quality(hub(tmp_path))
    clock = iter([10.0, 11.5, 20.0, 20.5])
    monkeypatch.setattr(quality.time, "monotonic", lambda: next(clock))
    for value in (
        "listening",
        "transcribing",
        "thinking",
        "speaking",
        "idle",
        "thinking",
        "speaking",
    ):
        desk.state({"value": value})
    desk.headsup(None)
    q = desk.public()
    assert desk.latency == [1.5, 0.5] and q["answers"] == 2 and q["headsups_per_day"] == 1


def test_a_kind_nearly_always_dismissed_is_quieted_until_brought_back(tmp_path):
    desk = quality.Quality(hub(tmp_path))
    rain = NS(kind="rain")
    for _ in range(10):
        desk.headsup(rain)
        desk.reaction("rain", "dismissed")
    assert desk.gate(rain) is False and desk.public()["quiet"] == ["rain"]
    call = NS(kind="call")
    for _ in range(12):
        desk.headsup(call)
        desk.reaction("call", "dismissed")
    assert desk.gate(call) is True  # never quieted
    desk.unquiet_kind("rain")
    for _ in range(12):
        desk.headsup(rain)
        desk.reaction("rain", "dismissed")
    assert desk.gate(rain) is True  # the owner's say holds
    weather = NS(kind="soon")
    for n in range(10):
        desk.headsup(weather)
        desk.reaction("soon", "opened" if n < 4 else "dismissed")
    assert desk.gate(weather) is True  # opened often enough to keep


def test_hands_free_answer_time_runs_from_the_heard_request(tmp_path, monkeypatch):
    desk = quality.Quality(hub(tmp_path))
    clock = iter([5.0, 5.0, 6.2, 6.2])
    monkeypatch.setattr(quality.time, "monotonic", lambda: next(clock))
    desk.woke("Jarvis, lights on", "lights on")
    desk.state({"value": "thinking"})
    desk.state({"value": "speaking"})
    assert desk.wake == [1.2] and desk.public()["wake_median"] == 1.2
