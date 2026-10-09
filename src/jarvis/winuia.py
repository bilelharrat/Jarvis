"""Reading and operating Windows apps through UI Automation: the interface screen readers use.

What macOS's Accessibility API (the JXA in system_voice.py) gives the Mac hands, UI Automation
gives these: the controls of the window in front, by name, in reading order, with their values
and states, and a way to press them without a coordinate. It is also what lets a blind person's
assistant work in an app whose own accessibility is poor: if Narrator or NVDA can see a control,
so can this.

Windows only (the `uiautomation` package, which drives UI Automation through COM). Every
public function is synchronous, makes its own COM apartment and is meant for a worker thread.
Nothing here ever raises for a control that vanished mid-walk: the walk skips it.
"""

from __future__ import annotations

import re
import sys
import time
from typing import Any

IS_WIN = sys.platform == "win32"

MAX_NODES = 260  # lines in an outline
MAX_CHARS = 9000
SEARCH_NODES = 4000  # controls looked at to find one by name
SEARCH_SECONDS = 4.0
LIST_SHOWN = 20  # items of a long list read out; the rest are counted

# Control types worth a line, and the words a person would use for them.
SPOKEN = {
    "ButtonControl": "button", "CheckBoxControl": "check box", "ComboBoxControl": "combo box",
    "EditControl": "edit field", "HyperlinkControl": "link", "ImageControl": "image",
    "ListItemControl": "list item", "MenuItemControl": "menu item", "MenuControl": "menu",
    "MenuBarControl": "menu bar", "RadioButtonControl": "radio button", "SliderControl": "slider",
    "SpinnerControl": "spin box", "TabControl": "tab list", "TabItemControl": "tab",
    "TextControl": "text", "TreeItemControl": "tree item", "TreeControl": "tree",
    "ToolBarControl": "toolbar", "WindowControl": "window", "DocumentControl": "document",
    "DataItemControl": "row", "HeaderItemControl": "column header", "SplitButtonControl": "split button",
    "GroupControl": "group", "ListControl": "list", "TableControl": "table", "DataGridControl": "table",
    "TitleBarControl": "title bar", "StatusBarControl": "status bar", "ProgressBarControl": "progress bar",
    "ToolTipControl": "tooltip", "AppBarControl": "app bar", "PaneControl": "pane",
}  # fmt: skip
# Pressable: tried first when a name matches more than one control.
PRESSABLE = {
    "ButtonControl", "HyperlinkControl", "MenuItemControl", "TabItemControl", "CheckBoxControl",
    "RadioButtonControl", "SplitButtonControl", "ListItemControl", "TreeItemControl", "DataItemControl",
}  # fmt: skip
SKIP_TYPES = {"ScrollBarControl", "ThumbControl", "SeparatorControl", "HeaderControl"}
CONTAINERS = {
    "ListControl",
    "TreeControl",
    "TableControl",
    "DataGridControl",
    "MenuControl",
    "TabControl",
}
BROWSERS = {
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "vivaldi.exe",
    "arc.exe",
}


def _auto():
    import uiautomation as auto

    auto.SetGlobalSearchTimeout(1.0)
    return auto


class Apartment:
    """COM for this thread, for the length of a with block."""

    def __enter__(self):
        from . import winhands

        winhands.dpi_aware()  # (UI Automation's pixels are then the mouse's pixels)
        self.auto = _auto()
        self.inner = self.auto.UIAutomationInitializerInThread(debug=False)
        self.inner.__enter__()
        return self.auto

    def __exit__(self, *exc):
        return self.inner.__exit__(*exc)


# ── raw UI Automation, one cross-process call per element ──
#
# The library's Control objects ask Windows for each property separately (a round trip to the
# app each time) and walk the raw tree. Reading a window that way takes seconds and a search
# gives up before it has seen every control. Here a CacheRequest brings back everything about an
# element in the same call that finds it, and the walk is the control view, the one screen
# readers use.

