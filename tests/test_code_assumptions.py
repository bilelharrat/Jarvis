"""The assumption ledger (features/code_assumptions.py): every guess made instead of asking
the owner (Eden's auto-answers, a busy owner's session choosing for itself, a session's own
note_assumption) is an entry with its evidence and a risk level rated by rule; high-risk
ones go to the Needs attention inbox or are stopped (code_assume_high); a turn's guesses are
on its receipt; each can be undone with the session's checkpoints, and an undone
auto-answer isn't given again."""

from dataclasses import replace
from types import SimpleNamespace as NS

import pytest

from jarvis import code_ai
from jarvis.features import code_assumptions as ca
from jarvis.features import code_receipts as cr
from jarvis.tasks import ClaudeTask


@pytest.fixture
def hub(settings, quiet_speaker, isolated, tmp_path):
    from test_hub import make_hub

    projects = tmp_path / "projects"
    (projects / "app").mkdir(parents=True)
    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    hub.memory = None
    hub.projects = projects
    hub.logged = []
    real_log = hub.tasks._log

    def log(task, role, text, **extra):
        hub.logged.append((task.id, role, text, extra))
        real_log(task, role, text, **extra)

    hub.tasks._log = log
    return hub


def task(hub, tid=3, **extra):
    t = ClaudeTask(id=tid, prompt=f"job {tid}", cwd=hub.projects / "app", status="running", **extra)
    hub.tasks.tasks[tid] = t
    return t


def asked(question, options):
    return {"question": question, "header": "", "options": options, "multi": False}


def learn(hub, question, answer):
    hub.code_answers._load()
    hub.code_answers.learned.append(
        {"project": "app", "question": question, "header": "", "answer": answer, "at": 0}
    )


# ── the rules ──


def test_the_risk_is_rated_by_rule_without_a_model():
    assert ca.risk_of("Force push to main?", "Yes", "as you answered before in app")[0] == "high"
    assert ca.risk_of("Store the session tokens in localStorage?", "Yes", "it's simpler") == (
        "high",
        "it's about tokens",
    )
    assert ca.risk_of("Which package manager?", "pnpm", "as you answered before in app") == (
        "low",
        "the owner's earlier answer",
    )
    assert ca.risk_of("Which package manager?", "pnpm", "from what you told me: “pnpm”")[0] == "low"
    assert ca.risk_of("Name the helper?", "slugify", "") == ("medium", "there's no evidence for it")
    assert (
        ca.risk_of("Name the helper?", "slugify", "probably what they meant")[1] == "it's a guess"
    )
    assert ca.risk_of("Which date format?", "ISO 8601", "the other files use it") == (
        "medium",
        "it picks a format",
    )
    assert ca.risk_of("Tabs or spaces?", "Spaces", "every file uses spaces") == (
        "low",
        "small choice with evidence",
    )
    # The session's own rating raises the level, never lowers it.
    assert ca.risk_of("Tabs or spaces?", "Spaces", "every file uses spaces", stated="high") == (
        "high",
        "the session rated it so",
    )
    assert ca.risk_of("Delete the cache dir?", "Yes", "it's regenerated", stated="low")[0] == "high"


# ── Eden's auto-answers ──


async def test_an_auto_answer_is_written_in_the_ledger(hub):
    t = task(hub)
    learn(hub, "Which package manager should I use?", "pnpm")
    q = asked("Which package manager should I use?", ["npm", "pnpm"])
    out = await hub.tasks.pre_answer(t, q)
    assert out[0] == "answer" and out[1] == "pnpm"  # (auto-answering stays on)
    [entry] = hub.code_assumptions.entries
    assert entry["source"] == "auto_answer" and entry["answer"] == "pnpm"
    assert entry["evidence"] == "as you answered before in app"
    assert entry["risk"] == "low" and entry["state"] == "open"
    assert hub.events[-1][0] == "code_assumptions"


