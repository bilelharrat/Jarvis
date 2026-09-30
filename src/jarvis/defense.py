"""The HUD's Defense panel: the Mac's real shields and link, not decoration.

Shields: the firewall, FileVault, Gatekeeper, System Integrity Protection and Time
Machine, as macOS reports them (no administrator password needed). Link: which network
is carrying traffic, how fast data is moving right now and the round trip to the
internet.
"""

from __future__ import annotations

import asyncio
import re
import subprocess
import time
from typing import Any

import psutil

LATENCY_HOST = ("1.1.1.1", 443)


def _run(*args: str) -> str:
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=5)  # noqa: S603
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return f"{done.stdout}\n{done.stderr}".strip()


def read_shields(run=_run) -> list[dict[str, Any]]:
    """[{name, on (True/False/None for unknown), detail}] for the five shields."""

    def shield(name: str, out: str, on: bool | None, detail: str) -> dict[str, Any]:
        return {"name": name, "on": None if not out else on, "detail": detail if out else "Unknown"}

    fw = run("/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate")
    fw_on = bool(re.search(r"enabled|State = [12]", fw))
    fv = run("fdesetup", "status")
    fv_on = "FileVault is On" in fv or "in progress" in fv
    gk = run("spctl", "--status")
    gk_on = "assessments enabled" in gk
    sip = run("csrutil", "status")
    sip_on = bool(re.search(r"status:\s*enabled", sip))
    tm = run("tmutil", "destinationinfo")
    tm_on = bool(tm) and "No destinations" not in tm
    return [
        shield("Firewall", fw, fw_on, "Blocking unwanted connections" if fw_on else "Off"),
        shield("FileVault", fv, fv_on, "Disk encrypted" if fv_on else "Disk not encrypted"),
        shield("Gatekeeper", gk, gk_on, "Only trusted apps" if gk_on else "Any app can run"),
        shield("SIP", sip, sip_on, "System files protected" if sip_on else "Protection off"),
        shield("Backup", tm, tm_on, "Time Machine set up" if tm_on else "No Time Machine disk"),
    ]


def read_link(run=_run) -> dict[str, Any]:
    """The interface carrying the default route: its kind, address and network name."""
    route = run("route", "-n", "get", "default")
    match = re.search(r"interface:\s*(\S+)", route)
    device = match.group(1) if match else ""
    if not device:
        return {"kind": "Offline", "device": "", "address": "", "name": ""}
    ports = run("networksetup", "-listallhardwareports")
    kind = "Network"
    for block in ports.split("\n\n"):
        if re.search(rf"Device:\s*{re.escape(device)}\b", block):
            found = re.search(r"Hardware Port:\s*(.+)", block)
            kind = found.group(1).strip() if found else kind
    address = run("ipconfig", "getifaddr", device).splitlines()
    name = ""
    if kind == "Wi-Fi":
        ssid = re.search(
            r"Current Wi-Fi Network:\s*(.+)", run("networksetup", "-getairportnetwork", device)
        )
        name = ssid.group(1).strip() if ssid else ""  # macOS hides it without Location access
    return {
        "kind": kind,
        "device": device,
        "address": address[0].strip()
        if address and re.match(r"[\d.]+$", address[0].strip())
        else "",
        "name": name,
    }


async def latency_ms(host: tuple[str, int] = LATENCY_HOST, timeout: float = 2.0) -> float | None:
    """Round trip to the internet: how long a TCP handshake takes."""
    started = time.perf_counter()
    try:
        _reader, writer = await asyncio.wait_for(asyncio.open_connection(*host), timeout)
    except (OSError, TimeoutError):
        return None
    elapsed = (time.perf_counter() - started) * 1000
    writer.close()
    return round(elapsed, 1)


class NetMeter:
    """Bytes per second in and out since the last reading."""

    def __init__(self, counters=psutil.net_io_counters) -> None:
        self._counters = counters
        self._last: tuple[float, int, int] | None = None

    def read(self) -> dict[str, float]:
        now = time.monotonic()
        c = self._counters()
        rates = {"down": 0.0, "up": 0.0}
        if self._last is not None:
            then, recv, sent = self._last
            span = max(0.001, now - then)
            rates = {
                "down": max(0.0, (c.bytes_recv - recv) / span),
                "up": max(0.0, (c.bytes_sent - sent) / span),
            }
        self._last = (now, c.bytes_recv, c.bytes_sent)
        return rates


