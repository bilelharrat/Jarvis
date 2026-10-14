"""Versioned stores (jsonstore.register_store, load_store, save_store; audit O3): a file
carries its store's version, an older one is copied whole before each migration and taken
through every step in order, a step that fails leaves the file as it was and nothing is
saved over it, and one from a newer build is kept aside once before this build reads it.
Eden Code's stores carry their version."""

import json
import os
import types
from datetime import datetime

import pytest

from jarvis import code_prs, coderules, codesandbox, codeusage, jsonstore, session_store, worktrees
from jarvis.features import code_handoff, code_issues, code_unattended

CLOCK = lambda: datetime(2026, 10, 13, 9, 30, 0)  # noqa: E731


@pytest.fixture
def store():
    """A store of the test's own, forgotten afterwards."""
    yield jsonstore.register_store("test_things", 1)
    jsonstore.STORES.pop("test_things", None)


def kept_copies(path):
    return sorted(p.name for p in path.parent.glob(f"{path.name}.v*.pre-migration"))


def test_a_file_from_before_versions_is_copied_then_saved_at_the_version(tmp_path, store):
    path = tmp_path / "things.json"
    path.write_text(json.dumps({"items": [1, 2]}))
    before = path.read_bytes()
    data = jsonstore.load_store(path, "test_things", clock=CLOCK)
    assert data == {"items": [1, 2], "version": 1}
    assert json.loads(path.read_text()) == {"items": [1, 2], "version": 1}
    [copy] = kept_copies(path)
    assert copy == "things.json.v0-20261013-093000.pre-migration"
    assert (tmp_path / copy).read_bytes() == before  # the file exactly as it was
    assert oct(os.stat(tmp_path / copy).st_mode & 0o777) == "0o600"
    # Read again: nothing more to do, no second copy.
    assert jsonstore.load_store(path, "test_things", clock=CLOCK) == data
    assert len(kept_copies(path)) == 1


def test_every_step_runs_in_order_and_a_save_stamps_the_version(tmp_path, store):
    jsonstore.register_migration("test_things", 1, lambda d: {"version": 1, "names": d["items"]})
    jsonstore.register_migration("test_things", 2, lambda d: {**d, "names": sorted(d["names"])})
    assert store.version == 3
    path = tmp_path / "things.json"
    path.write_text(json.dumps({"version": 1, "items": ["b", "a"]}))
    assert jsonstore.load_store(path, "test_things", clock=CLOCK) == {
        "version": 3,
        "names": ["a", "b"],
    }
    assert kept_copies(path) == ["things.json.v1-20261013-093000.pre-migration"]
    jsonstore.save_store(path, "test_things", {"names": ["c"]})
    assert json.loads(path.read_text()) == {"names": ["c"], "version": 3}


def test_a_step_that_fails_leaves_the_file_and_nothing_is_saved_over_it(tmp_path, store):
    def broken(_data):
        raise KeyError("what it expected")

    jsonstore.register_migration("test_things", 1, broken)
    path = tmp_path / "things.json"
    path.write_text(json.dumps({"version": 1, "items": [1]}))
    before = path.read_bytes()
    with pytest.raises(jsonstore.Unreadable):
        jsonstore.load_store(path, "test_things", clock=CLOCK)
    assert path.read_bytes() == before
    assert len(kept_copies(path)) == 1  # and the copy is there too


def test_no_copy_no_migration_on_disk_but_the_data_is_read(tmp_path, store, monkeypatch):
    """A copy that can't be made (here refused; a read-only folder below) left the store
    unreadable for the run. Its data is good: updated in memory and used, the file left as
    it was, and nothing saved over it until it's read again."""
    jsonstore.register_migration("test_things", 0, lambda d: {**d, "moved": True})
    path = tmp_path / "things.json"
    path.write_text(json.dumps({"items": [1]}))
    before = path.read_bytes()

    def refuse(*_a, **_k):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(jsonstore, "keep_before_migrating", refuse)
    data = jsonstore.load_store(path, "test_things", clock=CLOCK)
    assert data == {"items": [1], "moved": True, "version": 1}
    assert path.read_bytes() == before
    with pytest.raises(jsonstore.Unreadable):
        jsonstore.save_store(path, "test_things", data)
    assert path.read_bytes() == before


def test_a_read_only_folder_still_reads_an_old_file(tmp_path, store):
    folder = tmp_path / "ro"
    folder.mkdir()
    path = folder / "things.json"
    path.write_text(json.dumps({"items": [1]}))
    os.chmod(folder, 0o500)
    try:
        assert jsonstore.load_store(path, "test_things", clock=CLOCK)["items"] == [1]
    finally:
        os.chmod(folder, 0o700)
    assert json.loads(path.read_text()) == {"items": [1]}


