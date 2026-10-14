"""Eden Code's dev servers (devservers.py) against malformed and hostile launch files, the
saving of a config into a launch file that has other things in it, which addresses count
as on this Mac, and the server list's bookkeeping with a stand-in process (nothing real
is started here)."""

import asyncio
import json
import os
import time
from pathlib import Path

import pytest

from jarvis import devservers, runproc
from jarvis.devservers import (
    DevServer,
    DevServers,
    LaunchConfig,
    is_local_url,
    read_launch,
    save_config,
    suggest,
)


def launch(project, configs, where=".claude/launch.json", **extra):
    path = project / where
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"version": "0.0.1", "configurations": configs, **extra}))
    return path


def one(project, entry):
    """The configs and problems of a launch file holding just this entry."""
    launch(project, [entry])
    return read_launch(project)


# ── which addresses are on this Mac ──


def test_localhost_loopback_and_dot_localhost_addresses_are_local():
    """Every spelling of this Mac's own address is local, whatever its case or port."""
    for url in (
        "http://localhost",
        "HTTP://LOCALHOST:3000/path?q=1",
        "https://localhost:8443/",
        "http://127.0.0.1:8000",
        "http://127.0.0.2/",  # all of 127/8 is loopback
        "http://[::1]/",
        "http://app.localhost:5173/",
        "http://a.b.localhost/",
        "  http://localhost:5173/  ",
        "http://user:pw@localhost:3000/",  # the host is what's after the @
    ):
        assert is_local_url(url), url


def test_lookalikes_and_userinfo_tricks_are_not_local():
    """Hosts that only start or end like localhost, a localhost before the @, and other
    machines are never taken as this Mac."""
    for url in (
        "http://localhost.evil.com/",
        "http://localhost.evil.com:5173/",
        "http://evil-localhost/",
        "http://evillocalhost/",
        "http://localhost@evil.com/",
        "http://localhost:3000@evil.com/",
        "http://127.0.0.1.evil.com/",
        "http://0.0.0.0:8000/",
        "http://192.168.1.10:3000/",
        "http://[::2]/",
        "http://127.1/",  # short forms aren't read as addresses
        "http://2130706433/",
    ):
        assert not is_local_url(url), url


def test_addresses_that_arent_http_or_cant_be_read_are_not_local():
    """Other schemes, no host, a bad port and broken brackets are all not local."""
    for url in (
        "ftp://localhost/",
        "ws://localhost:3000/",
        "file://localhost/etc/passwd",
        "localhost:3000",
        "//localhost:3000/",
        "http://",
        "http://:8000/",
        "http://localhost:port/",
        "http://localhost:-1/",
        "http://[::1/",
    ):
        assert not is_local_url(url), url


# ── launch file entries ──


def test_entries_that_arent_objects_or_lack_a_usable_name_are_left_out(tmp_path):
    """Lists, strings, numbers and nulls in the configurations, and names that are missing,
    not text, blank, too long or with control characters are each said and skipped."""
    launch(
        tmp_path,
        [
            ["name", "x"],
            "a string",
            7,
            None,
            {"name": 5, "runtimeExecutable": "x"},
            {"name": "   ", "runtimeExecutable": "x"},
            {"name": "n" * 65, "runtimeExecutable": "x"},
            {"name": "bell\x07", "runtimeExecutable": "x"},
            {"name": "  padded  ", "runtimeExecutable": "  npm  "},
        ],
    )
    configs, problems = read_launch(tmp_path)
    assert [(c.name, c.command) for c in configs] == [("padded", "npm")]
    assert problems.count(".claude/launch.json: an entry that isn't an object.") == 4
    assert problems.count(".claude/launch.json: an entry without a usable name.") == 4


