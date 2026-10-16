"""Eden Code's lean mode (features.code_lean, openai_relay.lean_body): a short prompt and six
tools for a model on this Mac, on by default for one and switchable per session; and the
prompt-size difference, measured on Claude Code itself against a fake server on this Mac
(no model is reached: the "server" answers "ok" to whatever it's sent)."""

import asyncio
import json
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from starlette.testclient import TestClient
from test_code_voice_feature import close_all, hub_with, session

from jarvis import openai_relay
from jarvis.connectors import MemoryVault
from jarvis.features import code_lean
from jarvis.openai_relay import build_app, count_tokens, lean_body
from jarvis.providers import ProviderStore


def on_ollama(hub, *models):
    """An Ollama server on this Mac, added, with these models; their refs."""
    added = hub.providers.add_provider("openai", "", "local", "http://localhost:11434")
    hub.providers.add_models(added["id"], [(m, None) for m in models])
    return [f"custom:{e.id}" for e in hub.providers.models_of(added["id"])]


@pytest.fixture
def relay_up(monkeypatch):
    """The relay's address as if it were listening (a session on a local model needs it)."""
    monkeypatch.setattr(openai_relay.PROXY, "port", 45999)
    return openai_relay.PROXY.address


async def test_on_by_default_for_a_model_on_this_mac_and_off_for_claude(
    settings, quiet_speaker, isolated, tmp_path, relay_up
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    [ref] = on_ollama(hub, "qwen2.5-coder:7b")
    local = session(hub, "proj", "Fix the test", model_ref=ref)
    claude = session(hub, "proj", "Write the docs")
    lean = hub.code_lean
    assert lean.is_on(local) and not lean.is_on(claude)
    assert lean.state(local)["why"] == "On: this session runs on a model on this Mac."
    hub.set_feature_prefs({code_lean.PREF: "on"})
    assert lean.is_on(claude)
    hub.set_feature_prefs({code_lean.PREF: "off"})
    assert not lean.is_on(local)
    hub.set_feature_prefs({code_lean.PREF: "sometimes"})  # not a mode: kept as it was
    assert hub.prefs.feature(code_lean.PREF) == "off"
    close_all(hub)


async def test_a_lean_session_gets_a_short_prompt_six_tools_and_no_extra_servers(
    settings, quiet_speaker, isolated, tmp_path, relay_up
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    [ref] = on_ollama(hub, "qwen2.5-coder:7b")
    full = hub.tasks.options_for(session(hub, "proj", "Write the docs"))
    assert isinstance(full.system_prompt, dict)  # Claude Code's own, as before
    assert len(full.mcp_servers) > 3  # the browser, the simulator, the sessions' tools…
    task = session(hub, "proj", "Fix the test", model_ref=ref)
    options = hub.tasks.options_for(task)
    assert options.system_prompt == code_lean.LEAN_PROMPT
    assert options.tools == list(code_lean.LEAN_TOOLS)
    assert set(options.mcp_servers) <= set(code_lean.KEEP_SERVERS)
    assert "jarvis_secrets" in options.mcp_servers  # $SECRET_NAME still works
    assert options.strict_mcp_config and options.plugins == []
    assert "user" not in options.setting_sources and "project" in options.setting_sources
    kept = tuple(f"mcp__{name}__" for name in code_lean.KEEP_SERVERS)
    assert [
        t for t in options.allowed_tools if t.startswith("mcp__") and not t.startswith(kept)
    ] == []
    assert options.can_use_tool is not None  # Eden's own permission checks stay
    env = json.loads(options.settings)["env"]
    assert env["ANTHROPIC_BASE_URL"] == f"{relay_up}/p/{hub.providers.provider_of(ref).id}/lean"
    assert len(code_lean.LEAN_PROMPT) // 4 < 400  # a few hundred tokens
    close_all(hub)


async def test_the_switch_per_session_reopens_it_and_says_so(
    settings, quiet_speaker, isolated, tmp_path, relay_up
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    task = session(hub, "proj", "Write the docs")
    reopened, events = [], []
    hub.tasks.reopen = lambda task_id, note="": reopened.append((task_id, note)) or True
    hub.emit = lambda kind, **data: events.append((kind, data))
    key = hub.tasks._options_key(task)
    hub.code_lean.cmd_set({"id": task.id, "on": True})
    assert hub.code_lean.is_on(task) and hub.tasks._options_key(task) != key
    assert reopened == [
        (task.id, "Lean mode is on for this session: a short prompt and six tools.")
    ]
    assert events[-1] == ("lean_state", hub.code_lean.state(task)) and events[-1][1]["own"] is True
    hub.code_lean.cmd_set({"id": task.id, "on": True})  # no change: nothing reopened
    assert len(reopened) == 1
    hub.code_lean.cmd_set({"id": task.id, "on": None})  # back to the default (off for Claude)
    assert not hub.code_lean.is_on(task) and len(reopened) == 2
    assert hub.tasks.options_for(task).system_prompt != code_lean.LEAN_PROMPT
    hub.code_lean.cmd_set({"id": "nonsense", "on": True})  # no such session: nothing
    assert len(reopened) == 2
    assert "lean_state" in hub._commands and "lean_set" in hub._commands
    close_all(hub)


# ── the relay's lean path ──

BASH_LIKE = {
    "name": "Bash",
    "description": "Executes a bash command. "
    + "Long guidance about git and quoting. " * 200
    + "\n\nMore paragraphs nobody small needs.",
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "The command to execute.\nAnd more."},
            "timeout": {"type": "number", "description": "Optional timeout. " * 40},
        },
        "required": ["command"],
        "examples": [{"command": "ls"}],
    },
}


