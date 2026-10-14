"""Rewind and undo on an Eden Code session when things are not straightforward: the session
is busy, the checkpoint is gone, the session closed and has to be reopened (or can't be),
Claude Code refuses the rewind. Also the fork's refusals. Each reply is what the user sees."""

import asyncio

import pytest
from code_session_fakes import CONVERSATION, Stream, end_all, make_hub, until

import jarvis.tasks as tasks_module


@pytest.fixture
def history(monkeypatch):
    monkeypatch.setattr(tasks_module, "get_session_messages", lambda sid, directory: CONVERSATION)


async def _reopened(settings, quiet_speaker, isolated, tmp_path, client=Stream):
    """A hub with one session reopened from Claude Code's records (checkpoints u-1, u-2)."""
    (tmp_path / "proj").mkdir(exist_ok=True)
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated, client=client)
    task = hub.tasks.start("", "proj", resume="s")
    assert await until(lambda: task.client is not None and task.history_read)
    return hub, task


async def _close(task):
    """The connection closes, as after an idle hour: no client, no running session."""
    task.handle.cancel()
    await asyncio.gather(task.handle, return_exceptions=True)
    task.client = None


def _said(task):
    return [entry["text"] for entry in task.transcript]


async def test_undo_and_rewind_say_no_while_the_session_is_still_working(
    settings, quiet_speaker, isolated, tmp_path, history
):
    """A busy session is not rewound under Claude's feet: the user is told to stop it."""
    hub, task = await _reopened(settings, quiet_speaker, isolated, tmp_path)
    task.busy = True
    assert await hub.tasks.undo(task.id) == "It's still working; stop it first."
    assert (await hub.tasks.rewind_to(task.id, "u-1")).startswith("It's still working")
    assert getattr(task.client, "rewound", []) == [] and task.checkpoints == ["u-1", "u-2"]
    task.busy = False
    await end_all(hub)


async def test_undo_and_rewind_on_a_missing_session_or_nothing_to_undo(
    settings, quiet_speaker, isolated, tmp_path, history
):
    """No session, a non-code session number, and a session with no checkpoints each get
    a plain answer."""
    hub, task = await _reopened(settings, quiet_speaker, isolated, tmp_path)
    assert await hub.tasks.undo(9999) == "No Eden Code session with that number."
    assert await hub.tasks.rewind_to(9999, "u-1") == "That session is gone."
    task.checkpoints = []
    assert await hub.tasks.undo(task.id) == "There's nothing to undo in this session."
    await end_all(hub)


async def test_a_rewind_to_an_unknown_message_is_refused_and_noted_in_the_session(
    settings, quiet_speaker, isolated, tmp_path, history
):
    """A message that has no checkpoint (too far back, or already undone) is not sent to
    Claude Code, and the refusal shows in the session's log."""
    hub, task = await _reopened(settings, quiet_speaker, isolated, tmp_path)
    reply = await hub.tasks.rewind_to(task.id, "u-nope")
    assert reply.startswith("Couldn't rewind to that message")
    assert getattr(task.client, "rewound", []) == []
    assert any("Couldn't rewind to that message" in t for t in _said(task))
    await end_all(hub)


async def test_a_rewind_of_a_session_that_never_started_says_so(
    settings, quiet_speaker, isolated, tmp_path, history
):
    """No connection and no conversation id: nothing to reopen. Undo words it as undo."""
    hub, task = await _reopened(settings, quiet_speaker, isolated, tmp_path)
    await _close(task)
    task.session_id = ""
    reply = await hub.tasks.rewind_to(task.id, "u-2")
    assert reply == "Couldn't rewind: the session never started."
    assert await hub.tasks.undo(task.id) == "Couldn't undo: the session never started."
    assert task.checkpoints == ["u-1", "u-2"]
    await end_all(hub)


async def test_a_rewind_of_a_closed_session_reopens_it_first(
    settings, quiet_speaker, isolated, tmp_path, history
):
    """A session that closed is reopened for the rewind, and the rewind goes to the new
    connection; the files of the rewound message are no longer counted as changed."""
    hub, task = await _reopened(settings, quiet_speaker, isolated, tmp_path)
    old = task.client
    await _close(task)
    reply = await hub.tasks.rewind_to(task.id, "u-2")
    assert reply.startswith("Rewound")
    assert task.client is not None and task.client is not old
    assert task.client.rewound == ["u-2"] and getattr(old, "rewound", []) == []
    assert task.checkpoints == ["u-1"] and task.files_changed == {"/p/net.py"}
    await end_all(hub)


