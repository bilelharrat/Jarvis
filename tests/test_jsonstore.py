"""The one way every store reads and saves its file: whole or not at all, a copy of the last
good one kept, damage kept aside, never saved over a file it couldn't read."""

import json
import os
import stat
import subprocess
import sys
import time

import pytest

from jarvis import jsonstore

REAL_SYNC = jsonstore._sync  # conftest swaps it for a plain fsync in every test


def test_a_real_save_is_flushed_to_the_disk_itself(tmp_path, monkeypatch):
    """F_FULLFSYNC, not just fsync: on a Mac fsync stops at the drive's cache, so a power
    cut could still leave a torn or empty file."""
    asked = []
    real_fcntl = jsonstore.fcntl.fcntl

    def fcntl(fd, op, *args):
        asked.append(op)
        return real_fcntl(fd, op, *args)

    monkeypatch.setattr(jsonstore, "_sync", REAL_SYNC)
    monkeypatch.setattr(jsonstore.fcntl, "fcntl", fcntl)
    jsonstore.save_json(tmp_path / "prefs.json", {"hands_free": False})
    assert jsonstore.fcntl.F_FULLFSYNC in asked


def test_a_save_round_trips_privately_and_keeps_the_last_good_copy(tmp_path):
    path = tmp_path / "memory.json"
    jsonstore.save_json(path, [{"id": "a", "text": "one"}])
    jsonstore.save_json(path, [{"id": "a", "text": "one"}, {"id": "b", "text": "二"}])
    assert jsonstore.read_json(path, list) == (
        [{"id": "a", "text": "one"}, {"id": "b", "text": "二"}],
        "ok",
    )
    assert json.loads(path.with_name("memory.json.bak").read_text()) == [{"id": "a", "text": "one"}]
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert not list(tmp_path.glob("*.tmp")) and not list(tmp_path.glob(".*"))


@pytest.mark.parametrize(
    "blob",
    [
        b'[{"id": "a", "te',  # cut short
        b"null",  # the wrong shape
        b"[" * 100_000 + b"]" * 100_000,  # nested past reason
        b'[{"id": "a", "text": "\xff"}]',  # not UTF-8
    ],
    ids=["cut-short", "wrong-shape", "nested", "not-utf-8"],
)
def test_damage_is_kept_aside_and_the_last_good_copy_read(tmp_path, blob):
    path = tmp_path / "memory.json"
    jsonstore.save_json(path, [{"id": "a", "text": "good"}])
    jsonstore.save_json(path, [{"id": "a", "text": "good"}, {"id": "b", "text": "newer"}])
    path.write_bytes(blob)
    assert jsonstore.read_json(path, list) == ([{"id": "a", "text": "good"}], "restored")
    [kept] = tmp_path.glob("memory.json.bad-*")
    assert kept.read_bytes() == blob and not path.exists()


def test_what_isnt_there_or_is_empty_is_nothing(tmp_path):
    path = tmp_path / "memory.json"
    assert jsonstore.read_json(path, list) == (None, "missing")
    path.write_bytes(b"  \n")
    assert jsonstore.read_json(path, list) == (None, "empty")
    path.write_bytes(b'{"no": "list"}')
    assert jsonstore.read_json(path, list) == (None, "damaged")
    jsonstore.save_json(path, [1])
    jsonstore.save_json(path, [1, 2])
    path.unlink()  # the owner deleted it to start over: the copy doesn't bring it back
    assert jsonstore.read_json(path, list) == (None, "missing")


def test_a_second_damage_never_overwrites_the_first(tmp_path):
    path = tmp_path / "prefs.json"
    for blob in (b"{one", b"{two", b"{three"):
        path.write_bytes(blob)
        jsonstore.read_json(path, dict)
    kept = sorted(tmp_path.glob("prefs.json.bad-*"))
    assert {k.read_bytes() for k in kept} == {b"{one", b"{two", b"{three"}


