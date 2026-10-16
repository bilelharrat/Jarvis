"""Eden Code's OpenTelemetry export (code_otel, features/code_otel): OTLP/HTTP JSON spans
for each turn, step and subagent, events for sessions and turns, tokens and cost, to the
owner's collector only, off by default, never file contents, steps' inputs or outputs, or
keys; prompts only when the owner opts in, secrets blanked."""

import json

import pytest
from claude_agent_sdk import ResultMessage
from code_session_fakes import Stream, end_all, make_hub, until

from jarvis import code_otel as otel
from jarvis.tasks import ClaudeTask

KEY = "sk-ant-api03-" + "A1b2C3d4" * 6


def test_endpoints_take_a_base_or_a_signal_address_and_plain_http_only_nearby():
    assert otel.endpoints("http://localhost:4318") == (
        "http://localhost:4318/v1/traces",
        "http://localhost:4318/v1/logs",
    )
    assert otel.endpoints("https://otel.example.com/otlp/v1/traces/") == (
        "https://otel.example.com/otlp/v1/traces",
        "https://otel.example.com/otlp/v1/logs",
    )
    assert otel.endpoints("http://192.168.1.20:4318")[0].endswith("/v1/traces")
    assert otel.endpoints("http://[::1]:4318") is not None
    for bad in ("", "otel.example.com", "http://otel.example.com", "ftp://localhost",
                "https://user:pw@otel.example.com", "https://x.com:99999", "http://localhost /x"):  # fmt: skip
        assert otel.endpoints(bad) is None, bad


