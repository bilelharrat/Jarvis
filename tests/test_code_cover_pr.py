"""Eden Code's pull requests (features/code_pr.py), the parts the main tests leave out: the
pane's own buttons (Fix now, Resolve, Push, Merge, Forget, the log, the switches), the
watcher loop itself, opening's refusals and GitHub's no's (an existing pull request, a
merge conflict, a method the repository doesn't allow, a server error, a rate limit), and
follow-ups that can't reach a session.

The same set-up as tests/test_code_pr.py (its fixtures and helpers): real git in temp
repositories, GitHub is tests/github_fakes.py. Nothing leaves the Mac."""

import asyncio
import time

import test_code_pr
from code_session_fakes import until
from test_code_changes import git
from test_code_pr import events, github_project, sends, session, watched

from jarvis import github
from jarvis.features import code_pr

# The main tests' fixtures, by name (pytest finds them here): no gh CLI, a projects folder,
# and a hub whose GitHub is the fake one, with its cards answered from hub.answers.
_no_real_gh = test_code_pr._no_real_gh
projects = test_code_pr.projects
hub = test_code_pr.hub

MERGE = ("PUT", "/repos/acme/app/pulls/7/merge")
PULL = ("GET", "/repos/acme/app/pulls/7")


def captions(hub):
    return [d["text"] for d in events(hub, "caption")]


async def said(hub, text):
    """Wait for the pane's caption (a command's reply) and say whether it came."""
    return await until(lambda: text in captions(hub))


async def failing_pr(hub, tmp_path, projects, monkeypatch, **extra):
    """A watched pull request whose tests fail, seen once (fixing by itself off)."""
    repo, bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    sent = sends(hub, monkeypatch)
    rec = watched(hub, repo, autofix=False, **extra)
    job = hub.fake.run("head1", "tests", conclusion="failure", title="1 failed")
    hub.fake.logs[job["id"]] = "FAILED test_login - assert 1 == 2\n"
    await hub.code_pr.poll(rec)
    return repo, bare, task, sent, rec


# ── Fix now ──


async def test_fix_now_with_nothing_failing_says_so_and_sends_nothing(
    hub, tmp_path, projects, monkeypatch
):
    """The Fix button on a pull request whose checks pass only says nothing is failing."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    sent = sends(hub, monkeypatch)
    rec = watched(hub, repo)
    hub.fake.run("head1", "tests", conclusion="success")
    await hub.code_pr.poll(rec)
    hub.code_pr.cmd_fix({"id": task.id})
    assert await said(hub, "Nothing is failing right now.")
    assert sent == [] and rec.fix_attempts == 0


async def test_fix_now_sends_the_failing_logs_even_to_a_busy_session(
    hub, tmp_path, projects, monkeypatch
):
    """The owner's own Fix click sends the failing check's log as a note at once (busy or
    not), counts it as a fix and marks the commit as being fixed."""
    _repo, _bare, task, sent, rec = await failing_pr(hub, tmp_path, projects, monkeypatch)
    assert sent == []  # fixing by itself is off: only a heads-up
    task.busy = True
    hub.code_pr.cmd_fix({"id": task.id})
    assert await said(hub, "Sent the failing checks to the session.")
    [note] = sent
    assert note["note"] is True and "FAILED test_login" in note["text"]
    assert "fix 1 of 3" in note["text"]
    assert rec.fix_attempts == 1 and rec.fixed_shas == ["head1"] and rec.followup == "fix"
    assert events(hub, "code_pr")[-1]["pr"]["number"] == 7


async def test_fix_now_that_cant_be_queued_is_not_counted(hub, tmp_path, projects, monkeypatch):
    """When the session's inbox is full the owner hears why, and the attempt isn't kept."""
    _repo, _bare, task, _sent, rec = await failing_pr(hub, tmp_path, projects, monkeypatch)
    monkeypatch.setattr(hub.tasks, "send", lambda *a, **k: False)
    hub.code_pr.cmd_fix({"id": task.id})
    assert await said(hub, "Too many messages are waiting for that session already.")
    assert rec.fix_attempts == 0 and rec.fixed_shas == [] and rec.followup == ""


async def test_the_pane_buttons_do_nothing_for_a_session_without_a_pull_request(
    hub, tmp_path, projects, monkeypatch
):
    """Fix, Resolve, Push, Merge, Comment, Forget, Refresh, Log and Set on a session that
    has no pull request (or no session at all) change nothing and say nothing."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    sent = sends(hub, monkeypatch)
    desk = hub.code_pr
    for cmd in (desk.cmd_fix, desk.cmd_resolve, desk.cmd_push, desk.cmd_merge,
                desk.cmd_comment, desk.cmd_forget, desk.cmd_refresh, desk.cmd_log,
                desk.cmd_set):  # fmt: skip
        cmd({"id": task.id})
        cmd({"id": 999})
    await asyncio.sleep(0.02)
    assert sent == [] and captions(hub) == [] and hub.cards == [] and hub.fake.requests == []


