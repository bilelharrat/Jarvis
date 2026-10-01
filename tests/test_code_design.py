"""Jarvis Code builds from a design (features/code_design.py), wired into a real hub: a picture
sent with "build this" (or through Match a design…), the comparison after the turn (the app's
pictures faked as the window would send them), the transcript entry, and Refine, one round per
press of the owner's, up to the match's rounds."""

import asyncio
import base64
import time

import numpy as np
import pytest
from conftest import FakeClient

from jarvis.features import code_design
from jarvis.hub import Hub
from jarvis.tasks import ClaudeTask

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64).decode()
JPEG = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\x00" * 32).decode()


@pytest.fixture
async def hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    yield hub
    await hub.code_design.close()


class FakeServer:
    def __init__(self, url="http://localhost:5173/"):
        self.url = url

    def address(self):
        return self.url


def a_session(hub, tmp_path, server=True, monkeypatch=None):
    task = ClaudeTask(id=4, prompt="x", cwd=tmp_path)
    hub.tasks.tasks[4] = task
    if server:
        monkeypatch.setattr(hub.code_verify, "preview_server", lambda t: FakeServer())
    return task


def events(queue, kind):
    out = []
    while not queue.empty():
        ev = queue.get_nowait()
        if ev["type"] == kind:
            out.append(ev)
    return out


