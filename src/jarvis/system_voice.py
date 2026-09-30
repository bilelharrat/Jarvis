"""Instant voice control of the whole Mac: "open Safari", "switch to Mail", "scroll down",
"press command shift T", "click Save", "new tab", "volume up"… run at once, without a
round trip to Claude. Anything else (and anything this can't do) goes to Claude as before,
where the see-the-screen, click and type tools handle the rest.

These are the user's own spoken words, so with Settings › Control my Mac without asking on
(the default) "click Send" presses Send: in a messaging or mail app only while the
conversation hasn't read private data or a web page (then the send's card comes first, as
hands_guard has it). A button that buys, books or pays is never pressed outside the
built-in browser. With the setting off, buttons that send, pay, buy, delete or sign out
are left for the user to press. A button is found first and pressed only once its name is
checked.

Posting keys and clicks needs the Accessibility permission of the app running JARVIS;
clicking a button by its name also needs Automation for System Events.
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from . import computer
from .mac_tools import ToolFailure, run_command

# A button whose name has one of these words is the user's to press.
RISKY = re.compile(
    r"\b(send|pay|buy|purchase|order|checkout|check out|delete|remove|erase|trash|empty|"
    r"sign out|log out|logout|transfer|submit|confirm|subscribe|unsubscribe|install|"
    r"uninstall|format|reset|wipe|post|publish|approve|accept|allow)\b",
    re.IGNORECASE,
)

# Spoken key names -> computer.parse_keys names.
SPOKEN_KEYS = {
    "command": "cmd", "cmd": "cmd", "option": "option", "alt": "option", "control": "ctrl",
    "ctrl": "ctrl", "shift": "shift", "enter": "return", "return": "return", "escape": "escape",
    "esc": "escape", "tab": "tab", "space": "space", "spacebar": "space", "delete": "delete",
    "backspace": "delete", "forward delete": "forwarddelete", "up": "up", "down": "down",
    "left": "left", "right": "right", "home": "home", "end": "end", "page up": "pageup",
    "page down": "pagedown", "comma": ",", "period": ".", "dot": ".", "slash": "/",
    "minus": "-", "dash": "-", "equals": "=", "plus": "=", "semicolon": ";",
    "left bracket": "[", "right bracket": "]", "quote": "'",
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6",
    "seven": "7", "eight": "8", "nine": "9",
}  # fmt: skip

# Everyday actions as key presses (in the app in front).
ACTIONS = {
    "new tab": "cmd+t", "close tab": "cmd+w", "close this tab": "cmd+w", "close window": "cmd+w",
    "close this window": "cmd+w", "new window": "cmd+n", "next tab": "ctrl+tab",
    "previous tab": "ctrl+shift+tab", "reopen tab": "cmd+shift+t", "reopen closed tab": "cmd+shift+t",
    "minimize": "cmd+m", "minimize window": "cmd+m", "minimise window": "cmd+m",
    "full screen": "ctrl+cmd+f", "fullscreen": "ctrl+cmd+f", "enter full screen": "ctrl+cmd+f",
    "exit full screen": "ctrl+cmd+f", "undo": "cmd+z", "undo that": "cmd+z", "redo": "cmd+shift+z",
    "copy": "cmd+c", "copy that": "cmd+c", "paste": "cmd+v", "paste it": "cmd+v", "cut": "cmd+x",
    "select all": "cmd+a", "save": "cmd+s", "save it": "cmd+s", "find": "cmd+f",
    "reload": "cmd+r", "refresh": "cmd+r", "reload the page": "cmd+r", "refresh the page": "cmd+r",
    "go back": "cmd+[", "go forward": "cmd+]", "zoom in": "cmd+=", "zoom out": "cmd+-",
    "actual size": "cmd+0", "take a screenshot": "cmd+shift+3", "screenshot": "cmd+shift+3",
    "lock the screen": "ctrl+cmd+q", "lock screen": "ctrl+cmd+q", "lock my mac": "ctrl+cmd+q",
    "spotlight": "cmd+space", "open spotlight": "cmd+space", "switch apps": "cmd+tab",
    "hide this app": "cmd+h", "print": "cmd+p", "scroll to the top": "cmd+up",
    "scroll to the bottom": "cmd+down", "go to the top": "cmd+up", "go to the bottom": "cmd+down",
}  # fmt: skip

POLITE = re.compile(
    r"^(?:please\s+|can you\s+|could you\s+|would you\s+|now\s+)+|\s+(?:please|now|for me)$"
)


@dataclass
class Command:
    kind: (
        str  # open | focus | quit | hide | keys | scroll | click | point | type | volume | mission
    )
    arg: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


def _said(text: str) -> str:
    t = re.sub(r"\s+", " ", text.strip().lower()).strip(" .!?")
    previous = None
    while previous != t:
        previous, t = t, POLITE.sub("", t).strip()
    return t


def spoken_keys(words: str) -> str | None:
    """'command shift t' -> 'cmd+shift+t'; None if a word isn't a key."""
    words = re.sub(r"\b(and|plus|the|key)\b", " ", words.lower())
    words = re.sub(r"\barrow\b", " ", words)
    tokens: list[str] = []
    parts = words.split()
    i = 0
    while i < len(parts):
        pair = " ".join(parts[i : i + 2])
        if pair in SPOKEN_KEYS:
            tokens.append(SPOKEN_KEYS[pair])
            i += 2
            continue
        word = parts[i]
        if word in SPOKEN_KEYS:
            tokens.append(SPOKEN_KEYS[word])
        elif re.fullmatch(r"[a-z0-9]|f(?:[1-9]|1[0-2])", word):
            tokens.append(word)
        else:
            return None
        i += 1
    if not tokens:
        return None
    combo = "+".join(tokens)
    try:
        computer.parse_keys(combo)
    except ValueError:
        return None
    return combo


