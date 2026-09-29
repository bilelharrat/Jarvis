"""Jarvis Code sessions under the stress test's edge cases: steered messages outlive a
closing connection, switches made while connecting reach Claude Code, dead background
tasks don't pin a session open, End is pressed once however often, and ended sessions
don't pile up."""

import asyncio

from conftest import FakeClient
from test_tasks import until

from jarvis import tasks as tasks_mod
from jarvis.tasks import TaskManager


def make(settings, client=FakeClient):
    events = []

    async def approve(*_a, **_k):
        return "deny"

    return TaskManager(
        settings, approve, lambda kind, **d: events.append((kind, d)), client
    ), events


async def test_a_steered_message_the_connection_never_took_goes_back_to_the_queue(
    settings, tmp_path
):
    (tmp_path / "proj").mkdir()
    tm, _ = make(settings)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    task.steered, task.steered_items = 1, [{"text": "and add a test", "images": []}]
    tm._connection_gone(task)
    assert task.steered == 0 and task.steered_items == []
    assert [i["text"] for i in task.inbox.public()] == ["and add a test"]
    assert task.client is None
    task.handle.cancel()


async def test_a_mode_picked_while_connecting_reaches_claude_code(settings, tmp_path):
    (tmp_path / "proj").mkdir()

    class SlowConnect(FakeClient):
        async def connect(self):
            await asyncio.sleep(0.2)
            self.connected = True

    tm, _ = make(settings, SlowConnect)
    task = tm.start("", "proj", mode="smart", model="claude-opus-5-5")
    await asyncio.sleep(0.05)  # still connecting
    assert tm.set_mode(task.id, "ask") and task.client is None
    assert await until(lambda: task.client is not None and getattr(task.client, "modes", None))
    assert task.client.modes == ["default"]  # Manual, as the window shows
    task.handle.cancel()


async def test_background_tasks_end_with_their_connection(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = make(settings)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    task.background["b1"] = {"id": "b1", "description": "npm run dev"}
    tm._connection_gone(task)
    assert task.background == {}
    task.handle.cancel()


async def test_end_session_twice_ends_it_once(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = make(settings)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    handle = task.handle
    assert tm.cancel(task.id) and task.ending
    assert tm.cancel(task.id)  # the second press changes nothing
    assert handle.cancelling() == 1
    await asyncio.gather(handle, return_exceptions=True)
    assert task.status == "stopped" and not task.ending


async def test_ended_sessions_are_let_go_past_the_cap(settings, tmp_path, monkeypatch):
    (tmp_path / "proj").mkdir()
    monkeypatch.setattr(tasks_mod, "MAX_ENDED", 3)
    tm, _ = make(settings)
    started = [tm.start("", "proj") for _ in range(6)]
    for task in started:
        assert await until(lambda t=task: t.status == "waiting")
        tm.cancel(task.id)
        await asyncio.gather(task.handle, return_exceptions=True)
    assert len(tm.tasks) == 3 and set(tm.tasks) == {t.id for t in started[-3:]}


async def test_git_commands_never_get_the_ultracode_keyword(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = make(settings)
    task = tm.start("", "proj", ultracode=True)
    assert await until(lambda: task.status == "waiting")
    tm.send(task.id, "Commit the changes you made.", plain=True)
    assert await until(lambda: task.client and task.client.queries)
    assert task.client.queries[-1] == "Commit the changes you made."
    task.handle.cancel()


async def test_a_message_left_when_claude_code_exits_opens_the_session_again(settings, tmp_path):
    (tmp_path / "proj").mkdir()

    class ExitingClient(FakeClient):
        made: list = []

        def __init__(self, options=None):
            super().__init__(options)
            ExitingClient.made.append(self)

        async def receive_messages(self):
            while (message := await self._stream().get()) is not None:
                yield message

    tm, _ = make(settings, ExitingClient)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    task.steered, task.steered_items = 1, [{"text": "and the docs", "images": []}]
    ExitingClient.made[0]._stream().put_nowait(None)  # Claude Code exits before taking it up
    assert await until(lambda: len(ExitingClient.made) == 2 and ExitingClient.made[1].queries)
    assert "and the docs" in ExitingClient.made[1].queries[-1]
    assert task.inbox.empty() and task.status == "running"
    task.handle.cancel()
