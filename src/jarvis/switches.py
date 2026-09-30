"""The Mac's switches: dark mode, Wi-Fi, Bluetooth and Focus (Do Not Disturb is a Focus).

- Dark mode: System Events' appearance preferences (Automation for System Events).
- Wi-Fi: networksetup, on the Wi-Fi hardware port.
- Bluetooth: macOS has no command for it; blueutil does (Homebrew: brew install blueutil).
  Without it, JARVIS says so.
- Focus: macOS has no command either, so it goes through the owner's Shortcuts: one named for
  the mode and whether it goes on or off ("Work Focus On", "Do Not Disturb Off", "Focus
  Off"), made with Shortcuts' Set Focus action. focus_shortcut finds it by its name.

Reading a switch is safe; changing one goes through mac_gate.operate (the features' rule).
Every command here is run through the run_command passed in, so tests run none.
"""

from __future__ import annotations

import os
import re
import shutil
from collections.abc import Awaitable, Callable
from typing import Any

from . import mac_tools

Command = Callable[..., Awaitable[str]]

SWITCHES = ("dark_mode", "wifi", "bluetooth", "focus")
BLUEUTIL_PATHS = ("/opt/homebrew/bin/blueutil", "/usr/local/bin/blueutil")
DARK_SET = """on run argv
    tell application "System Events" to tell appearance preferences to set dark mode to ((item 1 of argv) is "on")
end run"""
DARK_GET = 'tell application "System Events" to tell appearance preferences to get dark mode'
NO_BLUEUTIL = (
    "macOS has no command for Bluetooth. With Homebrew's blueutil installed (brew install "
    "blueutil), I can switch it; until then, use Control Centre."
)
_ON_WORDS = frozenset(
    {"on", "start", "begin", "enable", "activate", "starts", "开", "打开", "开启"}
)
_OFF_WORDS = frozenset(
    {"off", "stop", "end", "disable", "deactivate", "ends", "关", "关闭", "关掉"}
)
_FOCUS_WORDS = frozenset({"focus", "dnd", "disturb", "专注", "勿扰"})
_MODE_ALIASES = {"dnd": "do not disturb", "勿扰": "do not disturb", "请勿打扰": "do not disturb"}


class Unavailable(RuntimeError):
    """This switch can't be worked on this Mac (no blueutil, no Wi-Fi port, no shortcut)."""


def _tokens(text: str) -> list[str]:
    return re.findall(r"[^\W_]+", str(text or "").lower())


def blueutil() -> str | None:
    found = shutil.which("blueutil")
    if found:
        return found
    return next((p for p in BLUEUTIL_PATHS if os.access(p, os.X_OK)), None)


def wifi_device(ports: str) -> str | None:
    """The Wi-Fi hardware port's device (en0 on most Macs), from networksetup's list."""
    for block in re.split(r"\n\s*\n", ports or ""):
        if re.search(r"Hardware Port:\s*(?:Wi-Fi|AirPort)\s*$", block, re.MULTILINE):
            found = re.search(r"Device:\s*(\S+)", block)
            if found:
                return found.group(1)
    return None


def _says(words: list[str], joined: str, vocab: frozenset[str]) -> bool:
    """A word of vocab is in the name: a whole word, or inside a Chinese one ("专注模式")."""
    return bool(vocab & set(words)) or any(v in joined for v in vocab if not v.isascii())


def focus_shortcut(names: list[str], mode: str, on: bool) -> tuple[str | None, list[str]]:
    """The owner's shortcut for this Focus change: (the one, []) or (None, the candidates
    when several could be meant). mode "" with on False: any shortcut that turns Focus off.
    Names are read in either language ("Work Focus On", "工作专注模式 开")."""
    mode = _MODE_ALIASES.get(mode.strip().lower(), mode.strip().lower())
    wanted = [w for w in _tokens(mode) if w not in ("focus", "mode")]
    hits = []
    for name in names:
        words = _tokens(name)
        joined = " ".join(words)
        if not (_says(words, joined, _FOCUS_WORDS) or "do not disturb" in joined):
            continue
        says_off = _says(words, joined, _OFF_WORDS)
        says_on = _says(words, joined, _ON_WORDS) and not says_off
        if on and (says_off or not (says_on or wanted)):
            continue
        if not on and not says_off:
            continue
        if mode == "do not disturb":
            if not ({"dnd", "disturb"} & set(words) or "勿扰" in joined):
                continue
        elif wanted and not all(w in words or (not w.isascii() and w in joined) for w in wanted):
            continue
        extra = [w for w in words if w not in _FOCUS_WORDS | _ON_WORDS | _OFF_WORDS]
        extra = [w for w in extra if w not in wanted and w not in ("turn", "set", "the", "mode")]
        hits.append((len(extra), name))
    if not hits:
        return None, []
    hits.sort()
    best = [name for score, name in hits if score == hits[0][0]]
    return (best[0], []) if len(best) == 1 else (None, best)


