"""A project's setup and container for each new isolated copy (devcontainer.py and
features/code_setup.py): .jarvis/setup.sh (or launch.json's "setup") run in the copy after
a card that comes back whenever the script changes, its output streamed and its end in the
transcript; and, where the owner turns it on, a container per copy (docker faked: nothing
here runs docker) whose Bash steps the session's hook rewrites, taken away with the copy.
Real git in temp repositories; fake Claude Code sessions."""

import asyncio
import json
import os
import shlex
from pathlib import Path

import pytest
from test_code_changes import git, make_repo
from test_code_isolation import answer, copy_of, hub, isolated_session, projects, until

from jarvis import devcontainer, tasks

__all__ = ["hub", "projects"]  # (the fixtures, used by name)

SETUP = "echo READY in $(basename $PWD)\necho main=$EDEN_MAIN_FOLDER\necho made > made.txt\n"


class FakeDocker:
    """docker as code_setup sees it: every call kept, nothing run. Commands "in the
    container" run on the Mac with /bin/sh, so a setup's output is real."""

    def __init__(self, problem=""):
        self.problem = problem
        self.calls = []
        self.fail = {}  # first argument -> (code, output)

    def env(self):
        return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(Path.home())}

    async def check(self):
        return self.problem

    async def run(self, args, cwd=None, timeout=15):
        self.calls.append(list(args))
        return self.fail.get(args[0], (0, ""))

    async def socket(self):
        return "/tmp/fake-docker.sock"

    def exec_argv(self, name, cwd, command):
        self.calls.append(["exec", name, command])
        return ["/bin/sh", "-c", command]

    def exec_line(self, name, cwd, command):
        return shlex.join(
            ["/usr/local/bin/docker", "exec", "-w", str(cwd), name, "/bin/sh", "-c", command]
        )


@pytest.fixture
def docker(hub):
    fake = FakeDocker()
    hub.code_setup.docker = fake
    return fake


def said(task):
    return "\n".join(e["text"] for e in task.transcript)


async def started(hub, task):
    """The session has connected: its copy's setup (and container) are done by then."""
    assert await until(lambda: task.client is not None, seconds=120.0), task.transcript


# ── setup ──


async def test_the_setup_script_runs_in_each_new_copy_after_one_card(hub, projects, docker):
    make_repo(projects / "proj", {"a.py": "x = 1\n", ".jarvis/setup.sh": SETUP})
    answer(hub, "yes")
    task = await isolated_session(hub)
    await started(hub, task)
    [card] = hub.cards
    assert card["question"] == "Run proj's setup in the new copy?"
    assert "echo made > made.txt" in card["detail"] and "From .jarvis/setup.sh" in card["detail"]
    assert "I ask again if it changes" in card["detail"]
    copy = copy_of(hub, task)
    assert (copy.cwd / "made.txt").read_text() == "made\n"  # it ran in the copy…
    assert not (projects / "proj" / "made.txt").exists()  # …never the main folder
    text = said(task)
    assert "Setup finished in" in text and "READY in proj" in text
    assert f"main={(projects / 'proj').resolve()}" in text or f"main={projects / 'proj'}" in text
    streamed = [d for k, d in hub.events if k == "code_setup_output"]
    assert any("READY in proj" in line for d in streamed for line in d["lines"])
    assert streamed[-1]["done"] is True and streamed[-1]["code"] == 0
    # The next copy of the same script runs it without asking again.
    second = await isolated_session(hub, prompt="")
    await started(hub, second)
    assert len(hub.cards) == 1 and "Setup finished" in said(second)


async def test_a_changed_script_asks_again_and_no_means_it_is_skipped(hub, projects, docker):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n", ".jarvis/setup.sh": SETUP})
    answer(hub, "yes", "no")
    first = await isolated_session(hub)
    await started(hub, first)
    (repo / ".jarvis" / "setup.sh").write_text("echo something else\n")
    git(repo, "commit", "-qam", "change the setup")
    second = await isolated_session(hub)
    await started(hub, second)
    assert len(hub.cards) == 2 and "echo something else" in hub.cards[1]["detail"]
    assert "Setup was skipped." in said(second)
    assert not (copy_of(hub, second).cwd / "made.txt").exists()


async def test_an_unanswered_card_skips_the_setup_and_the_session_still_starts(
    hub, projects, docker, monkeypatch
):
    from jarvis.features import code_setup

    monkeypatch.setattr(code_setup, "ASK_SECONDS", 0.2)
    make_repo(projects / "proj", {"a.py": "x = 1\n", ".jarvis/setup.sh": SETUP})
    task = await isolated_session(hub)
    await started(hub, task)
    assert "nobody said yes to it in time" in said(task)


