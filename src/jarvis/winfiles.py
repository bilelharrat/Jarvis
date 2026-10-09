"""The files' side of a PC: the Recycle Bin, the clipboard, the folders Windows keeps for a person
(file_actions.py uses these where a Mac uses the Trash, the pasteboard and Library).

- trash_item(path) sends a file or folder to the Recycle Bin (the shell's own delete, with undo) and
  says where it went inside the bin ($Recycle.Bin\\<you>\\$R...), so undo can put it back where it was.
  It refuses, in words, what the bin can't keep: a file on a network drive, a drive whose bin is
  switched off (Windows would then delete for good, without asking), and anything bigger than the
  bin holds. Nothing here ever deletes for good.
- read_clipboard / write_clipboard are the text on the clipboard; what a password manager marked
  private (it says so with the formats Windows' clipboard history looks at) is never read.
- known_folders() are the folders Windows keeps for a person (Documents, Desktop, Downloads…), wherever
  OneDrive or a school's network has put them: they are moved into and out of, never moved themselves.
"""

from __future__ import annotations

import ctypes
import json
import os
import struct
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

IS_WIN = sys.platform == "win32"

DRIVE_FIXED = 3
# The names Windows keeps for devices, which no file can be called (with or without an extension).
RESERVED = frozenset(
    ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
    + [f"COM{n}" for n in range(1, 10)]
    + [f"LPT{n}" for n in range(1, 10)]
)
NOT_IN_NAMES = frozenset('<>:"/\\|?*')
BIN_SECONDS = 120  # how recent a bin entry must be to be the one just made
LOOKUP_TRIES = 20
SCAN_LIMIT = 20_000  # entries looked at when measuring a folder before it goes to the bin


def bad_name(name: str) -> str:
    """Why a file can't be called this on a PC, or "" when it can."""
    if any(c in NOT_IN_NAMES for c in name):
        return "a name can't have any of these: < > : \" / \\ | ? *"
    if name != name.rstrip(" ."):
        return "a name can't end with a space or a dot"
    if name.split(".")[0].rstrip(" ").upper() in RESERVED:
        return "that's a name Windows keeps for a device"
    return ""


# ── the Recycle Bin ──


def parse_info(raw: bytes) -> tuple[str, datetime, int] | None:
    """A $I file of the Recycle Bin: (where the item was, when it went, how big it was), or None.
    Version 2 (Windows 10 and later) has the path's length before the path; version 1 (Vista to
    8.1) has a fixed 520 bytes for it."""
    if len(raw) < 28:
        return None
    version, size, filetime = struct.unpack_from("<qqq", raw)
    if version == 2:
        (count,) = struct.unpack_from("<i", raw, 24)
        if not 0 < count <= 32768:
            return None
        text = raw[28 : 28 + count * 2].decode("utf-16-le", "replace")
    elif version == 1:
        text = raw[24:544].decode("utf-16-le", "replace")
    else:
        return None
    text = text.split("\x00", 1)[0]
    if not text:
        return None
    try:
        when = datetime(1601, 1, 1, tzinfo=UTC) + timedelta(microseconds=filetime // 10)
    except (OverflowError, ValueError):
        return None
    return text, when, size


def user_sid() -> str:
    """This person's security id ("S-1-5-21-…"), the name of their folder in every drive's bin."""
    advapi32, kernel32 = ctypes.windll.advapi32, ctypes.windll.kernel32
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    advapi32.OpenProcessToken.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    advapi32.GetTokenInformation.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32),
    ]  # fmt: skip
    advapi32.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    token = ctypes.c_void_p()
    if not advapi32.OpenProcessToken(
        kernel32.GetCurrentProcess(), 0x8, ctypes.byref(token)
    ):  # TOKEN_QUERY
        raise OSError("couldn't ask Windows who this is")
    try:
        size = ctypes.c_uint32()
        advapi32.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))  # TokenUser
        buffer = ctypes.create_string_buffer(size.value)
        if not advapi32.GetTokenInformation(token, 1, buffer, size, ctypes.byref(size)):
            raise OSError("couldn't ask Windows who this is")
        sid = ctypes.c_void_p.from_buffer(buffer).value  # TOKEN_USER starts with the SID's address
        text = ctypes.c_wchar_p()
        if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(text)):
            raise OSError("couldn't read who this is")
        try:
            return str(text.value)
        finally:
            kernel32.LocalFree(text)
    finally:
        kernel32.CloseHandle(token)


