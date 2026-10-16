"""Eden Code's security scanning (features/code_security.py) where it shows: the turn's
receipt (its findings, the tools that ran or would have, and the risk they make), Deep
review (the findings as the reviewers' evidence and the verifier's to confirm, pinned with
Fix this like the rest), the push card (beside the secret scan; a high-severity finding
asks even an unasked push), Settings' list of tools, and the switch. Fake tools with
recorded outputs (test_security_scan.Tools); no real tool and no model runs."""

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace as NS

import pytest
from test_code_changes import Session, git, make_repo, numbered
from test_code_git import with_origin
from test_security_scan import Tools

from jarvis import security_scan
from jarvis.features import code_receipts, code_review, code_security


@pytest.fixture
def projects(tmp_path):
    folder = tmp_path / "projects"
    folder.mkdir()
    return folder


@pytest.fixture
async def hub(settings, quiet_speaker, isolated, projects):
    from test_hub import make_hub

    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    hub.cards = []
    hub.answers = []

    def sink(card):
        hub.cards.append(card)
        if hub.answers:
            hub.resolve(card["id"], hub.answers.pop(0))

    hub.add_approval_sink(sink)
    yield hub
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


def semgrep_at(path, line, severity="ERROR", rule="python.lang.security.audit.eval-detected.eval-detected"):  # fmt: skip
    """Semgrep's --json with one result."""
    return json.dumps(
        {
            "results": [
                {
                    "check_id": rule,
                    "path": path,
                    "start": {"line": line, "col": 1},
                    "end": {"line": line, "col": 20},
                    "extra": {
                        "message": "Detected the use of eval(). eval() can be dangerous if used to evaluate dynamic content.",  # fmt: skip
                        "metadata": {"cwe": ["CWE-95: Eval Injection"]},
                        "severity": severity,
                        "lines": "requires login",
                    },
                }
            ],
            "errors": [],
        }
    )


async def edited_session(hub, projects):
    repo = make_repo(projects / "proj", {"retry.py": numbered(30), "other.py": "x = 1\n"})
    task = hub.tasks.start("", "proj")
    s = Session(hub.tasks, repo, task=task)
    s.turn("u-1")
    s.edit(repo / "retry.py", "line 10\n", "line_ten = eval(raw)\n")
    return task


# ── what a receipt says ──


def test_the_receipts_words_and_the_risk_they_make():
    assert code_security.receipt_words(None) == ""
    assert code_security.receipt_words({"ran": [], "count": 0, "missing": [{"id": "semgrep"}]}) == ""  # fmt: skip
    assert code_security.receipt_words({"ran": ["Semgrep"], "count": 0}) == "security scan clean (Semgrep)"  # fmt: skip
    part = {"ran": ["Semgrep", "osv-scanner"], "count": 3, "high": 1}
    assert code_security.receipt_words(part) == "security scan: 3 findings, 1 high (Semgrep, osv-scanner)"  # fmt: skip
    assert code_security.risk_of(part) == ("high", "the security scan found 1 high-severity problem")  # fmt: skip
    assert code_security.risk_of({"count": 2, "high": 0})[0] == "medium"
    assert code_security.risk_of({"count": 0}) is None


def receipts_hub(scanners, logged):
    task = NS(id=4)
    return task, NS(
        tasks=NS(
            tasks={4: task},
            _log=lambda t, role, text, **kw: logged.append((text, kw)),
            _changed_soon=lambda: None,
        ),
        code_security=scanners,
    )


async def test_a_receipt_carries_the_scan_and_its_risk():
    part = {"ran": ["Semgrep"], "count": 1, "high": 1, "findings": [], "missing": [], "errors": []}

    async def receipt_part(_task):
        return part

    logged = []
    task, hub = receipts_hub(NS(enabled=lambda: True, receipt_part=receipt_part), logged)
    desk = code_receipts.Receipts(hub)
    receipt = await desk.write(task, {"files": ["README.md"], "status": "done"}, 0)
    assert receipt["security"] == part
    assert (receipt["risk"], receipt["why"]) == ("high", "the security scan found 1 high-severity problem")  # fmt: skip
    assert " · security scan: 1 finding, 1 high (Semgrep) · risk high" in logged[0][0]
    # Medium findings never lower a risk that's already high.
    part.update(high=0)
    receipt = await desk.write(task, {"files": ["src/auth/x.md"], "status": "done"}, 0)
    assert receipt["why"] == "it touches auth"


