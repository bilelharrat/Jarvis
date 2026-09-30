"""An incognito conversation (jarvis.features.conversation): nothing from it is kept. Claude
Code writes no record of it (so no past conversation, no recall, no resume); JARVIS
remembers and forgets nothing in it, learns nothing from the words said in it, and doesn't
keep it as the conversation to carry on. Leaving it carries on the conversation from before.
Claude Code's records are fakes: never the owner's ~/.claude."""

from types import SimpleNamespace

from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
from conftest import FakeClient
from conversation_support import settle

from jarvis.hub import Hub

NORMAL = "0f3c2d1e-aaaa-bbbb-cccc-0000000000a1"
SECRET = "0f3c2d1e-aaaa-bbbb-cccc-0000000000b2"
MEMORY_WRITES = {"mcp__memory__remember", "mcp__memory__forget"}


class Transcriber:
    def warm_up(self):
        pass


def result(sid):
    return ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id=sid,
        total_cost_usd=0.02,
        result="",
    )


def reply(sid, text="Sure."):
    return [AssistantMessage(content=[TextBlock(text=text)], model="m"), result(sid)]


def make_hub(settings, speaker, isolated):
    """A hub whose every connection is kept in made; an incognito one answers as SECRET."""
    made = []

    class Client(FakeClient):
        def __init__(self, options=None):
            super().__init__(options)
            made.append(self)
            incognito = "no-session-persistence" in (options.extra_args or {})
            self.script = reply(SECRET if incognito else NORMAL)

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
    convo = hub.conversation
    convo.get_info = lambda sid, directory=None: (
        SimpleNamespace(session_id=sid, first_prompt="Hello", last_modified=1_700_000_000_000)
        if sid == NORMAL
        else None
    )
    convo.get_messages = lambda sid, directory=None: []
    return hub, made


def emitted(hub, kind):
    return [data for k, data in hub.events if k == kind]


def incognito(client):
    options = client.options
    return "no-session-persistence" in (options.extra_args or {})


async def go_incognito(hub, on=True):
    await hub._handle({"type": "conversation_incognito", "on": on})
    await settle(hub)


async def test_nothing_from_an_incognito_conversation_is_kept(settings, quiet_speaker, isolated):
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("Hello")
    await settle(hub)
    assert hub.conversation.state.current == NORMAL
    await go_incognito(hub)
    assert hub.incognito is True
    secret = made[-1]
    # Claude Code keeps no record of it, and nothing earlier is carried into it.
    assert incognito(secret) and secret.options.resume is None
    # It can't remember or forget anything, and it's told why.
    assert MEMORY_WRITES <= set(secret.options.disallowed_tools)
    assert "incognito" in secret.options.system_prompt
    assert emitted(hub, "conversation")[-1]["incognito"] is True
    await hub.ask("Remind me what Dr Okafor said about sleep")
    await settle(hub)
    assert secret.said == ["Remind me what Dr Okafor said about sleep"]
    # Nothing of it in what's kept: not the conversation to carry on, not its reads, cost
    # or title; not a word learned from it; not a request noted for suggestions.
    state = hub.conversation.state
    assert state.current == NORMAL and SECRET not in state.sessions
    assert state.titles().get(NORMAL) == "Hello"
    assert "okafor" not in hub.hearing.words
    assert not any("Okafor" in h["t"] for h in hub.suggester.history)
    # The meter still says what it has cost so far, from memory.
    assert emitted(hub, "conversation_context")[-1]["cost"] == 0.02
    # Out of it, the same words are learned as ever.
    await go_incognito(hub, on=False)
    await hub.ask("Remind me what Dr Okafor said about sleep")
    await settle(hub)
    assert "okafor" in hub.hearing.words
    assert any("Okafor" in h["t"] for h in hub.suggester.history)


async def test_leaving_carries_the_conversation_from_before_on(settings, quiet_speaker, isolated):
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    hub._note_read("private", "Read your inbox")
    await hub.ask("Hello")
    await settle(hub)
    before = [(h["role"], h["text"]) for h in hub.history]
    await go_incognito(hub)
    lines = [(h["role"], h["text"]) for h in hub.history]
    assert lines == [("note", "Incognito: nothing from here on is kept.")]
    await hub.ask("Something private")
    await settle(hub)
    await go_incognito(hub, on=False)
    assert hub.incognito is False
    back = made[-1]
    assert not incognito(back) and back.options.resume == NORMAL
    assert hub._session_id == NORMAL
    assert hub._session_reads["private"] is True  # what it had read still counts
    lines = [(h["role"], h["text"]) for h in hub.history]
    assert lines == [
        *before,
        ("note", "Back to your conversation. Nothing from the incognito one was kept."),
    ]
    assert emitted(hub, "history")[-1]["items"] == list(hub.history)
    assert emitted(hub, "conversation")[-1]["incognito"] is False
    await hub.ask("Where were we?")
    await settle(hub)
    assert back.said == ["Where were we?"]


async def test_leaving_when_the_conversation_before_is_gone_starts_afresh(
    settings, quiet_speaker, isolated
):
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await go_incognito(hub)  # nothing said before it
    await go_incognito(hub, on=False)
    assert not incognito(made[-1]) and made[-1].options.resume is None
    assert hub.incognito is False


