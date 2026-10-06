"""Model Router for Jarvis Code (features/code_router): a routed message moves its session
to the picked model (and Claude's effort) before it goes, in order, never mid-step; Auto
comes back with a Claude model; a new session starts on the pick; a message sent on the
rules' pick while Gemini rates it (route_wait) waits a little for the rated route, in order;
Ask Gemini goes to Google with the Keychain key, which never reaches the window; the
settings are kept clean (Gemini rates by default)."""

import asyncio
import json

import httpx
import pytest
from code_session_fakes import make_hub

from jarvis.features import code_router
from jarvis.tasks import ClaudeTask

KEY = "sk-or-v1-" + "0123456789abcdef" * 4


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def sent_to_sessions(hub):
    calls = []
    hub.tasks.send = lambda task_id, text, images=None, **kw: calls.append(
        (task_id, text, hub.tasks.tasks[task_id].model, hub.tasks.tasks[task_id].effort)
    )
    return calls


async def until(check, seconds=5.0):
    for _ in range(int(seconds / 0.01)):
        if check():
            return True
        await asyncio.sleep(0.01)
    return False


def session(hub, tmp_path, **fields):
    task = ClaudeTask(id=7, prompt="", cwd=tmp_path)
    task.model, task.model_ref = "claude-opus-5-5", "opus"
    for k, v in fields.items():
        setattr(task, k, v)
    hub.tasks.tasks[7] = task
    return task


async def test_a_routed_message_moves_its_session_first(hub, tmp_path):
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    route = {"ref": "sonnet", "effort": "low", "model": "claude-sonnet-5-5"}
    await hub.handle({"type": "task_send", "id": 7, "text": "rename x", "route": route})
    assert await until(lambda: calls)
    assert calls == [(7, "rename x", "claude-sonnet-5-5", "low")]
    assert task.model_ref == "sonnet"
    # Without a route, a message goes at once, as before.
    await hub.handle({"type": "task_send", "id": 7, "text": "and this"})
    assert calls[-1] == (7, "and this", "claude-sonnet-5-5", "low")


async def test_never_mid_step_nor_to_a_model_off_the_list(hub, tmp_path):
    task = session(hub, tmp_path, busy=True)
    calls = sent_to_sessions(hub)
    await hub.handle({"type": "task_send", "id": 7, "text": "a", "route": {"ref": "haiku"}})
    assert await until(lambda: calls)
    assert task.model == "claude-opus-5-5"  # it was mid-step: the message went as it was
    task.busy = False
    await hub.handle({"type": "task_send", "id": 7, "text": "b", "route": {"ref": "custom:gone"}})
    assert await until(lambda: len(calls) == 2)
    assert task.model == "claude-opus-5-5" and calls[-1][1] == "b"


async def test_messages_keep_their_order_while_one_waits(hub, tmp_path):
    session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    gate = asyncio.Event()
    ready = hub._gemini_ready

    async def slow(ref):
        await gate.wait()
        await ready(ref)

    hub._gemini_ready = slow
    await hub.handle({"type": "task_send", "id": 7, "text": "first", "route": {"ref": "fable"}})
    await hub.handle({"type": "task_send", "id": 7, "text": "second"})
    await asyncio.sleep(0.05)
    assert calls == []  # the second waits behind the first
    gate.set()
    assert await until(lambda: len(calls) == 2)
    assert [c[1] for c in calls] == ["first", "second"]
    assert await until(lambda: not hub.code_router.queues)


async def test_auto_comes_back_with_a_claude_model(hub, tmp_path):
    await hub.start()
    provider = hub.providers.add_provider("openrouter", "", KEY)
    ref = hub.providers.add_model(provider["id"], "openai/gpt-6-luna")["ref"]
    task = session(hub, tmp_path, mode="smart")
    calls = sent_to_sessions(hub)
    await hub.handle({"type": "task_send", "id": 7, "text": "a", "route": {"ref": ref}})
    assert await until(lambda: calls)
    assert task.model_ref == ref and task.mode == "ask"  # Auto is Claude's
    await hub.handle(
        {"type": "task_send", "id": 7, "text": "b", "route": {"ref": "opus", "effort": "high"}}
    )
    assert await until(lambda: len(calls) == 2)
    assert task.model_ref == "opus" and task.mode == "smart" and task.effort == "high"
    # A mode the owner picks meanwhile stays theirs.
    await hub.handle({"type": "task_send", "id": 7, "text": "c", "route": {"ref": ref}})
    assert await until(lambda: len(calls) == 3)
    hub.tasks.set_mode(7, "plan")
    await hub.handle({"type": "task_send", "id": 7, "text": "d", "route": {"ref": "opus"}})
    assert await until(lambda: len(calls) == 4)
    assert task.mode == "plan"


