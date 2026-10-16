"""Model Router for messages from elsewhere (features/code_router_backend, code_router): a
message from the phone (Eden Code's own send, comments and steer, and the companion's) or
the local API is routed as the window routes its own: the session moves to the pick before
it goes, in the session's order with the window's messages, never mid-step; Shadow mode
logs the pick and moves nothing; a new session from the phone or the API starts on the
rules' pick unless a model was named; the event log keeps where it came from and how it
was picked, for the Model Router pane. With nothing to pick (no Node.js, no window), the
message goes to the session's own model and its receipt says so. The pick itself: the
backend's Node worker (the real one, with a stand-in Node finder), its Gemini rating
through Router.classify; else a connected window, asked over its socket."""

import asyncio
import json

import httpx
import pytest
from code_session_fakes import make_hub
from test_companion_api import fake_the_mac

from jarvis import remote
from jarvis.features import code_phone, code_router_backend
from jarvis.features.code_receipts import unrouted_part, unrouted_text
from jarvis.tasks import ClaudeTask

HAIKU = {"ref": "haiku", "model": "claude-haiku-4-5", "effort": "low",
         "info": {"pick": {"model": "claude-haiku-4-5", "effort": "low"}}}  # fmt: skip


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def session(hub, tmp_path, task_id=7, **fields):
    task = ClaudeTask(id=task_id, prompt="", cwd=tmp_path)
    task.model, task.model_ref = "claude-opus-5-5", "opus"
    for k, v in fields.items():
        setattr(task, k, v)
    hub.tasks.tasks[task_id] = task
    return task


def sent_to_sessions(hub):
    calls = []

    def send(task_id, text, images=None, **kw):
        task = hub.tasks.tasks[task_id]
        calls.append((task_id, text, task.model, task.effort, kw.get("steer")))
        return True

    hub.tasks.send = send
    return calls


async def until(check, seconds=5.0):
    for _ in range(int(seconds / 0.01)):
        if check():
            return True
        await asyncio.sleep(0.01)
    return False


def live(hub, **settings):
    hub.prefs.features["code_router_on"] = True
    if settings:
        hub.prefs.features["code_router_settings"] = settings


def picks(hub, route=HAIKU, via="worker", can=True):
    """The backend's pick, stood in: every decide() call kept."""
    backend = hub.code_router_backend
    asked = []

    async def decide(task, text, *, rate):
        asked.append((task.id if task else None, text, rate))
        mode = backend.mode()
        if route is None or not mode:
            return None, ""
        return ({**route, "shadow": True} if mode == "shadow" else dict(route)), via

    backend.decide = decide
    backend.can_route = lambda: can
    return asked


async def records(hub):
    events = hub.code_router_events
    await events.log.flush()
    return [r for r in events.log.read() if r.get("kind") is None]


# ── the phone ──


async def phone_client(hub, monkeypatch, tmp_path):
    fake_the_mac(hub, monkeypatch, tmp_path)
    hub.remote.host, hub.remote.port, hub.remote.advertiser = "127.0.0.1", 0, None
    hub.prefs.features[code_phone.PREF] = True
    app = remote.create_remote_app(hub, hub.remote.devices, extension=hub.remote.extension)
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://phone")
    paired = await client.post(
        "/api/pair", json={"code": hub.remote.devices.start_pairing(), "device_name": "iPhone"}
    )
    client.headers["Authorization"] = f"Bearer {paired.json()['token']}"
    return client


async def test_a_phone_message_is_routed_before_it_goes(hub, tmp_path, monkeypatch):
    task = session(hub, tmp_path / "proj")
    (tmp_path / "proj").mkdir()
    calls = sent_to_sessions(hub)
    live(hub)
    asked = picks(hub)
    phone = await phone_client(hub, monkeypatch, tmp_path)
    try:
        reply = await phone.post("/api/code/phone/send", json={"id": 7, "text": "rename foo"})
        assert reply.json() == {"ok": True}
        assert await until(lambda: calls)
        assert calls == [(7, "rename foo", "claude-haiku-4-5", "low", None)]
        assert task.model_ref == "haiku" and asked == [(7, "rename foo", True)]
        # Steer from the phone: routed the same way while the session is idle.
        await phone.post("/api/code/phone/steer", json={"id": 7, "text": "and the tests"})
        assert await until(lambda: len(calls) == 2)
        assert calls[-1][4] is True
    finally:
        await phone.aclose()
    logged = await records(hub)
    assert [r["route"]["source"] for r in logged] == ["phone", "phone"]
    assert (
        logged[0]["route"]["via"] == "worker" and logged[0]["pick"]["model"] == "claude-haiku-4-5"
    )
    # The Model Router pane's recent list says where it came from.
    recent = hub.code_router_events.recent_now()
    assert recent[0]["from"] == "phone"


