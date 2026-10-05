"""Jarvis Code's usage meter (codeusage, features.code_usage): days and projects counted and
kept, Claude's usage windows, caps that hold a session's next message (and raise to let it
go), Claude Code's own stop at the cap (max_budget_usd), heads-ups at 50/80/100%, and a
shared cap used up stopping the other sessions working under it."""

import asyncio
import json
from datetime import date, timedelta

from claude_agent_sdk.types import RateLimitInfo
from code_session_fakes import Stream, end_all, events_of, make_hub, until

from jarvis import codeusage
from jarvis.codeusage import Caps, Usage, crossed, money

# ── the store ──


def test_money_reads_as_people_say_it():
    assert money(20) == "$20"
    assert money(20.5) == "$20.50"
    assert money(0.034) == "$0.03"
    assert money(1500) == "$1,500"
    assert money(-3) == "$0"


def test_marks_are_crossed_once_each_and_only_the_highest_is_said():
    assert crossed(0, 4, 10) == 0
    assert crossed(4, 5, 10) == 50
    assert crossed(5, 6, 10) == 0  # past 50 already
    assert crossed(6, 8.5, 10) == 80
    assert crossed(4, 12, 10) == 100  # 50, 80 and 100 in one turn: the highest
    assert crossed(12, 15, 10) == 0  # over already
    assert crossed(1, 5, 0) == 0  # no cap
    assert crossed(5, 5, 10) == 0


def test_days_and_projects_are_counted_kept_and_pruned(tmp_path):
    today = [date(2026, 9, 29)]
    path = tmp_path / "code_usage.json"
    usage = Usage(path, today=lambda: today[0])
    assert usage.add("/p/alpha", 0.5) == (0.0, 0.0)
    assert usage.add("/p/alpha", 0.25) == (0.5, 0.5)
    assert usage.add("/p/beta", 1.0) == (0.75, 0.0)
    assert usage.today() == 1.75 and usage.project_today("/p/alpha") == 0.75
    assert [p["name"] for p in usage.projects_on()] == ["beta", "alpha"]
    again = Usage(path, today=lambda: today[0])
    assert again.today() == 1.75 and again.days["2026-09-29"]["turns"] == 3
    today[0] = date(2026, 9, 30)
    assert again.today() == 0.0  # a new day starts from nothing
    recent = again.recent(3)
    assert [d["day"] for d in recent] == ["2026-09-28", "2026-09-29", "2026-09-30"]
    assert [d["total"] for d in recent] == [0.0, 1.75, 0.0]
    today[0] = date(2026, 9, 29) + timedelta(days=codeusage.DAYS_KEPT + 1)
    again.add("/p/alpha", 0.1)
    assert "2026-09-29" not in again.days  # past the days kept


def test_a_damaged_or_hand_edited_file_never_stops_anything(tmp_path):
    path = tmp_path / "code_usage.json"
    path.write_text("{not json")
    usage = Usage(path)
    assert usage.today() == 0.0 and not usage.unreadable
    usage.add("/p/alpha", 0.2)
    assert Usage(path).today() == 0.2  # saved over the damaged one (kept aside)
    path.write_text(json.dumps({
        "days": {"2026-09-29": {"total": "lots"}, "nonsense": {"total": 1}, date.today().isoformat(): {
            "total": 2.5, "turns": -4, "projects": {"/p/a": 1.5, "/p/b": float("nan"), "/p/c": True}}},
        "windows": [{"kind": "five_hour", "utilization": 99, "status": "maybe"}, "junk"],
        "session_caps": {"s1": 5, "s2": -1, "": 3},
        "project_caps": {"/p/a": "ten"},
    }))  # fmt: skip
    usage = Usage(path)
    assert usage.today() == 2.5 and usage.project_today("/p/a") == 1.5
    assert usage.days[date.today().isoformat()]["projects"] == {"/p/a": 1.5}
    assert usage.windows["five_hour"].utilization is None
    assert usage.windows["five_hour"].status == "allowed"
    assert usage.session_caps == {"s1": 5.0} and usage.project_caps == {}


