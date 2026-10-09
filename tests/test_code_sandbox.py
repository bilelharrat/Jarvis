"""Eden Code's sandbox (codesandbox, features.code_sandbox): Bypass and unattended sessions
in Claude Code's sandbox when the switch is on, a session's own choice, the project's
allowlist, commands that ask until the sandbox is on, and another feature's sandbox left
alone."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from claude_agent_sdk import PermissionResultAllow, ToolPermissionContext
from code_session_fakes import Stream, end_all, events_of, make_hub, until

from jarvis.codeplatform import add_rule_check
from jarvis.codesandbox import DomainError, SandboxBook, clean_domain
from jarvis.features import code_sandbox

CTX = ToolPermissionContext()


def test_a_domain_is_kept_as_the_sandbox_takes_it():
    assert clean_domain("Registry.NPMjs.org") == "registry.npmjs.org"
    assert clean_domain(" https://user@pypi.org:443/simple/x?y ") == "pypi.org"
    assert clean_domain("*.GitHubUserContent.com.") == "*.githubusercontent.com"
    for bad in ["", "localhost", "not a domain", "*.*.x.com", "exa_mple.com", "http://"]:
        with pytest.raises(DomainError):
            clean_domain(bad)


def test_the_allowlists_are_kept_and_read_defensively(tmp_path):
    path = tmp_path / "code_sandbox.json"
    book = SandboxBook(path)
    assert book.add("/p", ["pypi.org", "PyPI.org", "files.pythonhosted.org"]) == [
        "pypi.org",
        "files.pythonhosted.org",
    ]
    with pytest.raises(DomainError):
        book.add("/p", ["github.com", "no good"])  # one bad: none added
    assert SandboxBook(path).domains("/p") == ["pypi.org", "files.pythonhosted.org"]
    assert book.remove("/p", "pypi.org") and not book.remove("/p", "pypi.org")
    path.write_text(
        json.dumps({"projects": {"/p": {"domains": ["ok.com", "bad one", 3]}, "/q": "x"}})
    )
    assert SandboxBook(path).projects == {"/p": ["ok.com"]}


def test_rule_checks_from_several_features_weigh_in_the_strictest_first():
    manager = SimpleNamespace(rule_check=None)
    add_rule_check(manager, lambda *_: ("allow", "A"))
    assert manager.rule_check(None, "Bash", {}) == ("allow", "A")
    add_rule_check(manager, lambda *_: ("ask", "B"))
    assert manager.rule_check(None, "Bash", {}) == ("ask", "B")
    add_rule_check(manager, lambda *_: None)
    add_rule_check(manager, lambda *_: ("deny", "C"))
    assert manager.rule_check(None, "Bash", {}) == ("deny", "C")
    quiet = SimpleNamespace(rule_check=None)
    add_rule_check(quiet, lambda *_: None)
    add_rule_check(quiet, lambda *_: None)
    assert quiet.rule_check(None, "Bash", {}) is None


# ── in a session ──


def _fresh(settings, quiet_speaker, isolated, tmp_path, on=True):
    (tmp_path / "proj").mkdir(exist_ok=True)
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    if on:
        hub.set_feature_prefs({"code_sandbox_bypass": True})
    return hub


async def test_bypass_sessions_run_in_the_sandbox_when_the_switch_is_on(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path)
    project = str((tmp_path / "proj").resolve())
    hub.code_sandbox.book.add(project, ["registry.npmjs.org"])
    bypass = hub.tasks.start("one", "proj", mode="auto")
    assert await until(lambda: bypass.status == "waiting")
    manual = hub.tasks.start("two", "proj")
    assert await until(lambda: manual.status == "waiting")
    sandbox = Stream.instances[0].options.sandbox
    assert sandbox == {
        "enabled": True,
        "autoAllowBashIfSandboxed": False,
        "allowUnsandboxedCommands": False,
        "network": {"allowedDomains": ["registry.npmjs.org"], "allowLocalBinding": True},
    }
    assert Stream.instances[1].options.sandbox is None  # Manual: it asks anyway
    await end_all(hub)


async def test_the_switch_off_leaves_bypass_as_it_was(settings, quiet_speaker, isolated, tmp_path):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path, on=False)
    task = hub.tasks.start("one", "proj", mode="auto")
    assert await until(lambda: task.status == "waiting")
    assert Stream.instances[0].options.sandbox is None
    await end_all(hub)


async def test_a_session_s_own_choice_wins_and_reopens_it(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path, on=False)
    seen = events_of(hub)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.status == "waiting")
    await hub._handle({"type": "cs_session", "id": task.id, "on": True})
    assert await until(lambda: len(Stream.instances) == 2, 600)
    assert Stream.instances[1].options.sandbox["enabled"] is True
    assert code_sandbox.NOW_ON in [e["text"] for e in task.transcript]
    state = [e for e in seen() if e["type"] == "cs_state"][-1]
    assert state["on"] and state["own"] is True and not state["default"]
    await hub._handle({"type": "cs_session", "id": task.id, "on": None})  # back to the switch
    assert await until(lambda: len(Stream.instances) == 3, 600)
    assert Stream.instances[2].options.sandbox is None
    await end_all(hub)


async def test_into_bypass_mid_step_its_commands_ask_till_the_sandbox_is_on(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.status == "waiting")
    Stream.instances[0].hold = True
    hub.tasks.send(task.id, "long job")
    assert await until(lambda: task.busy)
    hub.tasks.set_mode(task.id, "auto")  # Bypass, while a step runs unsandboxed
    policy = hub.tasks.policy_for(task)
    asking = asyncio.ensure_future(policy("Bash", {"command": "ls"}, CTX))
    assert await until(lambda: hub.approvals)  # a card, not Bypass's free pass
    [card] = hub.approvals.values()
    hub.resolve(card["id"], "allow")
    assert isinstance(await asking, PermissionResultAllow)
    Stream.instances[0].release()
    assert await until(lambda: len(Stream.instances) == 2, 600)  # its next step: sandboxed
    assert Stream.instances[1].options.sandbox["enabled"] is True
    assert await until(lambda: task.client is Stream.instances[1])
    ok = await policy("Bash", {"command": "rm -rf build"}, CTX)
    assert isinstance(ok, PermissionResultAllow) and task.audit[-1]["decision"] == "bypass"
    await end_all(hub)


async def test_the_allowlist_is_edited_in_the_pane_and_sessions_take_it_up(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path)
    seen = events_of(hub)
    task = hub.tasks.start("one", "proj", mode="auto")
    assert await until(lambda: task.status == "waiting")
    last = lambda: [e for e in seen() if e["type"] == "cs_state"][-1]  # noqa: E731
    await hub._handle({"type": "cs_domains", "id": task.id, "add": ["not a domain"]})
    assert "isn't a domain" in last()["error"]
    await hub._handle({"type": "cs_domains", "id": task.id, "add": "pypi"})
    assert last()["domains"] == ["pypi.org", "files.pythonhosted.org"]
    assert await until(lambda: len(Stream.instances) == 2, 600)
    allowed = Stream.instances[1].options.sandbox["network"]["allowedDomains"]
    assert allowed == ["pypi.org", "files.pythonhosted.org"]
    assert code_sandbox.ALLOWLIST in [e["text"] for e in task.transcript]
    await hub._handle({"type": "cs_domains", "id": task.id, "remove": "pypi.org"})
    assert last()["domains"] == ["files.pythonhosted.org"] and last()["live"]
    await end_all(hub)


async def test_an_unattended_run_is_sandboxed_and_another_feature_s_sandbox_stands(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path)
    own = {"enabled": True, "network": {"allowedDomains": []}}

    def issue_run(task, options):  # (an issue's run: its own sandbox, no network at all)
        if task.prompt == "issue":
            options.sandbox = dict(own)

    hub.tasks.session_extras.append(issue_run)
    hub.code_runs = SimpleNamespace(active={})
    project = str((tmp_path / "proj").resolve())
    hub.code_sandbox.book.add(project, ["github.com"])
    issue = hub.tasks.start("", "proj", mode="auto")
    issue.prompt = "issue"
    hub.tasks.send(issue.id, "fix it")
    assert await until(lambda: issue.status == "waiting")
    assert Stream.instances[0].options.sandbox == own
    run = hub.tasks.start("", "proj", mode="edits")
    hub.code_runs.active[run.id] = object()
    hub.tasks.send(run.id, "run the tests")
    assert await until(lambda: run.status == "waiting")
    assert Stream.instances[1].options.sandbox["network"]["allowedDomains"] == ["github.com"]
    await end_all(hub)


def test_its_transcript_notes_have_chinese_in_the_window():
    import re

    from jarvis.server import zh_strings

    zh = zh_strings()
    for note in [code_sandbox.NOW_ON, code_sandbox.NOW_OFF, code_sandbox.ALLOWLIST]:
        assert note in zh["strings"] or any(re.fullmatch(p, note) for p, _ in zh["patterns"])
