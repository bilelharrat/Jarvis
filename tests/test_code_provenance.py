"""Provenance notes (features/code_provenance.py): when Eden commits a session's work (the
Git panel, landing an isolated copy, a pull request's commit) the commit gets a git note
under refs/notes/eden, never a line in its message, saying which session, model and turn
(a prompt digest and scrubbed summary, the receipt's entry) wrote each hunk; git blame and
those notes give the editor's "who wrote this" overlay; a pull request's description can
list them (opt-in); a pref turns it off; the notes are never pushed. Real git in temp
repositories; "origin" is a local bare repository, so nothing leaves the machine."""

import json

import pytest
import test_code_git
from test_code_changes import Session, git, make_repo, numbered
from test_code_git import with_origin
from test_code_isolation import copy_of, isolated_session

from jarvis import code_changes as cc
from jarvis.features import code_provenance as cp

# The Git panel's fixtures: a hub whose cards are answered from hub.answers, and a projects
# folder.
hub = test_code_git.hub
projects = test_code_git.projects

AWS = "AKIA" + "Q7ZL3M9T2R5X8B4N"


def note_of(repo, commit="HEAD"):
    return json.loads(git(repo, "notes", "--ref", cp.NOTES_REF, "show", commit))


def said(hub, task, text, uid):
    """The owner's message (as the window logs it), then Claude Code taking it up."""
    hub.tasks._log(task, "user", text)
    Session(hub.tasks, task.cwd, task=task).turn(uid)


def receipt(hub, task):
    hub.tasks._log(task, "system", "Proof · Changed 1 file", receipt={"risk": "low"})
    return task.transcript[-1]["n"]


# ── a prompt, kept safely ──


def test_a_prompts_digest_ignores_spacing_and_its_summary_hides_secrets():
    assert cp.prompt_digest("fix  the\nlogin") == cp.prompt_digest("fix the login")
    assert cp.prompt_digest("fix the login").startswith("sha256:")
    assert len(cp.prompt_digest("x")) == len("sha256:") + cp.DIGEST_CHARS
    words = cp.prompt_summary(f"use {AWS} and api_key=s3cr3tValue99 to deploy")
    assert AWS not in words and "s3cr3tValue99" not in words
    assert words.count("[secret]") == 2 and words.startswith("use [secret]")
    long = cp.prompt_summary("word " * 100)
    assert len(long) == cp.SUMMARY_MAX and long.endswith("…")
    assert cp.prompt_summary("rename get_user_by_email_address_fn") == (
        "rename get_user_by_email_address_fn"
    )


# ── the Git panel's commit ──


async def test_a_commit_gets_a_note_per_turn_and_none_in_its_message(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(40)})
    task = hub.tasks.start("", "proj")
    task.model_label = "Sonnet 5.5"
    task.session_id = "sess-1"
    s = Session(hub.tasks, repo, task=task)
    said(hub, task, f"rename line five, key {AWS}", "u-1")
    s.edit(repo / "a.py", "line 5\n", "line five\n")
    first_receipt = receipt(hub, task)
    said(hub, task, "now line twenty", "u-2")
    s.edit(repo / "a.py", "line 20\n", "line twenty\n")
    (repo / "a.py").write_text((repo / "a.py").read_text().replace("line 33\n", "owner's\n"))
    git(repo, "add", "a.py")
    assert (await hub.code_git.commit({"directory": "proj", "message": "Two"})).startswith(
        "Committed "
    )
    assert git(repo, "log", "-1", "--format=%B").strip() == "Two"  # no trailer, ever
    assert git(repo, "notes", "list").strip() == ""  # (git's default notes ref is untouched)
    note = note_of(repo)
    assert note["eden_provenance"] == 1
    [session] = note["sessions"]
    assert session["task"] == task.id and session["session"] == "sess-1"
    assert session["model"] == "Sonnet 5.5" and "claude_agent_sdk" in session["engine"]
    one, two = session["turns"]
    assert one["checkpoint"] == "u-1" and one["n"] == 1 and one["receipt"] == first_receipt
    assert AWS not in json.dumps(note) and "[secret]" in one["summary"]
    assert one["digest"] == cp.prompt_digest(f"rename line five, key {AWS}")
    assert two["summary"] == "now line twenty" and two["receipt"] == 0
    hunks = {(h["path"], tuple(h["lines"][0]), h["t"]) for h in note["hunks"]}
    assert hunks == {("a.py", (5, 5), 1), ("a.py", (20, 20), 2)}  # not the owner's line 33


