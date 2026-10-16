"""Eden Code: every turn comes with proof, one card the owner can trust without the diff.

When a session's turn that changed files ends, its receipt goes into the transcript (so
the window, the iPhone's session view and "catch me up" all have it), as one entry:

- what changed: the files, how many;
- the tests the session ran, and how they ended (codesupervisor's journal);
- the check after the turn (code_verify), when the session has it on, with its picture of
  the page, and the video proof (code_video) when its project records one: both waited
  for, together, up to VERIFY_WAIT;
- the session's own check of its work (code_selfcheck, "Check it yourself"): its line
  ("Checked: 4 steps, 2 screenshots, no console errors"), verdict, first picture and
  video, waited for while it finishes;
- for a Spec mode task (code_spec), "Requirements met": each requirement it covers, met or
  not, with its evidence (the tests named after its criteria that passed, the reviewer's
  reason, the video proof and the check's screenshot), waited for up to SPEC_WAIT (the
  spec's check runs the project's whole test suite);
- "Assumptions": each guess made instead of asking the owner during the turn (Eden's own
  auto-answers and the session's notes: features/code_assumptions.py), with its evidence,
  risk and an Undo; an open high-risk one makes the receipt's risk high;
- the guardrails that fired in the turn (code_guardrails: the owner's rules compiled into
  checks), each blocked, asked or flagged, and how many times;
- what the security scanners the owner has installed found (code_security: Semgrep on
  the lines the turn added, osv-scanner, npm audit and pip-audit on the dependencies it
  brought in), with the tools that ran, and the ones that would have and aren't
  installed, with how to install them; run while the other proofs are waited for;
- test integrity (code_test_integrity): before the receipt may say the tests passed, the
  turn's changes to its tests are read for a test weakened (assertions taken out or
  loosened, skip/only markers, a test command that can no longer fail, tests deleted, the
  code under test mocked away), and, when Settings asks, a quick mutation pass reruns the
  relevant tests against small changes to the changed lines ("7 of 9 mutants caught");
- every move to a fallback model during the turn (from, to, why: hub._code_fallback keeps
  them on the session, task.fallbacks), so a model change is on the proof as well as in
  the transcript; and, in Model Router's Shadow mode, the model it would have picked for
  the turn's message and what that would have saved (code_router.take_shadow);
- a risk level: high when it failed, tests failed, a test was weakened, the check found
  problems, a security scanner found a high-severity problem, or it touched auth, billing,
  the database schema or secrets; medium when it was stopped, changed many files, changed
  code with no tests run (or tests that didn't finish, or ran before its last edits), or a
  scanner found something lesser; else low. Said in words, with why.

The tests line is only ever "passed" when a run that went to its end passed with a count,
nothing in the code changed after it, and no earlier failure is left uncovered
(codesupervisor.tests_verdict); a run with no count is "ran", one stopped "didn't finish",
one refused "not run", and a failed run never "(0)".

The entry's text reads well on its own (the phone, a voice summary); the window draws it
as a card from its receipt field (web/features/code-receipts.js).

Cost policy: no model calls here (the integrity check is local, and its mutation pass runs
the project's own tests in a scratch copy, off by default).
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from .. import codesupervisor as cs
from .code_security import receipt_words as security_words
from .code_security import risk_of as security_risk

log = logging.getLogger("jarvis")

VERIFY_WAIT = 120.0  # seconds a receipt waits for the check after the turn
INTEGRITY_WAIT = 240.0  # ... and for its test-integrity check (a mutation pass is bounded)
SPEC_WAIT = 900.0  # ... and for a Spec mode task's check against its requirements
MANY_FILES = 12
_CODE = (
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".go",
    ".rs",
    ".swift",
    ".kt",
    ".java",
    ".rb",
    ".c",
    ".cpp",
)


def risk_of(status: str, files: list[str], tests: list[Any], check: dict[str, Any] | None):
    """(low | medium | high, why)."""
    areas = cs.risky_areas(files)
    verdict = cs.tests_verdict(tests)
    state = verdict["state"] if verdict else ""
    code = any(f.endswith(_CODE) for f in files)
    if status == "failed":
        return "high", "the turn stopped with an error"
    if state == "failed":
        return "high", "its tests failed"
    if check and check.get("status") == "problems":
        return "high", "the check after it found problems"
    if areas:
        return "high", f"it touches {' and '.join(areas)}"
    if status == "stopped":
        return "medium", "it was stopped before it finished"
    if code and state in ("cancelled", "refused"):
        return "medium", "it changed code and its tests didn't run to the end"
    if code and state == "stale":
        return "medium", "it changed code after its tests ran"
    if len(files) >= MANY_FILES:
        return "medium", f"it changed {len(files)} files"
    if not tests and code:
        return "medium", "it changed code and ran no tests"
    if state == "passed":
        return "low", "small, tested change"
    return "low", "small change"


def tests_part(tests: list[Any]) -> dict[str, Any] | None:
    """The receipt's tests field (codesupervisor.tests_verdict): passed is True only for a
    real pass, False for a failure, None otherwise (no count, stopped, refused, out of date),
    so an older window still never shows a pass that didn't happen; state says which."""
    verdict = cs.tests_verdict(tests)
    if verdict is None:
        return None
    run, state = verdict["run"], verdict["state"]
    return {
        "command": run.command[:120],
        "passed": True if state == "passed" else False if state == "failed" else None,
        "passed_count": run.passed_count,
        "failed_count": run.failed_count,
        "state": state,
        "runs": verdict["runs"],
        "note": verdict["note"],
    }