# ── changes worth a heads-up, updates waiting, ports open ──

WATCHED = ("FileVault", "Firewall", "SIP", "Gatekeeper")  # a heads-up when one turns off
UPDATES_SECONDS = 180  # softwareupdate -l asks Apple's servers: it can take a while
LOCAL_ADDRESSES = ("127.0.0.1", "[::1]", "::1", "localhost")


def shield_states(shields: list[dict[str, Any]]) -> dict[str, bool]:
    """The watched shields macOS could report on: name -> on."""
    return {
        s["name"]: bool(s["on"])
        for s in shields
        if s.get("name") in WATCHED and isinstance(s.get("on"), bool)
    }


def turned_off(before: dict[str, Any], now: dict[str, bool]) -> list[str]:
    """Shields that were on and are off now (one unknown either time doesn't count)."""
    return [name for name in WATCHED if before.get(name) is True and now.get(name) is False]


def parse_updates(out: str) -> list[dict[str, Any]]:
    """softwareupdate -l's waiting updates: label, title, version, size, whether Apple
    recommends it and whether it restarts the Mac."""
    found: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in (out or "").splitlines():
        label = re.match(r"\s*\*\s*Label:\s*(.+)$", line)
        if label:
            current = {"label": label.group(1).strip(), "title": label.group(1).strip()}
            found.append(current)
            continue
        if current is None or "Title:" not in line:
            continue
        for key, value in re.findall(r"(\w+):\s*([^,]*)", line):
            key = key.lower()
            if key in ("title", "version", "size"):
                current[key] = value.strip()
            elif key == "recommended":
                current["recommended"] = value.strip().upper() == "YES"
            elif key == "action":
                current["restart"] = value.strip().lower() == "restart"
    return found


def read_updates(run=None) -> dict[str, Any]:
    """{"updates": […]} or {"error": why}; never raises."""
    if run is None:
        try:
            done = subprocess.run(  # noqa: S603
                ["softwareupdate", "-l"], capture_output=True, text=True, timeout=UPDATES_SECONDS
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"error": f"softwareupdate didn't answer ({type(exc).__name__})"}
        out = f"{done.stdout}\n{done.stderr}"
    else:
        out = run("softwareupdate", "-l")
    if "No new software available" in out:
        return {"updates": []}
    updates = parse_updates(out)
    if not updates and "Software Update found" not in out:
        return {
            "error": "softwareupdate gave no list"
            + (f": {out.strip()[:120]}" if out.strip() else "")
        }
    return {"updates": updates}


def parse_listening(out: str) -> list[dict[str, Any]]:
    """lsof's listening TCP sockets, one per program and port: the program, its process,
    the address and port, and whether other machines can reach it (not only this Mac)."""
    seen: dict[tuple[str, int], dict[str, Any]] = {}
    for line in (out or "").splitlines():
        m = re.match(r"^(\S+)\s+(\d+)\s+(\S+)\s.*?TCP\s+(\S+):(\d+)\s+\(LISTEN\)", line)
        if not m:
            continue
        command = m.group(1).replace("\\x20", " ")
        address, port = m.group(4), int(m.group(5))
        local = address in LOCAL_ADDRESSES
        row = seen.setdefault(
            (command, port),
            {
                "command": command,
                "pid": int(m.group(2)),
                "port": port,
                "addresses": [],
                "exposed": False,
            },
        )
        if address not in row["addresses"]:
            row["addresses"].append(address)
        row["exposed"] = row["exposed"] or not local
    return sorted(seen.values(), key=lambda r: (not r["exposed"], r["port"]))


def read_listening(run=_run) -> list[dict[str, Any]]:
    return parse_listening(run("lsof", "-nP", "-iTCP", "-sTCP:LISTEN"))