TYPE_NAMES = {
    50000: "ButtonControl", 50001: "CalendarControl", 50002: "CheckBoxControl", 50003: "ComboBoxControl",
    50004: "EditControl", 50005: "HyperlinkControl", 50006: "ImageControl", 50007: "ListItemControl",
    50008: "ListControl", 50009: "MenuControl", 50010: "MenuBarControl", 50011: "MenuItemControl",
    50012: "ProgressBarControl", 50013: "RadioButtonControl", 50014: "ScrollBarControl",
    50015: "SliderControl", 50016: "SpinnerControl", 50017: "StatusBarControl", 50018: "TabControl",
    50019: "TabItemControl", 50020: "TextControl", 50021: "ToolBarControl", 50022: "ToolTipControl",
    50023: "TreeControl", 50024: "TreeItemControl", 50025: "CustomControl", 50026: "GroupControl",
    50027: "ThumbControl", 50028: "DataGridControl", 50029: "DataItemControl", 50030: "DocumentControl",
    50031: "SplitButtonControl", 50032: "WindowControl", 50033: "PaneControl", 50034: "HeaderControl",
    50035: "HeaderItemControl", 50036: "TableControl", 50037: "TitleBarControl", 50038: "SeparatorControl",
    50040: "AppBarControl",
}  # fmt: skip
P_NAME, P_TYPE, P_OFFSCREEN, P_ENABLED, P_FOCUS = 30005, 30003, 30022, 30010, 30008
P_AUTOID, P_HELP, P_RECT, P_PID, P_PASSWORD = 30011, 30013, 30001, 30002, 30019
P_VALUE, P_READONLY, P_TOGGLE, P_SELECTED, P_EXPAND = 30045, 30046, 30086, 30079, 30070
# Whether each pattern is there at all: a property of a pattern an element doesn't have comes
# back as a placeholder object, not as "no value", so these are asked first.
A_TOGGLE, A_SELECTION, A_EXPAND, A_VALUE = 30041, 30036, 30028, 30043
CACHED = (
    P_NAME, P_TYPE, P_OFFSCREEN, P_ENABLED, P_FOCUS, P_AUTOID, P_HELP, P_RECT, P_PID, P_PASSWORD,
    P_VALUE, P_READONLY, P_TOGGLE, P_SELECTED, P_EXPAND, A_TOGGLE, A_SELECTION, A_EXPAND, A_VALUE,
)  # fmt: skip
SCOPE_ELEMENT, SCOPE_DESCENDANTS = 1, 4


