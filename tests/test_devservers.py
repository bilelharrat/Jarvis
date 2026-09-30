"""Dev servers for Jarvis Code projects: launch configs read defensively, suggestions that
never run by themselves, and servers in their own process groups that stop whole, stop with
the session that started them, and never outlive the app."""

import asyncio
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


async def until(condition, seconds=10.0):
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
    assert len(out) == 1 and len(out[0]) == runproc.LINE_MAX


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
    assert await until(lambda: not pid_alive(child), 5), (
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
        assert await until(lambda: not pid_alive(server), 8), "the server outlived the app"
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
        assert await until(lambda: server.status == "ready", 12)
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
    assert await until(lambda: not theirs.alive, 5)
