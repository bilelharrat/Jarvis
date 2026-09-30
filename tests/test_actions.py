"""What JARVIS did (jarvis.features.actions): every tool call of its conversation logged from
the stream, per day, with words that say nothing private and how it went; nothing while
incognito; what_did_you_do reads it back; the Activity drawer's History tab searches it."""

import asyncio
from datetime import date, timedelta

from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from conftest import FakeClient

from jarvis import action_log
from jarvis.features import actions
from jarvis.features.actions import parse_day
from jarvis.hub import Hub, tool_label


class Transcriber:
    def warm_up(self):
        pass


def call(tid, name, args):
    return AssistantMessage(content=[ToolUseBlock(id=tid, name=name, input=args)], model="m")


def returned(tid, error=False):
    return UserMessage(content=[ToolResultBlock(tool_use_id=tid, content="ok", is_error=error)])


def result():
    return ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id="s",
        total_cost_usd=0.01,
        result="",
    )


SCRIPT = [
    call("t1", "mcp__mac__open_app", {"name": "Safari"}),
    returned("t1"),
    call("t2", "mcp__messages__send_message", {"to": "Ann Lee", "text": "the code is 1234"}),
    returned("t2", error=True),
    call("t3", "WebFetch", {"url": "https://www.nytimes.com/2026/a?token=abc"}),  # no result
    AssistantMessage(content=[TextBlock(text="Done.")], model="m"),
    result(),
]


def make_hub(settings, speaker, isolated, script=SCRIPT):
    class Client(FakeClient):
        pass

    Client.script = script
    hub = Hub(
        settings,
        client_factory=Client,
        speaker=speaker,
        transcriber=Transcriber(),
        poll=False,
        **isolated,
    )
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    hub.events = events
    return hub


def emitted(hub, kind):
    return [data for k, data in hub.events if k == kind]


async def settle(hub):
    await asyncio.sleep(0)
    await asyncio.wait_for(hub.actions.flush(), 60)


def entry(t, tool="open_app", label="Opened an app", summary="Safari", outcome="done"):
    return {"t": t, "tool": tool, "label": label, "summary": summary, "outcome": outcome}