async def test_mid_step_a_phone_message_isnt_routed(hub, tmp_path):
    task = session(hub, tmp_path, busy=True)
    calls = sent_to_sessions(hub)
    live(hub)
    asked = picks(hub)
    assert hub.code_router.send(7, "stop that", source="phone", steer=True) is True
    assert calls == [(7, "stop that", "claude-opus-5-5", "", True)]  # (at once, as before)
    assert asked == [] and task.model_ref == "opus"


async def test_order_is_kept_with_the_windows_own_messages(hub, tmp_path):
    session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    live(hub)
    gate = asyncio.Event()
    backend = hub.code_router_backend
    backend.can_route = lambda: True

    async def slow(task, text, *, rate):
        await gate.wait()
        return dict(HAIKU), "worker"

    backend.decide = slow
    assert hub.code_router.send(7, "from the phone", source="phone")
    await hub.handle({"type": "task_send", "id": 7, "text": "from the window",
                      "route": {"ref": "sonnet", "model": "claude-sonnet-5-5"}})  # fmt: skip
    await asyncio.sleep(0.05)
    assert calls == []  # (the window's waits behind the phone's)
    gate.set()
    assert await until(lambda: len(calls) == 2)
    assert [(c[1], c[2]) for c in calls] == [
        ("from the phone", "claude-haiku-4-5"),
        ("from the window", "claude-sonnet-5-5"),
    ]


async def test_shadow_mode_logs_the_pick_and_moves_nothing(hub, tmp_path):
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    picks(hub)  # (Shadow mode is on by default while Model Router isn't the model)
    assert hub.code_router_backend.mode() == "shadow"
    assert hub.code_router.send(7, "refactor the parser", source="phone")
    assert await until(lambda: calls)
    assert calls[0][2] == "claude-opus-5-5" and task.model_ref == "opus"
    logged = await records(hub)
    assert logged[-1]["settings"]["shadow"] is True and logged[-1]["route"]["source"] == "phone"
    assert hub.code_router.shadows[7]["model"] == "claude-haiku-4-5"  # (for the receipt)
    # Off altogether: no pick asked for.
    hub.prefs.features["code_router_shadow"] = False
    asked = picks(hub)
    hub.code_router.send(7, "again", source="phone")
    assert asked == [] and calls[-1][1] == "again"


async def test_nothing_to_pick_with_goes_to_the_sessions_model_and_says_so(hub, tmp_path):
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    live(hub)
    picks(hub, can=False)  # (no Node.js, no window)
    assert hub.code_router.send(7, "fix the login bug", source="phone")
    assert calls[0][2] == "claude-opus-5-5"  # (at once: nothing to wait for)
    part = unrouted_part(hub.code_router, task)
    assert part["from"] == "phone" and part["model"] == "claude-opus-5-5"
    words = unrouted_text(part)
    assert "Model Router couldn't pick a model for this message from your phone" in words
    assert unrouted_part(hub.code_router, task) is None  # (said once)
    # A pick that came back empty says so too (the worker failed, no window answered).
    picks(hub, route=None)
    hub.code_router.send(7, "and this", source="phone")
    assert await until(lambda: len(calls) == 2)
    assert hub.code_router.take_unrouted(7)["from"] == "phone"


# ── the local API (the eden-code CLI, the editor extension) ──


async def test_a_local_api_message_is_routed(hub, tmp_path):
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    live(hub)
    asked = picks(hub, via="window")
    await hub.handle({"type": "task_send", "id": 7, "text": "add a test", "from": "api"})
    assert await until(lambda: calls)
    assert calls[0][:3] == (7, "add a test", "claude-haiku-4-5") and task.model_ref == "haiku"
    assert asked == [(7, "add a test", True)]
    logged = await records(hub)
    assert logged[-1]["route"]["source"] == "api" and logged[-1]["route"]["via"] == "window"
    # Without "from" (the window's own, sent with no route): left as it was.
    await hub.handle({"type": "task_send", "id": 7, "text": "plain"})
    assert len(asked) == 1 and calls[-1][1] == "plain"