# ── Resolve ──


async def test_resolve_without_a_conflict_says_there_is_nothing_to_resolve(
    hub, tmp_path, projects, monkeypatch
):
    """Resolve on a pull request GitHub says merges cleanly sends nothing."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    sent = sends(hub, monkeypatch)
    rec = watched(hub, repo)
    await hub.code_pr.poll(rec)
    assert rec.mergeable == "clean"
    hub.code_pr.cmd_resolve({"id": task.id})
    assert await said(hub, "There are no conflicts to resolve.")
    assert sent == []


async def test_resolve_on_a_conflict_fetches_the_base_and_asks_the_session(
    hub, tmp_path, projects, monkeypatch
):
    """With fixing by itself off, a conflict waits for the owner; Resolve then sends the
    merge request and remembers it was sent for this base commit."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    sent = sends(hub, monkeypatch)
    rec = watched(hub, repo, autofix=False)
    hub.fake.pulls[("acme/app", 7)].update(mergeable=False, mergeable_state="dirty")
    await hub.code_pr.poll(rec)
    assert sent == [] and rec.conflict_sent == ""
    hub.code_pr.cmd_resolve({"id": task.id})
    assert await said(hub, "Sent the conflicts to the session.")
    [ask] = sent
    assert "git merge origin/main" in ask["text"] and rec.followup == "conflict"
    assert rec.conflict_sent == "head1:base000"
    assert any("resolve the conflicts with main" in e["text"] for e in task.transcript)


async def test_resolve_that_cant_reach_the_session_says_why(hub, tmp_path, projects, monkeypatch):
    """A conflict whose session can't take another message is not marked as sent."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    rec = watched(hub, repo, autofix=False)
    hub.fake.pulls[("acme/app", 7)].update(mergeable=False, mergeable_state="dirty")
    await hub.code_pr.poll(rec)
    monkeypatch.setattr(hub.tasks, "send", lambda *a, **k: False)
    hub.code_pr.cmd_resolve({"id": task.id})
    assert await said(hub, "Too many messages are waiting for that session already.")
    assert rec.conflict_sent == ""


# ── Merge ──


async def test_merge_said_no_to_merges_nothing(hub, tmp_path, projects, monkeypatch):
    """The Merge button asks first; Not now leaves the pull request open."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    rec = watched(hub, repo)
    hub.answers = ["deny"]
    hub.code_pr.cmd_merge({"id": task.id})
    assert await said(hub, "Not merged.")
    assert hub.cards[-1]["question"] == "Merge pull request #7 into main now?"
    assert "Make x two" in hub.cards[-1]["detail"] and "(squash)" in hub.cards[-1]["detail"]
    assert hub.fake.merged == [] and rec.state == "open"


