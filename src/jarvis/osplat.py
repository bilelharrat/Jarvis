"""Which OS this is, and where it keeps things. The one place the engine asks.

macOS: ~/Library/Application Support/Jarvis and ~/Library/Logs/Jarvis. Windows:
%APPDATA%\\Jarvis and %LOCALAPPDATA%\\Jarvis\\Logs. Anything else: the XDG folders.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform == "win32"


def app_support(home: Path | None = None) -> Path:
    home = home or Path.home()
    if IS_WIN:
        return Path(os.environ.get("APPDATA") or home / "AppData" / "Roaming") / "Jarvis"
    if IS_MAC:
        return home / "Library" / "Application Support" / "Jarvis"
    return Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share") / "Jarvis"


def logs_dir(home: Path | None = None) -> Path:
    home = home or Path.home()
    if IS_WIN:
        return (
            Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local") / "Jarvis" / "Logs"
        )
    if IS_MAC:
        return home / "Library" / "Logs" / "Jarvis"
    return Path(os.environ.get("XDG_STATE_HOME") or home / ".local" / "state") / "Jarvis" / "logs"


def sqlite_ro_uri(path: Path | str) -> str:
    """A read-only SQLite URI for a file, right on a PC too (a drive letter, backslashes, spaces)."""
    return f"{Path(path).absolute().as_uri()}?mode=ro"


def kill_tree_argv(pid: int) -> list[str]:
    """Windows: the command that ends a process and everything it started."""
    return ["taskkill", "/PID", str(pid), "/T", "/F"]


# ── file locks, disk sync, user name ──


# Windows locks a byte range, and a byte that is locked can't be read by anyone else. The lock is a
# byte far past anything written (the file holds a process id, which the one turned away reads).
LOCK_AT = 1 << 30


def lock_file(handle, wait: bool = False) -> None:
    """An exclusive lock on an open file (or fd); OSError (BlockingIOError) when held elsewhere."""
    if IS_WIN:
        import msvcrt
        import time as _time

        fd = handle if isinstance(handle, int) else handle.fileno()
        deadline = _time.monotonic() + (3600 if wait else 0)
        while True:
            try:
                os.lseek(fd, LOCK_AT, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                os.lseek(fd, 0, os.SEEK_SET)
                return
            except OSError:
                os.lseek(fd, 0, os.SEEK_SET)
                if _time.monotonic() >= deadline:
                    raise BlockingIOError("locked") from None
                _time.sleep(0.1)
    import fcntl

    fcntl.flock(handle, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))


def unlock_file(handle) -> None:
    if IS_WIN:
        import msvcrt

        fd = handle if isinstance(handle, int) else handle.fileno()
        os.lseek(fd, LOCK_AT, os.SEEK_SET)
        try:
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        finally:
            os.lseek(fd, 0, os.SEEK_SET)
        return
    import fcntl

    fcntl.flock(handle, fcntl.LOCK_UN)


def keyring_backend():
    """The system's secret store: the login Keychain (macOS), Credential Manager (Windows)."""
    if IS_MAC:
        from keyring.backends import macOS

        return macOS.Keyring()
    import keyring

    return keyring.get_keyring()


SCREEN_READERS = ("nvda.exe", "jfw.exe", "narrator.exe", "supernova.exe", "zt.exe", "zoomtext.exe")


def screen_reader_running() -> bool | None:
    """Is a screen reader running on this PC? Windows' own flag for it (set by NVDA, JAWS and
    most others), or one of the well-known ones among the programs. Chromium's idea of it is
    wider (any program reading a window through UI Automation counts, and it stays "yes"), so on a
    PC this is asked first. None where it can't be asked (not Windows)."""
    if not IS_WIN:
        return None
    import ctypes

    flag = ctypes.c_int(0)
    try:
        if (
            ctypes.windll.user32.SystemParametersInfoW(0x0046, 0, ctypes.byref(flag), 0)
            and flag.value
        ):  # SPI_GETSCREENREADER
            return True
    except (OSError, AttributeError):
        pass
    try:
        import psutil

        return any(
            (p.info["name"] or "").lower() in SCREEN_READERS for p in psutil.process_iter(["name"])
        )
    except Exception:  # noqa: BLE001 - the program list can't be read: only the flag could say
        return False


