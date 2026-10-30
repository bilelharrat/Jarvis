"""Other models for Jarvis itself: the utility model (jarvis.utility_model) and the servers on
this Mac found and added in one click (jarvis.features.local_models). No model is reached:
utility_model.run_turn is faked, and the "servers" are httpx stand-ins."""

import json
from datetime import date

import httpx
import pytest
from conftest import FakeClient

from jarvis import openai_relay, utility_model
from jarvis import providers as providers_mod
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
    assert utility_model.ref(hub.prefs) == "gemini-3.8-flash"
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
    assert options.model == "gemini-3.8-flash" and options.system_prompt == "You sort."
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
    assert calls[-1]["options"].model == "gemini-3.8-flash" and calls[-1]["options"].settings is None


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
    (kind, data), *after = events
    assert kind == "local_models" and "providers" in [k for k, _ in after]  # the pickers too
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


@pytest.mark.parametrize("port", [float("inf"), float("-inf"), float("nan"), None, "x", [1234]])
async def test_an_odd_port_from_the_window_adds_nothing_and_says_so(
    settings, quiet_speaker, isolated, port, caplog
):
    """The window's frame is JSON, which Python reads with Infinity and NaN: a port that
    isn't a number names no server found (as hub._msg_int reads a window's numbers), and
    the owner is told to look again; nothing is added and no traceback is logged."""
    hub = make_hub(settings, quiet_speaker, isolated)
    finder = local_models.LocalModels(hub, local_client({1234: ["qwen3-coder"]}))
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    await finder.scan()
    events.clear()
    await finder.add({"port": port})
    assert events == [("providers_error", {"text": "Look for it again first: it isn't running."})]
    assert not hub.providers.providers
    assert not [r for r in caplog.records if r.exc_info]


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


# ── Eden Code's pickers: models on this Mac, with their size and context ──


