"""Attention-aware delegation (features/code_delegate.py): Eden Code heads-ups that can wait
are held while the owner is in a meeting or Focus and come as one digest at the next break
(urgent ones still break through); easy, low-risk to-do cards start without the owner near
the end of the day or when they step away (opt-in, capped, within budgets, sandboxed); a
meeting's coding action items become proposed to-do cards, never run on their own."""

import time
from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace as NS

import pytest

from jarvis import code_ai
from jarvis.features import code_delegate as cd
from jarvis.proactive import Alert


@pytest.fixture
def hub(settings, quiet_speaker, isolated, tmp_path):
    from test_hub import make_hub

    projects = tmp_path / "projects"
    (projects / "app").mkdir(parents=True)
    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    hub.projects = projects
    hub._in_meeting = lambda: False
    hub.quiet_verdict = lambda now: None
    return hub


def alerts(hub):
    return [d for k, d in hub.events if k == "alert"]


def ping(key="code:4:1", text="Eden Code finished in app.", title="Eden Code"):
    return Alert(key, "task", title, text)


# ── the rules ──


def test_which_heads_ups_are_eden_codes():
    assert cd.is_code_ping(ping())
    assert cd.is_code_ping(Alert("code-budget:day:x:80", "budget", "Budget", "80%"))
    assert not cd.is_code_ping(Alert("research:3", "task", "Research ready", "ready"))
    assert not cd.is_code_ping(Alert("video:abc", "task", "Video", "ready"))
    assert not cd.is_code_ping(Alert("mail:1", "mail", "Mail", "hi"))
    assert not cd.is_code_ping(Alert("budget:x", "budget", "Budget", "hi"))


def test_what_breaks_through():
    assert cd.urgent(ping("code-ok:3:1", "Session 3 needs your OK to run git push --force."))
    assert not cd.urgent(ping("code-ok:3:1", "Session 3 needs your OK to run npm test."))
    assert cd.urgent(ping("code-pr:1", "The deploy to production failed."))
    assert cd.urgent(ping("x", "Release v2 failed its checks"))
    assert cd.urgent(ping("alert:sentry:1", "A new issue in app"))
    assert not cd.urgent(ping("code:1:1", "Eden Code finished in app. All tests pass."))


def card(prompt, **extra):
    return {"id": "a1b2c3d4e5", "folder": "/x/app", "title": prompt[:40], "prompt": prompt,
            "state": "todo", **extra}  # fmt: skip


def test_an_easy_card_is_small_and_names_nothing_risky():
    assert cd.easy_card(card("Fix the typos in the README"))
    assert cd.easy_card(card("Add tests for the date parser"))
    assert not cd.easy_card(card("Fix the typo in the deploy script"))
    assert not cd.easy_card(card("Add tests for the login flow"))
    assert not cd.easy_card(card("Refactor the docs builder"))
    assert not cd.easy_card(card("Make the export faster"))  # (no easy word)
    assert not cd.easy_card(card("Fix the typos " + "x" * cd.EASY_CHARS))
    assert not cd.easy_card(card("Fix typos", state="started"))
    for extra in ({"untrusted": True}, {"issue": {"number": 1}}, {"cloud": True},
                  {"proposed": True}, {"model": "acp:gemini"}, {"mode": "auto"}):  # fmt: skip
        assert not cd.easy_card(card("Fix the typos in the README", **extra)), extra


def test_life_consent_is_read_defensively(hub):
    folder = str(hub.projects / "app")
    hub.prefs.features["code_life_context"] = True
    assert cd.life_consent(hub, folder)
    hub.prefs.features["code_life_context"] = False
    assert not cd.life_consent(hub, folder)
    hub.prefs.features["code_life_context"] = {"app": True}
    assert cd.life_consent(hub, folder)
    hub.prefs.features["code_life_context"] = {"projects": {folder: False}, "default": True}
    assert not cd.life_consent(hub, folder)
    hub.prefs.features["code_life_context"] = {"other": True}
    assert not cd.life_consent(hub, folder)
    hub.prefs.features["code_life_context"] = "odd"
    assert not cd.life_consent(hub, folder)
    hub.code_context.allowed_for = lambda f: f == folder  # (the life-context feature's own)
    assert cd.life_consent(hub, folder)


def test_end_of_day_reads_its_clock():
    now = datetime(2026, 10, 16, 12, 0)
    assert cd.end_of_day("18:15", now).hour == 18
    assert cd.end_of_day("nonsense", now).strftime("%H:%M") == "17:30"


def test_the_settings_are_cleaned():
    assert cd._per_day(9) == cd.MAX_PER_DAY and cd._per_day(True) is None
    assert cd._spend(100) == cd.SPEND_MAX and cd._spend("3") is None
    assert cd._clock("25:00") is None and cd._clock("09:05") == "09:05"


# ── 1. hold, then a digest ──


