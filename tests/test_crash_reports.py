"""Crash reports (features/crash_reports, audit O1): off until the owner turns them on;
on, the backend's uncaught failures (threads and asyncio tasks too) and the window's errors
are kept on this Mac, scrubbed, counted once when they repeat and capped an hour; the
diagnostics file carries them and lists the app's minidumps without taking one; nothing is
sent (the upload hook has nowhere to go)."""

import asyncio
import json
import sys
import threading
import types
import zipfile
from datetime import datetime

import pytest

from jarvis.features import crash_reports
from jarvis.features.ops import diagnostics

KEY = "sk-ant-api03-" + "x7Q2" * 10


class Prefs:
    def __init__(self, on=False):
        self.features = {"crash_reports": on} if on else {}

    def feature(self, key):
        return self.features.get(key, False)


def reporter(tmp_path, on=True, clock=None):
    emitted = []
    hub = types.SimpleNamespace(
        prefs=Prefs(on),
        emit=lambda kind, **data: emitted.append((kind, data)),
        feature_path=lambda name: tmp_path / name,
    )
    times = iter(clock or [1_800_000_000.0 + i for i in range(1000)])
    rep = crash_reports.Reporter(hub, clock=lambda: next(times), home=tmp_path / "home")
    return rep, hub, emitted


def kept(tmp_path):
    return sorted((tmp_path / "crash-reports").glob("*.json"))


def test_nothing_is_kept_until_the_owner_turns_them_on(tmp_path):
    rep, _hub, _ = reporter(tmp_path, on=False)
    assert rep.record("backend", "uncaught", "boom") is None
    assert kept(tmp_path) == []
    assert crash_reports.PREF == "crash_reports"
    from jarvis.prefs import FEATURE_PREFS

    assert FEATURE_PREFS["crash_reports"][0] is False  # off by default


def test_a_report_is_kept_scrubbed_with_its_version(tmp_path):
    rep, _hub, _ = reporter(tmp_path)
    home = tmp_path / "home"
    path = rep.record(
        "backend",
        "uncaught: RuntimeError",
        f"failed for ann@example.com with {KEY}",
        f'File "{home}/Projects/app.py", line 3\n  token=abcdef1234567890',
    )
    data = json.loads(path.read_text())
    text = json.dumps(data)
    assert KEY not in text and "ann@example.com" not in text and str(home) not in text
    assert "abcdef1234567890" not in text
    assert "~/Projects/app.py" in data["stack"]
    assert data["source"] == "backend" and data["times"] == 1 and data["version"] == 1
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_the_same_failure_again_is_counted_and_an_hour_holds_only_so_many(tmp_path):
    rep, _hub, _ = reporter(tmp_path)
    first = rep.record("backend", "uncaught", "boom", "stack")
    assert rep.record("backend", "uncaught", "boom", "stack") is None
    assert json.loads(first.read_text())["times"] == 2
    for n in range(crash_reports.PER_HOUR + 5):
        rep.record("window", "window error", f"different {n}")
    assert len(kept(tmp_path)) == crash_reports.PER_HOUR


def test_only_the_newest_are_kept(tmp_path, monkeypatch):
    monkeypatch.setattr(crash_reports, "KEEP", 3)
    monkeypatch.setattr(crash_reports, "PER_HOUR", 100)
    rep, _hub, _ = reporter(tmp_path, clock=[1_800_000_000.0 + i * 5 for i in range(20)])
    for n in range(6):
        rep.record("backend", "uncaught", f"failure {n}")
    assert [json.loads(p.read_text())["message"] for p in kept(tmp_path)] == [
        "failure 3",
        "failure 4",
        "failure 5",
    ]