def test_a_runtime_executable_that_is_missing_huge_or_has_a_line_break_is_refused(tmp_path):
    """The command must be text, not blank, at most 500 characters and on one line."""
    bad = {
        "none": None,
        "number": 3,
        "blank": "  ",
        "huge": "x" * 501,
        "newline": "npm\nrm -rf ~",
        "return": "npm\rx",
        "nul": "npm\0x",
    }
    launch(tmp_path, [{"name": n, "runtimeExecutable": c} for n, c in bad.items()])
    configs, problems = read_launch(tmp_path)
    assert configs == []
    text = " ".join(problems)
    for name in ("none", "number", "blank", "huge"):
        assert f"{name}: no runtimeExecutable" in text
    for name in ("newline", "return", "nul"):
        assert f"{name}: runtimeExecutable has a line break in it" in text


def test_runtime_args_of_the_wrong_kind_are_refused_and_numbers_become_words(tmp_path):
    """Arguments must be a list of at most 60 words (numbers taken as text); booleans,
    objects, nulls, NULs and arguments past 2000 characters refuse the entry."""
    launch(
        tmp_path,
        [
            {"name": "null args", "runtimeExecutable": "x", "runtimeArgs": None},
            {"name": "numbers", "runtimeExecutable": "x", "runtimeArgs": ["--port", 3000, 1.5]},
            {"name": "dict", "runtimeExecutable": "x", "runtimeArgs": {"a": 1}},
            {"name": "too many", "runtimeExecutable": "x", "runtimeArgs": ["a"] * 61},
            {"name": "bool", "runtimeExecutable": "x", "runtimeArgs": [True]},
            {"name": "nested", "runtimeExecutable": "x", "runtimeArgs": [["a"]]},
            {"name": "null item", "runtimeExecutable": "x", "runtimeArgs": [None]},
            {"name": "long", "runtimeExecutable": "x", "runtimeArgs": ["y" * 2001]},
            {"name": "nul", "runtimeExecutable": "x", "runtimeArgs": ["a\0b"]},
        ],
    )
    configs, problems = read_launch(tmp_path)
    found = {c.name: c for c in configs}
    assert set(found) == {"null args", "numbers"}
    assert found["null args"].args == ()
    assert found["numbers"].argv == ["x", "--port", "3000", "1.5"]
    text = " ".join(problems)
    for name in ("dict", "too many", "bool", "nested", "null item"):
        assert f"{name}: runtimeArgs must be a list of words" in text
    for name in ("long", "nul"):
        assert f"{name}: an argument is too long" in text


def test_ports_that_arent_port_numbers_are_ignored_with_a_note(tmp_path):
    """A port as digits in text is taken; true, zero, negative, past 65535, fractions and
    words are dropped with a note, and the entry is still used."""
    good = {"text": " 8080 ", "number": 3000, "top": 65535}
    bad = {"bool": True, "zero": 0, "neg": -1, "big": 70000, "float": 80.5, "word": "http"}
    entries = [{"name": n, "runtimeExecutable": "x", "port": p} for n, p in {**good, **bad}.items()]
    launch(tmp_path, entries)
    configs, problems = read_launch(tmp_path)
    ports = {c.name: c.port for c in configs}
    assert ports == {"text": 8080, "number": 3000, "top": 65535, **dict.fromkeys(bad)}
    for name in bad:
        assert f".claude/launch.json: {name}: port ignored (not a port number)." in problems
    assert not any(name + ":" in p for p in problems for name in good)


