"""Models that speak OpenAI's API behind Claude Code (jarvis.openai_relay): the translation
both ways, streaming with tool calls, errors in plain words, the relay sending a key only to
the address sealed with it, and a whole run through a fake OpenAI server on this Mac. No
request ever leaves 127.0.0.1."""

import asyncio
import json
import types

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from jarvis import openai_relay, providers
from jarvis.connectors import MemoryVault
from jarvis.openai_relay import OpenAIRelay, Stream, build_app, to_openai
from jarvis.providers import ProviderStore, openai_base_url

KEY = "local"


def events_of(text: str) -> list[dict]:
    """Anthropic's server-sent events, parsed."""
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "data" in lines:
            out.append(json.loads(lines["data"]))
    return out


# ── the request, translated ──


def test_a_messages_request_becomes_chat_completions():
    body = {
        "model": "qwen3",
        "max_tokens": 500,
        "stream": True,
        "system": [{"type": "text", "text": "You are JARVIS."}],
        "temperature": 0.2,
        "stop_sequences": ["\n\nHuman:"],
        "tools": [
            {
                "name": "list_events",
                "description": "List Calendar events.",
                "input_schema": {
                    "$schema": "http://json-schema.org/draft-07/schema#",
                    "type": "object",
                    "properties": {"days": {"type": "integer", "default": 1}},
                },
            },
            {"type": "web_search_20250305", "name": "web_search"},  # a server tool: left out
        ],
        "tool_choice": {"type": "auto"},
        "messages": [
            {"role": "user", "content": "What's on tomorrow?"},
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "hmm", "signature": "x"},
                    {"type": "text", "text": "Checking."},
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "list_events",
                        "input": {"days": 1},
                    },
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": [{"type": "text", "text": "Dentist at 3"}],
                    },
                    {"type": "text", "text": "And the weather?"},
                ],
            },
        ],
    }
    out = to_openai(body)
    assert out["model"] == "qwen3" and out["max_tokens"] == 500 and out["stream"] is True
    assert out["stream_options"] == {"include_usage": True}
    assert out["temperature"] == 0.2 and out["stop"] == ["\n\nHuman:"]
    system, user, assistant, tool, follow = out["messages"]
    assert system["role"] == "system" and system["content"].startswith("You are JARVIS.")
    assert "How to work with your tools" in system["content"]  # told to take the steps itself
    assert user == {"role": "user", "content": "What's on tomorrow?"}
    assert assistant == {
        "role": "assistant",
        "content": "Checking.",
        "tool_calls": [
            {
                "id": "toolu_1",
                "type": "function",
                "function": {"name": "list_events", "arguments": '{"days": 1}'},
            }
        ],
    }
    assert tool == {"role": "tool", "tool_call_id": "toolu_1", "content": "Dentist at 3"}
    assert follow == {"role": "user", "content": "And the weather?"}
    [fn] = out["tools"]
    assert fn["function"]["name"] == "list_events"
    assert "$schema" not in fn["function"]["parameters"]
    assert "default" not in fn["function"]["parameters"]["properties"]["days"]
    assert out["tool_choice"] == "auto"


