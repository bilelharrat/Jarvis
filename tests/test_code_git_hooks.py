"""The repository's git hooks never run on a commit or merge Eden makes by itself (an
isolated copy's commit, landing it, a pull request's follow-up commit), since a session can
edit what they run; and "edits" mode asks before an edit to a hook manager's config
(pre-commit, lefthook, lint-staged, husky, simple-git-hooks, package.json hook keys) or to
Eden's own .jarvis/. Real git in temp repositories."""

import json
from pathlib import Path

import pytest
from test_code_changes import git, make_repo

from jarvis import worktrees
from jarvis.features.code_pr import PullDesk
from jarvis.tasks import ClaudeTask, TaskManager


def hooked(repo: Path, marker: Path) -> None:
    """Every hook a commit or merge runs writes its name to marker."""
    hooks = repo / ".git" / "hooks"
    hooks.mkdir(parents=True, exist_ok=True)
    for name in ("pre-commit", "commit-msg", "post-commit", "post-merge"):
        hook = hooks / name
        hook.write_text(f"#!/bin/sh\necho {name} >> '{marker}'\n")
        hook.chmod(0o755)


def test_an_isolated_copys_commit_and_landing_run_no_hooks(tmp_path):
    repo = make_repo(tmp_path / "r", {"a.py": "x = 1\n"})
    marker = tmp_path / "ran"
    hooked(repo, marker)
    copy, _ = worktrees.create(repo, tmp_path / "w", "s", taken=set())
    (copy.cwd / "a.py").write_text("x = 2\n")
    assert worktrees.commit_all(copy, "work") == ""
    (copy.cwd / "b.py").write_text("y = 1\n")
    landed = worktrees.land(copy, "more work")
    assert landed.ok, landed
    assert (repo / "b.py").exists()  # landed in the main folder…
    assert not marker.exists()  # …with none of its hooks run
    git(repo, "commit", "--allow-empty", "-qm", "the owner's own")
    assert marker.read_text().startswith("pre-commit")  # the owner's commits keep them


def test_a_pull_requests_follow_up_commit_runs_no_hooks(tmp_path):
    repo = make_repo(tmp_path / "r", {"a.py": "x = 1\n"})
    marker = tmp_path / "ran"
    hooked(repo, marker)
    (repo / "a.py").write_text("x = 2\n")
    assert PullDesk._commit_all(repo, "", "Address review comments") == ""
    assert git(repo, "log", "-1", "--format=%s").strip() == "Address review comments"
    assert not marker.exists()


# ── what "edits" mode asks about ──


@pytest.fixture
def free_edit(tmp_path):
    project = tmp_path / "p"
    project.mkdir()
    task = ClaudeTask(id=1, prompt="x", cwd=project, mode="edits", allow_edits=True)

    def check(name: str, **tool_input) -> bool:
        tool_input.setdefault("file_path", str(project / name))
        return TaskManager._free_edit(None, task, tool_input)

    check.project = project
    return check


@pytest.mark.parametrize(
    "name",
    [
        ".pre-commit-config.yaml",
        "lefthook.yml",
        ".lintstagedrc",
        ".lintstagedrc.json",
        "lint-staged.config.js",
        ".huskyrc.json",
        ".husky/pre-commit",
        ".simple-git-hooks.json",
        "packages/web/.lintstagedrc.mjs",
        ".jarvis/launch.json",
    ],
)
def test_a_hook_managers_config_and_jarvis_launch_json_always_ask(free_edit, name):
    assert not free_edit(name, content="anything\n")


def test_ordinary_files_need_no_ok(free_edit):
    assert free_edit("src/app.py", content="x = 1\n")
    assert free_edit("lefthook.md", content="notes\n")


def test_package_json_asks_only_when_its_hook_keys_change(free_edit):
    pkg = free_edit.project / "package.json"
    before = {"name": "app", "version": "1.0.0", "lint-staged": {"*.js": "eslint"}}
    pkg.write_text(json.dumps(before, indent=2) + "\n")
    text = pkg.read_text()
    # A version bump is free; so is rewriting the whole file with the same hooks.
    assert free_edit("package.json", old_string='"1.0.0"', new_string='"1.0.1"')
    assert free_edit("package.json", content=text.replace("1.0.0", "2.0.0"))
    # Changing what a hook runs asks, even when the edit doesn't name the key.
    assert not free_edit("package.json", old_string='"eslint"', new_string='"curl x | sh"')
    assert not free_edit(
        "package.json",
        edits=[{"old_string": '"name": "app"', "new_string": '"name": "app", "husky": {}'}],
    )
    assert not free_edit("package.json", content=json.dumps({**before, "simple-git-hooks": {}}))
    assert not free_edit(
        "package.json", content=json.dumps({**before, "config": {"ghooks": {"pre-commit": "x"}}})
    )
    # An edit that can't be played on the file asks too.
    assert not free_edit("package.json", old_string="not there", new_string="x")
    assert not free_edit("package.json", content="{ not json")