async def test_a_high_risk_auto_answer_goes_to_the_inbox_by_default(hub):
    t = task(hub)
    learn(hub, "Should I push the branch when done?", "Yes")
    out = await hub.tasks.pre_answer(t, asked("Should I push the branch when done?", ["Yes", "No"]))
    assert out[0] == "answer"
    items = hub.code_attention.collect()
    assert [i["kind"] for i in items] == ["assumption"]
    assert (
        items[0]["said"] == "Session 3 (job 3) assumed: Should I push the branch when done? → Yes"
    )
    assert items[0]["assumption"] == hub.code_assumptions.entries[0]["id"]


async def test_with_block_a_high_risk_question_goes_to_the_owner_instead(hub):
    t = task(hub)
    hub.prefs.features[ca.PREF_HIGH] = "block"
    learn(hub, "Should I push the branch when done?", "Yes")
    assert (
        await hub.tasks.pre_answer(t, asked("Should I push the branch when done?", ["Yes", "No"]))
        is None
    )
    assert hub.code_assumptions.entries == []
    assert "guessing it is high risk" in hub.logged[-1][2]
    # A low-risk one is still answered.
    learn(hub, "Tabs or spaces?", "Spaces")
    assert (await hub.tasks.pre_answer(t, asked("Tabs or spaces?", ["Tabs", "Spaces"])))[
        0
    ] == "answer"


async def test_a_busy_owners_session_choosing_for_itself_is_a_guess_too(hub, monkeypatch):
    t = task(hub)
    monkeypatch.setattr(hub.code_answers, "_busy", lambda: True)
    out = await hub.tasks.pre_answer(t, asked("Which icon set?", ["Lucide", "Heroicons"]))
    assert out[0] == "go_on"
    [entry] = hub.code_assumptions.entries
    assert entry["source"] == "own_choice" and entry["risk"] == "medium"


# ── the session's own notes ──


async def test_the_session_notes_its_own_guess(hub):
    t = task(hub, checkpoints=["u1"])
    out = await hub.code_assumptions.note(
        t, {"question": "Which date format?", "answer": "ISO 8601", "evidence": "", "risk": "low"}
    )
    assert out["content"][0]["text"].startswith("Noted (risk medium: there's no evidence for it)")
    [entry] = hub.code_assumptions.entries
    assert entry["source"] == "agent" and entry["checkpoint"] == "u1"
    missing = await hub.code_assumptions.note(t, {"question": "", "answer": "x"})
    assert missing.get("is_error")


async def test_with_block_a_high_risk_note_waits_for_the_owners_ok(hub):
    t = task(hub)
    hub.prefs.features[ca.PREF_HIGH] = "block"
    cards = []

    async def approve(question, detail, choices, context=None):
        cards.append((question, choices, context))
        return answers.pop(0)

    hub.tasks.approve = approve
    answers = ["ask", "go"]
    note = {"question": "Drop the old users table?", "answer": "Yes", "evidence": "unused"}
    refused = await hub.code_assumptions.note(t, note)
    assert "ask them with AskUserQuestion" in refused["content"][0]["text"]
    assert cards[0][1][-1][0] == "ask"  # (an unanswered card times out to asking)
    assert cards[0][2]["task_id"] == 3
    kept = await hub.code_assumptions.note(t, note)
    assert "go ahead" in kept["content"][0]["text"]
    assert [e["state"] for e in hub.code_assumptions.entries] == ["refused", "kept"]
    assert hub.code_assumptions.inbox() == []


def test_every_session_gets_the_tool_and_the_prompt_line(hub):
    t = task(hub)
    options = NS(
        mcp_servers={"theirs": object()},
        allowed_tools=["TodoWrite"],
        system_prompt={"type": "preset", "preset": "claude_code", "append": "Eden Code."},
    )
    hub.code_assumptions.extend(t, options)
    assert set(options.mcp_servers) == {"theirs", ca.SERVER}
    assert ca.TOOL in options.allowed_tools
    assert options.system_prompt["append"].startswith("Eden Code.")
    assert "note_assumption" in options.system_prompt["append"]