def test_a_url_that_isnt_text_or_isnt_on_this_mac_is_ignored_with_a_note(tmp_path):
    """A url that is a number, a list, or another machine's address is dropped (the entry
    stays, without it); a local one is kept, trimmed."""
    launch(
        tmp_path,
        [
            {"name": "number", "runtimeExecutable": "x", "url": 5},
            {"name": "list", "runtimeExecutable": "x", "url": ["http://localhost"]},
            {"name": "lookalike", "runtimeExecutable": "x", "url": "http://localhost.evil.com/"},
            {"name": "userinfo", "runtimeExecutable": "x", "url": "http://localhost@evil.com/"},
            {"name": "script", "runtimeExecutable": "x", "url": "javascript:alert(1)"},
            {"name": "ok", "runtimeExecutable": "x", "url": " http://app.localhost:3000/ "},
            {"name": "empty", "runtimeExecutable": "x", "url": ""},
        ],
    )
    configs, problems = read_launch(tmp_path)
    urls = {c.name: c.url for c in configs}
    assert urls["ok"] == "http://app.localhost:3000/"
    assert all(urls[n] == "" for n in ("number", "list", "lookalike", "userinfo", "script"))
    ignored = [p for p in problems if "url ignored" in p]
    assert len(ignored) == 5 and not any("ok:" in p or "empty:" in p for p in problems)
    assert {c.name: c.address() for c in configs}["ok"] == "http://app.localhost:3000/"


def test_a_cwd_must_be_a_real_folder_inside_the_project(tmp_path):
    """The working folder is relative to the project, normalised, and refused when it isn't
    text, is a file, doesn't exist, or leads out of the project (by .., an absolute path or
    a link)."""
    project = tmp_path / "project"
    (project / "web").mkdir(parents=True)
    (project / "README").write_text("")
    outside = tmp_path / "outside"
    outside.mkdir()
    (project / "out-link").symlink_to(outside)
    launch(
        project,
        [
            {"name": "web", "runtimeExecutable": "x", "cwd": "web/../web/."},
            {"name": "root", "runtimeExecutable": "x", "cwd": "."},
            {"name": "number", "runtimeExecutable": "x", "cwd": 3},
            {"name": "file", "runtimeExecutable": "x", "cwd": "README"},
            {"name": "missing", "runtimeExecutable": "x", "cwd": "nope"},
            {"name": "up", "runtimeExecutable": "x", "cwd": "../outside"},
            {"name": "absolute", "runtimeExecutable": "x", "cwd": str(outside)},
            {"name": "link", "runtimeExecutable": "x", "cwd": "out-link"},
        ],
    )
    configs, problems = read_launch(project)
    assert {c.name: c.cwd for c in configs} == {"web": "web", "root": ""}
    for name in ("number", "file", "missing", "up", "absolute", "link"):
        assert f".claude/launch.json: {name}: cwd must be a folder in the project." in problems


def test_env_must_be_an_object_and_odd_keys_and_values_are_dropped(tmp_path):
    """An env that isn't an object refuses the entry; keys that aren't names, values that
    are booleans, lists, nulls, NULs or huge are each left out, and at most 50 are read."""
    many = {f"K{n}": str(n) for n in range(60)}
    launch(
        tmp_path,
        [
            {"name": "list env", "runtimeExecutable": "x", "env": ["A=1"]},
            {"name": "text env", "runtimeExecutable": "x", "env": "A=1"},
            {
                "name": "mixed",
                "runtimeExecutable": "x",
                "env": {
                    "GOOD": "1",
                    "NUM": 2.5,
                    "1BAD": "x",
                    "HAS SPACE": "x",
                    "": "x",
                    "BOOL": False,
                    "LIST": ["a"],
                    "NULL": None,
                    "NUL": "a\0b",
                    "HUGE": "v" * 4001,
                    "EDGE": "v" * 4000,
                },
            },
            {"name": "many", "runtimeExecutable": "x", "env": many},
        ],
    )
    configs, problems = read_launch(tmp_path)
    found = {c.name: c for c in configs}
    assert set(found) == {"mixed", "many"}
    assert dict(found["mixed"].env) == {"GOOD": "1", "NUM": "2.5", "EDGE": "v" * 4000}
    assert len(found["many"].env) == 50
    assert ".claude/launch.json: list env: env must be an object." in problems
    assert ".claude/launch.json: text env: env must be an object." in problems


# ── launch files ──


