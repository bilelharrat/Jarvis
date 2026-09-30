"""The security review: what JARVIS is allowed to do on its own right now, and a one-click
way to tighten each thing.

Findings say ok, notice (a choice worth knowing about) or risk, with what to tighten. A
tighten only ever narrows what JARVIS may do: it switches something off, makes something
ask first, unpairs a phone or makes a file private. Nothing here loosens anything, and
nothing runs without the owner's click and confirmation in the window.

Settings other features add in parallel (channels, webhooks, the companion's TLS) are read
defensively: a key that isn't there is simply not reported.
"""

from __future__ import annotations

import contextlib
import os
import re
import stat
from collections import deque
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

STALE_DEVICE = timedelta(days=30)
MAX_SCANNED = 20_000  # entries looked at in the data folder (the browser's caches are many)
MAX_DEPTH = 4
DEFAULT_LIMITS = {"pay_limit_purchase": 250.0, "pay_limit_transfer": 100.0, "pay_limit_day": 500.0}
# Other features' switches: prefs.features keys naming a channel or webhook, that end in
# _enabled or _on (switching one off only ever narrows what can reach JARVIS).
_EXTRA = re.compile(r"(channel|webhook|telegram|slack|discord|imessage|whatsapp)", re.I)
_SWITCH = re.compile(r"(?:_enabled|_on)$")


def action(aid: str, label: str, confirm: str, item: str = "") -> dict[str, str]:
    return {"id": aid, "label": label, "confirm": confirm, "item": item}


def finding(
    fid: str,
    title: str,
    state: str,
    summary: str,
    note: str = "",
    *,
    actions: list[dict[str, str]] | None = None,
    items: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "id": fid,
        "title": title,
        "state": state,
        "summary": summary,
        "note": note,
        "actions": actions or [],
        "items": items or [],
    }


# ── the phone companion ──


def companion_tls(hub: Any) -> bool | None:
    """Whether the companion speaks TLS. Another feature adds it; until then it's plain
    HTTP. None when that can't be told."""
    remote = getattr(hub, "remote", None)
    flag = getattr(remote, "tls", None)
    if isinstance(flag, bool):
        return flag
    with contextlib.suppress(Exception):
        pref = hub.prefs.feature("companion_tls")
        if isinstance(pref, bool):
            return pref
    with contextlib.suppress(Exception):
        urls = remote.public().get("urls") or []
        if urls:
            return all(str(u).startswith("https://") for u in urls)
    return False if remote is not None else None


def _seen(device: dict[str, Any]) -> datetime | None:
    for key in ("last_seen", "paired"):
        with contextlib.suppress(TypeError, ValueError):
            return datetime.fromisoformat(str(device.get(key)))
    return None


