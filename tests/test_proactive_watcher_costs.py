"""What the heads-up watcher (jarvis.proactive.Watcher) does again each minute, and what it
keeps: a meeting's files are looked up until they're announced, not for its whole half
hour, and the keys of what was said don't pile up while the app runs for weeks."""

from datetime import datetime, timedelta

from jarvis import fileindex
from jarvis.proactive import ANNOUNCED_DAYS, Alert, Watcher, event_key

NOW = datetime(2026, 9, 29, 14, 0)


def event(title, minutes, location="", id_=None):
    begin = NOW + timedelta(minutes=minutes)
    return {
        "title": title,
        "begin": begin,
        "end": begin + timedelta(hours=1),
        "location": location,
        "all_day": False,
        "id": id_ or title,
    }


def watcher(said, events, files=None, power=None):
    async def read():
        return list(events)

    async def eta(_where):
        return None

    return Watcher(
        said.append,
        events=read,
        eta=eta,
        battery=lambda: power,
        weather=lambda: None,
        files=files,
    )


async def test_a_meetings_files_are_looked_up_until_they_are_announced(monkeypatch):
    """Each look is a full-text search of the file index. Once the files were said, the
    meeting's other 29 minutes don't search again; one with nothing found still does."""
    board = event("Board review", 30, id_="e1")
    dentist = event("Dentist", 30, id_="e2")
    looked: list[str] = []

    def material(events, _index, now, ahead_minutes=fileindex.MEETING_AHEAD_MIN):
        found = []
        for e in events:
            if 0 < (e["begin"] - now).total_seconds() / 60 <= ahead_minutes:
                looked.append(e["id"])
                if e["id"] == "e1":
                    found.append((e, ["deck"]))
        return found

    monkeypatch.setattr(fileindex, "meeting_material", material)
    monkeypatch.setattr(fileindex, "prep_line", lambda title, *_a: f"Files for {title}.")

    async def files(events, now):  # the hub's own: fileindex.meeting_alerts
        return fileindex.meeting_alerts(events, None, now)

    said: list[Alert] = []
    w = watcher(said, [board, dentist], files)
    for minute in range(30):
        await w.tick(NOW + timedelta(minutes=minute))
    assert [a.text for a in said if a.kind == "files"] == ["Files for Board review."]
    assert looked.count("e1") == 1  # 30 searches before
    assert looked.count("e2") == 30  # nothing found yet: it's looked for again
    assert f"files:{event_key(board)}" in w.announced  # the index's own key


async def test_an_event_without_a_title_still_goes_to_the_index():
    seen = []

    async def files(events, _now):
        seen.append(list(events))
        return []

    odd = {"begin": NOW + timedelta(minutes=20), "all_day": False}
    w = watcher([], [odd], files)
    await w.tick(NOW)
    assert seen == [[odd]]


async def test_what_was_said_is_forgotten_once_it_cant_come_up_again():
    said: list[Alert] = []
    events = [event("Standup", 5, "Zoom")]
    power = {"percent": 4, "plugged": False}
    w = watcher(said, events, power=power)
    await w.tick(NOW)
    assert sorted(a.kind for a in said) == ["battery", "soon"]
    events.clear()
    for day in range(1, 30):  # a month of the app running
        events.append(event(f"Standup {day}", day * 24 * 60 + 5, "Zoom"))
        await w.tick(NOW + timedelta(days=day))
        events.clear()
    soon_keys = [k for k in w.announced if k.startswith("soon:")]
    assert len(soon_keys) <= ANNOUNCED_DAYS + 1  # not one a day for ever
    # The battery's key stays while it isn't charging: no second warning for the same low.
    assert "battery:5" in w.announced
    assert [a.kind for a in said].count("battery") == 1
    assert [a.kind for a in said].count("soon") == 30


async def test_a_key_is_still_said_once_within_its_days():
    said: list[Alert] = []
    standup = event("Standup", 5, "Zoom")
    w = watcher(said, [standup])
    for minute in range(5):
        await w.tick(NOW + timedelta(minutes=minute))
    assert [a.kind for a in said] == ["soon"]
