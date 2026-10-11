"""Dev servers for Eden Code projects: launch configs read defensively, suggestions that
never run by themselves, and servers in their own process groups that stop whole, stop with
the session that started them, and never outlive the app."""

import asyncio
import contextlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from jarvis import devservers, runproc
from jarvis.devservers import DevServers, LaunchConfig, read_launch, save_config, suggest


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def launch(project, configs, where=".claude/launch.json"):
    path = project / where
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": "0.0.1", "configurations": configs}))
    return path


def plain_env():
    return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "")}


async def until(condition, seconds=90.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        await asyncio.sleep(0.05)
    return False


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie counts as gone.
    out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return bool(out.stdout.strip()) and not out.stdout.strip().startswith("Z")


# ── output ──


def test_lines_are_split_however_the_output_is_chunked():
    s = runproc.LineSplitter()
    assert s.feed(b"hel") == []
    assert s.feed(b"lo\nwor") == ["hello"]
    # A progress bar redrawn in place keeps its last state; colours are stripped.
    assert s.feed(b"ld\n10%\r50%\r\x1b[32m100%\x1b[0m\n") == ["world", "100%"]
    # A character split across chunks is kept whole.
    snow = "☃".encode()
    assert s.feed(snow[:1]) == []
    assert s.feed(snow[1:] + b"\n") == ["☃"]
    assert s.feed(b"no end") == [] and s.flush() == ["no end"]


def test_a_huge_line_with_no_end_is_taken_as_it_is():
    s = runproc.LineSplitter()
    out = s.feed(b"x" * (runproc.PARTIAL_MAX + 10))
    assert len(out) == 1 and len(out[0]) == runproc.LINE_MAX and out[0].endswith("…")


def test_a_very_long_line_is_said_once_cut_and_a_progress_bar_waits_for_its_end():
    s = runproc.LineSplitter()
    # 5 MB with no end: one cut line, not hundreds; the rest of it left out until its end.
    out = []
    for _ in range(50):
        out += s.feed(b"y" * 100_000)
    assert len(out) == 1 and out[0].endswith("…") and len(out[0]) == runproc.LINE_MAX
    assert s.feed(b"yyy\nnext line\n") == ["next line"]
    # A line just over the cut, with its end: marked as cut.
    assert s.feed(b"z" * (runproc.LINE_MAX + 5) + b"\n") == ["z" * (runproc.LINE_MAX - 1) + "…"]
    # A progress bar that redraws with \r and never ends a line: nothing until its end, then
    # its last drawing only.
    bar = b"".join(f"\rprogress {i:05d}".encode() for i in range(3000))
    assert s.feed(bar) == [] and s.feed(bar) == []
    assert s.feed(b"\rdone\n") == ["done"]


def test_output_read_as_data_keeps_its_lines_whole():
    """A checker's JSON on one line (eslint's): never cut at LINE_MAX."""
    s = runproc.LineSplitter(None, 4_000_000)
    line = json.dumps([{"filePath": "/a.js", "source": "x" * 5000, "messages": []}])
    assert s.feed(line.encode() + b"\n") == [line]
    assert s.feed(b"w" * 20_000) == [] and s.flush() == ["w" * 20_000]


def test_the_log_ring_numbers_lines_and_keeps_the_newest():
    ring = runproc.LogRing(3)
    ring.add(["a", "b", "c", "d"])
    assert [t for _, t in ring.lines] == ["b", "c", "d"]
    assert ring.since(2) == [(3, "c"), (4, "d")]
    assert ring.tail(2) == ["c", "d"]
    assert ring.since(0, limit=1) == [(4, "d")]


def test_the_login_shells_environment_is_read_after_its_greeting():
    raw = (
        b"Welcome back!\n"
        + runproc.ENV_MARK.encode()
        + b"PATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/x\0bad key=1\0"
    )
    env = runproc.parse_env(raw)
    assert env == {"PATH": "/opt/homebrew/bin:/usr/bin", "HOME": "/Users/x"}
    assert runproc.parse_env(b"no marker here") == {}
    assert "/opt/homebrew/bin" in runproc.fallback_env()["PATH"]


# ── configs ──


def test_launch_configs_are_read_and_checked(tmp_path):
    (tmp_path / "web").mkdir()
    launch(
        tmp_path,
        [
            {
                "name": "web",
                "runtimeExecutable": "npm",
                "runtimeArgs": ["run", "dev"],
                "port": 5173,
                "cwd": "web",
            },
            {
                "name": "api",
                "runtimeExecutable": "uv",
                "runtimeArgs": ["run", "app.py"],
                "url": "https://evil.example.com/",
            },
            {"name": "escape", "runtimeExecutable": "ls", "cwd": "../.."},
            {"runtimeExecutable": "nameless"},
            {"name": "bad args", "runtimeExecutable": "x", "runtimeArgs": "run dev"},
            {
                "name": "env",
                "runtimeExecutable": "x",
                "env": {"PORT": 4000, "bad key": "1", "OK": "yes"},
                "port": "4000",
            },
        ],
    )
    launch(
        tmp_path,
        [
            {"name": "web", "runtimeExecutable": "other"},
            {"name": "docs", "runtimeExecutable": "hugo"},
        ],
        ".jarvis/launch.json",
    )
    configs, problems = read_launch(tmp_path)
    names = [c.name for c in configs]
    assert names == ["web", "api", "env", "docs"]  # .claude's web wins over .jarvis's
    web = configs[0]
    assert (
        web.argv == ["npm", "run", "dev"]
        and web.cwd == "web"
        and web.address() == "http://localhost:5173/"
    )
    assert configs[1].url == ""  # not on this Mac: never opened
    assert configs[2].env == (("PORT", "4000"), ("OK", "yes")) and configs[2].port == 4000
    text = " ".join(problems)
    assert "url ignored" in text and "cwd must be a folder in the project" in text
    assert "without a usable name" in text and "runtimeArgs must be a list" in text


def test_a_damaged_launch_file_is_said_never_fatal(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "launch.json").write_text("{not json")
    launch(tmp_path, [{"name": "ok", "runtimeExecutable": "x"}], ".jarvis/launch.json")
    configs, problems = read_launch(tmp_path)
    assert [c.name for c in configs] == ["ok"]
    assert problems == [".claude/launch.json isn't valid JSON (line 1)."]
    (tmp_path / ".jarvis" / "launch.json").write_text(json.dumps(["not", "a", "file"]))
    assert read_launch(tmp_path)[1][-1] == ".jarvis/launch.json has no configurations list."


def test_a_saved_suggestion_goes_into_claudes_launch_file(tmp_path):
    config = LaunchConfig("dev", "npm", ("run", "dev"), 5173)
    path = save_config(tmp_path, config)
    assert path == tmp_path / ".claude" / "launch.json"
    data = json.loads(path.read_text())
    assert data["version"] == "0.0.1"
    assert data["configurations"] == [
        {"name": "dev", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 5173}
    ]
    with pytest.raises(ValueError, match="already a config called dev"):
        save_config(tmp_path, config)
    path.write_text("{damaged")
    with pytest.raises(ValueError, match="can't be read"):
        save_config(tmp_path, LaunchConfig("other", "x"))
    assert path.read_text() == "{damaged"  # never written over


def test_suggestions_come_from_the_projects_files(tmp_path):
    (tmp_path / "package.json").write_text(
        json.dumps({"scripts": {"dev": "vite", "test": "vitest"}})
    )
    (tmp_path / "pnpm-lock.yaml").write_text("")
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "package.json").write_text(
        json.dumps({"scripts": {"start": "next start -p 3100"}})
    )
    (tmp_path / "manage.py").write_text("import django\n")
    (tmp_path / "uv.lock").write_text("")
    found = {c.name: c for c in suggest(tmp_path)}
    assert found["dev"].argv == ["pnpm", "dev"] and found["dev"].port == 5173
    assert found["web start"].cwd == "web" and found["web start"].port == 3100
    assert found["django"].argv == [
        "uv",
        "run",
        "python",
        "manage.py",
        "runserver",
        "127.0.0.1:8000",
    ]
    # One it has already (by name) isn't suggested again.
    assert "dev" not in {c.name for c in suggest(tmp_path, [LaunchConfig("dev", "x")])}