def test_a_session_or_project_of_its_own_overrides_the_defaults():
    usage = Usage(None)
    defaults = Caps(session=5, project=10, day=20)
    assert usage.caps_for("s", "/p", defaults) == defaults
    usage.set_session_cap("s", 0)  # its own: no cap at all
    usage.set_project_cap("/p", 2.5)
    assert usage.caps_for("s", "/p", defaults) == Caps(session=0, project=2.5, day=20)
    usage.set_session_cap("s", None)  # back to the default
    assert usage.caps_for("s", "/p", defaults).session == 5


def test_claude_s_usage_windows_say_each_mark_once_and_start_over_when_they_reset():
    clock = [1000.0]
    usage = Usage(None, clock=lambda: clock[0])

    def info(**kw):
        return RateLimitInfo(
            **{"status": "allowed", "rate_limit_type": "five_hour", "resets_at": 5000, **kw}
        )

    assert usage.hear(info(utilization=0.3))[1] == 0
    window, mark = usage.hear(info(utilization=0.55))
    assert mark == 50 and window.percent == 55
    assert usage.hear(info(utilization=0.6))[1] == 0
    assert usage.hear(info(status="allowed_warning", utilization=0.85))[1] == 80
    assert usage.hear(info(status="rejected"))[1] == 100  # used up, whatever it says of use
    assert usage.windows["five_hour"].utilization == 0.85  # (a status alone keeps what's known)
    assert usage.hear(info(status="rejected"))[1] == 0  # said once
    assert usage.hear(info(utilization=0.6, resets_at=9000))[1] == 50  # a new window
    ms = usage.hear(info(rate_limit_type="seven_day", utilization=0.1, resets_at=9_000_000_000_000))
    assert ms[0].resets_at == 9_000_000_000  # milliseconds, as seconds
    assert usage.hear(info(rate_limit_type=None))[0] is None
    clock[0] = 9500.0
    shown = {w["kind"]: w for w in usage.windows_public()}
    assert shown["five_hour"]["reset"] and shown["five_hour"]["percent"] == 0
    assert shown["seven_day"]["percent"] == 10 and shown["five_hour"]["label"] == "5-hour limit"


# ── the meter in a hub ──


def _fresh(settings, quiet_speaker, isolated, tmp_path, **features):
    (tmp_path / "proj").mkdir(exist_ok=True)
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    if features:
        hub.set_feature_prefs(features)
    return hub


def _alerts(seen):
    return [e["text"] for e in seen() if e["type"] == "alert"]


async def test_no_caps_means_no_limit_and_nothing_held(settings, quiet_speaker, isolated, tmp_path):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.status == "waiting" and task.cost_usd)
    assert Stream.instances[0].options.max_budget_usd is None
    assert hub.code_usage.gate(task) == "" and hub.code_usage.usage.today() == 0.1
    await end_all(hub)


async def test_a_session_cap_warns_stops_claude_code_there_and_holds_the_next_message(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path, code_budget_session=0.25)
    seen = events_of(hub)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.status == "waiting" and task.cost_usd == 0.1)
    assert Stream.instances[0].options.max_budget_usd == 0.25  # Claude Code's own stop
    assert _alerts(seen) == []  # 40%
    hub.tasks.send(task.id, "two")
    assert await until(lambda: task.cost_usd == 0.2 and not task.busy)
    assert _alerts(seen) == ["This Jarvis Code session has used 80% of its $0.25 limit."]
    hub.tasks.send(task.id, "three")
    assert await until(lambda: task.cost_usd == 0.3 and not task.busy)
    assert _alerts(seen)[1:] == ["This Jarvis Code session has reached its $0.25 limit."]
    hub.tasks.send(task.id, "four")
    assert await until(lambda: task.gated)
    await asyncio.sleep(0.05)
    assert Stream.instances[0].said == ["one", "two", "three"]  # "four" waits
    assert task.transcript[-1]["text"].startswith("On hold: this session has spent its $0.25 limit")
    assert task.last_action == "On hold" and task.inbox.qsize() == 1
    await hub._handle({"type": "cu_state"})  # (pushes are throttled: the window asks)
    state = [e for e in seen() if e["type"] == "cu_state"][-1]
    assert state["sessions"][str(task.id)]["held"]

    await hub._handle({"type": "cu_cap", "id": task.id, "scope": "session", "cap": 1})
    # A new connection with what's left of the new cap, then the message goes.
    assert await until(
        lambda: len(Stream.instances) == 2 and Stream.instances[1].said == ["four"], 600
    )
    assert Stream.instances[1].options.max_budget_usd == 0.7
    assert not task.gated
    assert hub.code_usage.usage.session_caps == {task.session_id: 1.0}
    await end_all(hub)


