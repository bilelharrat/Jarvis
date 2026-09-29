"""The second brain's rebuild helper works on a fresh install (no brain folder yet)."""

import json
import os
import subprocess
import sys

import pytest


def test_a_first_rebuild_makes_its_own_folder(tmp_path):
    store = tmp_path / "fresh" / "brain" / "index.json"  # none of this exists yet
    args = {"store": str(store), "only": []}  # nothing to collect: just start and finish
    run = subprocess.run(
        [sys.executable, "-m", "jarvis.brain_build", json.dumps(args)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert run.returncode == 0, run.stderr[-2000:]
    assert '"done"' in run.stdout and store.parent.is_dir()


def rebuild(store, home, only=None):
    """python -m jarvis.brain_build with every source off, in a home folder of its own
    (research and meetings are read from there, and there are none)."""
    args = {
        "store": str(store),
        "bsh": "",
        "bsh_on": False,
        "notes": False,
        "folders": [],
        "computer": False,
        "photos": False,
        "mail": False,
        "messages": False,
        "only": only,
    }
    return subprocess.run(
        [sys.executable, "-m", "jarvis.brain_build", json.dumps(args)],
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, "HOME": str(home)},
    )


NEWER = {"id": "n", "source": "notes", "title": "t", "text": "x", "ref": "r", "folder": "new"}
DAMAGED = {
    "a-list": b"[]",
    "a-note-from-a-newer-build": json.dumps({"notes": [NEWER], "positions": [[0, 0, 0]]}).encode(),
    "notes-that-arent-a-list": b'{"notes": 5}',
    "cut-short": b'{"built_at": "2026-09-01T10:00:00", "notes": [',
    "not-utf-8": b"\xff\xfe{",
    "a-time-that-isnt-one": b'{"notes": [], "built_at": "yesterday"}',
}


@pytest.mark.parametrize("blob", DAMAGED.values(), ids=DAMAGED.keys())
def test_the_rebuild_repairs_an_index_it_cant_read(tmp_path, blob):
    """It loads the index first, and that used to raise: the rebuild exited 1 every time
    and the bad index stayed until someone edited it by hand."""
    store = tmp_path / "brain" / "index.json"
    store.parent.mkdir()
    store.write_bytes(blob)
    run = rebuild(store, tmp_path)
    assert run.returncode == 0, run.stderr[-2000:]
    data = json.loads(store.read_text())
    assert isinstance(data["notes"], list) and data["built_at"]


def test_a_partial_rebuild_with_no_index_to_keep_from_reads_every_source(tmp_path):
    """A rebuild of the meetings alone keeps the other sources from the saved index; with
    none to keep them from, they'd be missing until the next full rebuild."""
    store = tmp_path / "brain" / "index.json"
    store.parent.mkdir()
    store.write_bytes(b"[]")
    run = rebuild(store, tmp_path, only=["meetings"])
    assert run.returncode == 0 and "Reading research" in run.stdout, run.stderr[-2000:]
    again = rebuild(store, tmp_path, only=["meetings"])  # a good index now: the meetings alone
    assert again.returncode == 0 and "Reading meetings" in again.stdout
    assert "Reading research" not in again.stdout
