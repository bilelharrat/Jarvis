"""Seeing and driving a Windows PC: the screen, the mouse and the keyboard.

What computer.py does on a Mac with Quartz and screencapture, done here with the Win32 API
(ctypes: nothing to install for the mouse and keyboard) and two small libraries for the
screenshot (mss and Pillow). Positions are physical pixels: the process is made DPI aware so
a screenshot pixel and a mouse pixel are the same pixel on a scaled display.

Everything here is synchronous and is called from a worker thread. Windows only; the module
imports anywhere (so its parsing can be tested) but its Win32 calls need Windows.
"""

from __future__ import annotations

import ctypes
import io
import sys
import time
from ctypes import wintypes
from typing import Any

IS_WIN = sys.platform == "win32"

# ── virtual keys ──

VK = {
    "return": 0x0D, "enter": 0x0D, "tab": 0x09, "space": 0x20, "escape": 0x1B, "esc": 0x1B,
    "backspace": 0x08, "delete": 0x08, "forwarddelete": 0x2E, "del": 0x2E,
    "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22, "insert": 0x2D,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
    "volumeup": 0xAF, "volumedown": 0xAE, "volumemute": 0xAD,
    "playpause": 0xB3, "nexttrack": 0xB0, "previoustrack": 0xB1, "stop": 0xB2,
}  # fmt: skip
# The Mac's names for the modifiers, the way the model has learned them: cmd is the key a
# Windows user means by ctrl, option is alt. "win" is the Windows key.
MODIFIER_VK = {
    "ctrl": 0x11, "control": 0x11, "cmd": 0x11, "command": 0x11, "meta": 0x11,
    "alt": 0x12, "option": 0x12, "opt": 0x12,
    "shift": 0x10,
    "win": 0x5B, "windows": 0x5B, "super": 0x5B,
}  # fmt: skip
PUNCTUATION_VK = {
    "-": 0xBD, "=": 0xBB, "[": 0xDB, "]": 0xDD, ";": 0xBA, "'": 0xDE, ",": 0xBC, ".": 0xBE,
    "/": 0xBF, "\\": 0xDC, "`": 0xC0,
}  # fmt: skip
EXTENDED = {0x25, 0x26, 0x27, 0x28, 0x21, 0x22, 0x23, 0x24, 0x2D, 0x2E, 0x5B}


def parse_keys(combo: str) -> tuple[list[int], int]:
    """ "ctrl+shift+t" -> ([ctrl, shift], T). The last part is the key, the rest modifiers.
    ValueError for anything it doesn't know."""
    parts = [p.strip().lower() for p in str(combo).replace(" ", "").split("+") if p.strip()]
    if not parts:
        raise ValueError("Say which key to press.")
    *mods, key = parts
    modifiers = []
    for m in mods:
        if m not in MODIFIER_VK:
            raise ValueError(f"I don't know the modifier “{m}”. Use ctrl, alt, shift or win.")
        vk = MODIFIER_VK[m]
        if vk not in modifiers:
            modifiers.append(vk)
    if key in VK:
        code = VK[key]
    elif key in MODIFIER_VK:  # a lone modifier, e.g. "win" to open Start
        code = MODIFIER_VK[key]
    elif len(key) == 1 and key.isalnum():
        code = ord(key.upper())
    elif key in PUNCTUATION_VK:
        code = PUNCTUATION_VK[key]
    elif key == "plus":  # shift and the = key
        code = PUNCTUATION_VK["="]
        if MODIFIER_VK["shift"] not in modifiers:
            modifiers.append(MODIFIER_VK["shift"])
    else:
        raise ValueError(f"I don't know the key “{key}”.")
    return modifiers, code


# ── Win32 ──

if IS_WIN:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    ULONG_PTR = ctypes.c_size_t

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ULONG_PTR),
        ]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [
            ("uMsg", wintypes.DWORD),
            ("wParamL", wintypes.WORD),
            ("wParamH", wintypes.WORD),
        ]

    class _INPUTUNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _anonymous_ = ("u",)
        _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]

    user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
    user32.SendInput.restype = wintypes.UINT

INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE = 0x1, 0x2, 0x4
MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x2, 0x4
MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP = 0x8, 0x10
MOUSEEVENTF_WHEEL, MOUSEEVENTF_HWHEEL = 0x800, 0x1000
WHEEL_DELTA = 120