def test_lean_body_keeps_the_tools_and_cuts_their_words():
    body = {
        "model": "qwen",
        "system": [
            {"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1;"},
            {"type": "text", "text": "You are Eden Code."},
        ],
        "tools": [BASH_LIKE],
        "messages": [{"role": "user", "content": "hi"}],
    }
    lean = lean_body(body)
    [tool] = lean["tools"]
    assert tool["name"] == "Bash" and tool["input_schema"]["required"] == ["command"]
    assert len(tool["description"]) <= openai_relay.LEAN_DESCRIPTION
    assert tool["description"].startswith("Executes a bash command.")
    props = tool["input_schema"]["properties"]
    assert props["command"] == {"type": "string", "description": "The command to execute."}
    assert len(props["timeout"]["description"]) <= openai_relay.LEAN_PARAMETER + 1
    assert "examples" not in tool["input_schema"]
    assert lean["system"] == [{"type": "text", "text": "You are Eden Code."}]
    assert lean["messages"] == body["messages"] and body["tools"] == [BASH_LIKE]  # untouched
    assert count_tokens(lean) * 5 < count_tokens(body)


def test_the_lean_door_sends_the_lean_body_on(tmp_path):
    store = ProviderStore(tmp_path / "providers.json", MemoryVault())
    pid = store.add_provider("openai", "", "local", "http://localhost:11434")["id"]
    got = []

    class Relay:
        async def messages(self, upstream, key, body):
            got.append(body)
            return 200, {"type": "message", "content": []}, None

    client = TestClient(build_app(Relay(), lambda: store.relay_target), client=("127.0.0.1", 5000))
    body = {"messages": [], "tools": [BASH_LIKE]}
    head = {"x-api-key": "local"}
    assert client.post(f"/p/{pid}/v1/messages", json=body, headers=head).status_code == 200
    assert client.post(f"/p/{pid}/lean/v1/messages", json=body, headers=head).status_code == 200
    assert got[0]["tools"] == [BASH_LIKE] and got[1] == lean_body(body)
    full = client.post(f"/p/{pid}/v1/messages/count_tokens", json=body, headers=head).json()
    short = client.post(f"/p/{pid}/lean/v1/messages/count_tokens", json=body, headers=head).json()
    assert short["input_tokens"] * 5 < full["input_tokens"]
    # the lean door is the same door: a wrong key still goes nowhere
    wrong = client.post(f"/p/{pid}/lean/v1/messages", json=body, headers={"x-api-key": "guess"})
    assert wrong.status_code == 401 and len(got) == 2


# ── the measurement: what Claude Code really sends, stock and lean ──


def _claude_cli() -> str | None:
    try:
        import claude_agent_sdk

        bundled = Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude"
    except ImportError:
        return None
    return str(bundled) if bundled.is_file() else shutil.which("claude")


