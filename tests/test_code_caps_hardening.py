"""Eden Code hardening (the 2026-10-13 audit, items W1-W7, W21, W29-W31): spending caps that
hold with sessions in parallel, forks and reconnects counted once, the midnight reset on
time, a session's own usage-limit reset, the restart check that waits for terminals, !
runs, test runs and preview checks, test reports read off the loop, watch mode's bounds,
and no git on the Mac."""

import asyncio
from types import SimpleNamespace

from code_session_fakes import Stream, end_all, make_hub, until

from jarvis import hub as hub_module

# ── W31: no git installed ──


async def test_no_git_on_the_mac_is_no_answer_not_an_error(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)

    async def no_git(*_args, **_kwargs):
        raise FileNotFoundError(2, "No such file or directory", "git")

    monkeypatch.setattr(hub_module.asyncio, "create_subprocess_exec", no_git)
    assert await hub._git(tmp_path, "rev-parse", "--abbrev-ref", "HEAD") == ""


# ── W21: what a quiet update waits for ──


async def test_a_restart_waits_for_terminal_jobs_bang_runs_test_runs_and_preview_checks(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert not hub.busy()
    idle = SimpleNamespace(exited=False, busy=lambda: "")
    working = SimpleNamespace(exited=False, busy=lambda: "sleep 60")
    gone = SimpleNamespace(exited=True, busy=lambda: "sleep 60")
    hub.code_terminal.shells.items = {"t1": idle, "t2": gone}
    assert not hub.busy()  # a shell at its prompt, or one that ended, loses nothing
    hub.code_terminal.shells.items["t3"] = working
    assert hub.busy()
    hub.code_terminal.shells.items = {}
    hub.code_terminal.runs["r1"] = object()  # a ! command running
    assert hub.busy()
    hub.code_terminal.runs.clear()
    runs = hub.code_verify.tests.runs
    runs["/p"] = SimpleNamespace(status="passed")
    assert not hub.busy()
    runs["/p"].status = "running"
    assert hub.busy()
    runs.clear()
    hub.code_verify.sessions[1] = SimpleNamespace(checking=True)
    assert hub.busy()
    hub.code_verify.sessions[1].checking = False
    assert not hub.busy()

    def broken():
        raise RuntimeError("psutil can't see it")

    hub.code_terminal.shells.items = {"t4": SimpleNamespace(exited=False, busy=broken)}
    assert not hub.busy()  # a shell that can't be asked never holds an update back


# ── W2, W3: forks, past sessions and reconnects counted once ──


def _parent(hub, tmp_path, cost=0.3, total=0.3):
    from jarvis.tasks import ClaudeTask

    (tmp_path / "proj").mkdir(exist_ok=True)
    task = ClaudeTask(id=900, prompt="x", cwd=(tmp_path / "proj").resolve(), session_id="s-parent")
    task.cost_usd, task.conn_cost = cost, total
    hub.tasks.tasks[task.id] = task
    return task


async def test_a_fork_starts_from_its_original_s_spend_and_counts_only_its_own_turn(
    settings, quiet_speaker, isolated, tmp_path
):
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    parent = _parent(hub, tmp_path)
    fork = hub.tasks.fork(parent.id)
    assert fork.cost_usd == 0.3 and fork.cost_inherited == 0.3
    # Claude Code's total carries the original's on: the first turn is 0.1, not 0.4.
    assert round(hub.tasks._count_cost(fork, 0.4), 6) == 0.1
    assert fork.cost_usd == 0.4
    from jarvis.features.code_usage import spent

    assert round(spent(fork), 6) == 0.1  # its own caps count its own spend
    await end_all(hub)


async def test_a_past_session_opened_by_its_id_takes_its_first_report_as_where_it_stood(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    task = hub.tasks.start("", "proj", resume="old-session")
    assert task.cost_unknown
    assert hub.tasks._count_cost(task, 5.0) == 0.0  # its past isn't today's spend
    assert task.cost_usd == 5.0
    assert round(hub.tasks._count_cost(task, 5.2), 6) == 0.2
    await end_all(hub)


async def test_a_reconnect_s_total_that_came_back_lower_is_not_counted_again_in_full(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    task = _parent(hub, tmp_path, cost=0.5, total=0.5)
    task.last_total, task.conn_cost = 0.5, None  # (a new connection: as _session sets it)
    # Claude Code kept 0.4 of it (the last connection ended before its figure was kept);
    # this turn cost 0.05: the 0.45 isn't counted again.
    assert hub.tasks._count_cost(task, 0.45) == 0.0
    assert task.cost_usd == 0.5
    assert round(hub.tasks._count_cost(task, 0.55), 6) == 0.1
    # Carried on as kept: only the turn.
    task.last_total, task.conn_cost = 0.6, None
    task.cost_usd = 0.6
    assert round(hub.tasks._count_cost(task, 0.7), 6) == 0.1


# ── W4: the midnight reset ──


async def test_a_new_day_is_noticed_within_a_minute_even_after_the_mac_slept(
    settings, quiet_speaker, isolated, monkeypatch
):
    from datetime import date, timedelta

    from jarvis.features import code_usage

    monkeypatch.setattr(code_usage, "DAY_LOOK", 0.01)
    hub = make_hub(settings, quiet_speaker, isolated)
    meter = hub.code_usage
    calls = []
    monkeypatch.setattr(meter, "caps_changed", lambda: calls.append(meter.usage.day()))
    loop = asyncio.ensure_future(meter.forever())
    try:
        await asyncio.sleep(0.05)
        assert calls == []  # the same day: nothing to do
        meter.usage._today = lambda: date.today() + timedelta(days=1)
        assert await until(lambda: len(calls) == 1)
        await asyncio.sleep(0.05)
        assert len(calls) == 1  # once a day
    finally:
        loop.cancel()


DAY_LOOK_MAX = 60.0


def test_the_day_is_looked_at_at_least_every_minute():
    from jarvis.features import code_usage

    assert 0 < code_usage.DAY_LOOK <= DAY_LOOK_MAX


# ── W6, W7: other agents, and a fork's own cap ──


async def test_claude_s_caps_never_count_or_stop_another_agent_s_session(
    settings, quiet_speaker, isolated, tmp_path
):
    from jarvis.tasks import ClaudeTask

    hub = make_hub(settings, quiet_speaker, isolated)
    meter = hub.code_usage
    cwd = tmp_path.resolve()
    claude = ClaudeTask(id=901, prompt="x", cwd=cwd, session_id="a")
    agent = ClaudeTask(id=902, prompt="x", cwd=cwd, session_id="b", model_ref="acp:gemini")
    for t in (claude, agent):
        t.busy, t.client = True, object()
        hub.tasks.tasks[t.id] = t
    assert meter._busy(claude) == []  # (the agent isn't Claude's to stop)
    assert meter._busy(agent) == [claude]
    meter.on_task_event("task_log", {"id": agent.id, "entry": {"role": "turn", "cost": 2.0}})
    assert meter.usage.today() == 0.0  # nothing it does is counted against Claude's caps


async def test_a_fork_has_its_own_cap_before_its_first_turn(
    settings, quiet_speaker, isolated, tmp_path
):
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    meter = hub.code_usage
    parent = _parent(hub, tmp_path)
    meter.usage.set_session_cap(parent.session_id, 0.2)  # the original's own cap: spent
    assert meter.gate(parent).startswith("On hold: this session")
    fork = hub.tasks.fork(parent.id)
    assert fork.session_id == parent.session_id and fork.fork
    assert meter.session_key(fork) == f"task:{fork.id}"
    assert meter.caps(fork).session == 0.0  # the default, not the original's
    assert meter.gate(fork) == ""
    await end_all(hub)


# ── W1: sessions working at once share what's left of a cap ──


async def test_sessions_working_at_once_share_the_day_s_room_and_hand_it_out_again(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    (tmp_path / "other").mkdir()
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"code_budget_day": 1.0})
    first = hub.tasks.start("one", "proj")
    assert await until(lambda: first.status == "waiting" and first.cost_usd == 0.1)
    assert Stream.instances[0].options.max_budget_usd == 1.0  # alone: the whole room
    first.client.hold = True
    hub.tasks.send(first.id, "long job")
    assert await until(lambda: first.busy)
    second = hub.tasks.start("two", "other")
    assert await until(lambda: len(Stream.instances) == 2)
    # With the first at work: an even share of the 0.9 left, less a tenth kept back.
    assert Stream.instances[1].options.max_budget_usd == 0.405
    assert await until(lambda: second.cost_usd == 0.1 and not second.busy)
    # The first's connection may still spend 0.9 of the 0.8 left: once its turn is over it
    # reopens with what's left, not all three sessions' worth.
    first.client.release()
    assert await until(lambda: len(Stream.instances) == 3, 600)
    assert Stream.instances[2].options.max_budget_usd <= 0.7 + 1e-9
    await end_all(hub)


async def test_a_session_stopped_at_its_share_reopens_with_a_new_one_while_room_is_left(
    settings, quiet_speaker, isolated, tmp_path
):
    from types import SimpleNamespace as NS

    from jarvis.tasks import ClaudeTask

    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"code_budget_day": 1.0})
    meter = hub.code_usage
    cwd = tmp_path.resolve()
    task = ClaudeTask(id=950, prompt="x", cwd=cwd, session_id="a")
    hub.tasks.tasks[task.id] = task
    meter.apply(task, NS(max_budget_usd=None))
    assert meter._given[task.id] == (1.0, 0.0, False)  # alone: all of it
    task.client, task.cost_usd = object(), 0.3
    meter._given[task.id] = (0.3, 0.0, False)  # (all another feature let it spend)
    reopened = []
    hub.tasks.reopen = lambda task_id, note="": reopened.append((task_id, note)) or True
    meter.rebalance()
    assert reopened == []  # a cap of its own is no share: it isn't handed more
    meter._given[task.id] = (0.3, 0.0, True)  # (its share, as Claude Code stopped it there)
    before = meter.key(task)
    meter.rebalance()
    assert reopened == [(task.id, "")]  # quietly
    assert meter.key(task) != before  # (a new connection's key: the reopen goes ahead)


