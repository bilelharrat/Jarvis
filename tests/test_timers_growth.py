"""What the timers keep while the app runs for weeks (jarvis.timers): the ones that rang
are remembered for a snooze only as long as one can still be asked for."""

from datetime import datetime, timedelta

from jarvis import timers as tk

NOW = datetime(2026, 9, 29, 15, 30, 0)


class Clock:
    def __init__(self, at=NOW):
        self.at = at

    def __call__(self):
        return self.at


def make(tmp_path, clock):
    heard = []
    timers = tk.Timers(
        tmp_path / "timers.json",
        lambda alert, busy: heard.append((alert, busy)),
        now=clock,
        play=lambda _sound: None,  # no event loop here: said and shown, never rung
    )
    return timers, heard


def test_what_rang_long_ago_isnt_kept_for_ever(tmp_path):
    clock = Clock()
    timers, heard = make(tmp_path, clock)
    for day in range(40):  # a timer a day for weeks
        clock.at = NOW + timedelta(days=day)
        timers.add(tk.new_timer(60, f"tea {day}", clock.at))
        clock.at += timedelta(seconds=61)
        timers.fire_due(clock.at)
    assert len(heard) == 40
    assert [t.label for t, _at in timers.recent.values()] == ["tea 39"]


def test_one_that_just_rang_can_still_be_snoozed(tmp_path):
    clock = Clock()
    timers, _heard = make(tmp_path, clock)
    timers.add(tk.new_timer(60, "pasta", NOW))
    timers.add(tk.new_timer(120, "rice", NOW))
    clock.at = NOW + timedelta(seconds=61)
    timers.fire_due(clock.at)
    clock.at = NOW + timedelta(seconds=121)
    timers.fire_due(clock.at)  # the pasta's still recent: a minute ago
    assert sorted(t.label for t, _at in timers.recent.values()) == ["pasta", "rice"]
    clock.at += timedelta(minutes=5)
    assert sorted(t.label for t in timers.snooze()) == ["pasta", "rice"]
