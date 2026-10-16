"""Eden Code on Windows (item 49), checked on a Mac by making it look like a PC (osplat.IS_WIN
patched, as the other win-* tests do): what codeparity says, the sandbox that isn't there
(each command asks; a run that must be sandboxed doesn't start), secrets that can't reach a
command (said before any card), Git Bash for the shell, editors found where Windows installs
them, links in isolated copies, test runners' Windows shims, the eden-code.cmd command, the
look-at-this key's front window, the Mac-only tools left out, and the "On this PC" list.
What only a real PC can show (Windows Hello's sheet, ConPTY, Credential Manager) is the
owner's check: docs/eden-code-windows-parity.md."""

import asyncio
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from claude_agent_sdk import PermissionResultDeny, ToolPermissionContext
from code_session_fakes import Stream, end_all, events_of, make_hub, until
from conftest import FakeClient

from jarvis import (
    code_editor,
    code_tools,
    codelook,
    codeparity,
    codetests,
    osplat,
    tasks,
    worktrees,
)
from jarvis.features import code_api, code_interpreter, code_secrets, code_unattended
from jarvis.hub import Hub
from jarvis.tasks import ClaudeTask

CTX = ToolPermissionContext()


@pytest.fixture
def windows(monkeypatch):
    monkeypatch.setattr(osplat, "IS_WIN", True)
    monkeypatch.setattr(osplat, "IS_MAC", False)


# ── what codeparity says ──


def test_on_a_mac_everything_is_there_and_nothing_is_listed():
    assert codeparity.sandbox_available() and codeparity.secret_runs_available()
    assert codeparity.report() == {"os": "mac", "features": []}
    assert codeparity.secret_store() == "Keychain"


def test_on_a_pc_the_sandbox_and_secret_runs_are_not_and_the_list_says_why(windows):
    assert not codeparity.sandbox_available() and not codeparity.secret_runs_available()
    assert codeparity.secret_store() == "Credential Manager"
    got = codeparity.report()
    assert got["os"] == "windows"
    by_id = {f["id"]: f for f in got["features"]}
    assert {"touchid", "sandbox", "secrets", "interpreter", "simulator"} <= set(by_id)
    assert by_id["touchid"]["state"] == "another" and "Windows Hello" in by_id["touchid"]["why"]
    assert by_id["sandbox"]["state"] == "mac" and by_id["sandbox"]["why"] == codeparity.NO_SANDBOX
    assert all(f["state"] in ("another", "mac") and f["why"] for f in got["features"])
    got["features"][0]["why"] = "changed"  # (a copy: the table itself stays)
    assert codeparity.REPORT[0]["why"] != "changed"


def test_git_bash_is_git_for_windows_never_wsl(tmp_path, monkeypatch):
    git = tmp_path / "Git"
    (git / "cmd").mkdir(parents=True)
    (git / "bin").mkdir()
    (git / "cmd" / "git.exe").write_text("")
    (git / "bin" / "bash.exe").write_text("")
    wsl = tmp_path / "Windows" / "System32"
    wsl.mkdir(parents=True)
    (wsl / "bash.exe").write_text("")
    monkeypatch.setattr(codeparity.shutil, "which", lambda name: str(git / "cmd" / "git.exe"))
    # WSL's bash named outright is passed over; Git's beside git.exe is found.
    env = {"CLAUDE_CODE_GIT_BASH_PATH": str(wsl / "bash.exe")}
    assert codeparity.git_bash(env) == str(git / "bin" / "bash.exe")
    own = tmp_path / "PortableGit" / "bin" / "bash.exe"
    own.parent.mkdir(parents=True)
    own.write_text("")
    assert codeparity.git_bash({"CLAUDE_CODE_GIT_BASH_PATH": str(own)}) == str(own)
    # No git on the PATH: where the installer puts it, else none.
    monkeypatch.setattr(codeparity.shutil, "which", lambda name: None)
    assert codeparity.git_bash({"ProgramFiles": str(tmp_path)}) == str(git / "bin" / "bash.exe")
    assert codeparity.git_bash({"ProgramFiles": str(tmp_path / "nowhere")}) is None


# ── the sandbox that isn't there ──


