"""System stats' pop-out: Activity Monitor's numbers, parsed from the Mac's own tools."""

import asyncio
import contextlib
import subprocess
import time
import types

import psutil
import pytest
from test_hub import make_hub

from jarvis import sysmon
from jarvis.sysmon import SystemMonitor, battery_health, energy_impact, vm_stat

VM_STAT = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                7575.
Pages active:                            284249.
Pages inactive:                          279151.
Pages purgeable:                           1000.
Pages wired down:                        418564.
Pages occupied by compressor:            529334.
Anonymous pages:                         365000.
File-backed pages:                       200000.
"""

IOREG = """+-o AppleSmartBattery  <class AppleSmartBattery>
    {
      "CycleCount" = 20
      "DesignCycleCount9C" = 1000
      "Voltage" = 11231
      "InstantAmperage" = 18446744073709550153
      "BatteryData" = {"DesignCapacity"=4629,"NominalChargeCapacity"=4400}
    }
"""

TOP = """Processes: 1730 total
PID    COMMAND          POWER
428    WindowServer     12.0
11557  Claude Helper    3.1
Processes: 1730 total
PID    COMMAND          POWER
428    WindowServer     62.1
11557  Claude Helper    25.8
3747   J.A.R.V.I.S Help 16.9
"""


def test_memory_is_broken_down_as_activity_monitor_does():
    m = vm_stat(VM_STAT)
    page = 16384
    assert m["app"] == (365000 - 1000) * page
    assert m["wired"] == 418564 * page
    assert m["compressed"] == 529334 * page
    assert m["cached"] == (200000 + 1000) * page


def test_battery_health_cycles_and_the_power_flowing():
    b = battery_health(IOREG)
    assert b["cycles"] == 20 and b["design_cycles"] == 1000
    assert b["health"] == round(100 * 4400 / 4629)
    assert b["watts"] == round(11231 * (18446744073709550153 - 2**64) / 1e6, 1) < 0  # draining
    assert battery_health("") == {}


def test_energy_impact_is_read_from_tops_second_sample():
    rows = energy_impact(TOP)
    assert [r["name"] for r in rows] == ["WindowServer", "Claude Helper", "J.A.R.V.I.S Help"]
    assert rows[0] == {"pid": 428, "name": "WindowServer", "energy": 62.1}
    assert energy_impact("") == []


def test_memory_pressure_is_read_in_this_process_as_sysctl_says_it(monkeypatch):
    """It's in every two-second sample: read with sysctlbyname, never a `sysctl` child, and
    the same number `sysctl -n` prints (100 minus the level; it moves, so near enough)."""
    if not sysmon._libc_sysctl():
        pytest.skip("no sysctlbyname here")
    ran = []
    monkeypatch.setattr(sysmon, "_run", lambda *cmd, **_kw: ran.append(cmd) or "")
    pressure = sysmon.memory_pressure()
    assert ran == []
    out = subprocess.run(
        ["sysctl", "-n", "kern.memorystatus_level"], capture_output=True, text=True
    ).stdout.strip()
    if out.isdigit():
        assert pressure is not None and 0 <= pressure <= 100
        assert abs(pressure - (100 - int(out))) <= 10


def test_memory_pressure_without_sysctlbyname_asks_the_command(monkeypatch):
    monkeypatch.setattr(sysmon, "_sysctlbyname", False)
    said = {("sysctl", "-n", "kern.memorystatus_level"): "38\n"}
    monkeypatch.setattr(sysmon, "_run", lambda *cmd, **_kw: said.get(cmd, ""))
    assert sysmon.memory_pressure() == 62
    said.clear()
    assert sysmon.memory_pressure() is None
    monkeypatch.setattr(sysmon, "_sysctlbyname", lambda *_args: -1)  # no such name here
    assert sysmon.memory_pressure() is None


class FakeProc:
    def __init__(self, pid, cpu, memory, name, gone=False):
        self.pid, self._cpu, self._memory, self._name, self.gone = pid, cpu, memory, name, gone
        self.named = 0

    @contextlib.contextmanager
    def oneshot(self):
        yield

    def cpu_percent(self, interval=None):
        return self._cpu

    def memory_info(self):
        return types.SimpleNamespace(rss=self._memory)

    def num_threads(self):
        return self.pid % 3 + 1

    def name(self):
        self.named += 1
        if self.gone:
            raise psutil.NoSuchProcess(self.pid)
        return self._name

    def username(self):
        return "root" if self.pid % 2 else "owner"


def test_names_are_read_for_the_rows_shown_only(monkeypatch):
    """A Mac runs well over a thousand processes: a look reads every one's CPU, memory and
    threads, but names and users only for the rows the tab shows, in the same order, and a
    process gone before its name was read gives its place to the next."""
    procs = [FakeProc(pid, pid % 7 + 0.5, pid * 4096 % 70001, f"app{pid}") for pid in range(1, 400)]
    procs[5].gone = True  # pid 6: among the busiest
    monkeypatch.setattr(sysmon.psutil, "process_iter", lambda: iter(procs))
    m = SystemMonitor()
    rows = m._processes()
    assert len(rows) == len(procs) and sum(r["threads"] for r in rows) == sum(
        p.num_threads() for p in procs
    )
    for key in ("cpu", "memory"):
        shown = m._top(rows, key)
        live = [p for p in procs if not p.gone]
        expected = [
            {
                "pid": p.pid,
                "name": p._name,
                "cpu": round(p._cpu, 1),
                "memory": p._memory,
                "threads": p.num_threads(),
                "user": p.username(),
            }
            for p in sorted(live, key=lambda p: -(p._cpu if key == "cpu" else p._memory))
        ][: sysmon.TOP_PROCESSES]
        assert shown == expected
    assert sum(p.named for p in procs) <= 2 * (sysmon.TOP_PROCESSES + 1)


def test_samples_become_rates_and_history(monkeypatch):
    now = [100.0]
    m = SystemMonitor(clock=lambda: now[0])
    monkeypatch.setattr(sysmon, "memory_pressure", lambda: 42)
    m.sample()
    now[0] += 2
    point = m.sample()
    assert point["pressure"] == 42 and point["t"] == 102.0
    assert {"user", "system", "read", "write", "down", "up", "pin", "pout"} <= set(point)
    assert all(point[k] >= 0 for k in ("read", "write", "down", "up"))
    assert len(m.history) == 2
    for _ in range(sysmon.HISTORY + 5):
        now[0] += 2
        m.sample()
    assert len(m.history) == sysmon.HISTORY  # six minutes, no more


def test_every_tab_answers(monkeypatch):
    m = SystemMonitor()
    monkeypatch.setattr(sysmon, "memory_pressure", lambda: 42)
    monkeypatch.setattr(sysmon, "vm_stat", lambda: vm_stat(VM_STAT))
    monkeypatch.setattr(sysmon, "battery_health", lambda: battery_health(IOREG))
    monkeypatch.setattr(sysmon, "energy_impact", lambda: energy_impact(TOP))
    monkeypatch.setattr(m, "_port_name", lambda d: d)
    m.sample()
    cpu = m.details("cpu")
    assert cpu["cpu"]["cores"] and cpu["processes"] and "threads" in cpu["cpu"]
    assert cpu["processes"] == sorted(cpu["processes"], key=lambda p: -p["cpu"])
    mem = m.details("memory")
    assert mem["memory"]["pressure"] == 42 and mem["memory"]["wired"] == 418564 * 16384
    assert mem["processes"][0]["memory"] >= mem["processes"][-1]["memory"]
    assert "volumes" in m.details("disk")["disk"]
    assert "interfaces" in m.details("network")["network"]
    m.details("energy")  # starts the measurement in the background
    for _ in range(50):
        if m._energy:
            break
        time.sleep(0.02)
    assert m.details("energy")["processes"][0]["name"] == "WindowServer"


async def test_the_hub_sends_the_open_tab_and_stops_when_closed(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    sent = []

    class Monitor:
        def details(self, tab):
            sent.append(tab)
            return {"tab": tab, "history": []}

    hub.sysmon = Monitor()
    q = hub.subscribe()
    await hub.handle({"type": "sysmon_open", "tab": "memory"})
    await hub.handle({"type": "sysmon_open", "tab": "nonsense"})  # ignored
    assert hub._sysmon_tab == "memory" and sent == ["memory"]
    await asyncio.sleep(0)
    events = []
    while not q.empty():
        events.append(q.get_nowait())
    assert any(e["type"] == "sysmon" and e["tab"] == "memory" for e in events)
    await hub.handle({"type": "sysmon_close"})
    assert hub._sysmon_tab is None
