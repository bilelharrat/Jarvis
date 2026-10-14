"""Model Router hardening (features/code_router, the 2026-10-13 audit's phase 3): no fallback
ping-pong back onto a Claude that can't answer (R1); "wait for Claude's limit to reset"
wins over the router's fallback (R2); a session moved off Claude stops waiting for Claude's
limit (R8); a session with messages queued isn't moved under them (R11); a gone session's
route and held Auto are let go (R12); a mode the owner picks, Manual too, isn't overridden
by Auto coming back (S18); the fallback stays with the provider the session is on unless
the owner opts in (S19); the Model Router page's server gets a minimal environment (S26);
the relays listen before the feature loops bring sessions back (R9)."""

import asyncio
import time

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
        (task_id, text, hub.tasks.tasks[task_id].model_ref, kw)
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


async def openrouter(hub):
    await hub.start()
    provider = hub.providers.add_provider("openrouter", "", KEY)
    return hub.providers.add_model(provider["id"], "openai/gpt-6-luna")["ref"]


async def send(hub, text, route, calls, n):
    await hub.handle({"type": "task_send", "id": 7, "text": text, "route": route})
    assert await until(lambda: len(calls) == n)


# ── R1: no ping-pong while Claude is down ──


async def test_the_router_doesnt_move_a_fallen_back_session_onto_claude_while_its_down(
    hub, tmp_path
):
    ref = await openrouter(hub)
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    await send(hub, "a", {"ref": ref}, calls, 1)
    assert task.model_ref == ref
    was = {"model": "claude-opus-5-5", "label": "", "ref": "opus", "env": {}, "mode": "ask"}
    task.fell_back_from = dict(was)  # (as the fallback leaves it)
    hub._claude_couldnt()
    hub._claude_back_at = time.time() + 3600  # Claude's limit resets in an hour
    await send(hub, "b", {"ref": "opus", "model": "claude-opus-5-5"}, calls, 2)
    assert task.model_ref == ref and calls[-1][2] == ref  # it stays on the fallback
    assert task.fell_back_from == was  # and still goes back to Claude by itself later
    hub._claude_down_at = 0.0  # Claude is back: the router may move it again
    await send(hub, "c", {"ref": "opus", "model": "claude-opus-5-5"}, calls, 3)
    assert task.model_ref == "opus"


async def test_claude_to_claude_still_moves_while_claude_is_down(hub, tmp_path):
    task = session(hub, tmp_path)
    task.model_ref = ""  # (the default model: Claude's too)
    calls = sent_to_sessions(hub)
    hub._claude_couldnt()
    await send(hub, "a", {"ref": "sonnet"}, calls, 1)
    assert task.model_ref == "sonnet"


# ── R2: waiting for Claude's limit wins over the router's fallback ──


async def test_waiting_for_the_limit_wins_over_the_routers_fallback(hub, tmp_path):
    hub.set_feature_prefs({"code_router_on": True, "code_limit_wait": True})
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    route = {"ref": "sonnet", "fallbacks": [{"ref": "opus", "model": "claude-opus-5-5"}]}
    await send(hub, "a", route, calls, 1)
    hub.tasks._claude_down(task, "rate_limit", "You've hit your limit")
    assert task.hold_until > time.time()  # code_limit waits it out
    await asyncio.sleep(0.05)
    assert task.model_ref == "sonnet" and len(calls) == 1  # not moved, nothing carried on
    hub.code_limit.forget()
    # An overload isn't Claude's limit: the router's fallback still takes it.
    task.hold_until, task.falling_back = 0.0, False
    hub.code_router.routes[7]["retried"] = False
    hub.tasks._claude_down(task, "overloaded", "")
    assert await until(lambda: task.model_ref == "opus")


# ── R8: moving off Claude ends the wait for Claude's limit ──


async def test_a_session_moved_off_claude_stops_waiting_for_claudes_limit(hub, tmp_path):
    ref = await openrouter(hub)
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    hub.code_limit.hold(task, time.time() + 5 * 3600)
    assert task.hold_until > 0 and 7 in hub.code_limit.waits
    await send(hub, "carry on", {"ref": ref}, calls, 1)
    assert task.model_ref == ref
    assert task.hold_until == 0 and 7 not in hub.code_limit.waits
    # No "Claude's limit has reset" note to a model that never had the limit: only the
    # owner's message went.
    assert [c[1] for c in calls] == ["carry on"]
    said = [e["text"] for e in task.transcript if e["role"] == "system"]
    assert said[-1].endswith("it no longer waits for Claude's usage limit.")


# ── R11: queued messages keep the model they were sent for ──


async def test_a_session_with_messages_queued_isnt_moved_under_them(hub, tmp_path):
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    task.inbox.put("the one routed to Opus, not taken up yet")
    await send(hub, "b", {"ref": "haiku"}, calls, 1)
    assert task.model_ref == "opus"
    assert not hub.code_router._movable(7)  # (nor waits for a rating it can't use)
    # Waiting out Claude's limit, the queue is no model's yet: it may move.
    task.hold_until = time.time() + 3600
    await send(hub, "c", {"ref": "haiku"}, calls, 2)
    assert task.model_ref == "haiku"


# ── R12: a gone session's route and held Auto go with it ──


async def test_a_gone_sessions_route_and_held_auto_are_let_go(hub, tmp_path):
    session(hub, tmp_path)
    router = hub.code_router
    router.routes[7] = {"ref": "opus"}
    router.auto_held[7] = "ask"
    router.routes[8] = {"ref": "haiku"}
    hub.tasks._changed()  # (still listed: kept)
    await asyncio.sleep(0.3)
    assert 7 in router.routes and 7 in router.auto_held
    del hub.tasks.tasks[7]
    hub.tasks._changed()
    assert await until(lambda: not router.routes and not router.auto_held)


