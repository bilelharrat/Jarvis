"""The owner's agents (jarvis.agents, jarvis.features.agents): kept and tidied, picked by the
owner's words, a persona's wake word or a chat's route, each with its own memory, persona
and conversation, and only its own tools (taken out of its conversation, and refused by a
hook all the same). With no agent made, nothing changes. All on a fake Claude."""

import asyncio
import json

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
from conftest import FakeClient

from jarvis import agents, lang, wake
from jarvis.agents import MAIN, AgentStore
from jarvis.features import agents as agents_feature
from jarvis.hub import Hub


def done(sid: str, text: str = "Done.") -> list:
    return [
        AssistantMessage(content=[TextBlock(text=text)], model="m"),
        ResultMessage(
            subtype="success",
            duration_ms=1,
            duration_api_ms=1,
            is_error=False,
            num_turns=1,
            session_id=sid,
            total_cost_usd=0.01,
            result=text,
        ),  # fmt: skip
    ]


WORK = {"name": "Work Jarvis", "persona": "friday", "servers": ["mail", "claude"],
        "routes": [{"channel": "slack", "place": "T-ACME"}]}  # fmt: skip
FAMILY = {"name": "Family Jarvis", "persona": "tars", "zh_name": "家庭助手",
          "servers": ["calendar", "messages"], "routes": [{"channel": "imessage"}]}  # fmt: skip


# ── the store ──


def test_agents_are_tidied_kept_and_read_back(tmp_path):
    store = AgentStore(tmp_path / "agents.json")
    assert store.items == [] and store.active == MAIN and store.current() is None
    work = store.put({**WORK, "servers": ["mail", "mail", "bad name!", "claude"], "routes": [
        {"channel": "slack", "place": "  T-ACME "}, {"channel": "fax"}, {"channel": "slack", "place": "T-ACME"}]})  # fmt: skip
    assert work.id == "work" and work.servers == ["claude", "mail"]
    assert [(r.channel, r.place) for r in work.routes] == [("slack", "T-ACME")]
    family = store.put(FAMILY)
    assert family.id == "family" and family.zh_name == "家庭助手"
    with pytest.raises(ValueError, match="Another agent has that name"):
        store.put({"name": "work jarvis"})
    with pytest.raises(ValueError, match="Give the agent a name"):
        store.put({"name": "  "})
    store.use("work", "jarvis")
    again = AgentStore(tmp_path / "agents.json")
    assert [a.id for a in again.items] == ["work", "family"]
    assert again.active == "work" and again.main_persona == "jarvis"
    again.remove("work")  # the one in use: back to the everyday JARVIS
    assert AgentStore(tmp_path / "agents.json").active == MAIN


def test_a_damaged_or_odd_file_never_stops_it(tmp_path):
    path = tmp_path / "agents.json"
    path.write_text(json.dumps({"agents": [{"id": "main", "name": "x"}, {"id": "Bad!", "name": "y"},
                                           {"id": "ok", "name": "Ok", "persona": "friday"}, 7],
                                "active": "nobody"}))  # fmt: skip
    store = AgentStore(path)
    assert [a.id for a in store.items] == ["ok"] and store.active == MAIN
    path.write_text("{not json")
    assert AgentStore(path).items == []


def test_room_for_so_many(tmp_path):
    store = AgentStore(tmp_path / "agents.json")
    for n in range(agents.MAX_AGENTS):
        store.put({"name": f"Agent {n}"})
    with pytest.raises(ValueError, match="room for"):
        store.put({"name": "One more"})
    assert (
        agents.make_id("Jarvis", set()) == "jarvis" and agents.make_id("工作", set()) == "agent-1"
    )


# ── routing ──


def make_items():
    return [
        agents.agent_from({**WORK, "id": "work"}),
        agents.agent_from({**FAMILY, "id": "family"}),
    ]


def test_a_chats_route_picks_the_best_match():
    items = make_items()
    assert agents.best_route(items, {"channel": "slack", "team": "T-ACME", "chat": "C1"}) == "work"
    assert agents.best_route(items, {"channel": "slack", "team": "T-OTHER"}) is None
    assert agents.best_route(items, {"channel": "imessage", "chat": "+1555"}) == "family"
    items[0].routes.append(agents.Route("imessage", "family-chat"))  # a chat named beats the app
    assert agents.best_route(items, {"channel": "imessage", "chat": "Family-Chat"}) == "work"
    assert agents.best_route(items, {}) is None and agents.best_route(items, None) is None


def test_a_personas_name_called_picks_its_agent_but_jarvis_never_switches():
    items = make_items()
    assert agents.called("Friday, what's on today?", items, "jarvis") == "work"
    assert agents.called("hey Fryday what's on", items, "jarvis") == "work"  # as Whisper hears it
    assert agents.called("TARS, call mum", items, "jarvis") == "family"
    assert agents.called("Jarvis, what's on today?", items, "jarvis") is None
    assert agents.called("What's on Friday, Jarvis?", items, "jarvis") is None  # not a call
    assert agents.called("星期五，今天有什么安排", items, "jarvis") == "work"
    # The everyday JARVIS on FRIDAY too: the name is shared, so it picks neither.
    assert agents.called("Friday, hello", items, "friday") is None
    assert set(agents.wake_words(items, "jarvis")) == {"Friday", "星期五", "TARS", "塔斯"}


