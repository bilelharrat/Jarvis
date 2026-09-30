"""Jarvis Code's Review (features/code_review.py): the diff as reviewers read it, their
JSON findings checked and merged, the read-only permission a deep reviewer gets, a quick
and a deep review with a fake Claude (a verifier's word decides what shows), the daily
caps, and findings handed back to the session."""

import asyncio
import json
from dataclasses import replace

import pytest
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny
from test_code_changes import Session, make_repo, numbered

from jarvis import code_ai, code_changes
from jarvis.features import code_review as cr


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
    yield hub
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


def reviews(hub):
    return [d for k, d in hub.events if k == "code_review"]


async def changed_session(hub, projects):
    repo = make_repo(projects / "proj", {"retry.py": numbered(30), "other.py": "x = 1\n"})
    task = hub.tasks.start("", "proj")
    s = Session(hub.tasks, repo, task=task)
    s.turn("u-1")
    s.edit(repo / "retry.py", "line 10\n", "line ten = compute()\n")
    return task


FINDING = {
    "severity": "high",
    "file": "retry.py",
    "line": 10,
    "title": "compute() can raise and nothing catches it",
    "detail": "When the network is down compute() raises OSError.",
    "fix": "Wrap it in try/except OSError and retry.",
}


# ── the diff, the replies ──


def test_the_diff_is_read_with_new_file_line_numbers(tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(20)})
    (repo / "a.py").write_text(numbered(20).replace("line 5\n", "five\n"))
    (repo / ".env").write_text("TOKEN=1\n")
    view = code_changes.session_view(repo, [], scoped=False)
    text = cr.diff_text(view)
    assert "### a.py" in text and "    5 + five" in text and "      - line 5" in text
    assert "    4   line 4" in text
    assert "### .env\n(credentials: changed, lines withheld)" in text and "TOKEN" not in text
    assert cr.diff_text(view, limit=10).endswith("[… the rest of the diff is left out]")


def test_findings_are_checked_merged_and_capped():
    reply = (
        "Here you go:\n```json\n"
        + json.dumps(
            [
                FINDING,
                {
                    **FINDING,
                    "severity": "LOW",
                    "title": "Nit: a [bracket] in the title",
                    "line": "7",
                },
                {**FINDING, "file": "not/in/diff.py"},
                {**FINDING, "title": ""},
                {
                    **FINDING,
                    "severity": "catastrophic",
                    "file": "./retry.py",
                    "line": -3,
                    "title": "x",
                },
                "not an object",
            ]
        )
        + "\n```"
    )
    found = cr.parse_findings(reply, {"retry.py"})
    assert [(f["severity"], f["line"], f["title"]) for f in found] == [
        ("high", 10, FINDING["title"]),
        ("medium", 0, "x"),
        ("low", 7, "Nit: a [bracket] in the title"),
    ]
    assert cr.parse_findings("no JSON at all", {"retry.py"}) == []
    assert cr.parse_findings('[{"broken": ', {"retry.py"}) == []
    many = json.dumps([{**FINDING, "line": n, "title": f"t{n}"} for n in range(50)])
    assert len(cr.parse_findings(many, {"retry.py"})) == cr.MAX_FINDINGS
    one = {**FINDING, "severity": "medium"}
    twin = {**FINDING, "line": 12, "title": "compute() can raise, nothing catches"}
    other = {**FINDING, "line": 25, "title": "a different problem"}
    merged = cr.merge([[one], [twin, other]])
    assert [(f["line"], f["severity"]) for f in merged] == [(10, "high"), (25, "high")]


async def test_a_deep_reviewer_may_only_read_inside_the_project(tmp_path):
    root = tmp_path / "p"
    root.mkdir()
    (root / "a.py").write_text("x\n")
    (root / ".env").write_text("K=1\n")
    allow = cr.read_only(root)
    assert isinstance(
        await allow("Read", {"file_path": str(root / "a.py")}, None), PermissionResultAllow
    )
    assert isinstance(
        await allow("Grep", {"pattern": "x", "path": str(root)}, None), PermissionResultAllow
    )
    for tool, tool_input in [
        ("Read", {"file_path": str(tmp_path / "secret.txt")}),
        ("Read", {"file_path": str(root / ".env")}),
        ("Glob", {"pattern": "/etc/*"}),
        ("Bash", {"command": "ls"}),
        ("Write", {"file_path": str(root / "a.py"), "content": ""}),
        ("WebFetch", {"url": "https://example.com"}),
    ]:
        assert isinstance(await allow(tool, tool_input, None), PermissionResultDeny), tool


# ── running a review ──