def parse(text: str) -> Command | None:
    """A request as an instant Mac command, or None (it goes to Claude)."""
    said = _said(text)
    if not said or len(said) > 120:
        return None
    if said in ACTIONS:
        return Command("keys", ACTIONS[said], {"name": said})
    if said in ("mission control", "show all windows", "show me all windows"):
        return Command("mission")
    m = re.fullmatch(r"(?:press|hit|push)\s+(.+)", said)
    if m:
        combo = spoken_keys(m.group(1))
        return Command("keys", combo, {"name": m.group(1)}) if combo else None
    m = re.fullmatch(r"scroll\s+(up|down|left|right)(?:\s+(a lot|a bit|a little|more|some))?", said)
    if m:
        amount = {"a lot": 30, "more": 20, "a bit": 4, "a little": 4}.get(m.group(2) or "", 10)
        return Command("scroll", m.group(1), {"amount": amount})
    m = re.fullmatch(r"page\s+(up|down)", said)
    if m:
        return Command("keys", f"page{m.group(1)}", {"name": said})
    m = re.fullmatch(r"(?:turn (?:the )?volume|volume)\s+(up|down)", said) or re.fullmatch(
        r"(?:make it\s+)?(louder|quieter|softer)", said
    )
    if m:
        up = m.group(1) in ("up", "louder")
        return Command("volume", "up" if up else "down")
    if said in ("mute", "mute the sound", "mute sound", "unmute", "unmute the sound"):
        return Command("volume", "unmute" if said.startswith("unmute") else "mute")
    m = re.fullmatch(r"(?:set (?:the )?volume to|volume to)\s+(\d{1,3})(?:\s*(?:%|percent))?", said)
    if m:
        return Command("volume", "set", {"level": min(100, int(m.group(1)))})
    m = re.fullmatch(
        r"(double[ -]click|right[ -]click|click)(?:\s+(?:on\s+)?(?:the\s+)?(.+?))?", said
    )
    if m:
        how = m.group(1).replace("-", " ")
        label = re.sub(r"\s+(button|link|tab|menu)$", "", (m.group(2) or "").strip())
        if not label or label in ("here", "that", "it", "this"):
            return Command("point", how)
        return Command("click", label, {"how": how})
    # Only "type …": "write down that…" is a note for Claude, not keys for the app in front.
    m = re.fullmatch(r"type\s+(.+)", text.strip().rstrip("."), re.IGNORECASE)
    if m and not said.startswith("type of"):
        return Command("type", m.group(1).strip())
    m = re.fullmatch(r"(?:open|launch)\s+(?:the\s+)?(?:app\s+)?(.+?)(?:\s+app)?", said)
    if m:
        return Command("open", m.group(1))
    # (not "show me…": "show me the weather" is a question, not the Weather app)
    m = re.fullmatch(r"(?:switch to|go to|bring up)\s+(?:the\s+)?(.+?)(?:\s+app)?", said)
    if m:
        return Command("focus", m.group(1))
    m = re.fullmatch(r"(?:quit|close)\s+(?:the\s+)?(.+?)(?:\s+app)?", said)
    if m:
        return Command("quit", m.group(1))
    m = re.fullmatch(r"hide\s+(?:the\s+)?(.+?)(?:\s+app)?", said)
    if m:
        return Command("hide", m.group(1))
    return None