class _FakeAnthropic(BaseHTTPRequestHandler):
    """Anthropic's Messages API as far as one turn needs: every request kept, "ok" back."""

    seen: list = []

    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        type(self).seen.append((self.path, body))
        if "count_tokens" in self.path:
            self._send("application/json", json.dumps({"input_tokens": 1}).encode())
            return
        message = {"id": "msg_1", "type": "message", "role": "assistant", "model": "m",
                   "content": [], "stop_reason": None, "usage": {"input_tokens": 1, "output_tokens": 1}}  # fmt: skip
        events = [
            ("message_start", {"type": "message_start", "message": message}),
            (
                "content_block_start",
                {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "text", "text": ""},
                },
            ),  # fmt: skip
            (
                "content_block_delta",
                {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "text_delta", "text": "ok"},
                },
            ),  # fmt: skip
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            (
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn"},
                    "usage": {"output_tokens": 1},
                },
            ),  # fmt: skip
            ("message_stop", {"type": "message_stop"}),
        ]
        data = "".join(f"event: {k}\ndata: {json.dumps(v)}\n\n" for k, v in events)
        self._send("text/event-stream", data.encode())

    def do_GET(self):
        self.send_response(404)
        self.end_headers()

    def _send(self, kind, data):
        self.send_response(200)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


async def _first_request(options, base_url, home):
    """The main request Claude Code sends for one "hi" with these options (its biggest:
    the one with the tools)."""
    from claude_agent_sdk import ClaudeSDKClient

    _FakeAnthropic.seen = []
    options.env = {
        **(options.env or {}),
        "ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_API_KEY": "sk-ant-not-a-key",
        "HOME": home, "CLAUDE_CONFIG_DIR": home, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    }  # fmt: skip
    options.settings = None  # (no provider: straight to the fake server)
    options.model = "claude-sonnet-4-5"
    options.max_turns = 1
    options.resume = None
    async with ClaudeSDKClient(options=options) as client:
        await client.query("hi")
        async for _message in client.receive_response():
            pass
    bodies = [b for p, b in _FakeAnthropic.seen if "count_tokens" not in p and b.get("tools")]
    return max(bodies, key=lambda b: len(json.dumps(b)))


@pytest.mark.skipif(_claude_cli() is None, reason="Claude Code isn't installed with the SDK")
async def test_lean_mode_sends_a_fraction_of_the_tokens(
    settings, quiet_speaker, isolated, tmp_path, relay_up, capsys
):
    """Eden Code's own options for a session, stock and lean, run through Claude Code for
    one "hi", against a fake server on this Mac: what each sends before the request. The
    stock one with nothing of the owner's loaded (an empty home) is the floor of what a
    real session sends; the lean one is what a model on this Mac gets through the relay."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _FakeAnthropic)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    home = tempfile.mkdtemp(dir=tmp_path)
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    try:
        task = session(hub, "proj", "Say hi")
        stock = await asyncio.wait_for(_first_request(hub.tasks.options_for(task), base, home), 120)
        hub.code_lean.switches[task.id] = True
        lean = await asyncio.wait_for(_first_request(hub.tasks.options_for(task), base, home), 120)
    finally:
        server.shutdown()
        close_all(hub)
    stock_tokens = count_tokens(stock)
    lean_tokens = count_tokens(lean)
    relayed = count_tokens(lean_body(lean))  # what the relay sends a model on this Mac
    with capsys.disabled():
        print(
            f"\n  Eden Code's first request, estimated tokens: stock {stock_tokens:,} "
            f"({len(stock['tools'])} tools), lean {lean_tokens:,} ({len(lean['tools'])} tools), "
            f"lean through the relay {relayed:,}"
        )
    builtin = sorted(t["name"] for t in lean["tools"] if not t["name"].startswith("mcp__"))
    assert builtin == sorted(code_lean.LEAN_TOOLS)
    assert {t["name"] for t in lean["tools"]} - set(builtin) <= {
        "mcp__jarvis_secrets__ask_secret", "mcp__jarvis_secrets__secrets"
    }  # fmt: skip
    assert stock_tokens > 15_000  # Claude Code's own prompt and two dozen tools
    assert relayed < 4_000  # a few thousand, for a small model's context
    assert relayed * 5 < stock_tokens
    assert "You are Eden Code" in json.dumps(lean["system"])
