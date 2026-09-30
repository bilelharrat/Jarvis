"""Subagent lanes (codelanes, features.code_lanes): Agent calls as a tree with their steps,
tokens, time and estimated cost, background ones ending as tasks, and Stop for one
subagent through Claude Code's stop_task."""

import asyncio

from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TaskNotificationMessage,
    TaskProgressMessage,
    TaskStartedMessage,
    TaskUpdatedMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from code_session_fakes import end_all, events_of, make_hub, until
from conftest import FakeClient

from jarvis import codelanes
from jarvis.codelanes import Lanes, rates_from, weighted
from jarvis.tasks import describe_tool

HAIKU = "claude-haiku-4-5"


def agent_call(tool_id, parent=None, **tool_input):
    tool_input = {"subagent_type": "Explore", "description": "Find the auth code", **tool_input}
    return AssistantMessage(
        content=[ToolUseBlock(id=tool_id, name="Agent", input=tool_input)],
        model="claude-opus-5-5",
        parent_tool_use_id=parent,
    )


def step(parent, tool_id, message_id, name="Read", **usage):
    usage = {"input_tokens": 1000, "output_tokens": 100, "cache_read_input_tokens": 5000, **usage}
    return AssistantMessage(
        content=[ToolUseBlock(id=tool_id, name=name, input={"file_path": "/p/auth.py"})],
        model=HAIKU,
        parent_tool_use_id=parent,
        usage=usage,
        message_id=message_id,
    )


def started(tool_id, task_id, **data):
    return TaskStartedMessage(
        subtype="task_started",
        data={"subagent_type": "Explore", **data},
        task_id=task_id,
        description="Find the auth code",
        uuid="u",
        session_id="s",
        tool_use_id=tool_id,
        task_type="local_agent",
    )


def result_with(model_usage):
    return ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id="s",
        total_cost_usd=0.5,
        model_usage=model_usage,
    )


def test_rates_come_from_each_model_s_cost_and_tokens():
    rates = rates_from({
        HAIKU: {"inputTokens": 1000, "outputTokens": 100, "cacheReadInputTokens": 5000,
                "cacheCreationInputTokens": 0, "costUSD": 0.0035, "webSearchRequests": 0},
        "claude-opus-5-5": {"inputTokens": 100, "outputTokens": 0, "costUSD": 0.03, "webSearchRequests": 2},
        "free": {"inputTokens": 5, "costUSD": 0},
        "junk": "nope",
    })  # fmt: skip
    assert rates[HAIKU] == 0.0035 / (1000 + 500 + 500)
    assert rates["claude-opus-5-5"] == (0.03 - 0.02) / 100  # its web searches aren't tokens
    assert "free" not in rates and "junk" not in rates
    assert rates_from(None) == {} and rates_from("x") == {}
    assert weighted({"input": 10, "output": 2, "cache_write": 4, "cache_read": 10}) == 26.0


