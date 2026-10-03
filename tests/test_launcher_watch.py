"""A backend the app started stops once the app is gone (launcher_watch.py)."""

from __future__ import annotations

from types import SimpleNamespace

from jarvis import launcher_watch
from jarvis.launcher_watch import Watch, find_app, find_launcher

BUNDLE = "/Users/me/Applications/J.A.R.V.I.S.app"


def proc(pid, exe, parent=None):
    return SimpleNamespace(pid=pid, exe=lambda: exe, parent=lambda: parent)


def tree():
    """The app, uv under it, this backend under that."""
    app = proc(10, f"{BUNDLE}/Contents/MacOS/J.A.R.V.I.S", proc(1, "/sbin/launchd"))
    uv = proc(20, "/opt/homebrew/bin/uv", app)
    return app, proc(30, "/repo/.venv/bin/python3", uv)


def test_the_app_is_found_above_uv_or_directly():
    app, me = tree()
    assert find_app(me, BUNDLE) is app
    assert find_app(proc(31, "python", app), BUNDLE) is app
    assert find_app(me, "/Applications/Other.app") is None


def test_the_app_is_never_guessed():
    """Guessing it — the first ancestor inside any .app — took a terminal, an editor or one
    of Electron's helpers for the app. A helper quits while the app runs, and the backend
    stopped itself mid-session."""
    _, me = tree()
    assert find_app(me) is None

    helper = proc(
        11,
        f"{BUNDLE}/Contents/Frameworks/J.A.R.V.I.S Helper.app/Contents/MacOS/J.A.R.V.I.S Helper",
        proc(1, "/sbin/launchd"),
    )
    assert find_app(proc(12, "python", helper), BUNDLE) is None

    terminal = proc(13, "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal")
    assert find_app(proc(14, "python", terminal)) is None


def test_the_launcher_is_watched_by_the_pid_the_app_gave():
    app, me = tree()
    assert find_launcher(me, str(app.pid)) is app
    assert find_launcher(me, "") is None
    assert find_launcher(me, "nonsense") is None
    assert find_launcher(me, "1") is None  # launchd is nobody's launcher
    assert find_launcher(me, "9999") is None  # a pid that isn't above us is not ours


def test_no_app_started_it():
    shell = proc(5, "/bin/zsh", proc(1, "/sbin/launchd"))
    assert find_app(proc(6, "python", shell), BUNDLE) is None
    assert find_app(proc(7, "python", proc(1, "/lib/systemd/systemd")), BUNDLE) is None  # cloud

    def gone():
        raise ProcessLookupError

    assert find_app(SimpleNamespace(pid=8, parent=gone), BUNDLE) is None
    assert find_launcher(SimpleNamespace(pid=9, parent=gone), "10") is None


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
