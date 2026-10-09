"""An engineering memory learned from corrections (features/code_lessons.py): rules in the
owner's corrections become memory facts, scoped to a project or everywhere, and sessions
hear the ones that apply."""

from pathlib import Path
from types import SimpleNamespace

from jarvis.features import code_lessons as cl


def test_only_corrections_with_a_rule_become_lessons():
    assert cl.lesson_in("no, use pnpm instead of npm here") == (
        "Use pnpm instead of npm here",
        False,
    )
    assert cl.lesson_in("Always run ruff before you say it's done") == (
        "Always run ruff before you say it's done",
        True,
    )
    assert cl.lesson_in("add a retry to the fetch") is None  # a request
    assert cl.lesson_in("should we use pnpm instead?") is None  # a question
    assert cl.lesson_in("no") is None
    assert cl.lesson_in("never " + "x " * 200) is None  # too long for a rule


class Memory:
    def __init__(self):
        self.facts = []

    def add(self, text, **kw):
        self.facts.append(SimpleNamespace(text=text, origin=kw["origin"]))


def make():
    task = SimpleNamespace(id=1, kind="code", cwd=Path("/p/web"), workspace={})
    other = SimpleNamespace(id=2, kind="code", cwd=Path("/p/api"), workspace={})
    hub = SimpleNamespace(
        memory=Memory(),
        prefs=SimpleNamespace(feature=lambda key: True),
        tasks=SimpleNamespace(tasks={1: task, 2: other}),
    )
    return cl.Lessons(hub), hub, task, other


def say(desk, task_id, text):
    desk.heard("task_log", {"id": task_id, "entry": {"role": "user", "text": text}})


def test_a_correction_is_kept_once_and_heard_where_it_applies():
    desk, hub, web, api = make()
    say(desk, 1, "no, don't mock the database in these tests")
    say(desk, 1, "no, don't mock the database in these tests")  # known already
    say(desk, 1, "From now on always write the changelog entry")
    assert len(hub.memory.facts) == 2
    assert hub.memory.facts[0].origin == "Eden Code correction (project web)"
    note = desk.turn_note(web)
    assert "Don't mock the database" in note and "changelog" in note
    assert desk.turn_note(web) == ""  # heard already: said again only when there's more
    other = desk.turn_note(api)
    assert "changelog" in other and "mock" not in other  # the project's rule stays there


def test_saying_no_to_a_step_or_undoing_a_change_teaches_too():
    desk, hub, web, _api = make()
    emitted = []
    hub.emit = lambda kind, **data: emitted.append((kind, data))
    desk.corrected(web, "use the v2 client instead of raw requests")  # (no "no," needed)
    assert hub.memory.facts[-1].text == "Use the v2 client instead of raw requests"
    desk.changes_undone({"id": 1, "undone": True, "file": "api.py"})
    assert emitted[-1][0] == "code_lesson_ask"
    desk._cmd_add({"id": 1, "text": "from now on never touch generated files"})
    assert hub.memory.facts[-1].text == "From now on never touch generated files"
    assert hub.memory.facts[-1].origin == "Eden Code correction (every project)"
    desk._cmd_add({"id": 1, "text": "x"})  # too little to keep
    assert len(hub.memory.facts) == 2
