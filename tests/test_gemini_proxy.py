"""JARVIS's Gemini relay: Anthropic's Messages API in, Google's Gemini API out, with tools,
pictures, streaming, thought signatures and errors translated. Google is faked here."""

import json

import httpx
import pytest

from jarvis import gemini_proxy
from jarvis.gemini_proxy import GeminiRelay, Signatures, anthropic_error, clean_schema, to_gemini

KEY = "AIza" + "x" * 35
EXPRESS = "AQ." + "y" * 50

TOOLS = [
    {
        "name": "weather_report",
        "description": "The weather.",
        "input_schema": {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
            "additionalProperties": False,
        },
    }
]


def test_a_conversation_with_tools_and_pictures_becomes_gemini():
    sig = Signatures()
    sig.put("toolu_1", "SIG-1")
    body = {
        "model": "gemini-2.5-flash",
        "system": [
            {"type": "text", "text": "You are Jarvis.", "cache_control": {"type": "ephemeral"}}
        ],
        "max_tokens": 1000,
        "tools": TOOLS,
        "tool_choice": {"type": "auto"},
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Weather in Berkeley?"},
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"},
                    },
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "hmm", "signature": "x"},
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "weather_report",
                        "input": {"city": "Berkeley"},
                    },
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": [{"type": "text", "text": "68F, sunny"}],
                    }
                ],
            },
            {"role": "user", "content": "And tomorrow?"},
        ],
    }
    out = to_gemini(body, sig)
    system = out["systemInstruction"]["parts"][0]["text"]
    assert system.startswith("You are Jarvis.") and system.endswith(gemini_proxy.TOOL_HABITS)
    # Without tools the prompt goes as it came.
    bare = to_gemini({"system": "Be brief.", "messages": [{"role": "user", "content": "Hi"}]})
    assert bare["systemInstruction"] == {"parts": [{"text": "Be brief."}]}
    roles = [c["role"] for c in out["contents"]]
    assert roles == ["user", "model", "user"]  # the two user turns after the call are one
    assert out["contents"][0]["parts"][1] == {
        "inlineData": {"mimeType": "image/png", "data": "AAAA"}
    }
    call = out["contents"][1]["parts"][0]
    assert call == {
        "functionCall": {"name": "weather_report", "args": {"city": "Berkeley"}},
        "thoughtSignature": "SIG-1",
    }
    result = out["contents"][2]["parts"][0]["functionResponse"]
    assert result == {"name": "weather_report", "response": {"content": "68F, sunny"}}
    assert out["contents"][2]["parts"][1] == {"text": "And tomorrow?"}
    decl = out["tools"][0]["functionDeclarations"][0]
    assert decl["name"] == "weather_report" and "$schema" not in decl["parametersJsonSchema"]
    assert out["toolConfig"] == {"functionCallingConfig": {"mode": "AUTO"}}
    assert out["generationConfig"]["maxOutputTokens"] == 1000


def test_a_failed_tool_and_a_forced_tool():
    body = {
        "messages": [
            {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": "t9", "name": "read_file", "input": {}}],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "t9",
                        "is_error": True,
                        "content": "No such file",
                    }
                ],
            },
        ],
        "tools": [{"name": "read_file", "input_schema": {"type": "object"}}],
        "tool_choice": {"type": "tool", "name": "read_file"},
    }
    out = to_gemini(body)
    assert out["contents"][1]["parts"][0]["functionResponse"]["response"] == {
        "error": "No such file"
    }
    assert out["toolConfig"]["functionCallingConfig"] == {
        "mode": "ANY",
        "allowedFunctionNames": ["read_file"],
    }


def test_schemas_lose_what_gemini_rejects_and_keep_the_rest():
    schema = {
        "$schema": "x",
        "type": "object",
        "$defs": {},
        "properties": {"a": {"type": "array", "items": {"type": "string"}, "default": []}},
    }
    assert clean_schema(schema) == {
        "type": "object",
        "properties": {"a": {"type": "array", "items": {"type": "string"}}},
    }