async def test_merge_with_the_method_picked_merges_at_the_checked_commit(
    hub, tmp_path, projects, monkeypatch
):
    """Merge with a method from the pane merges with it, at the head the app last saw, and
    the owner hears it's merged."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    rec = watched(hub, repo)
    hub.answers = ["merge"]
    hub.code_pr.cmd_merge({"id": task.id, "method": "merge"})
    assert await until(lambda: hub.fake.merged)
    assert hub.fake.merged == [{"number": 7, "merge_method": "merge", "sha": "head1"}]
    assert await until(lambda: rec.state == "merged")
    assert rec.merge_method == "merge" and not rec.watch
    assert hub.alerts[-1].text == "Merged pull request #7 into main."


async def test_a_merge_after_the_branch_moved_is_refused_and_said(
    hub, tmp_path, projects, monkeypatch
):
    """GitHub's 409 (the head moved since it was checked) leaves it open and says why."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    rec = watched(hub, repo)
    hub.fake.pulls[("acme/app", 7)]["head"]["sha"] = "pushed-since"
    hub.answers = ["merge"]
    hub.code_pr.cmd_merge({"id": task.id, "method": "octopus"})  # (not a method: ignored)
    want = "Couldn't merge pull request #7: GitHub said no: Head branch was modified."
    assert await until(lambda: any(c.startswith(want) for c in captions(hub)))
    assert rec.state == "open" and rec.merge_method == "squash" and hub.fake.merged == []


async def test_a_merge_method_the_repository_forbids_turns_merging_when_green_off(
    hub, tmp_path, projects
):
    """A 405 "not allowed" on a pull request set to merge when green switches that off and
    tells the owner once; the reply says what GitHub said."""
    repo, _bare = github_project(tmp_path, projects)
    session(hub, repo)
    rec = watched(hub, repo, auto_merge=True, merge_method="rebase")
    hub.fake.fail[MERGE] = (405, {"message": "Rebase merges are not allowed on this repository."}, {})  # fmt: skip
    reply = await hub.code_pr.merge(rec)
    assert reply == (
        "Couldn't merge pull request #7: GitHub said no: Rebase merges are not allowed on "
        "this repository."
    )
    assert rec.auto_merge is False and rec.state == "open"
    assert hub.alerts[-1].text == (
        "GitHub won't merge pull request #7 with rebase; merging when green is off."
    )
    # Any other refusal leaves the switch as it is.
    rec.auto_merge = True
    hub.fake.fail[MERGE] = (409, {"message": "Base branch was modified."}, {})
    reply = await hub.code_pr.merge(rec)
    assert reply.endswith("Base branch was modified.") and rec.auto_merge is True


async def test_merging_when_green_waits_for_a_draft_to_be_ready(
    hub, tmp_path, projects, monkeypatch
):
    """A draft pull request with every check green is never merged by itself."""
    repo, _bare = github_project(tmp_path, projects)
    session(hub, repo)
    sends(hub, monkeypatch)
    rec = watched(hub, repo, auto_merge=True)
    hub.fake.pulls[("acme/app", 7)]["draft"] = True
    hub.fake.run("head1", "tests", conclusion="success")
    await hub.code_pr.poll(rec)
    assert rec.checks == "passed" and rec.draft and hub.fake.merged == []
    hub.fake.pulls[("acme/app", 7)]["draft"] = False
    await hub.code_pr.poll(rec)
    assert len(hub.fake.merged) == 1 and rec.state == "merged"


# ── Send (a comment by hand) ──


async def test_sending_a_comment_thats_gone_or_cant_be_queued_says_why(
    hub, tmp_path, projects, monkeypatch
):
    """Send on a comment the pane no longer lists, or to a session whose inbox is full,
    sends nothing and marks nothing seen."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    rec = watched(hub, repo)
    hub.fake.comment("acme/app", 7, "Please rename x", "stranger", association="NONE")
    await hub.code_pr.poll(rec)
    [comment] = hub.code_pr.details[rec.key]["comments"]
    hub.code_pr.cmd_comment({"id": task.id, "comment": 424242})
    assert await said(hub, "That comment isn't there any more.")
    monkeypatch.setattr(hub.tasks, "send", lambda *a, **k: False)
    seen = list(rec.seen)
    hub.code_pr.cmd_comment({"id": task.id, "comment": comment["id"]})
    assert await said(hub, "Too many messages are waiting for that session already.")
    assert rec.seen == seen and rec.followup == ""


# ── Push, Forget, the log, the switches, the pane ──


async def test_push_from_the_pane_pushes_the_sessions_commits_behind_the_card(
    hub, tmp_path, projects
):
    """Push sends the branch's new commits to origin once the card says yes; with nothing
    new to push it says nothing."""
    repo, bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    git(repo, "push", "-q", "-u", "origin", "feature/login")
    rec = watched(hub, repo, awaiting_push=True)
    published = len(events(hub, "code_pr"))
    hub.code_pr.cmd_push({"id": task.id})
    assert await until(lambda: not rec.awaiting_push)
    # The command ends with the pane's refresh (git reading the repository): let it end before
    # the test commits there, or the two git processes can meet on the repository's lock.
    assert await until(lambda: len(events(hub, "code_pr")) > published)
    assert hub.cards == [] and captions(hub) == []  # already there: no card, no words
    (repo / "b.py").write_text("y = 2\n")
    git(repo, "commit", "-qam", "Fix the failing test")
    hub.answers = ["push"]
    hub.code_pr.cmd_push({"id": task.id})
    assert await said(hub, "Pushed the work for pull request #7.")
    assert git(bare, "rev-parse", "feature/login").strip() == git(repo, "rev-parse", "HEAD").strip()


async def test_push_from_a_folder_that_is_no_longer_a_repository_says_so(
    hub, tmp_path, projects, monkeypatch
):
    """Push when git can't read the session's folder any more says why, pushing nothing."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    watched(hub, repo)
    monkeypatch.setattr(code_pr.code_changes, "repo_of", lambda _cwd: None)
    hub.code_pr.cmd_push({"id": task.id})
    assert await said(hub, "This folder isn't a git repository.")
    assert hub.cards == []