async def test_a_rewind_gives_up_when_the_session_does_not_reopen_in_time(
    settings, quiet_speaker, isolated, tmp_path, history, monkeypatch
):
    """A reopen that never comes up is not waited on forever: the user is told to try
    again, the checkpoints stay, and undo says the same in its own words."""
    hub, task = await _reopened(settings, quiet_speaker, isolated, tmp_path)
    await _close(task)
    monkeypatch.setattr(tasks_module, "REOPEN_POLLS", 1)
    # A reopen already under way that never connects: no second one is started.
    pending = asyncio.get_running_loop().create_future()
    task.handle = pending
    reply = await hub.tasks.rewind_to(task.id, "u-2")
    assert reply == "Couldn't reopen the session to rewind it. Try again in a moment."
    assert task.handle is pending and task.client is None
    assert (await hub.tasks.undo(task.id)).startswith("Couldn't reopen the session to undo it")
    assert task.checkpoints == ["u-1", "u-2"]
    pending.cancel()
    await end_all(hub)


class Refusing(Stream):
    """Claude Code says no to a rewind."""

    async def rewind_files(self, user_message_id):
        raise RuntimeError("checkpoint not found")


async def test_a_rewind_claude_code_refuses_keeps_the_checkpoint_to_try_again(
    settings, quiet_speaker, isolated, tmp_path, history
):
    """Claude Code's refusal comes back in the reply (undo's in its own words), and the
    checkpoint and changed files stay as they were."""
    hub, task = await _reopened(settings, quiet_speaker, isolated, tmp_path, client=Refusing)
    reply = await hub.tasks.rewind_to(task.id, "u-1")
    assert reply == "Couldn't rewind: checkpoint not found"
    assert await hub.tasks.undo(task.id) == "Couldn't undo: checkpoint not found"
    assert task.checkpoints == ["u-1", "u-2"]
    assert task.files_changed == {"/p/net.py", "/p/test_net.py"}
    await end_all(hub)


async def test_a_rewind_keeps_files_an_earlier_message_also_changed(
    settings, quiet_speaker, isolated, tmp_path, history
):
    """A file both an earlier message and a rewound one changed is still changed after the
    rewind; only the files the rewound rounds alone touched drop out."""
    hub, task = await _reopened(settings, quiet_speaker, isolated, tmp_path)
    task.checkpoint_files["u-2"] = {"/p/net.py", "/p/test_net.py"}
    assert (await hub.tasks.rewind_to(task.id, "u-2")).startswith("Rewound")
    assert task.files_changed == {"/p/net.py"}
    assert "u-2" not in task.checkpoint_files and task.checkpoints == ["u-1"]
    assert any(t.startswith("Rewound") for t in _said(task))
    await end_all(hub)


async def test_a_rewind_to_the_first_message_puts_every_round_back(
    settings, quiet_speaker, isolated, tmp_path, history
):
    """Rewinding to the first message undoes every round after it: nothing left to undo."""
    hub, task = await _reopened(settings, quiet_speaker, isolated, tmp_path)
    assert (await hub.tasks.rewind_to(task.id, "u-1")).startswith("Rewound")
    assert task.checkpoints == [] and task.files_changed == set()
    assert await hub.tasks.undo(task.id) == "There's nothing to undo in this session."
    await end_all(hub)


async def test_a_fork_is_refused_before_a_conversation_or_from_too_far_back(
    settings, quiet_speaker, isolated, tmp_path, history
):
    """No fork from a session with no conversation yet, nor from a message it has no fork
    point for, nor of a session number that isn't Eden Code; each refusal is noted."""
    hub, task = await _reopened(settings, quiet_speaker, isolated, tmp_path)
    assert hub.tasks.fork(9999) is None
    count = len(hub.tasks.tasks)
    assert hub.tasks.fork(task.id, "u-nope") is None
    assert any("Couldn't fork from that message" in t for t in _said(task))
    saved, task.session_id = task.session_id, ""
    assert hub.tasks.fork(task.id) is None
    assert any("hasn't started a conversation yet" in t for t in _said(task))
    task.session_id = saved
    assert len(hub.tasks.tasks) == count
    await end_all(hub)