class Raw:
    """The IUIAutomation interface, with a cache request that brings back every property this
    module reads along with each element."""

    def __init__(self) -> None:
        import uiautomation.uiautomation as ua

        client = ua._AutomationClient.instance()
        self.ua = ua
        self.iuia = client.IUIAutomation
        self.walker = self.iuia.ControlViewWalker
        self.cache = self.iuia.CreateCacheRequest()
        for pid in CACHED:
            self.cache.AddProperty(pid)
        self.cache.TreeScope = SCOPE_ELEMENT
        self.cache.AutomationElementMode = 1  # full: the element can still be acted on

    def node(self, el) -> dict[str, Any]:
        """An element's cached facts, as a dict (what it doesn't have comes back empty)."""

        def get(pid: int, default: Any = None) -> Any:
            try:
                return el.GetCachedPropertyValue(pid)
            except Exception:  # noqa: BLE001 - not cached, or gone
                return default

        def text(pid: int) -> str:
            value = get(pid)
            return value if isinstance(value, str) else ""

        def number(pid: int) -> int | None:
            value = get(pid)
            return value if isinstance(value, int) and not isinstance(value, bool) else None

        rect = None
        try:
            r = el.CachedBoundingRectangle
            rect = (int(r.left), int(r.top), int(r.right), int(r.bottom))
        except Exception:  # noqa: BLE001
            pass
        has_toggle, has_selection = get(A_TOGGLE) is True, get(A_SELECTION) is True
        has_expand, has_value = get(A_EXPAND) is True, get(A_VALUE) is True
        selected = get(P_SELECTED) if has_selection else None
        return {
            "el": el,
            "type": TYPE_NAMES.get(number(P_TYPE) or 0, ""),
            "name": _clean(text(P_NAME)),
            "offscreen": bool(get(P_OFFSCREEN, False)),
            "enabled": get(P_ENABLED, True) is not False,
            "focused": bool(get(P_FOCUS, False)),
            "id": _clean(text(P_AUTOID), 60),
            "help": _clean(text(P_HELP), 120),
            "rect": rect,
            "pid": number(P_PID) or 0,
            "password": get(P_PASSWORD) is True,
            "value": _clean(text(P_VALUE), 200)
            if has_value and get(P_PASSWORD) is not True
            else "",
            "readonly": bool(get(P_READONLY, False)) if has_value else False,
            "toggle": number(P_TOGGLE) if has_toggle else None,
            "selected": selected if isinstance(selected, bool) else None,
            "expand": number(P_EXPAND) if has_expand else None,
        }

    def children(self, el) -> list[Any]:
        out = []
        try:
            child = self.walker.GetFirstChildElementBuildCache(el, self.cache)
            while child:
                out.append(child)
                child = self.walker.GetNextSiblingElementBuildCache(child, self.cache)
        except Exception:  # noqa: BLE001 - the app went away mid-walk
            pass
        return out

    def everything_under(self, el) -> list[Any]:
        """Every descendant, found by Windows in one call, in document order."""
        try:
            found = el.FindAllBuildCache(
                SCOPE_DESCENDANTS, self.iuia.ControlViewCondition, self.cache
            )
            return [found.GetElement(i) for i in range(found.Length)]
        except Exception:  # noqa: BLE001
            return []

    def foreground(self) -> Any:
        """The window in front, as an element with its facts cached; None when there is none."""
        import ctypes

        handle = ctypes.windll.user32.GetForegroundWindow()
        if not handle:
            return None
        try:
            return self.iuia.ElementFromHandleBuildCache(handle, self.cache)
        except Exception:  # noqa: BLE001
            return None


def _states_of(n: dict[str, Any]) -> list[str]:
    states = []
    if not n["enabled"]:
        states.append("unavailable")
    if n["focused"]:
        states.append("focused")
    if n["toggle"] in (0, 1, 2):
        states.append({0: "off", 1: "on", 2: "partly on"}[n["toggle"]])
    if n["selected"]:
        states.append("selected")
    if n["expand"] in (0, 1, 2):  # (3 is a leaf: nothing to expand)
        states.append({0: "collapsed", 1: "expanded", 2: "partly expanded"}[n["expand"]])
    return states


def _without_query(value: str) -> str:
    """A web address without the part after a "?" or "#", where a sign-in token or a search
    can be (the page's address in its document, the address bar). Anything else as it is."""
    if re.match(r"(?i)(https?|file)://", value):
        return re.sub(r"[?#].*$", "", value)
    return value


def _facts_of(n: dict[str, Any]) -> dict[str, Any]:
    """One node as plain facts: {role, name, value, states, id, x, y}."""
    out: dict[str, Any] = {
        "role": "password field"
        if n["password"]
        else SPOKEN.get(n["type"]) or n["type"].replace("Control", "").lower() or "item",
        "name": n["name"],
        "value": _without_query(n["value"]),
        "states": _states_of(n),
        "id": n["id"],
    }
    if n["rect"]:
        left, top, right, bottom = n["rect"]
        out["x"], out["y"] = (left + right) // 2, (top + bottom) // 2
    return out


_PUNCTUATION = re.compile(r"[.,;:!?)\]”’%]+")


def _continues(before: str, piece: str) -> bool:
    """The next piece of text goes on from the last (a sentence with a bold word in it comes as
    several), rather than being a cell of its own (a status bar's "Ln 1, Col 18" then "UTF-8")."""
    if _PUNCTUATION.fullmatch(piece):
        return True
    return bool(re.match(r"[a-z(\[“‘]", piece)) and not re.search(r"[.!?;:]$", before)


def _is_text(n: dict[str, Any]) -> bool:
    """A plain piece of text: a name, nothing else about it to say."""
    return (
        n["type"] == "TextControl"
        and bool(n["name"])
        and not n["offscreen"]
        and not n["value"]
        and not _states_of(n)
    )


