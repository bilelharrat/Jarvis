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
