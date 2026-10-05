"""Stress round 1, stores: a file that parses but holds the wrong kind of value where a
number, a list or a section belongs (hand-edited, another build's, or a number past what a
float holds) never stops a store from opening or from being used, and the good records
beside it are still read."""

import json
from datetime import datetime

import pytest

from jarvis.claude_usage import UsageBook
from jarvis.conversation_state import ConversationState
from jarvis.features.chat_projects import ChatProjects
from jarvis.hearing import Hearing
from jarvis.session_store import SessionStore
from jarvis.timers import TimerStore, new_timer

HUGE = 10**400  # parses as a Python int; float() of it overflows
ODD = [HUGE, -HUGE, float("nan"), float("inf"), "x", [1], {"a": 1}, None, True]
IDS = ["huge", "-huge", "nan", "inf", "str", "list", "dict", "null", "true"]
NOON = datetime(2026, 9, 29, 12).timestamp()


def _write(path, data):
    path.write_text(json.dumps(data))  # NaN and Infinity as Python writes them


# ── hearing.json: made by the Hub itself, so a bad section stopped the app starting ──


@pytest.mark.parametrize("section", ["corrections", "words"])
@pytest.mark.parametrize("odd", ODD, ids=IDS)
def test_a_wrong_hearing_section_never_stops_the_app(tmp_path, section, odd):
    path = tmp_path / "hearing.json"
    good = {
        "corrections": {"jarvice": {"meant": "Jarvis", "count": 2}},
        "words": {"acme": {"word": "Acme", "count": 3}},
    }
    _write(path, {**good, section: odd})
    ear = Hearing(path, clock=lambda: 1000.0)
    other = "words" if section == "corrections" else "corrections"
    assert getattr(ear, other)  # the section that fits is still read


# ── usage.json: counted after every answer, so a bad day broke every answer's end ──


def _usage(n=10):
    return {"input_tokens": n, "output_tokens": n}


@pytest.mark.parametrize(
    "where", ["day", "cost", "requests", "input", "sources", "source", "models", "resets_at"]
)
@pytest.mark.parametrize("odd", ODD, ids=IDS)
def test_a_wrong_number_in_usage_never_stops_counting(tmp_path, where, odd):
    path = tmp_path / "usage.json"
    book = UsageBook(path, clock=lambda: NOON)
    book.record("jarvis", 0.5, _usage(), "claude-opus-5-5")
    book.plan({"five_hour": {"utilization": 0.5, "resets_at": NOON + 3600}})
    book.flush()
    data = json.loads(path.read_text())
    today = data["days"]["2026-09-29"]
    data["days"]["2026-09-28"] = json.loads(json.dumps(today))  # a good day beside it
    if where == "day":
        data["days"]["2026-09-29"] = odd
    elif where in ("cost", "requests", "input", "sources", "models"):
        today[where] = odd
    elif where == "source":
        today["sources"]["jarvis"] = odd
    else:
        data["limits"]["five_hour"]["resets_at"] = odd
    _write(path, data)
    book = UsageBook(path, clock=lambda: NOON)
    book.summary()
    book.record("jarvis", 0.25, _usage(), "claude-opus-5-5")  # the next answer counts
    summary = book.summary()
    assert summary["session"]["requests"] == 1
    assert summary["week"]["requests"] >= 2  # yesterday's good day, and this answer
    book.flush()
    assert UsageBook(path, clock=lambda: NOON).summary()["week"]["requests"] >= 2


# ── conversation.json, timers.json, kept Jarvis Code sessions: a number past a float ──


def test_a_conversation_cost_past_a_float_is_no_cost(tmp_path):
    path = tmp_path / "conversation.json"
    _write(
        path,
        {
            "current": "abc123",
            "sessions": {
                "abc123": {"cost": HUGE, "at": "2026-09-29T12:00:00", "title": "Hi"},
                "def456": {"cost": 0.5, "at": "2026-09-29T11:00:00", "title": "Yo"},
            },
        },
    )
    state = ConversationState(path)
    assert state.cost_of("abc123") == 0.0 and state.cost_of("def456") == 0.5
    state.save()


@pytest.mark.parametrize(
    "field, odd, running",
    [
        ("at", HUGE, ["pasta", "tea"]),  # no instant: its time on the wall decides
        ("at", -HUGE, ["pasta", "tea"]),
        ("due", "0001-01-01T00:00:00", ["tea"]),  # parses; this Mac's clock can't place it
        ("due", "0001-01-01T00:00:01", ["tea"]),
    ],
    ids=["at-huge", "at-minus-huge", "due-year-1", "due-year-1-and-a-second"],
)
def test_a_timer_row_past_the_clock_never_stops_the_rest(tmp_path, field, odd, running):
    now = datetime(2026, 9, 29, 12)
    path = tmp_path / "timers.json"
    store = TimerStore(path)
    store.add(new_timer(600, "pasta", now))
    store.add(new_timer(60, "tea", now))
    rows = json.loads(path.read_text())
    rows[0][field] = odd
    if field == "due":
        rows[0]["at"] = 0.0
    _write(path, rows)
    store = TimerStore(path)
    assert [t.label for t in store.items] == running
    assert store.next_due() is not None
    for timer in store.items:
        timer.public(now), timer.describe(now)
    store.save()  # the row it couldn't use is kept in the file as it was
    assert len(json.loads(path.read_text())) == 2