@pytest.mark.parametrize(
    "said, picked",
    [
        ("switch to work", "work"),
        ("Switch to Work Jarvis.", "work"),
        ("please switch over to the family agent", "family"),
        ("talk to family", "family"),
        ("switch to Friday", "work"),  # its persona's name
        ("go back to Jarvis", MAIN),
        ("switch back to the default", MAIN),
        ("切换到家庭助手", "family"),
        ("切换到贾维斯", MAIN),
        ("switch to dark mode", None),
        ("go to work", None),
        ("use Sonnet", None),
        ("what is work like?", None),
    ],
)
def test_the_owners_words_switch(said, picked):
    assert agents.asked_for(said, make_items(), "jarvis") == picked


def test_no_agents_no_switching():
    assert agents.asked_for("switch to work", [], "jarvis") is None


# ── on the hub ──


@pytest.fixture
def make_hub(settings, quiet_speaker, isolated):
    def make():
        return Hub(
            settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated
        )

    yield make
    FakeClient.script = []
    wake.add_names("agents", None)


async def saved(hub, raw):
    await hub.agents.save({"agent": raw})
    return hub.agents.store().get(agents.make_id(raw["name"], set()))


async def test_with_no_agent_nothing_changes(make_hub):
    hub = make_hub()
    await hub.start()
    options = hub.client.options
    assert "memory" in options.mcp_servers and "mail" in options.mcp_servers
    assert "one of their agents" not in options.system_prompt
    assert await hub.agents.instant("switch to work") is None
    FakeClient.script = done("s1")
    assert await hub.ask("switch to work") == "Done."  # Claude's to answer: no agent called work