async def test_forget_stops_watching_and_says_so(hub, tmp_path, projects):
    """Forget takes the pull request off the watch list, saved, and says which."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    rec = watched(hub, repo)
    hub.code_pr.cmd_forget({"id": task.id})
    assert captions(hub) == ["Stopped watching pull request #7."]
    assert not rec.watch and rec not in hub.code_pr.store().watched()
    # Refresh brings an open one back on the watch, and reads it.
    hub.code_pr.cmd_refresh({"id": task.id})
    assert await until(lambda: hub.fake.sent("GET", "/repos/acme/app/pulls/7"))
    assert rec.watch


async def test_a_checks_log_is_read_for_the_pane_and_an_unknown_check_is_empty(
    hub, tmp_path, projects, monkeypatch
):
    """The log button reads the failing Actions job's log; a check that isn't there shows
    an empty log."""
    _repo, _bare, task, _sent, _rec = await failing_pr(hub, tmp_path, projects, monkeypatch)
    hub.code_pr.cmd_log({"id": task.id, "check": "tests"})
    assert await until(lambda: events(hub, "code_pr_log"))
    [shown] = events(hub, "code_pr_log")
    assert shown["key"] == f"id:{task.id}" and shown["check"] == "tests"
    assert "1 failed" in shown["text"] and "FAILED test_login" in shown["text"]
    hub.code_pr.cmd_log({"id": task.id, "check": "nope"})
    assert await until(lambda: len(events(hub, "code_pr_log")) == 2)
    assert events(hub, "code_pr_log")[-1]["text"] == ""


async def test_a_log_github_wont_give_is_said_in_its_place(hub, tmp_path, projects, monkeypatch):
    """A failing job whose log GitHub can't find is still sent, with why in the log's place;
    a check from another service is read from its annotations."""
    repo, _bare = github_project(tmp_path, projects)
    session(hub, repo)
    sent = sends(hub, monkeypatch)
    rec = watched(hub, repo)
    hub.fake.run("head1", "tests", conclusion="failure")  # no log kept: GitHub says 404
    hub.fake.run("head1", "circle", conclusion="failure", actions=False)
    await hub.code_pr.poll(rec)
    [note] = sent
    assert "(the log couldn't be read: GitHub can't find acme/app" in note["text"]
    assert '<ci-log check="circle">' in note["text"]
    assert any(r.url.path.endswith("/annotations") for r in hub.fake.requests)


async def test_the_switches_turn_fixing_back_on_and_pick_the_method(hub, tmp_path, projects):
    """Turning fixing back on starts its count again; the method is kept; merging when
    green turned off needs no card."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    rec = watched(hub, repo, autofix=False, fix_attempts=3, auto_merge=True)
    hub.code_pr.cmd_set({"id": task.id, "autofix": True, "method": "merge", "auto_merge": False})
    assert await until(lambda: events(hub, "code_pr"))
    assert rec.autofix and rec.fix_attempts == 0 and rec.merge_method == "merge"
    assert rec.auto_merge is False and hub.cards == []


