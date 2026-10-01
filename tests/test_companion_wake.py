"""The listener that opens JARVIS for a paired phone (jarvis.companion_wake)."""

from __future__ import annotations

import hashlib
import json
import plistlib
import socket
import ssl
import threading
from types import SimpleNamespace

from jarvis import companion_tls, companion_wake

TOKEN = "phone-token-" + "x" * 30


def folder_with_phone(tmp_path):
    digest = hashlib.sha256(TOKEN.encode()).hexdigest()
    (tmp_path / "devices.json").write_text(json.dumps([{"id": "p1", "token_hash": digest}]))
    return tmp_path


def wake(token=TOKEN, path="/wake", method="POST") -> bytes:
    return (
        f"{method} {path} HTTP/1.1\r\nHost: mac\r\nAuthorization: Bearer {token}\r\n\r\n".encode()
    )


class Launchctl:
    def __init__(self, loaded=False, fails=False):
        self.calls, self.loaded, self.fails = [], loaded, fails

    def __call__(self, args, **_kw):
        self.calls.append(args[1])
        if args[1] == "print":
            return SimpleNamespace(returncode=0 if self.loaded else 113, stderr=b"")
        if args[1] == "bootstrap":
            self.loaded = not self.fails
            return SimpleNamespace(returncode=5 if self.fails else 0, stderr=b"no")
        if args[1] == "bootout":
            self.loaded = False
        return SimpleNamespace(returncode=0, stderr=b"")


# ── who it answers ──


def test_only_a_paired_phone_asking_to_wake_gets_the_app_opened(tmp_path):
    folder = folder_with_phone(tmp_path)
    assert companion_wake.answer(wake(), folder) == (202, {"ok": True, "opening": True})
    assert companion_wake.answer(wake(token="guess"), folder)[0] == 401
    assert companion_wake.answer(wake(token=""), folder)[0] == 401
    assert companion_wake.answer(wake(path="/api/state"), folder)[0] == 404
    assert companion_wake.answer(wake(method="GET"), folder)[0] == 404
    assert companion_wake.answer(b"garbage", folder)[0] == 404


def test_without_paired_phones_nothing_wakes_it(tmp_path):
    assert companion_wake.answer(wake(), tmp_path)[0] == 401  # no devices.json
    (tmp_path / "devices.json").write_text("{not json")
    assert companion_wake.answer(wake(), tmp_path)[0] == 401
    (tmp_path / "devices.json").write_text(json.dumps([{"id": "p1"}, 5, {"token_hash": ""}]))
    assert companion_wake.answer(wake(), tmp_path)[0] == 401


def test_it_opens_the_app_in_the_background_and_says_so(tmp_path):
    folder = folder_with_phone(tmp_path)
    opened = []
    here, there = socket.socketpair()
    with here, there:
        here.sendall(wake())
        status = companion_wake.serve(
            there, "/Applications/J.A.R.V.I.S..app", folder, opener=lambda a, **_k: opened.append(a)
        )
        reply = here.recv(4096)
    assert status == 202 and opened == [["/usr/bin/open", "-g", "/Applications/J.A.R.V.I.S..app"]]
    assert reply.startswith(b"HTTP/1.1 202 Accepted") and reply.endswith(
        b'{"ok": true, "opening": true}'
    )

    opened.clear()
    here, there = socket.socketpair()
    with here, there:
        here.sendall(wake(token="nope"))
        assert (
            companion_wake.serve(there, "/x.app", folder, opener=lambda a, **_k: opened.append(a))
            == 401
        )
        assert here.recv(4096).startswith(b"HTTP/1.1 401")
    assert opened == []


