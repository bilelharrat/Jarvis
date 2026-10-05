"""Sessions in isolated copies and the per-project settings that follow them (features
code_rules and code_sandbox): an isolated copy's project is found by following every copy's
folder on the disk, so it's looked up only when some project has rules or allowed domains of
its own. With none (the usual case) the answers are the same, and no lookup is made for each
step a session asks about or each change to the sessions list."""

from types import SimpleNamespace

from code_session_fakes import Stream, make_hub

from jarvis import worktrees
from jarvis.features import code_rules, code_sandbox
from jarvis.tasks import ClaudeTask


def _hub_with_copies(settings, quiet_speaker, isolated, tmp_path, count=4):
    (tmp_path / "proj").mkdir(exist_ok=True)
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_feature_prefs({"code_sandbox_bypass": True})
    store = hub.code_desk.store()
    sessions = []
    for i in range(count):
        checkout = tmp_path / "copies" / "proj" / f"c{i}" / "checkout"
        checkout.mkdir(parents=True)
        store.copies.append(
            worktrees.Copy(
                slug=f"c{i}",
                project="proj",
                repo=str((tmp_path / "proj").resolve()),
                prefix="",
                checkout=str(checkout),
                branch=f"jarvis/c{i}",
                base="abc",
                into="main",
            )
        )
        task = ClaudeTask(id=40 + i, prompt="x", cwd=checkout.resolve(), kind="code", mode="auto")
        task.workspace = {"slug": f"c{i}"}
        hub.tasks.tasks[task.id] = task
        sessions.append(task)
    return hub, sessions


def _count_lookups(monkeypatch, module):
    looked = []
    real = module.project_of
    monkeypatch.setattr(module, "project_of", lambda h, t: looked.append(t.id) or real(h, t))
    return looked


def _options():
    return SimpleNamespace(
        disallowed_tools=[], settings=None, sandbox=None, max_budget_usd=None, hooks={}
    )


async def test_no_rules_for_any_project_means_no_lookup_for_each_step(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    hub, sessions = _hub_with_copies(settings, quiet_speaker, isolated, tmp_path)
    desk = hub.code_rules
    looked = _count_lookups(monkeypatch, code_rules)
    task = sessions[-1]
    none = {"allow": [], "ask": [], "deny": []}
    assert desk.rules_of(task) == none == desk.book.rules(str(tmp_path / "proj"))
    assert desk.check(task, "Bash", {"command": "rm -rf build"}) is None
    assert desk.key(task) == ((), ())
    options = _options()
    desk.apply(task, options)
    assert options.disallowed_tools == [] and options.settings is None
    assert looked == []
    # A rule for the project: each session in one of its copies is held to it.
    project = str((tmp_path / "proj").resolve())
    desk.book.add(project, "deny", "Bash(rm:*)")
    assert desk.check(task, "Bash", {"command": "rm -rf build"})[0] == "deny"
    assert desk.key(task) == (("Bash(rm:*)",), ())
    assert looked == [task.id, task.id]
    # (and a session elsewhere, in a project with no rules, has none)
    (tmp_path / "other").mkdir()
    elsewhere = ClaudeTask(id=90, prompt="y", cwd=(tmp_path / "other").resolve(), kind="code")
    assert desk.check(elsewhere, "Bash", {"command": "rm -rf build"}) is None


async def test_no_allowed_domains_for_any_project_means_no_lookup_as_sessions_change(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    hub, sessions = _hub_with_copies(settings, quiet_speaker, isolated, tmp_path)
    desk = hub.code_sandbox
    looked = _count_lookups(monkeypatch, code_sandbox)
    task = sessions[0]
    assert desk.wanted(task)  # Bypass, with the sandbox switch on
    assert desk.key(task) == (True, ())
    options = _options()
    desk.apply(task, options)
    assert options.sandbox["network"]["allowedDomains"] == []
    task.client = object()  # an open connection with what it was given
    for _ in range(20):  # every change to the sessions list settles each session
        desk.on_task_event("tasks", {"items": []})
    assert looked == []
    assert not task.reopen
    # The project allows a domain: its sessions' connections take it up, with a lookup.
    project = str((tmp_path / "proj").resolve())
    desk.book.add(project, ["registry.npmjs.org"])
    assert desk.domains(task) == ("registry.npmjs.org",)
    assert desk.key(task) == (True, ("registry.npmjs.org",))
    desk.settle(task)
    assert task.reopen  # (reopened between steps, with the new allowlist)
    assert looked and set(looked) == {task.id}