async def test_a_new_session_from_elsewhere_starts_on_the_rules_pick(hub, tmp_path):
    await hub.start()
    (tmp_path / "proj").mkdir()
    live(hub)
    asked = picks(hub)
    await hub.handle({"type": "task_new", "directory": "proj", "prompt": "hi", "from": "phone"})
    assert await until(lambda: hub.tasks.tasks)
    task = list(hub.tasks.tasks.values())[-1]
    assert task.model_ref == "haiku" and task.effort == "low"
    assert asked == [(None, "hi", False)]  # (never rated: the phone waits for it to start)
    task.handle.cancel()
    # A model named: theirs, not routed.
    await hub.handle({"type": "task_new", "directory": "proj", "prompt": "yo", "from": "api",
                      "model": "sonnet"})  # fmt: skip
    assert await until(lambda: len(hub.tasks.tasks) == 2)
    assert len(asked) == 1
    for t in hub.tasks.tasks.values():
        if t.handle:
            t.handle.cancel()


# ── the pick: the worker, a window ──


class Window:
    """A connected window's queue, as hub.emit fills it."""

    cut_off = False

    def put_nowait(self, _event):
        pass


async def test_a_window_answers_when_the_worker_cant(hub, tmp_path):
    task = session(hub, tmp_path)
    live(hub)
    backend = hub.code_router_backend
    backend.find_node = lambda: None
    hub._subscribers.add(Window())  # (a window is connected)
    asks = []
    hub.add_event_sink(["model_router_ask"], asks.append)

    async def answer():
        assert await until(lambda: asks)
        ask = asks[-1]
        assert ask["text"] == "refactor it" and ask["task"]["id"] == 7 and ask["rate"] is True
        backend.cmd_answer({"rid": ask["rid"], "route": {"ref": "sonnet"}, "final": False})
        await asyncio.sleep(0.02)
        backend.cmd_answer({"rid": ask["rid"], "route": {"ref": "opus", "effort": "max"}})

    helper = asyncio.create_task(answer())
    route, via = await backend.decide(task, "refactor it", rate=True)
    await helper
    assert (route, via) == ({"ref": "opus", "effort": "max"}, "window")

    # A rules' pick that's final: no waiting for more.
    async def rules():
        assert await until(lambda: len(asks) == 2)
        backend.cmd_answer({"rid": asks[-1]["rid"], "route": {"ref": "haiku"}, "final": True})

    helper = asyncio.create_task(rules())
    assert await backend.decide(task, "x y z w", rate=True) == ({"ref": "haiku"}, "window")
    await helper


async def test_no_window_answers_nothing_is_picked(hub, tmp_path, monkeypatch):
    task = session(hub, tmp_path)
    live(hub)
    backend = hub.code_router_backend
    monkeypatch.setattr(code_router_backend, "ASK_FIRST_SECONDS", 0.05)
    assert await backend.decide(task, "refactor it", rate=True) == (None, "")  # (no window)
    hub._subscribers.add(Window())  # (an Eden chat window: never answers)
    assert await backend.decide(task, "refactor it", rate=True) == (None, "")


def real_node():
    return code_router_backend.shutil.which("node") or next(
        (p for p in code_router_backend.NODE_PATHS if code_router_backend.Path(p).is_file()), None
    )


@pytest.mark.skipif(real_node() is None, reason="no Node.js here")
async def test_the_worker_picks_and_its_rating_goes_through_the_backend(hub, tmp_path):
    task = session(hub, tmp_path, effort="high")
    live(hub)  # (Gemini rates by default)
    backend = hub.code_router_backend
    backend.find_node = real_node
    rated = []

    async def classify(model, body):
        rated.append(model)
        return 401, json.dumps({"error": {"message": "no key"}})

    hub.code_router.classify = classify
    try:
        long = (
            "Refactor the whole authentication module to use dependency injection, then add tests."
        )
        route, via = await backend.decide(task, long, rate=True)
        assert via == "worker" and route["ref"] in {m["ref"] for m in hub.providers.picker()}
        assert route["info"]["pick"]["model"] == route["model"]
        assert rated and rated[0].startswith("gemini-")  # (asked once; no key: the rules' pick)
        # Shadow mode: a Shadow route, never rated.
        hub.prefs.features["code_router_on"] = False
        shadow, _ = await backend.decide(task, long, rate=True)
        assert shadow["shadow"] is True and len(rated) == 1
        # Off: nothing.
        hub.prefs.features["code_router_shadow"] = False
        assert await backend.decide(task, long, rate=True) == (None, "")
    finally:
        await backend.stop()
    assert backend.proc is None


async def test_a_worker_that_cant_start_isnt_tried_again_at_once(hub, tmp_path):
    task = session(hub, tmp_path)
    live(hub)
    backend = hub.code_router_backend
    backend.find_node = lambda: str(tmp_path / "no-such-node")
    assert await backend.decide(task, "refactor it", rate=True) == (None, "")
    assert backend.failed_at > 0 and not backend.can_route()