def stale_devices(devices: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    out = []
    for device in devices:
        seen = _seen(device)
        if seen is None or now - seen > STALE_DEVICE:
            out.append(device)
    return out


def companion(hub: Any, now: datetime) -> dict[str, Any]:
    title = "iPhone & Watch companion"
    remote = getattr(hub, "remote", None)
    devices = []
    with contextlib.suppress(Exception):
        devices = list(remote.devices.public())
    items = [
        {
            "id": str(d.get("id", "")),
            "label": str(d.get("name", "")),
            "note": str(d.get("last_seen") or ""),
            "user": True,
        }
        for d in devices
    ]
    stale = stale_devices(devices, now)
    actions = []
    if stale:
        actions.append(
            action(
                "unpair_stale",
                "Unpair phones not seen for a month",
                f"Unpair {len(stale)} phone(s) that haven't connected for a month? Each can pair "
                "again with a new code.",
            )
        )
    if not hub.prefs.remote_enabled:
        state, summary = ("notice", "Off, with phones still paired") if devices else ("ok", "Off")
        return finding("companion", title, state, summary, items=items, actions=actions)
    tls = companion_tls(hub)
    actions.insert(
        0,
        action(
            "companion_off",
            "Turn the companion off",
            "Turn the phone companion off? Paired phones stay paired and work again when you "
            "turn it back on.",
        ),
    )
    if tls:
        return finding("companion", title, "notice", "On, encrypted", actions=actions, items=items)
    return finding(
        "companion",
        title,
        "risk",
        "On, without encryption",
        "It answers on your network over plain HTTP: someone on the same Wi-Fi could read "
        "what you ask from your phone. Use it at home, or turn it off when you're away.",
        actions=actions,
        items=items,
    )


# ── what JARVIS does without asking ──


def control(hub: Any) -> dict[str, Any]:
    title = "Control my Mac without asking"
    if not hub.prefs.control_always:
        return finding("control", title, "ok", "Off: it asks first")
    return finding(
        "control",
        title,
        "notice",
        "On",
        "Jarvis clicks, types, opens and quits apps and runs Shortcuts without asking. "
        "Paying still waits for your OK.",
        actions=[
            action(
                "control_ask",
                "Ask before controlling the Mac",
                "Have Jarvis ask before it clicks, types or opens apps for you?",
            )
        ],
    )


def connectors(hub: Any) -> dict[str, Any]:
    title = "Connected accounts"
    try:
        conns = hub.connectors.public()["connections"]
    except Exception:
        conns = []
    items, risky, quiet = [], 0, 0
    for conn in conns:
        cid, name = str(conn.get("id", "")), str(conn.get("name", ""))
        always = [str(t) for t in conn.get("always_allow") or []]
        acts = []
        if conn.get("policy") == "allow":
            risky += 1
            acts.append(
                action(
                    "connector_ask",
                    "Ask first",
                    f"Have {name} ask before anything that changes your data?",
                    cid,
                )
            )
            note = "Everything runs without asking"
        elif always:
            quiet += 1
            acts.append(
                action(
                    "connector_forget",
                    "Ask again for these",
                    f"Have {name} ask again before the actions you allowed for good?",
                    cid,
                )
            )
            note = ", ".join(t.replace("_", " ") for t in always[:6])
        else:
            continue
        items.append({"id": cid, "label": name, "note": note, "actions": acts, "user": True})
    if not conns:
        return finding("connectors", title, "ok", "None connected")
    if risky:
        summary = (
            f"{risky} run everything without asking"
            if risky != 1
            else "1 runs everything without asking"
        )
        return finding("connectors", title, "risk", summary, items=items)
    if quiet:
        return finding(
            "connectors",
            title,
            "notice",
            "Some actions run without asking",
            "Ones you allowed for good on an approval card.",
            items=items,
        )
    return finding("connectors", title, "ok", "Everything that changes data asks first")


def code(hub: Any) -> dict[str, Any]:
    """Jarvis Code: its don't-ask-again rules per project, and Bypass (every step runs)."""
    title = "Jarvis Code"
    items: list[dict[str, Any]] = []
    actions: list[dict[str, str]] = []
    state, summary = "ok", "Every step asks first unless you allow it"
    rules = {}
    with contextlib.suppress(Exception):
        rules = {k: list(v) for k, v in hub.tasks.rules.rules.items() if v}
    for folder, kept in sorted(rules.items()):
        items.append(
            {
                "id": folder,
                "label": Path(folder).name or folder,
                "note": ", ".join(kept[:6]) + (" …" if len(kept) > 6 else ""),
                "actions": [
                    action(
                        "code_rules",
                        "Ask again",
                        f"Ask again before the commands you allowed in {Path(folder).name}?",
                        folder,
                    )
                ],
                "user": True,
            }
        )
    if rules:
        state = "notice"
        summary = (
            f"Commands run without asking in {len(rules)} projects"
            if len(rules) != 1
            else "Commands run without asking in 1 project"
        )
    bypassing = []
    bypass_steps = 0
    with contextlib.suppress(Exception):
        for task in hub.tasks.tasks.values():
            if getattr(task, "mode", "") == "auto" and getattr(task, "status", "") not in (
                "closed",
                "stopped",
                "failed",
                "done",
            ):
                bypassing.append(task)
            bypass_steps += sum(
                1 for a in getattr(task, "audit", []) or [] if a.get("decision") == "bypass"
            )
    if bypassing:
        state = "risk"
        summary = (
            f"{len(bypassing)} sessions in Bypass now"
            if len(bypassing) != 1
            else "1 session in Bypass now"
        )
        actions.append(
            action(
                "code_sessions_manual",
                "Switch them to Manual",
                "Switch the sessions running in Bypass to Manual, so each step asks first?",
            )
        )
    if getattr(hub.prefs, "code_mode", "ask") == "auto":
        state = "risk"
        summary = "New sessions start in Bypass" if not bypassing else summary
        actions.append(
            action(
                "code_default_manual",
                "Start new sessions in Manual",
                "Start new Jarvis Code sessions in Manual, so each step asks first?",
            )
        )
    note = (
        f"{bypass_steps} steps ran in Bypass in the sessions open now."
        if bypass_steps > 1
        else ("1 step ran in Bypass in the sessions open now." if bypass_steps == 1 else "")
    )
    return finding("code", title, state, summary, note, actions=actions, items=items)


def purchases(hub: Any) -> dict[str, Any]:
    title = "Purchases"
    p = hub.prefs
    if not getattr(p, "pay_enabled", False):
        return finding("purchases", title, "ok", "Off")
    currency = getattr(p, "pay_currency", "USD")
    limits = {k: float(getattr(p, k, v)) for k, v in DEFAULT_LIMITS.items()}
    note = (
        f"{limits['pay_limit_purchase']:g} {currency} a purchase, "
        f"{limits['pay_limit_transfer']:g} a transfer, {limits['pay_limit_day']:g} a day"
    )
    actions = [
        action(
            "pay_off",
            "Turn off buying for me",
            "Turn off buying, booking and paying in the built-in browser?",
        )
    ]
    if any(limits[k] > v for k, v in DEFAULT_LIMITS.items()):
        actions.append(
            action(
                "pay_defaults",
                "Lower the limits to the defaults",
                "Lower the limits above the defaults (250 a purchase, 100 a transfer, 500 a "
                "day) to those? Lower ones stay as they are.",
            )
        )
    return finding("purchases", title, "notice", "On, one confirmation each", note, actions=actions)


def screen(hub: Any) -> dict[str, Any]:
    title = "Screen awareness"
    if not getattr(hub.prefs, "screen_aware", False):
        return finding("screen", title, "ok", "Off")
    return finding(
        "screen",
        title,
        "notice",
        "On",
        "A picture of your screen every 15 seconds, kept in memory for two minutes and "
        "sent only with your own questions.",
        actions=[action("screen_off", "Turn it off", "Turn screen awareness off?")],
    )


# ── the data folder's permissions ──


def loose_entries(folder: Path) -> list[tuple[str, int, bool]]:
    """(path relative to the folder, mode, is a folder) for everything others on this Mac
    could read: group or other bits set. Links are never followed."""
    found: list[tuple[str, int, bool]] = []
    try:
        mode = stat.S_IMODE(os.lstat(folder).st_mode)
    except OSError:
        return found
    if mode & 0o077:
        found.append((".", mode, True))
    # Breadth first: Jarvis's own folders (bin, brain, models) are looked at before the
    # budget goes on the depths of the browser's caches, which share the folder.
    seen = 0
    waiting: deque[tuple[Path, int]] = deque([(folder, 0)])
    while waiting and seen < MAX_SCANNED:
        current, depth = waiting.popleft()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    seen += 1
                    if seen > MAX_SCANNED:
                        break
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if stat.S_ISLNK(info.st_mode):
                        continue
                    is_dir = stat.S_ISDIR(info.st_mode)
                    mode = stat.S_IMODE(info.st_mode)
                    if mode & 0o077:
                        found.append((os.path.relpath(entry.path, folder), mode, is_dir))
                    if is_dir and depth + 1 < MAX_DEPTH:
                        waiting.append((Path(entry.path), depth + 1))
        except OSError:
            continue
    return sorted(found)


def data_folder(folder: Path, loose: list[tuple[str, int, bool]] | None = None) -> dict[str, Any]:
    title = "Data folder permissions"
    loose = loose_entries(folder) if loose is None else loose
    if not loose:
        return finding("data_folder", title, "ok", "Private to you")
    names = [name if name != "." else "the folder itself" for name, _mode, _dir in loose[:12]]
    return finding(
        "data_folder",
        title,
        "risk",
        f"{len(loose)} can be read by others on this Mac"
        if len(loose) != 1
        else "1 can be read by others on this Mac",
        "Folders should be 700 and files 600: yours alone.",
        actions=[
            action(
                "make_private",
                "Make them private",
                "Make these readable by you alone (folders 700, files 600)?",
            )
        ],
        items=[{"id": n, "label": n, "note": "", "user": True} for n in names],
    )


def make_private(folder: Path) -> int:
    """Take away the group and other bits (never adds any); how many changed."""
    changed = 0
    for rel, mode, _is_dir in loose_entries(folder):
        path = folder if rel == "." else folder / rel
        try:
            if stat.S_ISLNK(os.lstat(path).st_mode):
                continue
            os.chmod(path, mode & ~0o077)
        except OSError:
            continue
        changed += 1
    return changed


# ── other features' channels and webhooks ──


def extras(hub: Any) -> dict[str, Any] | None:
    """Channels and webhooks, when features that add them are installed: their switches
    that are on. None when there are none of those settings at all."""
    try:
        features = dict(hub.prefs.features)
    except Exception:
        return None
    try:
        from ... import prefs as prefs_module

        registered = set(prefs_module.FEATURE_PREFS)
    except Exception:
        registered = set()
    keys = sorted(k for k in set(features) | registered if _EXTRA.search(k))
    if not keys:
        return None
    items = []
    for key in keys:
        value = hub.prefs.feature(key)
        if _SWITCH.search(key) and value is True:
            label = key.replace("_", " ").strip().capitalize()
            items.append(
                {
                    "id": key,
                    "label": label,
                    "note": "On",
                    "actions": [action("extra_off", "Turn off", f"Turn off {label}?", key)],
                }
            )
    title = "Channels & webhooks"
    if not items:
        return finding("extras", title, "ok", "None switched on")
    return finding(
        "extras",
        title,
        "notice",
        f"{len(items)} switched on" if len(items) != 1 else "1 switched on",
        "Messages from these reach Jarvis from outside this Mac.",
        items=items,
    )


def review(
    hub: Any,
    folder: Path,
    now: datetime | None = None,
    loose: list[tuple[str, int, bool]] | None = None,
) -> dict[str, Any]:
    """Every finding. Called on the hub's loop (it reads the hub's live state); the data
    folder's scan, the only slow part, can come ready-made from a thread (loose)."""
    now = now or datetime.now()
    findings = [
        companion(hub, now),
        control(hub),
        connectors(hub),
        code(hub),
        purchases(hub),
        screen(hub),
        data_folder(folder, loose),
    ]
    extra = extras(hub)
    if extra is not None:
        findings.append(extra)
    counts = {s: sum(1 for f in findings if f["state"] == s) for s in ("risk", "notice", "ok")}
    return {"at": now.isoformat(timespec="seconds"), "findings": findings, "counts": counts}


class Refused(Exception):
    """A tighten that doesn't apply (unknown, or nothing left to tighten)."""


async def tighten(
    hub: Any, folder: Path, aid: str, item: str = "", now: datetime | None = None
) -> str:
    """Apply one tighten; what was done, in a sentence. Only ever narrows."""
    now = now or datetime.now()
    p = hub.prefs
    if aid == "companion_off":
        hub.set_prefs({"remote_enabled": False})
        return "The phone companion is off."
    if aid == "unpair_stale":
        devices = list(hub.remote.devices.public())
        gone = [d for d in stale_devices(devices, now) if hub.remote.devices.remove(d["id"])]
        with contextlib.suppress(Exception):
            hub.emit("remote", **hub.remote.public())
        if not gone:
            raise Refused
        return f"Unpaired {len(gone)} phone(s)."
    if aid == "control_ask":
        hub.set_prefs({"control_always": False})
        return "Jarvis asks before controlling the Mac."
    if aid == "connector_ask":
        if item not in hub.connectors.connections:
            raise Refused
        hub.connectors.set_policy(item, "ask")
        return "It asks first now."
    if aid == "connector_forget":
        conn = hub.connectors.connections.get(item)
        if conn is None or not conn.always_allow:
            raise Refused
        conn.always_allow.clear()
        hub.connectors.set_policy(item, conn.policy)  # saves the connection, tells the window
        return "It asks again for those actions."
    if aid == "code_rules":
        store = hub.tasks.rules
        kept = list(store.rules.get(item, []))
        if not kept:
            raise Refused
        for rule in kept:
            store.remove(Path(item), rule)
        return "Jarvis Code asks again in that project."
    if aid == "code_sessions_manual":
        switched = 0
        for task in list(hub.tasks.tasks.values()):
            if getattr(task, "mode", "") == "auto" and hub.tasks.set_mode(task.id, "ask"):
                switched += 1
        if not switched:
            raise Refused
        return "Those sessions ask first now."
    if aid == "code_default_manual":
        if p.code_mode != "auto":
            raise Refused
        hub.set_prefs({"code_mode": "ask"})
        return "New sessions start in Manual."
    if aid == "pay_off":
        hub.set_prefs({"pay_enabled": False})
        return "Buying for you is off."
    if aid == "pay_defaults":
        lower = {k: v for k, v in DEFAULT_LIMITS.items() if float(getattr(p, k, v)) > v}
        if not lower:
            raise Refused
        hub.set_prefs(lower)
        return "The limits are back to the defaults."
    if aid == "screen_off":
        hub.set_prefs({"screen_aware": False})
        return "Screen awareness is off."
    if aid == "make_private":
        import asyncio

        changed = await asyncio.to_thread(make_private, folder)
        if not changed:
            raise Refused
        return "Jarvis's data is private to you."
    if aid == "extra_off":
        if not (_EXTRA.search(item) and _SWITCH.search(item)) or p.feature(item) is not True:
            raise Refused
        hub.set_feature_prefs({item: False})
        return "Turned off."
    raise Refused