def test_a_static_site_is_served_on_this_mac_only(tmp_path):
    (tmp_path / "index.html").write_text("<h1>hi</h1>")
    [static] = suggest(tmp_path)
    assert static.argv == ["python3", "-m", "http.server", "8000", "--bind", "127.0.0.1"]


def test_fastapi_and_flask_apps_are_suggested_with_their_runner(tmp_path):
    (tmp_path / "pyproject.toml").write_text('dependencies = ["fastapi", "uvicorn"]')
    (tmp_path / "main.py").write_text("from fastapi import FastAPI\napp = FastAPI()\n")
    (tmp_path / ".venv" / "bin").mkdir(parents=True)
    (tmp_path / ".venv" / "bin" / "python").write_text("")
    [api] = suggest(tmp_path)
    assert api.argv[:4] == [".venv/bin/python", "-m", "uvicorn", "main:app"] and api.port == 8000


def test_addresses_servers_print():
    cases = {
        "  ➜  Local:   http://localhost:5173/": ("http://localhost:5173/", 5173),
        "   - Local:        http://localhost:3000": ("http://localhost:3000", 3000),
        "INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)": (
            "http://127.0.0.1:8000",
            8000,
        ),
        "Starting development server at http://127.0.0.1:8000/": ("http://127.0.0.1:8000/", 8000),
        "Server listening on port 4000": ("", 4000),
        "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...": (
            "http://localhost:8000/",
            8000,
        ),
        "Compiled successfully": ("", None),
    }
    for line, want in cases.items():
        assert devservers.output_address(line) == want, line