async def test_an_agent_gets_only_its_tools_its_persona_and_its_memory(make_hub):
    hub = make_hub()
    await hub.start()
    FakeClient.script = done("main-1")
    await hub.ask("hello")
    hub.memory.add("The owner's daughter is Mia.", source="said")  # shared, from before agents
    await saved(hub, WORK)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    FakeClient.script = done("never")
    assert await hub.ask("switch to work") == "Switched to Work Jarvis."
    assert hub.agents.active_id() == "work" and hub.prefs.persona == "friday"
    assert hub.memory.agent == "work" and "switch to work" not in hub.client.said  # no Claude
    assert any(kind == "agents" and data["active"] == "work" for kind, data in events)
    FakeClient.script = done("work-1")
    await hub.ask("any mail from Ann?")
    options = hub.client.options
    assert set(options.mcp_servers) == {"mail", "claude", "memory"}
    assert all(not t.startswith("mcp__") or t.split("__")[1] in {"mail", "claude", "memory"}
               for t in options.allowed_tools)  # fmt: skip
    assert "“Work Jarvis”" in options.system_prompt and not options.resume  # its own conversation
    # A call to a tool it wasn't given is refused all the same.
    hook = options.hooks["PreToolUse"][0].hooks[0]
    refused = await hook({"tool_name": "mcp__messages__send_message"}, "t1", None)
    assert refused["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert await hook({"tool_name": "mcp__mail__search"}, "t2", None) == {}
    assert await hook({"tool_name": "WebSearch"}, "t3", None) == {}
    # Its memory: the shared facts and its own; what it learns is its own.
    hub.memory.add("The owner's manager is Ann.", source="said")
    assert "Mia" in options.system_prompt and "manager is Ann" in hub.memory.prompt_block()
    hub.agents.choose(MAIN)
    assert hub.memory.agent == "" and hub.prefs.persona == "jarvis"
    assert [f.text for f in hub.memory.search("manager")] == []
    assert [f.text for f in hub.memory.search("daughter")] == ["The owner's daughter is Mia."]
    FakeClient.script = done("main-2")
    await hub.ask("hello again")
    options = hub.client.options
    assert (
        options.resume == "main-1"
        and "mail" in options.mcp_servers
        and "messages" in options.mcp_servers
    )
    assert "one of their agents" not in options.system_prompt
    # Back to work: its own conversation carries on.
    hub.agents.choose("work")
    FakeClient.script = done("work-2")
    await hub.ask("and from Bob?")
    assert hub.client.options.resume == "work-1"


async def test_a_chats_route_and_a_called_name_pick_the_agent(make_hub):
    hub = make_hub()
    await hub.start()
    await saved(hub, WORK)
    await saved(hub, FAMILY)
    FakeClient.script = done("w")
    await hub.ask("what's due?", origin={"channel": "slack", "team": "T-ACME", "chat": "C9"})
    assert hub.agents.active_id() == "work" and set(hub.client.options.mcp_servers) == {
        "mail",
        "claude",
        "memory",
    }
    assert hub.turn_origin == {}  # only while it runs
    heard = []
    hub.add_wake_sink(lambda text, command: heard.append((text, command)))
    assert "TARS" in wake.wake_names()  # every agent's name wakes it, whichever is in use
    hub.agents.on_wake("TARS, text mum I'm late", "text mum I'm late")
    FakeClient.script = done("f")
    await hub.ask("text mum I'm late")
    assert hub.agents.active_id() == "family" and hub.prefs.persona == "tars"
    assert set(hub.client.options.mcp_servers) == {"calendar", "messages", "memory"}
    # A name called long ago doesn't count.
    hub.agents.on_wake("Friday, hi there", "hi there")
    hub.agents.called = ("work", hub.agents.called[1] - agents_feature.WAKE_SECONDS - 1)
    FakeClient.script = done("f2")
    await hub.ask("and dad")
    assert hub.agents.active_id() == "family"


async def test_the_wake_seam_hears_what_woke_it(make_hub):
    hub = make_hub()
    heard = []
    hub.add_wake_sink(lambda text, command: heard.append((text, command)))
    hub._ask_by_voice = lambda request: None  # nothing asked: only the seam is under test
    await hub.on_heard("Jarvis, what's on today?")
    await hub.on_heard("Jarvis, stop")
    assert [text for text, _command in heard] == ["Jarvis, what's on today?"]
    assert heard[0][1].startswith("what's on today")


async def test_incognito_keeps_its_conversation(make_hub):
    hub = make_hub()
    await hub.start()
    await saved(hub, WORK)
    hub.incognito = True
    try:
        reply = await hub.agents.instant("switch to work")
    finally:
        hub.incognito = False
    assert reply == "Leave incognito first, then switch agents." and hub.agents.active_id() == MAIN


async def test_deleting_the_agent_in_use_goes_back_to_jarvis(make_hub):
    hub = make_hub()
    await hub.start()
    await saved(hub, WORK)
    await hub.agents.use({"id": "work"})
    assert hub.agents.active_id() == "work" and hub.agents.connected == "work"
    await hub.agents.delete({"id": "work"})
    assert hub.agents.active_id() == MAIN and hub.prefs.persona == "jarvis"
    assert hub.agents.store().items == []


async def test_an_agent_in_use_at_startup_is_its_own_from_the_first_connect(
    settings, quiet_speaker, isolated, tmp_path
):
    folder = isolated["prefs_store"].path.parent
    store = AgentStore(folder / "agents.json")
    store.put(WORK)
    store.use("work", "jarvis")
    isolated["memory"].add("Shared fact about the owner's garden.", source="said")
    isolated["memory"].agent = "family"
    isolated["memory"].add("Family-only fact about piano lessons.", source="said")
    isolated["memory"].agent = ""
    agents_feature.prepare(folder)
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    try:
        assert hub.memory.agent == "work"
        await hub.start()
        prompt = hub.client.options.system_prompt
        assert set(hub.client.options.mcp_servers) == {"mail", "claude", "memory"}
        assert "garden" in prompt and "piano" not in prompt
    finally:
        wake.add_names("agents", None)


async def test_lazily_read_agents_rescope_the_first_prompt(make_hub, isolated):
    folder = isolated["prefs_store"].path.parent
    store = AgentStore(folder / "agents.json")
    store.put(FAMILY)
    store.use("family", "jarvis")
    isolated["memory"].add("Shared: the owner lives in Lisbon.", source="said")
    isolated["memory"].agent = "family"
    isolated["memory"].add("Family: piano on Tuesdays.", source="said")
    isolated["memory"].agent = ""
    hub = make_hub()
    await hub.start()
    prompt = hub.client.options.system_prompt
    assert "Lisbon" in prompt and "piano on Tuesdays" in prompt
    assert set(hub.client.options.mcp_servers) == {"calendar", "messages", "memory"}


async def test_the_window_gets_the_tools_personas_and_errors(make_hub):
    hub = make_hub()
    await hub.start()
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    await hub.agents.state({})
    await hub.agents.save({"agent": {"name": ""}})
    [first, second] = [d for k, d in events if k == "agents"]
    names = {t["name"] for t in first["tools"]}
    assert {"mail", "calendar", "messages", "claude"} <= names and "memory" not in names
    assert {"id": "friday", "name": "FRIDAY"} in first["personas"] or any(
        p["id"] == "friday" for p in first["personas"]
    )
    assert first["active"] == MAIN and first["channels"] == list(agents.CHANNELS)
    assert second["error"] == "Give the agent a name."


def test_its_chinese():
    for english in agents_feature.TEXTS:
        assert lang.has_cjk(lang.tr(english, "zh", name="工作助手")), english
    assert lang.tr("Switched to {name}.", "zh", name="工作助手") == "已切换到工作助手。"


async def test_switching_says_it_in_chinese(make_hub):
    hub = make_hub()
    await hub.start()
    await saved(hub, FAMILY)
    hub.prefs.language = "zh"
    assert await hub.agents.instant("切换到家庭助手") == "已切换到家庭助手。"
    await asyncio.sleep(0)