async def test_a_cap_set_before_the_first_turn_goes_with_the_session(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path)
    task = hub.tasks.start("", "proj")
    await hub._handle({"type": "cu_cap", "id": task.id, "cap": 3})
    assert hub.code_usage.usage.session_caps == {f"task:{task.id}": 3.0}
    hub.tasks.send(task.id, "one")
    assert await until(lambda: task.cost_usd == 0.1)
    assert hub.code_usage.usage.session_caps == {"s": 3.0}
    assert hub.code_usage.caps(task).session == 3.0
    await hub._handle({"type": "cu_cap", "id": task.id, "cap": "lots"})  # not an amount
    assert hub.code_usage.usage.session_caps == {"s": 3.0}
    await end_all(hub)


async def test_the_day_s_cap_used_up_stops_the_others_and_holds_everyone(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "other").mkdir()
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path, code_budget_day=0.25)
    seen = events_of(hub)
    first = hub.tasks.start("one", "proj")
    assert await until(lambda: first.status == "waiting" and first.cost_usd == 0.1)
    second = hub.tasks.start("two", "other")
    assert await until(lambda: second.status == "waiting" and second.cost_usd == 0.1)
    assert Stream.instances[1].options.max_budget_usd == 0.15  # what's left of the day
    first.client.hold = True
    hub.tasks.send(first.id, "long job")
    assert await until(lambda: first.busy)
    hub.tasks.send(second.id, "three")  # 0.3 of 0.25: the day is spent
    assert await until(lambda: first.client.interrupted)
    assert await until(
        lambda: "Jarvis Code has spent today's $0.25 limit" in first.transcript[-1]["text"]
    )
    assert "Jarvis Code has reached today's $0.25 limit." in _alerts(seen)
    hub.tasks.send(second.id, "four")
    assert await until(
        lambda: second.gated.startswith("On hold: Jarvis Code has spent today's $0.25")
    )
    first.client.release()
    await end_all(hub)


async def test_a_project_s_cap_counts_its_isolated_copies_and_holds_only_that_project(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "other").mkdir()
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path, code_budget_project=0.15)
    first = hub.tasks.start("one", "proj")
    assert await until(lambda: first.status == "waiting" and first.cost_usd == 0.1)
    hub.tasks.send(first.id, "two")
    assert await until(lambda: first.cost_usd == 0.2 and not first.busy)
    elsewhere = hub.tasks.start("one", "other")
    assert await until(lambda: elsewhere.status == "waiting" and elsewhere.cost_usd == 0.1)
    assert hub.code_usage.gate(elsewhere) == ""
    assert hub.code_usage.gate(first).startswith(
        "On hold: proj has spent its $0.15 limit for today"
    )
    # Its own cap for the project, raised: it may go on.
    await hub._handle({"type": "cu_cap", "id": first.id, "scope": "project", "cap": 5})
    assert hub.code_usage.gate(first) == ""
    await end_all(hub)


async def test_raising_the_default_lets_held_sessions_go(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path, code_budget_day=0.1)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.cost_usd == 0.1 and not task.busy)
    hub.tasks.send(task.id, "two")
    assert await until(lambda: task.gated)
    hub.set_feature_prefs({"code_budget_day": 10.0})
    assert await until(lambda: "two" in [q for c in Stream.instances for q in c.said], 600)
    await end_all(hub)


