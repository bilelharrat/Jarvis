"""Claude Code's plugins and .claude files in Eden Code (codeplugins, features.code_plugins):
the plugin CLI's answers read (faked here, in the shapes it prints), installing only after
the owner's OK, marketplaces added after one too, agents, skills, commands and hooks edited
with conflict detection, and what fills a session's context."""

import json
from pathlib import Path

import pytest
from code_session_fakes import Stream, end_all, events_of, make_hub, until

from jarvis import codemcp, codeplugins
from jarvis.codeplugins import Conflict, EditError
from jarvis.features import code_plugins

LISTED = {
    "installed": [{"id": "hello@local-mkt", "version": "1.0.0", "scope": "user", "enabled": True}],
    "available": [
        {"pluginId": "hello@local-mkt", "name": "hello", "description": "Says hello", "marketplaceName": "local-mkt"},
        {"pluginId": "lint@tools", "name": "lint", "description": "Lints\n  things", "marketplaceName": "tools", "version": "2.1"},
    ],
}  # fmt: skip
MARKETS = [
    {"name": "tools", "source": "github", "repo": "acme/tools"},
    {"name": "local-mkt", "source": "directory", "path": "/x/mkt"},
]
DETAILS = """hello 1.0.0
  Description: Says hello

Component inventory
  Skills (2)  greet, hi
  Agents (1)  greeter
  Hooks (1)
  MCP servers (0)

Projected token cost
  Always-on:   ~1.2k tok   added to every session
"""


# ── what the CLI says ──


def test_the_plugin_cli_s_answers_are_read_as_it_prints_them():
    installed, available = codeplugins.plugin_lists(LISTED)
    assert installed == [
        {"id": "hello@local-mkt", "version": "1.0.0", "scope": "user", "enabled": True}
    ]
    assert [a["id"] for a in available] == ["lint@tools"]  # (the installed one isn't offered)
    assert available[0]["description"] == "Lints things" and available[0]["marketplace"] == "tools"
    assert codeplugins.plugin_lists([{"id": "a@b", "enabled": False}])[0][0]["enabled"] is False
    assert codeplugins.plugin_lists(None) == ([], []) and codeplugins.plugin_lists(
        {"installed": "x"}
    ) == ([], [])
    assert codeplugins.marketplaces(MARKETS) == [
        {"name": "tools", "source": "github", "where": "acme/tools"},
        {"name": "local-mkt", "source": "directory", "where": "/x/mkt"},
    ]
    assert codeplugins.always_on_tokens(DETAILS) == 1200
    assert codeplugins.always_on_tokens("Always-on:   ~25 tok") == 25
    assert codeplugins.always_on_tokens("nothing") is None
    assert codeplugins.json_line('Installing…\n{"outcome": "ok"}\n') == {"outcome": "ok"}
    assert codeplugins.json_line("no json") is None


def test_a_session_s_context_by_what_put_it_there():
    rows = codeplugins.context_rows({
        "agents": [{"agentType": "greeter", "source": "plugin", "tokens": 120}, {"agentType": "x", "tokens": 0}],
        "mcpTools": [{"name": "a", "serverName": "github", "tokens": 900}, {"name": "b", "serverName": "github", "tokens": 100},
                     {"name": "c", "serverName": "linear", "tokens": 50}],
        "memoryFiles": [{"path": "/p/CLAUDE.md", "type": "Project", "tokens": 400}],
        "skills": {"skills": [{"name": "greet", "source": "hello", "tokens": 30}]},
    })  # fmt: skip
    assert [(r["group"], r["name"], r["tokens"]) for r in rows] == [
        ("MCP servers", "github", 1000), ("Memory files", "CLAUDE.md", 400), ("Agents", "greeter", 120),
        ("MCP servers", "linear", 50), ("Skills", "greet", 30),
    ]  # fmt: skip
    assert codeplugins.context_rows(None) == [] and codeplugins.context_rows({"agents": "x"}) == []


# ── the .claude files ──