def test_a_subagent_s_steps_tokens_and_cost_are_its_own():
    lanes = Lanes()
    assert lanes.take(agent_call("a1"), describe_tool)
    assert lanes.take(started("a1", "t1"), describe_tool)
    lanes.take(step("a1", "r1", "m1"), describe_tool)
    lanes.take(step("a1", "r1b", "m1"), describe_tool)  # the same message's next block
    lanes.take(step("a1", "r2", "m2", name="Grep"), describe_tool)
    lane = lanes.lanes["a1"]
    assert lane.task_id == "t1" and lanes.by_task == {"t1": "a1"}
    assert lane.steps == 3 and lane.last == "Searching for "  # (Grep with no pattern)
    assert lane.usage[HAIKU] == {
        "input": 2000,
        "output": 200,
        "cache_write": 0,
        "cache_read": 10000,
    }
    [shown] = lanes.public()
    assert shown["cost"] is None and shown["can_stop"] and shown["tokens"] == 12200
    lanes.take(
        TaskProgressMessage(subtype="task_progress", data={}, task_id="t1", description="",
                            usage={"total_tokens": 15000, "tool_uses": 4, "duration_ms": 6500},
                            uuid="u", session_id="s", tool_use_id="a1", last_tool_name="Grep"),
        describe_tool,
    )  # fmt: skip
    lanes.take(
        result_with(
            {
                HAIKU: {
                    "inputTokens": 2000,
                    "outputTokens": 200,
                    "cacheReadInputTokens": 10000,
                    "costUSD": 0.004,
                }
            }
        ),
        describe_tool,
    )
    [shown] = lanes.public()
    assert shown["tokens"] == 15000 and shown["steps"] == 4 and shown["seconds"] == 6.5
    assert shown["cost"] == 0.004 and shown["models"] == [HAIKU]
    lanes.take(
        UserMessage(content=[ToolResultBlock(tool_use_id="a1", content="found it")],
                    tool_use_result={"totalTokens": 16000, "totalToolUseCount": 5, "totalDurationMs": 7000}),
        describe_tool,
    )  # fmt: skip
    [shown] = lanes.public()
    assert shown["status"] == "done" and not shown["can_stop"]
    assert (shown["tokens"], shown["steps"], shown["seconds"]) == (16000, 5, 7.0)


def test_lanes_nest_under_the_subagent_that_started_them():
    lanes = Lanes()
    lanes.take(agent_call("a1"), describe_tool)
    lanes.take(agent_call("a2", parent="a1", subagent_type="test-runner"), describe_tool)
    lanes.take(agent_call("a3", parent="ghost"), describe_tool)  # under no lane known here
    by_id = {lane["id"]: lane for lane in lanes.public()}
    assert by_id["a2"]["parent"] == "a1" and by_id["a2"]["agent"] == "test-runner"
    assert by_id["a3"]["parent"] == ""
    assert lanes.lanes["a1"].steps == 1  # starting a subagent is one of its steps


def test_a_background_subagent_ends_as_a_task_and_a_stopped_one_says_so():
    lanes = Lanes()
    lanes.take(agent_call("a1", run_in_background=True), describe_tool)
    lanes.take(started("a1", "t1", is_backgrounded=True), describe_tool)
    lanes.take(
        UserMessage(content=[ToolResultBlock(tool_use_id="a1", content="Launched")]), describe_tool
    )
    assert lanes.lanes["a1"].status == "running"  # launching isn't its end
    lanes.take(
        TaskNotificationMessage(subtype="task_notification", data={}, task_id="t1", status="completed",
                                output_file="", summary="done", uuid="u", session_id="s"),
        describe_tool,
    )  # fmt: skip
    assert lanes.lanes["a1"].status == "done"
    lanes.take(agent_call("a2"), describe_tool)
    lanes.take(started("a2", "t2"), describe_tool)
    lanes.take(
        TaskUpdatedMessage(
            subtype="task_updated",
            data={},
            task_id="t2",
            patch={"status": "killed"},
            status="killed",
        ),
        describe_tool,
    )
    assert lanes.lanes["a2"].status == "stopped"
    lanes.take(
        UserMessage(content=[ToolResultBlock(tool_use_id="a2", content="stopped", is_error=True)]),
        describe_tool,
    )
    assert lanes.lanes["a2"].status == "stopped"  # (its end was already known)


def test_only_so_many_lanes_are_kept_the_oldest_finished_first(monkeypatch):
    monkeypatch.setattr(codelanes, "LANES_KEPT", 3)
    lanes = Lanes()
    for n in range(3):
        lanes.take(agent_call(f"a{n}"), describe_tool)
        lanes.take(started(f"a{n}", f"t{n}"), describe_tool)
    lanes.take(
        UserMessage(content=[ToolResultBlock(tool_use_id="a1", content="ok")]), describe_tool
    )
    lanes.take(agent_call("a3"), describe_tool)
    assert list(lanes.lanes) == ["a0", "a2", "a3"] and "t1" not in lanes.by_task