def test_headers_come_only_from_the_standard_environment_variable(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_HEADERS", "x-honeycomb-team=abc%3D1, bad key=1,api-key=z")
    assert otel.env_headers() == {"x-honeycomb-team": "abc=1", "api-key": "z"}
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_HEADERS")
    assert otel.env_headers() == {}


def test_spans_are_otlp_json():
    span = otel.Span("execute_tool Bash", "a" * 32, parent_id="b" * 16, attrs={"n": 3, "ok": True, "x": 1.5})
    span.event("e", {"k": "v"})
    out = span.finish("tool_error").otlp()
    assert out["traceId"] == "a" * 32 and out["parentSpanId"] == "b" * 16 and len(out["spanId"]) == 16
    assert out["status"]["code"] == otel.STATUS_ERROR
    attrs = {a["key"]: a["value"] for a in out["attributes"]}
    assert attrs["n"] == {"intValue": "3"} and attrs["ok"] == {"boolValue": True}
    assert attrs["error.type"] == {"stringValue": "tool_error"}
    assert int(out["endTimeUnixNano"]) >= int(out["startTimeUnixNano"])
    body = otel.traces_body([span], "1.2")
    res = {a["key"]: a["value"]["stringValue"] for a in body["resourceSpans"][0]["resource"]["attributes"]}
    assert res["service.name"] == "eden-code" and res["service.version"] == "1.2"
    assert "host.name" not in res and "user.name" not in res


class Collector:
    """urllib's opener stand-in: every request it got, as (path, body)."""

    def __init__(self):
        self.got, self.down = [], False

    def __call__(self, request, timeout=10):
        if self.down:
            raise OSError("connection refused")
        self.got.append((request.full_url, json.loads(request.data), dict(request.headers)))

        class Answer:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        return Answer()

    def spans(self):
        return [s for url, body, _ in self.got if url.endswith("/v1/traces")
                for r in body["resourceSpans"] for sc in r["scopeSpans"] for s in sc["spans"]]  # fmt: skip

    def events(self):
        return [r for url, body, _ in self.got if url.endswith("/v1/logs")
                for rl in body["resourceLogs"] for sl in rl["scopeLogs"] for r in sl["logRecords"]]  # fmt: skip


def attrs(span):
    return {a["key"]: next(iter(a["value"].values())) for a in span["attributes"]}


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    made = make_hub(settings, quiet_speaker, isolated)
    made.code_otel.opener = Collector()
    return made


def result(cost=0.25):
    return ResultMessage(subtype="success", duration_ms=1500, duration_api_ms=1, is_error=False,
                         num_turns=1, session_id="sess-1", total_cost_usd=cost, result="done",
                         usage={"input_tokens": 120, "output_tokens": 40, "cache_read_input_tokens": 900},
                         model_usage={"claude-opus-4-1": {}})  # fmt: skip


def play_a_turn(hub, task):
    t = hub.code_otel
    log = lambda entry: t.on_event("task_log", {"id": task.id, "entry": entry})  # noqa: E731
    log({"role": "user", "text": f"fix the login, key {KEY}"})
    log({"role": "tool", "tool": "Read", "tool_id": "t1", "text": "Reading /Users/owner/secret/a.py",
         "detail": "file contents here"})  # fmt: skip
    log({"role": "tool", "tool": "Agent", "tool_id": "t2", "agent": "Explore", "detail": "find it"})
    log({"role": "subtool", "tool": "Grep", "parent": "t2"})
    t.on_event("task_log_update", {"id": task.id, "tool_id": "t1", "status": "failed", "output": "x"})
    t.on_event("task_log_update", {"id": task.id, "tool_id": "t2", "status": "done", "output": "y"})
    log({"role": "assistant", "text": "Fixed the login."})
    hub.tasks.on_usage(task, 0.25, result())
    task.session_id = "sess-1"
    log({"role": "turn", "seconds": 2, "tokens": 1060, "cost": 0.25})


async def test_off_by_default_nothing_is_kept_or_sent(hub, tmp_path):
    task = ClaudeTask(id=3, prompt="x", cwd=tmp_path)
    hub.tasks.tasks[3] = task
    play_a_turn(hub, task)
    assert hub.code_otel.spans == [] and hub.code_otel.logs == [] and hub.code_otel.opener.got == []
    assert hub.code_otel.status()["enabled"] is False


async def test_a_turn_is_a_trace_of_its_steps_and_subagents_with_tokens_and_cost(hub, tmp_path):
    hub.set_feature_prefs({"code_otel_endpoint": "http://localhost:4318"})
    task = ClaudeTask(id=3, prompt="x", cwd=tmp_path, model="opus", mode="edits")
    hub.tasks.tasks[3] = task
    usage_seen = []
    hub.usage.record = lambda *a, **k: usage_seen.append(a)  # (the Session card's: still called)
    play_a_turn(hub, task)
    collector = hub.code_otel.opener
    assert await until(lambda: len(collector.spans()) == 3 and collector.events())
    assert usage_seen and usage_seen[0][1] == 0.25
    by_name = {s["name"]: s for s in collector.spans()}
    root, read, agent = (by_name["invoke_agent Eden Code"], by_name["execute_tool Read"],
                         by_name["invoke_agent Explore"])  # fmt: skip
    assert read["parentSpanId"] == root["spanId"] == agent["parentSpanId"]
    assert read["traceId"] == root["traceId"] == agent["traceId"]
    r = attrs(root)
    assert r["gen_ai.operation.name"] == "invoke_agent" and r["gen_ai.agent.name"] == "Eden Code"
    assert r["gen_ai.provider.name"] == "anthropic" and r["gen_ai.request.model"] == "opus"
    assert r["gen_ai.response.model"] == "claude-opus-4-1" and r["gen_ai.conversation.id"] == "sess-1"
    assert r["gen_ai.usage.input_tokens"] == "120" and r["gen_ai.usage.output_tokens"] == "40"
    assert r["gen_ai.usage.cache_read.input_tokens"] == "900" and r["eden_code.cost_usd"] == 0.25
    assert read["status"]["code"] == otel.STATUS_ERROR and attrs(read)["gen_ai.tool.call.id"] == "t1"
    assert attrs(agent)["gen_ai.agent.name"] == "Explore"
    assert agent["events"][0]["name"] == "eden_code.subagent.tool"
    names = [e["eventName"] for e in collector.events()]
    assert names == ["eden_code.session.start", "eden_code.turn"]
    # Never the prompt, a reply, a path, a step's input or output, or a key, by default.
    sent = json.dumps([b for _, b, _ in collector.got])
    for private in ("fix the login", "Fixed the login", "/Users/owner", "file contents", KEY, "find it"):
        assert private not in sent, private
    assert hub.code_otel.status()["sent"] == 5 and hub.code_otel.status()["error"] == ""


async def test_prompts_go_only_when_opted_in_with_secrets_blanked(hub, tmp_path):
    hub.set_feature_prefs({"code_otel_endpoint": "http://localhost:4318", "code_otel_prompts": True})
    task = ClaudeTask(id=3, prompt="x", cwd=tmp_path)
    hub.tasks.tasks[3] = task
    play_a_turn(hub, task)
    collector = hub.code_otel.opener
    assert await until(lambda: collector.spans())
    root = next(s for s in collector.spans() if s["name"] == "invoke_agent Eden Code")
    said = json.loads(attrs(root)["gen_ai.input.messages"])
    assert said[0]["role"] == "user" and "fix the login" in said[0]["parts"][0]["content"]
    assert KEY not in json.dumps(collector.got) and "Fixed the login." in attrs(root)["gen_ai.output.messages"]


async def test_a_collector_that_can_t_be_reached_keeps_them_waiting(hub, tmp_path):
    hub.set_feature_prefs({"code_otel_endpoint": "http://localhost:4318"})
    collector = hub.code_otel.opener
    collector.down = True
    task = ClaudeTask(id=3, prompt="x", cwd=tmp_path)
    hub.tasks.tasks[3] = task
    play_a_turn(hub, task)
    assert await until(lambda: hub.code_otel.error and not hub.code_otel.sending)
    assert "Couldn't reach the collector" in hub.code_otel.error
    assert hub.code_otel.status()["waiting"] == 5
    collector.down = False
    play_a_turn(hub, task)
    assert await until(lambda: len(collector.spans()) == 6 and not hub.code_otel.sending)
    assert hub.code_otel.status()["waiting"] == 0 and hub.code_otel.error == ""


async def test_the_settings_test_button_sends_one_span_and_event(hub):
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    await hub.handle({"type": "cw_otel_test"})
    assert await until(lambda: any(k == "code_otel" for k, _ in seen))
    assert [d for k, d in seen if k == "code_otel"][-1]["tested"] is False  # (no endpoint yet)
    hub.set_feature_prefs({"code_otel_endpoint": "https://otel.example.com"})
    await hub.handle({"type": "cw_otel_test"})
    assert await until(lambda: [d for k, d in seen if k == "code_otel"][-1].get("tested") is True)
    assert [u for u, _, _ in hub.code_otel.opener.got] == [
        "https://otel.example.com/v1/traces",
        "https://otel.example.com/v1/logs",
    ]
    # A plain-http address beyond this Mac's network is never kept.
    hub.set_feature_prefs({"code_otel_endpoint": "http://otel.example.com"})
    assert hub.prefs.feature("code_otel_endpoint") == "https://otel.example.com"


async def test_a_real_session_s_turn_is_heard_through_the_hub(settings, quiet_speaker, isolated, tmp_path):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    collector = hub.code_otel.opener = Collector()
    hub.set_feature_prefs({"code_otel_endpoint": "http://127.0.0.1:4318"})
    task = hub.tasks.start("add a retry", "proj")
    assert await until(lambda: any(s["name"] == "invoke_agent Eden Code" for s in collector.spans()))
    root = next(s for s in collector.spans() if s["name"] == "invoke_agent Eden Code")
    assert attrs(root)["eden_code.session.number"] == str(task.id)
    assert attrs(root)["gen_ai.conversation.id"] == "s"
    await end_all(hub)