# ── the turn's receipt ──


async def test_a_turns_guesses_are_on_its_receipt(hub, monkeypatch):
    t = task(hub, checkpoints=["u1"])
    await hub.code_assumptions.note(
        t, {"question": "Which date format?", "answer": "ISO 8601", "evidence": "the other files"}
    )
    hub.code_assumptions.task_event(
        "task_finished", {"id": 3, "task_kind": "code", "files": ["a.py"]}
    )
    receipts = cr.Receipts(hub)
    monkeypatch.setattr(receipts, "tests_of", lambda *_: [])
    receipt = await receipts.write(t, {"files": ["a.md"], "status": "done"}, 0)
    [row] = receipt["assumptions"]
    assert row["question"] == "Which date format?" and row["risk"] == "medium"
    assert receipt["risk"] == "low"  # (a medium guess doesn't raise the receipt's risk)
    assert " · assumed 1 · " in cr.receipt_text(receipt)
    # The next turn's receipt has only its own.
    hub.code_assumptions.task_event(
        "task_finished", {"id": 3, "task_kind": "code", "files": ["a.py"]}
    )
    assert hub.code_assumptions.receipt_part(3) == []


async def test_an_open_high_risk_guess_makes_the_receipt_high(hub, monkeypatch):
    t = task(hub)
    await hub.code_assumptions.note(t, {"question": "Deploy to production after?", "answer": "Yes"})
    hub.code_assumptions.task_event(
        "task_finished", {"id": 3, "task_kind": "code", "files": ["a.md"]}
    )
    receipts = cr.Receipts(hub)
    monkeypatch.setattr(receipts, "tests_of", lambda *_: [])
    receipt = await receipts.write(t, {"files": ["a.md"], "status": "done"}, 0)
    assert receipt["risk"] == "high" and receipt["why"].startswith("it assumed")
    assert "assumed 1 (1 high risk)" in cr.receipt_text(receipt)


async def test_a_turn_with_no_files_gets_its_own_assumptions_entry(hub):
    t = task(hub)
    await hub.code_assumptions.note(
        t, {"question": "Which locale?", "answer": "en-GB", "evidence": "README"}
    )
    hub.code_assumptions.task_event("task_finished", {"id": 3, "task_kind": "code", "files": []})
    _, role, text, extra = hub.logged[-1]
    assert role == "system" and text.startswith("Assumptions · 1 · “Which locale?” → en-GB")
    assert extra["assumptions"][0]["answer"] == "en-GB"
    # A turn with no guesses says nothing.
    n = len(hub.logged)
    hub.code_assumptions.task_event("task_finished", {"id": 3, "task_kind": "code", "files": []})
    assert len(hub.logged) == n


# ── undo and keep ──


async def test_undo_rewinds_the_turn_tells_the_session_and_stops_that_auto_answer(hub):
    t = task(hub, checkpoints=["u1", "u2"])
    rewound = []

    async def rewind_to(task_id, uuid):
        rewound.append((task_id, uuid))
        return "Rewound: the files are back as they were before that message."

    hub.tasks.rewind_to = rewind_to
    learn(hub, "Which package manager should I use?", "pnpm")
    t.checkpoints = ["u1"]
    q = asked("Which package manager should I use?", ["npm", "pnpm"])
    await hub.tasks.pre_answer(t, q)
    t.checkpoints = ["u1", "u2"]
    await hub.code_assumptions.note(
        t, {"question": "Which locale?", "answer": "en-GB", "evidence": "x"}
    )
    first, later = hub.code_assumptions.entries
    assert (first["checkpoint"], later["checkpoint"]) == ("u1", "u2")
    ok, text = await hub.code_assumptions.undo(first["id"])
    assert ok and rewound == [(3, "u1")]
    assert text.startswith("Assumption undone: “Which package manager should I use?” → pnpm.")
    assert [e["state"] for e in hub.code_assumptions.entries] == ["undone", "undone"]
    note = hub.code_assumptions.turn_note(t)
    assert "The user undid what you assumed" in note and "pnpm" in note
    assert hub.code_assumptions.turn_note(t) == ""  # (said once)
    # The same question isn't answered for the owner again.
    assert await hub.tasks.pre_answer(t, q) is None
    assert (await hub.code_assumptions.undo(first["id"])) == (True, "Already undone.")