def test_a_launch_file_that_cant_be_read_is_said_and_the_other_still_used(tmp_path):
    """A .claude/launch.json without read permission is reported; .jarvis/launch.json's
    configs still come through."""
    path = launch(tmp_path, [{"name": "a", "runtimeExecutable": "x"}])
    launch(tmp_path, [{"name": "b", "runtimeExecutable": "x"}], ".jarvis/launch.json")
    os.chmod(path, 0)
    try:
        if os.access(path, os.R_OK):
            pytest.skip("running with permission to read any file")
        configs, problems = read_launch(tmp_path)
    finally:
        os.chmod(path, 0o600)
    assert [c.name for c in configs] == ["b"]
    assert len(problems) == 1 and problems[0].startswith(".claude/launch.json can't be read (")


def test_a_launch_file_too_big_to_be_one_is_not_read(tmp_path):
    """A launch file past the size limit is said and skipped, whatever it holds."""
    path = launch(tmp_path, [{"name": "a", "runtimeExecutable": "x"}])
    path.write_text(path.read_text() + " " * devservers.MAX_FILE)
    configs, problems = read_launch(tmp_path)
    assert configs == [] and problems == [".claude/launch.json is too big to be a launch file."]


def test_a_launch_file_whose_configurations_arent_a_list_is_said(tmp_path):
    """An object without configurations, or with them as an object or text, is reported."""
    for data in ({}, {"configurations": {"a": {}}}, {"configurations": "x"}, "text", 3, None):
        path = tmp_path / ".claude" / "launch.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(data))
        assert read_launch(tmp_path) == ([], [".claude/launch.json has no configurations list."])


def test_bytes_that_arent_utf8_dont_stop_a_launch_file_being_read(tmp_path):
    """Invalid UTF-8 inside a string is replaced, and the rest of the file still reads."""
    path = tmp_path / ".claude" / "launch.json"
    path.parent.mkdir()
    path.write_bytes(
        b'{"configurations": [{"name": "caf\xe9", "runtimeExecutable": "x"},'
        b' {"name": "ok", "runtimeExecutable": "y"}]}'
    )
    configs, problems = read_launch(tmp_path)
    assert [c.name for c in configs] == ["caf�", "ok"] and problems == []


def test_only_so_many_configs_are_read_and_a_repeated_name_keeps_the_first(tmp_path):
    """Entries past the per-file limit are not read; a name used twice in one file keeps
    its first entry."""
    entries = [{"name": "dup", "runtimeExecutable": "first"}]
    entries.append({"name": "dup", "runtimeExecutable": "second"})
    entries += [{"name": f"c{n}", "runtimeExecutable": "x"} for n in range(40)]
    launch(tmp_path, entries)
    configs, _ = read_launch(tmp_path)
    assert len(configs) == devservers.MAX_CONFIGS - 1  # 30 read, one of them a repeat
    assert configs[0].command == "first"
    assert configs[-1].name == f"c{devservers.MAX_CONFIGS - 3}"


def test_a_project_with_no_launch_files_has_no_configs_and_no_problems(tmp_path):
    """Nothing there: nothing said. A folder where a launch file belongs is passed over."""
    assert read_launch(tmp_path) == ([], [])
    (tmp_path / ".claude" / "launch.json").mkdir(parents=True)
    assert read_launch(tmp_path) == ([], [])


# ── saving a config ──


def test_saving_keeps_everything_else_in_the_launch_file(tmp_path):
    """A saved config is appended; the file's version, its other keys, its other entries
    (even ones Eden can't use) stay exactly as they were."""
    path = launch(
        tmp_path,
        [{"name": "theirs", "runtimeExecutable": "make", "extra": [1, 2]}, "junk"],
        where=".claude/launch.json",
        custom={"keep": True},
    )
    data = json.loads(path.read_text())
    data["version"] = "0.0.9"
    path.write_text(json.dumps(data))
    config = LaunchConfig(
        "mine",
        "npm",
        ("run", "dev"),
        5173,
        url="http://localhost:5173/",
        cwd="web",
        env=(("A", "1"),),
    )
    assert save_config(tmp_path, config) == path
    saved = json.loads(path.read_text())
    assert saved["version"] == "0.0.9" and saved["custom"] == {"keep": True}
    assert saved["configurations"][:2] == data["configurations"]
    assert saved["configurations"][2] == {
        "name": "mine",
        "runtimeExecutable": "npm",
        "runtimeArgs": ["run", "dev"],
        "port": 5173,
        "url": "http://localhost:5173/",
        "cwd": "web",
        "env": {"A": "1"},
    }
    assert [p.name for p in path.parent.iterdir()] == ["launch.json"]  # no temp file left


