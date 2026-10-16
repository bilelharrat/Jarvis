"""Every turn's proof (features/code_receipts.py): what changed, the tests, the check after
the turn, and a risk level with why, as one transcript entry."""

from itertools import product
from types import SimpleNamespace as NS

from jarvis import codesupervisor as cs
from jarvis.features import code_receipts as cr


def run(passed, ok=3, bad=0):
    return NS(command="pytest", passed=passed, passed_count=ok, failed_count=bad)


def test_the_risk_level_says_why():
    assert cr.risk_of("failed", ["a.py"], [], None) == ("high", "the turn stopped with an error")
    assert cr.risk_of("done", ["a.py"], [run(False, 2, 1)], None)[0] == "high"
    assert cr.risk_of("done", ["a.py"], [run(True)], {"status": "problems"})[0] == "high"
    assert cr.risk_of("done", ["src/billing/charge.py"], [run(True)], None) == (
        "high",
        "it touches billing",
    )
    assert cr.risk_of("done", ["app.py"], [], None) == (
        "medium",
        "it changed code and ran no tests",
    )
    assert cr.risk_of("done", ["README.md"], [], None) == ("low", "small change")
    assert cr.risk_of("done", ["a.py"], [run(True)], {"status": "ok"}) == (
        "low",
        "small, tested change",
    )


def test_the_receipt_reads_on_its_own():
    r = cr.receipt_of(None, {"files": ["a.py", "b.py"], "status": "done"}, [run(True, 12)], None)
    assert cr.receipt_text(r) == (
        "Proof · Changed 2 files · tests passed (12) · risk low: small, tested change"
    )


def test_a_run_with_no_counts_is_unknown_and_no_line_says_zero():
    files = {"files": ["a.py"], "status": "done"}
    unknown = cr.receipt_of(None, files, [run(True, 0, 0)], None)
    assert unknown["tests"]["passed"] is None
    assert "tests ran (no result shown)" in cr.receipt_text(unknown)
    failed = cr.receipt_of(None, files, [run(False, 0, 0)], None)
    assert failed["tests"]["passed"] is False
    assert " · tests failed · " in cr.receipt_text(failed)
    for r in (unknown, failed):
        assert "(0)" not in cr.receipt_text(r)


async def test_a_turn_that_changed_files_gets_its_receipt_in_the_transcript():
    logged = []
    task = NS(id=4)
    hub = NS(
        tasks=NS(
            tasks={4: task},
            _log=lambda t, role, text, **kw: logged.append((role, text, kw)),
            _changed_soon=lambda: None,
        ),
    )
    desk = cr.Receipts(hub)
    receipt = await desk.write(task, {"files": ["src/auth/login.py"], "status": "done"}, 0)
    assert receipt["risk"] == "high" and logged[0][0] == "system"
    assert logged[0][1].startswith("Proof · Changed 1 file") and logged[0][2]["receipt"] == receipt


async def test_the_receipt_waits_for_the_video_proof_and_carries_it(monkeypatch):
    import asyncio

    logged = []
    task = NS(id=5)
    hub = NS(
        tasks=NS(
            tasks={5: task},
            _log=lambda t, role, text, **kw: logged.append(kw),
            _changed_soon=lambda: None,
        ),
    )
    desk = cr.Receipts(hub)
    monkeypatch.setattr(desk, "videoing", lambda t, files: True)
    writing = asyncio.ensure_future(
        desk.write(task, {"files": ["web/page.tsx"], "status": "done"}, 0)
    )
    await asyncio.sleep(0.01)
    desk.task_event(
        "task_log",
        {
            "id": 5,
            "entry": {
                "role": "video",
                "status": "ok",
                "video": "a" * 24,
                "poster": "QUJD",
                "seconds": 6,
            },
        },
    )
    receipt = await asyncio.wait_for(writing, 2)
    assert receipt["video"] == {"id": "a" * 24, "poster": "QUJD", "seconds": 6}
    assert logged[0]["receipt"]["video"]["id"] == "a" * 24


# A receipt never claims a pass that didn't happen (roadmap 1: the filmed "Tests passed (0)"
# after a failed run): no tests run, a failed run, a cancelled or refused one, a pass before
# the last edits, a narrower rerun after a failure, a stopped turn.


def tr(passed, ok=3, bad=0, command="pytest", outcome="", edited=False):
    return cs.TestRun(command, passed, bad, ok, outcome, edited)


FILES = {"files": ["app.py"], "status": "done"}