@pytest.mark.parametrize(
    "version",
    ['"2"', "-1", "1.0", "2.5", "true", "[2]", "9" * 300],
    ids=["string", "negative", "float", "fraction", "bool", "list", "300-digits"],
)
def test_nonsense_for_a_version_runs_no_step_and_is_never_saved_over(tmp_path, store, version):
    """2.0 was read as version 0, so a newer build's file went through the first steps;
    a 300-digit one made a copy's name too long and the store unusable."""
    ran = []
    jsonstore.register_migration("test_things", 0, lambda d: ran.append(d) or d)
    path = tmp_path / "things.json"
    path.write_text('{"version": %s, "keep": "me"}' % version)
    before = path.read_bytes()
    with pytest.raises(jsonstore.Unreadable):
        jsonstore.load_store(path, "test_things", clock=CLOCK)
    with pytest.raises(jsonstore.Unreadable):
        jsonstore.save_store(path, "test_things", {"keep": "nothing"})
    assert ran == [] and path.read_bytes() == before and not kept_copies(path)


def test_many_migrations_in_one_second_each_keep_a_copy(tmp_path, store):
    path = tmp_path / "things.json"
    for i in range(120):  # (99 ran out of names)
        path.write_text(json.dumps({"n": i}))
        jsonstore.load_store(path, "test_things", clock=CLOCK)
    assert len(kept_copies(path)) == 120


def test_going_back_a_release_twice_keeps_both_newer_files(tmp_path, store):
    """F2: the second time, a copy of the same version was there already, so none was
    made, and this build's save lost the newer build's second file."""
    path = tmp_path / "things.json"
    later = lambda: datetime(2026, 10, 14, 9, 30, 0)  # noqa: E731
    path.write_text(json.dumps({"version": 2, "items": ["A"], "newer": "first"}))
    data = jsonstore.load_store(path, "test_things", clock=CLOCK)
    jsonstore.save_store(path, "test_things", {"items": data["items"]})
    path.write_text(json.dumps({"version": 2, "items": ["A", "B"], "newer": "SECOND"}))
    data = jsonstore.load_store(path, "test_things", clock=later)
    jsonstore.load_store(path, "test_things", clock=later)  # (the same file: no new copy)
    jsonstore.save_store(path, "test_things", {"items": data["items"]})
    jsonstore.save_store(path, "test_things", {"items": data["items"]})
    copies = [(tmp_path / c).read_text() for c in kept_copies(path)]
    assert len(copies) == 2 and any("SECOND" in c for c in copies)


def test_backup_false_and_forget_leave_no_copy_from_before_a_migration(tmp_path, store):
    """F3: crash reports save with backup=False so what's dropped can't come back, yet a
    migration's copy beside it kept it whole; and a deleted session's copy stayed."""
    path = tmp_path / "things.json"
    path.write_text('{"secret": "drop-me"}')
    jsonstore.load_store(path, "test_things", clock=CLOCK)
    jsonstore.save_store(path, "test_things", {}, backup=False)
    assert not [p for p in tmp_path.iterdir() if "drop-me" in p.read_text()]
    other = tmp_path / "session.json"
    other.write_text('{"words": "private"}')
    jsonstore.load_store(other, "test_things", clock=CLOCK)
    jsonstore.save_store(other, "test_things", {"words": "x"})
    jsonstore.forget(other)
    assert not list(tmp_path.glob("session.json*"))


def test_no_store_saves_over_a_file_it_couldnt_read(tmp_path):
    """The rule kept in one place: a store that caught Unreadable as "nothing yet" and then
    saved its empty start over the owner's file can't."""
    path = tmp_path / "prefs.json"
    jsonstore.save_json(path, {"keep": 1})
    os.chmod(path, 0)
    try:
        with pytest.raises(jsonstore.Unreadable):
            jsonstore.load_json(path, dict)
        with pytest.raises(jsonstore.Unreadable):
            jsonstore.save_json(path, {})
    finally:
        os.chmod(path, 0o600)
    assert json.loads(path.read_text()) == {"keep": 1}
    assert jsonstore.load_json(path, dict) == {"keep": 1}  # readable again: saves again
    jsonstore.save_json(path, {"keep": 2})
    jsonstore.save_json(path, {"forced": 1}, over_unreadable=True)


def test_a_file_from_a_newer_build_is_kept_aside_once_and_read(tmp_path, store):
    path = tmp_path / "things.json"
    path.write_text(json.dumps({"version": 7, "items": [1], "later": True}))
    assert jsonstore.load_store(path, "test_things", clock=CLOCK)["items"] == [1]
    assert jsonstore.load_store(path, "test_things", clock=CLOCK)["items"] == [1]
    assert kept_copies(path) == ["things.json.v7-20261013-093000.pre-migration"]


def test_an_unreadable_or_damaged_file_keeps_the_old_rules(tmp_path, store):
    path = tmp_path / "things.json"
    path.write_text("{not json")
    assert jsonstore.load_store(path, "test_things", clock=CLOCK) is None
    assert any(p.name.startswith("things.json.bad-") for p in tmp_path.iterdir())
    assert jsonstore.load_store(tmp_path / "none.json", "test_things") is None


# ── Eden Code's stores ──


def test_eden_codes_stores_carry_their_version():
    for name in (
        codeusage.STORE,
        code_prs.STORE,
        code_handoff.STORE,
        code_unattended.STORE,
        code_issues.STORE,
        coderules.STORE,
        codesandbox.STORE,
        session_store.STORE,
    ):
        assert jsonstore.STORES[name].version >= 1, name
    assert jsonstore.STORES[session_store.STORE].key == "v"  # (sessions' files had it already)


