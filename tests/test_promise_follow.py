"""Closing the loop on promises (commitments.py, features/memory.py): a late one is said
once, a sent item that keeps one closes it, and a due one comes with an offer to help."""

from datetime import datetime, timedelta

from jarvis import commitments


def store(tmp_path):
    s = commitments.CommitmentStore(tmp_path / "commitments.json")
    s.load()
    return s


def test_a_promise_past_its_day_is_mentioned_once(tmp_path):
    s = store(tmp_path)
    promised = datetime(2026, 10, 3, 9, 0)
    item = s.add(
        "Send Ann the deck", to="Ann", due="2026-10-03", source="said", today=promised.date()
    )
    item.reminded = ["due"]
    today = promised + timedelta(days=2)
    assert s.due_reminders(today) == [(item, "late")]
    s.reminded(item, "late")
    assert s.due_reminders(today) == []
    assert s.due_reminders(today + timedelta(days=5)) == []
    assert s.due_reminders(promised) == []  # (its own day: the due reminder, said already)


def test_sending_what_was_promised_keeps_the_promise(tmp_path):
    s = store(tmp_path)
    item = s.add(
        "Send Ann the pitch deck", to="Ann", due="", source="message",
        sent="2026-10-01T10:00:00", handle="+1555", quote="I'll send you the pitch deck",
        today=datetime(2026, 10, 1).date(),
    )  # fmt: skip
    unrelated = commitments.Sent(
        "message", 2, "Ann", "+1555", "see you at lunch", datetime(2026, 10, 2)
    )
    other = commitments.Sent(
        "message", 3, "Bob", "+1666", "here's the pitch deck", datetime(2026, 10, 2)
    )
    kept = commitments.Sent(
        "message", 4, "Ann", "+1555", "Here's the pitch deck!", datetime(2026, 10, 2)
    )
    assert s.fulfilled([unrelated, other]) == []
    assert s.fulfilled([unrelated, kept]) == [(item, kept)]