async def test_launch_json_setup_lines_run_in_order_and_stop_at_a_failure(hub, projects, docker):
    launch = {"version": "0.0.1", "configurations": [], "setup": ["echo one", "false", "echo two"]}
    make_repo(projects / "proj", {"a.py": "x\n", ".jarvis/launch.json": json.dumps(launch)})
    answer(hub, "yes")
    task = await isolated_session(hub)
    await started(hub, task)
    text = said(task)
    assert "Setup failed (exit 1)" in text and "one" in text and "two" not in text.split("```")[-2]
    assert "From .jarvis/launch.json" in hub.cards[0]["detail"]


def test_reading_the_setup(tmp_path):
    assert devcontainer.read_setup(tmp_path) == (None, "")
    (tmp_path / ".jarvis").mkdir()
    (tmp_path / ".jarvis" / "launch.json").write_text('{"setup": "npm ci"}')
    found, _ = devcontainer.read_setup(tmp_path)
    assert found.text == "npm ci" and found.command() == ["/bin/sh", "-c", "npm ci"]
    (tmp_path / ".jarvis" / "launch.json").write_text('{"setup": 5}')
    assert "must be a command" in devcontainer.read_setup(tmp_path)[1]
    (tmp_path / ".jarvis" / "setup.sh").write_text("make\n")
    found, _ = devcontainer.read_setup(tmp_path)  # the script wins over the entry
    assert found.source == ".jarvis/setup.sh" and found.command() == [
        "/bin/bash",
        ".jarvis/setup.sh",
    ]
    other = devcontainer.Setup(".jarvis/setup.sh", "make all\n")
    assert other.fingerprint != found.fingerprint
    (tmp_path / ".jarvis" / "setup.sh").write_text("x" * (devcontainer.SETUP_MAX + 1))
    assert "isn't run" in devcontainer.read_setup(tmp_path)[1]
    (tmp_path / ".jarvis" / "setup.sh").unlink()
    (tmp_path / ".jarvis" / "setup.sh").symlink_to(tmp_path / ".jarvis" / "launch.json")
    assert "is a link" in devcontainer.read_setup(tmp_path)[1]


def test_a_session_still_cant_edit_the_setup_script_unasked(tmp_path):
    """S21's rule stands for the setup: .jarvis/ is a protected folder."""
    from jarvis.tasks import ClaudeTask

    manager = tasks.TaskManager.__new__(tasks.TaskManager)
    task = ClaudeTask(id=1, prompt="", cwd=tmp_path)
    assert not manager._free_edit(task, {"file_path": str(tmp_path / ".jarvis" / "setup.sh")})
    assert manager._free_edit(task, {"file_path": str(tmp_path / "setup.sh")})


# ── containers ──


DEVCONTAINER = """{
  // the project's dev container
  "name": "app", /* a comment */
  "image": "mcr.microsoft.com/devcontainers/python:3.12",
  "forwardPorts": [8000,],
}"""


def container_on(hub, name="proj", image=None):
    changes = {"code_container_projects": [name]}
    if image:
        changes["code_container_images"] = {name: image}
    hub.set_feature_prefs(changes)