async def test_the_pane_lists_every_pull_request_and_drafts_on_request(
    hub, tmp_path, projects, monkeypatch
):
    """code_prs lists the watched ones with their session; code_pr shows the session's
    and asks GitHub again when it's stale; dropping a draft forgets it."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    rec = watched(hub, repo)
    desk = hub.code_pr
    desk.cmd_list({})
    [listed] = events(hub, "code_prs")[-1]["items"]
    assert listed["number"] == 7 and listed["task_id"] == task.id
    desk.cmd_state({"id": task.id})
    assert desk.next_poll[rec.key] <= time.time()  # never polled: looked at now
    assert await until(lambda: events(hub, "code_pr"))
    desk.drafts[task.id] = {"title": "kept"}
    desk.cmd_draft_drop({"id": task.id})
    assert task.id not in desk.drafts
    assert await until(lambda: events(hub, "code_pr")[-1]["draft"] is None)
    desk.cmd_draft({"id": task.id, "base": "main"})
    assert await until(lambda: events(hub, "code_pr_draft"))
    assert events(hub, "code_pr_draft")[-1]["note"] == "This branch already has pull request #7."


async def test_a_session_that_got_its_id_later_is_kept_on_its_record(hub, tmp_path, projects):
    """A record found by its folder takes the session's Claude Code id when the pane shows
    it, so it follows the session from then on."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo, session_id="s-new")
    rec = watched(hub, repo)
    rec.session_id = ""
    await hub.code_pr.publish(task)
    assert rec.session_id == "s-new"


async def test_the_pane_for_a_folder_without_git_says_so(hub, tmp_path, projects):
    """A session in a plain folder shows no pull request and that it isn't a git folder."""
    plain = projects / "plain"
    plain.mkdir()
    task = session(hub, plain)
    await hub.code_pr.publish(task)
    shown = events(hub, "code_pr")[-1]
    assert shown["pr"] is None and shown["where"] == {"git": False}


async def test_the_merge_methods_fall_back_to_all_when_github_cant_say(hub, tmp_path, projects):
    """When the repository's settings can't be read, every method is offered."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    watched(hub, repo)
    hub.fake.fail[("GET", "/repos/acme/app")] = (500, {"message": "boom"}, {})
    await hub.code_pr.publish(task)
    assert events(hub, "code_pr")[-1]["methods"] == ["squash", "merge", "rebase"]


# ── opening's refusals ──


async def test_opening_from_the_pane_says_what_happened(hub, tmp_path, projects):
    """code_pr_open pushes behind the card, opens it, and the reply is the pane's caption."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    hub.answers = ["push"]
    hub.code_pr.cmd_open({"id": task.id, "title": "Make x two", "body": ""})
    assert await said(hub, "Opened pull request #7.")
    assert hub.code_pr.store().find("acme/app", 7) is not None


async def test_opening_a_branch_that_already_has_one_links_it(hub, tmp_path, projects):
    """GitHub's 422 "already exists" links the branch's open pull request instead."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    hub.fake.add_pull("acme/app", "feature/login", sha="old", title="Made elsewhere")
    hub.answers = ["push"]
    reply = await hub.code_pr.open(task, {"title": "Make x two", "body": ""})
    assert reply == "Linked the branch's pull request #7."
    rec = hub.code_pr.store().find("acme/app", 7)
    assert rec.title == "Made elsewhere" and rec.session_id == "s-1" and rec.watch


async def test_opening_turned_down_by_github_says_github_s_words(hub, tmp_path, projects):
    """Any other 422, and a server error, come back as GitHub said them, with nothing
    linked."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    create = ("POST", "/repos/acme/app/pulls")
    hub.fake.fail[create] = (422, {"message": "Validation Failed",
                                   "errors": [{"message": "Base main is protected."}]}, {})  # fmt: skip
    hub.answers = ["push"]
    reply = await hub.code_pr.open(task, {"title": "Make x two", "body": ""})
    assert reply == "GitHub said no: Base main is protected."
    hub.fake.fail[create] = (502, {"message": "Bad gateway"}, {})
    reply = await hub.code_pr.open(task, {"title": "Make x two", "body": ""})
    assert reply == "GitHub had a problem (502). Try again in a moment."
    # "Already exists", yet GitHub lists none open on the branch: its words, as said.
    hub.fake.fail[create] = (422, {"message": "Validation Failed", "errors": [
        {"message": "A pull request already exists for acme:feature/login."}]}, {})  # fmt: skip
    reply = await hub.code_pr.open(task, {"title": "Make x two", "body": ""})
    assert reply == "GitHub said no: A pull request already exists for acme:feature/login."
    assert hub.code_pr.store().items == []


