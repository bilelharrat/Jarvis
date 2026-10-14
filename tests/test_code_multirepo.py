"""Multi-repo tasks (features/code_multirepo.py): one session in a folder holding an
isolated copy of each repository; landing all or nothing; linked pull requests opened
together and merged only when every one is green. Real git in temp repositories (origins
that look like github.com but are local bare ones), GitHub faked (tests/github_fakes.py)."""

import asyncio
import json
import subprocess
from dataclasses import replace
from pathlib import Path

import pytest
from github_fakes import FakeGitHub
from test_code_changes import git, make_repo
from test_code_isolation import until

from jarvis import github
from jarvis.code_prs import PullRecord
from jarvis.features.code_pr import FolderView, PullDesk


@pytest.fixture(autouse=True)
def _no_real_gh(monkeypatch):
    monkeypatch.setattr(github.shutil, "which", lambda _name: None)


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
    hub.cards, hub.answers = [], []

    def sink(card):
        hub.cards.append(card)
        if hub.answers:
            hub.resolve(card["id"], hub.answers.pop(0))

    hub.add_approval_sink(sink)
    hub.fake = FakeGitHub()
    for name in ("api", "web"):
        hub.fake.repos[f"acme/{name}"] = {
            **hub.fake.repos["acme/app"], "full_name": f"acme/{name}",
            "html_url": f"https://github.com/acme/{name}",
        }  # fmt: skip
    hub.code_pr._client = github.Client(lambda: "tok", transport=hub.fake.transport())
    yield hub
    await hub.code_pr.client.aclose()
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


def repo(tmp_path, projects, name):
    """A project whose origin is github.com/acme/<name> (a local bare repository)."""
    path = make_repo(projects / name, {"a.py": f"{name} = 1\n", "b.py": "b = 1\n"})
    bare = tmp_path / f"{name}.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(bare)], check=True)
    url = f"https://github.com/acme/{name}.git"
    git(path, "remote", "add", "origin", url)
    git(path, "config", f"url.{bare}.insteadOf", url)
    git(path, "push", "-q", "-u", "origin", "main")
    return path


async def start(hub, *names, prompt="add the field everywhere"):
    said = await hub.code_multi.start({"projects": list(names), "prompt": prompt})
    assert said == "", said
    [group] = hub.code_multi.groups().values()
    task = hub.tasks.tasks[group.task_id]
    assert await until(lambda: task.client is not None, seconds=120.0), task.transcript
    return group, task


def copies(hub, group):
    return {c.label: c for c in hub.code_multi.copies(group)}


# ── starting ──


async def test_a_task_gets_a_copy_of_each_repository_in_one_folder(hub, tmp_path, projects):
    api = repo(tmp_path, projects, "api")
    repo(tmp_path, projects, "web")
    group, task = await start(hub, "api", "web")
    folder = Path(group.folder)
    assert task.cwd == folder.resolve() and not task.workspace
    made = copies(hub, group)
    assert set(made) == {"api", "web"}
    for name, copy in made.items():
        assert copy.cwd == folder / name and copy.branch.startswith("jarvis/")
        assert copy.group == f"multi:{group.slug}" and copy.into == "main"
        assert (copy.cwd / "a.py").read_text() == f"{name} = 1\n"
    assert git(api, "branch", "--show-current").strip() == "main"  # the main folders as they were
    first = task.client.said[0]
    assert "This task spans 2 repositories" in first and "api/ : api" in first
    assert first.endswith("add the field everywhere")
    # The folder is one a session may run in; the copies stay while the task does.
    assert hub.tasks.resolve_dir(str(folder)) == folder.resolve()
    assert {c.slug for c in made.values()} <= hub.code_desk.live_slugs()
    shown = [d for k, d in hub.events if k == "code_multis"][-1]["groups"][0]
    assert [r["project"] for r in shown["repos"]] == ["api", "web"]


async def test_starting_needs_two_different_projects_and_a_request(hub, tmp_path, projects):
    repo(tmp_path, projects, "api")
    multi = hub.code_multi
    assert "at least two" in await multi.start({"projects": ["api"], "prompt": "x"})
    assert "twice" in await multi.start({"projects": ["api", "api"], "prompt": "x"})
    assert "something to do" in await multi.start({"projects": ["api", "web"], "prompt": ""})
    assert "No project folder" in await multi.start({"projects": ["api", "nope"], "prompt": "x"})
    (projects / "plain").mkdir()
    said = await multi.start({"projects": ["api", "plain"], "prompt": "x"})
    assert "Couldn't make the task's copies" in said and "isn't a git repository" in said
    assert multi.groups() == {} and hub.code_desk.store().copies == []  # nothing left over


