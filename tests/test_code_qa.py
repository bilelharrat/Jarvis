"""The Mac as the QA team (features/code_qa.py): a pass on demand, and after a turn that
changed what a user sees when auto is on, capped, never for the pass's own turn."""

from types import SimpleNamespace as NS

from jarvis.features import code_qa


def make(auto):
    sent = []
    task = NS(id=1, kind="code", files_changed={"src/app.tsx"})
    hub = NS(
        prefs=NS(feature=lambda key: auto),
        tasks=NS(
            tasks={1: task},
            send=lambda tid, text, note=False: sent.append((tid, text, note)) or True,
        ),
    )
    return code_qa.QA(hub), sent


def done(files):
    return {"id": 1, "task_kind": "code", "status": "done", "files": files}


def test_a_pass_on_demand_reports_and_never_fixes():
    desk, sent = make(auto=False)
    assert desk.start(1)
    tid, text, note = sent[0]
    assert note and "src/app.tsx" in text and "Don't fix" in text and "never buy" in text


def test_auto_runs_after_ui_changes_capped_and_not_after_its_own_turn():
    desk, sent = make(auto=True)
    desk.task_event("task_finished", done(["api/server.py"]))
    assert sent == []  # nothing a user sees
    desk.task_event("task_finished", done(["web/page.css"]))
    assert len(sent) == 1
    desk.task_event("task_finished", done(["web/page.css"]))  # the pass's own turn
    assert len(sent) == 1
    desk.task_event("task_finished", done(["web/page.css"]))
    desk.task_event("task_finished", done(["web/page.css"]))  # (its own turn again)
    desk.task_event("task_finished", done(["web/page.css"]))
    assert len(sent) == code_qa.QA_PER_HOUR
