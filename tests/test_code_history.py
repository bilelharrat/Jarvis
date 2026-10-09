"""Eden Code's history: past sessions listed across projects, and a reopened session's
conversation read back from Claude Code's own records."""

from pathlib import Path

from claude_agent_sdk.types import SDKSessionInfo, SessionMessage

import jarvis.tasks as tasks_module
from jarvis.tasks import ClaudeTask, TaskManager, session_history


def _msg(kind, uuid, content):
    role = "assistant" if kind == "assistant" else "user"
    return SessionMessage(
        type=kind, uuid=uuid, session_id="s", message={"role": role, "content": content}
    )


CONVERSATION = [
    _msg("user", "u1", "fix the failing test"),
    _msg(
        "assistant",
        "a1",
        [
            {"type": "thinking", "thinking": "Look at the test first."},
            {"type": "text", "text": "Running the tests."},
            {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "pytest -q"}},
        ],
    ),
    _msg(
        "user",
        "r1",
        [{"type": "tool_result", "tool_use_id": "t1", "content": "1 failed", "is_error": True}],
    ),
    _msg("assistant", "a2", [{"type": "text", "text": "Fixed: the off-by-one in parse()."}]),
    _msg("user", "u2", "<command-name>/compact</command-name><command-args></command-args>"),
    _msg("user", "u3", [{"type": "text", "text": "[Request interrupted by user]"}]),
    _msg("user", "u4", [{"type": "text", "text": "now commit it"}, {"type": "image"}]),
]


def test_a_past_conversation_reads_back_as_the_transcript_shows_it(monkeypatch, tmp_path):
    monkeypatch.setattr(tasks_module, "get_session_messages", lambda sid, directory: CONVERSATION)
    past = session_history("s", tmp_path)
    shown = [(e["role"], e["text"]) for e in past["entries"]]
    assert shown == [
        ("user", "fix the failing test"),
        ("thinking", "Look at the test first."),
        ("assistant", "Running the tests."),
        ("tool", shown[3][1]),  # the step as described live
        ("assistant", "Fixed: the off-by-one in parse()."),
        ("user", "/compact"),
        ("system", "Interrupted."),
        ("user", "now commit it"),
    ]
    step = past["entries"][3]
    assert step["tool"] == "Bash" and step["status"] == "failed" and step["output"] == "1 failed"
    assert past["entries"][-1]["images"] == 1
    assert all(e["past"] for e in past["entries"])
    # Each of the user's messages can be forked from: the message before it.
    assert past["fork_points"] == {"u1": "", "u2": "a2", "u4": "u3"}
    assert past["last_uuid"] == "u4"


def test_a_fork_reads_up_to_its_point_and_an_unknown_point_reads_nothing(monkeypatch, tmp_path):
    monkeypatch.setattr(tasks_module, "get_session_messages", lambda sid, directory: CONVERSATION)
    past = session_history("s", tmp_path, until="a2")
    assert past["entries"][-1]["text"] == "Fixed: the off-by-one in parse()."
    assert past["last_uuid"] == "a2"
    assert session_history("s", tmp_path, until="nowhere")["entries"] == []


def test_an_unreadable_record_says_so_so_it_is_read_again(monkeypatch, tmp_path):
    def broken(sid, directory):
        raise OSError("damaged")

    monkeypatch.setattr(tasks_module, "get_session_messages", broken)
    assert session_history("s", tmp_path) == {
        "entries": [],
        "fork_points": {},
        "last_uuid": "",
        "failed": True,  # (never taken for "no history": _read_history tries again)
    }


def _manager(settings, events):
    return TaskManager(settings, None, lambda kind, **d: events.append((kind, d)), None)


def test_the_history_lists_every_projects_sessions_newest_first(monkeypatch, settings, tmp_path):
    for name in ("alpha", "beta", "broken"):
        (tmp_path / name).mkdir()
    records = {
        "alpha": [SDKSessionInfo("a-old", "Old", 1_000), SDKSessionInfo("a-new", "New", 3_000)],
        "beta": [SDKSessionInfo("b-1", "", 2_000, first_prompt="add a login page")],
    }

    def listed(directory, limit, include_worktrees):
        name = Path(directory).name
        if name == "broken":
            raise ValueError("a damaged record")
        return records[name][:limit]

    monkeypatch.setattr(tasks_module, "list_sessions", listed)
    history = _manager(settings, []).recent_sessions()
    assert [(h["session_id"], h["folder"]) for h in history] == [
        ("a-new", "alpha"),
        ("b-1", "beta"),
        ("a-old", "alpha"),
    ]
    assert history[1]["title"] == "add a login page"  # no title: its first message


async def test_a_reopened_session_shows_its_conversation_before_anything_new(
    monkeypatch, settings, tmp_path
):
    monkeypatch.setattr(tasks_module, "get_session_messages", lambda sid, directory: CONVERSATION)
    events = []
    tm = _manager(settings, events)
    task = ClaudeTask(id=1, prompt="", cwd=tmp_path, session_id="s")
    tm.tasks[1] = task
    tm._log(task, "system", "Couldn't add that folder.")  # said before the history was read
    await tm._read_history(task)
    texts = [e["text"] for e in task.transcript]
    assert texts[0] == "fix the failing test" and texts[-1] == "Couldn't add that folder."
    assert [e["n"] for e in task.transcript] == list(range(1, len(texts) + 1))
    assert task.last_uuid == "u4" and "u4" in task.fork_points
    sent = [d for kind, d in events if kind == "task_transcript"]
    assert sent and sent[-1]["id"] == 1 and len(sent[-1]["entries"]) == len(texts)
    assert task.history_read  # read once: a reconnect doesn't add it again