async def test_every_call_is_logged_with_safe_words_and_how_it_went(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("Open Safari, text Ann and read the Times")
    await settle(hub)
    kept = hub.actions.log.day(date.today())
    assert [(e["tool"], e["label"], e["summary"], e["outcome"]) for e in kept] == [
        ("open_app", tool_label("mcp__mac__open_app"), "Safari", "done"),
        ("send_message", tool_label("mcp__messages__send_message"), "", "failed"),
        ("WebFetch", tool_label("WebFetch"), "nytimes.com", "stopped"),  # never came back
    ]
    # Beside prefs.json, the owner's alone, and nothing a message said, nor who to.
    (day_file,) = (tmp_path / "action_log").iterdir()
    raw = day_file.read_text()
    assert "1234" not in raw and "Ann" not in raw and "token" not in raw


async def test_nothing_is_logged_while_incognito(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    hub.incognito = True
    await hub.ask("Open Safari")
    await settle(hub)
    assert hub.actions.log.days() == []
    hub.incognito = False
    await hub.ask("Open Safari")
    await settle(hub)
    assert len(hub.actions.log.day(date.today())) == 3


async def test_old_days_go_once_a_day(settings, quiet_speaker, isolated, monkeypatch):
    hub = make_hub(settings, quiet_speaker, isolated)
    old = date.today() - timedelta(days=action_log.LOG_DAYS + 3)
    hub.actions.log.add([entry(f"{old.isoformat()}T09:00:00")])
    pruned = []
    real = action_log.ActionLog.prune
    monkeypatch.setattr(action_log.ActionLog, "prune", lambda self: pruned.append(1) or real(self))
    await hub.start()
    await hub.ask("Open Safari")
    await settle(hub)
    await hub.ask("Open Safari again")
    await settle(hub)
    assert pruned == [1] and old not in hub.actions.log.days()


async def test_the_history_tab_searches_newest_first_and_pages_back(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.setattr(actions, "PAGE", 2)
    hub = make_hub(settings, quiet_speaker, isolated)
    today = date.today().isoformat()
    hub.actions.log.add(
        [
            entry(f"{today}T08:00:00"),
            entry(
                f"{today}T09:00:00", tool="weather_report", label="Checked the weather", summary=""
            ),
            entry(f"{today}T10:00:00", summary="Notes"),
            entry(f"{today}T11:00:00"),
        ]
    )
    await hub._handle({"type": "action_log", "q": "opened", "seq": "4"})
    await settle(hub)
    (page,) = emitted(hub, "action_log")
    assert [e["t"][11:] for e in page["items"]] == ["11:00:00", "10:00:00"]
    assert page["more"] is True and page["seq"] == "4" and page["q"] == "opened"
    await hub._handle({"type": "action_log", "q": "opened", "before": page["items"][-1]["t"]})
    await settle(hub)
    more = emitted(hub, "action_log")[-1]
    assert [e["t"][11:] for e in more["items"]] == ["08:00:00"] and more["more"] is False
    await hub._handle({"type": "action_log", "q": "", "before": "not a time"})
    await settle(hub)
    assert emitted(hub, "action_log")[-1]["before"] == ""


async def test_what_did_you_do_reads_a_day_back(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert "actions" in hub._extra_servers and "what_did_you_do" in hub._feature_prompt()
    what, _undo = hub.actions.tools()
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    hub.actions.log.add(
        [
            entry(f"{yesterday}T08:15:00"),
            entry(
                f"{yesterday}T09:30:00",
                tool="send_email",
                label="Sent an email",
                summary="",
                outcome="failed",
            ),
            entry(f"{date.today().isoformat()}T07:00:00", summary="Mail"),
        ]
    )
    out = await what.handler({"day": "yesterday"})
    text = out["content"][0]["text"]
    lines = text.splitlines()
    assert lines[0].startswith("What you did on ") and "oldest first" in lines[0]
    assert lines[1:] == ["08:15 Opened an app (Safari)", "09:30 Sent an email — failed"]
    out = await what.handler({"query": "opened"})  # every day, newest first
    lines = out["content"][0]["text"].splitlines()
    assert "newest first" in lines[0] and lines[1].endswith("07:00 Opened an app (Mail)")
    assert lines[2].endswith("08:15 Opened an app (Safari)")
    out = await what.handler({"day": "last Christmas"})
    assert out.get("is_error") is True
    long_ago = (date.today() - timedelta(days=action_log.LOG_DAYS + 5)).isoformat()
    out = await what.handler({"day": long_ago})
    assert f"keeps {action_log.LOG_DAYS} days" in out["content"][0]["text"]
    out = await what.handler({"day": "today", "query": "weather"})
    assert out["content"][0]["text"].startswith("Nothing in your action log matches “weather”")


def test_days_as_they_are_said():
    wednesday = date(2026, 9, 30)
    assert parse_day("", wednesday) == wednesday
    assert parse_day("Today", wednesday) == wednesday
    assert parse_day("yesterday", wednesday) == date(2026, 9, 29)
    assert parse_day("the day before yesterday", wednesday) == date(2026, 9, 28)
    assert parse_day("Monday", wednesday) == date(2026, 9, 28)
    assert parse_day("on wednesday", wednesday) == wednesday
    assert parse_day("last Thursday", wednesday) == date(2026, 9, 24)
    assert parse_day("2026-09-01", wednesday) == date(2026, 9, 1)
    assert parse_day("昨天", wednesday) == date(2026, 9, 29)
    assert parse_day("前天", wednesday) == date(2026, 9, 28)
    assert parse_day("周一", wednesday) == date(2026, 9, 28)
    assert parse_day("星期天", wednesday) == date(2026, 9, 27)
    for bad in ["2026-13-01", "next week", "soon"]:
        assert parse_day(bad, wednesday) is None, bad