def test_held_in_a_meeting_and_digested_at_the_break(hub):
    desk = hub.code_delegate
    hub._in_meeting = lambda: True
    assert desk.gate(ping("code:4:1", "Eden Code finished in app.")) is False
    assert desk.gate(ping("code-pr:2", "Pull request #2 is ready to push", "Pull request")) is False
    assert len(desk.held) == 2
    # urgent ones, other heads-ups, and the digest itself pass
    assert desk.gate(ping("code-ok:3:1", "Session 3 needs your OK to delete the build folder."))
    assert desk.gate(Alert("mail:1", "mail", "Mail", "hello"))
    assert desk.gate(Alert("code-digest:1", "task", "While", "x"))
    assert desk.deliver() is False  # still in the meeting
    hub._in_meeting = lambda: False
    assert desk.deliver() is True
    shown = alerts(hub)
    assert len(shown) == 1 and shown[0]["title"] == "While you were in a meeting"
    assert "2 Eden Code updates" in shown[0]["text"] and "ready to push" in shown[0]["text"]
    assert desk.held == [] and desk.deliver() is False


def test_hub_notify_holds_it_and_nothing_reaches_the_phone(hub):
    hub.prefs.proactive = True
    pushed = []
    hub._notify_sinks.append(pushed.append)
    hub.quiet_verdict = lambda now: True  # Focus on
    hub.notify(ping(), speak=False)
    assert not alerts(hub) and not pushed
    assert hub.code_delegate.held[0]["why"] == "focus"
    assert hub.code_delegate.holds_push({"status": "done"})
    hub.quiet_verdict = lambda now: None
    assert not hub.code_delegate.holds_push({"status": "done"})
    hub.code_delegate.deliver()
    assert alerts(hub)[0]["title"] == "While Focus was on" and len(pushed) == 1


def test_off_holds_nothing(hub):
    hub.prefs.features[cd.PREF_HOLD] = False
    hub._in_meeting = lambda: True
    assert hub.code_delegate.gate(ping()) is True
    assert not hub.code_delegate.holds_push({})


def test_nothing_waits_past_the_longest_hold_and_held_ones_survive_a_restart(hub):
    desk = hub.code_delegate
    hub._in_meeting = lambda: True
    desk.gate(ping())
    again = cd.Delegate(hub)
    again._load()
    assert len(again.held) == 1
    again.held[0]["at"] = time.time() - cd.MAX_HOLD - 1
    assert again.deliver() is True  # back-to-back meetings: it shows anyway


def test_a_long_digest_names_a_few_and_counts_the_rest(hub):
    desk = hub.code_delegate
    hub._in_meeting = lambda: True
    for i in range(7):
        desk.gate(ping(f"code:{i}:1", f"Session {i} finished."))
    hub._in_meeting = lambda: False
    hub.quiet_verdict = lambda now: True  # (then Focus)
    desk.gate(ping("code:9:1", "Session 9 finished."))
    alert = desk.digest()
    assert alert.title == "While you were busy" and "and 4 more" in alert.text
    assert alert.key.startswith(cd.DIGEST_KEY)


def test_away_marks_the_owner_away(hub):
    calls = []

    class Cloud:
        async def away(self, by_voice=False):
            calls.append(by_voice)
            return "moved"

    hub.code_cloud = Cloud()
    cd._wrap_away(hub, hub.code_delegate)
    cd._wrap_away(hub, hub.code_delegate)  # (once)
    import asyncio

    assert asyncio.run(hub.code_cloud.away(by_voice=True)) == "moved" and calls == [True]
    assert hub.code_delegate.away_until > time.time()


# ── 2. easy cards started without the owner ──


class Runs:
    def __init__(self, hub, where=None):
        self.hub, self.where, self.active, self.started = hub, where, {}, []

    def _where(self, scope):
        return self.where or (self.hub.projects / "app", "app")

    def start(self, scope, origin="owner", sandbox=False):
        from jarvis.tasks import ClaudeTask

        tid = 50 + len(self.started)
        task = ClaudeTask(id=tid, prompt=scope.prompt, cwd=self.hub.projects / "app", status="running")
        self.hub.tasks.tasks[tid] = task
        run = NS(id=f"r{tid}", task_id=tid)
        self.active[tid] = run
        self.started.append((scope, origin, sandbox))
        return run


def setup_auto(hub, *prompts):
    hub.prefs.features[cd.PREF_AUTO] = True
    hub.code_runs = Runs(hub)
    folder = str(hub.projects / "app")
    made = [hub.code_todo.add(folder, {"prompt": p}) for p in prompts]
    desk = hub.code_delegate

    async def idle():
        return 0.0, True  # the screen is locked: away

    desk.idle = idle
    return desk, made


async def test_off_by_default_starts_nothing(hub):
    desk, _ = setup_auto(hub, "Fix the typos in the README")
    hub.prefs.features[cd.PREF_AUTO] = False
    assert await desk.autostart() is None and not hub.code_runs.started


