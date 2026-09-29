"""One JARVIS backend per Mac: a second `jarvis serve` refuses to start and says why, the
lock goes with the process however it ends, and only serve() takes it (the app window's
server and the tests never do)."""

import os
import subprocess
import sys

import pytest
from starlette.testclient import TestClient
from test_hub import make_hub

from jarvis import config, jsonstore, prefs, server

HOLD = """
import sys, time
from pathlib import Path
from jarvis.jsonstore import claim_folder
lock = claim_folder(Path(sys.argv[1]))
print("held" if lock else "no lock", flush=True)
time.sleep(120)
"""

CLAIM = """
import sys
from pathlib import Path
from jarvis.jsonstore import FolderTaken, claim_folder
try:
    lock = claim_folder(Path(sys.argv[1]))
except FolderTaken as exc:
    print(exc.strerror)
    raise SystemExit(3)
raise SystemExit(0 if lock else 1)
"""


def test_only_one_process_holds_the_data_folder(tmp_path):
    first = jsonstore.claim_folder(tmp_path)
    assert first is not None
    with pytest.raises(jsonstore.FolderTaken, match=f"process {os.getpid()}"):
        jsonstore.claim_folder(tmp_path)
    other = subprocess.run(
        [sys.executable, "-c", CLAIM, str(tmp_path)], capture_output=True, text=True, timeout=60
    )
    assert other.returncode == 3 and f"process {os.getpid()}" in other.stdout
    first.close()
    assert subprocess.run([sys.executable, "-c", CLAIM, str(tmp_path)], timeout=60).returncode == 0


def test_the_lock_goes_with_the_process_however_it_ends(tmp_path):
    holder = subprocess.Popen(
        [sys.executable, "-c", HOLD, str(tmp_path)], stdout=subprocess.PIPE, text=True
    )
    try:
        assert holder.stdout.readline().strip() == "held"
        with pytest.raises(jsonstore.FolderTaken):
            jsonstore.claim_folder(tmp_path)
    finally:
        holder.kill()  # kill -9: no chance to let go of it itself
        holder.wait(timeout=30)
        holder.stdout.close()
    lock = jsonstore.claim_folder(tmp_path)
    assert lock is not None
    lock.close()


def test_a_second_backend_refuses_to_start_and_says_why(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("HOME", str(tmp_path))  # nothing of the owner's, even if it got further
    monkeypatch.setattr(prefs, "APP_SUPPORT", tmp_path / "Jarvis")

    def not_reached(*_args, **_kwargs):
        raise AssertionError("the second backend got past the lock")

    monkeypatch.setattr(config, "load_settings", not_reached)
    monkeypatch.setattr(server, "Hub", not_reached)
    held = jsonstore.claim_folder(tmp_path / "Jarvis")
    try:
        with pytest.raises(SystemExit) as refused:
            server.serve(0, "token")
    finally:
        held.close()
    assert refused.value.code == 75
    said = capsys.readouterr().err
    assert f"process {os.getpid()}" in said and "Quit that one first" in said


def test_the_window_server_and_tests_never_take_the_lock(
    tmp_path, monkeypatch, settings, quiet_speaker, isolated
):
    monkeypatch.setattr(prefs, "APP_SUPPORT", tmp_path / "Jarvis")
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    with TestClient(server.create_app(hub, "token")):  # starts and stops the hub
        lock = jsonstore.claim_folder(tmp_path / "Jarvis")
        assert lock is not None
        lock.close()