async def test_opening_from_a_branch_with_nothing_new_or_no_repository_is_refused(
    hub, tmp_path, projects
):
    """A branch level with its base has nothing to open; a plain folder isn't git; a
    detached head is on no branch. None of them pushes or calls GitHub."""
    repo, _bare = github_project(tmp_path, projects)
    git(repo, "switch", "-q", "-c", "empty", "main")
    task = session(hub, repo)
    reply = await hub.code_pr.open(task, {"title": "Nothing", "body": ""})
    assert reply == "There's nothing on empty that isn't in main yet."
    git(repo, "switch", "-q", "--detach", "HEAD")
    reply = await hub.code_pr.open(task, {"title": "Nothing", "body": ""})
    assert reply == "You're not on a branch, so there's nothing to open a pull request from."
    plain = projects / "plain"
    plain.mkdir()
    task.cwd = plain
    reply = await hub.code_pr.open(task, {"title": "Nothing", "body": ""})
    assert reply == "This folder isn't a git repository."
    assert hub.cards == [] and hub.fake.sent("POST") == []


async def test_without_a_token_the_draft_says_how_to_connect(hub, tmp_path, projects):
    """With GitHub not connected, the draft's note is how to connect it."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    await hub.code_pr.client.aclose()
    hub.code_pr._client = github.Client(lambda: "", transport=hub.fake.transport())
    event = await hub.code_pr.draft(task)
    assert event["draft"] is None and event["note"] == github.CONNECT
    assert "Tools & Accounts" in github.CONNECT


# ── follow-ups that can't reach a session ──


async def test_a_follow_up_for_a_busy_or_gone_session_says_why(
    hub, tmp_path, projects, monkeypatch
):
    """An automatic follow-up waits for a busy session; with the session gone and its folder
    gone too, the owner is told to open one; a session that can't be resumed says why."""
    repo, _bare = github_project(tmp_path, projects)
    task = session(hub, repo)
    rec = watched(hub, repo)
    task.busy = True
    assert await hub.code_pr.follow_up(rec, "fix", "logs") == (
        "The session is busy; it gets this when it's done."
    )
    del hub.tasks.tasks[task.id]
    rec.folder = str(tmp_path / "gone")
    assert await hub.code_pr.follow_up(rec, "fix", "logs") == (
        "There's no session for pull request #7 any more: open one in its folder."
    )
    rec.folder = str(repo)

    def cant(*_a, **_k):
        raise ValueError("Too many sessions are running.")

    monkeypatch.setattr(hub.tasks, "start", cant)
    assert await hub.code_pr.follow_up(rec, "fix", "logs") == "Too many sessions are running."
    assert rec.followup == ""


async def test_a_follow_up_for_a_closed_session_resumes_it_in_its_folder(
    hub, tmp_path, projects, monkeypatch
):
    """With no session listed, the record's Claude Code session is resumed in its folder
    and the follow-up goes to it."""
    repo, _bare = github_project(tmp_path, projects)
    rec = watched(hub, repo)
    sent = sends(hub, monkeypatch)
    started = []

    def start(prompt, directory, resume=""):
        started.append((prompt, directory, resume))
        return session(hub, repo, id=5, session_id=resume)

    monkeypatch.setattr(hub.tasks, "start", start)
    assert await hub.code_pr.follow_up(rec, "jarvis", "the owner asks") == ""
    assert started == [("", str(repo), "s-1")]
    assert sent == [{"id": 5, "text": "the owner asks", "note": True}]
    assert rec.followup == "jarvis" and rec.followup_task == 5


# ── the watcher ──