def test_a_kept_session_cost_past_a_float_still_opens(tmp_path):
    record = {"cwd": "/tmp/x", "cost_usd": HUGE, "created": "2026-09-29T12:00:00"}
    _write(tmp_path / "abcdef12.json", record)
    [kept] = SessionStore(tmp_path).load()
    assert kept["cost_usd"] is None and kept["cwd"] == "/tmp/x"


# ── chat-projects.json: a bad field lost the feature until the file was mended ──


class _Hub:
    def emit(self, *_args, **_kw):
        pass


@pytest.mark.parametrize(
    "where", ["projects", "files", "file", "chars", "added", "created", "sessions"]
)
@pytest.mark.parametrize("odd", ODD, ids=IDS)
def test_a_wrong_field_in_chat_projects_never_loses_the_rest(tmp_path, where, odd):
    good = {
        "id": "p1",
        "name": "Taxes",
        "files": [{"name": "a.txt", "chars": 10, "added": 5}],
        "sessions": ["abc123"],
        "created": 5,
    }
    bad = json.loads(json.dumps({**good, "id": "p2", "name": "Odd"}))
    if where in ("files", "created", "sessions"):
        bad[where] = odd
    elif where == "file":
        bad["files"][0] = odd
    elif where in ("chars", "added"):
        bad["files"][0][where] = odd
    projects = odd if where == "projects" else [good, bad]
    _write(tmp_path / "chat-projects.json", {"active": "p1", "projects": projects})
    chats = ChatProjects(_Hub(), folder=tmp_path)
    if where != "projects":
        assert chats.find("p1") == {**good, "instructions": ""}
        assert chats.active == "p1"
    chats._save()


# ── a file there that can't be read now (its permissions, a disk error) is never saved over ──


@pytest.fixture
def locked(tmp_path):
    """A file made unreadable (mode 000) for the test, and readable again after it."""
    made = []

    def lock(path):
        path.chmod(0)
        made.append(path)
        return path

    yield lock
    for path in made:
        path.chmod(0o600)


def test_chat_projects_it_cant_read_are_never_saved_over(tmp_path, locked):
    path = tmp_path / "chat-projects.json"
    _write(path, {"active": "", "projects": [{"id": "p1", "name": "Taxes"}]})
    before = path.read_bytes()
    chats = ChatProjects(_Hub(), folder=tmp_path)
    assert chats.find("p1")
    locked(path)
    chats = ChatProjects(_Hub(), folder=tmp_path)
    with pytest.raises(OSError, match="can't be read"):
        chats.save({"name": "Holiday"})
    for _ in range(2):  # two saves: the copy kept beside it would be gone too
        with pytest.raises(OSError):
            chats._save()
    path.chmod(0o600)
    assert path.read_bytes() == before


def test_usage_it_cant_read_is_never_saved_over(tmp_path, locked):
    path = tmp_path / "usage.json"
    book = UsageBook(path, clock=lambda: NOON)
    book.record("jarvis", 0.5, _usage(), "claude-opus-5-5")
    book.flush()
    before = path.read_bytes()
    locked(path)
    now = [NOON]
    book = UsageBook(path, clock=lambda: now[0])
    for _ in range(3):
        now[0] += 60
        book.record("jarvis", 0.25, _usage(), "claude-opus-5-5")  # counted, in memory
        book.flush()
    assert book.summary()["session"]["requests"] == 3
    path.chmod(0o600)
    assert path.read_bytes() == before


def test_kept_session_settings_it_cant_read_are_never_saved_over(tmp_path, locked):
    store = SessionStore(tmp_path)
    store.save_remembered({"s1": {"mode": "plan"}})
    path = tmp_path / "remembered.json"
    before = path.read_bytes()
    locked(path)
    store = SessionStore(tmp_path)
    assert store.load_remembered() == {}
    for _ in range(2):
        with pytest.raises(OSError, match="can't be read"):
            store.save_remembered({"s2": {"mode": "ask"}})
    path.chmod(0o600)
    assert path.read_bytes() == before


def test_a_session_that_stops_the_reading_never_costs_the_others_their_files(tmp_path, monkeypatch):
    """Kept sessions read before one that stops the reading (a field no check foresaw) were
    taken as listed, and the next save let go of their files as no longer listed."""
    from jarvis import session_store

    store = SessionStore(tmp_path)
    keys = ["aaaaaaaa", "bbbbbbbb"]
    store.save({k: {"cwd": "/tmp/x", "created": "2026-09-29T12:00:00"} for k in keys}, set(keys))
    clean = session_store.clean_record

    def trips(data, key):
        if key == "bbbbbbbb":
            raise RuntimeError("a field no check foresaw")
        return clean(data, key)

    monkeypatch.setattr(session_store, "clean_record", trips)
    store = SessionStore(tmp_path)
    with pytest.raises(RuntimeError):
        store.load()  # code_sessions logs it and starts with no sessions listed
    store.save({"cccccccc": {"cwd": "/tmp/y"}}, {"cccccccc"})
    assert all((tmp_path / f"{k}.json").exists() for k in keys)