def test_saving_into_a_launch_file_without_a_version_gives_it_one(tmp_path):
    """A launch file with only a configurations list gets the version Claude Code writes."""
    path = tmp_path / ".claude" / "launch.json"
    path.parent.mkdir()
    path.write_text(json.dumps({"configurations": []}))
    save_config(tmp_path, LaunchConfig("a", "x"))
    data = json.loads(path.read_text())
    assert data["version"] == "0.0.1"
    assert data["configurations"] == [{"name": "a", "runtimeExecutable": "x", "runtimeArgs": []}]


def test_a_file_that_isnt_a_launch_file_is_never_written_over(tmp_path):
    """A list, text, or an object without a configurations list in .claude/launch.json
    refuses the save and stays as it was."""
    path = tmp_path / ".claude" / "launch.json"
    path.parent.mkdir()
    for text in ("[]", '"x"', '{"version": "0.0.1"}', '{"configurations": {}}'):
        path.write_text(text)
        with pytest.raises(ValueError, match="isn't a launch file, so it wasn't changed"):
            save_config(tmp_path, LaunchConfig("a", "x"))
        assert path.read_text() == text


def test_a_full_launch_file_takes_no_more_configs(tmp_path):
    """A launch file already at the per-file limit refuses another config."""
    entries = [{"name": f"c{n}", "runtimeExecutable": "x"} for n in range(devservers.MAX_CONFIGS)]
    path = launch(tmp_path, entries)
    before = path.read_text()
    with pytest.raises(ValueError, match=f"already has {devservers.MAX_CONFIGS} configs"):
        save_config(tmp_path, LaunchConfig("one more", "x"))
    assert path.read_text() == before


def test_a_config_round_trips_through_the_launch_file(tmp_path):
    """What's saved reads back as the same config, from .claude/launch.json."""
    (tmp_path / "web").mkdir()
    config = LaunchConfig(
        "web", "npm", ("run", "dev"), 3000, "http://localhost:3000/", "web", (("X", "y"),)
    )
    save_config(tmp_path, config)
    [back], problems = read_launch(tmp_path)
    assert problems == []
    assert back == LaunchConfig(**{**config.__dict__, "source": ".claude/launch.json"})
    assert back.public() == {
        "name": "web",
        "command": "npm run dev",
        "port": 3000,
        "url": "http://localhost:3000/",
        "cwd": "web",
        "source": ".claude/launch.json",
        "why": "",
    }


# ── suggestions and printed addresses ──


def test_yarn_and_bun_projects_are_suggested_with_their_own_runner(tmp_path):
    """A yarn lock runs the script by name with yarn; a bun lock (either kind) with bun run."""
    for lock, argv in (
        ("yarn.lock", ["yarn", "dev"]),
        ("bun.lockb", ["bun", "run", "dev"]),
        ("bun.lock", ["bun", "run", "dev"]),
    ):
        project = tmp_path / lock
        project.mkdir()
        (project / "package.json").write_text(json.dumps({"scripts": {"dev": "vite"}}))
        (project / lock).write_text("")
        [found] = suggest(project)
        assert found.argv == argv and found.port == 5173, lock