def test_only_addresses_on_this_mac_are_local():
    for url in (
        "http://localhost:5173/",
        "http://127.0.0.1:8000",
        "http://[::1]:3000/",
        "http://app.localhost:80",
    ):
        assert devservers.is_local_url(url), url
    for url in (
        "https://example.com",
        "http://10.0.0.2:3000",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "http://localhost:99999",
        "",
    ):
        assert not devservers.is_local_url(url), url


def test_error_lines_in_a_servers_output():
    assert devservers.is_error_line("[vite] Internal server error: Failed to resolve import")
    assert devservers.is_error_line("TypeError: Cannot read properties of undefined")
    assert devservers.is_error_line("Traceback (most recent call last):")
    assert not devservers.is_error_line("Found 0 errors. Watching for file changes.")
    assert not devservers.is_error_line("  ➜  Local:   http://localhost:5173/")


# ── running (real processes, in a temp project) ──


def server_script(tmp_path, body):
    script = tmp_path / "serve.py"
    script.write_text(body)
    return script


async def test_a_server_starts_answers_logs_and_stops_whole(tmp_path):
    port = free_port()
    launch(
        tmp_path,
        [
            {
                "name": "site",
                "runtimeExecutable": sys.executable,
                "runtimeArgs": ["-u", "-m", "http.server", str(port), "--bind", "127.0.0.1"],
                "port": port,
            }
        ],
    )
    (tmp_path / "index.html").write_text("hello")
    events = []
    servers = DevServers(lambda kind, **d: events.append((kind, d)), env=plain_env)
    server = await servers.start(tmp_path, "site", started_by=None)
    assert await until(lambda: server.status == "ready")
    # The address it printed (http.server says 127.0.0.1) over the one made from its port.
    assert server.address() == f"http://127.0.0.1:{port}/"
    assert server.public()["url"] == server.address()
    # Starting it again is the same server.
    assert await servers.start(tmp_path, "site") is server
    pid = server.proc.pid
    assert await servers.stop(server.key)
    assert server.status == "stopped" and not pid_alive(pid)
    assert not await runproc.port_open(port)
    assert server.ring.tail(1) == ["[the process was terminated]"]
    assert any(k == "devservers" for k, _ in events)