async def test_rate_limit_reports_reach_the_fallback_and_the_meter(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path)
    seen = events_of(hub)
    hub.tasks.on_rate_limit(
        RateLimitInfo(
            status="allowed_warning",
            rate_limit_type="five_hour",
            utilization=0.82,
            resets_at=4_000_000_000,
        )
    )
    assert _alerts(seen) == ["You've used 80% of Claude's 5-hour limit."]
    hub.tasks.on_rate_limit(
        RateLimitInfo(status="rejected", rate_limit_type="five_hour", resets_at=4_000_000_000)
    )
    assert _alerts(seen)[-1] == "You've reached Claude's 5-hour limit."
    assert hub._claude_back_at == 4_000_000_000  # JARVIS's fallback still hears when it resets
    hub.set_feature_prefs({"code_budget_alerts": False})
    hub.tasks.on_rate_limit(
        RateLimitInfo(
            status="allowed", rate_limit_type="seven_day", utilization=0.9, resets_at=4_100_000_000
        )
    )
    assert len(_alerts(seen)) == 2  # heads-ups off: counted, not said
    await hub._handle({"type": "cu_state"})
    state = [e for e in seen() if e["type"] == "cu_state"][-1]
    assert [w["kind"] for w in state["windows"]] == ["five_hour", "seven_day"]
    assert state["windows"][1]["percent"] == 90 and not state["alerts"]


async def test_the_meter_speaks_chinese_when_the_owner_does(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path)
    hub.set_prefs({"language": "zh"})
    seen = events_of(hub)
    hub.tasks.on_rate_limit(
        RateLimitInfo(
            status="allowed", rate_limit_type="five_hour", utilization=0.51, resets_at=4_000_000_000
        )
    )
    assert _alerts(seen) == ["你已用掉 Claude 5 小时额度的 50%。"]


async def test_a_broken_gate_never_holds_a_session(settings, quiet_speaker, isolated, tmp_path):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path)

    def broken(*_args):
        raise RuntimeError("a feature's bug")

    hub.tasks.turn_gate = broken
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.cost_usd == 0.1 and not task.busy)
    assert not task.gated and Stream.instances[0].said == ["one"]
    await end_all(hub)


async def test_a_lower_cap_another_feature_set_holds(settings, quiet_speaker, isolated, tmp_path):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path, code_budget_session=0.25)

    def unattended(task, options):  # (an unattended run's own cap, set before the meter's)
        options.max_budget_usd = 0.05

    hub.tasks.session_extras.append(unattended)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.cost_usd == 0.1 and not task.busy)
    assert Stream.instances[0].options.max_budget_usd == 0.05
    await end_all(hub)


async def test_a_new_day_gives_an_open_session_the_day_s_room_quietly(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path, code_budget_day=1.0)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.cost_usd == 0.1 and not task.busy)
    assert Stream.instances[0].options.max_budget_usd == 1.0
    hub.tasks.send(task.id, "two")
    assert await until(lambda: task.cost_usd == 0.2 and not task.busy)
    notes = len(task.transcript)
    hub.code_usage.usage._today = lambda: date.today() + timedelta(days=1)
    hub.code_usage.caps_changed()  # (as the midnight loop does)
    assert await until(lambda: len(Stream.instances) == 2, 600)
    assert Stream.instances[1].options.max_budget_usd == 1.0  # the new day's whole room
    # Only the reopen's own line: no word of limits changing.
    assert [e["text"] for e in task.transcript[notes:]] == ["Reopening with the new settings."]
    await end_all(hub)