def _bin_folders(drive: str) -> list[Path]:
    """This person's folder in the drive's bin (the bin's own root can't be listed by anyone but
    an administrator, but each person may open their own folder by name)."""
    try:
        folder = Path(drive + "\\") / "$Recycle.Bin" / user_sid()
    except OSError:
        return []
    return [folder] if folder.is_dir() else []


def _same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def find_in_bin(original: Path, after: datetime | None = None) -> Path | None:
    """Where a file that went to the bin from here now is (its $R... name), the newest if the
    same path went more than once. None when it isn't to be found."""
    best: tuple[datetime, Path] | None = None
    for folder in _bin_folders(original.drive):
        try:
            names = [n for n in os.listdir(folder) if n.startswith("$I")]
        except OSError:
            continue
        for name in names:
            try:
                info = parse_info((folder / name).read_bytes())
            except OSError:
                continue
            if info is None or not _same(info[0], str(original)):
                continue
            if after is not None and info[1] < after:
                continue
            held = folder / ("$R" + name[2:])
            if os.path.lexists(held) and (best is None or info[1] > best[0]):
                best = (info[1], held)
    return best[1] if best else None


def left_the_bin(held: Path) -> None:
    """The bin's note about an item that has been put back (its $I file), taken away, so the bin
    doesn't list something that isn't there."""
    if not held.name.startswith("$R"):
        return
    try:
        os.remove(held.parent / ("$I" + held.name[2:]))
    except OSError:
        pass


def _registry_dword(root: int, path: str, name: str) -> int | None:
    import winreg

    try:
        with winreg.OpenKey(root, path) as key:
            value, kind = winreg.QueryValueEx(key, name)
    except OSError:
        return None
    return int(value) if kind == winreg.REG_DWORD else None


def volume_guid(drive: str) -> str:
    """The id Windows keeps a drive's bin settings under: "{xxxxxxxx-…}", or "" if unknown."""
    buf = ctypes.create_unicode_buffer(64)
    if not ctypes.windll.kernel32.GetVolumeNameForVolumeMountPointW(drive + "\\", buf, 64):
        return ""
    name = buf.value  # \\?\Volume{guid}\
    start, end = name.find("{"), name.rfind("}")
    return name[start : end + 1] if 0 <= start < end else ""


def bin_limits(drive: str) -> tuple[bool, int]:
    """(whether the bin is switched off for this drive, the most it keeps in bytes). Switched off:
    by the person (the drive's "Don't move files to the Recycle Bin" setting) or by their
    organisation's policy. The most is the drive's own setting, else a twentieth of the drive."""
    import winreg

    policy = _registry_dword(
        winreg.HKEY_CURRENT_USER,
        r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer",
        "NoRecycleFiles",
    )
    if policy:
        return True, 0
    base = r"Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket"
    here = rf"{base}\Volume\{volume_guid(drive)}"
    off = _registry_dword(winreg.HKEY_CURRENT_USER, here, "NukeOnDelete")
    biggest = _registry_dword(winreg.HKEY_CURRENT_USER, here, "MaxCapacity")
    if off is None:  # every drive the same way: the bin's own setting
        off = _registry_dword(winreg.HKEY_CURRENT_USER, base, "NukeOnDelete")
    if biggest:
        return bool(off), biggest * 1024 * 1024
    try:
        import shutil

        total = shutil.disk_usage(drive + "\\").total
    except OSError:
        total = 0
    return bool(off), total // 20