def _worth_a_node(n: dict[str, Any]) -> bool:
    kind, name = n["type"], n["name"]
    if kind in SKIP_TYPES or n["offscreen"]:
        return False
    if (
        kind in ("PaneControl", "CustomControl", "GroupControl", "ImageControl", "TextControl")
        and not name
    ):
        return False
    return kind in SPOKEN or bool(name)


def _clean(text: Any, limit: int = 160) -> str:
    out = re.sub(r"\s+", " ", str(text or "")).strip()
    return out if len(out) <= limit else out[: limit - 1] + "…"


def _type(ctrl) -> str:
    try:
        return ctrl.ControlTypeName
    except Exception:  # noqa: BLE001 - gone
        return ""


def _name(ctrl) -> str:
    try:
        return _clean(ctrl.Name)
    except Exception:  # noqa: BLE001
        return ""


def _children(ctrl) -> list:
    try:
        return ctrl.GetChildren()
    except Exception:  # noqa: BLE001
        return []


def _flag(ctrl, attribute: str) -> bool:
    try:
        return bool(getattr(ctrl, attribute))
    except Exception:  # noqa: BLE001
        return False


def _value(ctrl) -> str:
    """What an edit field, combo box, slider or document holds, short. Never a password's."""
    if _flag(ctrl, "IsPassword"):
        return ""
    try:
        pattern = ctrl.GetValuePattern()
        if pattern is not None:
            return _clean(_without_query(str(pattern.Value or "")), 200)
    except Exception:  # noqa: BLE001
        pass
    if _type(ctrl) in ("DocumentControl", "EditControl"):
        try:
            text = ctrl.GetTextPattern()
            if text is not None:
                return _clean(text.DocumentRange.GetText(240), 200)
        except Exception:  # noqa: BLE001
            pass
    return ""


def _states(ctrl) -> list[str]:
    states = []
    if not _flag(ctrl, "IsEnabled"):
        states.append("unavailable")
    if _flag(ctrl, "HasKeyboardFocus"):
        states.append("focused")
    try:
        toggle = ctrl.GetTogglePattern()
        if toggle is not None:
            states.append({0: "off", 1: "on", 2: "partly on"}.get(int(toggle.ToggleState), ""))
    except Exception:  # noqa: BLE001
        pass
    try:
        item = ctrl.GetSelectionItemPattern()
        if item is not None and item.IsSelected:
            states.append("selected")
    except Exception:  # noqa: BLE001
        pass
    try:
        expand = ctrl.GetExpandCollapsePattern()
        if expand is not None:
            state = int(expand.ExpandCollapseState)
            if state in (1, 3):
                states.append("expanded" if state == 1 else "partly expanded")
            elif state == 0:
                states.append("collapsed")
    except Exception:  # noqa: BLE001
        pass
    return [s for s in states if s]


def describe(ctrl) -> dict[str, Any]:
    """One control as plain facts: {role, name, value, states, id, x, y}."""
    kind = _type(ctrl)
    out: dict[str, Any] = {
        "role": "password field"
        if _flag(ctrl, "IsPassword")
        else SPOKEN.get(kind) or kind.replace("Control", "").lower() or "item",
        "name": _name(ctrl),
        "value": _value(ctrl),
        "states": _states(ctrl),
    }
    try:
        out["id"] = _clean(ctrl.AutomationId, 60)
        rect = ctrl.BoundingRectangle
        out["x"], out["y"] = int(rect.xcenter()), int(rect.ycenter())
    except Exception:  # noqa: BLE001
        pass
    return out


def _line(info: dict[str, Any]) -> str:
    text = info["role"]
    if info["name"]:
        text += f": {info['name']}"
    if info["value"] and info["value"] != info["name"]:
        text += f", contains “{info['value']}”"
    if info["states"]:
        text += f" ({', '.join(info['states'])})"
    return text


