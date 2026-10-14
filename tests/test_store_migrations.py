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


def test_no_copy_no_migration(tmp_path, store, monkeypatch):
    path = tmp_path / "things.json"
    path.write_text(json.dumps({"items": [1]}))
    before = path.read_bytes()

    def refuse(*_a, **_k):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(jsonstore.shutil, "copy2", refuse)
    with pytest.raises(jsonstore.Unreadable):
        jsonstore.load_store(path, "test_things", clock=CLOCK)
    assert path.read_bytes() == before


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