def fake_google(stream_chunks=None, reply=None, status=200, reject_gemini=False):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(
            (str(request.url), request.headers.get("x-goog-api-key"), json.loads(request.content))
        )
        if reject_gemini and "generativelanguage" in str(request.url):
            return httpx.Response(
                400,
                json={
                    "error": {
                        "message": "API key not valid. Please pass a valid API key.",
                        "status": "INVALID_ARGUMENT",
                    }
                },
            )
        if status != 200:
            return httpx.Response(
                status, json={"error": {"message": "Resource has been exhausted (quota)."}}
            )
        if "alt=sse" in str(request.url):
            body = "".join(f"data: {json.dumps(c)}\r\n\r\n" for c in stream_chunks or [])
            return httpx.Response(
                200, content=body.encode(), headers={"content-type": "text/event-stream"}
            )
        return httpx.Response(200, json=reply or {})

    return GeminiRelay(httpx.AsyncClient(transport=httpx.MockTransport(handler))), seen


def events_of(text):
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


async def test_a_streamed_reply_with_a_tool_call_comes_out_as_anthropic_events():
    chunks = [
        {"candidates": [{"content": {"parts": [{"text": "Let me "}]}}]},
        {
            "candidates": [
                {"content": {"parts": [{"thought": True, "text": "thinking…"}, {"text": "check."}]}}
            ]
        },
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "functionCall": {
                                    "name": "weather_report",
                                    "args": {"city": "Berkeley"},
                                },
                                "thoughtSignature": "SIG-9",
                            }
                        ]
                    },
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {"promptTokenCount": 120, "candidatesTokenCount": 9},
        },
    ]
    relay, seen = fake_google(chunks)
    status, body, events = await relay.messages(
        KEY,
        {
            "model": "gemini-2.5-flash",
            "stream": True,
            "max_tokens": 50,
            "tools": TOOLS,
            "messages": [{"role": "user", "content": "Weather?"}],
        },
    )
    assert status == 200 and body is None
    text = "".join([e async for e in events])
    got = events_of(text)
    kinds = [k for k, _ in got]
    assert kinds[0] == "message_start" and kinds[-2:] == ["message_delta", "message_stop"]
    deltas = [d["delta"] for k, d in got if k == "content_block_delta"]
    assert [d["text"] for d in deltas if d["type"] == "text_delta"] == [
        "Let me ",
        "check.",
    ]  # thoughts dropped
    tool = next(
        d["content_block"]
        for k, d in got
        if k == "content_block_start" and d["content_block"]["type"] == "tool_use"
    )
    assert tool["name"] == "weather_report"
    assert json.loads(
        next(d["partial_json"] for d in deltas if d["type"] == "input_json_delta")
    ) == {"city": "Berkeley"}
    stop = next(d for k, d in got if k == "message_delta")
    assert stop["delta"]["stop_reason"] == "tool_use" and stop["usage"]["output_tokens"] == 9
    assert relay.signatures.get(tool["id"]) == "SIG-9"  # sent back with this call next time
    url, key, payload = seen[0]
    assert (
        "generativelanguage.googleapis.com" in url
        and ":streamGenerateContent?alt=sse" in url
        and key == KEY
    )


def test_a_long_answer_streams_piece_by_piece_and_reads_whole():
    """Thousands of small pieces of text: each goes out as it comes, and the message holds
    every piece, in order (each was added to a string once, which copied the whole reply
    again for each piece: 1.5 s on the event loop for a megabyte)."""
    words = [f"w{i} " for i in range(5_000)]
    stream = gemini_proxy.Stream("gemini-flash-latest", Signatures())
    out = stream.start()
    for word in words:
        out += stream.chunk({"candidates": [{"content": {"parts": [{"text": word}]}}]})
    out += stream.chunk(
        {"candidates": [{"content": {"parts": [{"functionCall": {"name": "a", "args": {}}}]}}]}
    )
    out += stream.chunk({"candidates": [{"content": {"parts": [{"text": "after"}]}}]})
    out += stream.end()
    said = [
        d["delta"]["text"]
        for k, d in events_of(out)
        if k == "content_block_delta" and d["delta"]["type"] == "text_delta"
    ]
    assert said == [*words, "after"]
    assert [b.get("text") for b in stream.message()["content"]] == ["".join(words), None, "after"]
    whole = gemini_proxy.Stream("m", Signatures())  # a reply not streamed: never closed
    whole.chunk(
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"text": "one "},
                            {"text": "two"},
                            {"functionCall": {"name": "a", "args": {"x": 1}}},
                            {"text": "three"},
                        ]
                    }
                }
            ]
        }
    )
    first = whole.message()
    assert [b.get("text") for b in first["content"]] == ["one two", None, "three"]
    assert whole.message()["content"] == first["content"]  # asked twice: the same


