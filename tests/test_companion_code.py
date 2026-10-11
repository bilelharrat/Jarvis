"""Eden Code from the phone (companion_code.py): new sessions, and the window's own commands
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


def test_a_long_prompt_from_the_phone_is_refused_or_sent_whole(api, tmp_path, monkeypatch):  # noqa: F811
    """CA3-2 (bug sweep r3): /api/code/new cut the prompt at 20,000 and answered ok. Now
    past a session's limit it's refused with why (413); under it, it goes whole."""
    from jarvis.tasks import MESSAGE_MAX

    started = []

    def start(prompt, directory, **kw):
        started.append(prompt)
        return session(api.hub, 42, tmp_path / "alpha")

    monkeypatch.setattr(api.hub.tasks, "start", start)
    reply = api.post("/api/code/new", {"prompt": "x" * (MESSAGE_MAX + 1), "directory": "alpha"})
    assert reply.status_code == 413 and "100,001 characters" in reply.json()["error"]
    assert started == []
    whole = "y" * 50_000 + "END"
    assert api.post("/api/code/new", {"prompt": whole, "directory": "alpha"}).json()["ok"]
    assert started == [whole]
    task = session(api.hub, 5, tmp_path / "alpha")
    reply = api.post(
        "/api/code/action", {"id": task.id, "action": "command", "text": "z" * (MESSAGE_MAX + 1)}
    )
    assert reply.status_code == 413


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


def test_a_bang_command_and_bypass_are_refused_from_the_phone(api, tmp_path, monkeypatch):  # noqa: F811
    """CD5 (bug sweep r1): the phone's token alone was a shell on the Mac ("!" commands,
    Bypass permissions, a new session in Bypass). They wait for a Face ID-backed proof."""
    task = session(api.hub, 5, tmp_path / "alpha")
    ran = []
    real = api.hub.handle

    async def handle(msg):
        ran.append(msg.get("type"))
        return await real(msg)

    monkeypatch.setattr(api.hub, "handle", handle)
    marker = tmp_path / "alpha" / "PHONE_BANG"
    reply = api.post("/api/code/action", {"id": 5, "action": "bash", "command": f"touch '{marker}'"})
    assert reply.status_code == 403 and "can't be run from the phone" in reply.json()["error"]
    reply = api.post("/api/code/action", {"id": 5, "action": "mode", "mode": "auto"})
    assert reply.status_code == 403 and task.mode != "auto"
    reply = api.post(
        "/api/code/new", {"prompt": "x", "directory": str(tmp_path / "alpha"), "mode": "auto"}
    )
    assert reply.status_code == 403
    assert ran == [] and not marker.exists()
    # "/bypass" typed on the phone reaches voice coding's mode switch: refused there too.
    api.post("/api/code/action", {"id": 5, "action": "command", "text": "/bypass"})
    assert task.mode != "auto"
    # ... and a new session that would start in Bypass by the owner's default.
    api.hub.prefs.code_mode = "auto"
    reply = api.post("/api/code/new", {"prompt": "x", "directory": str(tmp_path / "alpha")})
    assert reply.status_code == 400 and "phone" in reply.json()["error"]
    assert [t.mode for t in api.hub.tasks.tasks.values()] == [task.mode]
    api.hub.prefs.code_mode = "ask"


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


def test_files_and_a_file_come_from_the_real_window_commands(api, tmp_path):  # noqa: F811
    projects = api.hub.tasks.settings.projects_dir
    folder = projects / "alpha"
    (folder / "src").mkdir(parents=True, exist_ok=True)
    (folder / "src" / "app.py").write_text("print('hi')\n")
    session(api.hub, 7, folder)
    files = api.post("/api/code/action", {"id": 7, "action": "files"}).json()
    assert "src/app.py" in files["project_files"]["files"]
    one = api.post("/api/code/action", {"id": 7, "action": "file", "path": "src/app.py"}).json()
    assert one["file_content"]["text"] == "print('hi')\n"
    secret = api.post(
        "/api/code/action", {"id": 7, "action": "file", "path": "../../etc/passwd"}
    ).json()
    assert secret["file_content"].get("error")


def test_git_state_stage_and_commit_from_the_phone(api):  # noqa: F811
    import subprocess

    folder = api.hub.tasks.settings.projects_dir / "beta"
    folder.mkdir(parents=True, exist_ok=True)
    run = lambda *a: subprocess.run(["git", *a], cwd=folder, check=True, capture_output=True)  # noqa: E731
    run("init", "-b", "main")
    run("config", "user.email", "t@example.com")
    run("config", "user.name", "T")
    (folder / "a.txt").write_text("one\n")
    run("add", "a.txt")
    run("commit", "-m", "first")
    (folder / "a.txt").write_text("two\n")
    session(api.hub, 8, folder)
    state = api.post("/api/code/action", {"id": 8, "action": "git"}).json()["code_git"]
    assert state["branch"] == "main" and [f["path"] for f in state["unstaged"]] == ["a.txt"]
    staged = api.post("/api/code/action", {"id": 8, "action": "stage", "all": True}).json()[
        "code_git"
    ]
    assert [f["path"] for f in staged["staged"]] == ["a.txt"]
    done = api.post("/api/code/action", {"id": 8, "action": "commit", "message": "Second"}).json()
    assert done.get("code_git_committed", {}).get("sha") or "ommit" in done.get("said", "")
    log = subprocess.run(
        ["git", "log", "--format=%s"], cwd=folder, capture_output=True, text=True
    ).stdout
    assert log.splitlines()[0] == "Second"