async def test_a_new_session_starts_on_the_pick(hub, tmp_path):
    await hub.start()
    (tmp_path / "proj").mkdir()
    route = {"ref": "haiku", "effort": "medium"}
    await hub.handle({"type": "task_new", "directory": "proj", "prompt": "hi", "route": route})
    assert await until(lambda: hub.tasks.tasks)
    task = list(hub.tasks.tasks.values())[-1]
    assert task.model == "claude-haiku-4-5" and task.model_ref == "haiku"
    assert task.effort == "medium"
    task.handle.cancel()


def gemini(replies):
    seen = []

    def handler(request):
        seen.append(request)
        return replies(request)

    return httpx.MockTransport(handler), seen


async def test_ask_gemini_uses_the_keychain_key_and_never_shows_it(hub, monkeypatch):
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    body = {"contents": [{"parts": [{"text": "Rate: fix the typo"}]}], "generationConfig": {}}
    monkeypatch.setattr(hub.providers, "key_of", lambda kind: "")
    await hub._handle({"type": "model_router_classify", "rid": "r1", "model": "gemini-3.6-flash", "body": body})  # fmt: skip
    ((kind, data),) = events
    assert kind == "model_router_classified" and data["rid"] == "r1" and data["status"] == 401
    assert "Settings › Models" in json.loads(data["body"])["error"]["message"]

    secret = "AIza" + "x" * 35
    monkeypatch.setattr(hub.providers, "key_of", lambda kind: secret if kind == "gemini" else "")
    hub.code_router.transport, seen = gemini(
        lambda r: httpx.Response(200, json={"candidates": [], "echo": r.headers["x-goog-api-key"]})
    )
    events.clear()
    await hub._handle({"type": "model_router_classify", "rid": "r2", "model": "gemini-3.6-flash", "body": {**body, "tools": [{"x": 1}]}})  # fmt: skip
    (request,) = seen
    assert str(request.url).endswith("/models/gemini-3.6-flash:generateContent")
    assert request.headers["x-goog-api-key"] == secret
    assert "tools" not in json.loads(request.content)  # only what the router sends
    ((_, data),) = events
    assert data["status"] == 200 and secret not in json.dumps(events)

    events.clear()
    for bad in ({"model": "gpt-6", "body": body}, {"model": "gemini-3.6-flash", "body": "x"}):
        await hub._handle({"type": "model_router_classify", "rid": "r3", **bad})
    assert [d["status"] for _, d in events] == [400, 400] and len(seen) == 1


async def test_the_settings_are_kept_clean(hub):
    hub.set_feature_prefs(
        {"code_router_on": True, "code_router_settings": {"efficiency": 150, "classifier": "x"}}
    )
    assert hub.prefs.feature("code_router_on") is True
    assert hub.prefs.feature("code_router_settings") == {
        "efficiency": 100, "performance": 50, "classifier": "always",
        "subscriptionClaude": True, "shadow": False, "learn": True, "learnFromPrompts": False,
    }  # fmt: skip
    hub.set_feature_prefs({"code_router_on": "yes"})
    assert hub.prefs.feature("code_router_on") is True  # (not a bool: the old value stays)
    hub.set_feature_prefs({"code_router_settings": {"classifier": "off"}})  # (still a choice)
    assert hub.prefs.feature("code_router_settings")["classifier"] == "off"
    # The switches: booleans only, else their defaults (Claude as plan quota, learning on).
    hub.set_feature_prefs(
        {"code_router_settings": {"subscriptionClaude": False, "shadow": True, "learn": "no"}}
    )
    kept = hub.prefs.feature("code_router_settings")
    assert kept["subscriptionClaude"] is False and kept["shadow"] is True
    assert kept["learn"] is True and kept["learnFromPrompts"] is False


def test_gemini_rates_by_default():
    assert code_router.DEFAULT_SETTINGS["classifier"] == "always"
    assert code_router.clean_settings({})["classifier"] == "always"
    assert code_router.clean_settings({"classifier": "auto"})["classifier"] == "auto"


# ── route_wait: a message sent on the rules' pick while Gemini rates it ──

TOKEN = "rw0123456789abcdef01234567"
RULES = {"ref": "haiku", "effort": "low", "model": "claude-haiku-4-5"}
RATED = {"ref": "opus", "effort": "high", "model": "claude-opus-5-5"}


def waiting(text, token=TOKEN, route=RULES, **more):
    return {"type": "task_send", "id": 7, "text": text, "route": route, "route_wait": token, **more}


def no_tokens_left(hub):
    return not hub.code_router.waits and not hub.code_router.early