async def test_a_whole_reply_when_not_streaming():
    relay, _ = fake_google(
        reply={"candidates": [{"content": {"parts": [{"text": "OK."}]}, "finishReason": "STOP"}]}
    )
    status, body, events = await relay.messages(
        KEY,
        {
            "model": "gemini-2.5-flash",
            "max_tokens": 5,
            "messages": [{"role": "user", "content": "Say OK."}],
        },
    )
    assert status == 200 and events is None
    assert (
        body["content"] == [{"type": "text", "text": "OK."}] and body["stop_reason"] == "end_turn"
    )


async def test_an_express_key_goes_to_vertex_and_the_endpoint_is_remembered():
    relay, seen = fake_google(reply={"candidates": [{"content": {"parts": [{"text": "OK."}]}}]})
    await relay.messages(
        EXPRESS, {"model": "gemini-2.5-flash", "messages": [{"role": "user", "content": "hi"}]}
    )
    assert "aiplatform.googleapis.com" in seen[0][0]


async def test_a_key_the_gemini_api_refuses_is_tried_on_vertex():
    relay, seen = fake_google(
        reply={"candidates": [{"content": {"parts": [{"text": "OK."}]}}]}, reject_gemini=True
    )
    status, body, _ = await relay.messages(
        KEY, {"model": "gemini-2.5-flash", "messages": [{"role": "user", "content": "hi"}]}
    )
    assert status == 200 and [("generativelanguage" in u) for u, _, _ in seen] == [True, False]
    await relay.messages(
        KEY, {"model": "gemini-2.5-flash", "messages": [{"role": "user", "content": "again"}]}
    )
    assert "aiplatform" in seen[-1][0]  # straight to the endpoint that took it


async def test_googles_errors_come_back_as_anthropic_errors():
    relay, _ = fake_google(status=429)
    status, body, _ = await relay.messages(
        KEY, {"model": "gemini-2.5-flash", "messages": [{"role": "user", "content": "hi"}]}
    )
    assert (
        status == 429
        and body["error"]["type"] == "rate_limit_error"
        and "quota" in body["error"]["message"]
    )
    assert anthropic_error(503, "down") == (
        529,
        {"type": "error", "error": {"type": "overloaded_error", "message": "down"}},
    )


async def test_the_relay_serves_anthropics_api_on_this_mac_only():
    relay, _ = fake_google(reply={"candidates": [{"content": {"parts": [{"text": "Hi."}]}}]})
    app = gemini_proxy.build_app(relay)
    transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 5555))
    async with httpx.AsyncClient(transport=transport, base_url="http://relay") as client:
        answer = await client.post(
            "/v1/messages",
            headers={"x-api-key": KEY},
            json={"model": "gemini-2.5-flash", "messages": [{"role": "user", "content": "hi"}]},
        )
        assert answer.status_code == 200 and answer.json()["content"][0]["text"] == "Hi."
        nokey = await client.post("/v1/messages", json={"messages": []})
        assert nokey.status_code == 401
        counted = await client.post(
            "/v1/messages/count_tokens", json={"messages": [{"role": "user", "content": "x" * 400}]}
        )
        assert counted.json()["input_tokens"] >= 100
    remote = httpx.ASGITransport(app=app, client=("10.0.0.9", 5555))
    async with httpx.AsyncClient(transport=remote, base_url="http://relay") as client:
        assert (
            await client.post("/v1/messages", headers={"x-api-key": KEY}, json={})
        ).status_code == 403


async def test_the_server_starts_on_a_free_local_port_and_stops():
    proxy = gemini_proxy.GeminiProxy()
    address = await proxy.start()
    try:
        assert address.startswith("http://127.0.0.1:") and proxy.port > 0
        async with httpx.AsyncClient() as client:
            answer = await client.post(f"{address}/v1/messages/count_tokens", json={"messages": []})
        assert answer.status_code == 200
    finally:
        await proxy.close()
    assert proxy.port == 0