async def test_the_counts_are_saved_a_moment_later_off_the_loop(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    monkeypatch.setattr(codeusage, "SAVE_DELAY", 0.05)
    hub = _fresh(settings, quiet_speaker, isolated, tmp_path)
    task = hub.tasks.start("one", "proj")
    assert await until(lambda: task.cost_usd == 0.1 and not task.busy)
    path = hub.feature_path("code_usage.json")
    assert await until(lambda: path.exists() and Usage(path).today() == 0.1)
    await end_all(hub)


def test_its_transcript_notes_have_chinese_in_the_window():
    import re

    from jarvis.features import code_usage
    from jarvis.server import zh_strings
    from jarvis.tasks import _ENDED

    zh = zh_strings()

    def translated(text):
        return text in zh["strings"] or any(re.fullmatch(p, text) for p, _ in zh["patterns"])

    for note in [
        code_usage.HELD_SESSION.format(cap="$5"),
        code_usage.HELD_PROJECT.format(project="my app", cap="$12.50"),
        code_usage.HELD_DAY.format(cap="$1,500"),
        code_usage.STOPPED_DAY.format(cap="$20"),
        code_usage.STOPPED_PROJECT.format(project="alpha", cap="$3"),
        code_usage.CHANGED,
        _ENDED["error_max_budget_usd"],
    ]:
        assert translated(note), note


async def test_an_isolated_copys_project_is_looked_up_once_a_pass(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    """An isolated copy's project is found by following every copy's folder on the disk:
    each of the meter's passes (the gate, a connection's budget, the windows' figures, a
    cap changed) looks it up once a session, and gets the project's caps from it."""
    from types import SimpleNamespace

    from jarvis import worktrees
    from jarvis.features import code_usage
    from jarvis.tasks import ClaudeTask

    hub = _fresh(settings, quiet_speaker, isolated, tmp_path, code_budget_project=0.15)
    store = hub.code_desk.store()
    sessions = []
    for i in range(3):
        checkout = tmp_path / "copies" / "proj" / f"c{i}" / "checkout"
        checkout.mkdir(parents=True)
        store.copies.append(
            worktrees.Copy(
                slug=f"c{i}",
                project="proj",
                repo=str(tmp_path / "proj"),
                prefix="",
                checkout=str(checkout),
                branch=f"jarvis/c{i}",
                base="abc",
                into="main",
            )
        )
        task = ClaudeTask(id=50 + i, prompt="x", cwd=checkout.resolve(), kind="code")
        task.workspace = {"slug": f"c{i}"}
        hub.tasks.tasks[task.id] = task
        sessions.append(task)
    project = str(tmp_path / "proj")
    meter = hub.code_usage
    meter.usage.add(project, 0.2)  # the project has spent its cap today
    looked = []
    real = code_usage.project_of
    monkeypatch.setattr(code_usage, "project_of", lambda h, t: looked.append(t.id) or real(h, t))
    first = sessions[0]
    assert meter.gate(first) == code_usage.HELD_PROJECT.format(project="proj", cap="$0.15")
    assert looked == [first.id]
    looked.clear()
    options = SimpleNamespace(max_budget_usd=None)
    meter.apply(first, options)
    assert options.max_budget_usd == 0.01  # (nothing left: the least it can be)
    assert meter._applied[first.id] == (0.0, 0.15, 0.0, meter.usage.day())
    assert looked == [first.id]
    looked.clear()
    public = meter.public()
    assert sorted(looked) == [t.id for t in sessions]
    assert {s["project"] for s in public["sessions"].values()} == {project}
    assert public["projects"][project]["today"] == 0.2
    assert public["projects"][project]["cap"] == 0.15
    looked.clear()
    first.client = object()  # an open connection whose caps are as they were
    meter.caps_changed()
    assert looked == [first.id]  # (the others have no connection to compare)
    assert meter.left(first) == 0.15 - 0.2
    assert meter.key(first) == meter._applied[first.id]


async def test_a_save_due_as_the_app_quits_is_written_not_lost(tmp_path, monkeypatch):
    """A save that comes due while the app quits (its loop's threads already let go) is
    written there and then, rather than lost to "Executor shutdown has been called"."""
    path = tmp_path / "code_usage.json"
    usage = Usage(path)
    loop = asyncio.get_running_loop()

    def gone(*_args, **_kwargs):
        raise RuntimeError("Executor shutdown has been called")

    monkeypatch.setattr(loop, "run_in_executor", gone)
    usage.add("/p", 0.25)
    usage._timer.cancel()
    usage._save_now()  # (as its timer would, a moment later)
    await usage._writer
    assert Usage(path).today() == 0.25
    assert not usage._writing