def _worth_a_line(ctrl, kind: str, name: str) -> bool:
    if kind in SKIP_TYPES:
        return False
    if _flag(ctrl, "IsOffscreen"):
        return False
    if (
        kind in ("PaneControl", "CustomControl", "GroupControl", "ImageControl", "TextControl")
        and not name
    ):
        return False
    return kind in SPOKEN or bool(name)


def _front(auto):
    return auto.GetForegroundControl()


def _window_of(auto, ctrl):
    """The top-level window a control is in."""
    try:
        top = ctrl.GetTopLevelControl()
        return top or ctrl
    except Exception:  # noqa: BLE001
        return ctrl


def front_window() -> dict[str, Any]:
    """The window in front: {title, app, pid}. {} when there's none."""
    with Apartment() as auto:
        ctrl = _front(auto)
        if ctrl is None:
            return {}
        top = _window_of(auto, ctrl)
        return {"title": _name(top), "pid": _pid(top), "app": _process_name(_pid(top))}


def _pid(ctrl) -> int:
    try:
        return int(ctrl.ProcessId)
    except Exception:  # noqa: BLE001
        return 0


def _process_name(pid: int) -> str:
    try:
        import psutil

        return psutil.Process(pid).name()
    except Exception:  # noqa: BLE001
        return ""


# ── reading ──


def outline(
    max_nodes: int = MAX_NODES, max_chars: int = MAX_CHARS, seconds: float = 8.0
) -> dict[str, Any]:
    """The window in front as an outline in reading order: a line for each control that
    says something, indented by how deep it sits. {title, app, text, lines, truncated}."""
    with Apartment():
        raw = Raw()
        top = raw.foreground()
        if top is None:
            return {
                "title": "",
                "app": "",
                "text": "No window is in front.",
                "lines": 0,
                "truncated": False,
            }
        head = raw.node(top)
        lines: list[str] = []
        used = 0
        deadline = time.monotonic() + seconds
        truncated = False

        def add(line: str) -> None:
            nonlocal used
            lines.append(line)
            used += len(line)

        def visit_all(kids: list, depth: int, parent: str = "") -> None:
            """The children in order; text that is in pieces (a sentence with a bold word in it)
            is one line, as a screen reader says it, and text that only repeats the name of the
            control it is in (a button's label) is not said twice."""
            nodes = [(kid, raw.node(kid)) for kid in kids]
            i = 0
            while i < len(nodes):
                kid, n = nodes[i]
                if _is_text(n):
                    words, j = n["name"], i + 1
                    while j < len(nodes) and _is_text(nodes[j][1]):
                        piece = nodes[j][1]["name"]
                        if not _continues(words, piece):
                            break
                        words += piece if _PUNCTUATION.fullmatch(piece) else " " + piece
                        j += 1
                    same = words.casefold() == parent.casefold()
                    if j - i > 1 or same:
                        if not same:
                            add("  " * min(depth, 8) + "text: " + words)
                        i = j
                        continue
                visit(kid, depth, n=n)
                i += 1

        def visit(el, depth: int, root: bool = False, n: dict[str, Any] | None = None) -> None:
            nonlocal truncated
            if truncated:
                return
            if len(lines) >= max_nodes or used >= max_chars or time.monotonic() > deadline:
                truncated = True
                return
            n = n or (head if root else raw.node(el))
            if n["type"] in SKIP_TYPES:
                return
            shown = (not root) and _worth_a_node(n)
            if shown:
                add("  " * min(depth, 8) + _line(_facts_of(n)))
            kids = raw.children(el)
            below = depth + (1 if shown else 0)
            if n["type"] in CONTAINERS and len(kids) > LIST_SHOWN:
                visit_all(kids[:LIST_SHOWN], depth + 1, n["name"])
                add("  " * min(depth + 1, 8) + f"… and {len(kids) - LIST_SHOWN} more")
                return
            visit_all(kids, below, n["name"] if shown else "")

        visit(top, 0, root=True)
        body = "\n".join(lines)
        if truncated:
            body += "\n… (the rest of the window is not listed)"
        return {
            "title": head["name"],
            "app": _process_name(head["pid"]),
            "text": body,
            "lines": len(lines),
            "truncated": truncated,
        }