def receipt_of(task: Any, data: dict[str, Any], tests: list[Any], check: dict[str, Any] | None):
    files = [str(f) for f in data.get("files") or []]
    status = str(data.get("status") or "")
    level, why = risk_of(status, files, tests, check)
    out = {
        "files": files[:30],
        "file_count": len(files),
        "tests": tests_part(tests),
        "check": {
            k: (check or {}).get(k, "") for k in ("status", "text", "url", "thumb")
        } if check else None,
        "risk": level,
        "why": why,
        "elapsed": int(data.get("elapsed") or 0),
    }  # fmt: skip
    if status == "stopped":
        out["stopped"] = True
    return out


# The tests line in words, by its state (the window's card has the same, code-receipts.js).
def tests_words(t: dict[str, Any] | None) -> str:
    if not t:
        return "no tests run"
    state = t.get("state") or (
        "unknown" if t.get("passed") is None else "passed" if t.get("passed") else "failed"
    )
    if state == "passed" and t.get("passed") is True and t.get("passed_count"):
        words = f"tests passed ({t['passed_count']})"
        return words + (", but a test was weakened" if t.get("trusted") is False else "")
    if state == "failed":
        # A failed run whose count we couldn't read says just that: never "(0)".
        n = t.get("failed_count")
        words = f"tests failed ({n})" if n else "tests failed"
        return words + (f" ({t['note']})" if t.get("note") else "")
    if state == "stale":
        n = t.get("passed_count")
        return (
            f"tests passed ({n}) before its last edits" if n else "tests ran before its last edits"
        )
    if state == "cancelled":
        return "tests didn't finish"
    if state == "refused":
        return "tests not run (not allowed)"
    return "tests ran (no result shown)"


