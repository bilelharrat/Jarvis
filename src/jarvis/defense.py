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