def focused() -> dict[str, Any]:
    """What has the keyboard focus: {role, name, value, states, window, app}."""
    with Apartment() as auto:
        ctrl = auto.GetFocusedControl()
        if ctrl is None:
            return {}
        info = describe(ctrl)
        top = _window_of(auto, ctrl)
        info["window"], info["app"] = _name(top), _process_name(_pid(top))
        return info


def page_address() -> dict[str, str]:
    """The address and title of the page in the browser in front: {url, title, app}."""
    with Apartment():
        raw = Raw()
        top = raw.foreground()
        if top is None:
            return {}
        head = raw.node(top)
        app = _process_name(head["pid"])
        if app.lower() not in BROWSERS:
            return {}
        url = title = ""
        for el in raw.everything_under(top)[:800]:
            n = raw.node(el)
            if not url and n["type"] == "EditControl":
                if re.search(r"address|url|search or enter", n["name"], re.I):
                    url = n["value"]
            elif not title and n["type"] == "DocumentControl" and n["name"]:
                title = n["name"]  # (the window's title adds the browser, and often a profile)
            if url and title:
                break
        return {
            "url": url,
            "title": title or re.sub(r" [-–—] [^-–—]+$", "", head["name"]),
            "app": app,
        }


# ── finding and pressing ──


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().casefold()


def find_controls(name: str, limit: int = 8, exact: bool = False) -> list[dict[str, Any]]:
    """Controls in the window in front whose name is `name` (best matches first)."""
    with Apartment():
        raw = Raw()
        return [_facts_of(n) | {"_rank": r} for n, r in _search(raw, name, limit, exact)]


def _search(
    raw: Raw, name: str, limit: int = 8, exact: bool = False
) -> list[tuple[dict[str, Any], int]]:
    top = raw.foreground()
    want = _norm(name)
    if top is None or not want:
        return []
    found: list[tuple[int, int, dict[str, Any]]] = []
    for order, el in enumerate(raw.everything_under(top)):
        try:
            label = _norm(el.GetCachedPropertyValue(P_NAME) or "")
        except Exception:  # noqa: BLE001
            continue
        if not label:
            continue
        if label == want:
            rank = 0
        elif not exact and label.startswith(want):
            rank = 1
        elif not exact and want in label:
            rank = 2
        else:
            continue
        n = raw.node(el)
        if n["type"] in SKIP_TYPES or n["offscreen"]:
            continue
        # Pressable and enabled controls beat a text label of the same name.
        found.append((rank + (0 if n["type"] in PRESSABLE else 3), order, n))
    found.sort(key=lambda t: (t[0], t[1]))
    return [(n, r) for r, _o, n in found[:limit]]


def press(
    name: str, how: str = "click", find_only: bool = False, exact: bool = False
) -> dict[str, Any]:
    """Press the control called `name` in the window in front. how: click, double click or
    right click. Returns {found, name, app, labels, x?, y?}: x and y only when it has to be
    clicked with the mouse (no Invoke, Toggle, Select or Expand to do it with). find_only: look,
    press nothing."""
    with Apartment():
        raw = Raw()
        hits = _search(raw, name, 1, exact)
        if not hits:
            front = raw.foreground()
            return {
                "found": False,
                "app": _process_name(raw.node(front)["pid"]) if front is not None else "",
            }
        node = hits[0][0]
        info = _facts_of(node)
        out: dict[str, Any] = {
            "found": True,
            "name": info["name"],
            "app": _process_name(node["pid"]),
            "labels": [x for x in (info["name"], node["help"], info["id"]) if x],
        }
        if find_only:
            return out
        if how == "click":
            ctrl = raw.ua.Control.CreateControlFromElement(node["el"])
            for getter, act in (
                ("GetInvokePattern", lambda p: p.Invoke()),
                ("GetTogglePattern", lambda p: p.Toggle()),
                ("GetSelectionItemPattern", lambda p: p.Select()),
                ("GetExpandCollapsePattern", lambda p: p.Expand()),
            ):
                try:
                    pattern = getattr(ctrl, getter)()
                    if pattern is not None:
                        act(pattern)
                        return out
                except Exception:  # noqa: BLE001 - this way didn't work: the next, then the mouse
                    continue
        if "x" in info:
            out["x"], out["y"] = info["x"], info["y"]
        return out


