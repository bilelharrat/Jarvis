"""The backend inside the app people download, and where that app keeps its own pieces.

The downloadable J.A.R.V.I.S.app carries its backend (Contents/Resources/backend/python, see
app/scripts/release) and starts it with JARVIS_APP_DIR (Contents/Resources/app.asar.unpacked:
the node_modules for the terminal and hand tracking, which Python can't read inside
app.asar, and build/ for the icon) and JARVIS_HELPERS_DIR (the prebuilt Swift helpers,
swift_helper.prebuilt). Run from the repo with uv, as the owner's own install does, neither
is set and everything is found in the repo, as before.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_DIR_ENV = "JARVIS_APP_DIR"
REPO_APP_DIR = Path(__file__).resolve().parents[2] / "app"
BUNDLED_PREFIX = "*.app/Contents/Resources/backend/python"


def app_dir() -> Path:
    """The Electron app's own folder, laid out like the repo's app/ (node_modules, build)."""
    given = os.environ.get(APP_DIR_ENV, "").strip()
    return Path(given) if given else REPO_APP_DIR


def is_packaged(prefix: str | None = None) -> bool:
    """Whether this is the backend bundled inside an app (no uv, no repo, no swiftc here):
    its Python lives in the app's Contents/Resources/backend."""
    try:
        return Path(prefix or sys.prefix).resolve().match(BUNDLED_PREFIX)
    except (OSError, ValueError):
        return False
