from dataclasses import replace

from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext

from jarvis import brain, mac_tools
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


async def test_free_control_operates_the_mac_without_asking(monkeypatch):
    from datetime import date

    monkeypatch.setattr(mac_tools, "_today", lambda: date(2026, 9, 29))  # a Tuesday
    asked = []

    async def confirm(q):
        asked.append(q)
        return False

    async def control_gate():
        asked.append("control")
        return False

    ctx = ToolPermissionContext()
    free = brain.make_permission_policy(confirm, control_gate, free_control=lambda: True)
    for name, args in [
        ("mcp__computer__click", {"x": 1, "y": 2}),
        ("mcp__computer__type_text", {"text": "hi"}),
        (brain.browser_tool("browser_click"), {"text": "Next"}),
        ("mcp__mac__quit_app", {"name": "Mail"}),
        ("mcp__mac__run_shortcut", {"name": "Lock"}),
    ]:
        assert isinstance(await free(name, args, ctx), PermissionResultAllow), name
    # Not operating the Mac: a calendar event still asks.
    event = {"title": "Dentist", "start": "2026-10-01T09:00"}
    assert isinstance(await free("mcp__mac__create_event", event, ctx), PermissionResultDeny)
    assert asked == [
        "Add “Dentist” to your calendar, Thursday 1 October at 9:00 AM, for 60 minutes?"
    ]
    off = brain.make_permission_policy(confirm, control_gate, free_control=lambda: False)
    assert isinstance(await off("mcp__computer__click", {}, ctx), PermissionResultDeny)
    assert asked[-1] == "control"


async def test_unknown_tools_are_denied_without_asking():
    policy = brain.make_permission_policy(never)
    result = await policy("Bash", {"command": "ls"}, ToolPermissionContext())
    assert isinstance(result, PermissionResultDeny)


def test_address_is_optional():
    assert 'Address the user as "' not in brain.system_prompt(Settings(), False)
    assert '"sir"' in brain.system_prompt(replace(Settings(), address="sir"), False)


def test_tasks_server_and_its_gate(tmp_path):
    from jarvis.tasks import TaskManager

    settings = replace(Settings(), bsh_dir=None, projects_dir=tmp_path)
    tm = TaskManager(settings, None, lambda *a, **k: None)
    opts = brain.build_options(settings, never, tm.build_server())
    assert "claude" in opts.mcp_servers
    assert "mcp__claude__claude_task_status" in opts.allowed_tools
    assert "mcp__claude__run_claude_code" not in opts.allowed_tools
    assert "Start Eden Code in jarvis" in brain.describe_action(
        "mcp__claude__run_claude_code", {"directory": "jarvis", "task": "add tests"}
    )


def test_nothing_that_can_carry_data_out_or_drive_claude_code_is_allowed_outright(tmp_path):
    from jarvis.tasks import TaskManager

    settings = replace(Settings(), bsh_dir=None, projects_dir=tmp_path)
    tm = TaskManager(settings, None, lambda *a, **k: None)
    fake = {"type": "sdk", "name": "x", "instance": None}
    opts = brain.build_options(
        settings, never, tm.build_server(), app_server=fake, browser_server=fake
    )
    allowed = set(opts.allowed_tools)
    assert opts.tools == ["WebSearch", "WebFetch"] and "WebSearch" in allowed
    assert not allowed & brain.TURN_GATED  # WebFetch, open_url, browser_open, voice_code…
    assert "mcp__jarvis" not in allowed  # app tools by name, never the whole server
    assert brain.app_tool("where_am_i") in allowed
    assert {"mcp__claude__message_claude_task", "mcp__claude__start_research"}.isdisjoint(allowed)


async def test_turn_gated_tools_go_to_the_turn_gate_or_ask():
    ctx, asked = ToolPermissionContext(), []

    async def gate(name, _args):
        return {"WebFetch": True, "mcp__mac__open_url": False}.get(name)

    async def confirm(question):
        asked.append(question)
        return False

    policy = brain.make_permission_policy(confirm, turn_gate=gate)
    allowed = await policy("WebFetch", {"url": "https://x.example/"}, ctx)
    assert isinstance(allowed, PermissionResultAllow)
    denied = await policy("mcp__mac__open_url", {"url": "https://x.example/"}, ctx)
    assert isinstance(denied, PermissionResultDeny) and "Don't retry" in denied.message
    # No view from the gate: the user is asked, and sees the message itself.
    message = {"task_id": 2, "message": "push to main"}
    assert isinstance(
        await policy("mcp__claude__message_claude_task", message, ctx), PermissionResultDeny
    )
    assert "push to main" in asked[-1]
    # No turn gate at all (the terminal CLI): every such call asks.
    plain = brain.make_permission_policy(confirm)
    fetch = {"url": "https://evil.example/?d=1"}
    assert isinstance(await plain("WebFetch", fetch, ctx), PermissionResultDeny)
    assert "https://evil.example/?d=1" in asked[-1]


