"""Jarvis Code sessions at their limits (the stress sweep): messages Claude Code never took
up, crashes with a queue waiting, quitting, a full queue, bursts of switches and changes,
steps past the kept transcript, and more sessions than should stay open."""

import asyncio
import time as _time

from claude_agent_sdk import (
    AssistantMessage,
    StreamEvent,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from test_tasks import StreamClient, res, stream_manager, until
from test_tasks import manager as plain_manager

from jarvis import tasks as tasks_mod
from jarvis.tasks import ClaudeTask


class Scripted(StreamClient):
    """Claude Code as the sweep saw it. hold: the first connection's first step runs a
    tool that doesn't end here; a message sent into it waits inside Claude Code until the
    step ends (release()) or an interrupt drops it. The stream can end cleanly ("__END__")
    or with an error, as the CLI exiting or crashing does."""

    hold = True
    connecting = 0
    most_connecting = 0
    connect_delay = 0.0

    def __init__(self, options=None):
        super().__init__(options)
        self.running, self.waiting = False, []

    async def __aenter__(self):
        Scripted.connecting += 1
        Scripted.most_connecting = max(Scripted.most_connecting, Scripted.connecting)
        try:
            if self.connect_delay:
                await asyncio.sleep(self.connect_delay)
            return await super().__aenter__()
        finally:
            Scripted.connecting -= 1

    async def query(self, text):
        if self.running:  # mid-step: Claude Code keeps it for after the step
            self.queries.append(text)
            self.waiting.append(text)
            return
        if not (self.hold and self is StreamClient.instances[0] and not self.queries):
            return await super().query(text)
        self.queries.append(text)
        self.running = True
        self._stream().put_nowait(UserMessage(content=str(text), uuid="u-job"))
        self._stream().put_nowait(
            AssistantMessage(
                content=[ToolUseBlock(id="b1", name="Bash", input={"command": "sleep 60"})],
                model="m",
            )
        )

    async def receive_messages(self):
        while True:
            item = await self._stream().get()
            if isinstance(item, Exception):
                raise item
            if item == "__END__":
                return
            yield item

    async def interrupt(self):
        # The step stops, and what was waiting in Claude Code is dropped (never replayed).
        self.running, self.waiting = False, []
        self._stream().put_nowait(res("", 0.01, reason="aborted_streaming"))


def manager(settings, client=Scripted):
    Scripted.connecting = Scripted.most_connecting = 0
    return stream_manager(settings, client)


async def _steered(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, events = manager(settings)
    tm.steer_now = lambda: True
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    tm.send(task.id, "run the slow thing")
    assert await until(lambda: task.busy and task.current == "user")
    tm.send(task.id, "and update the docs")  # into the running step
    assert await until(lambda: len(StreamClient.instances[0].queries) == 2)
    assert task.steered == 1
    return tm, task


async def test_a_steered_message_is_queued_once_when_its_write_fails_as_the_session_ends(
    settings, tmp_path
):
    class BlockedSteer(Scripted):
        """The steered message's write is still going (a big picture) when End is pressed,
        and then fails: the connection's end has already put it back in the queue."""

        async def query(self, text):
            if self is StreamClient.instances[0] and self.running:
                self.queries.append(text)
                self.unblock = asyncio.Event()
                await self.unblock.wait()
                raise ConnectionError("stdin closed")
            return await super().query(text)

        async def __aexit__(self, *exc):
            if getattr(self, "unblock", None):
                self.unblock.set()
            await asyncio.sleep(0.01)
            return await super().__aexit__(*exc)

    (tmp_path / "proj").mkdir()
    tm, _events = manager(settings, BlockedSteer)
    tm.steer_now = lambda: True
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    tm.send(task.id, "run the slow thing")
    assert await until(lambda: task.busy and task.current == "user")
    tm.send(task.id, "and update the docs")  # into the running step; its write hangs
    assert await until(lambda: len(StreamClient.instances[0].queries) == 2)
    tm.cancel(task.id)
    assert await until(lambda: task.handle.done())
    await asyncio.sleep(0.05)
    assert [i["text"] for i in task.inbox.public()] == ["and update the docs"]  # once


async def test_after_an_hour_idle_a_steer_never_taken_up_is_noted_not_sent(
    settings, tmp_path, monkeypatch
):
    monkeypatch.setattr(tasks_mod, "IDLE_CLOSE_SECONDS", 0.3)
    tm, task = await _steered(settings, tmp_path)
    await tm.interrupt(task.id)
    assert await until(lambda: task.status == "closed", tries=400)
    await asyncio.sleep(0.1)
    assert len(StreamClient.instances) == 1  # it never opened again to send it unasked
    assert task.inbox.empty()
    notes = [e["text"] for e in task.transcript if e["role"] == "system"]
    assert any("not sent: and update the docs" in n for n in notes)


class Crashes(Scripted):
    """The first connection's step crashes (or the CLI exits) while a follow-up waits."""

    ending: object = None

    async def query(self, text):
        if self is not StreamClient.instances[0]:
            return await StreamClient.query(self, text)
        self.queries.append(text)
        self._stream().put_nowait(UserMessage(content=str(text), uuid="u-1"))
        if Crashes.ending is not None:
            self._stream().put_nowait(Crashes.ending)


async def test_a_queued_follow_up_goes_after_claude_code_crashes_or_exits(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    for ending in (RuntimeError("CLI process exited with code 1"), "__END__"):
        Crashes.ending = None
        tm, _ = manager(settings, Crashes)
        task = tm.start("", "proj")
        assert await until(lambda t=task: t.status == "waiting")
        tm.send(task.id, "long job")
        assert await until(lambda t=task: t.busy)
        tm.send(task.id, "then the docs")  # waits behind it
        StreamClient.instances[0]._stream().put_nowait(ending)
        assert await until(lambda: len(StreamClient.instances) == 2, tries=600)
        second = StreamClient.instances[1]
        assert await until(lambda s=second, t=task: s.queries == ["then the docs"] and not t.busy)
        tm.cancel(task.id)
        await asyncio.sleep(0.02)


async def test_a_session_that_crashes_every_time_is_not_reopened_forever(settings, tmp_path):
    (tmp_path / "proj").mkdir()

    class AlwaysCrashes(Scripted):
        async def query(self, text):
            self.queries.append(text)
            self._stream().put_nowait(RuntimeError("CLI process exited with code 1"))

    tm, _ = manager(settings, AlwaysCrashes)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    tm.send(task.id, "a")
    tm.send(task.id, "b")
    tm.send(task.id, "c")
    assert await until(lambda: task.status == "failed" and task.handle.done(), tries=600)
    await asyncio.sleep(0.1)
    assert len(StreamClient.instances) == 1 + tasks_mod.AUTO_RESTARTS
    assert task.status == "failed" and not task.inbox.empty()  # it waits for the user now


async def test_quitting_never_opens_a_session_again(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = manager(settings)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    tm.send(task.id, "run the slow thing")
    assert await until(lambda: task.busy)
    tm.send(task.id, "then the docs")  # queued behind it
    await tm.close()  # the app quits
    await asyncio.sleep(0.1)
    assert len(StreamClient.instances) == 1 and task.handle.done()
    assert task.status == "stopped"


async def test_a_message_claude_code_never_took_up_goes_again(settings, tmp_path):
    (tmp_path / "proj").mkdir()

    class ExitsOnIt(Crashes):
        async def query(self, text):
            if self is not StreamClient.instances[0]:
                return await StreamClient.query(self, text)
            self.queries.append(text)
            self._stream().put_nowait("__END__")  # took nothing up, just went

    class WriteFails(Crashes):
        async def query(self, text):
            if self is StreamClient.instances[0]:
                raise ConnectionError("Cannot write to terminated process")
            return await StreamClient.query(self, text)

    for client in (ExitsOnIt, WriteFails):
        tm, _ = manager(settings, client)
        task = tm.start("", "proj")
        assert await until(lambda t=task: t.status == "waiting")
        tm.send(task.id, "are you there?")
        assert await until(lambda: len(StreamClient.instances) == 2, tries=600)
        second = StreamClient.instances[1]
        assert await until(lambda s=second, t=task: s.queries == ["are you there?"] and not t.busy)
        tm.cancel(task.id)
        await asyncio.sleep(0.02)


async def test_the_queue_has_a_cap_and_the_list_carries_only_its_head(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, events = manager(settings)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    tm.send(task.id, "run the slow thing")
    assert await until(lambda: task.busy)
    sent = [tm.send(task.id, f"msg {i} " + "q" * 3000) for i in range(tasks_mod.MAX_QUEUED + 5)]
    assert sent.count(True) == tasks_mod.MAX_QUEUED and sent[-1] is False
    row = task.public()
    assert row["queued"] == tasks_mod.MAX_QUEUED
    assert len(row["queue"]) == tasks_mod.QUEUE_SHOWN and len(row["queue"][0]["text"]) == 500
    assert any("already waiting" in e["text"] for e in task.transcript if e["role"] == "system")
    tm.cancel(task.id)


class _HeldClock:
    """The clock tasks.py reads. Held, it shows the time the test sets, however long a busy
    Mac takes between two steps (a session that woke a quarter second after a change, the
    process paused in between, found the burst over and reopened mid-burst). Let go, it
    runs with the real clock from where it was held."""

    def __init__(self):
        self.held: float | None = None
        self.behind = 0.0

    def hold(self) -> None:
        self.held = self.monotonic()

    def let_go(self) -> None:
        self.behind = _time.monotonic() - self.held
        self.held = None

    def monotonic(self) -> float:
        return self.held if self.held is not None else _time.monotonic() - self.behind

    def __getattr__(self, name):
        return getattr(_time, name)


async def test_a_burst_of_menu_changes_reopens_once_and_changes_that_cancel_out_dont(
    settings, tmp_path, monkeypatch
):
    monkeypatch.setattr(tasks_mod, "REOPEN_QUIET", 0.2)
    clock = _HeldClock()
    monkeypatch.setattr(tasks_mod, "time", clock)
    (tmp_path / "proj").mkdir()
    tm, _ = manager(settings)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    clock.hold()
    for i in range(60):  # a connector toggled over and over, 10 ms apart
        clock.held += 0.01
        tm.set_mcp(task.id, f"srv{i % 5}", i % 2 == 1)
        await asyncio.sleep(0.01)
    clock.let_go()
    assert await until(lambda: len(StreamClient.instances) == 2, tries=400)
    await asyncio.sleep(0.4)
    assert len(StreamClient.instances) == 2  # one reopen for the whole burst
    for i in range(200):  # off, on, off, on...: ends as it began
        tm.set_mcp(task.id, "github", i % 2 == 1)
    await asyncio.sleep(0.5)
    assert len(StreamClient.instances) == 2 and not task.reopen
    tm.cancel(task.id)


async def test_a_burst_of_mode_switches_sends_one_at_a_time_and_ends_on_the_last(
    settings, tmp_path
):
    (tmp_path / "proj").mkdir()

    class SlowModes(Scripted):
        hold = False
        in_flight = 0
        most = 0

        async def set_permission_mode(self, mode):
            SlowModes.in_flight += 1
            SlowModes.most = max(SlowModes.most, SlowModes.in_flight)
            await asyncio.sleep(0.01)
            SlowModes.in_flight -= 1
            await super().set_permission_mode(mode)

    tm, _ = manager(settings, SlowModes)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    for i in range(1000):
        tm.set_mode(task.id, ("ask", "plan")[i % 2])
    assert await until(lambda: not task.applying_mode)
    assert SlowModes.most == 1 and len(task.client.modes) <= 3
    assert task.client.modes[-1] == tasks_mod.SDK_MODES[task.mode] == "plan"
    tm.cancel(task.id)


async def test_a_result_past_the_kept_transcript_still_reaches_the_window(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, events = manager(settings)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    push = task.client._stream().put_nowait
    push(AssistantMessage(content=[ToolUseBlock(id="t-agent", name="Agent",
                                                input={"description": "big job"})], model="m"))  # fmt: skip
    for i in range(450):  # the agent's own steps push its card out of the kept 400
        push(AssistantMessage(content=[ToolUseBlock(id=f"s{i}", name="Read",
                                                    input={"file_path": f"f{i}.py"})],
                              model="m", parent_tool_use_id="t-agent"))  # fmt: skip
    push(
        UserMessage(content=[ToolResultBlock(tool_use_id="t-agent", content="boom", is_error=True)])
    )
    assert await until(lambda: any(k == "task_log_update" for k, _ in events))
    update = next(d for k, d in events if k == "task_log_update")
    assert update["tool_id"] == "t-agent" and update["status"] == "failed"
    tm.cancel(task.id)


def test_finished_background_tasks_are_remembered_boundedly(settings, tmp_path):
    from claude_agent_sdk import TaskUpdatedMessage

    tm, _ = manager(settings)
    task = tasks_mod.ClaudeTask(id=1, prompt="", cwd=tmp_path)
    for i in range(2000):
        tm._on_task_message(task, TaskUpdatedMessage(subtype="task_updated", data={},
                                                     task_id=f"bg{i}", patch={}, status="killed",
                                                     session_id="s", uuid=f"x{i}"))  # fmt: skip
    assert len(task.finished_background) == 500 and "bg1999" in task.finished_background


async def test_a_burst_of_changes_is_one_update_of_the_list(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, events = manager(settings)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    await asyncio.sleep(0.2)
    before = sum(1 for k, _ in events if k == "tasks")
    push = task.client._stream().put_nowait
    for i in range(200):  # a busy turn: a step every millisecond
        push(AssistantMessage(content=[ToolUseBlock(id=f"t{i}", name="Read",
                                                    input={"file_path": f"f{i}.py"})], model="m"))  # fmt: skip
    await asyncio.sleep(0.3)
    updates = [d for k, d in events if k == "tasks"][before:]
    assert 1 <= len(updates) <= 5  # not 200
    assert updates[-1]["items"][0]["last_action"] == "Reading f199.py"  # the last one is current
    tm.cancel(task.id)


async def test_open_sessions_are_capped_and_the_closed_ones_resume(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(tasks_mod, "MAX_CONNECTED", 3)
    monkeypatch.setattr(tasks_mod, "ROOM_IDLE", 0.0)
    for i in range(6):
        (tmp_path / f"p{i}").mkdir()
    tm, _ = manager(settings)
    started = []
    for i in range(6):
        task = tm.start("", f"p{i}")
        assert await until(lambda t=task: t.status == "waiting")
        started.append(task)
    assert await until(lambda: sum(t.client is not None for t in started) <= 3)
    closed = [t for t in started if t.status == "closed"]
    assert [t.id for t in closed] == [t.id for t in started[:3]]  # the longest idle went
    old = closed[0]
    tm.send(old.id, "carry on")  # it comes back, and another idle one makes room
    assert await until(lambda: old.client is not None and not old.busy and old.result)
    assert await until(lambda: sum(t.client is not None for t in started) <= 3)
    for t in started:
        tm.cancel(t.id)


async def test_sessions_opened_together_with_a_request_are_capped_once_idle_a_while(
    settings, tmp_path, monkeypatch
):
    # The usual way in: sessions opened at once, each with a request, answer and go idle.
    monkeypatch.setattr(tasks_mod, "MAX_CONNECTED", 3)
    monkeypatch.setattr(tasks_mod, "ROOM_IDLE", 0.3)
    monkeypatch.setattr(tasks_mod, "SPAWN_WINDOW", 0.01)
    for i in range(6):
        (tmp_path / f"p{i}").mkdir()
    tm, _ = manager(settings, StreamClient)
    started = [tm.start(f"look at p{i}", f"p{i}") for i in range(6)]
    assert await until(lambda: all(t.result and not t.busy for t in started), tries=600)
    assert sum(t.client is not None for t in started) == 6  # just answered: none closes yet
    assert await until(lambda: sum(t.client is not None for t in started) <= 3, tries=400)
    closed = [t for t in started if t.status == "closed"]
    assert len(closed) == 3
    assert all(
        any("Closed to make room" in e["text"] for e in t.transcript if e["role"] == "system")
        for t in closed
    )
    for t in started:
        tm.cancel(t.id)


async def test_sessions_busy_turn_after_turn_never_close_for_room(settings, tmp_path, monkeypatch):
    # Over the cap but at work: each goes idle only between turns, and none is closed then.
    monkeypatch.setattr(tasks_mod, "MAX_CONNECTED", 2)
    monkeypatch.setattr(tasks_mod, "SPAWN_WINDOW", 0.01)
    for i in range(4):
        (tmp_path / f"p{i}").mkdir()
    tm, _ = manager(settings, StreamClient)
    started = [tm.start(f"step 0 in p{i}", f"p{i}") for i in range(4)]
    for n in range(1, 6):
        assert await until(lambda: all(t.result and not t.busy for t in started), tries=600)
        for t in started:
            tm.send(t.id, f"step {n}")
    assert await until(lambda: all(not t.busy and t.inbox.empty() for t in started), tries=600)
    assert len(StreamClient.instances) == 4  # never reopened: each kept its connection
    for t in started:
        tm.cancel(t.id)


async def test_a_burst_of_sessions_starts_a_few_claude_codes_a_second(
    settings, tmp_path, monkeypatch
):
    monkeypatch.setattr(tasks_mod, "SPAWN_WINDOW", 0.1)
    for i in range(10):
        (tmp_path / f"p{i}").mkdir()
    started_at = []

    class Timed(Scripted):
        hold = False

        async def __aenter__(self):
            started_at.append(asyncio.get_running_loop().time())
            return await super().__aenter__()

    tm, _ = manager(settings, Timed)
    started = [tm.start("", f"p{i}") for i in range(10)]
    assert await until(lambda: len(started_at) == 10, tries=600)
    for i, t0 in enumerate(started_at):  # never more than 3 in any 0.1 s
        assert sum(1 for t in started_at[i:] if t - t0 < 0.099) <= tasks_mod.CONNECTS_PER_SECOND
    for t in started:
        tm.cancel(t.id)


async def test_a_picture_with_no_words_never_goes_as_the_keyword_alone(settings, tmp_path):
    (tmp_path / "proj").mkdir()

    class Plain(Scripted):
        hold = False

        async def query(self, text):
            if not isinstance(text, str):
                items = [m async for m in text]
                text = items[0]["message"]["content"][-1]["text"]
            return await super().query(text)

    tm, _ = manager(settings, Plain)
    task = tm.start("", "proj", ultracode=True)
    assert await until(lambda: task.status == "waiting")
    tm.send(task.id, "", [{"media_type": "image/png", "data": "iVBORw0KGgo=", "name": "a.png"}])
    assert await until(lambda: task.client.queries and not task.busy)
    assert task.client.queries[-1] == "Take a look at this."
    tm.send(
        task.id, "why is this red?", [{"media_type": "image/png", "data": "iVBO", "name": "b.png"}]
    )
    assert await until(lambda: len(task.client.queries) == 2 and not task.busy)
    assert task.client.queries[-1] == "why is this red?\n\nultracode"
    tm.cancel(task.id)


async def test_the_brain_hears_why_a_follow_up_was_not_sent(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(tasks_mod, "MAX_QUEUED", 1)
    (tmp_path / "proj").mkdir()
    tm, _ = manager(settings)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    tm.send(task.id, "run the slow thing")
    assert await until(lambda: task.busy)
    tm.send(task.id, "then the docs")
    handler = {t.name: t for t in _tools(tm)}["message_claude_task"]
    out = await handler.handler({"task_id": task.id, "message": "and the changelog"})
    assert "already waiting" in out["content"][0]["text"] and out["is_error"]
    tm.cancel(task.id)


def _tools(tm):
    """The SDK tool objects build_server hands to create_sdk_mcp_server."""
    captured = {}
    real = tasks_mod.create_sdk_mcp_server
    tasks_mod.create_sdk_mcp_server = lambda **kw: captured.update(kw)
    try:
        tm.build_server()
    finally:
        tasks_mod.create_sdk_mcp_server = real
    return captured["tools"]


async def test_a_model_claude_code_refuses_is_never_shown_as_the_sessions(settings, tmp_path):
    (tmp_path / "proj").mkdir()

    class Refuses(StreamClient):
        async def set_model(self, model):
            raise RuntimeError(f"model {model} isn't available")

    tm, _events = stream_manager(settings, Refuses)
    task = tm.start("", "proj", model="claude-opus-5-5")
    assert await until(lambda: task.status == "waiting")
    assert not await tm.set_model(task.id, "claude-fable-9", "Fable")
    row = next(t for t in tm.public() if t["id"] == task.id)
    assert task.model == row["model"] == "claude-opus-5-5"
    assert any("Couldn't switch the model" in e["text"] for e in task.transcript)
    tm.cancel(task.id)


async def test_a_model_picked_as_the_connection_closes_is_the_next_ones(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    holder = {}

    class Closes(StreamClient):
        async def set_model(self, model):
            holder["tm"]._connection_gone(holder["task"])  # it went while the switch was sent
            raise RuntimeError("Not connected")

    tm, _events = stream_manager(settings, Closes)
    task = tm.start("", "proj", model="claude-opus-5-5")
    holder.update(tm=tm, task=task)
    assert await until(lambda: task.status == "waiting")
    assert await tm.set_model(task.id, "claude-sonnet-5-5", "Sonnet")
    assert task.model == "claude-sonnet-5-5"
    assert tm.options_for(task).model == "claude-sonnet-5-5"
    tm.cancel(task.id)


def _delta(text, n):
    return StreamEvent(uuid=f"se{n}", session_id="s",
                       event={"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}})  # fmt: skip


async def test_a_burst_of_live_words_is_one_event(settings, tmp_path):
    tm, _, events = plain_manager(settings)
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path)
    for n in range(1000):
        tm._on_task_message(task, _delta("tok ", n))
    await asyncio.sleep(0.1)
    streams = [d for kind, d in events if kind == "task_stream"]
    assert len(streams) == 1 and streams[0]["text"] == "tok " * 1000


async def test_the_live_words_come_before_the_reply_that_ends_them(settings, tmp_path):
    tm, _, events = plain_manager(settings)
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path)
    tm._on_task_message(task, _delta("All ", 1))
    tm._on_task_message(task, _delta("done.", 2))
    tm._on_task_message(task, AssistantMessage(content=[TextBlock(text="All done.")], model="m"))
    kinds = [kind for kind, _ in events if kind in ("task_stream", "task_log")]
    assert kinds[:2] == ["task_stream", "task_log"]
    await asyncio.sleep(0.1)
    assert sum(1 for kind, _ in events if kind == "task_stream") == 1  # nothing after the reply