async def test_on_a_pc_a_sandboxed_session_s_commands_each_ask_and_nothing_pretends(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"code_sandbox_bypass": True})
    monkeypatch.setattr(osplat, "IS_WIN", True)
    seen = events_of(hub)
    task = hub.tasks.start("one", "proj", mode="auto")
    assert await until(lambda: task.status == "waiting")
    assert Stream.instances[0].options.sandbox is None  # (it'd run unsandboxed without a word)
    desk = hub.code_sandbox
    assert desk.check(task, "Bash", {"command": "ls"}) == ("ask", codeparity.NO_SANDBOX)
    assert desk.check(task, "Read", {}) is None
    desk.settle(task)  # nothing a reopen could add: no reopen, ever
    await asyncio.sleep(0.05)
    assert len(Stream.instances) == 1
    await hub._handle({"type": "cs_state", "id": task.id})
    state = [e for e in seen() if e["type"] == "cs_state"][-1]
    assert state["available"] is False and state["why"] == codeparity.NO_SANDBOX
    assert state["on"] and not state["live"]
    # The switch off: Bypass as it was, no asking.
    hub.set_feature_prefs({"code_sandbox_bypass": False})
    assert desk.check(task, "Bash", {"command": "ls"}) is None
    await end_all(hub)


async def test_on_a_pc_a_run_that_must_be_sandboxed_does_not_start(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated)
    monkeypatch.setattr(osplat, "IS_WIN", True)
    scope = code_unattended.Scope(prompt="fix issue 3", project="proj")
    before = dict(hub.tasks.tasks)
    said = hub.code_runs.start(scope, origin="github", untrusted=True, sandbox=True)
    assert said == codeparity.NO_SANDBOX_RUN
    assert hub.tasks.tasks == before  # no session at all
    options = SimpleNamespace(
        setting_sources=None, mcp_servers={"x": 1}, strict_mcp_config=False,
        allowed_tools=[], disallowed_tools=[], sandbox=None,
    )  # fmt: skip
    code_unattended.Runs.lock_down(options, sandbox=True)  # (an issue's run, resumed)
    assert options.sandbox is None and options.mcp_servers == {}  # locked down all the same
    await end_all(hub)


# ── secrets ──


@pytest.fixture
async def secrets_hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    folder = settings.projects_dir / "shop"
    folder.mkdir()
    task = ClaudeTask(id=6, prompt="x", cwd=folder.resolve())
    hub.tasks.tasks[6] = task
    yield hub, task


async def test_on_a_pc_no_secret_is_asked_for_and_a_command_naming_one_is_refused_first(
    secrets_hub, monkeypatch
):
    hub, task = secrets_hub
    tools = {t.name: t.handler for t in hub.code_secrets.tools(task)}
    # One given on the Mac (the card, answered), before the backend is a PC's.
    ask = asyncio.ensure_future(tools["ask_secret"]({"name": "stripe key", "why": "To test."}))
    assert await until(lambda: any(e["role"] == "secret" for e in task.transcript))
    card = [e for e in task.transcript if e["role"] == "secret"][-1]
    await hub._handle(
        {"type": "sec_answer", "ask": card["ask"], "value": "pass-4242-x", "scope": "session"}
    )
    await asyncio.wait_for(ask, 5)
    monkeypatch.setattr(osplat, "IS_WIN", True)
    said = await tools["ask_secret"]({"name": "github token", "why": "To push."})
    assert said["content"][0]["text"] == codeparity.NO_SECRET_RUNS
    assert len([e for e in task.transcript if e["role"] == "secret"]) == 1  # no new card
    cards = []

    async def approve(*_a, **_k):
        cards.append(1)
        return tasks.ALLOW

    hub.tasks.approve = approve
    task.mode = "auto"
    options = hub.tasks.options_for(task)
    command = 'curl -H "Authorization: Bearer $SECRET_STRIPE_KEY" https://api.example.com/'
    refused = await options.can_use_tool("Bash", {"command": command}, CTX)
    assert isinstance(refused, PermissionResultDeny)
    assert refused.message == codeparity.NO_SECRET_RUN
    assert cards == [] and not hub.code_secrets.asks  # no card was put up for it


def test_a_secret_command_s_shell_is_git_bash_on_a_pc(windows, monkeypatch):
    monkeypatch.setattr(codeparity, "git_bash", lambda: r"C:\Program Files\Git\bin\bash.exe")
    assert code_secrets.shell_argv("npm test") == [
        r"C:\Program Files\Git\bin\bash.exe", "--norc", "--noprofile", "-c", "npm test",
    ]  # fmt: skip
    monkeypatch.setattr(codeparity, "git_bash", lambda: None)
    assert code_secrets.shell_argv("x")[0] == "bash.exe"