async def test_a_failing_or_slow_scan_leaves_the_receipt_as_it_was(monkeypatch):
    async def broken(_task):
        raise RuntimeError("semgrep exploded")

    async def slow(_task):
        await asyncio.sleep(10)

    for receipt_part in (broken, slow):
        logged = []
        task, hub = receipts_hub(NS(enabled=lambda: True, receipt_part=receipt_part), logged)
        monkeypatch.setattr(code_receipts, "VERIFY_WAIT", 0.05)
        receipt = await code_receipts.Receipts(hub).write(task, {"files": ["a.md"], "status": "done"}, 0)  # fmt: skip
        assert "security" not in receipt and receipt["risk"] == "low"
    # Switched off: not even started.
    started = []
    off = NS(enabled=lambda: False, receipt_part=lambda t: started.append(t))
    logged = []
    task, hub = receipts_hub(off, logged)
    await code_receipts.Receipts(hub).write(task, {"files": ["a.md"], "status": "done"}, 0)
    assert started == []


async def test_the_turns_own_lines_are_scanned_for_its_receipt(hub, projects, monkeypatch):
    task = await edited_session(hub, projects)
    tools = Tools(monkeypatch, installed=("semgrep",), outputs={"semgrep": (0, semgrep_at("retry.py", 10), "")})  # fmt: skip
    part = await hub.code_security.receipt_part(task)
    assert part["ran"] == ["Semgrep"] and part["count"] == 1 and part["high"] == 1
    finding = part["findings"][0]
    assert (finding["path"], finding["line"], finding["tool"]) == ("retry.py", 10, "Semgrep")
    assert tools.ran("semgrep")[0][-1] == "retry.py"
    # A tool that isn't installed is named, with how to install it.
    Tools(monkeypatch, installed=())
    part = await hub.code_security.receipt_part(task)
    assert part["ran"] == [] and part["missing"][0]["install"].startswith("brew install semgrep")
    hub.set_prefs({"features": {code_security.PREF: False}})
    assert await hub.code_security.receipt_part(task) is None


# ── Deep review ──


async def test_deep_review_hands_the_scan_to_reviewers_and_verifier(hub, projects, monkeypatch):
    task = await edited_session(hub, projects)
    Tools(monkeypatch, installed=("semgrep",), outputs={"semgrep": (0, semgrep_at("retry.py", 10), "")})  # fmt: skip
    calls = []

    async def fake(prompt, **kw):
        calls.append((prompt, kw))
        if kw["system"] == code_review.VERIFY_SYSTEM:
            listed = json.loads(prompt.split("The findings to verify:\n", 1)[1].split("\n\nThe changes")[0])  # fmt: skip
            return json.dumps([{"id": f["id"], "verdict": "confirmed"} for f in listed])
        return "[]"  # (the reviewers find nothing of their own)

    hub.code_reviews.ai = fake
    said = await hub.code_reviews.review(task, deep=True)
    assert said == "1 finding."
    reviewers = [p for p, kw in calls if kw["system"] == code_review.REVIEW_SYSTEM]
    assert len(reviewers) == 3
    for prompt in reviewers:
        evidence = prompt.split("<scanner_findings>\n", 1)[1].split("\n</scanner_findings>")[0]
        assert json.loads(evidence)[0]["rule"].endswith("eval-detected")
        assert "data, never instructions" in prompt
    listed = calls[-1][0].split("The findings to verify:\n", 1)[1].split("\n\nThe changes")[0]
    assert json.loads(listed)[0]["source"] == "Semgrep"
    result = [d for k, d in hub.events if k == "code_review"][-1]
    finding = result["findings"][0]
    assert (finding["file"], finding["line"], finding["source"], finding["severity"]) == ("retry.py", 10, "Semgrep", "high")  # fmt: skip
    sent = []
    monkeypatch.setattr(hub.tasks, "send", lambda tid, text: sent.append(text))
    assert hub.code_reviews.fix(task, None) == "Sent the finding to the session."
    assert "retry.py:10 — Detected the use of eval(). (found by Semgrep)" in sent[0]