async def test_stopping_takes_down_a_child_that_ignores_sigterm(tmp_path):
    marker = tmp_path / "child.pid"
    stubborn = server_script(
        tmp_path,
        "import os, signal, time, sys\n"
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "open(sys.argv[1], 'w').write(str(os.getpid()))\n"
        "time.sleep(600)\n",
    ).rename(tmp_path / "stubborn.py")
    script = server_script(
        tmp_path,
        "import subprocess, sys, time\n"
        f"child = subprocess.Popen([sys.executable, {str(stubborn)!r}, {str(marker)!r}])\n"
        "print('Server listening on port 1', flush=True)\n"
        "time.sleep(600)\n",
    )
    launch(
        tmp_path,
        [{"name": "stubborn", "runtimeExecutable": sys.executable, "runtimeArgs": [str(script)]}],
    )
    servers = DevServers(lambda *a, **k: None, env=plain_env)
    server = await servers.start(tmp_path, "stubborn")
    assert await until(lambda: marker.exists() and marker.read_text().strip())
    child = int(marker.read_text())
    assert pid_alive(child)
    t0 = time.monotonic()
    await server.proc.stop(grace=0.5)
    assert time.monotonic() - t0 < 6
    assert await until(lambda: not pid_alive(child), 20), (
        "the child that ignored SIGTERM is still running"
    )


async def test_nothing_outlives_the_app_even_one_killed_without_a_word(tmp_path):
    """The app is killed (-9): its servers' supervisors notice and take their groups down."""
    marker = tmp_path / "server.pid"
    serve = server_script(
        tmp_path,
        "import os, sys, time\nopen(sys.argv[1], 'w').write(str(os.getpid()))\ntime.sleep(600)\n",
    )
    fake_app = tmp_path / "fake_app.py"
    src = str(Path(runproc.__file__).resolve().parents[1])
    fake_app.write_text(
        "import asyncio, sys\n"
        f"sys.path.insert(0, {src!r})\n"
        "from pathlib import Path\n"
        "from jarvis import runproc\n"
        "async def main():\n"
        f"    argv = [sys.executable, {str(serve)!r}, {str(marker)!r}]\n"
        f"    p = runproc.Proc(argv, Path({str(tmp_path)!r}), {{'PATH': '/usr/bin:/bin'}}, lambda lines: None)\n"
        "    await p.start()\n"
        "    print('started', flush=True)\n"
        "    await asyncio.sleep(600)\n"
        "asyncio.run(main())\n"
    )
    app = subprocess.Popen([sys.executable, str(fake_app)], stdout=subprocess.PIPE)
    try:
        assert app.stdout.readline().strip() == b"started"
        assert await until(lambda: marker.exists() and marker.read_text().strip())
        server = int(marker.read_text())
        assert pid_alive(server)
        app.send_signal(signal.SIGKILL)
        app.wait()
        assert await until(lambda: not pid_alive(server), 30), "the server outlived the app"
    finally:
        if app.poll() is None:
            app.kill()
        app.stdout.close()


async def test_a_server_that_exits_says_so_and_one_that_cant_start_says_why(tmp_path):
    script = server_script(
        tmp_path, "print('boom: TypeError: x is undefined', flush=True)\nraise SystemExit(3)\n"
    )
    launch(
        tmp_path,
        [
            {"name": "crash", "runtimeExecutable": sys.executable, "runtimeArgs": [str(script)]},
            {"name": "missing", "runtimeExecutable": "no-such-tool-jarvis-test"},
        ],
    )
    servers = DevServers(lambda *a, **k: None, env=plain_env)
    server = await servers.start(tmp_path, "crash")
    assert await until(lambda: server.status == "exited")
    assert server.message == "It exited with code 3."
    assert server.errors_since(0) == ["boom: TypeError: x is undefined"]
    with pytest.raises(ValueError, match="isn't installed"):
        await servers.start(tmp_path, "missing")
    assert servers.servers[devservers.server_key(tmp_path, "missing")].status == "failed"
    with pytest.raises(ValueError, match="No dev server called nope"):
        await servers.start(tmp_path, "nope")


async def test_a_server_that_never_says_its_address_is_found_by_its_socket(tmp_path):
    port = free_port()
    script = server_script(
        tmp_path,
        "import socket, time\n"
        "s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n"
        f"s.bind(('127.0.0.1', {port})); s.listen()\n"
        "print('up', flush=True)\n"
        "time.sleep(600)\n",
    )
    launch(
        tmp_path,
        [{"name": "quiet", "runtimeExecutable": sys.executable, "runtimeArgs": [str(script)]}],
    )
    servers = DevServers(lambda *a, **k: None, env=plain_env)
    server = await servers.start(tmp_path, "quiet")
    try:
        assert await until(lambda: server.status == "ready", 45)
        assert server.port == port
    finally:
        await servers.close()
    assert not server.alive


