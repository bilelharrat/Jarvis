"""Eden Code on the phone, the calls the native iPhone app adds (features/_code_phone_routes.py,
2026-10-16): a session's changes as the window's pane shows them, Keep and Undo (one hunk or
Undo all), line comments sent as one message, the turns' receipts without pictures, steering
into the running step, the to-do column and starting a card (never in Auto or Bypass), and the
usage glance. Every one behind the device token and the owner's switch, like the rest. Real
git in temp repositories (test_code_changes' Session), the phone through Starlette's client."""

from __future__ import annotations

import pytest
from test_code_changes import Session, make_repo, numbered
from test_code_phone import phone  # noqa: F401 (the fixture)
from test_companion_api import api, session  # noqa: F401 (the fixture)
from test_companion_push import ready, settle, setup  # noqa: F401 (the fixture)

from jarvis.features._code_phone_routes import OFF

GETS = [
    "/api/code/phone/changes?id=5",
    "/api/code/phone/receipts?id=5",
    "/api/code/phone/todos",
    "/api/code/phone/usage",
]
POSTS = [
    "/api/code/phone/hunk",
    "/api/code/phone/comments",
    "/api/code/phone/steer",
    "/api/code/phone/todo_start",
]


def edited(hub, tmp_path):
    folder = make_repo(tmp_path / "proj", {"a.py": numbered(40)})
    s = Session(hub.tasks, folder, task_id=5)
    s.turn("u-1")
    s.edit(folder / "a.py", "line 5\n", "line five\n")
    s.edit(folder / "a.py", "line 30\n", "line thirty\n")
    return s.task, folder


def test_the_apps_calls_need_the_token_and_the_switch(api, tmp_path):  # noqa: F811
    session(api.hub, 5, tmp_path / "alpha")
    for path in GETS:
        assert api.client.get(path).status_code == 401, path
    for path in POSTS:
        assert api.client.post(path, json={"id": 5}).status_code == 401, path
    for path in GETS:
        reply = api.get(path)
        assert reply.status_code == 403 and reply.json() == {"error": OFF, "off": True}, path
    for path in POSTS:
        assert api.post(path, {"id": 5}).status_code == 403, path


def test_changes_keep_undo_and_undo_all(phone, tmp_path):  # noqa: F811
    task, folder = edited(phone.hub, tmp_path)
    view = phone.get("/api/code/phone/changes?id=5&view=session").json()
    assert view["git"] is True and view["totals"]["hunks"] == 2
    hunks = view["files"][0]["hunks"]
    assert [h["n"] for h in hunks] == [1, 2] and ["+", "line five"] in hunks[0]["lines"]

    kept = phone.post("/api/code/phone/hunk", {"id": 5, "hunk": hunks[1]["id"], "action": "keep"})
    assert kept.json()["ok"] is True
    assert kept.json()["changes"]["files"][0]["hunks"][1]["kept"] is True

    undone = phone.post("/api/code/phone/hunk", {"id": 5, "hunk": hunks[0]["id"], "action": "undo"})
    assert undone.json()["ok"] is True and undone.json()["said"] == "Undid 1 change."
    assert "line 5\n" in (folder / "a.py").read_text()
    again = phone.post("/api/code/phone/hunk", {"id": 5, "hunk": hunks[0]["id"], "action": "undo"})
    assert again.json()["ok"] is False and "isn't there" in again.json()["said"]

    # Undo all: every hunk at once.
    left = [h["id"] for h in undone.json()["changes"]["files"][0]["hunks"]]
    all_gone = phone.post("/api/code/phone/hunk", {"id": 5, "hunks": left, "action": "undo"})
    assert (
        all_gone.json()["ok"] is True and all_gone.json()["changes"]["totals"].get("hunks", 0) == 0
    )
    assert "line thirty" not in (folder / "a.py").read_text()

    assert (
        phone.post("/api/code/phone/hunk", {"id": 5, "hunk": "x", "action": "delete"}).status_code
        == 400
    )
    assert (
        phone.post("/api/code/phone/hunk", {"id": 99, "hunk": "x", "action": "keep"}).status_code
        == 404
    )
    assert phone.get("/api/code/phone/changes?id=99").status_code == 404


def test_line_comments_go_to_the_session_as_one_message(phone, tmp_path, monkeypatch):  # noqa: F811
    session(phone.hub, 5, tmp_path / "alpha")
    sent = []
    monkeypatch.setattr(
        phone.hub.tasks, "send", lambda tid, text, **kw: sent.append((tid, text, kw)) or True
    )
    reply = phone.post(
        "/api/code/phone/comments",
        {
            "id": 5,
            "comments": [
                {"path": "a.py", "line": 5, "excerpt": "line five", "text": "use a constant"},
                {"path": "b.py", "line": 2, "side": "o", "text": "keep this"},
            ],
        },
    )
    assert reply.json() == {"ok": True}
    assert sent[0][0] == 5 and sent[0][1].startswith("Review comments:")
    assert "a.py:5 (`line five`) — use a constant" in sent[0][1]
    assert "b.py (removed line 2) — keep this" in sent[0][1]
    bad = phone.post("/api/code/phone/comments", {"id": 5, "comments": [{"path": "a.py"}]})
    assert bad.status_code == 400 and len(sent) == 1