# ── W5: a session's own usage-limit reset, and a cap on tries ──


async def test_a_session_waits_for_its_own_limit_s_reset_not_the_app_s_latest(
    settings, quiet_speaker, isolated, tmp_path
):
    import time

    from claude_agent_sdk.types import RateLimitInfo

    from jarvis.tasks import ClaudeTask

    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"code_limit_wait": True})
    now = time.time()
    hub._claude_back_at = now + 5 * 24 * 3600  # another session's weekly Opus limit
    task = ClaudeTask(id=960, prompt="x", cwd=tmp_path.resolve(), session_id="s")
    hub.tasks.tasks[task.id] = task
    task.rate_limit = RateLimitInfo(
        status="rejected", rate_limit_type="five_hour", resets_at=int((now + 3600) * 1000)
    )
    down = hub.code_limit.claude_down(lambda *_a: False)
    try:
        assert down(task, "rate_limit", "")
        assert abs(task.hold_until - (now + 3600)) < 2  # its own five-hour reset, in ms
    finally:
        hub.code_limit.forget()


async def test_waits_with_no_reset_time_stop_after_a_few_tries_in_a_row(
    settings, quiet_speaker, isolated, tmp_path
):
    from jarvis.features import code_limit
    from jarvis.tasks import ClaudeTask

    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"code_limit_wait": True})
    task = ClaudeTask(id=961, prompt="x", cwd=tmp_path.resolve(), session_id="s")
    hub.tasks.tasks[task.id] = task
    fallback = []
    down = hub.code_limit.claude_down(lambda t, why, said: fallback.append(t.id) or True)
    try:
        for _ in range(code_limit.RETRIES):
            assert down(task, "rate_limit", "")
            assert task.hold_until > 0 and fallback == []
            hub.code_limit.release(task)  # (half an hour on: it tries, and is limited again)
        assert down(task, "rate_limit", "")
        assert fallback == [task.id]  # no more waiting: the fallback takes it
        assert task.id not in hub.code_limit.tries
    finally:
        hub.code_limit.forget()
        await end_all(hub)