# ── in a session ──


class AgentStream(FakeClient):
    """A turn that hands work to a subagent and waits (the subagent is still at work)."""

    instances: list = []

    def __init__(self, options=None):
        super().__init__(options)
        self.stopped = []
        AgentStream.instances.append(self)

    async def query(self, text):
        self.queries.append(text)
        for m in (
            UserMessage(content=str(text), uuid="u-1"),
            agent_call("a1"),
            started("a1", "t1"),
            step("a1", "r1", "m1"),
        ):
            self._stream().put_nowait(m)

    async def stop_task(self, task_id):
        self.stopped.append(task_id)
        self._stream().put_nowait(
            TaskUpdatedMessage(
                subtype="task_updated",
                data={},
                task_id=task_id,
                patch={"status": "killed"},
                status="killed",
            )
        )
        self._stream().put_nowait(
            UserMessage(
                content=[ToolResultBlock(tool_use_id="a1", content="Stopped", is_error=True)]
            )
        )
        self._stream().put_nowait(
            AssistantMessage(content=[TextBlock(text="It was stopped.")], model="m")
        )
        self._stream().put_nowait(result_with({HAIKU: {"inputTokens": 1000, "costUSD": 0.001}}))


async def test_a_subagent_is_stopped_on_its_own_and_the_session_goes_on(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    AgentStream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated, client=AgentStream)
    seen = events_of(hub)
    task = hub.tasks.start("look around", "proj")
    assert await until(
        lambda: (
            hub.code_lanes.sessions.get(task.id)
            and hub.code_lanes.sessions[task.id].lanes.get("a1")
            and hub.code_lanes.sessions[task.id].lanes["a1"].task_id
        )
    )
    client = AgentStream.instances[0]
    assert client.options.forward_subagent_text is True
    await hub._handle({"type": "cl_lanes", "id": task.id})
    shown = [e for e in seen() if e["type"] == "cl_lanes"][-1]
    assert shown["id"] == task.id and shown["lanes"][0]["status"] == "running"
    assert shown["lanes"][0]["can_stop"] and shown["lanes"][0]["last"] == "Reading auth.py"
    await hub._handle({"type": "cl_stop", "id": task.id, "lane": "a1"})  # (in the background)
    assert await until(lambda: client.stopped == ["t1"])
    assert await until(lambda: not task.busy)
    lane = hub.code_lanes.sessions[task.id].lanes["a1"]
    assert lane.status == "stopped"
    assert any(e.get("text") == "Stopped that subagent." for e in task.transcript)
    await hub._handle({"type": "cl_stop", "id": task.id, "lane": "a1"})  # not running now
    await asyncio.sleep(0.05)
    assert client.stopped == ["t1"]
    await end_all(hub)


async def test_a_broken_sink_never_stops_a_session(settings, quiet_speaker, isolated, tmp_path):
    from code_session_fakes import Stream

    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    heard = []

    def broken(*_args):
        raise RuntimeError("a feature's bug")

    hub.tasks.message_sinks[:0] = [broken]
    hub.tasks.message_sinks.append(lambda task, message: heard.append(type(message).__name__))
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.cost_usd == 0.1 and not task.busy)
    assert heard[-1] == "ResultMessage" and "AssistantMessage" in heard
    assert Stream.instances[0].said == ["one"]
    await end_all(hub)


def test_its_transcript_notes_have_chinese_in_the_window():
    import re

    from jarvis.features import code_lanes
    from jarvis.server import zh_strings

    zh = zh_strings()
    for note in [code_lanes.STOPPED, code_lanes.NOT_STOPPED.format(error="it had ended")]:
        assert note in zh["strings"] or any(re.fullmatch(p, note) for p, _ in zh["patterns"])