def ollama_client(seen: list[str] | None = None) -> httpx.AsyncClient:
    """Ollama on 11434 as it answers: /v1/models, /api/tags, /api/show; nothing elsewhere."""
    tags = {
        "models": [
            {"name": "qwen2.5-coder:7b", "model": "qwen2.5-coder:7b", "size": 4_683_087_332,
             "details": {"parameter_size": "7.6B", "quantization_level": "Q4_K_M"}},
            {"name": "nomic-embed-text:latest", "model": "nomic-embed-text:latest", "size": 274_302_450,
             "details": {"parameter_size": "137M", "quantization_level": "F16"}},
            {"name": "llama3.2:3b", "model": "llama3.2:3b", "size": "huge", "details": "odd"},
        ]
    }  # fmt: skip
    show = {
        "qwen2.5-coder:7b": {"model_info": {"qwen2.context_length": 32768}, "capabilities": ["completion", "tools"]},
        "nomic-embed-text:latest": {"model_info": {"nomic-bert.context_length": 2048}, "capabilities": ["embedding"]},
        "llama3.2:3b": {"capabilities": ["completion"]},
    }  # fmt: skip

    def answer(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "127.0.0.1"
        if seen is not None:
            seen.append(request.url.path)
        if request.url.port != 11434:
            raise httpx.ConnectError("refused", request=request)
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": m["model"]} for m in tags["models"]]})
        if request.url.path == "/api/tags":
            return httpx.Response(200, json=tags)
        if request.url.path == "/api/show":
            return httpx.Response(200, json=show[json.loads(request.content)["model"]])
        return httpx.Response(404)

    return httpx.AsyncClient(transport=httpx.MockTransport(answer))


async def test_the_pickers_list_models_on_this_mac_with_size_and_context(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    finder = local_models.LocalModels(hub, ollama_client())
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    await finder.scan()
    providers = [d for k, d in events if k == "providers"][-1]
    unadded = providers["on_this_mac"]
    # the embedding model can't chat: it isn't offered
    assert [m["model"] for m in unadded] == ["qwen2.5-coder:7b", "llama3.2:3b"]
    qwen, llama = unadded
    assert qwen["group"] == "On this Mac" and qwen["server"] == "Ollama" and qwen["needs_add"]
    assert (qwen["size"], qwen["context"], qwen["params"], qwen["quant"], qwen["tools"]) == (
        4_683_087_332,
        32768,
        "7.6B",
        "Q4_K_M",
        True,
    )
    assert qwen["ref"] == "local:11434/qwen2.5-coder:7b"
    # what a server said oddly is left out; the catalog's context stands in
    assert llama["size"] is None and llama["params"] == "" and llama["tools"] is False
    assert llama["context"] is None or llama["context"] > 0
    # not a model ref: nothing runs it as it is, and the picker proper doesn't list it
    assert not hub.providers.known("local:11434/qwen2.5-coder:7b")
    assert all(not m["ref"].startswith("local:") for m in providers["picker"])
    events.clear()
    await finder.scan()  # nothing changed: the pickers aren't told again
    assert [k for k, _ in events] == ["local_models"]


async def test_picking_one_adds_its_server_and_says_which_ref_to_use(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    finder = local_models.LocalModels(hub, ollama_client())
    started = []

    async def ready(store, ref=None):
        started.append(ref)

    monkeypatch.setattr(openai_relay, "ready", ready)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    await finder.scan()
    events.clear()
    await finder.use({"port": 11434, "model": "llama3.2:3b"})
    [provider] = hub.providers.providers.values()
    assert provider.name == "Ollama" and provider.base_url == "http://localhost:11434"
    models = [e.model for e in hub.providers.models_of(provider.id)]
    assert models[0] == "llama3.2:3b" and "qwen2.5-coder:7b" in models
    ready_ev = [d for k, d in events if k == "local_model_ready"][-1]
    entry = next(e for e in hub.providers.models_of(provider.id) if e.model == "llama3.2:3b")
    assert ready_ev == {"ref": f"custom:{entry.id}", "model": "llama3.2:3b", "port": 11434}
    assert started == [None]
    # once added, it's in the picker under On this Mac, with what was found about it
    picker = hub.providers.public()["picker"]
    qwen = next(m for m in picker if m["model"] == "qwen2.5-coder:7b")
    assert qwen["local"] and qwen["group"] == "On this Mac" and qwen["context"] == 32768
    assert qwen["ref"].startswith("custom:") and "needs_add" not in qwen
    assert hub.providers.public()["on_this_mac"] == []
    # again: the same server, no second provider
    events.clear()
    await finder.use({"port": 11434, "model": "qwen2.5-coder:7b"})
    assert len(hub.providers.providers) == 1
    assert [d for k, d in events if k == "local_model_ready"][-1]["ref"] == qwen["ref"]
    # a model the server doesn't list, or a server not running: said, nothing added
    events.clear()
    await finder.use({"port": 11434, "model": "gpt-oss:120b"})
    await finder.use({"port": "x", "model": "qwen2.5-coder:7b"})
    assert [k for k, _ in events] == ["providers_error", "providers_error"]
    assert "local_models_use" in hub._commands


async def test_a_real_fake_ollama_on_this_mac_is_found_without_ollama(
    settings, quiet_speaker, isolated, monkeypatch
):
    """The same look, over real HTTP, against a stand-in Ollama on a free port here: no
    Ollama needs to be installed or running, and no other port is asked."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    asked = []

    class FakeOllama(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def _json(self, data):
            out = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def do_GET(self):
            asked.append(self.path)
            if self.path == "/v1/models":
                self._json({"object": "list", "data": [{"id": "gemma3:4b"}]})
            elif self.path == "/api/tags":
                self._json({"models": [{"model": "gemma3:4b", "size": 3_338_801_804,
                                        "details": {"parameter_size": "4.3B"}}]})  # fmt: skip
            else:
                self.send_response(404)
                self.end_headers()

        def do_POST(self):
            asked.append(self.path)
            self.rfile.read(int(self.headers.get("content-length") or 0))
            self._json(
                {"model_info": {"gemma3.context_length": 131072}, "capabilities": ["completion"]}
            )

    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeOllama)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    monkeypatch.setattr(local_models, "LOCAL_SERVERS", {port: "Ollama"})
    monkeypatch.setitem(providers_mod.LOCAL_SERVERS, port, "Ollama")
    hub = make_hub(settings, quiet_speaker, isolated)
    try:
        await local_models.LocalModels(hub).scan()
    finally:
        server.shutdown()
    [found] = hub.providers.public()["on_this_mac"]
    assert (found["model"], found["server"], found["size"], found["context"], found["tools"]) == (
        "gemma3:4b",
        "Ollama",
        3_338_801_804,
        131072,
        False,
    )
    assert sorted(set(asked)) == ["/api/show", "/api/tags", "/v1/models"]
