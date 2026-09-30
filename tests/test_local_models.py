"""Other models for JARVIS itself: the utility model (jarvis.utility_model) and the servers on
this Mac found and added in one click (jarvis.features.local_models). No model is reached:
utility_model.run_turn is faked, and the "servers" are httpx stand-ins."""

import json
from datetime import date

import httpx
import pytest
from conftest import FakeClient

from jarvis import openai_relay, utility_model
from jarvis.features import local_models
from jarvis.hub import Hub
from jarvis.prefs import MODELS


def make_hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


@pytest.fixture
def calls(monkeypatch):
    seen = []

    async def fake_turn(prompt, options, timeout=90.0):
        seen.append({"prompt": prompt, "options": options})
        return "an answer"

    monkeypatch.setattr(utility_model, "run_turn", fake_turn)
    return seen


# ── the utility model ──


def test_haiku_unless_the_owner_picks_another(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert utility_model.ref(hub.prefs) == "haiku"
    hub.set_feature_prefs({"utility_model": "sonnet"})
    assert utility_model.ref(hub.prefs) == "sonnet"
    hub.set_feature_prefs({"utility_model": "gpt-5; rm -rf"})  # not a model ref: kept as it was
    assert utility_model.ref(hub.prefs) == "sonnet"
    hub.set_feature_prefs({"utility_model": "custom:abcdef123456"})
    assert utility_model.ref(hub.prefs) == "custom:abcdef123456"


async def test_a_call_runs_on_the_chosen_model_with_nothing_of_the_owners_loaded(
    settings, quiet_speaker, isolated, calls
):
    hub = make_hub(settings, quiet_speaker, isolated)
    utility_model.register_purpose("demo_triage", 2)
    assert (
        await utility_model.complete(hub, "sort this", system="You sort.", purpose="demo_triage")
        == "an answer"
    )
    options = calls[0]["options"]
    assert options.model == MODELS["haiku"] and options.system_prompt == "You sort."
    assert options.tools == [] and options.allowed_tools == [] and options.setting_sources == []
    assert options.strict_mcp_config and options.max_turns == 1
    assert options.env["ENABLE_TOOL_SEARCH"] == "false"
    assert options.cwd == str(hub.feature_path("workspace"))
    await utility_model.complete(hub, "again", system="s", purpose="demo_triage", model="sonnet")
    assert calls[1]["options"].model == MODELS["sonnet"]
    with pytest.raises(utility_model.OverBudget):
        await utility_model.complete(hub, "a third", system="s", purpose="demo_triage")
    assert len(calls) == 2  # past the cap nothing is sent
    saved = json.loads(hub.feature_path("utility_usage.json").read_text())
    assert saved == {"day": date.today().isoformat(), "counts": {"demo_triage": 2}}


async def test_a_purpose_nobody_registered_is_refused(settings, quiet_speaker, isolated, calls):
    hub = make_hub(settings, quiet_speaker, isolated)
    with pytest.raises(utility_model.OverBudget):
        await utility_model.complete(hub, "x", system="s", purpose="never_registered")
    assert calls == []


async def test_an_added_model_is_used_and_a_removed_one_means_the_default(
    settings, quiet_speaker, isolated, calls, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    store = hub.providers
    pid = store.add_provider("openai", "", "local", "http://localhost:11434")["id"]
    ref = store.add_model(pid, "qwen3")["ref"]
    started = []

    async def start(resolve):
        started.append(resolve)
        monkeypatch.setattr(openai_relay.PROXY, "port", 40001)
        return "http://127.0.0.1:40001"

    monkeypatch.setattr(openai_relay.PROXY, "start", start)
    monkeypatch.setattr(openai_relay.PROXY, "port", 0)
    hub.set_feature_prefs({"utility_model": ref})
    utility_model.register_purpose("demo_summary", 5)
    await utility_model.complete(hub, "sum up", system="s", purpose="demo_summary")
    options = calls[-1]["options"]
    assert started and options.model == "qwen3"
    assert (
        json.loads(options.settings)["env"]["ANTHROPIC_BASE_URL"]
        == f"http://127.0.0.1:40001/p/{pid}"
    )
    store.remove_model(ref)
    await utility_model.complete(hub, "sum up", system="s", purpose="demo_summary")
    assert calls[-1]["options"].model == MODELS["haiku"] and calls[-1]["options"].settings is None


def test_a_damaged_usage_file_starts_the_day_over(tmp_path):
    path = tmp_path / "utility_usage.json"
    path.write_text("{not json")
    usage = utility_model.Usage(path)
    utility_model.register_purpose("demo_x", 1)
    usage.take("demo_x")
    with pytest.raises(utility_model.OverBudget):
        usage.take("demo_x")
    usage.take("demo_x", today=date(2099, 1, 1))  # a new day: counts start over
    assert usage.left("demo_x", today=date(2099, 1, 1)) == 0


# ── servers on this Mac, found and added ──


def local_client(servers: dict[int, list[str]]) -> httpx.AsyncClient:
    def answer(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "127.0.0.1"  # only this Mac is ever asked
        models = servers.get(request.url.port)
        if models is None:
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(200, json={"object": "list", "data": [{"id": m} for m in models]})

    return httpx.AsyncClient(transport=httpx.MockTransport(answer))


async def test_servers_running_on_this_mac_are_found(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    finder = local_models.LocalModels(hub, local_client({11434: ["qwen3", "llama3.2", "qwen3"]}))
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    await finder.scan()
    [(kind, data)] = events
    assert kind == "local_models"
    assert data == {
        "servers": [
            {
                "port": 11434,
                "name": "Ollama",
                "models": ["qwen3", "llama3.2"],
                "count": 2,
                "added": "",
            }
        ]
    }


async def test_adding_one_brings_its_models_and_starts_the_relay(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    finder = local_models.LocalModels(hub, local_client({1234: ["qwen3-coder", "gemma-3"]}))
    started = []

    async def ready(store, ref=None):
        started.append(ref)

    monkeypatch.setattr(openai_relay, "ready", ready)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    await finder.scan()
    await finder.add({"port": 1234})
    [provider] = hub.providers.providers.values()
    assert provider.kind == "openai" and provider.name == "LM Studio"
    assert provider.base_url == "http://localhost:1234"
    assert [e.model for e in hub.providers.models_of(provider.id)] == ["qwen3-coder", "gemma-3"]
    assert started == [None]
    assert ("providers" in [k for k, _ in events]) and events[-1][1]["servers"][0][
        "added"
    ] == provider.id
    events.clear()
    await finder.add({"port": 1234})  # twice: said, not added again
    assert events[0] == ("providers_error", {"text": "LM Studio is added already."})
    await finder.add({"port": 11434})  # not found running
    assert events[1][0] == "providers_error" and len(hub.providers.providers) == 1


def test_the_feature_registers_its_commands_and_the_relay_keeper(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert "local_models_scan" in hub._commands and "local_models_add" in hub._commands
    assert "openai_relay" in [name for name, _ in hub._loops]


async def test_the_hub_starts_the_relay_for_an_added_server(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    started = []

    async def ready(store, ref=None):
        started.append(ref)

    monkeypatch.setattr(openai_relay, "ready", ready)
    await hub._relay_if_needed()
    await hub._gemini_ready("custom:abcdef123456")
    assert started == [None, "custom:abcdef123456"]