def test_receipts_come_without_pictures(phone, tmp_path):  # noqa: F811
    task = session(phone.hub, 5, tmp_path / "alpha")
    task.transcript = [
        {"n": 1, "role": "user", "text": "fix it", "at": ""},
        {
            "n": 2,
            "role": "note",
            "text": "Proof · Changed 2 files",
            "at": "2026-10-16T10:00:00",
            "receipt": {
                "files": ["a.py", "b.py"],
                "file_count": 2,
                "risk": "low",
                "why": "small, tested change",
                "tests": {"passed": True, "passed_count": 41, "state": "passed"},
                "check": {
                    "status": "ok",
                    "text": "Looks right",
                    "thumb": "data:image/png;base64,AAAA",
                },
                "selfcheck": {"verdict": "pass", "headline": "Checked", "image": "AAAA"},
            },
        },
    ]
    found = phone.get("/api/code/phone/receipts?id=5").json()
    assert found["id"] == 5 and len(found["receipts"]) == 1
    receipt = found["receipts"][0]
    assert receipt["i"] == 2 and receipt["text"].startswith("Proof")
    assert receipt["receipt"]["tests"]["passed_count"] == 41
    assert (
        "thumb" not in receipt["receipt"]["check"]
        and "image" not in receipt["receipt"]["selfcheck"]
    )


def test_steer_goes_into_the_running_step(phone, tmp_path, monkeypatch):  # noqa: F811
    session(phone.hub, 5, tmp_path / "alpha")
    sent = []
    monkeypatch.setattr(
        phone.hub.tasks, "send", lambda tid, text, **kw: sent.append((tid, text, kw)) or True
    )
    assert (
        phone.post("/api/code/phone/steer", {"id": 5, "text": "use the other API"}).json()["ok"]
        is True
    )
    assert sent == [(5, "use the other API", {"steer": True})]
    assert phone.post("/api/code/phone/steer", {"id": 5, "text": "  "}).status_code == 400


@pytest.fixture
def cards(phone, tmp_path):  # noqa: F811
    todo = phone.hub.code_todo
    folder = tmp_path / "alpha"
    folder.mkdir()
    safe = todo.add(str(folder), {"prompt": "add a dark mode", "mode": "edits"})
    risky = todo.add(str(folder), {"prompt": "rewrite the build", "mode": "auto"})
    return phone, todo, safe, risky


def test_the_todo_column_and_its_queues(cards):
    phone, _todo, safe, risky = cards  # noqa: F811
    found = phone.get("/api/code/phone/todos").json()
    ids = [c["id"] for c in found["cards"]]
    assert safe["id"] in ids and risky["id"] in ids
    one = next(c for c in found["cards"] if c["id"] == safe["id"])
    assert one["project"] == "alpha" and one["mode"] == "edits" and one["state"] == "todo"
    assert isinstance(found["queues"], dict)


def test_a_card_never_starts_in_bypass_from_the_phone(cards, monkeypatch, tmp_path):
    phone, todo, safe, risky = cards  # noqa: F811
    started = []

    async def start(card, **_kw):
        started.append(card["id"])
        return session(phone.hub, 42, tmp_path / "alpha")

    monkeypatch.setattr(todo, "start", start)
    refused = phone.post("/api/code/phone/todo_start", {"card": risky["id"]})
    assert refused.status_code == 403 and "on your Mac" in refused.json()["error"]
    assert started == []
    reply = phone.post("/api/code/phone/todo_start", {"card": safe["id"]})
    assert reply.json() == {"ok": True, "id": 42} and started == [safe["id"]]
    assert todo.board.get(safe["id"])["state"] == "started"
    assert phone.post("/api/code/phone/todo_start", {"card": "nope"}).status_code == 404


def test_a_card_with_no_mode_follows_a_safe_default_only(cards, monkeypatch, tmp_path):
    phone, todo, _safe, _risky = cards  # noqa: F811
    plain = todo.add(str(tmp_path / "alpha"), {"prompt": "tidy the README"})
    monkeypatch.setattr(todo, "start", lambda card, **_kw: None)
    phone.hub.prefs.code_mode = "auto"  # (everyone's default is Bypass: not from the phone)
    assert phone.post("/api/code/phone/todo_start", {"card": plain["id"]}).status_code == 403


def test_the_usage_glance(phone, monkeypatch):  # noqa: F811
    meter = phone.hub.code_usage
    monkeypatch.setattr(
        meter,
        "public",
        lambda: {
            "today": 3.25,
            "defaults": {"day": 20.0, "session": 0, "project": 0},
            "recent": [{"day": f"2026-10-{d:02d}", "total": 1.0, "turns": 2} for d in range(1, 15)],
            "by_project": [{"project": "alpha", "total": 3.25}],
            "windows": [{"kind": "five_hour", "percent": 42}],
        },
    )
    found = phone.get("/api/code/phone/usage").json()
    assert found["today"] == 3.25 and found["day_cap"] == 20.0
    assert len(found["recent"]) == 7 and found["windows"][0]["percent"] == 42
