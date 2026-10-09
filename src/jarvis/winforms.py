"""Forms on a PC, for someone who can't see them: the fields of the form in the window in front
(what each is called, what kind it is, what it holds, whether it must be filled), and filling
them one at a time, each read back after it is filled.

Through UI Automation (winuia.py), the interface Narrator and NVDA read: a text box gets its
answer through its value, a check box is toggled to yes or no, an option is selected, a
drop-down that can't be typed in is opened and its item chosen. Nothing is typed with the
keyboard, so nothing lands in the wrong place if the window in front changes: each field is
found again by its number in the same window (by its handle), and its label must still match.
A password field is never read or filled.

Windows only; every function is synchronous, makes its own COM apartment and is meant for a
worker thread.
"""

from __future__ import annotations

import re
from typing import Any

from .winuia import Apartment, Raw, _norm, _process_name

FIELD_TYPES = {
    "EditControl": "text field",
    "ComboBoxControl": "drop-down",
    "CheckBoxControl": "check box",
    "RadioButtonControl": "option",
    "SpinnerControl": "number box",
    "SliderControl": "slider",
}
MAX_FIELDS = 80
YES_WORDS = {"yes", "y", "true", "on", "check", "checked", "tick", "ticked", "select", "selected", "1", "x"}  # fmt: skip
NO_WORDS = {"no", "n", "false", "off", "uncheck", "unchecked", "untick", "clear", "0", "none"}
REQUIRED_WORDS = re.compile(r"\*\s*$|\(required\)|\brequired\b|\bmandatory\b", re.I)


def _label(nodes: list[dict[str, Any]], index: int) -> str:
    """What a field is called: its own name, else its help text, else the text just before it
    (a label beside a box), else its automation id."""
    n = nodes[index]
    if n["name"]:
        return n["name"]
    if n["help"]:
        return n["help"]
    for back in range(index - 1, max(-1, index - 4), -1):
        before = nodes[back]
        if before["type"] == "TextControl" and before["name"]:
            return before["name"]
        if before["type"] in FIELD_TYPES:
            break
    return n["id"] or ""


def describe_field(nodes: list[dict[str, Any]], index: int, group: str = "") -> dict[str, Any]:
    """One field as plain facts: {label, kind, value, required, group, enabled, readonly}."""
    n = nodes[index]
    label = _label(nodes, index)
    kind = "password field" if n["password"] else FIELD_TYPES[n["type"]]
    required = n.get("required") is True or bool(REQUIRED_WORDS.search(f"{label} {n['help']}"))
    if n["type"] == "CheckBoxControl":
        value = {0: "not checked", 1: "checked", 2: "partly checked"}.get(n["toggle"], "")
    elif n["type"] == "RadioButtonControl":
        value = "selected" if n["selected"] else "not selected"
    else:
        value = "" if n["password"] else n["value"]
    return {
        "label": label.rstrip(" *:") or f"unlabelled {kind}",
        "kind": kind,
        "value": value,
        "required": required,
        "group": group,
        "enabled": n["enabled"],
        "readonly": n["readonly"],
    }


def _fields(raw: Raw, top) -> tuple[list[dict[str, Any]], list[tuple[int, str]]]:
    """Every control under the window (as facts) and, in reading order, the place of each
    fillable one with the group it sits in (a set of options' question)."""
    nodes = [raw.node(el) for el in raw.everything_under(top)]
    places: list[tuple[int, str]] = []
    groups: list[tuple[str, tuple[int, int, int, int]]] = []
    for i, n in enumerate(nodes):
        if n["type"] == "GroupControl" and n["name"] and n["rect"]:
            groups.append((n["name"], n["rect"]))
        if n["type"] in FIELD_TYPES and not n["offscreen"]:
            group = ""
            if n["type"] in ("RadioButtonControl", "CheckBoxControl") and n["rect"]:
                # The innermost group drawn around it (the walk is flat: the box tells).
                x = (n["rect"][0] + n["rect"][2]) / 2
                y = (n["rect"][1] + n["rect"][3]) / 2
                for name, (left, top, right, bottom) in reversed(groups):
                    if left <= x <= right and top <= y <= bottom:
                        group = name
                        break
            places.append((i, group))
    return nodes, places[:MAX_FIELDS]


