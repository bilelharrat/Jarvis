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


def ui_hub(tmp_path, kind, verdict=None):
    """code_qa_auto as its default ("ui"): a project that is a front-end or not, and the
    turn's own check (code_selfcheck) passed or not."""
    folder = tmp_path / kind
    folder.mkdir()
    if kind == "web":
        (folder / "package.json").write_text('{"dependencies": {"svelte": "5"}}')
    sent = []
    task = NS(id=1, kind="code", files_changed={"src/app.svelte"}, cwd=folder)
    selfcheck = NS(receipt_part=lambda tid: {"verdict": verdict} if verdict else None)
    hub = NS(
        prefs=NS(feature=lambda key: code_qa.UI),
        tasks=NS(tasks={1: task}, send=lambda tid, text, note=False: sent.append(tid) or True),
        code_selfcheck=selfcheck,
    )
    return code_qa.QA(hub), sent


def test_by_default_a_pass_follows_ui_changes_in_ui_projects_only(tmp_path):
    desk, sent = ui_hub(tmp_path, "web")
    desk.task_event("task_finished", done(["src/app.svelte"]))
    assert sent == [1]
    desk, sent = ui_hub(tmp_path, "tool")  # no front-end, no dev server, no Xcode project
    desk.task_event("task_finished", done(["src/app.svelte"]))
    assert sent == []


def test_by_default_no_pass_after_a_turn_whose_own_check_passed(tmp_path):
    desk, sent = ui_hub(tmp_path, "web", verdict="pass")
    desk.task_event("task_finished", done(["src/app.svelte"]))
    assert sent == []
    (tmp_path / "again").mkdir()
    desk, sent = ui_hub(tmp_path / "again", "web", verdict="fail")
    desk.task_event("task_finished", done(["src/app.svelte"]))
    assert sent == [1]


def test_the_setting_takes_true_false_or_ui():
    from jarvis import prefs

    clean = prefs.FEATURE_PREFS["code_qa_auto"]
    assert clean[0] == "ui"
    assert [clean[1](v) for v in (True, False, "ui", "yes", 1)] == [True, False, "ui", None, None]