def set_text(name: str, text: str) -> dict[str, Any]:
    """Put text in the edit field called `name` (or the one with the focus when name is
    empty), replacing what it held. {ok: False} when it can't."""
    with Apartment():
        raw = Raw()
        node = None
        if name:
            for n, _r in _search(raw, name, 6):
                if n["type"] in ("EditControl", "ComboBoxControl", "DocumentControl"):
                    node = n
                    break
        else:
            focus = raw.ua.GetFocusedControl()
            if focus is not None:
                node = {"el": focus.Element, "name": _name(focus)}
        if node is None:
            return {"ok": False}
        try:
            pattern = raw.ua.Control.CreateControlFromElement(node["el"]).GetValuePattern()
            if pattern is not None and not pattern.IsReadOnly:
                pattern.SetValue(text)
                return {"ok": True, "name": node["name"]}
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "name": node["name"]}


# ── what the hands guard asks: the app in front, and what is under a point ──


def _facts(ctrl) -> dict[str, Any]:
    """A control as the guard (hands_guard.py) reads one: title, help, identifier, whether it
    takes text, and what it holds."""
    kind = _type(ctrl)
    editable = kind in ("EditControl", "DocumentControl")
    if kind == "ComboBoxControl":
        editable = True
    out: dict[str, Any] = {
        "role": "AXTextField" if editable else kind,
        "title": _name(ctrl),
        "help": _clean(getattr(ctrl, "HelpText", ""), 120) if _safe(ctrl, "HelpText") else "",
        "identifier": _clean(getattr(ctrl, "AutomationId", ""), 60)
        if _safe(ctrl, "AutomationId")
        else "",
        "editable": editable,
    }
    if editable:
        out["value"] = _value(ctrl)
    return out


def _safe(ctrl, attribute: str) -> bool:
    try:
        getattr(ctrl, attribute)
        return True
    except Exception:  # noqa: BLE001
        return False


def _app_of(ctrl) -> dict[str, str]:
    top = ctrl
    try:
        top = ctrl.GetTopLevelControl() or ctrl
    except Exception:  # noqa: BLE001
        pass
    exe = _process_name(_pid(top))
    stem = exe.rsplit(".", 1)[0] if exe else ""
    return {"app": stem.replace("-", " ").title(), "bundle": exe.lower(), "window": _name(top)}


def probe_focus() -> dict[str, Any]:
    """{app, bundle (the program's file name), window, focused, trusted}: the app in front
    and the control with the keyboard."""
    with Apartment() as auto:
        front = _front(auto)
        if front is None:
            return {}
        info = _app_of(front)
        focus = None
        try:
            focus = auto.GetFocusedControl()
        except Exception:  # noqa: BLE001
            focus = None
        return {**info, "focused": _facts(focus) if focus is not None else {}, "trusted": True}


def probe_point(x: float, y: float) -> dict[str, Any]:
    """What is at a point: the control there, the nearest one up from it that presses, the
    app and window it is in."""
    with Apartment() as auto:
        hit = auto.ControlFromPoint(int(x), int(y))
        if hit is None:
            return {"trusted": True}
        info = _app_of(hit)
        press = None
        node = hit
        for _ in range(7):
            if node is None:
                break
            if _type(node) in PRESSABLE:
                press = node
                break
            try:
                node = node.GetParentControl()
            except Exception:  # noqa: BLE001
                break
        focus = None
        try:
            focus = auto.GetFocusedControl()
        except Exception:  # noqa: BLE001
            focus = None
        return {
            "at": _facts(hit),
            "press": _facts(press) if press is not None else None,
            "at_app": info["app"], "at_bundle": info["bundle"], "at_window": info["window"],
            "at_focused": _facts(focus) if focus is not None else {},
            "trusted": True,
        }  # fmt: skip
