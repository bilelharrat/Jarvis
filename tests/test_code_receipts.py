"""Every turn's proof (features/code_receipts.py): what changed, the tests, the check after
the turn, and a risk level with why, as one transcript entry."""

from types import SimpleNamespace as NS

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