async def test_an_easy_card_starts_sandboxed_capped_and_linked(hub):
    desk, (risky, easy) = setup_auto(hub, "Delete the old migrations", "Fix the typos in the README")
    hub.prefs.features[cd.PREF_SPEND] = 3
    started = await desk.autostart()
    assert started["card"] == easy["id"] and started["moment"] == "away"
    scope, origin, sandbox = hub.code_runs.started[0]
    assert origin == "delegate" and sandbox and scope.mode == "edits"
    assert scope.spend_cap == 3.0 and scope.hours == cd.RUN_HOURS
    assert "Fix the typos in the README" in scope.prompt and "Note from Eden" in scope.prompt
    assert easy["state"] == "started" and easy["task"] == 50 and easy["auto"]["run"] == "r50"
    assert hub.code_sandbox.own[50] is True
    assert risky["state"] == "todo"
    assert any(d["title"] == "Started without you" for d in alerts(hub))
    # one at a time: the run is still going
    assert await desk.autostart() is None


async def test_the_days_cap_and_the_budget_hold(hub):
    desk, _ = setup_auto(hub, "Fix typos in the README", "Fix typos in the docs", "Fix typos in comments")
    hub.prefs.features[cd.PREF_PER_DAY] = 1
    assert await desk.autostart() is not None
    hub.code_runs.active.clear()  # (it finished)
    assert await desk.autostart() is None  # one a day
    hub.prefs.features[cd.PREF_PER_DAY] = 3
    hub.prefs.features["code_budget_day"] = 1.0  # less than a run's $2 cap
    assert await desk.autostart() is None
    hub.prefs.features["code_budget_day"] = 0.0
    assert await desk.autostart() is not None


async def test_only_at_the_end_of_the_day_or_away(hub):
    desk, _ = setup_auto(hub, "Fix the typos in the README")

    async def here():
        return 5.0, False

    desk.idle = here
    desk.now = lambda: datetime(2026, 10, 16, 11, 0)
    assert await desk.autostart() is None
    desk.now = lambda: datetime(2026, 10, 16, 17, 5)
    started = await desk.autostart()
    assert started is not None and started["moment"] == "evening"


async def test_a_project_without_a_copy_is_skipped_for_the_day(hub):
    desk, (easy,) = setup_auto(hub, "Fix the typos in the README")
    hub.code_runs.where = "app isn't a git repository"
    assert await desk.autostart() is None
    assert desk.skipped[easy["id"]].startswith("app isn't")
    hub.code_runs.where = None
    assert await desk.autostart() is None  # (not again today)


async def test_the_optional_model_can_only_say_no(hub, monkeypatch):
    desk, (easy,) = setup_auto(hub, "Fix the typos in the README")
    hub.prefs.features[cd.PREF_MODEL] = True
    asked = []

    async def fake(prompt, **kw):
        asked.append((prompt, kw["kind"]))
        return "No."

    monkeypatch.setattr(code_ai, "complete", fake)
    assert await desk.autostart() is None and asked[0][1] == "delegate_easy"
    assert easy["id"] in desk.skipped and not hub.code_runs.started


# ── 3. meeting action items, as cards ──

NOTES = """# Standup

## Summary
- Ann saw the export crash on large files.

## Action items
- [ ] Fix the export crash in app by Friday (Ann)
- [ ] Book the offsite
"""


async def test_a_meetings_coding_items_become_proposed_cards(hub, tmp_path):
    path = tmp_path / "standup.md"
    path.write_text(NOTES)
    asked = []

    async def approval(*a, **k):
        asked.append(a)
        return "allow"

    hub.request_approval = approval
    assert await hub.code_context.offer(path, "Standup") == 1
    cards = hub.code_todo.board.of(str(hub.projects / "app"))
    assert len(cards) == 1 and not asked  # a card, not a question
    c = cards[0]
    assert c["proposed"] and c["meeting"] == "Standup" and c["mode"] == "plan" and c["state"] == "todo"
    assert "data, not instructions" in c["prompt"] and not cd.easy_card(c)
    assert any("Added a to-do card in app from Standup" in d["text"] for d in alerts(hub))
    assert await hub.code_context.offer(path, "Standup") == 0  # (the same notes again)


async def test_no_card_for_a_project_life_context_may_not_reach(hub, tmp_path):
    path = tmp_path / "standup.md"
    path.write_text(NOTES)
    hub.prefs.features["code_life_context"] = {"projects": {"app": False}, "default": True}
    assert await hub.code_delegate.meeting_cards(path, "Standup", NOTES, ["app"]) == 0
    assert not hub.code_todo.board.cards


async def test_cards_off_keeps_the_old_question(hub, tmp_path):
    path = tmp_path / "standup.md"
    path.write_text(NOTES)
    hub.prefs.features[cd.PREF_CARDS] = False
    asked = []

    async def approval(question, detail="", *a, **k):
        asked.append(question)
        return "deny"

    hub.request_approval = approval
    assert await hub.code_context.offer(path, "Standup") == 0 and asked
    assert not hub.code_todo.board.cards


def test_the_window_hears_the_state(hub):
    hub._in_meeting = lambda: True
    hub.code_delegate.gate(ping())
    hub.events.clear()
    hub.code_delegate.cmd_state({})
    kind, data = hub.events[-1]
    assert kind == "code_delegate" and data["held"] == 1 and data["why"] == "meeting"
    assert data["autostart"] is False and data["left"] == 2
