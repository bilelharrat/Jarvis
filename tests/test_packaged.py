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