# ── S18: a mode the owner picks stays theirs ──


async def test_auto_doesnt_come_back_over_manual_the_owner_picked(hub, tmp_path):
    ref = await openrouter(hub)
    task = session(hub, tmp_path, mode="smart")
    calls = sent_to_sessions(hub)
    await send(hub, "a", {"ref": ref}, calls, 1)
    assert task.mode == "ask" and hub.code_router.auto_held == {7: "ask"}
    await hub.handle({"type": "task_mode", "id": 7, "mode": "ask"})  # Manual, on purpose
    assert task.mode == "ask" and 7 not in hub.code_router.auto_held
    await send(hub, "b", {"ref": "opus"}, calls, 2)
    assert task.model_ref == "opus" and task.mode == "ask"


# ── S19: the fallback stays with the provider ──


async def test_the_fallback_doesnt_cross_providers_unless_opted_in(hub, tmp_path):
    ref = await openrouter(hub)
    hub.set_feature_prefs({"code_router_on": True})
    task = session(hub, tmp_path)
    calls = sent_to_sessions(hub)
    route = {"ref": "sonnet", "fallbacks": [{"ref": ref, "model": "gpt-6-luna"}]}
    await send(hub, "a", route, calls, 1)
    seen = []
    down = hub.code_router.claude_down(lambda t, why, said="": seen.append(why) or False)
    assert down(task, "overloaded", "") is False and seen == ["overloaded"]  # the hub's
    assert task.model_ref == "sonnet"
    hub.set_feature_prefs({"code_router_cross_fallback": True})
    assert down(task, "overloaded", "") is True
    assert await until(lambda: task.model_ref == ref)


def test_claude_and_an_anthropic_key_are_one_company(hub):
    router = hub.code_router
    assert router._company("opus") == router._company("") == "anthropic"
    provider = hub.providers.add_provider("anthropic", "", "sk-ant-api03-" + "x" * 90)
    ref = "custom:" + hub.providers.models_of(provider["id"])[0].id
    assert router._company(ref) == "anthropic"
    other = hub.providers.add_provider("openrouter", "", KEY)
    assert router._company(hub.providers.add_model(other["id"], "x/y")["ref"]) == other["id"]


# ── S26: the page's server gets a minimal environment ──


async def test_the_model_router_page_gets_a_minimal_environment(hub, tmp_path, monkeypatch):
    home = tmp_path / "Model Router"
    (home / "dist" / "ui").mkdir(parents=True)
    (home / "dist" / "ui" / "server.js").write_text("")
    monkeypatch.setenv("MODEL_ROUTER_HOME", str(home))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-secret-from-with-keys")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret")
    monkeypatch.setattr(code_router.shutil, "which", lambda name: "/usr/local/bin/node")
    hub.providers.key_of = lambda kind: "AIza-gemini-key" if kind == "gemini" else ""
    started = {}

    async def spawn(*args, env=None, **kw):
        started["env"] = env
        return object()

    async def answers():
        return "env" in started

    monkeypatch.setattr(code_router.asyncio, "create_subprocess_exec", spawn)
    hub.code_router._answers = answers
    assert await hub.code_router._start_page() == ""
    env = started["env"]
    assert env["GEMINI_API_KEY"] == "AIza-gemini-key" and env["PATH"]
    assert env["MODEL_ROUTER_HOME"] == str(home)
    assert "OPENAI_API_KEY" not in env and "ANTHROPIC_API_KEY" not in env


# ── R9: the relays first, then the feature loops ──


async def test_the_relays_listen_before_the_feature_loops_start(hub, monkeypatch):
    order = []
    hub.poll = True

    async def relay():
        order.append("relay")

    def spawn(coro):
        name = getattr(coro, "__qualname__", "")
        order.append(name)
        coro.close()
        done = asyncio.get_running_loop().create_future()
        done.set_result(None)
        return done

    hub._relay_if_needed = relay
    monkeypatch.setattr(hub, "_spawn", spawn)
    await hub.start()
    loops = [i for i, name in enumerate(order) if name.endswith("_feature_loop")]
    assert loops and order.index("relay") < loops[0]


# ── the window hears when Claude can't answer (wave-1 follow-up) ──


async def test_the_window_hears_when_claude_is_down_and_until_when(hub):
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    told = lambda: [d for k, d in seen if k == "model_router_claude"]  # noqa: E731
    await hub.handle({"type": "model_router_claude_get"})
    assert told()[-1] == {"down": False, "until": 0}
    before = time.time()
    hub._claude_couldnt()  # an outage: half an hour on
    state = told()[-1]
    assert state["down"] is True
    assert (before + 1799) * 1000 <= state["until"] <= (time.time() + 1801) * 1000
    hub._claude_couldnt()  # the same again: nothing new to say
    assert len(told()) == 2

    class Limit:  # Claude's usage limit, with its reset time
        status, overage_status, resets_at = "rejected", None, int(time.time()) + 600
        rate_limit_type, utilization = "five_hour", 1.0

    hub.tasks.on_rate_limit(Limit())
    assert told()[-1] == {"down": True, "until": Limit.resets_at * 1000}
    hub._claude_down_at = time.time() - 3600  # long ago, and the reset time passed too
    hub._claude_back_at = time.time() - 1
    await hub.handle({"type": "model_router_claude_get"})
    assert told()[-1] == {"down": False, "until": 0}