# ── landing ──


async def test_landing_lands_every_repository_and_ends_the_task(hub, tmp_path, projects):
    api, web = repo(tmp_path, projects, "api"), repo(tmp_path, projects, "web")
    group, task = await start(hub, "api", "web")
    made = copies(hub, group)
    (made["api"].cwd / "a.py").write_text("api = 2\n")
    (made["web"].cwd / "a.py").write_text("web = 2\n")
    hub.answers = ["land"]
    said = await hub.code_multi.land(group.slug)
    assert said == "Landed add the field everywhere in all 2 repositories."
    [card] = hub.cards
    assert card["question"] == "Land add the field everywhere in all 2 repositories?"
    assert "api: jarvis/" in card["detail"] and "or none does" in card["detail"]
    assert (api / "a.py").read_text() == "api = 2\n" and (web / "a.py").read_text() == "web = 2\n"
    assert hub.code_desk.store().copies == [] and hub.code_multi.groups() == {}
    assert not Path(group.folder).exists()
    assert task.handle.done()


async def test_one_repository_that_cant_land_means_none_does(hub, tmp_path, projects):
    api, web = repo(tmp_path, projects, "api"), repo(tmp_path, projects, "web")
    group, _task = await start(hub, "api", "web")
    made = copies(hub, group)
    (made["api"].cwd / "a.py").write_text("api = 2\n")
    (made["web"].cwd / "a.py").write_text("web = 'copy'\n")
    (web / "a.py").write_text("web = 'main'\n")  # main moved on, in the same line
    git(web, "commit", "-qam", "meanwhile")
    hub.answers = ["land"]
    said = await hub.code_multi.land(group.slug)
    assert said == "Nothing landed: web: conflicts in a.py."
    assert (api / "a.py").read_text() == "api = 1\n"  # api, which could have, didn't
    assert hub.code_desk.conflicts[made["web"].slug] == ["a.py"]
    assert len(hub.code_desk.store().copies) == 2 and group.slug in hub.code_multi.groups()


async def test_uncommitted_work_in_a_main_folder_stops_every_landing(hub, tmp_path, projects):
    api, web = repo(tmp_path, projects, "api"), repo(tmp_path, projects, "web")
    group, _task = await start(hub, "api", "web")
    made = copies(hub, group)
    (made["api"].cwd / "a.py").write_text("api = 2\n")
    (made["web"].cwd / "b.py").write_text("b = 2\n")
    (web / "b.py").write_text("b = 'mine, not committed'\n")
    hub.answers = ["land"]
    said = await hub.code_multi.land(group.slug)
    assert said.startswith("Nothing landed: web: the main folder has uncommitted changes in b.py")
    assert (api / "a.py").read_text() == "api = 1\n"
    assert (web / "b.py").read_text() == "b = 'mine, not committed'\n"


async def test_not_now_lands_nothing_and_discard_throws_every_copy_away(hub, tmp_path, projects):
    repo(tmp_path, projects, "api")
    repo(tmp_path, projects, "web")
    group, task = await start(hub, "api", "web")
    (copies(hub, group)["api"].cwd / "a.py").write_text("api = 2\n")
    hub.answers = ["deny"]
    assert await hub.code_multi.land(group.slug) == "Not landed."
    hub.answers = ["discard"]
    said = await hub.code_multi.discard(group.slug)
    assert said.startswith("Discarded add the field everywhere")
    store = hub.code_desk.store()
    assert store.copies == [] and len(store.trash) == 2 and all(t["ref"] for t in store.trash)
    assert hub.code_multi.groups() == {} and task.handle.done()


# ── pull requests ──


