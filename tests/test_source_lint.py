"""The backend's own code passes ruff's check, as the project's settings have it (round 3
found voice.py's imports out of order: a lint failure nobody saw, since nothing ran it)."""

import subprocess
from pathlib import Path

from conftest import ruff_binary

ROOT = Path(__file__).resolve().parents[1]


def test_the_backend_passes_ruff_check():
    done = subprocess.run(
        [ruff_binary(), "check", "--output-format", "concise", "src"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert done.returncode == 0, done.stdout + done.stderr
