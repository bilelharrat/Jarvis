"""Eden Code on Windows: what works the same on a PC, what works another way there, and what
is the Mac's alone, with why. The one place Eden Code's features ask about it (osplat says
which OS this is; this says what that means for Eden Code), and what the window's
"On this PC" list in Eden Code settings › General shows (features/code_windows.py,
web/features/code-windows.js). The whole table, feature by feature, is
docs/eden-code-windows-parity.md.

Every answer reads osplat.IS_WIN when it's asked, never at import, so the tests can make a
Mac look like a PC (monkeypatch osplat.IS_WIN), as the other win-* tests do.

What's here:
- sandbox_available(): Claude Code's own sandbox is macOS's Seatbelt and Linux's bubblewrap;
  native Windows has neither, so a session told to use it would run unsandboxed without a
  word. Eden Code never pretends: code_sandbox makes each command ask instead, and an
  unattended run that must be sandboxed doesn't start (code_unattended).
- secret_runs_available(): a command that uses a saved secret gets it from the backend over
  a Unix socket made for that one run, whose peer is checked (key_proxy.Handoffs); Python on
  Windows has no AF_UNIX, so on a PC sessions are told so instead of being asked for a value
  they couldn't use (code_secrets).
- git_bash(): the bash Claude Code itself runs a session's commands in on Windows (Git for
  Windows'), never WSL's bash.exe in System32, which runs in another computer's files.
- link_folder(): a folder linked into an isolated copy (node_modules, .venv): a symlink, which
  Windows lets an app make only with Developer Mode on. No junction instead on purpose: a tool
  that deletes the copy and follows a junction would empty the main folder's node_modules.
- REPORT / report(): the features that are limited or the Mac's alone on this computer.

Cost policy: nothing here calls a model.
"""

from __future__ import annotations

import os
import shutil
import socket
from pathlib import Path
from typing import Any

from . import osplat

# What the owner and Claude are told (lang strings: features/code_windows.py registers the
# Chinese of each).
NO_SANDBOX = (
    "Claude Code's sandbox isn't available on Windows (it's built on macOS's and Linux's "
    "own), so with the sandbox switch on each command of a Bypass or unattended session "
    "asks you first instead."
)
NO_SANDBOX_RUN = (
    "This run's commands have to be in Claude Code's sandbox, which isn't available on "
    "Windows, so it didn't start. Turn the sandbox off for this repository to run it "
    "without (its commands then keep to the run's own list), or run it on a Mac."
)
NO_SECRET_RUNS = (
    "On Windows, Eden Code can't hand a saved secret to a command yet (it goes over a Unix "
    "socket, which Windows' Python lacks). Don't ask for the value: ask the owner to run "
    "the command that needs it themselves, in the Terminal pane, and tell you how it went."
)
NO_SECRET_RUN = (
    "On Windows, Eden Code can't hand the owner's secret to a command. Ask the owner to "
    "run this command themselves, in the Terminal pane."
)
NO_LINKS = (
    "{name} isn't linked: Windows lets apps make links only with Developer Mode on "
    "(Settings › System › For developers). Install its dependencies in the copy instead."
)


def os_name() -> str:
    if osplat.IS_WIN:
        return "windows"
    return "mac" if osplat.IS_MAC else "linux"


def sandbox_available() -> bool:
    """Whether Claude Code's sandbox runs here (macOS, Linux; not native Windows)."""
    return not osplat.IS_WIN


def secret_runs_available() -> bool:
    """Whether a command can be handed a saved secret here (a Unix socket with its peer
    checked: key_proxy.Handoffs)."""
    return not osplat.IS_WIN and hasattr(socket, "AF_UNIX")


def secret_store() -> str:
    """Where the owner's secrets are kept here, as the owner knows it."""
    return "Credential Manager" if osplat.IS_WIN else "Keychain"


