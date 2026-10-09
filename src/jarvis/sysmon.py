"""The System stats pop-out: what Activity Monitor shows, tab by tab (CPU, Memory, Energy,
Disk, Network), with a few minutes of history for each tab's chart.

The cheap numbers (CPU, memory, disk and network counters) are sampled every couple of
seconds while a window is open, so a chart has history the moment the pop-out opens. The
costly ones (every process, energy impact, the battery's health) are read only while the
pop-out is open, and energy impact (from `top`, which needs a second to measure) only
every ten seconds. macOS doesn't tell other apps how much disk or network each process
uses without root, so those tabs list volumes and interfaces instead.
"""

from __future__ import annotations

import re
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import Any

import psutil

from . import osplat

HISTORY = 180  # samples: six minutes at one every two seconds
TOP_PROCESSES = 30
ENERGY_EVERY = 10.0  # s
ENERGY_ROWS = 15


def _run(*cmd: str, timeout: float = 5) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.SubprocessError):
        return ""


def vm_stat(text: str | None = None) -> dict[str, int]:
    """Activity Monitor's memory breakdown, in bytes, from vm_stat."""
    text = _run("vm_stat") if text is None else text
    page = 16384
    m = re.search(r"page size of (\d+) bytes", text)
    if m:
        page = int(m.group(1))
    pages: dict[str, int] = {}
    for line in text.splitlines():
        name, _, value = line.partition(":")
        value = value.strip().rstrip(".")
        if value.isdigit():
            pages[name.strip().strip('"')] = int(value) * page
    anonymous = pages.get("Anonymous pages", 0)
    purgeable = pages.get("Pages purgeable", 0)
    return {
        "app": max(0, anonymous - purgeable),
        "wired": pages.get("Pages wired down", 0),
        "compressed": pages.get("Pages occupied by compressor", 0),
        "cached": pages.get("File-backed pages", 0) + purgeable,
    }


_sysctlbyname: Any = None  # libc's, looked up on first use; False where there's none


def _libc_sysctl() -> Any:
    global _sysctlbyname
    if _sysctlbyname is None:
        import ctypes

        try:
            fn = ctypes.CDLL(None).sysctlbyname
        except (OSError, AttributeError, TypeError):  # not a Mac (nor a BSD; a PC says TypeError)
            fn = False
        else:
            fn.argtypes = [
                ctypes.c_char_p,
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_size_t),
                ctypes.c_void_p,
                ctypes.c_size_t,
            ]
            fn.restype = ctypes.c_int
        _sysctlbyname = fn
    return _sysctlbyname


def memory_pressure() -> int | None:
    """0-100, as Activity Monitor's graph: how much of memory the system counts as used.
    It's in every two-second sample, so it's read in this process (sysctlbyname) rather
    than by starting `sysctl` each time; the command only where libc has no sysctlbyname."""
    sysctlbyname = _libc_sysctl()
    if not sysctlbyname:
        if osplat.IS_WIN:  # no sysctl on a PC: how full memory is is the same measure
            return round(psutil.virtual_memory().percent)
        out = _run("sysctl", "-n", "kern.memorystatus_level").strip()
        return 100 - int(out) if out.isdigit() else None
    import ctypes

    level = ctypes.c_int(0)
    size = ctypes.c_size_t(ctypes.sizeof(level))
    if sysctlbyname(b"kern.memorystatus_level", ctypes.byref(level), ctypes.byref(size), None, 0):
        return None  # no such name on this macOS: as `sysctl -n` printing nothing
    return 100 - level.value if level.value >= 0 else None


def battery_health(text: str | None = None) -> dict[str, Any]:
    """Cycle count, capacity against design, temperature and the power flowing, from the
    battery's controller."""
    text = _run("ioreg", "-rn", "AppleSmartBattery") if text is None else text
    values: dict[str, int] = {}
    for key in (
        "CycleCount",
        "DesignCapacity",
        "NominalChargeCapacity",
        "AppleRawMaxCapacity",
        "Temperature",
        "Voltage",
        "InstantAmperage",
        "DesignCycleCount9C",
    ):
        m = re.search(rf'"{key}" ?= ?(-?\d+)', text)  # "Key" = 1 and, nested, "Key"=1
        if m:
            values[key] = int(m.group(1))
    out: dict[str, Any] = {}
    if "CycleCount" in values:
        out["cycles"] = values["CycleCount"]
    if "DesignCycleCount9C" in values:
        out["design_cycles"] = values["DesignCycleCount9C"]
    full = values.get("NominalChargeCapacity") or values.get("AppleRawMaxCapacity")
    if values.get("DesignCapacity") and full:
        # a new battery can hold a little more than it was designed to: 100% at most
        out["health"] = min(100, round(100 * full / values["DesignCapacity"]))
    if "Temperature" in values:
        out["temperature"] = round(values["Temperature"] / 100, 1)  # centi-degrees C
    if "Voltage" in values and "InstantAmperage" in values:
        amps = values["InstantAmperage"]
        if amps > 2**63:  # an unsigned reading of a negative (discharging) current
            amps -= 2**64
        out["watts"] = round(values["Voltage"] * amps / 1e6, 1)  # mV x mA
    return out


