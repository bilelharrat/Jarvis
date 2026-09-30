"""The Jarvis Code workspace feature (features/code_workspace.py), through the hub's window
commands: pictures from Claude Code's record for the transcript."""

import asyncio

import pytest
from code_session_fakes import make_hub

from jarvis.tasks import ClaudeTask

SID = "0f5d8c1e-7a41-4b8e-9d6b-2f1a3c4e5b6d"


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def record(hub):
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    return seen


async def settle(seen, kind, n=1):
    for _ in range(400):
        if sum(k == kind for k, _ in seen) >= n:
            return [d for k, d in seen if k == kind]
        await asyncio.sleep(0.005)
    raise AssertionError(f"no {kind}: {seen}")


def session(hub, tmp_path, sid=SID):
    task = ClaudeTask(id=7, prompt="", cwd=tmp_path, session_id=sid)
    hub.tasks.tasks[task.id] = task
    return task


async def test_pictures_come_from_the_session_s_record_by_entry(hub, tmp_path):
    session(hub, tmp_path)
    asked = []

    def pictures(sid, cwd, keys):
        asked.append((sid, cwd, keys))
        return {"u-1": [{"media_type": "image/png", "data": "AAAA"}]}

    hub.code_workspace.media.pictures = pictures
    seen = record(hub)
    await hub.handle({"type": "cw_media", "id": 7, "keys": ["u-1", "t-2", 5], "ref": "big-1"})
    (reply,) = await settle(seen, "cw_media")
    assert asked == [(SID, tmp_path, ["u-1", "t-2"])]
    assert reply == {
        "id": 7,
        "keys": ["u-1", "t-2"],
        "items": {"u-1": [{"media_type": "image/png", "data": "AAAA"}]},
        "ref": "big-1",
    }


async def test_no_pictures_for_an_unknown_session_or_one_never_connected(hub, tmp_path):
    session(hub, tmp_path, sid="")
    hub.code_workspace.media.pictures = lambda *a: pytest.fail("the record was read")
    seen = record(hub)
    await hub.handle({"type": "cw_media", "id": 7, "keys": ["u-1"]})
    await hub.handle({"type": "cw_media", "id": 99, "keys": ["u-1"]})
    await hub.handle({"type": "cw_media", "id": "x", "keys": ["u-1"]})
    replies = await settle(seen, "cw_media", 3)
    assert [r["items"] for r in replies] == [{}, {}, {}]
    assert [r["id"] for r in replies] == [7, 0, 0]