def test_package_json_without_a_server_script_or_too_big_suggests_nothing(tmp_path):
    """Scripts with no dev/start/serve/develop, scripts that aren't an object, and a
    package.json past the size limit suggest no server."""
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test": "vitest"}}))
    assert suggest(tmp_path) == []
    (tmp_path / "package.json").write_text(json.dumps({"scripts": ["dev"]}))
    assert suggest(tmp_path) == []
    big = {"scripts": {"dev": "vite"}, "pad": "x" * devservers.MAX_FILE}
    (tmp_path / "package.json").write_text(json.dumps(big))
    assert suggest(tmp_path) == []


def test_flask_and_rails_apps_are_suggested(tmp_path):
    """A Flask app with flask in its requirements, and a Rails app with its bin/rails."""
    (tmp_path / "requirements.txt").write_text("Flask==3.0\n")
    (tmp_path / "app.py").write_text("from flask import Flask\napp = Flask(__name__)\n")
    (tmp_path / "Gemfile").write_text("gem 'rails', '~> 7.1'\n")
    (tmp_path / "bin").mkdir()
    (tmp_path / "bin" / "rails").write_text("")
    found = {c.name: c for c in suggest(tmp_path)}
    assert found["flask"].argv == [
        "python3", "-m", "flask", "--app", "app", "run", "--debug", "--port", "5000"
    ]  # fmt: skip
    assert found["rails"].argv == ["bin/rails", "server", "-b", "127.0.0.1"]
    assert found["rails"].port == 3000


def test_a_uv_flask_app_runs_flask_through_uv(tmp_path):
    """With a uv.lock the Flask suggestion runs uv run flask."""
    (tmp_path / "uv.lock").write_text("")
    (tmp_path / "pyproject.toml").write_text('dependencies = ["flask"]')
    (tmp_path / "server.py").write_text("app = Flask(__name__)\n")
    [flask] = suggest(tmp_path)
    assert flask.argv[:4] == ["uv", "run", "flask", "--app"] and "server" in flask.argv


def test_a_printed_address_with_a_port_past_the_last_is_kept_without_a_port():
    """A server line with an address whose port can't be one gives the address and no port."""
    assert devservers.output_address("Local: http://localhost:99999/") == (
        "http://localhost:99999/",
        None,
    )


# ── the server list, with a stand-in process ──


class FakeProc:
    """Stands in for runproc.Proc: nothing runs; the test ends it, or stop() does."""

    made: list["FakeProc"] = []
    fail_start: OSError | None = None

    def __init__(self, argv, cwd, env, on_lines, on_exit=None):
        self.argv, self.cwd, self.env = argv, cwd, env
        self.on_lines, self.on_exit = on_lines, on_exit
        self.finished = False
        self.stopping = False
        self.pid = None
        self.stops: list[float | None] = []
        FakeProc.made.append(self)

    async def start(self):
        if FakeProc.fail_start is not None:
            raise FakeProc.fail_start

    def end(self, code):
        self.on_exit(code)
        self.finished = True

    async def stop(self, grace=None):
        self.stops.append(grace)
        self.stopping = True
        self.end(-15)


@pytest.fixture
def fake_runs(monkeypatch):
    """Dev servers that start a FakeProc for any command, and a record of what they emit."""
    FakeProc.made, FakeProc.fail_start = [], None
    monkeypatch.setattr(runproc, "Proc", FakeProc)
    monkeypatch.setattr(runproc, "which", lambda command, env, cwd: f"/bin/{command}")
    emitted: list[tuple[str, dict]] = []
    servers = DevServers(lambda kind, **kw: emitted.append((kind, kw)), env=lambda: {"PATH": "/x"})
    yield servers, emitted
    FakeProc.fail_start = None


async def test_the_list_says_its_configs_suggestions_and_problems(tmp_path, fake_runs):
    """configs() gives the saved ones, suggestions it hasn't got and what was wrong."""
    servers, _ = fake_runs
    launch(tmp_path, [{"name": "dev", "runtimeExecutable": "npm"}, "junk"])
    (tmp_path / "index.html").write_text("")
    out = servers.configs(tmp_path)
    assert [c["name"] for c in out["configs"]] == ["dev"]
    assert [c["name"] for c in out["suggestions"]] == ["static"]
    assert out["problems"] == [".claude/launch.json: an entry that isn't an object."]