def _send(inputs: list[Any]) -> None:
    array = (INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), array, ctypes.sizeof(INPUT))
    if sent != len(inputs):
        raise OSError(
            ctypes.get_last_error(),
            "Windows refused the keyboard or mouse input (a window with higher rights may be in front).",
        )


def _key(vk: int, up: bool = False) -> Any:
    flags = (KEYEVENTF_KEYUP if up else 0) | (KEYEVENTF_EXTENDEDKEY if vk in EXTENDED else 0)
    return INPUT(
        type=INPUT_KEYBOARD, ki=KEYBDINPUT(wVk=vk, wScan=0, dwFlags=flags, time=0, dwExtraInfo=0)
    )


def _unicode(unit: int, up: bool = False) -> Any:
    return INPUT(
        type=INPUT_KEYBOARD,
        ki=KEYBDINPUT(
            wVk=0,
            wScan=unit,
            dwFlags=KEYEVENTF_UNICODE | (KEYEVENTF_KEYUP if up else 0),
            time=0,
            dwExtraInfo=0,
        ),
    )


def _mouse(flags: int, data: int = 0) -> Any:
    return INPUT(
        type=INPUT_MOUSE,
        mi=MOUSEINPUT(
            dx=0, dy=0, mouseData=data & 0xFFFFFFFF, dwFlags=flags, time=0, dwExtraInfo=0
        ),
    )


def dpi_aware() -> None:
    """Pixels are physical pixels from here on (once per process)."""
    if not IS_WIN:
        return
    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # per-monitor v2
    except (AttributeError, OSError):
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except (AttributeError, OSError):
            user32.SetProcessDPIAware()


# ── monitors ──


def monitors() -> list[dict[str, int]]:
    """Every display, the main one first: {index, x, y, w, h} in virtual-screen pixels."""
    dpi_aware()
    found: list[tuple[int, int, int, int, bool]] = []

    callback_type = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HMONITOR,
        wintypes.HDC,
        ctypes.POINTER(wintypes.RECT),
        wintypes.LPARAM,
    )

    class MONITORINFO(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("rcMonitor", wintypes.RECT),
            ("rcWork", wintypes.RECT),
            ("dwFlags", wintypes.DWORD),
        ]

    def visit(handle, _dc, _rect, _data):
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(handle, ctypes.byref(info)):
            r = info.rcMonitor
            found.append(
                (r.left, r.top, r.right - r.left, r.bottom - r.top, bool(info.dwFlags & 1))
            )
        return True

    user32.EnumDisplayMonitors(None, None, callback_type(visit), 0)
    found.sort(key=lambda m: (not m[4], m[0], m[1]))  # the primary first, then left to right
    return [
        {"index": i + 1, "x": x, "y": y, "w": w, "h": h} for i, (x, y, w, h, _p) in enumerate(found)
    ]


def main_size() -> tuple[int, int]:
    m = monitors()
    return (m[0]["w"], m[0]["h"]) if m else (1920, 1080)


# ── the screenshot ──


def screenshot(
    display: int = 1, width: int = 1280
) -> tuple[bytes, int, int, tuple[int, int, int, int]]:
    """A PNG of one display, scaled to at most `width` pixels across: (png, w, h, the
    display's x, y, w, h in screen pixels)."""
    import mss
    from PIL import Image

    shown = monitors()
    where = next((m for m in shown if m["index"] == display), None)
    if where is None:
        raise ValueError(f"There's no display {display}.")
    with mss.mss() as grabber:
        shot = grabber.grab(
            {"left": where["x"], "top": where["y"], "width": where["w"], "height": where["h"]}
        )
    image = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    if image.width > width:
        image = image.resize(
            (width, max(1, round(image.height * width / image.width))), Image.LANCZOS
        )
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=False)
    return (
        out.getvalue(),
        image.width,
        image.height,
        (where["x"], where["y"], where["w"], where["h"]),
    )


# ── mouse ──


def mouse_position() -> tuple[float, float]:
    dpi_aware()
    point = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(point))
    return float(point.x), float(point.y)