async def test_a_sessions_servers_stop_when_it_ends(tmp_path):
    script = server_script(
        tmp_path, "import time\nprint('listening on port 9', flush=True)\ntime.sleep(600)\n"
    )
    launch(
        tmp_path,
        [
            {"name": "a", "runtimeExecutable": sys.executable, "runtimeArgs": [str(script)]},
            {"name": "b", "runtimeExecutable": sys.executable, "runtimeArgs": [str(script)]},
        ],
    )
    servers = DevServers(lambda *a, **k: None, env=plain_env)
    mine = await servers.start(tmp_path, "a", started_by=7)
    theirs = await servers.start(tmp_path, "b", started_by=None)
    try:
        await servers.session_ended(7)
        assert not mine.alive and mine.message == "Stopped with the session that started it."
        assert theirs.alive  # the owner's own keeps running
    finally:
        servers.shutdown()
    assert await until(lambda: not theirs.alive, 20)


async def test_what_a_finished_command_leaves_behind_goes_with_it(tmp_path):
    """sh starts a background sleep that keeps the output open, and ends: the run still ends,
    and the sleep with it."""
    marker = tmp_path / "left.pid"
    lines = []
    ended = []
    proc = runproc.Proc(
        ["/bin/sh", "-c", f"sleep 600 & echo $! > {marker}; echo started"],
        tmp_path,
        plain_env(),
        lines.extend,
        ended.append,
    )
    await proc.start()
    assert await until(lambda: ended, 45), "the run never ended"
    assert lines == ["started"] and ended == [0]
    left = int(marker.read_text())
    assert await until(lambda: not pid_alive(left), 20), "the sleep it left outlived it"


async def test_one_that_slips_into_a_session_of_its_own_is_not_waited_for(tmp_path):
    """A daemon that detaches (setsid) keeps the output open, out of reach of the group and
    session: the run still ends a few seconds after its command did."""
    marker = tmp_path / "daemon.pid"
    daemon = tmp_path / "daemon.py"
    daemon.write_text(
        "import os, sys, time\nos.setsid()\nopen(sys.argv[1], 'w').write(str(os.getpid()))\ntime.sleep(600)\n"
    )
    script = tmp_path / "start.py"
    script.write_text(
        "import subprocess, sys\n"
        f"subprocess.Popen([sys.executable, {str(daemon)!r}, {str(marker)!r}])\n"
        "print('started', flush=True)\n"
    )
    ended = []
    proc = runproc.Proc(
        [sys.executable, str(script)], tmp_path, plain_env(), lambda _l: None, ended.append
    )
    await proc.start()
    try:
        assert await until(lambda: ended, 60), "the run waited on a detached daemon"
        assert ended == [0] and proc.finished
    finally:
        with contextlib.suppress(Exception):
            os.kill(int(marker.read_text()), signal.SIGKILL)


async def test_a_stop_while_it_is_still_starting_still_stops_it(tmp_path):
    """Stop pressed right after Start (or a session ending just after it started one): the
    stop waits for the process to be there, and takes it down."""
    marker = tmp_path / "started.pid"
    script = server_script(
        tmp_path,
        "import os, sys, time\nopen(sys.argv[1], 'w').write(str(os.getpid()))\ntime.sleep(600)\n",
    )
    proc = runproc.Proc(
        [sys.executable, str(script), str(marker)], tmp_path, plain_env(), lambda _l: None
    )
    starting = asyncio.create_task(proc.start())
    await asyncio.sleep(0)  # start() is under way, the process not there yet
    assert proc.proc is None
    await asyncio.gather(starting, proc.stop(grace=2.0))
    assert await until(lambda: proc.finished, 30), "a stop during its start was lost"
    if marker.exists() and marker.read_text().strip():
        assert await until(lambda: not pid_alive(int(marker.read_text())), 20)


