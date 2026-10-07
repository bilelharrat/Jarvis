"""Jarvis's quality numbers (features/quality.py): answer time, crash-free days, lost chats
and heads-ups a day, kept across runs."""

import json
from datetime import date
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


def test_a_save_with_nothing_new_writes_nothing_but_a_change_or_a_lost_file_does(
    tmp_path, monkeypatch
):
    """The keeper saves every ten minutes: with nothing new (an idle night) the file isn't
    written and flushed again, but anything new is, and so is a file that went missing or
    was changed on disk since."""
    from jarvis import jsonstore

    writes = []
    real = jsonstore.save_json
    monkeypatch.setattr(
        jsonstore,
        "save_json",
        lambda path, data, **kw: (writes.append(path), real(path, data, **kw)),
    )
    desk = quality.Quality(hub(tmp_path))
    desk.headsup(NS(kind="rain"))
    desk.save()
    assert len(writes) == 1
    desk.save()
    desk.save()
    assert len(writes) == 1  # nothing new
    desk.headsup(NS(kind="rain"))
    desk.save()
    assert len(writes) == 2
    kept = (tmp_path / "quality.json").read_text()
    (tmp_path / "quality.json").unlink()
    desk.save()
    assert len(writes) == 3 and (tmp_path / "quality.json").read_text() == kept
    (tmp_path / "quality.json").write_text("{}")  # changed behind its back
    desk.save()
    assert len(writes) == 4 and (tmp_path / "quality.json").read_text() == kept
    again = quality.Quality(hub(tmp_path))
    assert again.kinds == {"rain": {"shown": 2, "opened": 0, "dismissed": 0}}


def test_an_odd_file_starts_those_numbers_afresh_never_failing(tmp_path):
    """Each field read for what it must be: one a hand edit (or another build) left as
    something else starts empty, and the feature still installs and the pane still reads
    (a word for a number, a list for the days, a date that isn't one, stopped both)."""
    (tmp_path / "quality.json").write_text(
        json.dumps(
            {
                "latency": "fast",
                "wake": [1.5, "x", None, [2]],
                "days": [["2026-10-01", {"crashes": 1}]],
                "since": "last week",
                "lost": None,
                "chat_keys": "abc",
                "kinds": {"rain": 5, "mail": {"shown": "3"}},
                "quiet": [7, "rain"],
                "unquiet": {},
            }
        )
    )
    desk = quality.Quality(hub(tmp_path))
    assert desk.latency == [] and desk.wake == [1.5] and desk.days == {}
    assert desk.since == date.today().isoformat() and desk.lost == 0 and desk.known == []
    assert desk.kinds == {"mail": {"shown": 3}} and desk.quiet == ["rain"] and desk.unquiet == []
    desk.started()
    assert desk.public()["lost_chats"] == 0 and desk.public()["crash_free_days"] == 1