def receipt_text(r: dict[str, Any]) -> str:
    parts = [f"Changed {r['file_count']} file{'s' if r['file_count'] != 1 else ''}"]
    if r.get("stopped"):
        parts.append("stopped before it finished")
    parts.append(tests_words(r["tests"]))
    for line in (r.get("integrity") or {}).get("lines") or []:
        parts.append(str(line.get("text") or "")[:160])
    if r["check"]:
        parts.append(f"check: {r['check']['text'] or r['check']['status']}"[:120])
    own = r.get("selfcheck")
    if own:
        verdict = {"pass": "passed", "fail": "found problems"}.get(
            own.get("verdict"), "not finished"
        )
        parts.append(f"{own.get('headline') or 'Checked'} ({verdict})"[:140])
    for move in r.get("fallbacks") or []:
        parts.append(f"fell back from {move['from']} to {move['to']} ({move['why']})"[:140])
    shadow = r.get("router")
    if shadow:
        parts.append(shadow_text(shadow))
    reqs = r.get("requirements")
    if reqs:
        met = sum(1 for q in reqs if q.get("status") == "met")
        parts.append(f"requirements met {met} of {len(reqs)}")
    guessed = r.get("assumptions")
    if guessed:
        high = sum(1 for a in guessed if a.get("risk") == "high")
        parts.append(f"assumed {len(guessed)}" + (f" ({high} high risk)" if high else ""))
    guards = r.get("guardrails")
    if guards:
        counts: dict[str, int] = {}
        for g in guards:
            action = str(g.get("action") or "")
            counts[action] = counts.get(action, 0) + int(g.get("count") or 1)
        said = ", ".join(f"{n} {a}" for a, n in counts.items() if a)
        parts.append(f"guardrails {said}")
    scanned = security_words(r.get("security"))
    if scanned:
        parts.append(scanned)
    parts.append(f"risk {r['risk']}: {r['why']}")
    return "Proof · " + " · ".join(parts)


_RISKS = ("low", "medium", "high")


async def _quietly(coro: Any) -> Any:
    """A proof that's extra: its failure leaves it out, never the receipt."""
    try:
        return await coro
    except Exception as exc:
        log.warning("a receipt's security scan failed: %s", exc)
        return None


def shadow_text(shadow: dict[str, Any]) -> str:
    """Model Router's Shadow pick, said on the receipt: "Model Router would pick Sonnet
    (about $0.03 less)"."""
    said = f"Model Router would pick {shadow.get('label') or shadow.get('model')}"
    save = shadow.get("saveUSD")
    if isinstance(save, int | float) and abs(save) >= 0.005:
        said += f" (about ${abs(save):.2f} {'less' if save > 0 else 'more'})"
    return said[:140]


def shadow_part(router: Any, task: Any) -> dict[str, Any] | None:
    """The turn's Shadow pick for the receipt, when it differs from the model the session
    is on; taken once either way."""
    take = getattr(router, "take_shadow", None)
    shadow = take(task.id) if callable(take) else None
    if not shadow:
        return None
    if shadow.get("model") and shadow["model"] == shadow.get("current", ""):
        return None  # it agrees with the model the session is on: nothing to say
    if shadow.get("model") == str(getattr(task, "model", "") or ""):
        return None
    return {k: shadow.get(k) for k in ("model", "effort", "label", "saveUSD")}


