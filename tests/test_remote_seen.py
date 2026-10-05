"""When a paired phone was last seen (remote.Devices.seen, on every companion request once a
minute): written in a thread, so the request never waits on the disk, and never over a list
written since (a phone just removed or paired stays so on disk, and in its backup copy)."""

import asyncio
import json
import threading

from jarvis import jsonstore
from jarvis.remote import Devices


def _rows(path):
    return json.loads(path.read_text())


async def _settle(path, check):
    for _ in range(300):
        if path.exists() and check(_rows(path)):
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"{path.name} never got there: {path.read_text()}")


async def test_a_phone_seen_is_written_off_the_event_loop(tmp_path, monkeypatch):
    path = tmp_path / "devices.json"
    devices = Devices(path)
    token = devices.pair(devices.start_pairing(), "iPhone")
    device = devices.check(token)
    device.last_seen = ""
    threads = []
    real = jsonstore.save_json

    def save_json(*args, **kwargs):
        threads.append(threading.current_thread())
        real(*args, **kwargs)

    monkeypatch.setattr(jsonstore, "save_json", save_json)
    devices.seen(device)
    assert device.last_seen  # at once, for the window
    await _settle(path, lambda rows: rows[0]["last_seen"] == device.last_seen)
    assert threads and threading.main_thread() not in threads
    devices.seen(device)  # the same minute: nothing more to write
    await asyncio.sleep(0.05)
    assert len(threads) == 1


async def test_a_list_taken_earlier_never_brings_a_removed_phone_back(tmp_path):
    path = tmp_path / "devices.json"
    devices = Devices(path)
    lost = devices.pair(devices.start_pairing(), "Lost phone")
    devices.pair(devices.start_pairing(), "Watch")
    late = devices._taken_rows()  # a seen() whose thread hasn't written yet
    devices.remove(devices.check(lost).id)
    devices._write(*late)  # … and writes now
    assert [row["name"] for row in _rows(path)] == ["Watch"]
    assert not path.with_name("devices.json.bak").exists()
    assert Devices(path).check(lost) is None


async def test_seen_and_paired_together_keep_both(tmp_path):
    path = tmp_path / "devices.json"
    devices = Devices(path)
    first = devices.check(devices.pair(devices.start_pairing(), "iPhone"))
    first.last_seen = ""
    devices.seen(first)  # its write may land before or after the pairing's
    second = devices.pair(devices.start_pairing(), "Watch")
    await asyncio.sleep(0.05)
    again = Devices(path)
    assert again.check(second) is not None
    assert [row["last_seen"] for row in _rows(path)][0] == first.last_seen


def test_seen_without_an_event_loop_saves_at_once(tmp_path):
    path = tmp_path / "devices.json"
    devices = Devices(path)
    device = devices.check(devices.pair(devices.start_pairing(), "iPhone"))
    device.last_seen = ""
    devices.seen(device)
    assert _rows(path)[0]["last_seen"] == device.last_seen
