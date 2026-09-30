"""Regression tests from the built-in browser's bug sweep: each proves a bug found, and stays."""

import asyncio

from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext
from test_tasks import manager
from test_turn_gate import answer, started

from jarvis import brain, browser_gate, code_tools
from jarvis.tasks import DENY, ClaudeTask

BROWSER = brain.browser_tool
CTX = ToolPermissionContext()


def tabs_at(hub, pages):
    """The built-in browser with a page in each tab ({tab id or None for the one a call
    lands in unnamed: url}); the reads the gates made, as (action, tab)."""
    reads = []

    async def raw(action, args=None):
        tab = (args or {}).get("tab")
        reads.append((action, tab))
        return {"url": pages[tab], "title": "A page", "text": ""} if action == "read" else {}

    hub._browser_raw = raw
    return reads


# ── the typing gate weighs the tab a press lands in, when the call names one ──


async def test_a_press_in_a_tab_the_call_names_weighs_that_tab(settings, quiet_speaker, isolated):
    """After private reads, a click with no words asks once per site: the site it lands on.
    A call that names another tab lands there, so that tab's site is weighed, not the page
    on show (a site the user named)."""
    hub = await started(
        settings, quiet_speaker, isolated, said="summarize my inbox and check docs.example.com"
    )
    reads = tabs_at(hub, {None: "https://docs.example.com/", 7: "https://forms.evil.example/x"})
    hub.note_tool_result("mcp__mac__list_emails")
    q = hub.subscribe()
    press = {"action": "click", "ref": "e5", "tab": 7}
    pending = asyncio.create_task(hub.turn_gate(BROWSER("browser_act"), press))
    approval = await answer(hub, q, "deny")
    assert await pending is False
    assert approval["question"] == "Use forms.evil.example in the built-in browser?"
    assert ("read", 7) in reads and ("read", None) not in reads
    # The page on show is still the one weighed when no tab is named (a site they named).
    assert await hub.turn_gate(BROWSER("browser_act"), {"action": "click", "ref": "e2"}) is None


async def test_a_send_in_a_tab_the_call_names_meets_that_tab_s_send_card(
    settings, quiet_speaker, isolated
):
    """A Send pressed in another tab is weighed where it lands: Gmail's send card, even
    with the page on show a site that isn't a messaging app."""
    hub = await started(settings, quiet_speaker, isolated, said="look at the news")
    tabs_at(hub, {None: "https://news.example.com/", 4: "https://mail.google.com/mail/u/0/"})
    q = hub.subscribe()
    assert hub.prefs.control_always
    pending = asyncio.create_task(
        hub.turn_gate(BROWSER("browser_click"), {"text": "Send", "tab": 4})
    )
    approval = await answer(hub, q, "deny")
    assert await pending is False
    assert approval["question"] == "Send this in Gmail?"


async def test_a_code_session_s_press_in_a_tab_it_names_weighs_that_tab(settings, tmp_path):
    """A session acts freely only on a page on this Mac. Its own tab on localhost doesn't
    make a click or an Enter it sends to another tab (the owner's mail) a local one."""
    tm, asked, _ = manager(settings, answers=[DENY] * 10)
    task = ClaudeTask(id=1, prompt="build the login page", cwd=tmp_path)
    tm.tasks[1] = task
    pages = {None: "http://localhost:5173/login", 9: "https://mail.example.com/inbox"}

    async def page_url(_task_id, tab=None):
        return pages[tab]

    tm.page_url = page_url
    tm.set_mode(1, "edits")
    policy = tm.policy_for(task)
    act = f"mcp__{code_tools.BROWSER}__browser_act"
    own = await policy(act, {"action": "click", "ref": "e3"}, CTX)
    assert isinstance(own, PermissionResultAllow)  # its own app, unasked
    out = await policy(act, {"action": "click", "ref": "e9", "tab": 9}, CTX)
    assert isinstance(out, PermissionResultDeny)
    assert asked[-1][0] == f"Jarvis Code in {tmp_path.name} wants to click on mail.example.com"
    out = await policy(act, {"action": "press", "key": "Enter", "tab": 9}, CTX)
    assert isinstance(out, PermissionResultDeny)
    assert asked[-1][0].endswith("mail.example.com")


# ── browser_tabs: what op says is where, not words typed into a page ──


def test_a_tabs_call_s_op_carries_no_words():
    for args in ({"op": "list"}, {"op": "switch", "id": 3}, {"op": "close", "id": 3},
                 {"op": "switch", "id": 3, "background": True}):  # fmt: skip
        what = browser_gate.carried(BROWSER("browser_tabs"), args)
        assert what.words == "" and not what.urls and not what.submit, args
    opened = browser_gate.carried(BROWSER("browser_tabs"), {"op": "open", "url": "x.com/a"})
    assert opened.words == "" and opened.urls == ["x.com/a"]


async def test_listing_tabs_after_private_reads_types_nothing(settings, quiet_speaker, isolated):
    """browser_tabs takes op (list, switch, open, close): a list after private reads is no
    typing of the word "list" into the page on show."""
    hub = await started(settings, quiet_speaker, isolated, said="read my notes, then my tabs")
    tabs_at(hub, {None: "https://forms.evil.example/contact"})
    hub.note_tool_result("mcp__brain__read_note")
    q = hub.subscribe()
    pending = asyncio.create_task(hub.turn_gate(BROWSER("browser_tabs"), {"op": "list"}))
    approval = await answer(hub, q, "allow")
    assert await pending is True
    assert not approval["question"].startswith("Type into"), approval["question"]
    assert "What I'd type" not in approval["detail"]