def test_it_speaks_tls_with_the_companions_own_certificate(tmp_path, monkeypatch):
    folder = folder_with_phone(tmp_path)
    identity = companion_tls.create(folder, ["mac.local"])
    opened = []
    monkeypatch.setattr(companion_wake.subprocess, "run", lambda a, **_k: opened.append(a))
    phone, mac = socket.socketpair()
    monkeypatch.setattr(companion_wake.sys, "stdin", SimpleNamespace(fileno=mac.fileno))
    server = threading.Thread(
        target=companion_wake.main, args=(["--open", "/x.app", "--folder", str(folder)],)
    )
    server.start()
    context = ssl.create_default_context()
    context.check_hostname, context.verify_mode = False, ssl.CERT_NONE
    with context.wrap_socket(phone) as conn:
        der = conn.getpeercert(binary_form=True)
        conn.sendall(wake())
        reply = conn.recv(4096)
    server.join(5)
    assert companion_tls.fingerprint_of(der) == identity.fingerprint  # the phone's pin holds
    assert reply.startswith(b"HTTP/1.1 202") and opened == [["/usr/bin/open", "-g", "/x.app"]]


def test_without_the_companions_certificate_it_does_nothing(tmp_path):
    assert companion_wake.main(["--open", "/x.app", "--folder", str(tmp_path)]) == 0


# ── the LaunchAgent ──


def test_the_agent_has_launchd_listen_and_start_one_answer_per_connection(tmp_path):
    plist = companion_wake.agent("/Applications/J.A.R.V.I.S..app", tmp_path, "/py/bin/python3")
    assert plist["Label"] == "com.bshventures.jarvis.wake"
    assert plist["ProgramArguments"] == [
        "/py/bin/python3", "-m", "jarvis.companion_wake",
        "--open", "/Applications/J.A.R.V.I.S..app", "--folder", str(tmp_path),
    ]  # fmt: skip
    assert plist["inetdCompatibility"] == {"Wait": False}
    assert plist["Sockets"]["Listeners"] == {"SockServiceName": "8764", "SockType": "stream"}


def test_installing_writes_and_loads_it_once(tmp_path):
    app = tmp_path / "J.A.R.V.I.S..app"
    app.mkdir()
    launchctl = Launchctl()
    assert companion_wake.install(str(app), tmp_path, "/py", home=tmp_path, run=launchctl)
    written = plistlib.loads(companion_wake.plist_path(tmp_path).read_bytes())
    assert written["ProgramArguments"][4] == str(app)
    assert launchctl.calls == ["print", "bootstrap"]
    launchctl.calls.clear()
    assert companion_wake.install(str(app), tmp_path, "/py", home=tmp_path, run=launchctl)
    assert launchctl.calls == ["print"]  # already in place: left alone

    moved = tmp_path / "Other.app"
    moved.mkdir()
    launchctl.calls.clear()
    assert companion_wake.install(str(moved), tmp_path, "/py", home=tmp_path, run=launchctl)
    assert launchctl.calls == ["print", "bootout", "bootstrap"]  # the app moved: reloaded


def test_without_its_app_nothing_is_installed(tmp_path, monkeypatch):
    monkeypatch.delenv(companion_wake.APP_ENV, raising=False)
    launchctl = Launchctl()
    assert not companion_wake.install(None, tmp_path, "/py", home=tmp_path, run=launchctl)
    assert not companion_wake.install(
        str(tmp_path / "gone.app"), tmp_path, "/py", home=tmp_path, run=launchctl
    )
    assert not companion_wake.install(str(tmp_path), tmp_path, "/py", home=tmp_path, run=launchctl)
    assert launchctl.calls == [] and not companion_wake.plist_path(tmp_path).exists()


def test_a_launchd_refusal_is_reported(tmp_path):
    app = tmp_path / "J.A.R.V.I.S..app"
    app.mkdir()
    assert not companion_wake.install(
        str(app), tmp_path, "/py", home=tmp_path, run=Launchctl(fails=True)
    )


def test_only_the_apps_backend_removes_it(tmp_path, monkeypatch):
    path = companion_wake.plist_path(tmp_path)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"x")
    launchctl = Launchctl(loaded=True)
    monkeypatch.delenv(companion_wake.APP_ENV, raising=False)
    companion_wake.uninstall(home=tmp_path, run=launchctl)
    assert path.exists() and launchctl.calls == []  # a test or a backend run by hand
    monkeypatch.setenv(companion_wake.APP_ENV, "/Applications/J.A.R.V.I.S..app")
    companion_wake.uninstall(home=tmp_path, run=launchctl)
    assert not path.exists() and launchctl.calls == ["bootout"]