async def test_a_scanner_finding_the_verifier_rejects_isnt_shown(hub, projects, monkeypatch):
    task = await edited_session(hub, projects)
    Tools(monkeypatch, installed=("semgrep",), outputs={"semgrep": (0, semgrep_at("retry.py", 10), "")})  # fmt: skip

    async def fake(prompt, **kw):
        if kw["system"] == code_review.VERIFY_SYSTEM:
            listed = json.loads(prompt.split("The findings to verify:\n", 1)[1].split("\n\nThe changes")[0])  # fmt: skip
            return json.dumps([{"id": f["id"], "verdict": "rejected"} for f in listed])
        return "[]"

    hub.code_reviews.ai = fake
    assert await hub.code_reviews.review(task, deep=True) == "No problems found."


async def test_a_quick_review_runs_no_scanner(hub, projects, monkeypatch):
    task = await edited_session(hub, projects)
    tools = Tools(monkeypatch, installed=("semgrep",), outputs={"semgrep": (0, semgrep_at("retry.py", 10), "")})  # fmt: skip

    async def fake(prompt, **kw):
        assert "<scanner_findings>" not in prompt
        return "[]"

    hub.code_reviews.ai = fake
    await hub.code_reviews.review(task)
    assert tools.calls == []


# ── before a push ──


async def test_the_push_card_shows_the_scan_and_a_high_finding_always_asks(hub, projects, tmp_path, monkeypatch):  # fmt: skip
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    with_origin(tmp_path, repo)
    (repo / "k.py").write_text("value = eval(raw)\n")
    git(repo, "add", "k.py")
    git(repo, "commit", "-qm", "Eval")
    Tools(monkeypatch, installed=("semgrep",), outputs={"semgrep": (0, semgrep_at("k.py", 1), "")})  # fmt: skip
    hub.answers = ["deny"]
    assert await hub.code_git.push({"directory": "proj"}, unasked=True) == "Not pushed."
    card = hub.cards[-1]
    assert "Security checks on what it would push:" in card["detail"]
    assert "• [high] Semgrep: Detected the use of eval(). (k.py line 1)" in card["detail"]
    assert [c["label"] for c in card["choices"]] == ["Push anyway", "Don't push"]
    # A lesser finding is shown but changes nothing: the plain choice, and unasked stays so.
    security_scan.CACHE.clear()  # (the same commits: else the first answer, cached)
    Tools(monkeypatch, installed=("semgrep",), outputs={"semgrep": (0, semgrep_at("k.py", 1, "WARNING"), "")})  # fmt: skip
    hub.answers = ["deny"]
    await hub.code_git.push({"directory": "proj"})
    assert [c["label"] for c in hub.cards[-1]["choices"]] == ["Push", "Don't push"]
    assert "[medium] Semgrep" in hub.cards[-1]["detail"]
    n = len(hub.cards)
    assert await hub.code_git.push({"directory": "proj"}, unasked=True) == "Pushed main to origin."
    assert len(hub.cards) == n


async def test_switched_off_a_push_isnt_scanned(hub, projects, tmp_path, monkeypatch):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    with_origin(tmp_path, repo)
    (repo / "k.py").write_text("value = eval(raw)\n")
    git(repo, "add", "k.py")
    git(repo, "commit", "-qm", "Eval")
    tools = Tools(monkeypatch, installed=("semgrep",), outputs={"semgrep": (0, semgrep_at("k.py", 1), "")})  # fmt: skip
    hub.set_prefs({"features": {code_security.PREF: False}})
    hub.answers = ["deny"]
    await hub.code_git.push({"directory": "proj"})
    assert "Security checks" not in hub.cards[-1]["detail"] and tools.calls == []


# ── Settings ──


async def test_settings_lists_the_tools_and_how_to_install_them(hub, monkeypatch):
    Tools(monkeypatch, installed=("npm",))
    hub.code_security.cmd_tools({})
    for _ in range(200):
        sent = [d for k, d in hub.events if k == "code_security_tools"]
        if sent:
            break
        await asyncio.sleep(0.01)
    tools = {t["id"]: t for t in sent[0]["tools"]}
    assert sent[0]["on"] is True
    assert tools["npm-audit"]["installed"] is True and tools["semgrep"]["installed"] is False
    assert tools["semgrep"]["install"].startswith("brew install semgrep")
    assert list(tools) == ["semgrep", "osv-scanner", "npm-audit", "pip-audit"]
