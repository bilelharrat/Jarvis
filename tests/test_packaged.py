"""The backend bundled inside the downloadable app (packaged.py, jarvis/__main__.py): it finds
the app's own node_modules and icon where the app says (JARVIS_APP_DIR), knows it's bundled
by where its Python lives, and starts as `python -m jarvis serve`. From the repo, all of it
is as before."""

import subprocess
import sys
from pathlib import Path

from jarvis import packaged, server

REPO_APP = Path(__file__).resolve().parents[1] / "app"


def test_the_app_folder_is_the_repos_unless_the_app_names_its_own(monkeypatch, tmp_path):
    monkeypatch.delenv(packaged.APP_DIR_ENV, raising=False)
    assert packaged.app_dir() == REPO_APP
    monkeypatch.setenv(packaged.APP_DIR_ENV, str(tmp_path / "Resources" / "app"))
    assert packaged.app_dir() == tmp_path / "Resources" / "app"
    monkeypatch.setenv(packaged.APP_DIR_ENV, "  ")
    assert packaged.app_dir() == REPO_APP


def test_the_terminal_and_hand_tracking_scripts_come_from_the_app_folder():
    assert server.XTERM_DIR == packaged.app_dir() / "node_modules" / "@xterm"
    assert server.VISION_DIR == packaged.app_dir() / "node_modules" / "@mediapipe" / "tasks-vision"


def test_the_companion_icon_is_the_app_folders(monkeypatch, tmp_path):
    from starlette.testclient import TestClient

    from jarvis.remote import Devices, create_remote_app

    class Hub:
        speaker = None

        def emit(self, *_a, **_k):
            pass

    app_dir = tmp_path / "Resources" / "app"
    (app_dir / "build").mkdir(parents=True)
    (app_dir / "build" / "icon-1024.png").write_bytes(b"\x89PNG the app's icon")
    monkeypatch.setenv(packaged.APP_DIR_ENV, str(app_dir))
    client = TestClient(create_remote_app(Hub(), Devices(tmp_path / "devices.json")))
    got = client.get("/icon.png")
    assert got.status_code == 200 and got.content == b"\x89PNG the app's icon"
    monkeypatch.setenv(packaged.APP_DIR_ENV, str(tmp_path / "nowhere"))
    assert client.get("/icon.png").status_code == 404


def test_bundled_is_told_by_where_python_lives():
    assert packaged.is_packaged("/Applications/J.A.R.V.I.S.app/Contents/Resources/backend/python")
    assert packaged.is_packaged(
        "/Users/x/Applications/Some Name.app/Contents/Resources/backend/python"
    )
    assert not packaged.is_packaged("/Users/x/jarvis/.venv")
    assert not packaged.is_packaged("/Applications/J.A.R.V.I.S.app/Contents/Resources/other/python")
    assert not packaged.is_packaged()  # the tests' own Python is a venv


def test_python_dash_m_jarvis_is_the_jarvis_command():
    done = subprocess.run(
        [sys.executable, "-m", "jarvis", "--help"], capture_output=True, text=True, timeout=120
    )
    assert done.returncode == 0, done.stderr
    assert "serve" in done.stdout and done.stdout.startswith("usage: jarvis")


# ── what the owner's own tools inherit from the backend ──

LAUNCHED = {
    "JARVIS_TOKEN": "launch-token",
    "PYTHONNOUSERSITE": "1",
    "PYTHONDONTWRITEBYTECODE": "1",
    "JARVIS_HELPERS_DIR": "/Applications/J.A.R.V.I.S.app/Contents/Resources/helpers",
    "JARVIS_APP_DIR": "/Applications/J.A.R.V.I.S.app/Contents/Resources/app.asar.unpacked",
    "DISABLE_AUTOUPDATER": "1",
    "HOME": "/Users/owner",
    "PATH": "/opt/homebrew/bin:/usr/bin:/bin",
}


