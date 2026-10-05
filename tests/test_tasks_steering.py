"""Steering a Jarvis Code session's running step: steers keep the order they were sent in
(waiting for the step, or given back when their write fails), count against the queue's
cap, and one Claude Code dropped at an interrupt is said in the transcript and no longer
awaited, so the session never stays Working. No real Claude: the fakes of test_tasks and
test_tasks_limits."""

import asyncio

from claude_agent_sdk import UserMessage
from test_tasks import StreamClient, res, stream_manager, until
from test_tasks_limits import Scripted, _steered, manager

from jarvis.tasks import MAX_QUEUED, Inbox


def _texts(task):
    return [i["text"] for i in task.inbox.public()]


async def _begun(settings, tmp_path, client=StreamClient):
    """A session on a step Claude Code has begun (steer-ready); the step's end is put on
    the stream by hand."""
    (tmp_path / "p").mkdir()
    tm, _ = stream_manager(settings, client)
    task = tm.start("", "p")
    assert await until(lambda: task.status == "waiting")
    task.client.held = []
    tm.send(task.id, "first")
    assert await until(lambda: task.busy and task.client.queries == ["first"])
    task.client._stream().put_nowait(UserMessage(content="first", uuid="u-1"))
    assert await until(lambda: task.steer_ready)
    return tm, task, task.client


def test_a_steer_that_waits_goes_behind_whats_already_ahead_and_before_the_queue():
    inbox = Inbox()
    inbox.put("queued 1")
    inbox.put("carry on", front=True, note=True)  # the app's note
    inbox.put("A", steer=True)
    inbox.put("given back", front=True)  # a closed connection's message
    inbox.put("B", steer=True)
    inbox.put("queued 2")
    order = [i["text"] for i in inbox._items]
    assert order == ["given back", "carry on", "A", "B", "queued 1", "queued 2"]
    for _ in range(4):
        inbox.take()
    inbox.put("C", steer=True)
    assert [i["text"] for i in inbox._items] == ["C", "queued 1", "queued 2"]


async def test_waiting_messages_steered_before_the_step_begins_keep_the_order_clicked(
    settings, tmp_path
):
    (tmp_path / "p").mkdir()
    tm, _ = stream_manager(settings)
    task = tm.start("", "p")
    try:
        assert await until(lambda: task.status == "waiting")
        client = task.client
        client.held = []
        tm.send(task.id, "first")
        assert await until(lambda: task.busy and client.queries == ["first"])
        for text in ("q1", "q2", "q3"):
            tm.send(task.id, text, steer=False)
        ids = [i["id"] for i in task.inbox.public()]
        assert tm.steer_queued(task.id, ids[1]) and tm.steer_queued(task.id, ids[2])
        assert _texts(task) == ["q2", "q3", "q1"]
        client.release()
        assert await until(lambda: len(client.queries) == 4)
        assert client.queries == ["first", "q2", "q3", "q1"]
    finally:
        await tm.close()


class StdinGone(StreamClient):
    """A step under way whose connection is going: a message written now fails."""

    failing = False

    async def query(self, text):
        if self.failing:
            await asyncio.sleep(0)  # (the write is under way)
            raise ConnectionError("stdin closed")
        return await super().query(text)


async def test_steers_whose_writes_fail_go_back_to_the_queue_in_the_order_sent(settings, tmp_path):
    tm, task, client = await _begun(settings, tmp_path, StdinGone)
    try:
        client.failing = True
        for text in ("A", "B", "C"):
            assert tm.send(task.id, text, steer=True)
        assert await until(lambda: task.inbox.qsize() == 3 and task.steered == 0)
        assert _texts(task) == ["A", "B", "C"] and task.steered_items == []
        client.failing, client.held = False, None
        client._stream().put_nowait(res("done", 0.1))  # the step ends
        assert await until(lambda: len(client.queries) == 4)
        assert client.queries == ["first", "A", "B", "C"]
    finally:
        await tm.close()


async def test_messages_sent_into_the_step_count_toward_the_queues_cap(settings, tmp_path):
    tm, task, client = await _begun(settings, tmp_path)
    try:
        for i in range(MAX_QUEUED - 1):
            assert tm.send(task.id, f"steer {i}", steer=True)
        assert task.steered == MAX_QUEUED - 1
        assert tm.send(task.id, "the last that fits", steer=False)
        assert not tm.send(task.id, "one too many", steer=False)
        assert not tm.send(task.id, "one too many", steer=True)
        assert task.untaken == MAX_QUEUED and task.inbox.qsize() == 1
        notes = [e["text"] for e in task.transcript if e["role"] == "system"]
        assert notes.count(f"Not queued: {MAX_QUEUED} messages are already waiting.") == 2
    finally:
        await tm.close()


async def test_a_steer_dropped_at_an_interrupt_is_said_and_the_queue_keeps_moving(
    settings, tmp_path
):
    tm, task = await _steered(settings, tmp_path)  # a steer waiting inside Claude Code
    client = StreamClient.instances[0]
    try:
        assert await tm.interrupt(task.id)  # Stop: Claude Code drops it
        assert await until(lambda: not task.busy)
        assert task.steered == 0 and task.steered_items == []
        notes = [e["text"] for e in task.transcript if e["role"] == "system"]
        assert "Stopped before it was taken up, so not sent: and update the docs" in notes
        assert task.inbox.empty()  # never sent unasked
        tm.send(task.id, "next one", steer=False)
        assert await until(lambda: client.queries[-1] == "next one" and not task.busy)
        assert task.turns_pending == 0 and task.status == "waiting"
        tm.send(task.id, "third", steer=False)
        assert await until(lambda: client.queries[-1] == "third" and not task.busy)
    finally:
        await tm.close()


class SlowSteer(Scripted):
    """A steer whose write takes a while (a big picture): it lands after the interrupt,
    when Claude Code is between turns, and starts a turn of its own."""

    async def query(self, text):
        if self.running:
            self.unblock = asyncio.Event()
            await self.unblock.wait()
            return await StreamClient.query(self, text)
        return await super().query(text)


async def test_a_steer_still_being_written_at_an_interrupt_is_still_awaited(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = manager(settings, SlowSteer)
    task = tm.start("", "proj")
    try:
        assert await until(lambda: task.status == "waiting")
        tm.send(task.id, "run the slow thing")
        assert await until(lambda: task.busy and task.current == "user")
        client = StreamClient.instances[0]
        assert tm.send(task.id, "and update the docs", steer=True)
        assert await until(lambda: getattr(client, "unblock", None) is not None)
        assert await tm.interrupt(task.id)
        assert await until(lambda: task.current == "")
        assert task.steered == 1  # on its way, not dropped
        client.unblock.set()  # it lands: a turn of its own, counted and ended
        assert await until(lambda: task.result == "reply 2" and not task.busy)
        assert task.steered == 0 and task.turns_pending == 0
        notes = [e["text"] for e in task.transcript if e["role"] == "system"]
        assert not any("not sent" in n for n in notes)
        tm.send(task.id, "next one", steer=False)
        assert await until(lambda: client.queries[-1] == "next one" and not task.busy)
    finally:
        await tm.close()