# ── Open in an editor ──


def test_editors_are_found_where_windows_installs_them_and_open_with_their_own_program(
    tmp_path, monkeypatch, windows
):
    local = tmp_path / "Local"
    code = local / "Programs" / "Microsoft VS Code" / "Code.exe"
    code.parent.mkdir(parents=True)
    code.write_text("")
    cursor_cli = tmp_path / "cursor" / "resources" / "app" / "bin" / "cursor"
    cursor_cli.parent.mkdir(parents=True)
    cursor_cli.write_text("")
    (tmp_path / "cursor" / "resources" / "app" / "Cursor.exe").write_text("")
    monkeypatch.setattr(
        code_editor.shutil,
        "which",
        lambda name, path=None: str(cursor_cli) if name == "cursor" else None,
    )
    found = code_editor.find_windows_editors({"LOCALAPPDATA": str(local)})
    assert [e["id"] for e in found] == ["vscode", "cursor"]  # no Zed here; never Xcode
    vscode, cursor = found
    assert vscode["path"] == str(code)
    assert cursor["path"] == str(tmp_path / "cursor" / "resources" / "app" / "Cursor.exe")
    root = tmp_path / "proj"
    (root / "src").mkdir(parents=True)
    path = root / "src" / "app.py"
    path.write_text("x")
    assert code_editor.open_command(vscode, path, 12) == [str(code), "--goto", f"{path}:12"]
    assert code_editor.open_command(vscode, root) == [str(code), str(root)]
    zed = {"id": "zed", "name": "Zed", "bundle": "", "path": "Zed.exe"}
    assert code_editor.open_command(zed, path, 3) == ["Zed.exe", f"{path}:3"]
    # The Editors list looks on Windows' side.
    assert code_editor.Editors().find is code_editor.find_windows_editors


def test_on_a_pc_open_is_explorer_s_and_an_editor_starts_without_being_waited_for(monkeypatch):
    opened, started = [], []
    monkeypatch.setattr(osplat, "mac_open", lambda args: opened.append(args))
    monkeypatch.setattr(subprocess, "DETACHED_PROCESS", 0x8, raising=False)
    monkeypatch.setattr(subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)
    monkeypatch.setattr(
        subprocess, "Popen", lambda argv, **kw: started.append((argv, kw["creationflags"]))
    )
    code_editor.launch(["open", "-R", r"C:\proj\app.py"])
    assert opened == [["-R", r"C:\proj\app.py"]]
    code_editor.launch([r"C:\Code.exe", "--goto", r"C:\proj\app.py:3"])
    assert started == [([r"C:\Code.exe", "--goto", r"C:\proj\app.py:3"], 0x8 | 0x08000000)]
    with pytest.raises(ValueError):
        code_editor.launch([])


# ── isolated copies ──


def test_without_developer_mode_a_copy_s_links_are_said_not_made(tmp_path, monkeypatch, windows):
    main = tmp_path / "main"
    (main / "node_modules").mkdir(parents=True)
    copy_dir = tmp_path / "copy"
    copy_dir.mkdir()

    def refuse(link, target):
        raise OSError(1314, "A required privilege is not held by the client")

    monkeypatch.setattr(codeparity, "link_folder", refuse)
    repo = SimpleNamespace(top=main, prefix="")
    copy = SimpleNamespace(cwd=copy_dir, checkout=str(copy_dir), prefix="", folder=tmp_path)
    notes = worktrees.link_dependencies(repo, copy)
    assert notes == [codeparity.NO_LINKS.format(name="node_modules")]
    assert not (copy_dir / "node_modules").exists()


def test_a_link_is_a_folder_symlink_never_a_junction(tmp_path):
    target = tmp_path / "t"
    target.mkdir()
    link = tmp_path / "l"
    codeparity.link_folder(link, target)
    assert link.is_symlink() and link.resolve() == target.resolve()


# ── tests, the eden-code command ──


