"""Jarvis Code's video proof (features/code_video.py), wired into a real hub: off by default,
on per project; after a turn that changed the page's files the app is asked (through the
window, faked here) for a recording, which is kept and put in the transcript; "Record a video
proof" records one now."""

import asyncio
import base64
import time

import pytest
from conftest import FakeClient

from jarvis.features import code_video
from jarvis.hub import Hub
from jarvis.tasks import ClaudeTask

WEBM = base64.b64encode(code_video.WEBM_MAGIC + b"\x00" * 64).decode()
JPEG = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 32).decode()


@pytest.fixture
async def hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    yield hub
    await hub.code_video.close()


class FakeServer:
    def address(self):
        return "http://localhost:5173/"


@pytest.fixture
def task(hub, settings, monkeypatch):
    folder = settings.projects_dir / "shop"
    folder.mkdir()
    task = ClaudeTask(id=8, prompt="x", cwd=folder.resolve())
    hub.tasks.tasks[8] = task
    monkeypatch.setattr(hub.code_verify, "preview_server", lambda t: FakeServer())
    hub.browser_available = True
    return task


def turn(hub, files=("src/App.tsx",), status="done"):
    hub.tasks.emit("task_finished", id=8, task_kind="code", status=status, files=list(files))


def events(queue, kind):
    out = []
    while not queue.empty():
        ev = queue.get_nowait()
        if ev["type"] == kind:
            out.append(ev)
    return out


async def until(condition, seconds=5.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        await asyncio.sleep(0.02)
    return False


def videos(task):
    return [e for e in task.transcript if e["role"] == "video"]


def turn_on(hub, task):
    hub.set_feature_prefs({"code_project_defaults": {str(task.cwd): {"video_proof": True}}})


def test_which_changes_are_the_pages():
    assert code_video.changed_ui(["src/App.tsx", "README.md"])
    assert code_video.changed_ui(["styles/site.CSS"])
    assert not code_video.changed_ui(["server/api.py", "README.md"])
    assert not code_video.changed_ui([])


async def test_off_by_default_nothing_is_recorded(hub, task):
    q = hub.subscribe()
    turn(hub)
    await asyncio.sleep(0.1)
    assert events(q, "vp_capture") == [] and videos(task) == []


async def test_a_projects_switch_records_after_a_ui_turn_and_keeps_the_video(hub, task):
    turn_on(hub, task)
    q = hub.subscribe()
    turn(hub, files=["server.py"])  # not the page's
    turn(hub, status="stopped")
    await asyncio.sleep(0.1)
    assert events(q, "vp_capture") == []
    turn(hub)
    assert await until(lambda: any(e["type"] == "vp_capture" for e in list(q._items)))
    [ask] = events(q, "vp_capture")
    assert ask["url"] == "http://localhost:5173/" and ask["seconds"] <= code_video.MAX_SECONDS
    result = {"ok": True, "webm": WEBM, "poster": JPEG, "seconds": 7.9, "frames": 80}
    await hub._handle({"type": "vp_result", "call": ask["call"], "result": result})
    assert await until(lambda: len(videos(task)) == 1)
    [entry] = videos(task)
    assert entry["status"] == "ok" and entry["poster"] == JPEG and entry["seconds"] == 7.9
    path = hub.code_video.videos.path(entry["video"])
    assert path is not None and path.read_bytes().startswith(code_video.WEBM_MAGIC)
    assert entry["text"] == "Video proof: 7.9 s of http://localhost:5173/"
    # Played from the window's own server by its id, and only from this Mac.
    response = await hub.code_video.serve(Request(entry["video"]))
    assert response.status_code == 200 and str(response.path) == str(path)
    assert (await hub.code_video.serve(Request("../../etc/passwd"))).status_code == 404
    assert (await hub.code_video.serve(Request(entry["video"], "evil.test"))).status_code == 403


class Request:
    def __init__(self, video, host=None):
        self.path_params = {"video": video}
        self.scope = {"server": ("127.0.0.1", 8765)}
        self.headers = {"host": host or "127.0.0.1:8765"}


async def test_what_isnt_a_video_isnt_kept_and_the_entry_says_why(hub, task):
    q = hub.subscribe()
    await hub._handle({"type": "vp_record", "id": 8})  # the owner's own, whatever the switch
    assert await until(lambda: any(e["type"] == "vp_capture" for e in list(q._items)))
    [ask] = events(q, "vp_capture")
    fake = base64.b64encode(b"<html>not a video").decode()
    await hub._handle(
        {"type": "vp_result", "call": ask["call"], "result": {"ok": True, "webm": fake}}
    )
    assert await until(lambda: len(videos(task)) == 1)
    entry = videos(task)[0]
    assert entry["status"] == "problem" and entry["by_owner"] and "couldn't be kept" in entry["why"]
    hub.browser_available = False
    await hub._handle({"type": "vp_record", "id": 8})
    assert await until(lambda: len(videos(task)) == 2)
    assert "app window" in videos(task)[1]["why"]
    await hub._handle({"type": "vp_record", "id": 99})
    assert "Open a session" in events(q, "vp_error")[0]["text"]


def test_only_the_newest_videos_are_kept(tmp_path, monkeypatch):
    monkeypatch.setattr(code_video, "VIDEOS_KEPT", 2)
    store = code_video.VideoStore(tmp_path / "v")
    ids = [store.save(WEBM) for _ in range(3)]
    assert all(ids) and len(list((tmp_path / "v").glob("*.webm"))) == 2
    assert store.save("not base64!") == "" and store.save(JPEG) == ""