def text_of(tests, data=FILES):
    r = cr.receipt_of(None, data, tests, None)
    return r, cr.receipt_text(r)


def test_no_tests_run_is_said_and_is_medium_risk_for_code():
    r, text = text_of([])
    assert r["tests"] is None and " · no tests run · " in text
    assert r["risk"] == "medium" and "passed" not in text


def test_a_failed_run_is_never_a_pass_and_never_zero():
    r, text = text_of([tr(False, 4, 1)])
    assert r["tests"]["passed"] is False and r["tests"]["state"] == "failed"
    assert "tests failed (1)" in text and "passed" not in text and "(0)" not in text
    assert r["risk"] == "high"


def test_fail_first_then_the_same_run_passing_is_a_pass():
    r, text = text_of([tr(False, 4, 1, "npm test"), tr(True, 5, 0, "npm test")])
    assert r["tests"]["state"] == "passed" and "tests passed (5)" in text
    assert r["tests"]["runs"] == 2


def test_a_narrower_rerun_doesnt_hide_the_suites_failure():
    r, text = text_of([tr(False, 49, 1, "pytest"), tr(True, 3, 0, "pytest tests/test_a.py")])
    assert r["tests"]["passed"] is False
    assert "tests failed (1) (a later, narrower run passed)" in text


def test_cancelled_refused_and_out_of_date_runs_say_so():
    r, text = text_of([tr(False, 0, 0, outcome="cancelled")])
    assert r["tests"]["passed"] is None and "tests didn't finish" in text
    assert r["risk"] == "medium"
    r, text = text_of([tr(False, 0, 0, outcome="refused")])
    assert r["tests"]["passed"] is None and "tests not run (not allowed)" in text
    r, text = text_of([tr(True, 8, edited=True)])
    assert r["tests"]["passed"] is None and "tests passed (8) before its last edits" in text
    assert r["why"] == "it changed code after its tests ran"


def test_a_stopped_turn_says_it_stopped():
    r, text = text_of([tr(True, 2)], {"files": ["app.py"], "status": "stopped"})
    assert r["stopped"] is True and "stopped before it finished" in text
    assert r["risk"] == "medium" and r["why"] == "it was stopped before it finished"


KINDS = {
    "pass": dict(passed=True, ok=5),
    "pass-other": dict(passed=True, ok=2, command="pytest tests/test_a.py"),
    "pass-big": dict(passed=True, ok=60, command="pytest -q"),
    "pass-nocount": dict(passed=True, ok=0),
    "pass-stale": dict(passed=True, ok=5, edited=True),
    "fail": dict(passed=False, ok=4, bad=1),
    "fail-nocount": dict(passed=False, ok=0, bad=0),
    "cancelled": dict(passed=False, ok=0, outcome="cancelled"),
    "refused": dict(passed=False, ok=0, outcome="refused"),
}


def test_every_short_sequence_of_runs_claims_a_pass_only_when_one_happened():
    for n in (1, 2, 3):
        for names in product(KINDS, repeat=n):
            runs = [tr(**KINDS[name]) for name in names]
            r, text = text_of(runs)
            claims = r["tests"]["passed"] is True or (
                "tests passed (" in text and "before its last edits" not in text
            )
            if not claims:
                continue
            done = [x for x in runs if not x.outcome]
            last = done[-1]
            assert last.passed and last.passed_count > 0 and not last.edited_after, names
            for i, x in enumerate(done):
                if not x.passed:  # every failure covered by a later pass
                    total = x.passed_count + x.failed_count
                    assert any(
                        y.passed and (y.command == x.command or (total and y.passed_count >= total))
                        for y in done[i + 1 :]
                    ), names
            assert r["risk"] != "high" or "touches" in r["why"], names


def test_a_weakened_test_takes_the_plain_pass_away_and_makes_it_high_risk():
    r = cr.receipt_of(None, FILES, [tr(True, 6)], None)
    part = {
        "status": "weakened",
        "findings": [{"kind": "assert_removed", "file": "tests/test_a.py", "text": "x"}],
        "mutants": None,
        "lines": [
            {"tone": "bad", "text": "A test was weakened: 1 assertion taken out of tests/test_a.py"}
        ],
    }
    cr.with_integrity(r, part)
    assert r["tests"]["trusted"] is False and r["risk"] == "high"
    assert r["why"] == "a test was weakened"
    text = cr.receipt_text(r)
    assert "tests passed (6), but a test was weakened" in text
    assert text.count("A test was weakened: 1 assertion taken out of tests/test_a.py") == 1