async def test_a_closed_pull_request_stops_being_watched(hub, tmp_path, projects, monkeypatch):
    """Closed without a merge: no heads-up, and it's off the watch list."""
    repo, _bare = github_project(tmp_path, projects)
    session(hub, repo)
    sends(hub, monkeypatch)
    rec = watched(hub, repo)
    hub.fake.pulls[("acme/app", 7)]["state"] = "closed"
    await hub.code_pr.poll(rec)
    assert rec.state == "closed" and not rec.watch and hub.alerts == []


async def test_a_github_error_in_a_poll_is_shown_and_waits_and_a_rate_limit_says_nothing(
    hub, tmp_path, projects
):
    """GitHub's 500 shows on the pane and the next look waits two minutes; a rate limit
    just stops this look, with nothing shown."""
    repo, _bare = github_project(tmp_path, projects)
    session(hub, repo)
    rec = watched(hub, repo)
    desk = hub.code_pr
    hub.fake.fail[PULL] = (500, {"message": "boom"}, {})
    await desk.poll(rec)
    assert desk.details[rec.key]["error"] == "GitHub had a problem (500). Try again in a moment."
    assert desk.next_poll[rec.key] - time.time() > 100
    desk.next_poll[rec.key] = 0
    desk.details[rec.key]["error"] = ""
    hub.fake.fail[PULL] = (403, {"message": "API rate limit exceeded"}, {"retry-after": "60"})
    await desk.poll(rec)
    assert desk.details[rec.key]["error"] == "" and desk.next_poll[rec.key] == 0
    assert desk.client.wait_seconds() > 0


async def test_without_github_connected_the_watcher_waits_and_calls_nothing(
    hub, tmp_path, projects
):
    """With no token, due pull requests are put off for the idle interval, unasked."""
    repo, _bare = github_project(tmp_path, projects)
    session(hub, repo)
    rec = watched(hub, repo)
    desk = hub.code_pr
    await desk.client.aclose()
    desk._client = github.Client(lambda: "", transport=hub.fake.transport())
    await desk.tick(now=1000.0)
    assert desk.next_poll[rec.key] == 1000.0 + code_pr.POLL_IDLE
    assert hub.fake.requests == []
    await desk.tick(now=1001.0)  # not due yet: nothing at all
    assert desk.next_poll[rec.key] == 1000.0 + code_pr.POLL_IDLE


async def test_a_poll_that_dies_is_logged_and_the_others_still_go(
    hub, tmp_path, projects, monkeypatch, caplog
):
    """One pull request's look raising doesn't stop the tick; it's logged."""
    repo, _bare = github_project(tmp_path, projects)
    session(hub, repo)
    rec = watched(hub, repo)

    async def broken(_rec):
        raise RuntimeError("nobody expected this")

    monkeypatch.setattr(hub.code_pr, "poll", broken)
    with caplog.at_level("ERROR", logger="jarvis"):
        await hub.code_pr.tick()
    assert f"{rec.key} couldn't be read" in caplog.text


async def test_the_watch_loop_ticks_survives_a_failure_and_wakes_when_poked(
    hub, tmp_path, projects, monkeypatch
):
    """The loop looks after its first wait, keeps going when a look fails, and a poke (the
    owner opened or refreshed one) wakes it before the next tick is due."""
    monkeypatch.setattr(code_pr, "WATCH_FIRST", 0.0)
    monkeypatch.setattr(code_pr, "TICK", 30.0)  # (only a poke can wake it in time)
    desk = hub.code_pr
    ticks = []

    async def tick(now=None):
        ticks.append(time.time())
        if len(ticks) == 1:
            raise RuntimeError("the first look fails")

    monkeypatch.setattr(desk, "tick", tick)
    loop = asyncio.create_task(desk.watch())
    try:
        assert await until(lambda: len(ticks) == 1)
        await asyncio.sleep(0.02)
        assert len(ticks) == 1  # waiting for the next tick
        desk.poke("acme/app#7")
        assert await until(lambda: len(ticks) == 2)
        desk.poke("acme/app#7")
        assert await until(lambda: len(ticks) == 3)
    finally:
        loop.cancel()
        await asyncio.gather(loop, return_exceptions=True)
    assert desk.next_poll["acme/app#7"] > time.time()