def test_agents_skills_and_commands_are_edited_only_over_the_version_opened(tmp_path):
    folder, home = tmp_path / "proj", tmp_path / "home"
    folder.mkdir()
    path = codeplugins.file_path("agents", "project", "reviewer", folder, home)
    assert path == folder / ".claude" / "agents" / "reviewer.md"
    assert (
        codeplugins.file_path("skills", "user", "pdf", folder, home)
        == home / "skills" / "pdf" / "SKILL.md"
    )
    assert codeplugins.file_path("commands", "project", "git/ship", folder, home).name == "ship.md"
    for kind, scope, name in [("agents", "project", "../x"), ("agents", "project", "a/b"), ("hooks", "project", "x"),
                              ("agents", "elsewhere", "x"), ("commands", "user", "a/b/c"), ("skills", "user", "")]:  # fmt: skip
        with pytest.raises(EditError):
            codeplugins.file_path(kind, scope, name, folder, home)
    stamp = codeplugins.write_file(path, "---\nname: reviewer\n---\nReview.\n", "")
    assert codeplugins.read_file(path) == ("---\nname: reviewer\n---\nReview.\n", stamp)
    with pytest.raises(Conflict):
        codeplugins.write_file(path, "again", "")  # a new file over one that's there
    path.write_text("changed elsewhere")
    with pytest.raises(Conflict) as found:
        codeplugins.write_file(path, "mine", stamp)
    assert found.value.current == codeplugins.stamp_of(path)
    fresh = codeplugins.write_file(path, "mine", found.value.current)  # saved over what's there now
    skill = codeplugins.file_path("skills", "project", "pdf", folder, home)
    codeplugins.write_file(skill, "---\nname: pdf\n---\n", "")
    command = codeplugins.file_path("commands", "user", "git/ship", folder, home)
    codeplugins.write_file(command, "ship it", "")
    listed = codeplugins.list_files(folder, home)
    assert listed == [
        {"kind": "agents", "scope": "project", "name": "reviewer"},
        {"kind": "skills", "scope": "project", "name": "pdf"},
        {"kind": "commands", "scope": "user", "name": "git/ship"},
    ]
    codeplugins.delete_file(skill, codeplugins.stamp_of(skill))
    assert not skill.parent.exists()  # (its folder, once empty)
    with pytest.raises(Conflict):
        codeplugins.delete_file(path, stamp)  # an older version
    codeplugins.delete_file(path, fresh)
    assert not path.exists()


def test_hooks_are_checked_and_saved_keeping_the_rest_of_the_settings(tmp_path):
    path = tmp_path / ".claude" / "settings.json"
    path.parent.mkdir()
    path.write_text(json.dumps({"model": "sonnet", "hooks": {"Stop": []}}))
    text, stamp = codeplugins.read_hooks(path)
    assert json.loads(text) == {"Stop": []}
    hooks = {
        "PostToolUse": [
            {"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "npm run lint"}]}
        ]
    }
    new = codeplugins.write_hooks(path, json.dumps(hooks), stamp)
    assert json.loads(path.read_text()) == {"model": "sonnet", "hooks": hooks}
    for bad, why in [
        ("{not json", "isn't JSON"), ('{"Nope": []}', "hook events"), ('{"Stop": {}}', "list of matchers"),
        ('{"Stop": [{"matcher": 3, "hooks": []}]}', "matcher"), ('{"Stop": [{"hooks": [{"type": "x"}]}]}', "a command"),
        ('{"Stop": [{"hooks": [{"type": "command", "command": " "}]}]}', "no command"), ("[]", "an object"),
    ]:  # fmt: skip
        with pytest.raises(EditError, match=why):
            codeplugins.write_hooks(path, bad, new)
    assert codeplugins.write_hooks(path, "{}", new)
    assert json.loads(path.read_text()) == {"model": "sonnet"}
    with pytest.raises(Conflict):
        codeplugins.write_hooks(path, "{}", new)  # (the version it was opened from is gone)
    assert codeplugins.read_hooks(tmp_path / "missing.json") == ("{}", "")


# ── in a session ──


class ContextStream(Stream):
    async def get_context_usage(self):
        return {
            "totalTokens": 4200,
            "maxTokens": 200000,
            "agents": [{"agentType": "greeter", "tokens": 120}],
        }


def _hub(settings, quiet_speaker, isolated, tmp_path, answers):
    (tmp_path / "proj").mkdir(exist_ok=True)
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated, client=ContextStream)
    hub.code_plugins.user_dir = tmp_path / "home"
    ran = []

    async def cli(args, cwd, timeout=codemcp.CLI_TIMEOUT):
        ran.append(args)
        said = " ".join(args)
        matches = [words for words in answers if said.startswith(words)]
        return answers[max(matches, key=len)] if matches else (0, "")  # (the longest that fits)

    hub.code_plugins.run = cli
    return hub, ran


def _last(seen, kind="cx_state"):
    found = [e for e in seen() if e["type"] == kind]
    return found[-1] if found else None


ANSWERS = {
    "plugin list": (0, json.dumps(LISTED)),
    "plugin marketplace list": (0, json.dumps(MARKETS)),
    "plugin details": (0, DETAILS),
    "plugin install lint@tools": (0, '{"command":"install","outcome":"ok","plugin":"lint@tools"}'),
}