async def test_undo_waits_for_a_working_session_and_keep_clears_the_inbox(hub):
    t = task(hub, checkpoints=["u1"])
    await hub.code_assumptions.note(t, {"question": "Rotate the API keys?", "answer": "Yes"})
    [entry] = hub.code_assumptions.entries
    t.busy = True
    assert await hub.code_assumptions.undo(entry["id"]) == (
        False,
        "It's still working. Stop it first, then undo.",
    )
    assert [i["kind"] for i in hub.code_attention.collect()] == ["assumption"]
    hub.code_assumptions._cmd_keep({"id": entry["id"]})
    assert hub.events[-1] == (
        "code_assume_result",
        {"id": entry["id"], "ok": True, "text": "Kept.", "state": "kept"},
    )
    assert hub.code_attention.collect() == []
    assert (await hub.code_assumptions.undo("nope"))[0] is False


async def test_undo_with_no_checkpoint_marks_it_without_a_rewind(hub):
    t = task(hub)
    await hub.code_assumptions.note(
        t, {"question": "Which locale?", "answer": "en-GB", "evidence": "x"}
    )

    async def rewind_to(*_):
        raise AssertionError("no checkpoint: nothing to rewind")

    hub.tasks.rewind_to = rewind_to
    ok, text = await hub.code_assumptions.undo(hub.code_assumptions.entries[0]["id"])
    assert ok and text.endswith("No files to put back.")


# ── kept, and the optional model ──


async def test_the_ledger_is_kept_beside_the_settings(hub):
    t = task(hub)
    await hub.code_assumptions.note(
        t, {"question": "Which locale?", "answer": "en-GB", "evidence": "x"}
    )
    again = ca.Ledger(hub)
    again._load()
    assert [e["question"] for e in again.entries] == ["Which locale?"]


async def test_no_model_is_called_unless_the_owner_turns_it_on(hub, monkeypatch):
    t = task(hub)
    calls = []

    async def call(prompt, **kw):
        calls.append((prompt, kw))
        return "High."

    monkeypatch.setattr(code_ai, "call", call)
    monkeypatch.setattr(code_ai, "budget_for", lambda _hub: code_ai.Budget(None))
    note = {"question": "Which locale?", "answer": "en-GB", "evidence": "the README says so"}
    await hub.code_assumptions.note(t, note)
    assert calls == [] and hub.code_assumptions.entries[-1]["risk"] == "low"
    hub.prefs.features[ca.PREF_MODEL] = True
    await hub.code_assumptions.note(t, note)
    assert calls[0][1]["kind"] == "assume_risk" and "Which locale?" in calls[0][0]
    assert hub.code_assumptions.entries[-1]["risk"] == "high"
    assert hub.code_assumptions.entries[-1]["why"] == "a model rated it so"
    # It can only raise the rules' level.
    calls.clear()

    async def low(prompt, **kw):
        return "low"

    monkeypatch.setattr(code_ai, "call", low)
    await hub.code_assumptions.note(t, {**note, "evidence": ""})
    assert hub.code_assumptions.entries[-1]["risk"] == "medium"


def test_the_assume_risk_call_is_in_the_cost_policy():
    assert code_ai.POLICY["assume_risk"] == ("haiku", 100)
    assert code_ai.Budget(None).left("assume_risk") == 100
