"""Rewind and undo on a Jarvis Code session reopened from Claude Code's records: its file
checkpoints come back with its history. (Only its fork points used to, so Rewind said every
message was too far back.)"""

import pytest
from code_session_fakes import CONVERSATION, Stream, end_all, make_hub, until

import jarvis.tasks as tasks_module
from jarvis.tasks import session_history


@pytest.fixture
def history(monkeypatch):
    monkeypatch.setattr(tasks_module, "get_session_messages", lambda sid, directory: CONVERSATION)


def test_the_history_says_what_each_of_the_users_messages_led_to_changing(history, tmp_path):
    past = session_history("s", tmp_path)
    assert past["checkpoints"] == ["u-1", "u-2"]
    # A refused edit changed nothing, and isn't there.
    assert past["checkpoint_files"] == {"u-1": {"/p/net.py"}, "u-2": {"/p/test_net.py"}}
    assert session_history("s", tmp_path, until="a-2")["checkpoints"] == ["u-1"]


async def test_rewind_and_undo_work_on_a_reopened_session(
    settings, quiet_speaker, isolated, tmp_path, history
):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    task = hub.tasks.start("", "proj", resume="s")
    assert await until(lambda: task.client is not None and task.history_read)
    assert task.checkpoints == ["u-1", "u-2"] and hub.tasks.public()[0]["can_undo"]
    assert task.files_changed == {"/p/net.py", "/p/test_net.py"}
    reply = await hub.tasks.rewind_to(task.id, "u-2")
    assert reply.startswith("Rewound") and task.client.rewound == ["u-2"]
    assert task.checkpoints == ["u-1"] and task.files_changed == {"/p/net.py"}
    assert (await hub.tasks.undo(task.id)).startswith("Undone")
    assert task.client.rewound == ["u-2", "u-1"] and task.checkpoints == []
    # A fork has no checkpoints of its own to go back to: Claude Code doesn't copy them.
    fork = hub.tasks.fork(task.id, "u-2")
    assert await until(lambda: fork.history_read and fork.client is not None)
    assert fork.checkpoints == []
    await end_all(hub)