async def test_uncaught_failures_threads_and_tasks_are_reported_and_still_reach_the_old_handlers(
    tmp_path, monkeypatch
):
    rep, _hub, _ = reporter(tmp_path)
    heard = []
    monkeypatch.setattr(sys, "excepthook", lambda *a: heard.append("sys"))
    monkeypatch.setattr(threading, "excepthook", lambda args: heard.append("thread"))
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(loop, "_exception_handler", lambda lp, ctx: heard.append("loop"))
    await rep.watch()
    try:
        try:
            raise ValueError("from the main thread")
        except ValueError as exc:
            sys.excepthook(type(exc), exc, exc.__traceback__)

        def fails():
            raise KeyError("in a thread")

        worker = threading.Thread(target=fails, name="worker")
        worker.start()
        worker.join()

        async def task_fails():
            raise OSError("in a task")

        task = loop.create_task(task_fails())
        await asyncio.sleep(0)
        loop.call_exception_handler({"message": "Task exception", "exception": task.exception()})
    finally:
        loop.set_exception_handler(None)
    kinds = sorted(json.loads(p.read_text())["kind"] for p in kept(tmp_path))
    assert kinds == ["asyncio task: OSError", "thread worker: KeyError", "uncaught: ValueError"]
    assert heard == ["sys", "thread", "loop"]


async def test_the_windows_errors_come_in_through_its_command(tmp_path):
    rep, _hub, emitted = reporter(tmp_path)
    rep.cmd_report(
        {"kind": "window error: TypeError", "message": "x is undefined", "stack": "at f"}
    )
    [path] = kept(tmp_path)
    assert json.loads(path.read_text())["source"] == "window"
    rep.cmd_state({})
    assert emitted[-1] == (
        "crash_reports",
        {"on": True, "count": 1, "folder": str(tmp_path / "crash-reports")},
    )


def test_nothing_is_sent_and_the_upload_hook_is_there_for_later(tmp_path, monkeypatch):
    assert crash_reports.UPLOAD_URL == ""
    rep, _hub, _ = reporter(tmp_path)
    sent = []
    monkeypatch.setattr(rep, "upload", lambda report: sent.append(report) or False)
    rep.record("backend", "uncaught", "boom")
    assert len(sent) == 1  # every kept report passes the hook (which sends nothing today)
    assert crash_reports.Reporter.upload(rep, {"message": "x"}) is False


def test_the_diagnostics_file_carries_the_reports_and_only_lists_the_minidumps(tmp_path):
    rep, _hub, _ = reporter(tmp_path)
    rep.record("backend", "uncaught", "boom")
    folder = tmp_path / "crash-reports"
    # One the app wrote (app/features/crash-reports.js), with a secret in it somehow.
    (folder / "20261013-090000-electron-01.json").write_text(
        json.dumps({"source": "electron", "kind": "renderer gone", "message": f"crashed {KEY}"})
    )
    (folder / "electron" / "pending").mkdir(parents=True)
    (folder / "electron" / "pending" / "a1.dmp").write_bytes(b"MDMP memory with secrets")
    logs = tmp_path / "logs"
    logs.mkdir()
    path = diagnostics.build(
        tmp_path / "out",
        logs=logs,
        home=tmp_path / "home",
        info={},
        checkup={},
        review={},
        clock=lambda: datetime(2026, 10, 13, 9, 0, 0),
        extra=rep.for_diagnostics(),
    )
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        assert sum(n.startswith("crash-reports/") and n.endswith(".json") for n in names) == 3
        assert not any(n.endswith(".dmp") for n in names)
        dumps = json.loads(zf.read("crash-reports/minidumps.json"))
        assert [d["name"] for d in dumps] == ["a1.dmp"]
        everything = b"".join(zf.read(n) for n in names)
    assert KEY.encode() not in everything and b"MDMP" not in everything


@pytest.mark.parametrize("bad", ["../escape.txt", "logs/other.log"])
def test_the_bundle_takes_extra_files_only_under_crash_reports(tmp_path, bad):
    logs = tmp_path / "logs"
    logs.mkdir()
    path = diagnostics.build(
        tmp_path / "out",
        logs=logs,
        home=tmp_path,
        info={},
        checkup={},
        review={},
        extra=[(bad, "x")],
    )
    with zipfile.ZipFile(path) as zf:
        assert bad not in zf.namelist()
