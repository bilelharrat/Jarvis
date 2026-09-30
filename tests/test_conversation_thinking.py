"""Thinking in JARVIS's conversation (jarvis.features.conversation): a Settings level for
everyday turns (off by default, for speed), and "think hard about…", "take your time" (and
their Chinese) for one request. The SDK can't turn thinking on for one query, so that
request's connection is made again with thinking, carrying the conversation on, and made
again without it once the request is answered."""

from types import SimpleNamespace

from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
from conftest import FakeClient
from conversation_support import settle

from jarvis.features.conversation import asks_for_thought
from jarvis.hub import Hub

SID = "0f3c2d1e-aaaa-bbbb-cccc-00000000000d"


class Transcriber:
    def warm_up(self):
        pass


def result():
    return ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id=SID,
        total_cost_usd=0.02,
        result="",
    )


REPLY = [AssistantMessage(content=[TextBlock(text="Sure.")], model="m"), result()]


def make_hub(settings, speaker, isolated):
    """A hub whose every connection is kept in made, in order."""
    made = []

    class Client(FakeClient):
        script = REPLY

        def __init__(self, options=None):
            super().__init__(options)
            made.append(self)

    hub = Hub(
        settings,
        client_factory=Client,
        speaker=speaker,
        transcriber=Transcriber(),
        poll=False,
        **isolated,
    )
    events, spoken = [], []
    hub.emit = lambda kind, **data: events.append((kind, data))
    hub.events = events
    hub._speak = spoken.append
    hub.spoken = spoken
    return hub, made


def emitted(hub, kind):
    return [data for k, data in hub.events if k == kind]


def thinks(client):
    return (client.options.thinking, client.options.effort)


def test_only_the_owners_words_asking_for_thought_count():
    for text in [
        "Think hard about how to plan my week",
        "Please think carefully about this offer",
        "Okay, take your time and compare the two leases",
        "Compare the two leases, and take your time",
        "Think it through: should I take the job?",
        "Could you give it some real thought?",
        "No rush. Which of these flights is best?",
        "ultrathink",
    ]:
        assert asks_for_thought(text, "en"), text
    for text in [
        "I think it's hard to say",
        "What do you think?",
        "Think of a number",
        "Is there no rush hour traffic today?",
        "It took some time to get here",
    ]:
        assert not asks_for_thought(text, "en"), text
    for text in ["好好想想我这周怎么安排", "请仔细考虑一下这个报价", "慢慢来，比较一下这两个方案"]:
        assert asks_for_thought(text, "zh"), text
        assert not asks_for_thought(text, "en"), text  # Chinese only when it's spoken
    for text in ["我觉得这很难", "你怎么想？", "我不着急"]:
        assert not asks_for_thought(text, "zh"), text


async def test_everyday_turns_think_at_the_settings_level(settings, quiet_speaker, isolated):
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    assert thinks(made[-1]) == ({"type": "disabled"}, settings.effort)  # off: the fastest
    await hub.ask("Hello")
    await settle(hub)
    await hub._handle({"type": "conversation_thinking", "level": "medium"})
    await settle(hub)
    assert len(made) == 2
    assert thinks(made[-1]) == ({"type": "adaptive"}, "medium")
    assert made[-1].options.resume == SID  # the same conversation, carried on
    assert hub.prefs.feature("conversation_thinking") == "medium"
    assert emitted(hub, "conversation")[-1]["thinking"] == "medium"
    await hub._handle({"type": "conversation_thinking", "level": "loud"})  # not a level
    await settle(hub)
    assert len(made) == 2
    await hub.ask("And now?")
    await settle(hub)
    assert made[-1].said == ["And now?"] and len(made) == 2  # every turn at that level
    await hub._handle({"type": "conversation_thinking", "level": "off"})
    await settle(hub)
    assert thinks(made[-1]) == ({"type": "disabled"}, settings.effort)


async def test_think_hard_thinks_for_that_request_then_goes_back(settings, quiet_speaker, isolated):
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("Hello")
    await settle(hub)
    await hub.ask("Think hard about how to plan my week")
    await settle(hub)
    everyday, hard, back = made
    assert everyday.said == ["Hello"]
    # The request went to a connection made for it, carrying the conversation on.
    assert hard.said == ["Think hard about how to plan my week"]
    assert thinks(hard) == ({"type": "adaptive"}, "high") and hard.options.resume == SID
    assert "Let me think that through." in hub.spoken
    states = [c["thinking_hard"] for c in emitted(hub, "conversation")]
    assert True in states and states[-1] is False
    # Once it's answered, the everyday connection again, still the same conversation.
    assert thinks(back) == ({"type": "disabled"}, settings.effort) and back.options.resume == SID
    assert hub.client is back
    assert emitted(hub, "conversation_context")  # how full it is, asked of the new one
    await hub.ask("Thanks")
    await settle(hub)
    assert back.said == ["Thanks"] and len(made) == 3


async def test_thinking_hard_on_a_high_everyday_level_is_the_most_there_is(
    settings, quiet_speaker, isolated
):
    isolated["prefs_store"].prefs.features = {"conversation_thinking": "high"}
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    assert thinks(made[-1]) == ({"type": "adaptive"}, "high")
    await hub.ask("Take your time: which of these two offers is better?")
    await settle(hub)
    assert thinks(made[1]) == ({"type": "adaptive"}, "max")
    assert thinks(made[-1]) == ({"type": "adaptive"}, "high")


async def test_in_chinese_the_chinese_words_ask_for_it(settings, quiet_speaker, isolated):
    isolated["prefs_store"].prefs.language = "zh"
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("好好想想我这周怎么安排")
    await settle(hub)
    assert thinks(made[1]) == ({"type": "adaptive"}, "high")
    assert "让我好好想想。" in hub.spoken


async def test_a_routines_request_never_thinks_hard(settings, quiet_speaker, isolated):
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("Think hard about the markets today", display="Routine: markets")
    await settle(hub)
    assert len(made) == 1 and thinks(made[0]) == ({"type": "disabled"}, settings.effort)


async def test_the_first_request_thinking_hard_keeps_what_it_read(
    settings, quiet_speaker, isolated
):
    """Before its first reply a conversation has no session to carry on: the connection
    made for thinking starts it, and what the request read still counts for the gates."""
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("Think hard about this contract", untrusted="the file you sent")
    await settle(hub)
    assert len(made) == 3 and made[1].options.resume is None
    assert hub._session_reads["private"] is True
    assert "the file you sent" in hub._session_reads["what"]
    assert hub.conversation.state.reads_of(SID)["private"] is True


async def test_never_on_the_fallback_model(settings, quiet_speaker, isolated):
    isolated["prefs_store"].prefs.features = {"conversation_thinking": "high"}
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    hub._connected_ref = "gemini:flash"  # the conversation runs on the fallback now
    await hub.conversation._think("Think hard about it")
    assert len(made) == 1 and hub.conversation.public()["thinking_hard"] is False
    options = SimpleNamespace(thinking={"type": "disabled"}, effort="low")
    hub.conversation._apply_thinking(options)
    assert (options.thinking, options.effort) == ({"type": "disabled"}, "low")