def test_test_runners_use_windows_shims_and_venvs(tmp_path, windows):
    project = tmp_path / "p"
    (project / ".venv" / "Scripts").mkdir(parents=True)
    (project / ".venv" / "Scripts" / "python.exe").write_text("")
    assert codetests.python_runner(project) == (".venv/Scripts/python.exe",)
    assert codetests.python_runner(tmp_path / "none") == ("python",)
    web = project / "web"
    (web / "node_modules" / ".bin").mkdir(parents=True)
    (web / "node_modules" / ".bin" / "vitest.cmd").write_text("")
    (web / "package.json").write_text('{"devDependencies": {"vitest": "1"}}')
    [suite] = [s for s in codetests.discover(project) if s.id == "vitest"]
    assert suite.argv == ("node_modules/.bin/vitest.cmd", "run") and suite.ready
    assert suite.cwd == "web"


def test_the_eden_code_command_is_a_cmd_on_a_pc(windows):
    shim = code_api.cli_shim(r"C:\Eden\python.exe")
    assert shim.startswith("@echo off\r\nREM " + code_api.CLI_MARK + "\r\n")
    assert '"C:\\Eden\\python.exe" -m jarvis.eden_code_cli %*' in shim
    assert code_api.cli_shim("/usr/bin/python3", windows=False).startswith("#!/bin/sh\n")
    api = code_api.Api.__new__(code_api.Api)
    api.cli_dir = Path("bin")
    assert api.cli_path().name == "eden-code.cmd"


# ── the look-at-this key ──


class _User32:
    def GetForegroundWindow(self):
        return 77

    def GetWindowTextLengthW(self, hwnd):
        return 20

    def GetWindowTextW(self, hwnd, buf, size):
        buf.value = "app.py - shop - Code"
        return 20

    def GetWindowThreadProcessId(self, hwnd, pid):
        pid._obj.value = 4242
        return 1


class _Kernel32:
    closed = False

    def OpenProcess(self, access, inherit, pid):
        assert (access, pid) == (0x1000, 4242)
        return 9

    def QueryFullProcessImageNameW(self, handle, flags, buf, size):
        buf.value = r"C:\Users\Ann\AppData\Local\Programs\Microsoft VS Code\Code.exe"
        return 1

    def CloseHandle(self, handle):
        _Kernel32.closed = True


def test_on_a_pc_the_front_window_and_its_program_come_from_windows():
    got = codelook.windows_front(_User32(), _Kernel32())
    assert got == {"app": "Code", "title": "app.py - shop - Code"} and _Kernel32.closed
    nothing = SimpleNamespace(GetForegroundWindow=lambda: 0)
    assert codelook.windows_front(nothing, _Kernel32()) == {}


async def test_on_a_pc_look_needs_no_helper_and_sends_the_whole_screen(monkeypatch, windows):
    monkeypatch.setattr(codelook, "windows_front", lambda: {"app": "Code", "title": "app.py"})
    assert codelook.ensure_helper() is None  # (no swiftc to build with)

    async def screen():
        return "U0NSRUVO"

    seen = await codelook.look(helper=lambda: None, screen=screen)
    assert (seen.app, seen.title, seen.selected) == ("Code", "app.py", "")
    assert seen.image == {"media_type": "image/jpeg", "data": "U0NSRUVO"}


# ── what's left out, and the list ──


def test_on_a_pc_the_mac_only_tools_are_left_out(windows):
    hub = SimpleNamespace(registered=[])
    code_interpreter.install(hub)  # (registers nothing: no attribute is touched)
    assert not hasattr(hub, "interpreter")
    servers = code_tools.build_servers(lambda *a: None, None, lambda: Path("."))
    assert code_tools.SIMULATOR not in servers and code_tools.BROWSER in servers


def test_on_a_mac_the_simulator_is_offered():
    servers = code_tools.build_servers(lambda *a: None, None, lambda: Path("."))
    assert code_tools.SIMULATOR in servers


async def test_the_window_asks_what_this_computer_can_t_do(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    seen = events_of(hub)
    await hub._handle({"type": "code_parity"})
    assert [e for e in seen() if e["type"] == "code_parity"][-1]["features"] == []
    monkeypatch.setattr(osplat, "IS_WIN", True)
    await hub._handle({"type": "code_parity"})
    said = [e for e in seen() if e["type"] == "code_parity"][-1]
    assert said["os"] == "windows" and len(said["features"]) == len(codeparity.REPORT)