def _is_wsl_bash(path: str) -> bool:
    low = path.replace("/", "\\").lower()
    return low.endswith(("\\system32\\bash.exe", "\\sysnative\\bash.exe")) or "windowsapps" in low


def git_bash(env: dict[str, str] | None = None) -> str | None:
    """Git for Windows' bash.exe, as Claude Code finds it: CLAUDE_CODE_GIT_BASH_PATH, else the
    bash beside the git on the PATH (…\\Git\\cmd\\git.exe -> …\\Git\\bin\\bash.exe), else where
    the installer puts it. Never WSL's bash in System32. None when there's none."""
    env = os.environ if env is None else env
    named = env.get("CLAUDE_CODE_GIT_BASH_PATH") or ""
    if named and Path(named).is_file() and not _is_wsl_bash(named):
        return named
    places: list[Path] = []
    git = shutil.which("git")
    if git:
        top = Path(git).resolve().parent.parent  # (…\Git\cmd or …\Git\bin, or mingw64\bin)
        places += [top / "bin" / "bash.exe", top.parent / "bin" / "bash.exe"]
    for root in (env.get("ProgramFiles"), env.get("ProgramW6432"), env.get("LOCALAPPDATA")):
        if root:
            places += [Path(root) / "Git" / "bin" / "bash.exe"]
            places += [Path(root) / "Programs" / "Git" / "bin" / "bash.exe"]
    return next((str(p) for p in places if p.is_file() and not _is_wsl_bash(str(p))), None)


def link_folder(link: Path, target: Path) -> None:
    """link -> target, a folder's symlink. OSError when it can't be made (on Windows without
    Developer Mode, WinError 1314). Never a junction: see the module's note."""
    link.symlink_to(target, target_is_directory=True)


# ── the "On this PC" list ──

# Each: id, the owner's name for it, and on Windows: "another" (works, another way) or
# "mac" (the Mac's alone), with why. Only what differs is listed; everything else in Eden
# Code works the same (the parity table in docs/ says which, and how that was checked).
REPORT: list[dict[str, str]] = [
    {
        "id": "touchid",
        "name": "Touch ID for Bypass and risky steps",
        "state": "another",
        "why": "Windows Hello asks instead (your face, fingerprint or PIN); without Windows "
        "Hello set up, the app asks you to confirm.",
    },
    {
        "id": "sandbox",
        "name": "Sandbox for Bypass and unattended sessions",
        "state": "mac",
        "why": NO_SANDBOX,
    },
    {
        "id": "secrets",
        "name": "Secrets for commands",
        "state": "mac",
        "why": "A command gets a saved secret over a Unix socket, which Windows' Python "
        "lacks. Run such commands yourself in the Terminal pane.",
    },
    {
        "id": "interpreter",
        "name": "Code interpreter (run_python)",
        "state": "mac",
        "why": "Its Python runs in macOS's sandbox (no network, none of your files); "
        "Windows has no such sandbox for it, so it's off rather than unsandboxed.",
    },
    {
        "id": "simulator",
        "name": "iOS Simulator and Xcode tools",
        "state": "mac",
        "why": "The iOS Simulator and Xcode run only on a Mac.",
    },
    {
        "id": "look",
        "name": "The look-at-this key",
        "state": "another",
        "why": "It sends the app, its window's title and a picture of the screen; the text "
        "selected there isn't read on Windows yet.",
    },
    {
        "id": "links",
        "name": "Shared node_modules and .venv in isolated copies",
        "state": "another",
        "why": "Linked only with Windows' Developer Mode on; otherwise install them in the copy.",
    },
    {
        "id": "editors",
        "name": "Open in an editor",
        "state": "another",
        "why": "VS Code, Cursor and Zed are found where Windows installs them; Xcode is "
        "the Mac's alone.",
    },
]


def report() -> dict[str, Any]:
    """{os, features}: on Windows, what's limited or the Mac's alone (REPORT); elsewhere none."""
    return {"os": os_name(), "features": [dict(f) for f in REPORT] if osplat.IS_WIN else []}
