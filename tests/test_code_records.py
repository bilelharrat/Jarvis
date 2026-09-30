"""Claude Code's own record of a session (code_records): the pictures in it, found by the
transcript entry they go with and read back only when asked for; and the transcript
marking the steps that returned pictures (tasks.py), so the window knows which to ask
for."""

import json
import os

from claude_agent_sdk import AssistantMessage, ToolResultBlock, ToolUseBlock, UserMessage
from test_tasks import stream_manager, until

from jarvis import code_records, tasks
from jarvis.code_records import RecordMedia, keys_of, pictures_in, record_path, timestamps

SID = "0f5d8c1e-7a41-4b8e-9d6b-2f1a3c4e5b6d"
PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=="


def entry(kind, uuid, content, **extra):
    return {"parentUuid": None, "type": kind, "message": {"role": kind, "content": content},
            "uuid": uuid, "timestamp": f"2026-09-29T10:00:{uuid[-2:]}.000Z", "sessionId": SID, **extra}  # fmt: skip


def image(data=PNG, media_type="image/png"):
    return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}


def write_record(path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        for e in entries:
            f.write(json.dumps(e, separators=(",", ":")) + "\n")


def conversation():
    """The owner attaches a picture; a step reads text; another returns a screenshot."""
    return [
        entry("user", "u-000000000001", [image(), {"type": "text", "text": "what's wrong here?"}]),
        entry(
            "assistant",
            "a-000000000002",
            [
                {
                    "type": "tool_use",
                    "id": "t-read",
                    "name": "Read",
                    "input": {"file_path": "a.py"},
                },
                {
                    "type": "tool_use",
                    "id": "t-shot",
                    "name": "mcp__jarvis_browser__browser_screenshot",
                    "input": {},
                },
            ],
        ),  # fmt: skip
        entry(
            "user",
            "r-000000000003",
            [
                {"type": "tool_result", "tool_use_id": "t-read", "content": "print('hi')"},
                {
                    "type": "tool_result",
                    "tool_use_id": "t-shot",
                    "content": [
                        {"type": "text", "text": "the page"},
                        image(media_type="image/jpeg"),
                        image(),
                    ],
                },
            ],
        ),  # fmt: skip
        entry("assistant", "a-000000000004", [{"type": "text", "text": "Fixed."}]),
    ]


def test_an_entry_s_pictures_are_found_by_its_key(tmp_path):
    record = tmp_path / "record.jsonl"
    write_record(record, conversation())
    media = RecordMedia(locate=lambda sid, cwd: record)
    got = media.pictures(SID, tmp_path, ["u-000000000001", "t-shot", "t-read", "nope"])
    assert set(got) == {"u-000000000001", "t-shot"}  # the ones without pictures are left out
    assert got["u-000000000001"] == [{"media_type": "image/png", "data": PNG}]
    assert [p["media_type"] for p in got["t-shot"]] == ["image/jpeg", "image/png"]
    # What a line holds, by entry, read from the line alone.
    lines = conversation()
    assert keys_of(lines[0]) == ["u-000000000001"] and keys_of(lines[2]) == ["t-shot"]
    assert keys_of(lines[1]) == []  # Claude's own messages hold no pictures of the owner's
    assert pictures_in(lines[2], "t-read") == []


def test_only_new_lines_are_read_and_a_line_still_being_written_waits(tmp_path):
    record = tmp_path / "record.jsonl"
    write_record(record, conversation())
    media = RecordMedia(locate=lambda sid, cwd: record)
    assert media.pictures(SID, tmp_path, ["t-shot"])
    index = media._indexes[record]
    scanned = index.scanned
    assert scanned == record.stat().st_size
    # A picture half written (no newline yet) isn't read until its line is whole.
    later = json.dumps(entry("user", "u-000000000005", [image()]), separators=(",", ":"))
    with record.open("a") as f:
        f.write(later[:40])
    assert media.pictures(SID, tmp_path, ["u-000000000005"]) == {}
    assert index.scanned == scanned
    with record.open("a") as f:
        f.write(later[40:] + "\n")
    assert media.pictures(SID, tmp_path, ["u-000000000005"])["u-000000000005"][0]["data"] == PNG
    assert media._indexes[record] is index and index.scanned == record.stat().st_size
    # A record replaced by another (a rewind rewrote it) is indexed again from the top.
    record.unlink()
    write_record(record, [entry("user", "u-000000000009", [image()])])
    assert set(media.pictures(SID, tmp_path, ["u-000000000009", "t-shot"])) == {"u-000000000009"}


def test_big_pictures_and_big_answers_are_left_out_not_sent(tmp_path, monkeypatch):
    record = tmp_path / "record.jsonl"
    big = "A" * 400
    write_record(record, [
        entry("user", "u-000000000001", [image(big)]),
        entry("user", "u-000000000002", [image(big)]),
        entry("user", "u-000000000003", [image("B" * 5000)]),
        entry("user", "u-000000000004", [{"type": "image", "source": {"type": "url", "url": "https://x/y.png"}}]),
    ])  # fmt: skip
    monkeypatch.setattr(code_records, "IMAGE_MAX", 1000)
    monkeypatch.setattr(code_records, "REPLY_MAX", 600)
    got = RecordMedia(locate=lambda sid, cwd: record).pictures(
        SID, tmp_path, ["u-000000000001", "u-000000000002", "u-000000000003", "u-000000000004"]
    )
    assert got["u-000000000001"][0]["data"] == big
    assert got["u-000000000002"] == [
        {"media_type": "image/png", "too_big": True}
    ]  # past the answer's
    assert got["u-000000000003"] == [{"media_type": "image/png", "too_big": True}]  # past one's own
    assert "u-000000000004" not in got  # a picture by address is never fetched


def test_a_missing_or_unreadable_record_has_no_pictures(tmp_path):
    media = RecordMedia(locate=lambda sid, cwd: tmp_path / "gone.jsonl")
    assert media.pictures(SID, tmp_path, ["u-1"]) == {}
    assert RecordMedia(locate=lambda sid, cwd: None).pictures(SID, tmp_path, ["u-1"]) == {}
    garbled = tmp_path / "garbled.jsonl"
    garbled.write_text('{"type":"user","message":{"content":[{"type":"image" broken\n')
    assert RecordMedia(locate=lambda sid, cwd: garbled).pictures(SID, tmp_path, ["u-1"]) == {}


def test_the_record_is_found_where_claude_code_keeps_it(tmp_path, monkeypatch):
    from claude_agent_sdk._internal.sessions import _sanitize_path

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude"))
    project = tmp_path / "proj"
    project.mkdir()
    folder = tmp_path / "claude" / "projects" / _sanitize_path(os.path.realpath(project))
    write_record(folder / f"{SID}.jsonl", conversation())
    assert record_path(SID, project) == folder / f"{SID}.jsonl"
    assert record_path("not-a-session-id", project) is None
    assert record_path("", project) is None
    assert RecordMedia().pictures(SID, project, ["u-000000000001"])


def test_when_each_message_was_written_is_its_own_not_a_quoted_one(tmp_path):
    record = tmp_path / "record.jsonl"
    quoted = 'look: {"uuid": "11111111-1111-1111-1111-111111111111", "timestamp": "1999"}'
    write_record(record, [
        {"type": "user", "message": {"content": quoted}, "uuid": "22222222-2222-2222-2222-222222222222",
         "timestamp": "2026-09-29T10:00:00.000Z"},
        {"type": "summary", "summary": "no uuid here"},
    ])  # fmt: skip
    assert timestamps(record) == {
        "22222222-2222-2222-2222-222222222222": "2026-09-29T10:00:00.000Z"
    }
    assert timestamps(None) == {} and timestamps(tmp_path / "none.jsonl") == {}


def test_image_count_reads_a_tool_result():
    assert tasks.image_count([{"type": "text", "text": "x"}, image(), image()]) == 2
    assert tasks.image_count("text only") == 0 and tasks.image_count(None) == 0


async def test_a_step_that_returned_pictures_says_so_live(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, events = stream_manager(settings)
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    push = task.client._stream().put_nowait
    push(
        AssistantMessage(
            content=[ToolUseBlock(id="t-shot", name="mcp__x__screenshot", input={})], model="m"
        )
    )
    push(UserMessage(content=[ToolResultBlock(tool_use_id="t-shot", content=[
        {"type": "text", "text": "the page"}, image()], is_error=False)]))  # fmt: skip
    assert await until(lambda: any(k == "task_log_update" for k, _ in events))
    update = next(d for k, d in events if k == "task_log_update")
    assert update["images"] == 1 and update["output"].strip() == "the page"
    step = next(e for e in task.transcript if e.get("tool_id") == "t-shot")
    assert step["images"] == 1
    # A step without pictures says nothing about them.
    push(
        AssistantMessage(
            content=[ToolUseBlock(id="t-read", name="Read", input={"file_path": "a"})], model="m"
        )
    )
    push(
        UserMessage(content=[ToolResultBlock(tool_use_id="t-read", content="text", is_error=False)])
    )
    assert await until(lambda: sum(k == "task_log_update" for k, _ in events) == 2)
    last = [d for k, d in events if k == "task_log_update"][-1]
    assert "images" not in last
    tm.cancel(task.id)


def test_a_past_session_s_steps_say_which_returned_pictures(monkeypatch, tmp_path):
    from claude_agent_sdk.types import SessionMessage

    history = [
        SessionMessage(type=e["type"], uuid=e["uuid"], session_id=SID, message=e["message"])
        for e in conversation()
    ]
    monkeypatch.setattr(tasks, "get_session_messages", lambda sid, directory: history)
    past = tasks.session_history(SID, tmp_path)
    steps = {e.get("tool_id"): e for e in past["entries"] if e["role"] == "tool"}
    assert steps["t-shot"]["images"] == 2 and "images" not in steps["t-read"]
    user = next(e for e in past["entries"] if e["role"] == "user")
    assert user["images"] == 1 and user["uuid"] == "u-000000000001"