def test_a_file_that_cant_be_read_now_is_left_alone(tmp_path):
    path = tmp_path / "memory.json"
    jsonstore.save_json(path, [1])
    os.chmod(path, 0)
    try:
        with pytest.raises(jsonstore.Unreadable) as caught:
            jsonstore.read_json(path, list)
        assert caught.value.strerror == "Permission denied"
    finally:
        os.chmod(path, 0o600)
    assert json.loads(path.read_text()) == [1] and not list(tmp_path.glob("*.bad-*"))


def test_damage_that_cant_be_moved_aside_is_never_saved_over(tmp_path):
    folder = tmp_path / "locked"
    folder.mkdir()
    path = folder / "memory.json"
    path.write_bytes(b"{damaged")
    os.chmod(folder, 0o500)  # readable, but nothing can be renamed in it
    try:
        with pytest.raises(jsonstore.Unreadable, match="couldn't be moved aside"):
            jsonstore.read_json(path, list)
    finally:
        os.chmod(folder, 0o700)
    assert path.read_bytes() == b"{damaged"


def test_half_a_surrogate_pair_never_makes_a_file_unsaveable(tmp_path):
    path = tmp_path / "delegations.json"
    jsonstore.save_json(path, {"contact": "Sam \ud83d", "note": "日本"})
    assert jsonstore.load_json(path, dict) == {"contact": "Sam \ud83d", "note": "日本"}