def size_of(path: Path, limit: int = SCAN_LIMIT) -> int:
    """Bytes in a file or in everything under a folder (it stops counting at `limit` entries and
    says -1: too many to know)."""
    try:
        if not path.is_dir() or path.is_symlink():
            return path.lstat().st_size
    except OSError:
        return 0
    total = seen = 0
    for base, folders, files in os.walk(path):
        for name in files:
            seen += 1
            if seen > limit:
                return -1
            try:
                total += os.lstat(os.path.join(base, name)).st_size
            except OSError:
                continue
        seen += len(folders)
    return total


class _FileOp(ctypes.Structure):
    _fields_ = [
        ("hwnd", ctypes.c_void_p),
        ("wFunc", ctypes.c_uint),
        ("pFrom", ctypes.c_wchar_p),
        ("pTo", ctypes.c_wchar_p),
        ("fFlags", ctypes.c_ushort),
        ("fAnyOperationsAborted", ctypes.c_int),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", ctypes.c_wchar_p),
    ]


FO_DELETE = 0x3
FOF_SILENT = 0x4
FOF_NOCONFIRMATION = 0x10
FOF_ALLOWUNDO = 0x40
FOF_NOERRORUI = 0x400
FOF_WANTNUKEWARNING = 0x4000  # a warning, never a quiet delete for good, if the bin can't take it


def _recycle_here(path: Path) -> int:
    """The shell's delete with undo on one item, in this process: its error code (0: it went to the bin)."""
    op = _FileOp()
    op.wFunc = FO_DELETE
    buffer = ctypes.create_unicode_buffer(str(path) + "\x00\x00")
    op.pFrom = ctypes.cast(buffer, ctypes.c_wchar_p)
    op.fFlags = (
        FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT | FOF_WANTNUKEWARNING
    )
    code = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if code == 0 and op.fAnyOperationsAborted:
        return ERROR_CANCELLED
    return int(code)