class Receipts:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.waiting: dict[int, asyncio.Future] = {}  # task id -> its check's result
        self.filming: dict[int, asyncio.Future] = {}  # task id -> its video proof's entry

    def tests_of(self, task_id: int, since: float) -> list[Any]:
        voice = getattr(self.hub, "code_voice", None)
        journal = getattr(voice, "journal", None)
        turns = list((getattr(journal, "turns", {}) or {}).get(task_id, []))[-1:]
        # A stopped turn isn't one of the journal's turns, but its runs are still its proof.
        stopped = (getattr(journal, "stopped", {}) or {}).get(task_id)
        if stopped is not None:
            turns = sorted([*turns, stopped], key=lambda t: t.at)[-1:]
        return [r for turn in turns if turn.at >= since for r in turn.tests]

    def checking(self, task_id: int) -> bool:
        cv = getattr(self.hub, "code_verify", None)
        try:
            return bool(cv is not None and cv.session(task_id).verify)
        except Exception:
            return False

    def videoing(self, task: Any, files: list[str]) -> bool:
        """A video proof is on its way for this turn (code_video records one)."""
        vp = getattr(self.hub, "code_video", None)
        if vp is None:
            return False
        try:
            from .code_video import changed_ui

            return bool(changed_ui(files) and vp.enabled(task) and vp.server_url(task))
        except Exception:
            return False

    def task_event(self, kind: str, data: dict[str, Any]) -> None:
        """hub.add_task_sink: a code turn that changed files ended (and its video proof,
        when one was recorded)."""
        entry = data.get("entry") or {}
        if kind == "task_log" and entry.get("role") == "video":
            waiter = self.filming.get(data.get("id"))
            if waiter is not None and not waiter.done():
                waiter.set_result(entry)
            return
        if kind != "task_finished" or data.get("task_kind") != "code" or not data.get("files"):
            return
        task = self.hub.tasks.tasks.get(data.get("id"))
        if task is None:
            return
        spawn = getattr(self.hub, "_spawn", None)
        coro = self.write(task, dict(data), time.time() - 5)
        if spawn is not None:
            spawn(coro)
        else:  # pragma: no cover - every hub has it
            coro.close()

    def verified(self, event: dict[str, Any]) -> None:
        """hub.add_event_sink(cv_verify): the check after a turn is done."""
        if event.get("state") != "done":
            return
        waiter = self.waiting.get(event.get("id"))
        if waiter is not None and not waiter.done():
            waiter.set_result(event.get("last"))

    async def write(self, task: Any, data: dict[str, Any], since: float) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        waits: dict[str, asyncio.Future] = {}
        if self.checking(task.id):
            waits["check"] = self.waiting[task.id] = loop.create_future()
        if self.videoing(task, [str(f) for f in data.get("files") or []]):
            waits["video"] = self.filming[task.id] = loop.create_future()
        selfcheck = getattr(self.hub, "code_selfcheck", None)  # Check it yourself (code_selfcheck)
        pending = selfcheck.pending(task.id) if selfcheck is not None else None
        if pending is not None:
            waits["selfcheck"] = pending
        spec = getattr(self.hub, "code_spec", None)
        if spec is not None and spec.covers(task.id):
            waits["spec"] = spec.proof_future(task.id)
        scanners = getattr(self.hub, "code_security", None)  # (code_security: the scanners)
        if scanners is not None and scanners.enabled():
            waits["security"] = asyncio.ensure_future(_quietly(scanners.receipt_part(task)))
        # Test integrity (code_test_integrity): read once the journal has the turn's runs,
        # alongside the other waits (its mutation pass, when on, takes a while).
        integrity = getattr(self.hub, "code_integrity", None)
        honest = None
        if integrity is not None:
            honest = asyncio.ensure_future(self.integrity_of(integrity, task, since))
        if waits:  # the check and the video, together, as long as VERIFY_WAIT at most
            await asyncio.wait(list(waits.values()), timeout=VERIFY_WAIT)
        if "spec" in waits and not waits["spec"].done():  # its suite can take longer
            await asyncio.wait([waits["spec"]], timeout=SPEC_WAIT - VERIFY_WAIT)
        self.waiting.pop(task.id, None)
        self.filming.pop(task.id, None)
        if "security" in waits and not waits["security"].done():
            waits["security"].cancel()  # (a tool that's still going: the receipt won't wait)
        got = {k: f.result() for k, f in waits.items() if f.done() and not f.cancelled()}
        check = got.get("check")
        video = got.get("video")
        await asyncio.sleep(0)  # (the journal hears the same turn's end on this loop)
        receipt = receipt_of(task, data, self.tests_of(task.id, since), check)
        if video and video.get("status") == "ok" and video.get("video"):
            receipt["video"] = {
                "id": str(video["video"]),
                "poster": str(video.get("poster") or ""),
                "seconds": video.get("seconds") or 0,
            }
        own = selfcheck.receipt_part(task.id) if selfcheck is not None else None
        if own:
            receipt["selfcheck"] = own
            if own.get("verdict") == "fail" and receipt["risk"] != "high":
                receipt["risk"], receipt["why"] = "high", "its own check found problems"
        if "spec" in got:
            rows = spec.attach_receipt(task.id, list(got["spec"] or []), receipt)
            if rows:
                receipt["requirements"] = rows
        ledger = getattr(self.hub, "code_assumptions", None)  # the turn's guesses
        guessed = ledger.receipt_part(task.id) if ledger is not None else None
        if guessed:
            receipt["assumptions"] = guessed
            risky = next((a for a in guessed if a["risk"] == "high" and a["state"] == "open"), None)
            if risky is not None and receipt["risk"] != "high":
                receipt["risk"], receipt["why"] = "high", f"it assumed “{risky['question'][:80]}”"
        guards = getattr(self.hub, "code_guardrails", None)  # the owner's rules that fired
        fired = guards.receipt_part(task.id) if guards is not None else None
        if fired:
            receipt["guardrails"] = fired
        scanned = got.get("security")
        if scanned:
            receipt["security"] = scanned
            said = security_risk(scanned)
            if said and _RISKS.index(said[0]) > _RISKS.index(receipt["risk"]):
                receipt["risk"], receipt["why"] = said
        if honest is not None:
            done, _ = await asyncio.wait([honest], timeout=INTEGRITY_WAIT)
            part = None
            if honest in done:
                try:
                    part = honest.result()
                except Exception as exc:  # (it never keeps the receipt back)
                    log.warning("Eden Code's test-integrity check failed: %s", exc)
            else:
                honest.cancel()
            if part:
                with_integrity(receipt, part)
        moves = list(getattr(task, "fallbacks", None) or [])
        if moves:  # (said once: the next receipt starts afresh)
            receipt["fallbacks"] = [
                {k: str(m.get(k) or "") for k in ("from", "to", "why")} for m in moves
            ]
            task.fallbacks = []
        shadow = shadow_part(getattr(self.hub, "code_router", None), task)
        if shadow:
            receipt["router"] = shadow
        self.hub.tasks._log(task, "system", receipt_text(receipt), receipt=receipt)
        self.hub.tasks._changed_soon()
        return receipt

    async def integrity_of(self, integrity: Any, task: Any, since: float):
        await asyncio.sleep(0)  # (the journal hears the same turn's end on this loop)
        tests = self.tests_of(task.id, since)
        return await integrity.part(task, tests, cs.tests_verdict(tests))