# ── carrying it out ──

Runner = Callable[..., Awaitable[str]]


def _apple_string(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


async def _app_name(run: Runner, spoken: str) -> str | None:
    """The installed app a spoken name means ("chrome" -> "Google Chrome"), or None."""
    spoken = spoken.strip()
    if not re.fullmatch(r"[\w .&'+-]{1,40}", spoken):
        return None
    words = spoken.lower()
    try:
        found = await run(
            "mdfind",
            "kMDItemContentType == 'com.apple.application-bundle'",
            timeout=4,
        )
    except ToolFailure:
        return None
    names = []
    for line in found.splitlines():
        name = line.rsplit("/", 1)[-1].removesuffix(".app")
        if name:
            names.append(name)
    exact = [n for n in names if n.lower() == words]
    if exact:
        return exact[0]
    starts = [n for n in names if n.lower().startswith(words) or words in n.lower().split()]
    contains = [n for n in names if words in n.lower()]
    for group in (starts, contains):
        if group:
            return min(group, key=len)
    return None


# argv: the name, how (click, double click, right click; or find, which presses nothing
# and says what it would press, with all its labels), and "exact" to take only a control
# named exactly that (the one a find just reported).
CLICK_JXA = r"""
function run(argv) {
  const want = argv[0].toLowerCase(), how = argv[1], exact = argv[2] === 'exact';
  const se = Application('System Events');
  const proc = se.processes.whose({ frontmost: true })[0];
  const label = (el) => {
    const out = [];
    for (const k of ['name', 'description', 'title', 'value']) {
      try { const v = el[k](); if (typeof v === 'string' && v) out.push(v.toLowerCase().trim()); } catch (e) {}
    }
    return out;
  };
  const pressable = /AXButton|AXLink|AXCheckBox|AXRadioButton|AXPopUpButton|AXMenuButton|AXMenuBarItem|AXTab|AXCell|AXRow|AXMenuItem/;
  let best = null, bestScore = 0, bestName = '';
  const consider = (el) => {
    let role = '';
    try { role = el.role(); } catch (e) { return; }
    if (!pressable.test(role)) return;
    for (const name of label(el)) {
      const score = name === want ? 3 : exact ? 0 : name.startsWith(want) ? 2 : name.includes(want) ? 1 : 0;
      if (score > bestScore) { best = el; bestScore = score; bestName = name; }
    }
  };
  try { for (const item of proc.menuBars[0].menuBarItems()) consider(item); } catch (e) {}
  const wins = proc.windows();
  if (wins.length && bestScore < 3) {
    for (const el of wins[0].entireContents()) { consider(el); if (bestScore === 3) break; }
  }
  if (!best) return JSON.stringify({ found: false, app: proc.name() });
  if (how === 'find') return JSON.stringify({ found: true, name: bestName, labels: label(best), app: proc.name() });
  if (how === 'click') {
    try { best.actions.byName('AXPress').perform(); return JSON.stringify({ found: true, name: bestName, app: proc.name() }); } catch (e) {}
  }
  const p = best.position(), s = best.size();
  return JSON.stringify({ found: true, name: bestName, app: proc.name(), x: p[0] + s[0] / 2, y: p[1] + s[1] / 2 });
}
"""


async def carry_out(
    command: Command,
    run: Runner = run_command,
    post: Any = computer,
    free: bool = False,
    guard: Any = None,
) -> str | None:
    """Does it and says what happened; None when it isn't one after all (an app name that
    isn't an installed app), so the request goes to Claude instead. guard
    (hands_guard.HandsGuard): a press that would pay or send a message is checked there
    first, and its answer is the reply."""
    kind, arg = command.kind, command.arg
    said = str(command.extra.get("name") or arg)  # the user's own words for this press
    if kind in ("open", "focus", "quit", "hide"):
        name = await _app_name(run, arg)
        if name is None:
            return None
        quoted = _apple_string(name)
        if kind == "open" or kind == "focus":
            await run("open", "-a", name, timeout=10)
            return f"Switched to {name}." if kind == "focus" else f"Opening {name}."
        if kind == "quit":
            await run("osascript", "-e", f"tell application {quoted} to quit", timeout=10)
            return f"Quitting {name}."
        await run(
            "osascript",
            "-e",
            f'tell application "System Events" to set visible of process {quoted} to false',
            timeout=10,
        )
        return f"Hid {name}."
    if kind == "keys":
        if guard is not None and (why := await guard.keys(arg, said=said)):
            return why
        post._post_keys(arg)
        return "Done."
    if kind == "mission":
        await run("open", "-a", "Mission Control", timeout=5)
        return "Mission Control."
    if kind == "scroll":
        amount = int(command.extra.get("amount", 10))
        dy = amount if arg == "up" else -amount if arg == "down" else 0
        dx = amount if arg == "left" else -amount if arg == "right" else 0
        post._post_scroll(dy, dx)
        return "Scrolled."
    if kind == "volume":
        script = {
            "up": "set volume output volume ((output volume of (get volume settings)) + 12)",
            "down": "set volume output volume ((output volume of (get volume settings)) - 12)",
            "mute": "set volume with output muted",
            "unmute": "set volume without output muted",
            "set": f"set volume output volume {int(command.extra.get('level', 50))}",
        }[arg]
        await run("osascript", "-e", script, timeout=5)
        return {
            "up": "Louder.",
            "down": "Quieter.",
            "mute": "Muted.",
            "unmute": "Sound's back.",
        }.get(arg, f"Volume {command.extra.get('level')}%.")
    if kind == "point":
        x, y = post.mouse_position()
        # "Click" alone doesn't say what's under the pointer: a send there still asks.
        if (
            guard is not None
            and arg != "right click"
            and (why := await guard.click(x, y, own=True))
        ):
            return why
        clicks = 2 if arg == "double click" else 1
        post._post_mouse(
            "click", x, y, button="right" if arg == "right click" else "left", clicks=clicks
        )
        return "Clicked."
    if kind == "click":
        if not free and RISKY.search(arg):
            return f"“{arg}” is one I leave for you to press."
        how = command.extra.get("how", "click")
        target, exact = arg, ()
        try:
            if guard is not None or not free:
                # Found first, pressing nothing, and pressed only once its name is checked
                # ("click sen" must not press Send before anyone looks), then only a
                # control named exactly that.
                raw = await run(
                    "osascript", "-l", "JavaScript", "-e", CLICK_JXA, "--", arg, "find", timeout=6
                )
                found = json.loads(raw.strip().splitlines()[-1])
                if not found.get("found"):
                    return f"I don't see “{arg}” in {found.get('app') or 'the app in front'}."
                target = str(found.get("name") or arg)
                if not free and RISKY.search(target):
                    return f"“{target}” is one I leave for you to press."
                if guard is not None and how != "right click":
                    labels = [target, *(found.get("labels") or [])]
                    app = str(found.get("app") or "")
                    if why := await guard.press(labels, app=app, said=f"click {arg}"):
                        return why
                exact = ("exact",)
            raw = await run(
                "osascript",
                "-l",
                "JavaScript",
                "-e",
                CLICK_JXA,
                "--",
                target,
                how,
                *exact,
                timeout=6,
            )
            found = json.loads(raw.strip().splitlines()[-1])
        except (ToolFailure, ValueError, IndexError):
            return f"I couldn't look for “{arg}” on the screen. Is Accessibility allowed?"
        if not found.get("found"):
            return f"I don't see “{arg}” in {found.get('app') or 'the app in front'}."
        if not free and RISKY.search(found.get("name", "")):
            return f"“{found['name']}” is one I leave for you to press."
        if "x" in found:  # no press action (or a double or right click): a real click on it
            clicks = 2 if how == "double click" else 1
            button = "right" if how == "right click" else "left"
            post._post_mouse(
                "click", float(found["x"]), float(found["y"]), button=button, clicks=clicks
            )
        return "Done."
    if kind == "type":
        if guard is not None and (why := await guard.typing(arg, said=said)):
            return why
        post._post_text(arg)
        return "Typed."
    return None