async def test_the_overlay_names_the_session_and_prompt_of_each_line(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(40)})
    task = hub.tasks.start("", "proj")
    s = Session(hub.tasks, repo, task=task)
    said(hub, task, "make line five loud", "u-1")
    s.edit(repo / "a.py", "line 5\nline 6\n", "LINE FIVE\nLINE SIX\n")
    said(hub, task, "and line thirty", "u-2")
    s.edit(repo / "a.py", "line 30\n", "LINE THIRTY\n")
    git(repo, "add", "a.py")
    await hub.code_git.commit({"directory": "proj", "message": "Loud"})
    # Lines move after the commit: blame follows them to where they were written.
    (repo / "a.py").write_text("new top\n" + (repo / "a.py").read_text())
    event = await hub.code_provenance.send_blame({"directory": "proj", "path": "a.py"})
    assert event["key"] == "dir:proj" and event["note"] == ""
    spans = {(a, b): event["who"][w] for a, b, w in event["spans"]}
    assert set(spans) == {(6, 7), (31, 31)}
    assert spans[(6, 7)]["summary"] == "make line five loud" and spans[(6, 7)]["turn"] == 1
    assert spans[(31, 31)]["summary"] == "and line thirty"
    assert spans[(6, 7)]["commit"] == git(repo, "rev-parse", "--short=10", "HEAD").strip()
    assert [d for k, d in hub.events if k == "code_provenance_blame"][-1] == event
    outside = await hub.code_provenance.send_blame({"directory": "proj", "path": "../x.py"})
    assert outside["spans"] == [] and outside["note"]


async def test_turned_off_it_writes_no_note_and_shows_no_overlay(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(10)})
    hub.prefs.features[cp.PREF] = False
    task = hub.tasks.start("", "proj")
    said(hub, task, "change it", "u-1")
    Session(hub.tasks, repo, task=task).edit(repo / "a.py", "line 2\n", "line two\n")
    git(repo, "add", "a.py")
    await hub.code_git.commit({"directory": "proj", "message": "Off"})
    assert git(repo, "notes", "--ref", cp.NOTES_REF, "list").strip() == ""
    event = await hub.code_provenance.send_blame({"directory": "proj", "path": "a.py"})
    assert event["spans"] == [] and event["note"] == "Provenance is off in Settings."


async def test_the_owners_own_commit_and_unowned_hunks_get_no_note(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(10)})
    hub.tasks.start("", "proj")  # a session there, with no edits of its own
    (repo / "a.py").write_text("by hand\n")
    git(repo, "add", "a.py")
    await hub.code_git.commit({"directory": "proj", "message": "Mine"})
    assert git(repo, "notes", "--ref", cp.NOTES_REF, "list").strip() == ""


async def test_notes_are_never_pushed(hub, projects, tmp_path):
    repo = make_repo(projects / "proj", {"a.py": numbered(10)})
    bare = with_origin(tmp_path, repo)
    task = hub.tasks.start("", "proj")
    said(hub, task, "change it", "u-1")
    Session(hub.tasks, repo, task=task).edit(repo / "a.py", "line 2\n", "line two\n")
    git(repo, "add", "a.py")
    await hub.code_git.commit({"directory": "proj", "message": "Two"})
    assert note_of(repo)["hunks"]
    hub.answers = ["push"]
    assert await hub.code_git.push({"directory": "proj"}) == "Pushed main to origin."
    assert git(bare, "for-each-ref", "refs/notes").strip() == ""


# ── landing an isolated copy ──


async def test_landing_notes_the_copys_commits_and_blame_finds_them(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(20)})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    s = Session(hub.tasks, task.cwd, task=task)
    said(hub, task, "rename line three", "u-1")
    s.edit(task.cwd / "a.py", "line 3\n", "line three\n")
    (task.cwd / "new.py").write_text("print('made by a command')\n")
    hub.add_approval_sink(lambda card: hub.resolve(card["id"], "land"))
    assert (await hub.code_desk.land(copy.slug)).endswith("(fast-forward).")
    note = note_of(repo)
    by_path = {h["path"]: h for h in note["hunks"]}
    assert by_path["a.py"]["t"] == 1 and by_path["a.py"]["lines"] == [[3, 3]]
    assert by_path["new.py"]["t"] == 0  # the session's (its own copy), no turn's edit
    assert note["sessions"][0]["turns"][0]["summary"] == "rename line three"
    assert git(repo, "log", "-1", "--format=%B").strip() == "Eden Code: fix the login"
    event = await hub.code_provenance.send_blame({"directory": "proj", "path": "a.py"})
    assert [(a, b) for a, b, _ in event["spans"]] == [(3, 3)]