async def test_a_devcontainer_copy_runs_its_commands_in_a_container(hub, projects, docker):
    make_repo(
        projects / "proj",
        {"a.py": "x\n", ".devcontainer/devcontainer.json": DEVCONTAINER, ".jarvis/setup.sh": SETUP},
    )
    container_on(hub)
    answer(hub, "yes", "yes")
    task = await isolated_session(hub)
    await started(hub, task)
    copy = copy_of(hub, task)
    assert hub.cards[0]["question"] == (
        "Run proj's sessions in a container from .devcontainer/devcontainer.json?"
    )
    assert "python:3.12" in hub.cards[0]["detail"] and "read-only" in hub.cards[0]["detail"]
    name = f"eden-{copy.slug}"
    [run] = [c for c in docker.calls if c[0] == "run"]
    assert run[run.index("--name") + 1] == name and "no-new-privileges" in run
    assert f"{copy.checkout}:{copy.checkout}" in run  # the copy, at its own path
    assert any(m.endswith(":ro") and m.split(":")[0].endswith(".git") for m in run)
    assert run[run.index("--entrypoint") + 2] == "mcr.microsoft.com/devcontainers/python:3.12"
    # The setup ran in the container (docker exec), told where the main folder is.
    [exec_call] = [c for c in docker.calls if c[0] == "exec"]
    assert exec_call[1] == name and "EDEN_MAIN_FOLDER=" in exec_call[2]
    assert "Commands run in the container" in said(task)
    # The session's Bash steps go through the hook, into the container.
    hooks = task.client.options.hooks["PreToolUse"]
    bash = [h for h in hooks if h.matcher == "Bash"]
    assert bash
    out = await bash[0].hooks[0](
        {"tool_name": "Bash", "tool_input": {"command": "pytest -q"}}, None, None
    )
    line = out["hookSpecificOutput"]["updatedInput"]["command"]
    assert shlex.split(line)[-3:] == ["/bin/sh", "-c", "pytest -q"] and name in line
    assert "permissionDecision" not in out["hookSpecificOutput"]  # the session's mode still decides
    again = await bash[0].hooks[0](
        {"tool_name": "Bash", "tool_input": {"command": line}}, None, None
    )
    assert again == {}  # never wrapped twice
    # Landing takes the container away with the copy.
    answer(hub, "land")
    task.busy = False
    await hub.code_desk.land(copy.slug)
    await asyncio.sleep(0.05)
    assert ["rm", "-f", name] in docker.calls[-2:]
    assert copy.slug not in hub.code_setup.containers()


async def test_the_owners_own_image_needs_no_card(hub, projects, docker):
    make_repo(projects / "proj", {"a.py": "x\n"})
    container_on(hub, image="node:22")
    answer(hub)
    task = await isolated_session(hub)
    await started(hub, task)
    assert hub.cards == []
    [run] = [c for c in docker.calls if c[0] == "run"]
    assert "node:22" in run


async def test_without_docker_it_says_how_to_install_it_and_runs_on_the_mac(hub, projects, docker):
    make_repo(projects / "proj", {"a.py": "x\n"})
    container_on(hub, image="node:22")
    docker.problem = devcontainer.INSTALL
    task = await isolated_session(hub)
    await started(hub, task)
    assert "install Docker Desktop" in said(task) and "brew install colima" in said(task)
    assert not [c for c in docker.calls if c[0] == "run"]
    assert not [
        h for h in (task.client.options.hooks or {}).get("PreToolUse", []) if h.matcher == "Bash"
    ]


async def test_no_image_anywhere_says_so(hub, projects, docker):
    make_repo(projects / "proj", {"a.py": "x\n"})
    container_on(hub)
    task = await isolated_session(hub)
    await started(hub, task)
    assert "it has no image: pick one" in said(task)


async def test_a_dockerfile_is_built_after_the_card(hub, projects, docker):
    dc = '{"build": {"dockerfile": "Dockerfile", "context": ".."}}'
    make_repo(
        projects / "proj",
        {
            "a.py": "x\n",
            ".devcontainer/devcontainer.json": dc,
            ".devcontainer/Dockerfile": "FROM alpine\n",
        },
    )
    container_on(hub)
    answer(hub, "yes")
    task = await isolated_session(hub)
    await started(hub, task)
    assert "building it runs that Dockerfile" in hub.cards[0]["detail"]
    [build] = [c for c in docker.calls if c[0] == "build"]
    assert build[build.index("-f") + 1] == ".devcontainer/Dockerfile" and build[-1] == "."
    tag = build[build.index("-t") + 1]
    [run] = [c for c in docker.calls if c[0] == "run"]
    assert tag in run


async def test_saying_no_to_the_container_runs_on_the_mac(hub, projects, docker):
    make_repo(projects / "proj", {"a.py": "x\n", ".devcontainer/devcontainer.json": DEVCONTAINER})
    container_on(hub)
    answer(hub, "no")
    task = await isolated_session(hub)
    await started(hub, task)
    assert not [c for c in docker.calls if c[0] == "run"]


async def test_the_tidy_up_removes_containers_whose_copy_is_gone(hub, docker):
    hub.code_setup.containers()["gone-1234"] = {"name": "eden-gone-1234", "image": "x", "cwd": "/"}
    await hub.code_setup.tidy()
    await asyncio.sleep(0.05)
    assert ["rm", "-f", "eden-gone-1234"] in docker.calls