RECYCLE_SECONDS = (
    30  # how long Windows is given before it is taken to be asking something on screen
)
ERROR_CANCELLED = 1223
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def recycle(path: Path, wait: float = RECYCLE_SECONDS) -> int:
    """Send one item to the Recycle Bin: the error code (0: it went). Done by a short program of its own, so
    that if Windows puts a question on screen that nobody sees (a drive that can't keep it, a file in use),
    this stops waiting after `wait` seconds and ends that program, and the question with it: the item is
    still where it was, never deleted for good. (ERROR_CANCELLED says that.)"""
    try:
        done = subprocess.run(
            [sys.executable, "-I", "-m", "jarvis.winfiles", "recycle", str(path)],
            capture_output=True,
            text=True,
            timeout=wait,
            creationflags=NO_WINDOW,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return ERROR_CANCELLED
    except OSError:
        return _recycle_here(path)  # (no way to start one: do it here, as before)
    try:
        return int((done.stdout or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        return 1


def trash_item(path: Path) -> Path:
    """Send an item to the Recycle Bin; where it is in there now, so it can come back."""
    drive = path.drive
    if not drive or drive.startswith("\\\\"):
        raise OSError(
            "It's on a network location, which has no Recycle Bin, so I can't delete it safely."
        )
    if ctypes.windll.kernel32.GetDriveTypeW(drive + "\\") != DRIVE_FIXED:
        raise OSError("The Recycle Bin only keeps files from this computer's own drives.")
    off, biggest = bin_limits(drive)
    if off:
        raise OSError(
            "The Recycle Bin is switched off for that drive, so deleting would be for good. "
            "I won't do that."
        )
    size = size_of(path)
    if size < 0 or size > biggest * 0.9:
        raise OSError(
            "It's too big for the Recycle Bin to keep safely; delete it in File Explorer."
        )
    started = datetime.now(UTC) - timedelta(seconds=2)
    code = recycle(path)
    if code:
        if code == ERROR_CANCELLED:
            raise OSError(
                "Windows asked something on screen and I stopped waiting. Nothing was deleted."
            )
        raise OSError(f"Windows couldn't move it to the Recycle Bin (error {code:#x}).")
    for _ in range(LOOKUP_TRIES):  # the bin writes its note a moment after the delete returns
        held = find_in_bin(path, after=started)
        if held is not None:
            return held
        time.sleep(0.1)
    raise OSError(
        "It went to the Recycle Bin, but I can't tell where in it; "
        "you can put it back from the Recycle Bin."
    )


# ── the clipboard ──

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x2
# What password managers put on the clipboard to say "don't keep this" (Windows' clipboard history
# and cloud clipboard look for them): any of these in place and the text is private.
PRIVATE_FORMATS = ("ExcludeClipboardContentFromMonitorProcessing", "Clipboard Viewer Ignore")
HISTORY_FORMAT = "CanIncludeInClipboardHistory"  # a DWORD: 0 means "keep it out of the history"


def _clipboard_api():
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    user32.OpenClipboard.argtypes = [ctypes.c_void_p]
    user32.OpenClipboard.restype = ctypes.c_int
    user32.GetClipboardData.argtypes = [ctypes.c_uint]
    user32.GetClipboardData.restype = ctypes.c_void_p
    user32.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
    user32.SetClipboardData.restype = ctypes.c_void_p
    user32.IsClipboardFormatAvailable.argtypes = [ctypes.c_uint]
    user32.RegisterClipboardFormatW.argtypes = [ctypes.c_wchar_p]
    user32.RegisterClipboardFormatW.restype = ctypes.c_uint
    kernel32.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalSize.argtypes = [ctypes.c_void_p]
    kernel32.GlobalSize.restype = ctypes.c_size_t
    kernel32.GlobalFree.argtypes = [ctypes.c_void_p]
    return user32, kernel32


def _open_clipboard(user32) -> None:
    for _ in range(20):  # another program may have it for a moment
        if user32.OpenClipboard(None):
            return
        time.sleep(0.05)
    raise OSError("The clipboard is in use by another program.")


def clipboard_is_private(user32) -> bool:
    for name in PRIVATE_FORMATS:
        if user32.IsClipboardFormatAvailable(user32.RegisterClipboardFormatW(name)):
            return True
    fmt = user32.RegisterClipboardFormatW(HISTORY_FORMAT)
    if user32.IsClipboardFormatAvailable(fmt):
        handle = user32.GetClipboardData(fmt)
        if handle:
            kernel32 = ctypes.windll.kernel32
            pointer = kernel32.GlobalLock(handle)
            if pointer:
                try:
                    if (
                        kernel32.GlobalSize(handle) >= 4
                        and ctypes.c_uint.from_address(pointer).value == 0
                    ):
                        return True
                finally:
                    kernel32.GlobalUnlock(handle)
    return False


def read_clipboard(refuse) -> str:
    """The clipboard's text ("" if it holds none). `refuse` is the error to raise for a private one."""
    user32, kernel32 = _clipboard_api()
    _open_clipboard(user32)
    try:
        if clipboard_is_private(user32):
            raise refuse("The clipboard holds something a password manager marked private.")
        if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return ""
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return ""
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            return ""
        try:
            return ctypes.wstring_at(pointer)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def write_clipboard(text: str) -> None:
    user32, kernel32 = _clipboard_api()
    data = (text + "\x00").encode("utf-16-le")
    handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
    if not handle:
        raise OSError("There's no memory for the clipboard.")
    pointer = kernel32.GlobalLock(handle)
    if not pointer:
        kernel32.GlobalFree(handle)
        raise OSError("The clipboard's memory couldn't be used.")
    ctypes.memmove(pointer, data, len(data))
    kernel32.GlobalUnlock(handle)
    try:
        _open_clipboard(user32)
    except OSError:
        kernel32.GlobalFree(handle)
        raise
    try:
        user32.EmptyClipboard()
        if not user32.SetClipboardData(CF_UNICODETEXT, handle):
            kernel32.GlobalFree(handle)
            raise OSError("The clipboard wouldn't take it.")
    finally:
        user32.CloseClipboard()


# ── the folders Windows keeps for a person ──

_KNOWN = {
    "Desktop": "B4BFCC3A-DB2C-424C-B029-7FE99A87C641",
    "Documents": "FDD39AD0-238F-46AF-ADB4-6C85480369C7",
    "Downloads": "374DE290-123F-4565-9164-39C4925E467B",
    "Pictures": "33E28130-4E1E-4676-835A-98395C3BC3BB",
    "Music": "4BD8D571-6D19-48D3-BE97-422220080E43",
    "Videos": "18989B1D-99B5-455B-841C-AB7C74E4DDFC",
    "Favorites": "1777F761-68AD-4D8A-87BD-30B759FA33DD",
    "Contacts": "56784854-C6CB-462B-8169-88E350ACB882",
    "Links": "BFB9D5E0-C6A9-404C-B2B2-AE6DB6AF4968",
    "Saved Games": "4C5C32FF-BB9D-43B0-B5B4-2D72E54EAAA4",
    "Searches": "7D1D3A04-DEBB-4115-95CF-2F29DA2920DA",
}


class _Guid(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_uint32),
        ("Data2", ctypes.c_uint16),
        ("Data3", ctypes.c_uint16),
        ("Data4", ctypes.c_ubyte * 8),
    ]

    @classmethod
    def parse(cls, text: str) -> _Guid:
        import uuid

        u = uuid.UUID(text)
        return cls(u.time_low, u.time_mid, u.time_hi_version, (ctypes.c_ubyte * 8)(*u.bytes[8:]))


def known_folders() -> dict[str, Path]:
    """Documents, Desktop, Downloads… and where Windows keeps each for this person (OneDrive's
    or a school's network share when it has been moved there). Folders that aren't there are left out."""
    if not IS_WIN:
        return {}
    out: dict[str, Path] = {}
    shell32 = ctypes.windll.shell32
    shell32.SHGetKnownFolderPath.argtypes = [
        ctypes.POINTER(_Guid),
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    for name, guid in _KNOWN.items():
        pointer = ctypes.c_void_p()
        if (
            shell32.SHGetKnownFolderPath(
                ctypes.byref(_Guid.parse(guid)), 0, None, ctypes.byref(pointer)
            )
            == 0
        ):
            try:
                out[name] = Path(ctypes.wstring_at(pointer))
            finally:
                ctypes.windll.ole32.CoTaskMemFree(pointer)
    return out


def dropbox_roots() -> list[Path]:
    """Dropbox's folders (personal and work), where the Dropbox app says they are: it writes them to
    info.json (in AppData\\Roaming or Local) however it was installed, and whichever drive they are on."""
    found: list[Path] = []
    for base in (os.environ.get("APPDATA"), os.environ.get("LOCALAPPDATA")):
        if not base:
            continue
        try:
            info = json.loads((Path(base) / "Dropbox" / "info.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for account in info.values() if isinstance(info, dict) else []:
            where = account.get("path") if isinstance(account, dict) else None
            if (
                isinstance(where, str)
                and where
                and os.path.isdir(where)
                and Path(where) not in found
            ):
                found.append(Path(where))
    return found


def cloud_roots() -> list[Path]:
    """The folders a cloud drive keeps on this PC: OneDrive's (personal and work, by the places Windows
    says they are in) and Dropbox's. Files in them are the person's own, and "online only" ones are
    fetched when they are opened."""
    found: list[Path] = []
    for key in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        value = os.environ.get(key)
        if value and Path(value) not in found:
            found.append(Path(value))
    for place in dropbox_roots():
        if place not in found:
            found.append(place)
    return found


if __name__ == "__main__":  # python -m jarvis.winfiles recycle <path>: what recycle() starts
    if len(sys.argv) == 3 and sys.argv[1] == "recycle":
        print(_recycle_here(Path(sys.argv[2])), flush=True)
    else:
        print("usage: recycle <path>", file=sys.stderr)
        sys.exit(2)
