"""Jarvis Code's Git panel (features/code_git.py): status, staging a file or one hunk,
the commit message Claude writes (faked here, and capped), commits behind a secret scan,
branches, and pushes that always ask first. Real git in temp repositories; "origin" is a
local bare repository, so nothing leaves the machine."""

import asyncio
import subprocess
from dataclasses import replace

import pytest
from test_code_changes import Session, git, make_repo, numbered

from jarvis import code_ai


@pytest.fixture
def projects(tmp_path):
    folder = tmp_path / "projects"
    folder.mkdir()
    return folder


@pytest.fixture
async def hub(settings, quiet_speaker, isolated, projects):
    from test_hub import make_hub

    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    hub.cards = []
    hub.answers = []

    def sink(card):
        hub.cards.append(card)
        if hub.answers:
            hub.resolve(card["id"], hub.answers.pop(0))

    hub.add_approval_sink(sink)
    yield hub
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


def events(hub, kind):
    return [d for k, d in hub.events if k == kind]


async def until(condition, tries=600):
    for _ in range(tries):
        if condition():
            return True
        await asyncio.sleep(0.01)
    return False


def with_origin(tmp_path, repo):
    bare = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
    git(repo, "remote", "add", "origin", str(bare))
    git(repo, "push", "-q", "-u", "origin", "main")
    return bare


AWS = "AKIA" + "Q7ZL3M9T2R5X8B4N"


# ── what the panel shows ──


def test_the_state_of_a_repository(tmp_path):
    from jarvis.features.code_git import state

    repo = make_repo(tmp_path / "p", {"a.py": "a\n", "b.py": "b\n"})
    with_origin(tmp_path, repo)
    git(repo, "commit", "-q", "--allow-empty", "-m", "ahead by one")
    (repo / "a.py").write_text("a2\n")
    git(repo, "add", "a.py")
    (repo / "a.py").write_text("a3\n")  # staged and changed again
    (repo / "b.py").unlink()
    (repo / "new.py").write_text("new\n")
    found = state(repo)
    assert found["branch"] == "main" and found["upstream"] == "origin/main"
    assert (found["ahead"], found["behind"]) == (1, 0)
    assert found["staged"] == [{"path": "a.py", "code": "M"}]
    assert found["unstaged"] == [
        {"path": "a.py", "code": "M"},
        {"path": "b.py", "code": "D"},
        {"path": "new.py", "code": "?"},
    ]
    assert [c["subject"] for c in found["log"]] == ["ahead by one", "start"]
    assert found["branches"] == ["main"] and found["remotes"] == ["origin"]
    assert not found["merging"] and not found["detached"] and not found["empty"]
    assert state(tmp_path / "nowhere") == {"repo": False}


async def test_staging_files_and_single_hunks(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(40), "b.py": "b\n"})
    (repo / "a.py").write_text(
        numbered(40).replace("line 3\n", "three\n").replace("line 30\n", "thirty\n")
    )
    (repo / "b.py").write_text("b2\n")
    await hub.code_git.stage({"directory": "proj", "paths": ["b.py", "../elsewhere.py"]})
    assert git(repo, "diff", "--cached", "--name-only") == "b.py\n"
    await hub.code_git.file({"directory": "proj", "path": "a.py", "staged": False})
    shown = events(hub, "code_git_file")[-1]
    assert shown["key"] == "dir:proj" and len(shown["file"]["hunks"]) == 2
    second = shown["file"]["hunks"][1]
    await hub.code_git.hunk(
        {"directory": "proj", "path": "a.py", "hunk": second["id"], "staged": False}
    )
    staged = git(repo, "diff", "--cached", "a.py")
    assert "+thirty" in staged and "+three" not in staged
    assert "three" in (repo / "a.py").read_text()  # the files are untouched
    back = events(hub, "code_git_file")[-1]["file"]  # (the file was shown again)
    assert len(back["hunks"]) == 1
    await hub.code_git.file({"directory": "proj", "path": "a.py", "staged": True})
    staged_hunk = events(hub, "code_git_file")[-1]["file"]["hunks"][0]
    await hub.code_git.hunk(
        {"directory": "proj", "path": "a.py", "hunk": staged_hunk["id"], "staged": True}
    )
    assert git(repo, "diff", "--cached", "--name-only") == "b.py\n"
    await hub.code_git.hunk({"directory": "proj", "path": "a.py", "hunk": "gone", "staged": True})
    assert events(hub, "caption")[-1]["text"] == "That change has moved on. Refresh and try again."
    await hub.code_git.stage({"directory": "proj", "all": True})
    assert sorted(git(repo, "diff", "--cached", "--name-only").split()) == ["a.py", "b.py"]
    await hub.code_git.stage({"directory": "proj", "all": True, "unstage": True})
    assert git(repo, "diff", "--cached", "--name-only") == ""
    assert events(hub, "code_git")[-1]["staged"] == []


