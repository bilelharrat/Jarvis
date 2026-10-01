"""Jarvis Code from the phone (companion_code.py): new sessions, and the window's own commands
for a session, from an allowlist only."""

from __future__ import annotations

import asyncio

from test_companion_api import api, session  # noqa: F401 (the fixture)

from jarvis import companion_code


def test_options_say_what_a_new_session_can_be(api):  # noqa: F811
    found = api.get("/api/code/options").json()
    assert [m["ref"] for m in found["models"]][:3] == ["opus", "sonnet", "haiku"]
    assert [m["id"] for m in found["modes"]] == ["plan", "ask", "edits", "smart", "auto"]
    assert found["efforts"][0] == "low" and "projects" in found
    assert found["defaults"]["mode"]


def test_a_new_session_starts_as_the_composer_starts_one(api, tmp_path, monkeypatch):  # noqa: F811
    started = []

    def start(prompt, directory, **kw):
        task = session(api.hub, 42, tmp_path / "alpha")
        started.append((prompt, directory, kw["mode"], kw["images"]))
        return task

    monkeypatch.setattr(api.hub.tasks, "start", start)
    picture = {"media_type": "image/png", "data": "iVBORw0KGgo=", "name": "shot.png"}
    reply = api.post(
        "/api/code/new",
        {"prompt": "fix the login bug", "directory": "alpha", "mode": "plan", "images": [picture]},
    ).json()
    assert reply == {"ok": True, "id": 42}
    assert started == [("fix the login bug", "alpha", "plan", [picture])]
    assert api.post("/api/code/new", {"prompt": "", "directory": "alpha"}).status_code == 400


def test_a_session_that_cant_start_says_why(api, monkeypatch):  # noqa: F811
    def start(prompt, directory, **kw):
        raise ValueError("'~' is too broad for a project; pick a project folder.")

    monkeypatch.setattr(api.hub.tasks, "start", start)
    reply = api.post("/api/code/new", {"prompt": "x", "directory": "~"})
    assert reply.status_code == 400 and "too broad" in reply.json()["error"]


def test_only_listed_actions_go_through(api, tmp_path):  # noqa: F811
    session(api.hub, 5, tmp_path / "alpha")
    assert api.post("/api/code/action", {"id": 5, "action": "cw_term_new"}).json() == {
        "error": "not something the phone can do"
    }
    assert api.post("/api/code/action", {"id": 99, "action": "mode"}).status_code == 404


def test_settings_go_to_the_session(api, tmp_path, monkeypatch):  # noqa: F811
    task = session(api.hub, 5, tmp_path / "alpha")
    modes, names = [], []
    monkeypatch.setattr(api.hub.tasks, "set_mode", lambda tid, mode: modes.append((tid, mode)))
    monkeypatch.setattr(api.hub.tasks, "rename", lambda tid, title: names.append((tid, title)))
    assert api.post("/api/code/action", {"id": 5, "action": "mode", "mode": "edits"}).json() == {
        "ok": True
    }
    api.post("/api/code/action", {"id": 5, "action": "rename", "title": "Login fix", "extra": 1})
    assert modes == [(5, "edits")] and names == [(5, "Login fix")]
    assert task.id == 5


def test_a_bang_command_answers_with_its_own_output(api, tmp_path, monkeypatch):  # noqa: F811
    session(api.hub, 5, tmp_path / "alpha")

    async def task_bash(msg):
        api.hub.emit("task_bash", ref="someone-elses", command="ls", output="other", code=0)
        api.hub.emit("task_bash", ref=msg["ref"], command=msg["command"], output="ok\n", code=0)

    monkeypatch.setattr(api.hub, "task_bash", task_bash)
    real = api.hub.handle

    async def handle(msg):
        if msg.get("type") == "task_bash":
            return await task_bash(msg)
        return await real(msg)

    monkeypatch.setattr(api.hub, "handle", handle)
    reply = api.post("/api/code/action", {"id": 5, "action": "bash", "command": "echo ok"}).json()
    assert reply["task_bash"]["output"] == "ok\n" and reply["task_bash"]["command"] == "echo ok"


def test_the_desk_gathers_the_answering_events(api):  # noqa: F811
    desk = api.hub.phone_code_desk

    async def go():
        async def handle(_msg):
            api.hub.emit("caption", text="Committed abc123.")

        api.hub.handle = handle
        return await desk.run({"type": "code_git_commit"}, ("code_git_committed", "caption"), 2)

    heard = asyncio.run(go())
    assert heard == [{"type": "caption", "text": "Committed abc123."}]
    assert desk.waiting == []


def test_a_question_card_says_how_it_can_be_answered():
    card = {
        "id": "a1",
        "question": "Which database?",
        "choices": [{"id": "opt0", "label": "Postgres"}, {"id": "skip", "label": "Skip"}],
        "task_id": 5,
        "ask_kind": "question",
        "multi": True,
        "options": [{"label": "Postgres", "description": "Relational"}],
        "free_choices": ["pick", "other"],
    }
    from jarvis.companion_api import public_approval

    shown = public_approval(card)
    assert shown["multi"] is True and shown["free_choices"] == ["pick", "other"]
    assert shown["options"] == [{"label": "Postgres", "description": "Relational"}]
    assert companion_code.ACTIONS["bash"].by_ref
