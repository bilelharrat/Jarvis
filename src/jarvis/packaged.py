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
from typing import Any

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


# ── what the owner's own tools inherit ──

# The token the app starts the backend with (app/backend-launch.js): whoever holds it drives
# JARVIS itself, its approval cards and permission rules included.
TOKEN_ENV = "JARVIS_TOKEN"
# Set by the downloadable app's launcher for its bundled backend alone (bundledEnv). With
# them the owner's own Python would skip their user packages, and JARVIS's own code run in a
# Eden Code session (its tests) would find the installed app's pieces instead of the repo's.
LAUNCH_ONLY = ("PYTHONNOUSERSITE", "PYTHONDONTWRITEBYTECODE", "JARVIS_HELPERS_DIR", APP_DIR_ENV)
# ... and one only the Claude engine the app starts keeps: it never replaces itself inside the
# signed app, while the owner's own Claude Code updates as usual.
ENGINE_ONLY = ("DISABLE_AUTOUPDATER",)


def take_token(environ: Any = None) -> str:
    """The launch token, taken out of the backend's environment (every session, terminal,
    command and dev server it starts inherits that environment); "" when none was given."""
    environ = os.environ if environ is None else environ
    return str(environ.pop(TOKEN_ENV, "") or "")


def owner_env(env: Any, packaged: bool | None = None) -> dict[str, str]:
    """An environment for the owner's own tools this backend starts (a terminal, a "!"
    command, a dev server, the tests and checkers, another agent): env without JARVIS's own
    settings. Run from the repo with uv, only the token is JARVIS's: anything else there is
    the owner's."""
    out = {str(k): str(v) for k, v in dict(env).items()}
    out.pop(TOKEN_ENV, None)
    if is_packaged() if packaged is None else packaged:
        for key in (*LAUNCH_ONLY, *ENGINE_ONLY):
            out.pop(key, None)
    return out


def session_env(environ: Any = None, packaged: bool | None = None) -> dict[str, str]:
    """What a Claude Code session's options.env adds so that the commands it runs get the
    owner's environment: the SDK starts the engine with the backend's environment plus
    options.env, so the launcher's settings there are blanked (an empty PYTHON… or JARVIS_…
    setting counts as none). The engine keeps ENGINE_ONLY."""
    environ = os.environ if environ is None else environ
    if not (is_packaged() if packaged is None else packaged):
        return {}
    return {key: "" for key in LAUNCH_ONLY if key in environ}