def test_few_mutants_caught_makes_a_low_risk_medium():
    r = cr.receipt_of(None, {"files": ["README.md"], "status": "done"}, [tr(True, 6)], None)
    assert r["risk"] == "low"
    mutants = {"status": "done", "caught": 1, "tried": 6, "total": 6, "survived": []}
    cr.with_integrity(r, {"status": "ok", "findings": [], "mutants": mutants, "lines": []})
    assert r["risk"] == "medium" and r["why"] == "its tests barely constrain the change"


async def test_the_receipt_carries_the_integrity_part_and_a_stopped_turns_tests():
    logged = []
    task = NS(id=9)
    seen = {}

    class Desk:
        async def part(self, task, tests, verdict):
            seen["tests"], seen["verdict"] = tests, verdict
            return {
                "status": "ok",
                "findings": [],
                "mutants": {"status": "done", "caught": 7, "tried": 9, "total": 9, "survived": []},
                "lines": [
                    {"tone": "ok", "text": "Tests constrain this change: 7 of 9 mutants caught"}
                ],
            }

    journal = cs.Journal(clock=lambda: 100.0)
    journal.stopped[9] = cs.Turn(100.0, "stopped", [], [tr(True, 9)], "")
    hub = NS(
        tasks=NS(
            tasks={9: task},
            _log=lambda t, role, text, **kw: logged.append((text, kw)),
            _changed_soon=lambda: None,
        ),
        code_voice=NS(journal=journal),
        code_integrity=Desk(),
    )
    receipt = await cr.Receipts(hub).write(task, {"files": ["app.py"], "status": "stopped"}, 0)
    assert seen["verdict"]["state"] == "passed" and receipt["tests"]["passed_count"] == 9
    assert receipt["integrity"]["mutants"]["caught"] == 7
    assert "Tests constrain this change: 7 of 9 mutants caught" in logged[0][0]


async def test_every_fallback_and_the_routers_shadow_pick_are_on_the_receipt():
    """A model change is never silent: each move to a fallback model since the last receipt
    (task.fallbacks, hub._code_fallback) is on it, said once; and Model Router's Shadow pick
    with what it would have saved, unless it agrees with the session's model."""
    logged = []
    moves = [
        {
            "from": "Opus 5.5",
            "to": "Sonnet 5.5",
            "why": "its usage limit or a rate limit",
            "at": 1.0,
        }
    ]
    task = NS(id=4, model="claude-opus-5-5", fallbacks=list(moves))
    shadows = {4: {"model": "claude-sonnet-5-5", "effort": "low", "label": "Sonnet 5.5",
                   "current": "claude-opus-5-5", "saveUSD": 0.0381}}  # fmt: skip
    hub = NS(
        tasks=NS(
            tasks={4: task},
            _log=lambda t, role, text, **kw: logged.append(text),
            _changed_soon=lambda: None,
        ),
        code_router=NS(take_shadow=lambda tid: shadows.pop(tid, None)),
    )
    receipt = await cr.Receipts(hub).write(task, {"files": ["README.md"], "status": "done"}, 0)
    assert receipt["fallbacks"] == [
        {"from": "Opus 5.5", "to": "Sonnet 5.5", "why": "its usage limit or a rate limit"}
    ]
    assert receipt["router"] == {
        "model": "claude-sonnet-5-5",
        "effort": "low",
        "label": "Sonnet 5.5",
        "saveUSD": 0.0381,
    }
    assert "fell back from Opus 5.5 to Sonnet 5.5 (its usage limit or a rate limit)" in logged[0]
    assert "Model Router would pick Sonnet 5.5 (about $0.04 less)" in logged[0]
    assert task.fallbacks == []  # (said once)
    again = await cr.Receipts(hub).write(task, {"files": ["README.md"], "status": "done"}, 0)
    assert "fallbacks" not in again and "router" not in again


def test_a_shadow_pick_that_agrees_or_costs_more_says_so():
    agree = NS(take_shadow=lambda tid: {"model": "claude-opus-5-5", "current": "claude-opus-5-5"})
    assert cr.shadow_part(agree, NS(id=1, model="claude-opus-5-5")) is None
    assert (
        cr.shadow_text({"label": "Opus 5.5", "saveUSD": -0.2})
        == "Model Router would pick Opus 5.5 (about $0.20 more)"
    )
    assert cr.shadow_text({"model": "gpt-6", "saveUSD": None}) == "Model Router would pick gpt-6"
    assert cr.shadow_part(NS(), NS(id=1, model="m")) is None  # (a router without Shadow mode)