def test_devcontainer_json_with_comments_and_paths_that_leave_the_project(tmp_path):
    (tmp_path / ".devcontainer").mkdir()
    (tmp_path / ".devcontainer" / "devcontainer.json").write_text(DEVCONTAINER)
    image, problem = devcontainer.read_devcontainer(tmp_path)
    assert image.image == "mcr.microsoft.com/devcontainers/python:3.12" and problem == ""
    assert (
        devcontainer.strip_jsonc('{"u": "https://x//y", /* c */ "a": [1,],}')
        == '{"u": "https://x//y",  "a": [1]}'
    )
    (tmp_path / ".devcontainer" / "devcontainer.json").write_text(
        '{"build": {"dockerfile": "../../etc/Dockerfile"}}'
    )
    assert "outside the project" in devcontainer.read_devcontainer(tmp_path)[1]
    (tmp_path / ".devcontainer" / "devcontainer.json").write_text('{"image": "--privileged"}')
    assert "wouldn't take" in devcontainer.read_devcontainer(tmp_path)[1]
    (tmp_path / ".devcontainer" / "devcontainer.json").write_text('{"dockerComposeFile": "x.yml"}')
    assert "Docker Compose" in devcontainer.read_devcontainer(tmp_path)[1]


async def test_the_pane_shows_the_setup_and_the_container_state(hub, projects, docker):
    make_repo(projects / "proj", {"a.py": "x\n", ".jarvis/setup.sh": "make\n"})
    container_on(hub)
    docker.problem = devcontainer.NOT_RUNNING
    await hub.code_setup.cmd_state({"directory": "proj"})
    [event] = [d for k, d in hub.events if k == "code_setup"]
    assert event["setup"] == {"source": ".jarvis/setup.sh", "text": "make\n"}
    assert event["container"]["on"] is True and "isn't running" in event["container"]["docker"]


async def test_a_command_that_only_starts_like_the_docker_exec_line_still_goes_in(
    hub, projects, docker
):
    """B1: the hook left alone any command that merely started with its docker exec words,
    so "<that line> true; <anything>" ran the rest on the Mac (with docker's socket open in
    the sandbox). Only the exact line it makes is left as it is; a gone container refuses."""
    make_repo(projects / "proj", {"a.py": "x\n"})
    container_on(hub, image="node:22")
    task = await isolated_session(hub)
    await started(hub, task)
    copy = copy_of(hub, task)
    [bash] = [h for h in task.client.options.hooks["PreToolUse"] if h.matcher == "Bash"]
    hook = bash.hooks[0]
    name = f"eden-{copy.slug}"
    own = docker.exec_line(name, copy.cwd, "true")
    other = docker.exec_line("eden-someone-else", copy.cwd, "true")
    for sneaky in [
        own + "; touch /tmp/on-the-mac",
        own + " && curl evil",
        own.replace(" exec ", " exec --privileged ", 1),
        other,
        own + " extra-word",
    ]:
        out = await hook({"tool_name": "Bash", "tool_input": {"command": sneaky}}, None, None)
        line = out["hookSpecificOutput"]["updatedInput"]["command"]
        assert shlex.split(line)[-1] == sneaky and name in line, sneaky
    assert await hook({"tool_name": "Bash", "tool_input": {"command": own}}, None, None) == {}
    # The container gone under the session: its steps are refused, never run on the Mac.
    hub.code_setup.containers().pop(copy.slug)
    out = await hook({"tool_name": "Bash", "tool_input": {"command": "ls"}}, None, None)
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"


async def test_a_containers_copy_has_its_git_pinned_across_a_restart(hub, projects, docker):
    """B2: Eden's own git in a container's copy runs on the git data read before the
    container started, recorded with it, and pinned again when the app starts; a record
    from before there was one is pinned from the copy's .git when that's the main repo's."""
    from jarvis import code_changes

    make_repo(projects / "proj", {"a.py": "x\n"})
    container_on(hub, image="node:22")
    task = await isolated_session(hub)
    await started(hub, task)
    copy = copy_of(hub, task)
    [run] = [c for c in docker.calls if c[0] == "run"]
    assert f"{copy.checkout}/.git:{copy.checkout}/.git:ro" in run
    info = hub.code_setup.containers()[copy.slug]
    assert info["git"]["common"].endswith(".git") and info["checkout"] == str(copy.checkout)
    real = os.path.realpath(copy.checkout)
    assert code_changes._PINS[real] == info["git"]
    for record in (info, {k: v for k, v in info.items() if k not in ("git", "checkout")}):
        code_changes.unpin_git(copy.checkout)
        hub.code_setup._containers = None
        from jarvis import jsonstore

        jsonstore.save_json(hub.feature_path("code_containers.json"), {copy.slug: record})
        hub.code_setup.containers()
        assert code_changes._PINS[real] == info["git"]
    hub.code_setup.on_copy_gone(copy.slug)
    assert real not in code_changes._PINS