async def test_a_child_that_moved_to_a_session_of_its_own_stops_with_its_server(tmp_path):
    """A server that starts a helper in a new session (a daemon, a watcher with setsid):
    out of its group and session, still stopped with it, and the stop doesn't wait on it."""
    marker = tmp_path / "loose.pid"
    script = server_script(
        tmp_path,
        "import subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import os, sys, time; "
        'open(sys.argv[1], "w").write(str(os.getpid())); time.sleep(600)\', sys.argv[1]], '
        "start_new_session=True)\n"
        "print('Server listening on port 1', flush=True)\n"
        "time.sleep(600)\n",
    )
    launch(
        tmp_path,
        [
            {
                "name": "loose",
                "runtimeExecutable": sys.executable,
                "runtimeArgs": [str(script), str(marker)],
            }
        ],
    )
    servers = DevServers(lambda *a, **k: None, env=plain_env)
    server = await servers.start(tmp_path, "loose")
    assert await until(lambda: marker.exists() and marker.read_text().strip())
    loose = int(marker.read_text())
    try:
        assert os.getsid(loose) != os.getsid(server.proc.pid)
        t0 = time.monotonic()
        assert await servers.stop(server.key)
        assert time.monotonic() - t0 < 4.5, "the stop waited on what it set loose"
        assert await until(lambda: not pid_alive(loose), 10), "what it set loose outlived Stop"
    finally:
        with contextlib.suppress(OSError):
            os.kill(loose, signal.SIGKILL)


async def test_a_port_another_program_holds_is_never_taken_for_the_server(tmp_path):
    port = free_port()
    hold = socket.socket()
    hold.bind(("127.0.0.1", port))
    hold.listen(5)
    try:
        launch(
            tmp_path,
            [
                {
                    "name": "site",
                    "runtimeExecutable": sys.executable,
                    "runtimeArgs": ["-m", "http.server", str(port), "--bind", "127.0.0.1"],
                    "port": port,
                }
            ],
        )
        servers = DevServers(lambda *a, **k: None, env=plain_env)
        server = await servers.start(tmp_path, "site")
        seen = set()
        end = time.monotonic() + 20
        while server.alive and time.monotonic() < end:
            seen.add(server.status)
            await asyncio.sleep(0.02)
        assert "ready" not in seen and server.status == "exited"
        assert f"Port {port} is already in use by another program." in server.message
    finally:
        hold.close()


async def test_the_server_cap_counts_the_ones_still_starting(tmp_path, monkeypatch):
    monkeypatch.setattr(devservers, "MAX_SERVERS", 2)
    script = server_script(tmp_path, "import time\ntime.sleep(600)\n")
    launch(
        tmp_path,
        [
            {"name": f"s{i}", "runtimeExecutable": sys.executable, "runtimeArgs": [str(script)]}
            for i in range(3)
        ],
    )

    def slow_env():
        time.sleep(0.3)  # (the login shell's environment, being read)
        return plain_env()

    servers = DevServers(lambda *a, **k: None, env=slow_env)
    got = await asyncio.gather(
        *(servers.start(tmp_path, f"s{i}") for i in range(3)), return_exceptions=True
    )
    try:
        refused = [g for g in got if isinstance(g, ValueError)]
        assert len(refused) == 1 and "2 dev servers are running already" in str(refused[0])
        assert sum(1 for s in servers.servers.values() if s.alive) == 2
    finally:
        await servers.close()


async def test_a_server_that_says_its_address_is_ready_without_waiting_a_turn(tmp_path):
    port = free_port()
    script = server_script(
        tmp_path,
        "import socket, sys, time\n"
        "s = socket.socket(); s.bind(('127.0.0.1', int(sys.argv[1]))); s.listen(5)\n"
        "time.sleep(0.15)\n"
        "print(f'Local: http://127.0.0.1:{sys.argv[1]}/', flush=True)\n"
        "time.sleep(600)\n",
    )
    launch(
        tmp_path,
        [
            {
                "name": "quick",
                "runtimeExecutable": sys.executable,
                "runtimeArgs": [str(script), str(port)],
            }
        ],
    )
    servers = DevServers(lambda *a, **k: None, env=plain_env)
    server = await servers.start(tmp_path, "quick")
    try:
        assert await until(lambda: server.printed_port == port, 20)
        said = time.monotonic()
        assert await until(lambda: server.status == "ready", 5)
        assert time.monotonic() - said < 0.2, "ready only at the watch's next half-second turn"
    finally:
        await servers.close()