def post_mouse(kind: str, x: float, y: float, button: str = "left", clicks: int = 1) -> None:
    dpi_aware()
    user32.SetCursorPos(int(round(x)), int(round(y)))
    if kind == "move":
        return
    down, up = (
        (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
        if button == "right"
        else (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    )
    for _ in range(max(1, clicks)):
        _send([_mouse(down), _mouse(up)])
        time.sleep(0.04)


def post_scroll(dy: int, dx: int = 0) -> None:
    """dy lines (positive up), dx (positive right), at the mouse."""
    if dy:
        _send([_mouse(MOUSEEVENTF_WHEEL, dy * WHEEL_DELTA)])
    if dx:
        _send([_mouse(MOUSEEVENTF_HWHEEL, dx * WHEEL_DELTA)])


# ── keyboard ──


def post_text(text: str) -> None:
    """Type text where the keyboard focus is: every character, accents and emoji too."""
    batch: list[Any] = []
    for ch in text:
        if ch in "\r\n":
            batch += [_key(0x0D), _key(0x0D, up=True)]
            continue
        data = ch.encode("utf-16-le")
        for i in range(0, len(data), 2):
            unit = int.from_bytes(data[i : i + 2], "little")
            batch += [_unicode(unit), _unicode(unit, up=True)]
        if len(batch) >= 64:
            _send(batch)
            batch = []
            time.sleep(0.005)
    if batch:
        _send(batch)


def post_keys(combo: str) -> None:
    modifiers, key = parse_keys(combo)
    down = [_key(m) for m in modifiers] + [_key(key)]
    up = [_key(key, up=True)] + [_key(m, up=True) for m in reversed(modifiers)]
    _send(down + up)


def media_key(name: str, times: int = 1) -> None:
    code = VK[name]
    for _ in range(max(1, times)):
        _send([_key(code), _key(code, up=True)])
        time.sleep(0.01)


# ── windows ──


def _process_name(pid: int) -> str:
    try:
        import psutil

        return psutil.Process(pid).name()
    except Exception:  # noqa: BLE001 - gone, or not ours to see
        return ""


def foreground_window() -> dict[str, Any]:
    handle = user32.GetForegroundWindow()
    return window_info(handle) if handle else {}


def window_info(handle: int) -> dict[str, Any]:
    length = user32.GetWindowTextLengthW(handle)
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(handle, buffer, length + 1)
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))
    rect = wintypes.RECT()
    user32.GetWindowRect(handle, ctypes.byref(rect))
    return {
        "handle": int(handle),
        "title": buffer.value,
        "pid": int(pid.value),
        "app": _process_name(int(pid.value)),
        "x": rect.left, "y": rect.top, "w": rect.right - rect.left, "h": rect.bottom - rect.top,
        "minimized": bool(user32.IsIconic(handle)),
    }  # fmt: skip


def list_windows() -> list[dict[str, Any]]:
    """The windows you can switch to: visible, with a title, not tool windows; front first."""
    dpi_aware()
    found: list[dict[str, Any]] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    GWL_EXSTYLE, WS_EX_TOOLWINDOW = -20, 0x80
    front = user32.GetForegroundWindow()

    def visit(handle, _data):
        if not user32.IsWindowVisible(handle) or user32.GetWindowTextLengthW(handle) == 0:
            return True
        if user32.GetWindowLongW(handle, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
            return True
        info = window_info(handle)
        if info["title"] in ("Program Manager", "Windows Input Experience") or not info["w"]:
            return True
        info["front"] = int(handle) == int(front or 0)
        found.append(info)
        return True

    user32.EnumWindows(callback_type(visit), 0)
    found.sort(key=lambda w: not w["front"])
    return found


def focus_window(handle: int) -> bool:
    """Bring a window to the front and give it the keyboard. Windows only lets the foreground
    program do that, so it is done the way accessibility tools do: a tap on Alt (which makes
    the request count), the calling thread attached to the foreground window's thread for the
    moment, and the window raised. True when it is in front afterwards."""
    SW_RESTORE, SW_SHOW = 9, 5
    handle = int(handle)
    if user32.IsIconic(handle):
        user32.ShowWindow(handle, SW_RESTORE)
    if int(user32.GetForegroundWindow() or 0) == handle:
        return True
    for attempt in range(3):
        _send([_key(0x12), _key(0x12, up=True)])
        front = user32.GetForegroundWindow()
        mine = kernel32.GetCurrentThreadId()
        theirs = user32.GetWindowThreadProcessId(front, None) if front else 0
        attached = bool(theirs and theirs != mine and user32.AttachThreadInput(mine, theirs, True))
        try:
            user32.ShowWindow(handle, SW_SHOW)
            user32.BringWindowToTop(handle)
            user32.SetForegroundWindow(handle)
            user32.SetFocus(handle)
        finally:
            if attached:
                user32.AttachThreadInput(mine, theirs, False)
        time.sleep(0.15 * (attempt + 1))
        if int(user32.GetForegroundWindow() or 0) == handle:
            return True
    return False