async def test_a_server_that_cant_start_says_why_and_isnt_running(tmp_path, fake_runs):
    """An OSError starting it marks it failed with the system's reason."""
    servers, emitted = fake_runs
    launch(tmp_path, [{"name": "dev", "runtimeExecutable": "npm"}])
    FakeProc.fail_start = PermissionError(13, "Permission denied")
    with pytest.raises(ValueError, match="It didn't start: Permission denied"):
        await servers.start(tmp_path, "dev")
    server = servers.servers[devservers.server_key(tmp_path, "dev")]
    assert server.status == "failed" and server.proc is None and not server.alive
    assert emitted[-1][1]["items"][0]["status"] == "failed"
    assert emitted[-1][1]["items"][0]["url"] == ""


async def test_no_more_than_so_many_servers_run_at_once(tmp_path, fake_runs, monkeypatch):
    """Past the limit of running servers a start is refused until one stops."""
    servers, _ = fake_runs
    monkeypatch.setattr(devservers, "MAX_SERVERS", 1)
    monkeypatch.setattr(devservers, "READY_WAIT", 0.0)
    launch(tmp_path, [{"name": n, "runtimeExecutable": "x"} for n in ("a", "b")])
    a = await servers.start(tmp_path, "a")
    with pytest.raises(ValueError, match="1 dev servers are running already"):
        await servers.start(tmp_path, "b")
    assert await servers.stop(a.key)
    assert (await servers.start(tmp_path, "b")).alive


async def test_stopping_restarting_and_forgetting_servers(tmp_path, fake_runs, monkeypatch):
    """Stopping one that isn't there or isn't running says no; a restart starts it again
    for the same session; one that has stopped can be taken off the list, a running one
    can't."""
    servers, _ = fake_runs
    monkeypatch.setattr(devservers, "READY_WAIT", 0.0)
    launch(tmp_path, [{"name": "dev", "runtimeExecutable": "npm"}])
    assert not await servers.stop("nope")
    with pytest.raises(ValueError, match="isn't known"):
        await servers.restart("nope")
    first = await servers.start(tmp_path, "dev", started_by=7)
    again = await servers.restart(first.key)
    assert again is not first and again.alive and again.started_by == 7
    assert servers.running(tmp_path) == [again] and servers.running(tmp_path / "other") == []
    assert [s["name"] for s in servers.public(tmp_path)] == ["dev"]
    assert first.status == "stopped" and len(FakeProc.made[0].stops) == 1
    assert not servers.forget(again.key) and not servers.forget("nope")
    await servers.stop(again.key, "done")
    assert again.status == "stopped" and again.message == "done"
    assert not await servers.stop(again.key)
    assert servers.forget(again.key) and servers.public() == []
    assert servers.logs(again.key) == []


async def test_a_server_that_never_says_its_address_is_called_running(
    tmp_path, fake_runs, monkeypatch
):
    """Past the wait for its address, a server still going is running, saying it hasn't
    said where."""
    servers, _ = fake_runs
    monkeypatch.setattr(devservers, "READY_WAIT", 0.0)
    launch(tmp_path, [{"name": "dev", "runtimeExecutable": "npm"}])
    server = await servers.start(tmp_path, "dev")
    for _ in range(100):
        if server.status == "running":
            break
        await asyncio.sleep(0.01)
    assert server.status == "running"
    assert server.message == "Running; it hasn't said its address."
    assert servers.logs(server.key) == [(1, "$ npm")]