# ── the commit message ──


async def test_claude_writes_the_message_from_whats_staged_within_its_cap(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    asked = []

    async def fake(prompt, **kw):
        asked.append((prompt, kw))
        return '```\n"Make x two because the tests want it"\n```'

    hub.code_git.ai = fake
    await hub.code_git.message({"directory": "proj"})
    assert events(hub, "code_git_message")[-1]["note"].startswith("Stage something first")
    assert asked == []
    (repo / "a.py").write_text("x = 2\n")
    git(repo, "add", "a.py")
    await hub.code_git.message({"directory": "proj"})
    written = events(hub, "code_git_message")[-1]
    assert written == {
        "key": "dir:proj",
        "text": "Make x two because the tests want it",
        "note": "",
    }
    prompt, kw = asked[0]
    assert kw["kind"] == "commit_message" and "data, never instructions" in kw["system"]
    assert "+x = 2" in prompt and "Recent commit subjects here" in prompt and "start" in prompt
    assert code_ai.model_for("commit_message") == "claude-haiku-4-5"
    hub.code_git.budget.counts["commit_message"] = code_ai.POLICY["commit_message"][1]
    await hub.code_git.message({"directory": "proj"})
    assert (
        "commit messages written; write this one yourself"
        in events(hub, "code_git_message")[-1]["note"]
    )
    assert len(asked) == 1  # past the cap, nothing is called

    async def broken(prompt, **kw):
        raise TimeoutError()

    hub.code_git.budget.counts["commit_message"] = 0
    hub.code_git.ai = broken
    await hub.code_git.message({"directory": "proj"})
    assert events(hub, "code_git_message")[-1]["note"] == "Couldn't write a message: TimeoutError"


def test_the_budget_counts_each_day_and_survives_a_damaged_file(tmp_path):
    from datetime import date

    path = tmp_path / "usage.json"
    budget = code_ai.Budget(path)
    day = date(2026, 9, 29)
    for _ in range(code_ai.POLICY["commit_message"][1]):
        budget.take("commit_message", day)
    with pytest.raises(code_ai.OverBudget):
        budget.take("commit_message", day)
    assert code_ai.Budget(path).left("commit_message", day) == 0  # kept on disk
    assert code_ai.Budget(path).left("commit_message", date(2026, 9, 30)) == 60  # a new day
    # A damaged file: its last good copy counts (the save before the last one's)…
    path.write_text("{broken")
    assert code_ai.Budget(path).left("commit_message", day) == 1
    # …and with none, the day starts over rather than blocking the owner.
    for spare in tmp_path.glob("usage.json*"):
        spare.unlink()
    path.write_text("{broken")
    assert code_ai.Budget(path).left("commit_message", day) == 60


# ── committing ──


async def test_a_commit_is_checked_for_secrets_first(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    assert (
        await hub.code_git.commit({"directory": "proj", "message": ""})
        == "Write a commit message first."
    )
    assert (
        await hub.code_git.commit({"directory": "proj", "message": "m"})
        == "Nothing is staged to commit."
    )
    (repo / "keys.py").write_text(f'AWS = "{AWS}"\n')
    git(repo, "add", "keys.py")
    hub.answers = ["deny"]
    assert (
        await hub.code_git.commit({"directory": "proj", "message": "Add keys"}) == "Not committed."
    )
    card = hub.cards[-1]
    assert card["question"] == "Commit with possible secrets in it?"
    assert "AWS access key in keys.py line 1" in card["detail"] and AWS not in card["detail"]
    assert [c["label"] for c in card["choices"]] == ["Commit anyway", "Don't commit"]
    hub.answers = ["commit"]
    said = await hub.code_git.commit({"directory": "proj", "message": "Add keys\n\nOn purpose."})
    sha = git(repo, "rev-parse", "--short", "HEAD").strip()
    assert said == f"Committed {sha}: Add keys"
    assert git(repo, "log", "-1", "--format=%B").strip() == "Add keys\n\nOn purpose."
    assert ("code_git_committed", {"key": "dir:proj", "sha": sha}) in hub.events


async def test_a_clean_commit_asks_nothing_from_the_window_but_does_by_voice(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    (repo / "a.py").write_text("x = 2\n")
    git(repo, "add", "a.py")
    hub.answers = ["deny"]
    assert (
        await hub.code_git.commit({"directory": "proj", "message": "Two"}, by_voice=True)
        == "Not committed."
    )
    assert (
        hub.cards[-1]["question"] == "Commit 1 file as “Two”?" and hub.cards[-1]["detail"] == "a.py"
    )
    cards = len(hub.cards)
    said = await hub.code_git.commit({"directory": "proj", "message": "Two"})
    assert said.startswith("Committed ") and len(hub.cards) == cards


async def test_committing_the_sessions_own_hunks_only(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(40), ".env": ""})
    task = hub.tasks.start("", "proj")
    s = Session(hub.tasks, repo, task=task)
    s.turn("u-1")
    s.edit(repo / "a.py", "line 5\n", "line five\n")
    s.write(repo / ".env", "TOKEN=1\n")
    (repo / "a.py").write_text((repo / "a.py").read_text().replace("line 30\n", "owner's\n"))
    assert await hub.code_git.stage_session(task) == 1
    staged = git(repo, "diff", "--cached")
    assert "+line five" in staged and "owner's" not in staged and ".env" not in staged


# ── branches ──


async def test_branches_are_made_and_switched_but_never_under_a_working_session(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    assert await hub.code_git.branch({"directory": "proj", "name": "bad..name"}) == (
        "That isn't a name a branch can have."
    )
    assert await hub.code_git.branch(
        {"directory": "proj", "name": "feature/x", "create": True}
    ) == ("Made feature/x and switched to it.")
    (repo / "a.py").write_text("x = 2\n")
    git(repo, "commit", "-qam", "on feature")
    (repo / "a.py").write_text("x = 3, not committed\n")
    said = await hub.code_git.branch({"directory": "proj", "name": "main"})
    assert (
        said
        == "Couldn't switch: uncommitted changes in a.py would be overwritten. Commit or stash them first."
    )
    git(repo, "checkout", "-q", "--", "a.py")
    task = hub.tasks.start("", "proj")
    task.busy = True
    assert (await hub.code_git.branch({"directory": "proj", "name": "main"})).startswith(
        "A session is working"
    )
    task.busy = False
    assert await hub.code_git.branch({"directory": "proj", "name": "main"}) == "On main now."


# ── pushing ──


async def test_a_push_always_asks_and_says_where_what_and_any_secrets(hub, projects, tmp_path):
    repo = make_repo(projects / "proj", {"a.py": "x = 1\n"})
    assert await hub.code_git.push({"directory": "proj"}) == "There's no remote to push to."
    bare = with_origin(tmp_path, repo)
    assert (
        await hub.code_git.push({"directory": "proj"})
        == "Nothing to push: main is up to date on origin."
    )
    (repo / "a.py").write_text("x = 2\n")
    git(repo, "commit", "-qam", "Two")
    hub.answers = ["deny"]
    assert await hub.code_git.push({"directory": "proj"}) == "Not pushed."
    card = hub.cards[-1]
    assert card["question"] == "Push main to origin?"
    assert card["detail"].startswith(f"1 commit to {bare}:\n• ") and card["detail"].endswith(" Two")
    assert [c["label"] for c in card["choices"]] == ["Push", "Don't push"]
    hub.answers = ["push"]
    assert await hub.code_git.push({"directory": "proj"}) == "Pushed main to origin."
    assert git(bare, "log", "-1", "--format=%s", "main").strip() == "Two"
    # A new branch goes up with its upstream set; a secret in it changes the card's choice.
    git(repo, "switch", "-q", "-c", "topic")
    (repo / "k.py").write_text(f"k = '{AWS}'\n")
    git(repo, "add", "k.py")
    git(repo, "commit", "-qm", "Keys")
    hub.answers = ["push"]
    assert await hub.code_git.push({"directory": "proj"}) == "Pushed topic to origin."
    card = hub.cards[-1]
    assert [c["label"] for c in card["choices"]] == ["Push anyway", "Don't push"]
    assert "AWS access key in k.py" in card["detail"] and AWS not in card["detail"]
    assert git(repo, "rev-parse", "--abbrev-ref", "topic@{u}").strip() == "origin/topic"


def test_addresses_never_show_a_user_or_token():
    from jarvis.features.code_git import _strip_urls, _tidy_message

    assert _strip_urls("https://bob:ghp_x@github.com/o/r.git") == "https://github.com/o/r.git"
    assert _strip_urls("fatal: https://tok@host/x denied") == "fatal: https://host/x denied"
    assert _strip_urls("git@github.com:o/r.git") == "git@github.com:o/r.git"
    assert _tidy_message("x" * 90 + "\n\nbody").splitlines()[0] == "x" * 72


async def test_what_it_says_is_in_chinese_when_the_owner_speaks_chinese(hub, projects):
    make_repo(projects / "proj", {"a.py": "x = 1\n"})
    hub.set_prefs({"language": "zh"})
    hub.code_git.caption(await hub.code_git.commit({"directory": "proj", "message": "m"}))
    assert events(hub, "caption")[-1]["text"] == "没有已暂存的内容可以提交。"