async def test_by_voice_in_english_and_chinese(settings, quiet_speaker, isolated):
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("Hello")
    await settle(hub)
    said = await hub.ask("Jarvis, go incognito")
    await settle(hub)
    assert hub.incognito is True and incognito(made[-1])
    assert said == "Incognito: nothing from this conversation is kept."
    said = await hub.ask("Leave incognito mode")
    await settle(hub)
    assert hub.incognito is False and not incognito(made[-1])
    assert said == "Back to your conversation. Nothing from the incognito one was kept."
    # Words about incognito that don't ask for it go to Claude.
    await hub.ask("What does incognito mode do in Safari?")
    await settle(hub)
    assert hub.incognito is False
    assert made[-1].said[-1] == "What does incognito mode do in Safari?"
    hub.prefs.language = "zh"
    said = await hub.ask("开启无痕模式")
    await settle(hub)
    assert hub.incognito is True and said == "无痕模式：这段对话的内容一概不保留。"
    await hub.ask("退出无痕模式")
    await settle(hub)
    assert hub.incognito is False


async def test_a_reconnect_while_incognito_starts_afresh_and_claude_hears_why(
    settings, quiet_speaker, isolated
):
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await go_incognito(hub)
    await hub.ask("Something private")
    await settle(hub)
    assert hub._session_id == SECRET
    await hub._reconnect()  # a service connected, the fallback model's time is up…
    again = made[-1]
    assert incognito(again) and again.options.resume is None  # nothing to resume
    assert "incognito" in hub._style_note


async def test_nothing_is_carried_on_or_reconnected_while_incognito(
    settings, quiet_speaker, isolated
):
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("Hello")
    await settle(hub)
    await go_incognito(hub)
    count = len(made)
    # A past conversation isn't carried on while incognito: no card, it says why.
    await hub._handle({"type": "conversation_resume", "session_id": NORMAL})
    await settle(hub)
    assert not hub.approvals and len(made) == count
    toast = emitted(hub, "toast")[-1]["text"]
    assert toast == "Leave incognito to carry on a past conversation."
    # Thinking hard would reconnect (and so lose it): it answers as it is.
    await hub.ask("Think hard about this")
    await settle(hub)
    assert len(made) == count
    # A new thinking level is kept, for after it.
    await hub._handle({"type": "conversation_thinking", "level": "high"})
    await settle(hub)
    assert hub.prefs.feature("conversation_thinking") == "high" and len(made) == count


async def test_new_conversation_while_incognito_stays_incognito(settings, quiet_speaker, isolated):
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("Hello")
    await settle(hub)
    await go_incognito(hub)
    await hub.reset()
    await settle(hub)
    assert hub.incognito is True and incognito(made[-1])
    assert hub.conversation.state.current == NORMAL  # still the one to carry on


async def test_a_restart_while_incognito_carries_on_the_conversation_from_before(
    settings, quiet_speaker, isolated
):
    hub, _made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("Hello")
    await settle(hub)
    await go_incognito(hub)
    await hub.ask("Something private")
    await settle(hub)
    await hub.close()
    again, made = make_hub(settings, quiet_speaker, isolated)
    await again.start()
    assert again.incognito is False
    assert made[-1].options.resume == NORMAL and not incognito(made[-1])


async def test_a_transcript_fixed_in_the_window_teaches_nothing_while_incognito(
    settings, quiet_speaker, isolated
):
    hub, _made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await go_incognito(hub)
    learned = []
    hub.hearing.learn_edit = lambda original, edited: learned.append((original, edited))
    await hub._handle({"type": "heard_edit", "original": "call oaken", "edited": "call Okin"})
    assert learned == []
    await go_incognito(hub, on=False)
    await hub._handle({"type": "heard_edit", "original": "call oaken", "edited": "call Okin"})
    assert learned == [("call oaken", "call Okin")]


async def test_when_it_cant_start_the_conversation_before_goes_on(
    settings, quiet_speaker, isolated
):
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("Hello")
    await settle(hub)
    real = hub.client_factory

    def factory(options=None):
        if "no-session-persistence" in (options.extra_args or {}):
            raise RuntimeError("Claude Code didn't start")
        return real(options=options)

    hub.client_factory = factory
    await go_incognito(hub)
    assert hub.incognito is False
    assert (
        emitted(hub, "toast")[-1]["text"]
        == "Couldn't go incognito just now; try again in a moment."
    )
    assert made[-1].options.resume == NORMAL and hub._session_id == NORMAL
    assert emitted(hub, "conversation")[-1]["incognito"] is False


def long_turn(sid, steps=6):
    """A request that ran `steps` tools (a skill-sized one), then answered."""
    from claude_agent_sdk import ToolResultBlock, ToolUseBlock, UserMessage

    messages = []
    for n in range(steps):
        call = ToolUseBlock(id=f"t{n}", name="mcp__mac__list_events", input={})
        messages.append(AssistantMessage(content=[call], model="m"))
        done = ToolResultBlock(tool_use_id=f"t{n}", content="ok", is_error=False)
        messages.append(UserMessage(content=[done]))
    return messages + reply(sid, "Done.")


async def test_what_it_did_while_incognito_is_never_weighed_as_a_skill(
    settings, quiet_speaker, isolated
):
    """The Skill Workshop hears finished requests (a turn sink) and keeps long ones to
    offer as skills, the owner's request and all: never one made while incognito."""
    hub, made = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    heard = []
    hub.add_turn_sink(lambda turn: heard.append(turn["request"]))
    await go_incognito(hub)
    made[-1].script = long_turn(SECRET)
    await hub.ask("Plan my week around Dr Okafor's appointments")
    await settle(hub)
    assert heard == []
    assert not any("Okafor" in t.get("request", "") for t in hub.skills.workshop.recent)
    await go_incognito(hub, on=False)
    made[-1].script = long_turn(NORMAL)
    await hub.ask("Plan my week around the team offsite")
    await settle(hub)
    assert heard == ["Plan my week around the team offsite"]
    assert [t["request"] for t in hub.skills.workshop.recent] == heard