def fchmod(fd: int, mode: int) -> None:
    """The permission bits of an open file (0o600: the owner alone). Windows has no such bits:
    a file under the user's profile is already theirs alone."""
    if hasattr(os, "fchmod"):
        os.fchmod(fd, mode)


# open() flags a Mac has and Windows doesn't (0 there): no following a link swapped in since the
# file was looked at, no waiting on a pipe, and Windows' own binary mode (no \n to \r\n).
O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
O_NONBLOCK = getattr(os, "O_NONBLOCK", 0)
O_BINARY = getattr(os, "O_BINARY", 0)


def replace_file(src: str | os.PathLike[str], dst: str | os.PathLike[str]) -> None:
    """os.replace, which on Windows is refused for a moment while something else (a virus
    scanner, a program reading the file) has the target open: tried again for a short while."""
    if not IS_WIN:
        os.replace(src, dst)
        return
    import time

    for wait in (0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 0):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if not wait:
                raise
            time.sleep(wait)


def lower_priority() -> None:
    """Run behind the foreground work (the voice loop comes first): nice 10 on a Mac, below
    normal priority on Windows."""
    try:
        if IS_WIN:
            import psutil

            psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        else:
            os.nice(10)
    except (OSError, AttributeError, ImportError):
        pass


def _portable_strftime() -> None:
    """Windows' strftime has no "%-d" or "%-I" (no padding); it spells them "%#d" and "%#I".
    Code written on a Mac says "%-d", in datetime.strftime and in f-string formats alike, and
    every one of those goes through time.strftime, so that is said Windows' way here."""
    import re
    import time

    if getattr(time.strftime, "portable", False):
        return
    original = time.strftime

    def strftime(fmt, *args):
        if isinstance(fmt, str) and "%-" in fmt:
            fmt = re.sub(r"%-([a-zA-Z])", r"%#\1", fmt)
        return original(fmt, *args)

    strftime.portable = True  # type: ignore[attr-defined]
    time.strftime = strftime  # type: ignore[assignment]


if IS_WIN:
    _portable_strftime()


def full_sync(fd: int) -> None:
    """On the disk itself: macOS's fsync stops at the drive's cache; F_FULLFSYNC doesn't."""
    if IS_MAC:
        import fcntl

        try:
            fcntl.fcntl(fd, fcntl.F_FULLFSYNC)
            return
        except (AttributeError, OSError):
            pass
    os.fsync(fd)


def account_full_name() -> str:
    """The signed-in account's full name, "" when the system doesn't say."""
    try:
        if IS_WIN:
            import ctypes

            size = ctypes.c_ulong(256)
            buf = ctypes.create_unicode_buffer(256)
            # NameDisplay = 3
            if ctypes.windll.secur32.GetUserNameExW(3, buf, ctypes.byref(size)):
                return buf.value.strip()
            return ""
        import pwd

        return pwd.getpwuid(os.getuid()).pw_gecos.split(",")[0].strip()
    except (KeyError, OSError, ImportError, AttributeError):
        return ""


def current_uid() -> int:
    return -1 if IS_WIN else os.getuid()


# ── shells and process groups ──


def default_shell() -> str:
    """The user's shell: $SHELL, else zsh (macOS); on Windows PowerShell 7, Windows PowerShell, cmd."""
    if IS_WIN:
        import shutil

        return (
            shutil.which("pwsh")
            or shutil.which("powershell")
            or os.environ.get("COMSPEC", "cmd.exe")
        )
    return os.environ.get("SHELL") or "/bin/zsh"


def group_popen_kwargs() -> dict:
    """Popen/subprocess arguments that give a child its own process group (session on POSIX)."""
    if IS_WIN:
        import subprocess

        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
    return {"start_new_session": True}