class Switches:
    def __init__(
        self,
        command: Command | None = None,
        applescript: Command | None = None,
        shortcuts: Any = None,
    ) -> None:
        self.command = command or mac_tools.run_command
        self.applescript = applescript or mac_tools.run_applescript
        self.shortcuts = shortcuts  # home.Shortcuts: the Mac's shortcut names, and run()

    # ── reading ──

    async def dark_mode(self) -> bool:
        return (await self.applescript(DARK_GET, timeout=15)).strip() == "true"

    async def _wifi_device(self) -> str:
        device = wifi_device(await self.command("networksetup", "-listallhardwareports"))
        if device is None:
            raise Unavailable("This Mac has no Wi-Fi.")
        return device

    async def wifi(self) -> bool:
        device = await self._wifi_device()
        out = await self.command("networksetup", "-getairportpower", device)
        return out.strip().lower().endswith(": on")

    async def bluetooth(self) -> bool:
        tool = blueutil()
        if tool is None:
            raise Unavailable(NO_BLUEUTIL)
        return (await self.command(tool, "--power")).strip() == "1"

    async def status(self) -> dict[str, Any]:
        """Each switch it can read: True, False, or why it can't say."""
        out: dict[str, Any] = {}
        for name, read in (
            ("dark_mode", self.dark_mode),
            ("wifi", self.wifi),
            ("bluetooth", self.bluetooth),
        ):
            try:
                out[name] = await read()
            except (Unavailable, mac_tools.ToolFailure) as exc:
                out[name] = str(exc)
        return out

    # ── changing ──

    async def set_dark_mode(self, on: bool) -> str:
        await self.applescript(DARK_SET, "on" if on else "off", timeout=15)
        return "Dark mode is on." if on else "Dark mode is off."

    async def set_wifi(self, on: bool) -> str:
        device = await self._wifi_device()
        await self.command("networksetup", "-setairportpower", device, "on" if on else "off")
        return "Wi-Fi is on." if on else "Wi-Fi is off."

    async def set_bluetooth(self, on: bool) -> str:
        tool = blueutil()
        if tool is None:
            raise Unavailable(NO_BLUEUTIL)
        await self.command(tool, "--power", "1" if on else "0")
        return "Bluetooth is on." if on else "Bluetooth is off."

    async def find_focus(self, mode: str, on: bool) -> str:
        """The shortcut that makes this Focus change; Unavailable says what to make."""
        names = await self.shortcuts.refresh() if self.shortcuts is not None else []
        name, several = focus_shortcut(names, mode, on)
        if name is None and not several and not on and mode:
            name, several = focus_shortcut(names, "", on)  # "Focus Off" ends any of them
        if name is not None:
            return name
        if several:
            raise Unavailable(
                "Several shortcuts could do that: "
                + ", ".join(f"“{n}”" for n in several[:5])
                + ". Ask the user which one."
            )
        example = f"{mode.title()} Focus {'On' if on else 'Off'}" if mode else "Focus Off"
        raise Unavailable(
            "macOS lets Focus change only through Shortcuts. Make a shortcut named like "
            f"“{example}” with Shortcuts' Set Focus action, and I'll use it."
        )

    async def set_focus(self, shortcut: str, mode: str, on: bool) -> str:
        await self.command("shortcuts", "run", shortcut, timeout=60)
        what = f"The {mode} Focus" if mode else "Focus"
        return f"{what} is {'on' if on else 'off'} (ran “{shortcut}”)."