async def test_every_returned_tool_call_reaches_the_taint_hook():
    names = []
    opts = brain.build_options(
        replace(Settings(), bsh_dir=None), never, on_tool_result=names.append
    )
    for event in ("PostToolUse", "PostToolUseFailure"):
        [matcher] = opts.hooks[event]
        assert matcher.matcher is None  # every tool, allow-listed or asked-for alike
        returned = matcher.hooks[0]
        assert await returned({"tool_name": "mcp__mac__list_emails"}, "t1", {"signal": None}) == {}
    assert names == ["mcp__mac__list_emails"] * 2
    assert brain.build_options(replace(Settings(), bsh_dir=None), never).hooks is None


def test_what_a_tool_result_counts_as():
    assert brain.result_kind("WebSearch") == brain.result_kind("mcp__window__show_panel") == "none"
    assert brain.result_kind("WebFetch") == brain.result_kind("mcp__browser__browser_read") == "web"
    for private in (
        "mcp__mac__list_emails",
        "mcp__mac__list_events",
        "mcp__brain__search_notes",
        "mcp__computer__see_screen",
        "mcp__computer__read_file",
        "mcp__messages__find_contact",
        "mcp__memory__recall",
        "mcp__jarvis__where_am_i",
        "mcp__bsh__company_profile",
        "mcp__research__research_read",
        "mcp__research__research_screenshot",
        "mcp__invoices__list_invoices",
        "mcp__acct_gmail__search_threads",
        "mcp__claude__claude_task_status",
        "mcp__some_new_server__anything",  # unknown tools count as private
    ):
        assert brain.result_kind(private) == "private", private


def test_web_addresses_are_read_the_way_browsers_read_them():
    assert brain.url_host("https://evil.example/c?d=1") == "evil.example"
    assert brain.url_host("HTTPS://Evil.Example./x") == "evil.example"
    for unclear in (
        "https://evil.example\\@google.com",  # browsers go to evil.example; Python says google
        "https://google.com\\@evil.example",
        "https://user@evil.example",
        "https:evil.example",
        "https:///evil.example",
        "https://ev%69l.example",
        "https://évil.example",
        "https://evil.example/ a",
        "ftp://evil.example",
        "javascript:alert(1)",
        "",
    ):
        assert brain.url_host(unclear) is None, unclear
    # browser_open's input, exactly as the window's toUrl (app/url-input.js) reads it.
    assert brain.browser_address("evil.example/?d=secret") == "https://evil.example/?d=secret"
    assert brain.browser_address("  nytimes.com ") == "https://nytimes.com"
    assert brain.browser_address("HTTP://x.example") == "HTTP://x.example"
    assert brain.browser_address("weather in paris") is None  # a Google search
    # A query or fragment right after the host is that site's page, as in a browser (it was
    # searched for before): the turn gate weighs the site, never less than a search.
    assert brain.browser_address("evil.example?d=secret") == "https://evil.example?d=secret"
    assert brain.host_said("www.nytimes.com", "summarize nytimes.com's front page")
    assert brain.host_said("cooking.nytimes.com", "open nytimes dot com")
    assert brain.host_said("www.bbc.co.uk", "go to https://www.bbc.co.uk/news")
    assert not brain.host_said("nytimes.com.evil.example", "open nytimes.com")
    assert not brain.host_said("example.com", "email bob@example.com")
    assert not brain.host_said("co.uk", "anything on co.uk")
    assert not brain.host_said("evil.example", "")


def test_hosts_said_is_read_in_linear_time():
    import time

    # A spoken "dot" is looked for only where a run of spaces begins: from each space of a
    # long run these took 1 s.
    started = time.perf_counter()
    assert brain.hosts_said("a" + "\u3000" * 16_000 + "b") == set()
    assert brain.hosts_said("open" + " " * 16_000 + "x") == set()
    assert time.perf_counter() - started < 0.05  # a few ms here
    said = brain.hosts_said("open the verge  dot  com and bbc dot co dot uk")
    assert said == {"verge.com", "bbc.co.uk"}