def kill_group(pid: int, sig: int | None = None, *, force: bool = False) -> None:
    """Signal a child's whole group (POSIX killpg); on Windows end the process tree."""
    import signal as _signal

    if IS_WIN:
        import subprocess

        argv = kill_tree_argv(pid)
        if not force:
            argv = [a for a in argv if a != "/F"]
        subprocess.run(
            argv, capture_output=True, check=False, creationflags=subprocess.CREATE_NO_WINDOW
        )
        return
    os.killpg(pid, sig if sig is not None else (_signal.SIGKILL if force else _signal.SIGTERM))


def group_alive(pid: int) -> bool:
    if IS_WIN:
        import subprocess

        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True,
            text=True,
            check=False,
            creationflags=subprocess.CREATE_NO_WINDOW,
        ).stdout
        return str(pid) in out
    try:
        os.killpg(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def afplay_argv(path: str) -> list[str]:
    """The command that plays a sound file and returns when it's done (afplay; on Windows
    jarvis.winplay)."""
    if IS_WIN:
        import sys

        return [sys.executable, "-I", "-m", "jarvis.winplay", path]
    return ["afplay", path]


# ── opening things ──


def open_target(target: str, *, reveal: bool = False) -> Any:
    """Open a file, folder or web address the way the computer would (what a double click
    does); reveal: show the file in its folder instead (Finder, File Explorer)."""
    import subprocess

    if IS_WIN:
        import os

        if reveal:
            return subprocess.Popen(["explorer.exe", f"/select,{target}"])  # noqa: S603, S607
        os.startfile(target)  # noqa: S606 - ShellExecute: the registered app, no shell involved
        return None
    if IS_MAC:
        return subprocess.Popen(["open", *(["-R"] if reveal else []), target])  # noqa: S603, S607
    return subprocess.Popen(["xdg-open", target])  # noqa: S603, S607


def mac_open(args: list[str]) -> None:
    """What the Mac's `open` command was asked, done on Windows: open <target>, open -R <file>
    (reveal), open -a <app> [<file>]. ValueError for what has no equivalent (-b, a bundle id)."""
    rest = list(args)
    if "-b" in rest:
        raise ValueError("That opens a Mac app by its bundle id; this PC has no such thing.")
    reveal = "-R" in rest
    app = ""
    if "-a" in rest:
        i = rest.index("-a")
        app = rest[i + 1] if i + 1 < len(rest) else ""
        del rest[i : i + 2]
    rest = [a for a in rest if a not in ("-R", "-g", "-n", "-j", "-F")]
    if app:
        from . import win_tools

        found = win_tools.match_app(app, win_tools.start_apps())
        if found is not None and not isinstance(found, list):
            win_tools.launch(found)
            return
        if rest:
            import subprocess

            subprocess.Popen([app, rest[0]])  # noqa: S603 - an app on the PATH, a file for it
            return
        raise ValueError(f"I couldn't find an app called {app} on this PC.")
    if not rest:
        raise ValueError("Nothing to open.")
    open_target(rest[0], reveal=reveal)


def microphone_consent() -> str:
    """Whether apps may use the microphone on this PC, from Windows' own consent store:
    "granted", "denied" or "unknown"."""
    try:
        import winreg

        key = (
            "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager"
            "\\ConsentStore\\microphone"
        )
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
            value, _kind = winreg.QueryValueEx(handle, "Value")
        return {"Allow": "granted", "Deny": "denied"}.get(str(value), "unknown")
    except (OSError, ImportError):
        return "unknown"


def personal_folders(home: Path | None = None) -> list[Path]:
    """The person's Documents, Desktop and Downloads. ~/Documents and the like on a Mac; on a PC where
    Windows keeps each for them (with OneDrive's backup on, inside OneDrive: a plain C:\\Users\\you\\Documents
    beside it may not even exist), as long as that is inside their home folder."""
    names = ("Documents", "Desktop", "Downloads")
    real = Path.home()
    home = home or real
    if IS_WIN and os.path.realpath(home) == os.path.realpath(real):
        from . import winfiles

        known = winfiles.known_folders()
        found = []
        for name in names:
            where = known.get(name)
            found.append(
                where
                if where is not None and (where == home or home in where.parents)
                else home / name
            )
        return found
    return [home / name for name in names]