def test_signatures_keep_the_newest():
    sig = Signatures(keep=2)
    for n in range(3):
        sig.put(f"t{n}", f"s{n}")
    assert sig.get("t0") is None and sig.get("t2") == "s2"


@pytest.mark.parametrize("model", ["gemini-2.5-flash", "google/gemini-2.5-pro"])
async def test_the_model_name_reaches_google(model):
    relay, seen = fake_google(reply={"candidates": [{"content": {"parts": [{"text": "OK."}]}}]})
    await relay.messages(KEY, {"model": model, "messages": [{"role": "user", "content": "hi"}]})
    assert f"/models/{model.removeprefix('google/')}:" in seen[0][0]


def test_a_call_gemini_never_made_carries_googles_stand_in_signature():
    """History from Claude (before the fallback took over) has no Gemini signatures, and
    Gemini 3 turns a request down over one missing."""
    body = {
        "messages": [
            {"role": "user", "content": "Look at my screen"},
            {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "toolu_c", "name": "see_screen", "input": {}}
                ],
            },
            {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "toolu_c", "content": "ok"}],
            },
        ]
    }
    call = to_gemini(body, Signatures())["contents"][1]["parts"][0]
    assert call["thoughtSignature"] == gemini_proxy.FOREIGN_SIGNATURE


@pytest.mark.parametrize(
    ("model", "extra", "level"),
    [
        ("gemini-flash-latest", {}, "low"),  # JARVIS's voice turns: thinking off
        ("gemini-3.8-flash", {"thinking": {"type": "disabled"}}, "low"),
        ("gemini-pro-latest", {"thinking": {"type": "enabled", "budget_tokens": 16000}}, None),
        ("gemini-flash-latest", {"output_config": {"effort": "high"}}, None),
        # Eden Code's own effort (the session's, or Model Router's pick), below high:
        (
            "gemini-3.8-flash",
            {"thinking": {"type": "adaptive"}, "output_config": {"effort": "low"}},
            "low",
        ),
        (
            "gemini-3.8-flash",
            {"thinking": {"type": "adaptive"}, "output_config": {"effort": "medium"}},
            "medium",
        ),
        (
            "gemini-3.8-flash",
            {"thinking": {"type": "adaptive"}, "output_config": {"effort": "xhigh"}},
            None,
        ),
        (
            "gemini-pro-latest",
            {"thinking": {"type": "adaptive"}, "output_config": {"effort": "low"}},
            None,
        ),
        ("gemini-pro-latest", {}, None),  # Pro thinking lightly leaks stray words
        ("gemini-2.5-flash", {}, None),  # older models take no level
        ("gemma-4-31b-it", {}, None),
    ],
)
def test_thinking_follows_what_the_request_asked_for(model, extra, level):
    body = {"model": model, "messages": [{"role": "user", "content": "hi"}], **extra}
    config = to_gemini(body)["generationConfig"].get("thinkingConfig")
    assert config == ({"thinkingLevel": level} if level else None)


def test_a_retired_model_has_a_successor_in_its_family():
    assert gemini_proxy.successor("gemini-2.5-flash") == "gemini-flash-latest"
    assert gemini_proxy.successor("gemini-2.5-flash-lite") == "gemini-flash-lite-latest"
    assert gemini_proxy.successor("gemini-3.1-pro-preview") == "gemini-pro-latest"
    assert gemini_proxy.successor("gemini-pro-latest") is None
    assert gemini_proxy.successor("gemma-4-31b-it") is None


async def test_a_retired_model_is_answered_by_the_newest_of_its_family():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if "gemini-2.5-flash:" in str(request.url):
            return httpx.Response(
                404,
                json={
                    "error": {
                        "message": "This model models/gemini-2.5-flash is no longer "
                        "available to new users."
                    }
                },
            )
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "OK."}]}}]})

    relay = GeminiRelay(httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    status, body, _ = await relay.messages(
        KEY, {"model": "gemini-2.5-flash", "messages": [{"role": "user", "content": "hi"}]}
    )
    assert status == 200 and body["content"][0]["text"] == "OK."
    assert "/models/gemini-flash-latest:" in seen[-1]