async def test_a_watched_servers_output_goes_to_the_windows_in_batches(
    tmp_path, fake_runs, monkeypatch
):
    """While a logs view watches it, new lines are sent together a moment later, and the
    first local address and port it prints become its address."""
    servers, emitted = fake_runs
    monkeypatch.setattr(devservers, "READY_WAIT", 0.0)
    monkeypatch.setattr(devservers, "LOG_EVERY", 0.01)
    launch(tmp_path, [{"name": "dev", "runtimeExecutable": "npm"}])
    server = await servers.start(tmp_path, "dev")
    proc = FakeProc.made[-1]
    proc.on_lines(["not watched yet"])
    servers.watch(server.key)
    servers.watch("")  # no key: nothing watched
    proc.on_lines(["Remote: http://example.com:9000/", "Local: http://localhost:5173/"])
    proc.on_lines(["Network: http://127.0.0.1:4000/"])  # address known: not taken
    for _ in range(200):
        if any(kind == "devserver_log" for kind, _ in emitted):
            break
        await asyncio.sleep(0.01)
    [logs] = [kw for kind, kw in emitted if kind == "devserver_log"]
    assert logs["key"] == server.key
    assert [t for _, t in logs["lines"]] == [
        "Remote: http://example.com:9000/",
        "Local: http://localhost:5173/",
        "Network: http://127.0.0.1:4000/",
    ]
    assert server.printed_url == "http://localhost:5173/" and server.printed_port == 5173
    assert server.address() == "http://localhost:5173/"
    assert [t for _, t in servers.logs(server.key, since=1)][0] == "not watched yet"


async def test_a_watch_runs_out_and_only_so_many_are_kept(tmp_path, fake_runs):
    """A watch that has run out is dropped the next time one is asked for, and at most 50
    servers are watched at once."""
    servers, _ = fake_runs
    servers.watch("old", seconds=-1)
    servers.watch("new")
    assert "old" not in servers._watched and "new" in servers._watched
    for n in range(60):
        servers.watch(f"k{n}")
    assert len(servers._watched) == 50


async def test_closing_stops_every_running_server_and_says_nothing_more(
    tmp_path, fake_runs, monkeypatch
):
    """At close each running server is stopped with a short grace, and their ends are not
    announced to windows that are going away."""
    servers, emitted = fake_runs
    monkeypatch.setattr(devservers, "READY_WAIT", 0.0)
    launch(tmp_path, [{"name": n, "runtimeExecutable": "x"} for n in ("a", "b")])
    await servers.start(tmp_path, "a")
    await servers.start(tmp_path, "b")
    for _ in range(100):  # their address watches are over: they say "running"
        if all(s.status == "running" for s in servers.servers.values()):
            break
        await asyncio.sleep(0.01)
    count = len(emitted)
    await servers.close()
    assert [p.stops for p in FakeProc.made] == [[3.0], [3.0]]
    assert all(s.status == "stopped" for s in servers.servers.values())
    assert len(emitted) == count


async def test_settled_waits_for_a_quiet_moment_but_not_forever():
    """settled() returns once the output has been quiet a while, or after `most` seconds
    of output that never stops."""
    server = DevServer(project=Path("/p"), config=LaunchConfig("a", "x"))
    server.last_output = time.monotonic()
    start = time.monotonic()
    await DevServers(lambda *a, **k: None).settled(server, quiet=0.02, most=1.0)
    assert time.monotonic() - start < 0.5
    server.last_output = time.monotonic() + 60  # "still printing"
    start = time.monotonic()
    await DevServers(lambda *a, **k: None).settled(server, quiet=0.01, most=0.1)
    assert 0.09 <= time.monotonic() - start < 0.6


async def test_closing_while_a_server_is_still_starting_ends_its_address_watch(tmp_path, fake_runs):
    """A server still being watched for its address when the app closes is stopped and
    its watch doesn't linger."""
    servers, _ = fake_runs
    launch(tmp_path, [{"name": "dev", "runtimeExecutable": "npm"}])
    server = await servers.start(tmp_path, "dev")
    await asyncio.sleep(0)
    assert server.status == "starting" and servers._watchers
    await servers.close()
    for _ in range(100):
        if not servers._watchers:
            break
        await asyncio.sleep(0.01)
    assert not servers._watchers and server.status == "stopped"