async def test_linked_pull_requests_open_together_and_merge_only_when_all_are_green(
    hub, tmp_path, projects
):
    repo(tmp_path, projects, "api")
    repo(tmp_path, projects, "web")
    group, task = await start(hub, "api", "web")
    made = copies(hub, group)
    (made["api"].cwd / "a.py").write_text("api = 2\n")
    (made["web"].cwd / "a.py").write_text("web = 2\n")
    hub.answers = ["push", "push"]
    said = await hub.code_multi.open_prs(group.slug, {"title": "Add the field", "body": "Why."})
    assert said == "Opened 2 linked pull requests."
    assert [c["question"] for c in hub.cards] == [
        f"Push {made['api'].branch} to origin?",
        f"Push {made['web'].branch} to origin?",
    ]
    created = hub.fake.sent("POST")
    assert {r.url.path for r in created} == {"/repos/acme/api/pulls", "/repos/acme/web/pulls"}
    patched = {r.url.path: json.loads(r.content)["body"] for r in hub.fake.sent("PATCH")}
    api_body = patched["/repos/acme/api/pulls/7"]
    assert api_body.startswith("Why.\n\n---\nPart of one change across 2 repositories")
    assert "- acme/api#7 (this one)" in api_body and "- acme/web#8" in api_body
    assert "- acme/web#8 (this one)" in patched["/repos/acme/web/pulls/8"]
    assert [p["repo"] for p in group.prs] == ["acme/api", "acme/web"]
    recs = [hub.code_pr.store().find(p["repo"], p["number"]) for p in group.prs]
    assert all(r.session_id == task.session_id and r.copy for r in recs)
    assert {r.folder for r in recs} == {str(made["api"].cwd), str(made["web"].cwd)}
    # One failing check: nothing is merged.
    hub.fake.run("head1", "tests", conclusion="failure")
    said = await hub.code_multi.merge(group.slug)
    assert said.startswith("Nothing merged: acme/api#7: checks failing (tests)")
    assert hub.fake.merged == []
    # All green: one card, then both, each at its checked commit.
    hub.fake.run("head1", "tests", conclusion="success")
    hub.answers = ["merge"]
    assert await hub.code_multi.merge(group.slug) == "Merged all 2 pull requests."
    assert [m["number"] for m in hub.fake.merged] == [7, 8]
    assert all(m["sha"] == "head1" for m in hub.fake.merged)


async def test_a_draft_or_a_running_check_holds_back_every_merge(hub, tmp_path, projects):
    repo(tmp_path, projects, "api")
    repo(tmp_path, projects, "web")
    group, _task = await start(hub, "api", "web")
    for copy in copies(hub, group).values():
        (copy.cwd / "a.py").write_text("changed\n")
    hub.answers = ["push", "push"]
    await hub.code_multi.open_prs(group.slug, {"title": "T", "body": ""})
    hub.fake.pulls[("acme/web", 8)]["draft"] = True
    hub.fake.run("head1", "build", status="in_progress")
    said = await hub.code_multi.merge(group.slug)
    assert "acme/api#7: checks still running (build)" in said and "acme/web#8: it's a draft" in said
    assert hub.fake.merged == []


async def test_a_pull_request_that_cant_open_stops_the_rest(hub, tmp_path, projects):
    repo(tmp_path, projects, "api")
    repo(tmp_path, projects, "web")
    group, _task = await start(hub, "api", "web")
    for copy in copies(hub, group).values():
        (copy.cwd / "a.py").write_text("changed\n")
    hub.answers = ["push", "deny"]
    said = await hub.code_multi.open_prs(group.slug, {"title": "T", "body": ""})
    assert said.startswith("Opened acme/api#7; web: Not pushed.")
    assert len(hub.fake.sent("POST")) == 1 and [p["repo"] for p in group.prs] == ["acme/api"]


def test_a_pull_request_from_a_copy_inside_the_sessions_folder_is_seen_from_that_copy(
    tmp_path,
):
    task = type("T", (), {"cwd": tmp_path, "workspace": {}, "id": 3, "seq": 0})()
    rec = PullRecord(
        repo="acme/api", number=7, url="", title="T", branch="jarvis/x", base="main",
        remote="origin", folder=str(tmp_path / "api"), project="api", copy="x-1",
    )  # fmt: skip
    view = PullDesk.at(rec, task)
    assert isinstance(view, FolderView) and view.cwd == tmp_path / "api"
    assert view.workspace == {"slug": "x-1"} and view.id == 3
    view.seq += 1  # written through to the session
    assert task.seq == 1
    assert PullDesk._folder_of(task, rec)
    elsewhere = replace(rec, folder="/somewhere/else")
    assert PullDesk.at(elsewhere, task) is task and not PullDesk._folder_of(task, elsewhere)
