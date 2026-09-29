from dataclasses import replace

from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext

from jarvis import brain
from jarvis.config import Settings


async def never(_question):
    raise AssertionError("should not ask")


def test_options_lock_down_builtin_tools(tmp_path):
    opts = brain.build_options(replace(Settings(), bsh_dir=tmp_path), never)
    assert opts.tools == ["WebSearch", "WebFetch"]
    assert "Bash" in opts.disallowed_tools and "Write" in opts.disallowed_tools
    assert opts.strict_mcp_config and opts.setting_sources == []
    assert "mcp__mac__create_event" not in opts.allowed_tools
    assert "mcp__mac__run_shortcut" not in opts.allowed_tools
    assert "mcp__mac__list_events" in opts.allowed_tools


def test_bsh_server_only_when_checkout_exists(tmp_path):
    missing = brain.build_options(replace(Settings(), bsh_dir=tmp_path), never)
    assert "bsh" not in missing.mcp_servers
    assert "mcp__bsh" not in missing.allowed_tools

    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "bsh_mcp.py").write_text("")
    present = brain.build_options(replace(Settings(), bsh_dir=tmp_path), never)
    assert present.mcp_servers["bsh"]["args"][2] == str(tmp_path)
    assert "mcp__bsh" in present.allowed_tools
    assert "research desk" in present.system_prompt

    off = brain.build_options(replace(Settings(), bsh_dir=None), never)
    assert "bsh" not in off.mcp_servers


async def test_confirmable_tools_ask_and_respect_the_answer():
    questions = []

    async def answer(value):
        async def confirm(q):
            questions.append(q)
            return value

        return confirm

    ctx = ToolPermissionContext()
    event = {"title": "Dentist", "start": "2026-10-01T09:00", "location": "Main St"}
    yes = brain.make_permission_policy(await answer(True))
    assert isinstance(await yes("mcp__mac__create_event", event, ctx), PermissionResultAllow)
    assert "Dentist" in questions[0] and "Main St" in questions[0]

    no = brain.make_permission_policy(await answer(False))
    denied = await no("mcp__mac__run_shortcut", {"name": "Lock"}, ctx)
    assert isinstance(denied, PermissionResultDeny)


async def test_unknown_tools_are_denied_without_asking():
    policy = brain.make_permission_policy(never)
    result = await policy("Bash", {"command": "ls"}, ToolPermissionContext())
    assert isinstance(result, PermissionResultDeny)


def test_address_is_optional():
    assert "Address the user" not in brain.system_prompt(Settings(), False)
    assert '"sir"' in brain.system_prompt(replace(Settings(), address="sir"), False)


def test_tasks_server_and_its_gate(tmp_path):
    from jarvis.tasks import TaskManager

    settings = replace(Settings(), bsh_dir=None, projects_dir=tmp_path)
    tm = TaskManager(settings, None, lambda *a, **k: None)
    opts = brain.build_options(settings, never, tm.build_server())
    assert "claude" in opts.mcp_servers
    assert "mcp__claude__claude_task_status" in opts.allowed_tools
    assert "mcp__claude__run_claude_code" not in opts.allowed_tools
    assert "Start Claude Code in jarvis" in brain.describe_action(
        "mcp__claude__run_claude_code", {"directory": "jarvis", "task": "add tests"}
    )