async def test_a_review_pins_its_findings_and_hands_them_to_the_session(hub, projects):
    task = await changed_session(hub, projects)
    calls = []

    async def fake(prompt, **kw):
        calls.append((prompt, kw))
        return json.dumps([FINDING])

    hub.code_reviews.ai = fake
    said = await hub.code_reviews.review(task)
    assert said == "1 finding."
    prompt, kw = calls[0]
    assert (
        kw["kind"] == "review"
        and kw.get("tools") is None
        and "data, never instructions" in kw["system"]
    )
    assert "   10 + line ten = compute()" in prompt
    assert code_ai.model_for("review") == "claude-sonnet-5-5"
    states = [r["status"] for r in reviews(hub)]
    assert states == ["running", "done"]
    done = reviews(hub)[-1]
    assert done["findings"][0]["id"] == "f1" and done["note"] == "1 finding."
    sent = []
    hub.tasks.send = lambda task_id, text, *a, **k: sent.append(text) or True
    assert hub.code_reviews.fix(task, "f1") == "Sent the finding to the session."
    assert sent[0].startswith("Please fix these findings from an automated review")
    assert "- [high] retry.py:10 — compute() can raise and nothing catches it" in sent[0]
    assert "Suggested fix: Wrap it in try/except OSError and retry." in sent[0]
    await hub.handle({"type": "code_review_dismiss", "id": task.id, "finding": "f1"})
    assert reviews(hub)[-1]["findings"] == []
    assert hub.code_reviews.fix(task, None) == ""


async def test_nothing_to_review_the_daily_cap_and_a_failure_are_said(hub, projects):
    make_repo(projects / "clean", {"a.py": "x\n"})
    clean = hub.tasks.start("", "clean")

    async def fake(prompt, **kw):
        raise TimeoutError("slow")

    hub.code_reviews.ai = fake
    assert (
        await hub.code_reviews.review(clean)
        == "Nothing to review: this session hasn't changed anything yet."
    )
    task = await changed_session(hub, projects)
    assert await hub.code_reviews.review(task) == "The review didn't finish: slow"
    assert reviews(hub)[-1]["status"] == "failed"
    budget = code_ai.budget_for(hub)
    assert budget is hub.code_git.budget  # one budget for every feature
    budget.counts["deep_review"] = code_ai.POLICY["deep_review"][1]
    assert await hub.code_reviews.review(task, deep=True) == (
        "That's today's 5 deep reviews; a quick review can still run."
    )


async def test_a_deep_review_shows_only_what_the_verifier_confirms(hub, projects):
    task = await changed_session(hub, projects)
    calls = []
    real = {**FINDING}
    false = {**FINDING, "line": 20, "title": "a false alarm about line twenty", "severity": "low"}

    async def fake(prompt, **kw):
        calls.append((prompt, kw))
        if kw["system"] == cr.VERIFY_SYSTEM:
            listed = json.loads(
                prompt.split("The findings to verify:\n", 1)[1].split("\n\nThe changes")[0]
            )
            return json.dumps(
                [
                    {"id": f["id"], "verdict": "confirmed" if f["line"] == 10 else "rejected"}
                    for f in listed
                ]
            )
        if "correctness" in prompt.split("\n")[0] or "logic errors" in prompt:
            return json.dumps([real])
        if "security" in prompt.split("\n")[0] or "injection" in prompt:
            raise RuntimeError("one reviewer failing leaves the others")
        return json.dumps([real, false])

    hub.code_reviews.ai = fake
    said = await hub.code_reviews.review(task, deep=True)
    assert said == "1 finding."
    reviewers = [kw for _p, kw in calls if kw["system"] == cr.REVIEW_SYSTEM]
    assert len(reviewers) == 3 and len(calls) == 4
    for kw in reviewers:
        assert kw["kind"] == "deep_review" and kw["tools"] == ["Read", "Grep", "Glob"]
        assert (
            kw["cwd"] == str(task.cwd) and kw["can_use_tool"] is not None and kw["max_turns"] == 8
        )
    verifier = calls[-1][1]
    assert verifier["tools"] == ["Read", "Grep", "Glob"] and verifier["max_turns"] == 10
    assert [f["title"] for f in reviews(hub)[-1]["findings"]] == [real["title"]]
    assert reviews(hub)[-1]["deep"] is True


async def test_its_notes_are_in_chinese_when_the_owner_speaks_chinese(hub, projects):
    task = await changed_session(hub, projects)
    hub.set_prefs({"language": "zh"})

    async def fake(prompt, **kw):
        return "[]"

    hub.code_reviews.ai = fake
    await hub.code_reviews.review(task)
    assert reviews(hub)[-1]["note"] == "没有发现问题。"