async def test_a_merge_landing_notes_the_copys_commit_and_the_merge(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(20), "b.py": "b\n"})
    task = await isolated_session(hub)
    copy = copy_of(hub, task)
    said(hub, task, "edit line two", "u-1")
    Session(hub.tasks, task.cwd, task=task).edit(task.cwd / "a.py", "line 2\n", "copy's line\n")
    (repo / "b.py").write_text("main's b\n")
    git(repo, "commit", "-qam", "meanwhile on main")
    meanwhile = git(repo, "rev-parse", "HEAD").strip()
    hub.add_approval_sink(lambda card: hub.resolve(card["id"], "land"))
    assert (await hub.code_desk.land(copy.slug)).endswith("(a merge commit).")
    merge = git(repo, "rev-parse", "HEAD").strip()
    copy_commit = git(repo, "rev-parse", "HEAD^2").strip()
    assert note_of(repo, copy_commit)["hunks"][0]["path"] == "a.py"
    assert {h["path"] for h in note_of(repo, merge)["hunks"]} == {"a.py"}
    noted = git(repo, "notes", "--ref", cp.NOTES_REF, "list")
    assert meanwhile not in noted  # main's own commit isn't the session's
    event = await hub.code_provenance.send_blame({"directory": "proj", "path": "a.py"})
    assert [(a, b) for a, b, _ in event["spans"]] == [(2, 2)]


# ── the Changes pane, before anything is committed ──


async def test_the_changes_pane_hears_which_turn_wrote_each_hunk(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(40)})
    task = hub.tasks.start("", "proj")
    s = Session(hub.tasks, repo, task=task)
    said(hub, task, "first", "u-1")
    s.edit(repo / "a.py", "line 5\n", "line five\n")
    said(hub, task, "second", "u-2")
    s.edit(repo / "a.py", "line 30\n", "line thirty\n")
    event = await hub.code_provenance.send_hunks({"id": task.id, "view": "session"})
    assert sorted(w["summary"] for w in event["hunks"].values()) == ["first", "second"]
    view = cc.task_view(task, "session")
    assert set(event["hunks"]) == {h.id for f in view.files for h in f.hunks}


# ── notes, merged and read ──


def test_a_second_sessions_note_on_the_same_commit_keeps_the_first():
    a = {
        "eden_provenance": 1,
        "sessions": [{"task": 1}],
        "hunks": [{"path": "x", "lines": [[1, 1]], "s": 0, "t": 0}],
    }
    b = {
        "eden_provenance": 1,
        "sessions": [{"task": 2}],
        "hunks": [{"path": "y", "lines": [[2, 2]], "s": 0, "t": 0}],
    }
    both = cp.merged(a, b)
    assert [s["task"] for s in both["sessions"]] == [1, 2]
    assert [(h["path"], h["s"]) for h in both["hunks"]] == [("x", 0), ("y", 1)]
    again = cp.merged(both, {"eden_provenance": 1, "sessions": [{"task": 2}], "hunks": []})
    assert [s["task"] for s in again["sessions"]] == [1, 2] and len(again["hunks"]) == 1
    assert cp.parse_note("not json") is None and cp.parse_note('{"eden_provenance": 9}') is None


# ── pull requests ──


async def test_a_pull_requests_section_is_opt_in_and_added_once(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(40)})
    fork = git(repo, "rev-parse", "HEAD").strip()
    task = hub.tasks.start("", "proj")
    task.model_label = "Opus 5.5"
    said(hub, task, "rename line five", "u-1")
    Session(hub.tasks, repo, task=task).edit(repo / "a.py", "line 5\nline 6\n", "five\nsix\n")
    git(repo, "add", "a.py")
    await hub.code_git.commit({"directory": "proj", "message": "Two"})
    prov = hub.code_provenance
    assert prov.pr_body(repo, fork, "Body") == "Body"  # off by default
    hub.prefs.features[cp.PREF_PR] = True
    body = prov.pr_body(repo, fork, "Body")
    assert body.startswith("Body\n\n" + cp.PR_MARK) and "### Provenance" in body
    assert "Opus 5.5" in body and "turn 1: “rename line five”" in body and "2 lines" in body
    assert cp.prompt_digest("rename line five") in body
    assert prov.pr_body(repo, fork, body) == body
    hub.prefs.features[cp.PREF] = False  # provenance off: no section either
    assert prov.pr_body(repo, fork, "Body") == "Body"


@pytest.mark.parametrize(
    "lines,ranges",
    [
        ([("+", "a"), ("+", "b"), (" ", "c"), ("+", "d")], [[10, 11], [13, 13]]),
        ([("-", "a"), ("+", "b")], [[10, 10]]),
        ([("-", "a")], []),
    ],
)
def test_a_hunks_added_lines_as_ranges(lines, ranges):
    from jarvis.code_changes import Hunk

    assert cp.added_ranges(Hunk(10, 1, 10, 1, lines=lines)) == ranges