def test_a_progress_bar_drawn_by_moving_to_the_lines_start_keeps_its_last_drawing():
    """A bar that redraws with ESC[2K ESC[1G (Node's readline.cursorTo(0)), no \\r: its
    last drawing, never a 1,000-character line of every drawing with its end lost."""
    s = runproc.LineSplitter()
    out = []
    for i in range(4000):
        out += s.feed(f"\x1b[2K\x1b[1G[{'#' * (i // 100)}] {i // 40}%".encode())
    out += s.feed(b"\x1b[2K\x1b[1Gdone\n")
    out += s.feed(b"next line\n")
    assert out == ["done", "next line"]
    # The escape split across two reads of the output: still a move to the line's start.
    s = runproc.LineSplitter()
    assert s.feed(b"50%\x1b[") == [] and s.feed(b"G100%\n") == ["100%"]
    assert s.feed(b"\x1b[0Gall \x1b[1mgood\x1b[0m\n") == ["all good"]


def test_a_cut_line_ends_between_words_so_a_key_is_never_cut_in_two():
    """A long line is cut at LINE_MAX: back to the space before a key the cut falls in, so
    masking (which knows a key by its prefix) never meets its start alone."""
    key = "sk-ant-api03-" + "Q7wZ" * 10
    for at in range(runproc.LINE_MAX - 45, runproc.LINE_MAX - 5, 7):
        line = "x" * (at - 1) + " " + key + " tail"
        cut = runproc.LineSplitter().feed(line.encode() + b"\n")[0]
        assert cut.endswith("…") and len(cut) <= runproc.LINE_MAX
        assert "sk-ant" not in cut and "api03" not in cut, at
    # No space near the cut (minified code): cut where it falls, as before.
    assert runproc.LineSplitter().feed(b"y" * 5000 + b"\n") == ["y" * (runproc.LINE_MAX - 1) + "…"]


async def test_a_daemon_forked_twice_stops_with_its_server(tmp_path):
    """A server that daemonizes (fork, setsid, fork again: the daemon's parent is launchd at
    once, in neither the group nor the session): Stop finds it by its mark and stops it."""
    pidfile = tmp_path / "daemon.pid"
    port = free_port()
    script = server_script(
        tmp_path,
        "import os, socket, sys, time\n"
        "if os.fork() == 0:\n"
        "    os.setsid()\n"
        "    if os.fork() == 0:\n"
        "        devnull = os.open(os.devnull, os.O_RDWR)\n"
        "        for fd in (0, 1, 2): os.dup2(devnull, fd)\n"
        "        open(sys.argv[1], 'w').write(str(os.getpid()))\n"
        "        time.sleep(120)\n"
        "        os._exit(0)\n"
        "    os._exit(0)\n"
        f"s = socket.socket(); s.bind(('127.0.0.1', {port})); s.listen(5)\n"
        f"print('listening on http://127.0.0.1:{port}/', flush=True)\n"
        "time.sleep(120)\n",
    )
    launch(
        tmp_path,
        [
            {
                "name": "d",
                "runtimeExecutable": sys.executable,
                "runtimeArgs": [str(script), str(pidfile)],
                "port": port,
            }
        ],
    )
    servers = DevServers(lambda *a, **k: None, env=plain_env)
    server = await servers.start(tmp_path, "d")
    daemon = 0
    try:
        assert await until(lambda: server.status == "ready", 30)
        assert await until(lambda: pidfile.exists() and pidfile.read_text().strip(), 10)
        daemon = int(pidfile.read_text())
        assert os.getsid(daemon) != os.getsid(server.proc.pid)
        assert await servers.stop(server.key)
        assert await until(lambda: not pid_alive(daemon), 10), "the daemon outlived Stop"
    finally:
        if daemon:
            with contextlib.suppress(OSError):
                os.kill(daemon, signal.SIGKILL)
        await servers.close()
