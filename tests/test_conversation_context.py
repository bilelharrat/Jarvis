"""How full JARVIS's conversation is (jarvis.features.conversation): its context (the SDK's
context usage, shaped as Jarvis Code's ring shapes a session's) and cost after every turn and
when the window asks; Compact now (Claude Code's /compact, between requests, nothing said);
and a note in the conversation when it's summed up, by itself or when asked."""

from claude_agent_sdk import AssistantMessage, ResultMessage, SystemMessage, TextBlock
from conftest import FakeClient
from conversation_support import settle

from jarvis.hub import Hub

SID = "0f3c2d1e-aaaa-bbbb-cccc-00000000000c"


class Transcriber:
    def warm_up(self):
        pass


def result(total=0.03):
    return ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id=SID,
        total_cost_usd=total,
        result="",
    )


def boundary(trigger):
    return SystemMessage(
        subtype="compact_boundary",
        data={
            "type": "system",
            "subtype": "compact_boundary",
            "compact_metadata": {"trigger": trigger, "pre_tokens": 150_000},
        },
    )


def make_hub(settings, speaker, isolated, script):
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


REPLY = [AssistantMessage(content=[TextBlock(text="Sure.")], model="m"), result()]


async def test_every_turn_says_how_full_the_conversation_is_and_what_it_cost(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated, REPLY)
    await hub.start()
    await hub.ask("Hello")
    await settle(hub)
    (context,) = emitted(hub, "conversation_context")
    assert context["available"] is True
    assert (context["percent"], context["tokens"], context["max"]) == (42, 83000, 200000)
    assert context["cost"] == 0.03 and context["compacting"] is False
    # The window asks too (the sheet opening).
    await hub._handle({"type": "conversation_context"})
    await settle(hub)
    assert len(emitted(hub, "conversation_context")) == 2


async def test_with_no_connection_the_meter_says_so(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated, REPLY)
    await hub._handle({"type": "conversation_context"})
    await settle(hub)
    (context,) = emitted(hub, "conversation_context")
    assert context == {"available": False, "cost": 0.0, "compacting": False}


async def test_compact_now_sums_the_conversation_up_between_requests_and_says_nothing(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated, REPLY)
    await hub.start()
    await hub.ask("Hello")
    await settle(hub)
    type(hub.client).script = [boundary("manual"), result(total=0.05)]
    turn, history_before = dict(hub.turn), len(hub.history)
    hub.events.clear()
    await hub._handle({"type": "conversation_compact"})
    await settle(hub)
    assert hub.client.queries[-1] == "/compact"
    assert hub.turn == turn  # no reply, nothing said
    assert hub.history[-1]["role"] == "note"
    assert hub.history[-1]["text"] == "Summed up the conversation to make room, as you asked."
    assert len(hub.history) == history_before + 1
    assert emitted(hub, "history")[-1]["items"] == list(hub.history)
    contexts = emitted(hub, "conversation_context")
    assert contexts[0]["compacting"] is True and contexts[-1]["compacting"] is False
    assert hub.conversation.state.cost_of(SID) == 0.05  # what it cost is counted
    assert hub.state == "idle"


async def test_a_summary_made_by_itself_mid_turn_is_noted_where_it_happened(
    settings, quiet_speaker, isolated
):
    script = [
        boundary("auto"),
        AssistantMessage(content=[TextBlock(text="Done.")], model="m"),
        result(),
    ]
    hub = make_hub(settings, quiet_speaker, isolated, script)
    await hub.start()
    await hub.ask("Carry on")
    await settle(hub)
    assert [(h["role"], h["text"]) for h in hub.history] == [
        ("user", "Carry on"),
        ("note", "Summed up the earlier conversation to make room."),
        ("assistant", "Done."),
    ]
    # The window gets the list once the turn is over (mid-turn it shows the turn's own).
    assert emitted(hub, "history")[-1]["items"] == list(hub.history)
    kinds = [k for k, _ in hub.events]
    assert kinds.index("turn_done") < len(kinds) - 1 - kinds[::-1].index("history")


async def test_in_chinese_the_notes_are_chinese(settings, quiet_speaker, isolated):
    isolated["prefs_store"].prefs.language = "zh"
    script = [
        boundary("auto"),
        AssistantMessage(content=[TextBlock(text="好的。")], model="m"),
        result(),
    ]
    hub = make_hub(settings, quiet_speaker, isolated, script)
    await hub.start()
    await hub.ask("继续")
    await settle(hub)
    assert hub.history[1]["text"] == "为了腾出空间，前面的对话已做成摘要。"


async def test_a_compact_that_fails_says_so(settings, quiet_speaker, isolated):
    class Fails(FakeClient):
        script = REPLY

        async def query(self, text):
            if text == "/compact":
                raise RuntimeError("the connection dropped")
            await super().query(text)

    hub = make_hub(settings, quiet_speaker, isolated, REPLY)
    hub.client_factory = Fails
    await hub.start()
    await hub.ask("Hello")
    await settle(hub)
    await hub._handle({"type": "conversation_compact"})
    await settle(hub)
    assert (
        emitted(hub, "toast")[-1]["text"] == "Couldn't make room just now; try again in a moment."
    )
    assert hub.conversation.compacting is False and hub.state == "idle"


async def test_with_nothing_said_yet_there_is_nothing_to_compact(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated, REPLY)
    await hub.start()
    await hub._handle({"type": "conversation_compact"})
    await settle(hub)
    assert hub.client.queries == [] and not emitted(hub, "toast")