def with_integrity(receipt: dict[str, Any], part: dict[str, Any]) -> None:
    """A receipt takes its test-integrity part: a test weakened is high risk, and its tests
    line is no plain pass; tests that barely constrain the change make a low risk medium."""
    receipt["integrity"] = part
    tests = receipt.get("tests")
    if part.get("status") == "weakened":
        if tests and tests.get("state") == "passed":
            tests["trusted"] = False
        kinds = {str(f.get("kind")) for f in part.get("findings") or []}
        run_only = bool(kinds) and kinds <= {"cannot_fail", "run_cannot_fail"}
        if receipt["risk"] != "high":
            receipt["risk"] = "high"
            receipt["why"] = "a test can no longer fail" if run_only else "a test was weakened"
        return
    mutants = part.get("mutants") or {}
    if mutants.get("status") == "done" and mutants.get("tried"):
        low = mutants["caught"] / mutants["tried"] < 0.5
        if low and receipt["risk"] == "low":
            receipt["risk"], receipt["why"] = "medium", "its tests barely constrain the change"


def install(hub: Any) -> None:
    desk = Receipts(hub)
    hub.code_receipts = desk  # (for the tests)
    hub.add_task_sink(desk.task_event)
    hub.add_event_sink(("cv_verify",), desk.verified)
