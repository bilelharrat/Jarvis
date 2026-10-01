"""Ops: first-run setup, the checkup ("Jarvis, run a checkup"), the security review,
backups of the data folder and a diagnostics file to share when asking for help.

- Setup: the first-run intro (web/features/intro.js), shown by itself on a fresh install
  (no prefs.json when the backend started) and from Settings any time. It uses this
  feature's state (ops_state, ops_setup), the permissions' live status, the Claude check,
  the voice sample and the microphone test, and ops_mic_meter: a live level meter read off
  hands-free's own stream for a few seconds (nothing recorded), or the microphone test.
- The checkup (doctor.py): permissions, Claude, the speech model, the Swift compiler, disk
  space, damaged data files, errors in the log, the companion's port, accounts, leftover
  Claude processes, the file and knowledge indexes and backups; a fix button only for the
  few safe fixes, each asking first.
- The security review (audit.py): what JARVIS may do on its own, each with a one-click
  tighten (never a loosen).
- Backups (backup.py): zips with a SHA-256 manifest, daily and kept seven deep, verified,
  and restored at the next start after a safety backup.
- Diagnostics (diagnostics.py): recent logs with secrets masked, versions and a checkup.

Cost: none of it calls a model. By voice the checkup is one tool call inside the turn the
owner started.

Everything here is registered through the feature kit; install() only registers.
prepare() runs before the hub, in the backend itself (features.prepare_all, from
server.serve): it applies a restore the owner confirmed, then notes whether this is a
fresh install.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ... import prefs as prefs_module
from ...textclean import clean_text


def _setup_state(value: Any) -> str | None:
    return value if value in ("", "pending", "done", "skipped") else None


def _folder(value: Any) -> str | None:
    """A backup folder as the window gives it: an absolute path (or ~/…), or "" for the
    default. Where it may be is checked when a backup is made."""
    if not isinstance(value, str):
        return None
    text = clean_text(value).strip()[:500]
    if not text:
        return ""
    path = Path(text).expanduser()
    if not path.is_absolute() or ".." in path.parts:
        return None
    return str(path)


prefs_module.register_feature_pref("ops_setup_state", "", _setup_state)
prefs_module.register_feature_pref("ops_backup_daily", True)
prefs_module.register_feature_pref("ops_backup_knowledge", False)
prefs_module.register_feature_pref("ops_backup_folder", "", _folder)


def desk_for(hub: Any):
    """The hub's ops desk (tests reach it here to point it at their own folders)."""
    return getattr(hub, "ops_desk", None)


def prepare(folder: Path) -> None:
    """Before any store reads its file: a staged restore goes into place, then whether
    prefs.json is there says if Setup should show by itself."""
    from . import backup, desk

    backup.apply_pending(folder)
    try:
        fresh = not (folder / "prefs.json").exists()
    except OSError:
        fresh = False
    desk.STARTUP.update(folder=str(folder), fresh=fresh)


def install(hub: Any) -> None:
    from . import desk

    ops = desk.Ops(hub)
    # Kept on the hub, never in a map of this module's: one keyed weakly by the hub still
    # holds its desk, the desk holds the hub, and no hub would ever be freed.
    hub.ops_desk = ops
    for kind, handler in {
        "ops_state": ops.state,
        "ops_setup": ops.setup,
        "ops_permissions": ops.permissions_check,
        "ops_claude": ops.claude_check,
        "ops_open_settings": ops.open_settings,
        "ops_voice_test": ops.voice_test,
        "ops_mic_test": ops.mic_test,
        "ops_mic_meter": ops.mic_meter,
        "ops_doctor": ops.doctor,
        "ops_fix": ops.fix,
        "ops_security": ops.security,
        "ops_tighten": ops.tighten,
        "ops_backups": ops.backups,
        "ops_backup": ops.backup_now,
        "ops_backup_verify": ops.verify,
        "ops_restore_preview": ops.restore_preview,
        "ops_restore": ops.restore,
        "ops_restore_cancel": ops.restore_cancel,
        "ops_diagnostics": ops.make_diagnostics,
        "ops_reveal": ops.reveal,
    }.items():
        hub.register_command(kind, handler)
    hub.register_server(
        "ops", ops.build_server, prompt=desk.PROMPT, labels=desk.LABELS, quiet=("run_checkup",)
    )
    hub.register_loop("ops_daily_backup", ops.daily_loop)