async def test_a_waiting_message_goes_on_the_rated_route(hub, tmp_path):
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    await hub.handle(waiting("design a scheduler"))
    await asyncio.sleep(0.05)
    assert calls == [] and task.model_ref == "opus"  # held for Gemini's rating
    await hub.handle({"type": "model_router_route", "token": TOKEN, "route": RATED})
    assert await until(lambda: calls)
    assert calls == [(7, "design a scheduler", "claude-opus-5-5", "high")]
    assert no_tokens_left(hub) and await until(lambda: not hub.code_router.queues)
    # A rating with no route (it failed, or picks the same): the message's own, at once.
    await hub.handle(waiting("rename x", token="rw-second-token"))
    await hub.handle({"type": "model_router_route", "token": "rw-second-token"})
    assert await until(lambda: len(calls) == 2, seconds=1.0)  # (not ROUTE_WAIT_SECONDS)
    assert calls[-1] == (7, "rename x", "claude-haiku-4-5", "low")


async def test_no_rating_in_time_the_message_goes_on_its_own(hub, tmp_path, monkeypatch):
    monkeypatch.setattr(code_router, "ROUTE_WAIT_SECONDS", 0.2)
    session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    await hub.handle(waiting("rename x"))
    assert await until(lambda: calls, seconds=2.0)
    assert calls == [(7, "rename x", "claude-haiku-4-5", "low")]
    assert no_tokens_left(hub)  # (nothing kept for it)
    # The rating, late: it changes nothing, and isn't kept.
    await hub.handle({"type": "model_router_route", "token": TOKEN, "route": RATED})
    assert no_tokens_left(hub)
    # Nor is the same token taken again: that message goes on its route, without waiting.
    await hub.handle(waiting("again"))
    assert await until(lambda: len(calls) == 2, seconds=0.15)
    assert calls[-1][2] == "claude-haiku-4-5"


async def test_unknown_and_malformed_tokens_change_nothing(hub, tmp_path):
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    for bad in ("short", "x" * 65, "has space in it", 12345678, None, {"a": 1}):
        await hub.handle({"type": "model_router_route", "token": bad, "route": RATED})
    assert no_tokens_left(hub)
    await hub.handle({"type": "model_router_route", "token": "rw-nobody-sent-this", "route": RATED})
    assert task.model_ref == "opus" and task.effort != "high" and calls == []
    # A message whose token isn't one the window makes goes on its route, without waiting.
    await hub.handle(waiting("plain", token="no good"))
    assert await until(lambda: calls, seconds=0.5)
    assert calls == [(7, "plain", "claude-haiku-4-5", "low")]
    # Kept for a while (a message still to come), a few at most.
    for i in range(code_router.MAX_TOKENS + 10):
        await hub.handle({"type": "model_router_route", "token": f"rw-early-{i:04d}"})
    assert len(hub.code_router.early) <= code_router.MAX_TOKENS


async def test_a_rating_that_came_before_its_message(hub, tmp_path):
    session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    await hub.handle({"type": "model_router_route", "token": TOKEN, "route": RATED})
    await hub.handle(waiting("after a question"))
    assert await until(lambda: calls, seconds=0.5)
    assert calls == [(7, "after a question", "claude-opus-5-5", "high")]
    assert no_tokens_left(hub)


async def test_order_is_kept_while_one_waits_for_its_rating(hub, tmp_path):
    session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    await hub.handle(waiting("first"))
    await hub.handle({"type": "task_send", "id": 7, "text": "second"})
    await hub.handle(waiting("third", token="rw-third-token", route={"ref": "sonnet"}))
    await asyncio.sleep(0.05)
    assert calls == []  # all behind the first's rating
    await hub.handle({"type": "model_router_route", "token": "rw-third-token"})  # (its own)
    await asyncio.sleep(0.05)
    assert calls == []
    await hub.handle({"type": "model_router_route", "token": TOKEN, "route": RATED})
    assert await until(lambda: len(calls) == 3)
    assert [(c[1], c[2]) for c in calls] == [
        ("first", "claude-opus-5-5"), ("second", "claude-opus-5-5"), ("third", "claude-sonnet-5-5"),
    ]  # fmt: skip
    assert no_tokens_left(hub) and await until(lambda: not hub.code_router.queues)


async def test_a_session_mid_step_doesnt_wait(hub, tmp_path):
    task = session(hub, tmp_path, busy=True)
    calls = sent_to_sessions(hub)
    await hub.handle(waiting("steer"))
    assert await until(lambda: calls, seconds=0.5)
    assert task.model == "claude-opus-5-5" and no_tokens_left(hub)


async def test_a_new_session_waits_for_its_rating(hub, tmp_path):
    await hub.start()
    (tmp_path / "proj").mkdir()
    new = {"type": "task_new", "directory": "proj", "prompt": "hi"}
    await hub.handle({**new, "route": RULES, "route_wait": TOKEN})
    await asyncio.sleep(0.05)
    assert not hub.tasks.tasks
    await hub.handle({"type": "model_router_route", "token": TOKEN, "route": RATED})
    assert await until(lambda: hub.tasks.tasks)
    task = list(hub.tasks.tasks.values())[-1]
    assert task.model_ref == "opus" and task.effort == "high"
    assert no_tokens_left(hub)
    task.handle.cancel()
