"""The interrupter's state file is written off the event loop during a look (a save is
flushed to the disk itself: tens of milliseconds, far more on a busy disk), the look still
waits for it, and an older state never lands over a newer one."""

import asyncio
import json
import threading
import time

from jarvis import interrupts, jsonstore
from jarvis.interrupts import Interrupter


def watcher(tmp_path, **kw):
    # No databases: a look reads nothing, so only the save is left to watch.
    return Interrupter(lambda _alert: None, state_path=tmp_path / "interrupts.json", **kw)


async def test_a_looks_save_runs_in_a_thread_and_is_on_disk_when_the_look_ends(
    tmp_path, monkeypatch
):
    threads = []
    real = jsonstore.save_json

    def recording(path, data, **kw):
        threads.append(threading.current_thread())
        real(path, data, **kw)

    monkeypatch.setattr(interrupts.jsonstore, "save_json", recording)
    watch = watcher(tmp_path)
    watch._tell("message:7")
    assert await watch.poll() == []
    assert threads and all(t is not threading.main_thread() for t in threads)
    saved = json.loads((tmp_path / "interrupts.json").read_text())
    assert saved["told"] == ["message:7"] and not watch._dirty


async def test_the_loop_keeps_going_while_a_slow_disk_saves(tmp_path, monkeypatch):
    real = jsonstore.save_json

    def slow(path, data, **kw):
        time.sleep(0.3)  # a disk busy with something else
        real(path, data, **kw)

    monkeypatch.setattr(interrupts.jsonstore, "save_json", slow)
    watch = watcher(tmp_path)
    watch._tell("message:1")
    ticks = 0
    done = False

    async def ticker():
        nonlocal ticks
        while not done:
            ticks += 1
            await asyncio.sleep(0.01)

    task = asyncio.create_task(ticker())
    await watch.poll()
    done = True
    await task
    assert ticks >= 5  # the loop ran while the save was flushed
    assert json.loads((tmp_path / "interrupts.json").read_text())["told"] == ["message:1"]


async def test_a_change_made_while_it_writes_is_saved_next_time(tmp_path, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    real = jsonstore.save_json

    def held(path, data, **kw):
        entered.set()
        release.wait(5)
        real(path, data, **kw)

    monkeypatch.setattr(interrupts.jsonstore, "save_json", held)
    watch = watcher(tmp_path)
    watch._tell("message:1")
    look = asyncio.create_task(watch.poll())
    await asyncio.to_thread(entered.wait, 5)
    watch._tell("message:2")  # arrives while the first state is being written
    release.set()
    await look
    assert watch._dirty  # what was written is already behind
    on_disk = json.loads((tmp_path / "interrupts.json").read_text())
    assert on_disk["told"] == ["message:1"]
    watch._save()
    assert json.loads((tmp_path / "interrupts.json").read_text())["told"] == [
        "message:1",
        "message:2",
    ]
    assert not watch._dirty


def test_an_older_state_never_lands_over_a_newer_one(tmp_path):
    watch = watcher(tmp_path)
    watch._write({"told": ["new"]}, 2)
    watch._write({"told": ["old"]}, 1)  # a slow thread's earlier state, finishing late
    assert json.loads((tmp_path / "interrupts.json").read_text())["told"] == ["new"]


async def test_a_save_that_fails_is_tried_again(tmp_path, monkeypatch):
    def full(*_a, **_k):
        raise OSError(28, "No space left on device")

    watch = watcher(tmp_path)
    watch._tell("message:3")
    monkeypatch.setattr(interrupts.jsonstore, "save_json", full)
    await watch.poll()
    assert watch._dirty and not (tmp_path / "interrupts.json").exists()
    monkeypatch.undo()
    await watch.poll()
    assert not watch._dirty
    assert json.loads((tmp_path / "interrupts.json").read_text())["told"] == ["message:3"]


def test_an_unreadable_file_is_never_saved_over(tmp_path):
    path = tmp_path / "interrupts.json"
    path.write_text("{}")
    path.chmod(0)
    try:
        watch = watcher(tmp_path)
        if not watch.unreadable:  # running as a user who can read anything: nothing to see
            return
        watch._tell("message:4")
        asyncio.run(watch.poll())
    finally:
        path.chmod(0o600)
    assert path.read_text() == "{}"