async def until(condition, seconds=10.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        await asyncio.sleep(0.02)
    return False


def rgb(header=(29, 78, 216)):
    img = np.full((40, 64, 3), 250, dtype=np.uint8)
    img[:10] = header
    return base64.b64encode(img.tobytes()).decode()


def the_apps_answer(header=(29, 78, 216)):
    return {
        "ok": True,
        "size": [1440, 900],
        "cw": 64,
        "ch": 40,
        "a": rgb(),
        "b": rgb(header),
        "shot": JPEG,
        "thumb": JPEG,
        "design_shot": JPEG,
        "design_thumb": JPEG,
    }


def design_entries(task):
    return [e for e in task.transcript if e["role"] == "design"]


async def a_comparison(hub, q, task, header=(220, 38, 38)):
    """The turn that built it ends; the window answers the app's render with these pictures."""
    hub.tasks.emit("task_finished", id=task.id, task_kind="code", status="done", files=["a.html"])
    assert await until(lambda: any(e["type"] == "dm_render" for e in list(q._items)))
    [ask] = events(q, "dm_render")
    assert ask["url"] == "http://localhost:5173/" and ask["design"].startswith("/f/code-design/")
    before = len(design_entries(task))
    await hub._handle(
        {"type": "dm_render_result", "call": ask["call"], "result": the_apps_answer(header)}
    )
    assert await until(lambda: len(design_entries(task)) > before)
    return design_entries(task)[-1], ask


def test_build_this_is_the_owners_words_handing_over_a_design():
    for text in [
        "build this",
        "Please build this page",
        "can you make this?",
        "Match this design",
        "做这个",
        "请帮我实现这个设计",
    ]:
        assert code_design.wants_build(text), text
    for text in ["fix the build", "this is broken", "", None, "make tests pass"]:
        assert not code_design.wants_build(text), text


def test_only_a_real_picture_is_taken_as_a_design():
    assert code_design.clean_design({"media_type": "image/png", "data": PNG, "name": "d.png"})
    assert (
        code_design.clean_design({"media_type": "image/png", "data": JPEG}) is None
    )  # a JPEG called a PNG
    assert code_design.clean_design({"media_type": "application/pdf", "data": PNG}) is None
    assert code_design.clean_design({"media_type": "image/png", "data": "not base64!"}) is None
    assert code_design.clean_design("x") is None


async def test_a_picture_sent_with_build_this_is_matched_after_the_turn_that_builds_it(
    hub, tmp_path, monkeypatch
):
    task = a_session(hub, tmp_path, monkeypatch=monkeypatch)
    sent = []
    monkeypatch.setattr(hub.tasks, "send", lambda *a, **k: sent.append((a, k)) or True)
    hub.browser_available = True
    q = hub.subscribe()
    image = {"media_type": "image/png", "data": PNG, "name": "design.png"}
    await hub._handle({"type": "task_send", "id": 4, "text": "build this", "images": [image]})
    assert len(sent) == 1 and sent[0][0][1] == "build this"  # the message itself went on
    match = hub.code_design.matches[4]
    assert match.armed and not match.waiting
    # A turn already running when it was sent isn't the one that builds it.
    hub.tasks.emit("task_finished", id=4, task_kind="code", status="done", files=["x.py"])
    await asyncio.sleep(0.1)
    assert events(q, "dm_render") == []
    hub.tasks.emit("task_log", id=4, entry={"role": "user", "text": "build this"})
    assert match.waiting
    entry, ask = await a_comparison(hub, q, task)
    assert entry["status"] == "compared" and entry["compared"] == 1 and entry["refined"] == 0
    assert 0 < entry["score"] < 1 and len(entry["heat"]) == entry["rows"] * entry["cols"]
    assert entry["scores"] == [entry["score"]] and entry["size"] == [1440, 900]
    assert hub.code_design.proofs.read(entry["render_proof"]) == JPEG
    assert entry["design_thumb"] == JPEG and entry["render_thumb"] == JPEG
    assert entry["text"].startswith("Design match: ")
    # The design is served to the app by its token only, from this Mac.
    response = await hub.code_design.serve(Request(ask["design"].rsplit("/", 1)[1]))
    assert response.status_code == 200 and response.body == base64.b64decode(PNG)
    assert (await hub.code_design.serve(Request("nope"))).status_code == 404
    assert (await hub.code_design.serve(Request(match.token, host="evil.test"))).status_code == 403


class Request:
    def __init__(self, token, host=None):
        self.path_params = {"token": token}
        self.scope = {"server": ("127.0.0.1", 8765)}
        self.headers = {"host": host or "127.0.0.1:8765"}


async def test_refine_sends_one_round_per_press_up_to_the_rounds(hub, tmp_path, monkeypatch):
    task = a_session(hub, tmp_path, monkeypatch=monkeypatch)
    hub.browser_available = True
    sent = []
    monkeypatch.setattr(hub.tasks, "send", lambda *a, **k: sent.append((a, k)) or True)
    q = hub.subscribe()
    await hub._handle(
        {
            "type": "dm_start",
            "id": 4,
            "image": {"media_type": "image/png", "data": PNG},
            "rounds": 2,
        }
    )
    [((_, text, images), kwargs)] = sent
    assert text.startswith("Build this design") and images[0]["data"] == PNG and kwargs == {}
    hub.tasks.emit("task_log", id=4, entry={"role": "user", "text": text})
    first, _ = await a_comparison(hub, q, task, header=(220, 38, 38))
    # Nothing goes to the session without the owner's press.
    assert len(sent) == 1
    await hub._handle({"type": "dm_refine", "id": 4, "compared": 1})
    ((task_id, note, images), kwargs) = sent[-1]
    assert task_id == 4 and kwargs == {"note": True}
    assert note.startswith("Design match, round 1 of 2:") and images[0]["data"] == JPEG
    assert design_entries(task)[-1]["status"] == "sent"
    # A second press before the round's turn ends: refused (the round is on its way).
    await hub._handle({"type": "dm_refine", "id": 4, "compared": 1})
    assert len(sent) == 2 and events(q, "dm_error")
    second, _ = await a_comparison(hub, q, task, header=(29, 78, 216))
    assert second["compared"] == 2 and second["scores"][0] < second["scores"][1]
    assert second["score"] > first["score"]
    # An old card's button: refused.
    await hub._handle({"type": "dm_refine", "id": 4, "compared": 1})
    assert "That round is over" in events(q, "dm_error")[-1]["text"]
    await hub._handle({"type": "dm_refine", "id": 4, "compared": 2})
    assert len(sent) == 3
    third, _ = await a_comparison(hub, q, task)
    await hub._handle({"type": "dm_refine", "id": 4, "compared": 3})
    assert "All the refinement rounds are used." in events(q, "dm_error")[-1]["text"]
    assert len(sent) == 3
    await hub._handle({"type": "dm_stop", "id": 4})
    assert 4 not in hub.code_design.matches


async def test_no_dev_server_or_no_app_window_says_why_and_compare_now_tries_again(
    hub, tmp_path, monkeypatch
):
    task = a_session(hub, tmp_path, server=False)
    monkeypatch.setattr(hub.code_verify, "preview_server", lambda t: None)
    monkeypatch.setattr(hub.tasks, "send", lambda *a, **k: True)
    await hub._handle(
        {"type": "dm_start", "id": 4, "image": {"media_type": "image/png", "data": PNG}}
    )
    hub.tasks.emit("task_log", id=4, entry={"role": "user", "text": "x"})
    hub.tasks.emit("task_finished", id=4, task_kind="code", status="done", files=["a.css"])
    assert await until(lambda: len(design_entries(task)) == 1)
    assert "No dev server is running" in design_entries(task)[0]["why"]
    monkeypatch.setattr(hub.code_verify, "preview_server", lambda t: FakeServer())
    hub.browser_available = False
    await hub._handle({"type": "dm_compare", "id": 4})
    assert await until(lambda: len(design_entries(task)) == 2)
    assert "app window" in design_entries(task)[1]["why"]


async def test_a_bad_picture_or_no_session_is_refused(hub, tmp_path, monkeypatch):
    a_session(hub, tmp_path, monkeypatch=monkeypatch)
    q = hub.subscribe()
    await hub._handle(
        {"type": "dm_start", "id": 4, "image": {"media_type": "image/png", "data": JPEG}}
    )
    assert "can't be used" in events(q, "dm_error")[0]["text"]
    await hub._handle(
        {"type": "dm_start", "id": 99, "image": {"media_type": "image/png", "data": PNG}}
    )
    assert "Open a session" in events(q, "dm_error")[0]["text"]
    assert hub.code_design.matches == {}