def test_the_launch_token_leaves_the_backend_s_environment():
    environ = dict(LAUNCHED)
    assert packaged.take_token(environ) == "launch-token"
    assert "JARVIS_TOKEN" not in environ  # nothing the backend starts inherits it
    assert packaged.take_token(environ) == ""  # (a manual run: none given)


def test_the_owner_s_tools_never_inherit_jarvis_s_own_settings():
    bundled = packaged.owner_env(LAUNCHED, packaged=True)
    assert bundled == {"HOME": "/Users/owner", "PATH": "/opt/homebrew/bin:/usr/bin:/bin"}
    # Run from the repo, those settings (bar the token) are the owner's own and stay.
    repo = packaged.owner_env(LAUNCHED, packaged=False)
    assert "JARVIS_TOKEN" not in repo
    assert repo["PYTHONNOUSERSITE"] == "1" and repo["DISABLE_AUTOUPDATER"] == "1"
    # A Claude Code session's commands: the launcher's settings blanked (an empty one is no
    # setting), while the engine itself keeps never updating inside the signed app.
    blanked = packaged.session_env(LAUNCHED, packaged=True)
    assert blanked == {k: "" for k in packaged.LAUNCH_ONLY}
    assert "DISABLE_AUTOUPDATER" not in blanked
    assert packaged.session_env(LAUNCHED, packaged=False) == {}
    assert packaged.session_env({"HOME": "/Users/owner"}, packaged=True) == {}


async def test_a_bang_command_and_the_owner_s_shell_get_the_owner_s_environment(
    tmp_path, monkeypatch
):
    import asyncio

    from jarvis import runproc
    from jarvis.code_terminals import BangRun

    for key, value in LAUNCHED.items():
        if key not in ("HOME", "PATH"):
            monkeypatch.setenv(key, value)
    monkeypatch.setenv("SHELL", "/bin/zsh")
    monkeypatch.setattr(packaged, "is_packaged", lambda *_a: True)
    run = BangRun(
        "env",
        'printf "%s|%s|%s" "${JARVIS_TOKEN-none}" "${PYTHONNOUSERSITE-none}" '
        '"${DISABLE_AUTOUPDATER-none}"',
        tmp_path,
        lambda *_a, **_k: None,
    )
    run.start()
    assert await asyncio.wait_for(run.done, 60) == 0
    assert run.output(1000).strip().splitlines()[-1] == "none|none|none"
    # The dev servers', tests' and checkers' environment: the login shell is asked with the
    # owner's, and what it answers carries none of JARVIS's own either.
    asked = {}

    def fake_run(argv, **kwargs):
        asked.update(kwargs.get("env") or {})
        return subprocess.CompletedProcess(argv, 0, stdout=b"", stderr=b"")

    monkeypatch.setattr(runproc.subprocess, "run", fake_run)
    monkeypatch.setattr(runproc, "_env_cache", None)
    env = runproc.shell_env(refresh=True)
    assert asked and not set(asked) & {"JARVIS_TOKEN", *packaged.LAUNCH_ONLY}
    assert not set(env) & {"JARVIS_TOKEN", *packaged.LAUNCH_ONLY, *packaged.ENGINE_ONLY}
    monkeypatch.setattr(runproc, "_env_cache", None)


def test_a_session_s_commands_get_the_owner_s_environment(settings, monkeypatch):
    from jarvis.tasks import ClaudeTask, TaskManager

    async def approve(*_a, **_k):
        return "allow"

    monkeypatch.setenv("PYTHONNOUSERSITE", "1")
    monkeypatch.setattr(packaged, "is_packaged", lambda *_a: True)
    manager = TaskManager(settings, approve, lambda *_a, **_k: None, object)
    task = ClaudeTask(id=1, prompt="", cwd=settings.projects_dir, env={"FOO": "bar"})
    options = manager.options_for(task)
    assert options.env["PYTHONNOUSERSITE"] == "" and options.env["FOO"] == "bar"
    monkeypatch.setattr(packaged, "is_packaged", lambda *_a: False)
    assert "PYTHONNOUSERSITE" not in manager.options_for(task).env  # (from the repo: as before)