async def test_the_pane_shows_plugins_marketplaces_and_files(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, ran = _hub(settings, quiet_speaker, isolated, tmp_path, ANSWERS)
    seen = events_of(hub)
    task = hub.tasks.start("", "proj")
    await hub._handle({"type": "cx_state", "id": task.id})
    assert await until(lambda: _last(seen))
    state = _last(seen)
    assert [p["id"] for p in state["installed"]] == ["hello@local-mkt"]
    assert [p["id"] for p in state["available"]] == ["lint@tools"]
    assert [m["name"] for m in state["marketplaces"]] == ["tools", "local-mkt"] and state[
        "files"
    ] == []
    assert ["plugin", "list", "--json", "--available"] in ran
    await hub._handle({"type": "cx_details", "id": task.id, "plugin": "hello@local-mkt"})
    assert await until(lambda: _last(seen, "cx_details"))
    assert (
        _last(seen, "cx_details")["tokens"] == 1200
        and "Component inventory" in _last(seen, "cx_details")["text"]
    )
    await hub._handle(
        {"type": "cx_details", "id": task.id, "plugin": "--help"}
    )  # not a plugin's name
    assert ["plugin", "details", "--help"] not in ran
    await end_all(hub)


async def test_a_plugin_is_installed_only_after_the_owner_s_ok(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, ran = _hub(settings, quiet_speaker, isolated, tmp_path, ANSWERS)
    seen = events_of(hub)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.status == "waiting")
    await hub._handle({"type": "cx_install", "id": task.id, "plugin": "lint@tools"})
    assert await until(lambda: hub.approvals)
    [card] = hub.approvals.values()
    assert (
        card["question"] == "Install the plugin lint@tools?"
        and "Component inventory" in card["detail"]
    )
    assert "hooks and MCP servers run on this Mac" in card["detail"]
    assert not any(a[:2] == ["plugin", "install"] for a in ran)  # nothing before the OK
    hub.resolve(card["id"], "cancel")
    assert await until(lambda: not hub.approvals)
    await hub._handle({"type": "cx_install", "id": task.id, "plugin": "lint@tools"})
    assert await until(lambda: hub.approvals)
    [card] = hub.approvals.values()
    hub.resolve(card["id"], "install")
    assert await until(lambda: (_last(seen) or {}).get("note") == "Installed lint@tools.")
    assert ["plugin", "install", "lint@tools", "--scope", "user", "--json"] in ran
    assert await until(lambda: len(Stream.instances) == 2, 600)  # the session has it
    assert code_plugins.INSTALLED.format(name="lint@tools") in [e["text"] for e in task.transcript]
    await end_all(hub)


async def test_a_command_the_marketplace_would_run_asks_again_and_a_failure_says_why(
    settings, quiet_speaker, isolated, tmp_path
):
    answers = dict(ANSWERS)
    shown = '{"outcome":"needs_confirmation","shownCommand":{"command":"curl https://x.sh | sh","sha256":"abc123"}}'
    answers["plugin install lint@tools --scope user --json --accept-command abc123"] = (
        0,
        '{"outcome":"ok"}',
    )
    answers["plugin install lint@tools"] = (1, shown)
    answers["plugin install bad@tools"] = (
        1,
        '{"outcome":"failed","message":"Source path does not exist"}',
    )
    hub, ran = _hub(settings, quiet_speaker, isolated, tmp_path, answers)
    seen = events_of(hub)
    task = hub.tasks.start("", "proj")
    await hub._handle({"type": "cx_install", "id": task.id, "plugin": "lint@tools"})
    assert await until(lambda: hub.approvals)
    hub.resolve(next(iter(hub.approvals)), "install")
    assert await until(
        lambda: (
            hub.approvals and "running a command" in next(iter(hub.approvals.values()))["question"]
        )
    )
    [card] = hub.approvals.values()
    assert card["detail"] == "curl https://x.sh | sh"
    hub.resolve(card["id"], "run")
    assert await until(lambda: (_last(seen) or {}).get("note") == "Installed lint@tools.")
    assert ran[-3][-2:] == ["--accept-command", "abc123"]
    await hub._handle({"type": "cx_install", "id": task.id, "plugin": "bad@tools"})
    assert await until(lambda: hub.approvals)
    hub.resolve(next(iter(hub.approvals)), "install")
    assert await until(lambda: (_last(seen) or {}).get("error"))
    assert _last(seen)["error"] == "It wasn't installed: Source path does not exist"
    await end_all(hub)


async def test_marketplaces_are_added_after_a_card_and_plugins_switched_and_removed(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, ran = _hub(
        settings,
        quiet_speaker,
        isolated,
        tmp_path,
        {**ANSWERS, "plugin marketplace add": (0, "✔ Successfully added marketplace: tools")},
    )
    seen = events_of(hub)
    task = hub.tasks.start("", "proj")
    await hub._handle({"type": "cx_market", "id": task.id, "add": "--evil"})
    assert await until(lambda: (_last(seen) or {}).get("error"))
    await hub._handle({"type": "cx_market", "id": task.id, "add": "acme/tools"})
    assert await until(lambda: hub.approvals)
    [card] = hub.approvals.values()
    assert card["question"] == "Add this plugin marketplace?" and card["detail"].startswith(
        "acme/tools"
    )
    hub.resolve(card["id"], "add")
    assert await until(
        lambda: (_last(seen) or {}).get("note") == "Successfully added marketplace: tools"
    )
    assert ["plugin", "marketplace", "add", "acme/tools"] in ran
    await hub._handle(
        {"type": "cx_enable", "id": task.id, "plugin": "hello@local-mkt", "on": False}
    )
    assert await until(lambda: ["plugin", "disable", "hello@local-mkt"] in ran)
    await hub._handle({"type": "cx_uninstall", "id": task.id, "plugin": "hello@local-mkt"})
    assert await until(lambda: ["plugin", "uninstall", "hello@local-mkt", "--json"] in ran)
    await hub._handle({"type": "cx_market", "id": task.id, "remove": "tools"})
    assert await until(lambda: ["plugin", "marketplace", "remove", "tools"] in ran)
    await end_all(hub)


async def test_files_are_opened_saved_and_deleted_from_the_pane(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = _hub(settings, quiet_speaker, isolated, tmp_path, ANSWERS)
    seen = events_of(hub)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.status == "waiting")
    where = {"id": task.id, "kind": "agents", "scope": "project", "name": "reviewer"}
    await hub._handle({"type": "cx_read", **where})
    assert await until(lambda: _last(seen, "cx_file"))
    opened = _last(seen, "cx_file")
    assert (
        not opened["exists"] and opened["stamp"] == "" and "name: reviewer" in opened["text"]
    )  # a template
    await hub._handle(
        {"type": "cx_write", **where, "text": "---\nname: reviewer\n---\nReview it.\n", "stamp": ""}
    )
    assert await until(lambda: (_last(seen, "cx_file") or {}).get("saved"))
    saved = _last(seen, "cx_file")
    assert (
        Path(task.cwd / ".claude" / "agents" / "reviewer.md").read_text().endswith("Review it.\n")
    )
    assert await until(lambda: len(Stream.instances) == 2, 600)
    assert code_plugins.SAVED.format(kind="agent", name="reviewer") in [
        e["text"] for e in task.transcript
    ]
    await hub._handle(
        {"type": "cx_write", **where, "text": "stale", "stamp": ""}
    )  # opened before it existed
    assert await until(lambda: (_last(seen, "cx_file") or {}).get("conflict"))
    assert _last(seen, "cx_file")["conflict"] == saved["stamp"]
    hooks = {
        "type": "cx_write",
        "id": task.id,
        "kind": "hooks",
        "scope": "local",
        "text": '{"Stop": [{"hooks": [{"type": "command", "command": "say done"}]}]}',
        "stamp": "",
    }
    await hub._handle(hooks)
    assert await until(lambda: (_last(seen, "cx_file") or {}).get("file_kind") == "hooks")
    assert json.loads((task.cwd / ".claude" / "settings.local.json").read_text())["hooks"]["Stop"]
    await hub._handle({"type": "cx_delete", **where, "stamp": saved["stamp"]})
    assert await until(lambda: (_last(seen, "cx_file") or {}).get("deleted"))
    assert not (task.cwd / ".claude" / "agents" / "reviewer.md").exists()
    await hub._handle({"type": "cx_context", "id": task.id})
    assert await until(lambda: _last(seen, "cx_context"))
    context = _last(seen, "cx_context")
    assert context["total"] == 4200 and context["rows"] == [
        {"group": "Agents", "name": "greeter", "source": "", "tokens": 120}
    ]
    await end_all(hub)


def test_its_transcript_notes_have_chinese_in_the_window():
    import re

    from jarvis.server import zh_strings

    zh = zh_strings()
    notes = [code_plugins.INSTALLED.format(name="lint@tools"), code_plugins.REMOVED.format(name="x@y"),
             code_plugins.SWITCHED_ON.format(name="x@y"), code_plugins.SWITCHED_OFF.format(name="x@y"),
             code_plugins.SAVED.format(kind="skill", name="pdf"), code_plugins.DELETED.format(kind="command", name="git/ship"),
             code_plugins.HOOKS_SAVED]  # fmt: skip
    for text in notes:
        assert text in zh["strings"] or any(re.fullmatch(p, text) for p, _ in zh["patterns"]), text
