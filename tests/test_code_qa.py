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


def test_a_pass_the_session_didnt_take_is_neither_counted_nor_waited_for():
    desk, sent = make(auto=True)
    desk.hub.tasks.send = lambda tid, text, note=False: False  # (queue full)
    assert not desk.start(1)
    assert desk.pending == {} and desk.runs.get(1, []) == []
    desk.hub.tasks.send = lambda tid, text, note=False: sent.append((tid, text, note)) or True
    desk.task_event("task_finished", done(["web/page.css"]))  # a real turn: it gets its pass
    assert len(sent) == 1


def test_a_pass_queued_behind_a_running_turn_is_the_turn_after_it():
    desk, sent = make(auto=True)
    desk.hub.tasks.tasks[1].busy = True  # the owner's turn is going
    assert desk.start(1)
    desk.hub.tasks.tasks[1].busy = False
    desk.task_event("task_finished", done(["web/page.css"]))  # the owner's turn: not the pass
    desk.task_event("task_finished", done(["web/page.css"]))  # the pass itself
    assert len(sent) == 1  # neither started another
    desk.task_event("task_finished", done(["web/page.css"]))  # a turn after the pass
    assert len(sent) == 2