def energy_impact(text: str | None = None) -> list[dict[str, Any]]:
    """The apps using the most energy now, from top's second sample (the first has none)."""
    if text is None:
        # slow on a busy Mac (top samples every process twice): it runs in the background
        text = _run(
            "top", "-l", "2", "-s", "1", "-n", str(ENERGY_ROWS), "-o", "power",
            "-stats", "pid,command,power", timeout=90,
        )  # fmt: skip
    blocks = text.split("PID")
    rows = []
    for line in blocks[-1].splitlines()[1:] if len(blocks) > 1 else []:
        m = re.match(r"\s*(\d+)\s+(.+?)\s+([\d.]+)\s*$", line)
        if m:
            rows.append({"pid": int(m.group(1)), "name": m.group(2), "energy": float(m.group(3))})
    return rows[:TOP_PROCESSES]


class SystemMonitor:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.history: deque[dict[str, Any]] = deque(maxlen=HISTORY)
        self._last: tuple[float, Any, Any] | None = None  # (when, disk, net) counters
        self._procs: dict[int, psutil.Process] = {}
        self._energy: list[dict[str, Any]] = []
        self._energy_at = -1e9
        self._ports: dict[str, str] | None = None
        self._energy_busy = False

    # ── the cheap numbers, for the charts ──

    def sample(self) -> dict[str, Any]:
        now = self.clock()
        times = psutil.cpu_times_percent(interval=None)
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()
        disk = psutil.disk_io_counters()
        net = psutil.net_io_counters()
        rates = {"read": 0.0, "write": 0.0, "reads": 0.0, "writes": 0.0}
        rates |= {"down": 0.0, "up": 0.0, "pin": 0.0, "pout": 0.0}
        if self._last is not None:
            then, d0, n0 = self._last
            span = max(0.5, now - then)
            if disk is not None and d0 is not None:
                rates["read"] = max(0, disk.read_bytes - d0.read_bytes) / span
                rates["write"] = max(0, disk.write_bytes - d0.write_bytes) / span
                rates["reads"] = max(0, disk.read_count - d0.read_count) / span
                rates["writes"] = max(0, disk.write_count - d0.write_count) / span
            if net is not None and n0 is not None:
                rates["down"] = max(0, net.bytes_recv - n0.bytes_recv) / span
                rates["up"] = max(0, net.bytes_sent - n0.bytes_sent) / span
                rates["pin"] = max(0, net.packets_recv - n0.packets_recv) / span
                rates["pout"] = max(0, net.packets_sent - n0.packets_sent) / span
        self._last = (now, disk, net)
        battery = psutil.sensors_battery()
        point = {
            "t": round(now, 1),
            "user": round(times.user + getattr(times, "nice", 0.0), 1),
            "system": round(times.system, 1),
            "pressure": memory_pressure(),
            "mem_used": mem.total - mem.available,
            "swap": swap.used,
            "battery": round(battery.percent) if battery else None,
            **{k: round(v) for k, v in rates.items()},
        }
        self.history.append(point)
        return point

    # ── the whole picture, while the pop-out is open ──

    def details(self, tab: str) -> dict[str, Any]:
        out: dict[str, Any] = {"history": list(self.history), "tab": tab}
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()
        if tab == "cpu":
            times = psutil.cpu_times_percent(interval=None)
            procs = self._processes()
            out["cpu"] = {
                "user": round(times.user + getattr(times, "nice", 0.0), 1),
                "system": round(times.system, 1),
                "idle": round(times.idle, 1),
                "cores": psutil.cpu_percent(percpu=True),
                "load": [round(x, 2) for x in psutil.getloadavg()],
                "processes": len(procs),
                "threads": sum(p["threads"] for p in procs),
            }
            out["processes"] = self._top(procs, "cpu")
        elif tab == "memory":
            procs = self._processes()
            out["memory"] = {
                "total": mem.total,
                "used": mem.total - mem.available,
                "swap": swap.used,
                "swap_total": swap.total,
                "pressure": memory_pressure(),
                **vm_stat(),
            }
            out["processes"] = self._top(procs, "memory")
        elif tab == "energy":
            battery = psutil.sensors_battery()
            info: dict[str, Any] = {}
            if battery is not None:
                left = battery.secsleft
                info = {
                    "percent": round(battery.percent),
                    "plugged": bool(battery.power_plugged),
                    "minutes_left": (
                        None if left in (psutil.POWER_TIME_UNLIMITED, psutil.POWER_TIME_UNKNOWN)
                        else round(left / 60)
                    ),
                }  # fmt: skip
                info |= battery_health()
            out["energy"] = info
            self._measure_energy()
            out["processes"] = self._energy
        elif tab == "disk":
            counters = psutil.disk_io_counters()
            volumes = []
            for part in psutil.disk_partitions(all=False):
                # the startup disk (its Data volume holds what's used) and anything plugged
                # in; not the sealed system snapshot, Recovery or simulators' runtimes
                mount = part.mountpoint
                if mount != "/System/Volumes/Data" and not (
                    mount.startswith("/Volumes/") and mount != "/Volumes/Recovery"
                ):
                    continue
                try:
                    use = psutil.disk_usage(part.mountpoint)
                except OSError:
                    continue
                volumes.append(
                    {
                        "name": "Macintosh HD" if mount == "/System/Volumes/Data" else mount[9:],
                        "fs": part.fstype,
                        "used": use.used,
                        "total": use.total,
                    }
                )
            out["disk"] = {
                "read_total": getattr(counters, "read_bytes", 0),
                "write_total": getattr(counters, "write_bytes", 0),
                "reads_total": getattr(counters, "read_count", 0),
                "writes_total": getattr(counters, "write_count", 0),
                "volumes": volumes,
            }
        elif tab == "network":
            total = psutil.net_io_counters()
            per = psutil.net_io_counters(pernic=True)
            stats = psutil.net_if_stats()
            interfaces = []
            for name, io in per.items():
                st = stats.get(name)
                if io.bytes_recv + io.bytes_sent < 1_000_000:  # idle tunnels and the like
                    continue
                interfaces.append(
                    {
                        "name": self._port_name(name),
                        "up": bool(st and st.isup),
                        "received": io.bytes_recv,
                        "sent": io.bytes_sent,
                    }
                )
            out["network"] = {
                "received": total.bytes_recv,
                "sent": total.bytes_sent,
                "packets_in": total.packets_recv,
                "packets_out": total.packets_sent,
                "interfaces": sorted(interfaces, key=lambda i: -(i["received"] + i["sent"])),
            }
        return out

    def _measure_energy(self) -> None:
        """Energy impact, measured in the background (top can take a minute on a busy
        Mac): the tab shows the latest measurement meanwhile."""
        if self._energy_busy or self.clock() - self._energy_at < ENERGY_EVERY:
            return
        self._energy_busy = True

        def measure() -> None:
            try:
                rows = energy_impact()
                if rows:
                    self._energy = rows
            finally:
                self._energy_at = self.clock()
                self._energy_busy = False

        threading.Thread(target=measure, name="jarvis-energy", daemon=True).start()

    def _port_name(self, device: str) -> str:
        """en0 -> "Wi-Fi (en0)", as System Settings names it."""
        if self._ports is None:
            self._ports = {}
            port = ""
            for line in _run("networksetup", "-listallhardwareports").splitlines():
                if line.startswith("Hardware Port:"):
                    port = line.split(":", 1)[1].strip()
                elif line.startswith("Device:") and port:
                    self._ports[line.split(":", 1)[1].strip()] = port
        if device == "lo0":
            return "Loopback (lo0)"
        port = self._ports.get(device)
        return f"{port} ({device})" if port else device

    def _processes(self) -> list[dict[str, Any]]:
        """Every process with its CPU (since the last look), memory and threads. The same
        Process objects are kept between looks: that's what CPU % is measured against.
        Names and users are read by _top, for the rows shown only: on a Mac running well
        over a thousand processes they were most of the cost of a look (another kernel
        call each, and one more for every name longer than 15 characters)."""
        seen: dict[int, psutil.Process] = {}
        rows = []
        for proc in psutil.process_iter():
            proc = self._procs.get(proc.pid, proc)
            try:
                with proc.oneshot():
                    rows.append(
                        {
                            "pid": proc.pid,
                            "cpu": round(proc.cpu_percent(interval=None), 1),
                            "memory": proc.memory_info().rss,
                            "threads": proc.num_threads(),
                        }
                    )
                seen[proc.pid] = proc
            except (psutil.Error, OSError):
                continue
        self._procs = seen
        return rows

    def _top(self, rows: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
        """The TOP_PROCESSES rows with the most `key` (cpu or memory), each with its name
        and user. One that has gone meanwhile is left out, and the next one shown."""
        top = []
        for row in sorted(rows, key=lambda p: -p[key]):
            proc = self._procs.get(row["pid"])
            if proc is None:
                continue
            try:
                with proc.oneshot():
                    name, user = proc.name(), proc.username()
            except (psutil.Error, OSError):
                continue
            top.append(
                {
                    "pid": row["pid"],
                    "name": name,
                    "cpu": row["cpu"],
                    "memory": row["memory"],
                    "threads": row["threads"],
                    "user": user,
                }
            )
            if len(top) >= TOP_PROCESSES:
                break
        return top