def form_fields(handle: int = 0) -> dict[str, Any]:
    """The fields of the form in the window in front (or the window with this handle):
    {title, app, handle, fields: [{number, label, kind, value, required, group, ...}]}."""
    with Apartment():
        raw = Raw()
        handle = handle or raw.foreground_handle()
        top = raw.window(handle)
        if top is None:
            return {"title": "", "app": "", "handle": 0, "fields": []}
        head = raw.node(top)
        nodes, places = _fields(raw, top)
        fields = [
            {"number": k, **describe_field(nodes, i, group)}
            for k, (i, group) in enumerate(places, 1)
        ]
        return {
            "title": head["name"],
            "app": _process_name(head["pid"]),
            "handle": handle,
            "fields": fields,
        }


def _choose(raw: Raw, el, want: str) -> str:
    """Pick the item called `want` in a drop-down that can't be typed in: open it, select the
    item, close it. The item's name, or "" when it has none like that."""
    ctrl = raw.ua.Control.CreateControlFromElement(el)
    try:
        expand = ctrl.GetExpandCollapsePattern()
        if expand is not None:
            expand.Expand()
    except Exception:  # noqa: BLE001 - some lists are there without opening
        pass
    target = _norm(want)
    best = None
    for item in raw.everything_under(el):
        n = raw.node(item)
        if n["type"] != "ListItemControl":
            continue
        name = _norm(n["name"])
        if name == target:
            best = (item, n)
            break
        if best is None and target and target in name:
            best = (item, n)
    chosen = ""
    if best is not None:
        try:
            pattern = raw.ua.Control.CreateControlFromElement(best[0]).GetSelectionItemPattern()
            if pattern is not None:
                pattern.Select()
                chosen = best[1]["name"]
        except Exception:  # noqa: BLE001
            chosen = ""
    try:
        expand = ctrl.GetExpandCollapsePattern()
        if expand is not None:
            expand.Collapse()
    except Exception:  # noqa: BLE001
        pass
    return chosen


def _put(raw: Raw, n: dict[str, Any], value: str) -> str:
    """Put the answer in the field; "" when done, else why not."""
    ctrl = raw.ua.Control.CreateControlFromElement(n["el"])
    word = _norm(value)
    kind = n["type"]
    if kind == "CheckBoxControl":
        if word not in YES_WORDS | NO_WORDS:
            return "Say yes or no for a check box."
        want = 1 if word in YES_WORDS else 0
        toggle = ctrl.GetTogglePattern()
        for _ in range(3):  # (a three-state box can need two presses)
            if raw.refreshed(n["el"])["toggle"] == want:
                break
            toggle.Toggle()
        return ""
    if kind == "RadioButtonControl":
        if word in NO_WORDS:
            return "An option is turned off by choosing another one."
        ctrl.GetSelectionItemPattern().Select()
        return ""
    if kind in ("SliderControl", "SpinnerControl"):
        try:
            number = float(str(value).replace(",", ""))
        except ValueError:
            return "That needs a number."
        ctrl.GetRangeValuePattern().SetValue(number)
        return ""
    pattern = None
    if not (kind == "ComboBoxControl" and n["readonly"]):
        pattern = ctrl.GetValuePattern()
    if pattern is not None and not pattern.IsReadOnly:
        pattern.SetValue(str(value))
        return ""
    if kind == "ComboBoxControl":
        return "" if _choose(raw, n["el"], str(value)) else f"The list has no choice like {value}."
    return "That field can't be typed in."


def fill_field(handle: int, number: int, value: str, label: str = "") -> dict[str, Any]:
    """Put an answer in field `number` (as form_fields counts them) of the window with this
    handle, then read the field back. label, when given, must still be that field's (else the
    form changed). {ok, label, kind, now, why}: now is what the field holds afterwards."""
    with Apartment():
        raw = Raw()
        top = raw.window(handle)
        if top is None:
            return {"ok": False, "why": "The form's window has closed."}
        nodes, places = _fields(raw, top)
        if not 1 <= number <= len(places):
            return {"ok": False, "why": f"The form has no field {number} now."}
        i, group = places[number - 1]
        n = nodes[i]
        info = describe_field(nodes, i, group)
        out: dict[str, Any] = {"ok": False, "label": info["label"], "kind": info["kind"]}
        if label and _norm(label) != _norm(info["label"]):
            return out | {
                "why": f"Field {number} is now {info['label']}, not {label}: the form changed."
            }
        if n["password"]:
            return out | {"why": "It's a password field: type that yourself."}
        if not n["enabled"]:
            return out | {"why": "That field is unavailable."}
        try:
            why = _put(raw, n, value)
        except Exception:  # noqa: BLE001 - the app refused it
            why = "The app didn't take it."
        if why:
            return out | {"why": why}
        fresh = list(nodes)
        fresh[i] = raw.refreshed(n["el"])
        return out | {"ok": True, "now": describe_field(fresh, i, group)["value"]}