def test_the_pull_request_list_from_before_versions_is_kept_and_moved_on(tmp_path):
    path = tmp_path / "code_prs.json"
    old = {
        "pulls": [
            {
                "repo": "o/r",
                "number": 4,
                "url": "https://github.com/o/r/pull/4",
                "title": "Fix it",
                "branch": "fix",
                "base": "main",
                "remote": "origin",
                "folder": str(tmp_path),
                "project": "r",
                "state": "open",
                "opened": 9e9,
            }
        ]
    }
    path.write_text(json.dumps(old))
    pulls = code_prs.PullStore(path)
    assert [(p.repo, p.number) for p in pulls.items] == [("o/r", 4)]
    assert json.loads(path.read_text())["version"] == 1
    [copy] = kept_copies(path)
    assert json.loads((tmp_path / copy).read_text()) == old


def test_usage_rules_sandbox_and_copies_save_with_their_version(tmp_path):
    usage = codeusage.Usage(tmp_path / "code_usage.json")
    usage._write(usage._data())
    assert json.loads((tmp_path / "code_usage.json").read_text())["version"] == 1
    rules = coderules.RuleBook(tmp_path / "code_rules.json")
    rules.add("/p", "allow", "Bash(ls:*)")
    assert json.loads((tmp_path / "code_rules.json").read_text())["version"] == 1
    sandbox = codesandbox.SandboxBook(tmp_path / "code_sandbox.json")
    sandbox.save()
    assert json.loads((tmp_path / "code_sandbox.json").read_text())["version"] == 1
    copies = worktrees.CopyStore(tmp_path / "copies.json")
    copies.save()
    assert json.loads((tmp_path / "copies.json").read_text())["version"] == 1


def test_a_kept_session_from_before_versions_is_read_and_moved_on(tmp_path):
    folder = tmp_path / "code_sessions"
    folder.mkdir()
    key = "ab" * 8
    (folder / f"{key}.json").write_text(json.dumps({"cwd": str(tmp_path), "title": "old"}))
    [record] = session_store.SessionStore(folder).load()
    assert record["title"] == "old"
    assert json.loads((folder / f"{key}.json").read_text())["v"] == 1
    assert len(kept_copies(folder / f"{key}.json")) == 1
    store = session_store.SessionStore(folder)
    store.load()
    store.save({}, keep=set())  # the session deleted: its copy from before goes too (F3)
    assert not list(folder.glob(f"{key}.json*"))


def _hub(tmp_path):
    return types.SimpleNamespace(feature_path=lambda name: tmp_path / name)


def test_unattended_runs_never_save_over_a_file_they_couldnt_read(tmp_path, monkeypatch):
    path = tmp_path / "code_runs.json"
    path.write_text(json.dumps({"runs": [], "jobs": [], "version": 1}))
    before = path.read_bytes()

    def unreadable(*_a, **_k):
        raise jsonstore.Unreadable(13, "Permission denied")

    monkeypatch.setattr(jsonstore, "load_store", unreadable)
    runs = code_unattended.Runs(_hub(tmp_path))
    runs.save()
    assert path.read_bytes() == before


def test_issue_watch_never_saves_over_a_file_it_couldnt_read(tmp_path, monkeypatch):
    path = tmp_path / "code_issues.json"
    path.write_text(json.dumps({"seen": {"o/r": [1, 2]}, "version": 1}))
    before = path.read_bytes()

    def unreadable(*_a, **_k):
        raise jsonstore.Unreadable(13, "Permission denied")

    monkeypatch.setattr(jsonstore, "load_store", unreadable)
    watch = code_issues.Issues(_hub(tmp_path))
    watch.save()
    assert path.read_bytes() == before


@pytest.mark.parametrize("which", ["answers", "verify-starts"])
def test_answers_and_dev_server_yeses_never_save_over_a_file_they_couldnt_read(tmp_path, which):
    """code_answers and code_verify caught Unreadable as an empty start, and their next
    save wrote that over the owner's file."""
    from pathlib import Path

    from jarvis import devservers
    from jarvis.features import code_answers, code_verify

    hub = types.SimpleNamespace(feature_path=lambda name: tmp_path / name)
    name = "code_answers.json" if which == "answers" else "code-verify-starts.json"
    path = tmp_path / name
    path.write_text(json.dumps({"learned": [], "chosen": [{"KEEP": "ME"}], "/p": ["KEEP-ME"]}))
    before = path.read_bytes()
    os.chmod(path, 0)
    try:
        if which == "answers":
            answers = code_answers.Answers(hub)
            answers._load()
            answers._save()
        else:
            cv = object.__new__(code_verify.CodeVerify)
            cv.hub = hub
            config = devservers.LaunchConfig("django", "python", ["manage.py"], 8000, why="x")
            cv._remember_start(Path("/p"), config)
    finally:
        os.chmod(path, 0o600)
    assert path.read_bytes() == before