def test_pictures_errors_and_tool_choice_translate():
    picture = {"type": "base64", "media_type": "image/png", "data": "iVBOR"}
    out = to_openai(
        {
            "model": "llava",
            "tools": [{"name": "see_screen", "input_schema": {"type": "object"}}],
            "tool_choice": {"type": "tool", "name": "see_screen"},
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Look"},
                        {"type": "image", "source": picture},
                    ],
                },
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "t1", "name": "see_screen", "input": {}}
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "t1",
                            "is_error": True,
                            "content": "denied",
                        },
                    ],
                },
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "t2", "name": "see_screen", "input": {}}
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "t2",
                            "content": [{"type": "image", "source": picture}],
                        },
                        {
                            "type": "document",
                            "source": {"type": "text", "data": "notes"},
                            "title": "a.txt",
                        },
                        {
                            "type": "document",
                            "source": {
                                "type": "base64",
                                "media_type": "application/pdf",
                                "data": "JVBE",
                            },
                        },
                    ],
                },
            ],
        }
    )
    assert out["tool_choice"] == {"type": "function", "function": {"name": "see_screen"}}
    first = out["messages"][1]["content"]
    assert first[0] == {"type": "text", "text": "Look"}
    assert first[1] == {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBOR"}}
    assert out["messages"][3] == {"role": "tool", "tool_call_id": "t1", "content": "Error: denied"}
    tool, pictures, docs = out["messages"][5:8]
    assert tool == {"role": "tool", "tool_call_id": "t2", "content": "(no output)"}
    assert pictures["role"] == "user" and pictures["content"][1]["type"] == "image_url"
    assert (
        docs["content"]
        == "a.txt\n\nnotes\n\n[A document was attached here that this model can't read.]"
    )
    assert (
        to_openai(
            {
                "messages": [],
                "tools": [{"name": "x", "input_schema": {}}],
                "tool_choice": {"type": "any"},
            }
        )["tool_choice"]
        == "required"
    )
    assert "stream_options" not in to_openai({"messages": []})


# ── the reply, translated ──


def chunk(content=None, calls=None, finish=None, usage=None):
    delta = {}
    if content is not None:
        delta["content"] = content
    if calls is not None:
        delta["tool_calls"] = calls
    data = {"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    if usage is not None:
        data = {"choices": [], "usage": usage}
    return data


def test_streamed_words_and_a_tool_call_split_across_chunks():
    stream = Stream("qwen3")
    out = stream.start()
    out += stream.chunk(chunk("Let me "))
    out += stream.chunk(chunk("check."))
    out += stream.chunk(
        chunk(
            calls=[
                {
                    "index": 0,
                    "id": "call_9",
                    "function": {"name": "list_events", "arguments": '{"da'},
                }
            ]
        )
    )
    out += stream.chunk(chunk(calls=[{"index": 0, "function": {"arguments": 'ys": 2}'}}]))
    out += stream.chunk(chunk(finish="tool_calls"))
    out += stream.chunk(chunk(usage={"prompt_tokens": 120, "completion_tokens": 30}))
    out += stream.end()
    events = events_of(out)
    kinds = [e["type"] for e in events]
    assert kinds == [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_delta",
        "content_block_stop",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
    ]
    assert (
        "".join(
            e["delta"]["text"] for e in events if e.get("delta", {}).get("type") == "text_delta"
        )
        == "Let me check."
    )
    start = events[5]["content_block"]
    assert start == {"type": "tool_use", "id": "call_9", "name": "list_events", "input": {}}
    assert json.loads(events[6]["delta"]["partial_json"]) == {"days": 2}
    assert events[5]["index"] == 1 and events[1]["index"] == 0
    assert events[-2]["delta"]["stop_reason"] == "tool_use"
    assert events[-2]["usage"] == {"output_tokens": 30} and stream.input_tokens == 120


def test_broken_arguments_become_an_empty_call_and_finish_reasons_map():
    stream = Stream("m")
    stream.chunk(
        chunk(calls=[{"id": "c1", "function": {"name": "weather_report", "arguments": "{oops"}}])
    )
    stream.chunk(chunk(calls=[{"function": {"name": ""}}]))  # a fragment with no function
    events = events_of(stream.end())
    assert [e["type"] for e in events][:3] == [
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
    ]
    assert json.loads(events[1]["delta"]["partial_json"]) == {}
    for finish, reason in (
        ("stop", "end_turn"),
        ("length", "max_tokens"),
        ("content_filter", "refusal"),
        ("odd", "end_turn"),
    ):
        s = Stream("m")
        s.chunk(chunk("x", finish=finish))
        assert s.stop_reason() == reason


def test_a_whole_reply_reads_into_one_message():
    stream = Stream("gpt-5")
    stream.whole(
        {
            "choices": [
                {
                    "message": {
                        "content": "Two meetings.",
                        "tool_calls": [
                            {
                                "id": "c2",
                                "type": "function",
                                "function": {"name": "a", "arguments": {"x": 1}},
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {"prompt_tokens": 9, "completion_tokens": 4},
        }
    )
    message = stream.message()
    assert message["content"] == [
        {"type": "text", "text": "Two meetings."},
        {"type": "tool_use", "id": "c2", "name": "a", "input": {"x": 1}},
    ]
    assert message["stop_reason"] == "tool_use"
    assert message["usage"] == {"input_tokens": 9, "output_tokens": 4}


def test_a_long_answer_and_a_long_call_come_through_whole():
    """A model writing a big file: its words and the call's arguments arrive in thousands of
    small pieces. Each word goes out as it comes; the call goes out whole, and the blocks
    hold every piece, in order."""
    content = "".join(chr(0x61 + i % 26) for i in range(60_000))
    body = json.dumps({"path": "big.py", "content": content})
    stream = Stream("qwen3")
    out = stream.start()
    words = [f"w{i} " for i in range(5_000)]
    for word in words:
        out += stream.chunk(chunk(word))
    out += stream.chunk(
        chunk(calls=[{"index": 0, "id": "c1", "function": {"name": "Write", "arguments": ""}}])
    )
    for i in range(0, len(body), 7):
        out += stream.chunk(chunk(calls=[{"index": 0, "function": {"arguments": body[i : i + 7]}}]))
    out += stream.end()
    events = events_of(out)
    said = [e["delta"]["text"] for e in events if e.get("delta", {}).get("type") == "text_delta"]
    assert said == words
    [call] = [e for e in events if e.get("delta", {}).get("type") == "input_json_delta"]
    assert json.loads(call["delta"]["partial_json"]) == {"path": "big.py", "content": content}
    assert stream.blocks[0] == {"type": "text", "text": "".join(words)}
    assert stream.blocks[1]["input"]["content"] == content
    again = Stream("m")  # a text block opened again after a call starts empty
    again.chunk(chunk("one"))
    again.chunk(
        chunk(calls=[{"index": 0, "id": "c", "function": {"name": "a", "arguments": "{}"}}])
    )
    again.chunk(chunk("two"))
    again.end()
    assert [b.get("text") for b in again.blocks] == ["one", None, "two"]


# ── the calls, against a stand-in for the provider ──


def sse(*chunks):
    return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"


async def test_the_relay_streams_and_sends_the_key_only_as_a_bearer():
    seen = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            text=sse(chunk("Hi"), chunk(finish="stop")),
            headers={"content-type": "text/event-stream"},
        )

    relay = OpenAIRelay(httpx.AsyncClient(transport=httpx.MockTransport(answer)))
    status, data, events = await relay.messages(
        "http://localhost:11434",
        KEY,
        {"model": "qwen3", "stream": True, "messages": [{"role": "user", "content": "hello"}]},
    )
    assert status == 200 and data is None
    text = "".join([piece async for piece in events])
    assert [e["type"] for e in events_of(text)][-1] == "message_stop"
    [request] = seen
    assert str(request.url) == "http://localhost:11434/v1/chat/completions"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert "anthropic-version" not in request.headers and "x-api-key" not in request.headers


async def test_an_older_server_gets_the_request_again_without_what_it_refused():
    bodies = []

    def answer(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        if "stream_options" in body:
            return httpx.Response(
                400, json={"error": {"message": "Unrecognized field stream_options"}}
            )
        if "max_tokens" in body:
            return httpx.Response(
                400, json={"error": {"message": "use max_completion_tokens instead"}}
            )
        return httpx.Response(200, text=sse(chunk("ok", finish="stop")))

    relay = OpenAIRelay(httpx.AsyncClient(transport=httpx.MockTransport(answer)))
    status, _, events = await relay.messages(
        "https://api.example.com",
        "sk-x",
        {"model": "o3", "stream": True, "max_tokens": 50, "messages": []},
    )
    assert status == 200
    assert "ok" in "".join([p async for p in events])
    assert (
        len(bodies) == 3
        and bodies[-1]["max_completion_tokens"] == 50
        and "max_tokens" not in bodies[-1]
    )


async def test_errors_come_back_as_anthropic_errors_in_plain_words():
    def refused(request):
        raise httpx.ConnectError("refused", request=request)

    relay = OpenAIRelay(httpx.AsyncClient(transport=httpx.MockTransport(refused)))
    status, data, events = await relay.messages(
        "http://localhost:11434", KEY, {"model": "qwen3", "messages": []}
    )
    assert events is None and status == 400  # shown, not retried over and over
    assert "Nothing is answering at localhost:11434 on this Mac" in data["error"]["message"]

    def rejected(request):
        return httpx.Response(
            401, json={"error": {"message": "Incorrect API key provided: sk-abcd…wxyz"}}
        )

    relay = OpenAIRelay(httpx.AsyncClient(transport=httpx.MockTransport(rejected)))
    status, data, _ = await relay.messages(
        "https://api.example.com", "sk-secret-000000000wxyz", {"messages": []}
    )
    assert status == 401 and data["error"]["type"] == "authentication_error"
    assert "api.example.com answered 401" in data["error"]["message"]

    def leaky(request):
        return httpx.Response(
            429, json={"error": {"message": "slow down, key sk-secret-000000000wxyz"}}
        )

    relay = OpenAIRelay(httpx.AsyncClient(transport=httpx.MockTransport(leaky)))
    status, data, _ = await relay.messages(
        "https://api.example.com", "sk-secret-000000000wxyz", {"messages": []}
    )
    assert status == 429 and "000000000wxyz" not in json.dumps(data)  # the key is never repeated

    def down(request):
        return httpx.Response(503, text="<html>bad gateway</html>")

    relay = OpenAIRelay(httpx.AsyncClient(transport=httpx.MockTransport(down)))
    status, data, _ = await relay.messages("https://api.example.com", "k" * 20, {"messages": []})
    assert status == 529 and data["error"]["type"] == "overloaded_error"


async def test_a_model_server_that_fails_or_answers_garbage_says_so_instead_of_going_quiet():
    """A local model server that stops with an error part-way, breaks off, or isn't a model
    server at all (a web page at that address): the reply ends in an Anthropic error Claude
    Code reports, never a quiet, empty or cut-off answer JARVIS takes as done."""

    async def run(answer, stream=True):
        relay = OpenAIRelay(httpx.AsyncClient(transport=httpx.MockTransport(answer)))
        body = {"model": "qwen3", "stream": stream, "messages": [{"role": "user", "content": "hi"}]}
        return await relay.messages("http://localhost:11434", KEY, body)

    def failed(request):  # LM Studio, vLLM: an error as a chunk, after some words
        text = sse(chunk("The first"), {"error": {"message": "context length exceeded"}})
        return httpx.Response(200, text=text, headers={"content-type": "text/event-stream"})

    status, _, events = await run(failed)
    got = events_of("".join([p async for p in events]))
    assert status == 200 and got[-1]["type"] == "error"
    assert "context length exceeded" in got[-1]["error"]["message"]
    assert "message_stop" not in [e["type"] for e in got]

    class Broken(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"choices": [{"index": 0, "delta": {"content": "Half"}}]}\n\n'
            raise httpx.ReadError("connection reset")

    def broken(request):
        return httpx.Response(200, stream=Broken(), headers={"content-type": "text/event-stream"})

    _, _, events = await run(broken)
    got = events_of("".join([p async for p in events]))
    assert got[-1]["type"] == "error" and "broke off" in got[-1]["error"]["message"]

    def page(request):  # a web page where the model server was expected
        return httpx.Response(200, text="<!doctype html><title>Router</title>")

    _, _, events = await run(page)
    got = events_of("".join([p async for p in events]))
    assert got[-1]["type"] == "error" and "isn't a model server" in got[-1]["error"]["message"]

    # A whole (non-streamed) reply that isn't JSON: shown, not retried as if overloaded.
    status, data, _ = await run(page, stream=False)
    assert status == 400 and data["error"]["type"] == "invalid_request_error"
    assert "didn't answer in JSON" in data["error"]["message"]


async def test_a_whole_reply_comes_back_whole():
    def answer(request):
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "Four."}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1},
            },
        )

    relay = OpenAIRelay(httpx.AsyncClient(transport=httpx.MockTransport(answer)))
    status, data, events = await relay.messages(
        "http://localhost:1234",
        KEY,
        {"model": "m", "messages": [{"role": "user", "content": "2+2"}]},
    )
    assert status == 200 and events is None
    assert (
        data["content"] == [{"type": "text", "text": "Four."}] and data["stop_reason"] == "end_turn"
    )


# ── the relay's own door ──


def openai_store(tmp_path, url="http://localhost:11434", key=KEY):
    store = ProviderStore(tmp_path / "providers.json", MemoryVault())
    added = store.add_provider("openai", "", key, url)
    return store, added["id"]


def test_the_door_sends_a_request_only_with_the_key_sealed_for_that_provider(tmp_path):
    store, pid = openai_store(tmp_path)
    calls = []

    class Relay:
        async def messages(self, upstream, key, body):
            calls.append((upstream, key))
            return 200, {"type": "message", "content": []}, None

    client = TestClient(build_app(Relay(), lambda: store.relay_target), client=("127.0.0.1", 5000))
    ok = client.post(f"/p/{pid}/v1/messages", json={"messages": []}, headers={"x-api-key": KEY})
    assert ok.status_code == 200 and calls == [("http://localhost:11434", KEY)]
    wrong = client.post(
        f"/p/{pid}/v1/messages", json={}, headers={"authorization": "Bearer another-key"}
    )
    assert wrong.status_code == 401 and len(calls) == 1
    nobody = client.post("/p/000000000000/v1/messages", json={}, headers={"x-api-key": KEY})
    assert nobody.status_code == 401
    keyless = client.post(f"/p/{pid}/v1/messages", json={})
    assert keyless.status_code == 401
    tokens = client.post(
        f"/p/{pid}/v1/messages/count_tokens",
        json={"messages": [{"role": "user", "content": "x" * 400}]},
        headers={"x-api-key": KEY},
    )
    assert tokens.json()["input_tokens"] >= 100
    far = TestClient(build_app(Relay(), lambda: store.relay_target), client=("10.0.0.2", 5000))
    assert far.post(f"/p/{pid}/v1/messages", json={}, headers={"x-api-key": KEY}).status_code == 403


def test_the_sealed_address_wins_over_an_edited_file(tmp_path):
    store, pid = openai_store(tmp_path)
    assert store.relay_target(pid, KEY) == "http://localhost:11434"
    assert store.relay_target(pid, "guess") is None
    # Someone edits providers.json to point the provider elsewhere: the key goes nowhere.
    raw = json.loads(store.path.read_text())
    raw["providers"][0]["base_url"] = "https://evil.example.com"
    store.path.write_text(json.dumps(raw))
    reloaded = ProviderStore(store.path, store.vault)
    assert reloaded.relay_target(pid, KEY) is None
    # Not an OpenAI-compatible provider: never through this relay.
    other = ProviderStore(tmp_path / "other.json", MemoryVault())
    orp = other.add_provider("openrouter", "", "sk-or-v1-" + "a" * 64)["id"]
    assert other.relay_target(orp, "sk-or-v1-" + "a" * 64) is None


def test_a_new_key_is_checked_again(tmp_path):
    store, pid = openai_store(tmp_path, key="first-key")
    assert store.relay_target(pid, "first-key")
    store.replace_key(pid, "second-key")
    assert store.relay_target(pid, "first-key") is None
    assert store.relay_target(pid, "second-key") == "http://localhost:11434"


# ── providers: the kind itself ──


@pytest.mark.parametrize(
    ("given", "kept", "name"),
    [
        ("http://localhost:11434", "http://localhost:11434", "Ollama"),
        ("localhost:11434/v1", "http://localhost:11434", "Ollama"),
        ("http://127.0.0.1:1234/v1/chat/completions", "http://127.0.0.1:1234", "LM Studio"),
        ("https://openrouter.ai/api/v1", "https://openrouter.ai/api", "openrouter.ai"),
        ("https://api.groq.com/openai/v1/", "https://api.groq.com/openai", "api.groq.com"),
    ],
)
def test_openai_compatible_addresses_and_names(tmp_path, given, kept, name):
    store = ProviderStore(tmp_path / "p.json", MemoryVault())
    added = store.add_provider("openai", "", KEY, given)
    assert added["base_url"] == kept == openai_base_url(given)
    assert added["name"] == name and added["auth"] == "bearer"


def test_a_plain_http_address_off_this_mac_is_refused_and_so_are_wrong_keys(tmp_path):
    store = ProviderStore(tmp_path / "p.json", MemoryVault())
    with pytest.raises(ValueError, match="Use https"):
        store.add_provider("openai", "", KEY, "http://llm.example.com")
    with pytest.raises(ValueError, match="Anthropic key"):
        store.add_provider("openai", "", "sk-ant-api03-" + "x" * 40, "https://api.example.com")
    with pytest.raises(ValueError, match="Google key"):
        store.add_provider("openai", "", "AIza" + "x" * 35, "https://api.example.com")


def test_an_openai_compatible_session_goes_through_the_relay(tmp_path, monkeypatch):
    store, pid = openai_store(tmp_path)
    ref = store.add_model(pid, "qwen3")["ref"]
    monkeypatch.setattr(openai_relay.PROXY, "port", 0)
    with pytest.raises(ValueError, match="relay isn't running"):
        store.session_config(ref, {})
    monkeypatch.setattr(openai_relay.PROXY, "port", 45678)
    config = store.session_config(ref, {})
    pins = json.loads(config["settings"])["env"]
    assert pins["ANTHROPIC_BASE_URL"] == f"http://127.0.0.1:45678/p/{pid}"
    assert all(pins[name] == "qwen3" for name in providers.TIER_ENV)  # a local model stays local
    assert pins["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"
    assert KEY not in config["settings"] and config["claude"] is False
    far, far_id = openai_store(
        tmp_path / "far", url="https://openrouter.ai/api/v1", key="sk-or-v1-" + "b" * 64
    )
    far_pins = json.loads(
        far.session_config(far.add_model(far_id, "openai/gpt-5")["ref"], {})["settings"]
    )["env"]
    assert "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" not in far_pins  # its own traffic is its own


async def test_checking_an_openai_compatible_server_lists_its_models(tmp_path):
    store, pid = openai_store(tmp_path)
    seen = []

    def answer(request):
        seen.append(request)
        return httpx.Response(
            200, json={"object": "list", "data": [{"id": "qwen3"}, {"id": "llama3.2"}]}
        )

    result = await store.check(pid, httpx.AsyncClient(transport=httpx.MockTransport(answer)))
    assert result["ok"] and [m["id"] for m in result["models"]] == ["qwen3", "llama3.2"]
    assert str(seen[0].url) == "http://localhost:11434/v1/models?limit=1000"
    assert seen[0].headers["authorization"] == f"Bearer {KEY}"
    assert "anthropic-version" not in seen[0].headers


# ── a whole run: Claude Code's request, the relay, a fake OpenAI server on this Mac ──


@pytest.fixture
async def fake_server():
    import uvicorn

    seen: list[dict] = []

    async def chat(request):
        body = await request.json()
        seen.append({"auth": request.headers.get("authorization"), "body": body})
        if body.get("stream"):

            async def gen():
                for piece in (
                    chunk("It's "),
                    chunk("sunny."),
                    chunk(
                        calls=[
                            {
                                "index": 0,
                                "id": "call_1",
                                "function": {"name": "weather_report", "arguments": "{}"},
                            }
                        ]
                    ),
                    chunk(finish="tool_calls"),
                    chunk(usage={"prompt_tokens": 40, "completion_tokens": 6}),
                ):
                    yield f"data: {json.dumps(piece)}\n\n"
                    await asyncio.sleep(0)
                yield "data: [DONE]\n\n"

            return StreamingResponse(gen(), media_type="text/event-stream")
        return JSONResponse(
            {"choices": [{"message": {"content": "Hello."}, "finish_reason": "stop"}]}
        )

    async def models(_request):
        return JSONResponse({"object": "list", "data": [{"id": "qwen3"}]})

    app = Starlette(
        routes=[Route("/v1/chat/completions", chat, methods=["POST"]), Route("/v1/models", models)]
    )
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning", lifespan="off")
    )
    task = asyncio.create_task(server.serve())
    for _ in range(500):
        if server.started:
            break
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    yield types.SimpleNamespace(port=port, seen=seen, url=f"http://127.0.0.1:{port}")
    server.should_exit = True
    await task


@pytest.fixture
async def relay_proxy():
    yield openai_relay.PROXY
    await openai_relay.PROXY.close()


async def test_a_whole_run_through_a_fake_local_server(tmp_path, fake_server, relay_proxy):
    store, pid = openai_store(tmp_path, url=fake_server.url)
    ref = store.add_model(pid, "qwen3")["ref"]
    await openai_relay.ready(store, ref)
    pins = json.loads(store.session_config(ref, {})["settings"])["env"]
    base = pins["ANTHROPIC_BASE_URL"]
    body = {
        "model": "qwen3",
        "stream": True,
        "max_tokens": 200,
        "tools": [
            {
                "name": "weather_report",
                "description": "Weather.",
                "input_schema": {"type": "object"},
            }
        ],
        "messages": [{"role": "user", "content": "Weather?"}],
    }
    async with httpx.AsyncClient() as client:
        response = await client.post(f"{base}/v1/messages", json=body, headers={"x-api-key": KEY})
        assert response.status_code == 200
        events = events_of(response.text)
        refused = await client.post(
            f"{base}/v1/messages", json=body, headers={"x-api-key": "other"}
        )
        assert refused.status_code == 401
        whole = await client.post(
            f"{base}/v1/messages", json={**body, "stream": False}, headers={"x-api-key": KEY}
        )
    text = "".join(
        e["delta"]["text"] for e in events if e.get("delta", {}).get("type") == "text_delta"
    )
    assert text == "It's sunny."
    tool = next(e for e in events if e.get("content_block", {}).get("type") == "tool_use")
    assert (
        tool["content_block"]["name"] == "weather_report"
        and tool["content_block"]["id"] == "call_1"
    )
    assert events[-2]["delta"]["stop_reason"] == "tool_use"
    assert whole.json()["content"] == [{"type": "text", "text": "Hello."}]
    assert len(fake_server.seen) == 2  # the refused one never reached the server
    assert fake_server.seen[0]["auth"] == f"Bearer {KEY}"
    assert fake_server.seen[0]["body"]["tools"][0]["function"]["name"] == "weather_report"


async def test_ready_starts_the_relay_only_when_a_session_needs_it(tmp_path, monkeypatch):
    started = []

    async def start(resolve):
        started.append(resolve)
        return "http://127.0.0.1:1"

    monkeypatch.setattr(openai_relay.PROXY, "start", start)
    empty = ProviderStore(tmp_path / "e.json", MemoryVault())
    await openai_relay.ready(empty)
    assert started == []
    store, pid = openai_store(tmp_path)
    ref = store.add_model(pid, "qwen3")["ref"]
    await openai_relay.ready(store, "sonnet")
    assert started == []
    await openai_relay.ready(store, ref)
    await openai_relay.ready(store)
    assert len(started) == 2 and started[0] == store.relay_target