def test_a_failed_write_leaves_the_file_and_no_temp_file(tmp_path, monkeypatch):
    path = tmp_path / "routines.json"
    jsonstore.save_json(path, ["kept"])

    def disk_full(*_args, **_kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(jsonstore.json, "dump", disk_full)
    with pytest.raises(OSError, match="No space"):
        jsonstore.save_json(path, ["lost"])
    assert json.loads(path.read_text()) == ["kept"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["routines.json"]


def test_backup_false_drops_the_old_copy(tmp_path):
    """So a forgotten fact or an unpaired phone can't come back from it."""
    path = tmp_path / "devices.json"
    jsonstore.save_json(path, ["phone", "watch"])
    jsonstore.save_json(path, ["phone", "watch", "ipad"])
    assert path.with_name("devices.json.bak").exists()
    jsonstore.save_json(path, ["phone"], backup=False)
    assert not path.with_name("devices.json.bak").exists()


def test_temp_files_a_killed_save_left_are_swept_but_never_a_live_one(tmp_path):
    path = tmp_path / "rules.json"
    jsonstore.save_json(path, {"/p": ["ls"]})
    old = tmp_path / ".rules.json.abc123.tmp"
    old_link = tmp_path / ".rules.json.def456.tmp.bak"
    fresh = tmp_path / ".rules.json.ghi789.tmp"
    for leftover in (old, old_link, fresh):
        leftover.write_text("{half")
    hour_ago = time.time() - 3600
    os.utime(old, (hour_ago, hour_ago))
    os.utime(old_link, (hour_ago, hour_ago))
    assert jsonstore.load_json(path, dict) == {"/p": ["ls"]}
    assert not old.exists() and not old_link.exists() and fresh.exists()


def test_reading_a_folder_of_stores_lists_it_once_and_still_sweeps_new_leftovers(
    tmp_path, monkeypatch
):
    """A read looks for its own leftovers; the folder is listed once, not once per store
    (a thousand kept sessions took seconds), and again as soon as it has changed."""
    for i in range(50):
        jsonstore.save_json(tmp_path / f"s{i}.json", {"i": i})
    listed = []
    real = os.listdir
    monkeypatch.setattr(os, "listdir", lambda p: listed.append(p) or real(p))
    assert [jsonstore.load_json(tmp_path / f"s{i}.json", dict)["i"] for i in range(50)] == list(
        range(50)
    )
    assert len(listed) == 1
    # A save stopped half way, found after the folder was listed: still swept once old.
    old = tmp_path / ".s7.json.abc123.tmp"
    other = tmp_path / ".s70.json.abc123.tmp"  # another store's: never this one's to sweep
    fresh = tmp_path / ".s7.json.def456.tmp"
    for leftover in (old, other, fresh):
        leftover.write_text("{half")
    hour_ago = time.time() - 3600
    os.utime(old, (hour_ago, hour_ago))
    os.utime(other, (hour_ago, hour_ago))
    assert jsonstore.load_json(tmp_path / "s7.json", dict) == {"i": 7}
    assert not old.exists() and other.exists() and fresh.exists()
    jsonstore.load_json(tmp_path / "s8.json", dict)  # listed again: the sweep changed it
    assert len(listed) == 3
    # Grown old while nothing in the folder changed: swept from the listing kept.
    os.utime(fresh, (hour_ago, hour_ago))
    jsonstore.load_json(tmp_path / "s7.json", dict)
    assert not fresh.exists() and len(listed) == 3


def test_a_folder_on_a_coarse_clock_is_listed_every_time(tmp_path, monkeypatch):
    """An mtime in whole milliseconds (HFS+, exFAT) may not move for a change in the same
    tick: such a folder is never trusted to be unchanged."""
    from types import SimpleNamespace

    jsonstore.save_json(tmp_path / "a.json", {})
    real_stat = os.stat

    def coarse(path, *args, **kwargs):
        found = real_stat(path, *args, **kwargs)
        if os.fspath(path) == os.fspath(tmp_path):
            return SimpleNamespace(st_mtime_ns=found.st_mtime_ns // 10**9 * 10**9)
        return found

    monkeypatch.setattr(os, "stat", coarse)
    listed = []
    real = os.listdir
    monkeypatch.setattr(os, "listdir", lambda p: listed.append(p) or real(p))
    for _ in range(3):
        jsonstore.load_json(tmp_path / "a.json", dict)
    assert len(listed) == 3


def test_a_save_is_quick(tmp_path, monkeypatch):
    """Measured at 5-7 ms for 200 facts with F_FULLFSYNC and the kept copy; the target is
    10 ms."""
    monkeypatch.setattr(jsonstore, "_sync", REAL_SYNC)
    path = tmp_path / "memory.json"
    facts = [{"id": str(i), "text": "y" * 200, "at": "2026-09-29T09:00:00"} for i in range(200)]
    started = time.perf_counter()
    for _ in range(20):
        jsonstore.save_json(path, facts)
    assert (time.perf_counter() - started) / 20 < 0.05  # generous: the machine may be busy


WRITER = """
import os, sys
from pathlib import Path
from jarvis import jsonstore
jsonstore._sync = jsonstore._sync_folder = lambda _: None  # whole files, not the drive's cache
path, tag, n = Path(sys.argv[1]), sys.argv[2], int(sys.argv[3])
errors = 0
for i in range(n):
    rows = [{"id": f"{tag}{i}", "text": "x" * (1000 if tag == "a" else 10)}] * (20 if tag == "a" else 2)
    try:
        jsonstore.save_json(path, rows)
    except OSError as exc:
        errors += 1
        print(exc, file=sys.stderr)
print(errors)
"""


def test_two_writers_never_fail_or_tear_the_file(tmp_path):
    """Two processes x 600 saves each (4x the 150 that tore files and lost updates before)
    while this one keeps reading: no save fails, no read ever sees half a file, and no temp
    file is left behind."""
    path = tmp_path / "memory.json"
    jsonstore.save_json(path, [])
    writers = [
        subprocess.Popen(
            [sys.executable, "-c", WRITER, str(path), tag, "600"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for tag in ("a", "b")
    ]
    reads = torn = 0
    deadline = time.monotonic() + 120
    while any(w.poll() is None for w in writers) and time.monotonic() < deadline:
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            torn += 1  # the file must always be there
            continue
        reads += 1
        try:
            json.loads(raw)
        except ValueError:
            torn += 1
    outs = [w.communicate(timeout=60) for w in writers]
    assert [out.strip() for out, _err in outs] == ["0", "0"], outs
    assert torn == 0 and reads > 0
    assert not list(tmp_path.glob("*.tmp")) and not list(tmp_path.glob(".*.tmp*"))
