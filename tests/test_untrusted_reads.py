"""B7: a run on anyone's words (an issue's, a Linear or Slack trigger's, Exterminator Mode on
anyone's code) read what a private folder holds, and any file on the Mac a "read-only"
command named: their guards let a step by on _goes_ahead without the private-folder rule
policy_for has, and read-only Bash went ahead on any path. Fake sessions, temp folders."""

import os

import pytest
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny
from test_code_changes import make_repo
from test_code_unattended import hub, projects

from jarvis import private_folders, tasks
from jarvis.features.code_bugfix import BugRun
from jarvis.features.code_unattended import Run
from jarvis.tasks import ClaudeTask

__all__ = ["hub", "projects"]  # (the fixtures, used by name)


@pytest.fixture
def secret(projects):
    """A private folder inside the project, and the owner's ~/.ssh outside it."""
    folder = projects / "proj" / "grades"
    private_folders.configure(lambda: [str(folder)])
    yield folder
    private_folders.configure(lambda: [])


def test_a_read_only_command_reads_inside_its_folder_or_it_doesnt_count(tmp_path):
    (tmp_path / "a.py").write_text("x\n")
    outside = tmp_path.parent / f"{tmp_path.name}-key"
    outside.write_text("KEY")
    os.symlink(outside, tmp_path / "link")
    for fine in ("cat a.py", "ls", "grep -rn foo .", "git diff --stat", "wc -l a.py", "ls -la"):
        assert tasks.reads_inside(fine, tmp_path), fine
    for out in (
        "cat ~/.ssh/id_rsa",
        "find /",
        "git diff --no-index ~/.ssh/id_rsa /dev/null",
        "cat ../x",
        f"head -n5 {outside}",
        "cat link",
        "cat *",
        "grep -f/etc/passwd a.py",
        "grep --file=/etc/passwd a.py",
        "ls | cat ~/.aws/credentials",
    ):
        assert not tasks.reads_inside(out, tmp_path), out


async def test_an_issues_run_reads_no_private_folder_and_nothing_outside(hub, projects, secret):
    runs = hub.code_runs
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n", "grades/marks.md": "38/100\n"})
    task = ClaudeTask(id=3, prompt="x", cwd=repo, mode="edits", allow_edits=True)
    hub.tasks.tasks[3] = task
    run = Run("r1", "t", "p", "proj", "edits", ["npm test"], 5.0, 2.0)
    run.untrusted = True
    runs.active[3] = run

    async def inner(*_):
        return PermissionResultAllow()

    guard = runs.guard(task, inner)
    for name, data in (
        ("Read", {"file_path": str(secret / "marks.md")}),
        ("Grep", {"pattern": "x", "path": str(secret)}),
        ("Bash", {"command": "cat grades/marks.md"}),
        ("Bash", {"command": "cat ~/.ssh/id_rsa"}),
        ("Bash", {"command": "find /"}),
        ("Bash", {"command": "git diff --no-index ~/.ssh/id_rsa /dev/null"}),
    ):
        assert isinstance(await guard(name, data, None), PermissionResultDeny), data
    for name, data in (("Read", {"file_path": str(repo / "a.py")}), ("Bash", {"command": "ls"})):
        assert isinstance(await guard(name, data, None), PermissionResultAllow), data
    del runs.active[3]


async def test_bug_fix_mode_reads_no_private_folder_and_nothing_outside(hub, projects, secret):
    desk = hub.code_bugfix
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n", "grades/marks.md": "38/100\n"})
    task = ClaudeTask(id=9, prompt="x", cwd=repo, mode="edits", allow_edits=True)
    run = BugRun("r1", "proj", step="fix", stack={"kinds": ["python"]})
    desk.active[9] = run
    for name, data in (
        ("Read", {"file_path": str(secret / "marks.md")}),
        ("Bash", {"command": "cat grades/marks.md"}),
        ("Bash", {"command": "cat ~/.ssh/id_rsa"}),
        ("Bash", {"command": "find / -name id_rsa"}),
    ):
        assert desk.refusal(run, task, name, data) not in (None, "card"), data
    assert desk.refusal(run, task, "Read", {"file_path": str(repo / "a.py")}) is None
    assert desk.refusal(run, task, "Bash", {"command": "cat a.py"}) is None
    del desk.active[9]
