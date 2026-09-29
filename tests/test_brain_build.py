"""The second brain's rebuild helper works on a fresh install (no brain folder yet)."""

import json
import subprocess
import sys


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
