"""A backend the app started stops once the app is gone (launcher_watch.py)."""

from __future__ import annotations

from types import SimpleNamespace

from jarvis import launcher_watch
from jarvis.launcher_watch import Watch, find_app


def proc(pid, exe, parent=None):
    return SimpleNamespace(pid=pid, exe=lambda: exe, parent=lambda: parent)


def test_the_app_is_found_above_uv_or_directly():
    app = proc(
        10,
        "/Users/me/Applications/J.A.R.V.I.S.app/Contents/MacOS/J.A.R.V.I.S",
        proc(1, "/sbin/launchd"),
    )
    uv = proc(20, "/opt/homebrew/bin/uv", app)
    me = proc(30, "/repo/.venv/bin/python3", uv)
    assert find_app(me) is app
    assert find_app(proc(31, "python", app)) is app
    bundle = "/Users/me/Applications/J.A.R.V.I.S.app"
    assert find_app(me, bundle) is app
    assert find_app(me, "/Applications/Other.app") is None


def test_no_app_started_it():
    shell = proc(5, "/bin/zsh", proc(1, "/sbin/launchd"))
    assert find_app(proc(6, "python", shell)) is None
    assert find_app(proc(7, "python", proc(1, "/lib/systemd/systemd"))) is None  # the cloud server

    def gone():
        raise ProcessLookupError

    assert find_app(SimpleNamespace(pid=8, parent=gone)) is None


def test_it_stops_when_the_app_goes_and_ends_if_stopping_hangs():
    now = [0.0]
    alive = [True]
    calls = []
    watch = Watch(
        lambda: alive[0],
        lambda: calls.append("stop"),
        lambda: calls.append("force"),
        lambda: now[0],
    )
    assert watch.check() == ""
    alive[0] = False
    assert watch.check() == "stop" and calls == ["stop"]
    now[0] += launcher_watch.STOP_GRACE - 1
    assert watch.check() == ""
    now[0] += 2
    assert watch.check() == "force" and calls == ["stop", "force"]
