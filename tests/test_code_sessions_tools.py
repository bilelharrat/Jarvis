"""The tools around Jarvis Code sessions (features.code_sessions): projects beyond the
projects folder and their own defaults, the sidebar's groups, /btw, /goal and the board."""

import subprocess
from dataclasses import replace
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    PermissionResultAllow,
    PermissionResultDeny,
    TextBlock,
    ToolPermissionContext,
)
from code_session_fakes import Stream, end_all, events_of, make_hub, res, until

from jarvis import code_asides, code_projects
from jarvis.tasks import ClaudeTask


class Scripted(Stream):
    """Sessions as Stream has them; the side calls (/btw, a goal's check) answer from
    answers, in order, and say what they were asked."""

    answers: list = []
    asked: list = []
    commands: list | None = None  # Claude Code's own commands, as its init answer lists them

    async def query(self, text):
        if self.options.system_prompt in (code_asides.BTW_PROMPT, code_asides.CHECK_PROMPT):
            Scripted.asked.append((self.options, text))
            self.answer = Scripted.answers.pop(0) if Scripted.answers else ""
            return
        await super().query(text)

    async def receive_response(self):
        yield AssistantMessage(content=[TextBlock(text=self.answer)], model="m")
        yield res(self.answer)

    async def get_server_info(self):
        if Scripted.commands is None:
            raise AttributeError("no server info")
        return {"commands": Scripted.commands}


def scripted(answers=(), commands=None):
    Stream.instances, Scripted.asked = [], []
    Scripted.answers, Scripted.commands = list(answers), commands
    return Scripted


async def session(hub, folder="proj"):
    task = hub.tasks.start("", folder)
    assert await until(lambda: task.client is not None and task.status == "waiting")
    return task


# ── projects ──


def home_settings(settings, tmp_path, monkeypatch):
    home = tmp_path / "home"
    for folder in (
        "projects/alpha",
        "code/app",
        "code/alpha",
        "work/tool",
        "Desktop",
        ".ssh",
        "Library/x",
    ):
        (home / folder).mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home)
    return replace(settings, projects_dir=home / "projects"), home


async def test_open_folder_adds_a_project_and_refuses_broad_or_private_ones(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    settings, home = home_settings(settings, tmp_path, monkeypatch)
    hub = make_hub(settings, quiet_speaker, isolated)
    seen = events_of(hub)
    await hub._handle({"type": "code_project_add", "path": str(home / "work" / "tool")})
    assert (
        "tool" in hub.tasks.projects() and hub.tasks.resolve_dir("tool") == home / "work" / "tool"
    )
    added = [e for e in seen() if e["type"] == "code_project_added"]
    assert added[-1]["name"] == "tool"
    listed = [e for e in seen() if e["type"] == "claude_projects"][-1]["items"]
    assert {p["name"]: p["path"] for p in listed}["tool"] == str(home / "work" / "tool")
    for refused in (home, home / "Desktop", home / ".ssh", home / "Library" / "x", "/etc", "rel"):
        await hub._handle({"type": "code_project_add", "path": str(refused)})
    notes = [e["text"] for e in seen() if e["type"] == "code_note"]
    assert len(notes) == 6 and all(notes)
    assert hub.prefs.feature("code_project_folders") == [str(home / "work" / "tool")]
    # One already on the list is opened, not added twice.
    await hub._handle({"type": "code_project_add", "path": str(home / "projects" / "alpha")})
    assert [e for e in seen() if e["type"] == "code_project_added"][-1]["name"] == "alpha"
    assert hub.prefs.feature("code_project_folders") == [str(home / "work" / "tool")]


async def test_more_roots_list_their_folders_and_a_name_taken_stays_off_the_list(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    settings, home = home_settings(settings, tmp_path, monkeypatch)
    hub = make_hub(settings, quiet_speaker, isolated)
    seen = events_of(hub)
    await hub._handle({"type": "code_project_add", "path": str(home / "code"), "root": True})
    assert hub.tasks.projects() == ["alpha", "app"]  # code/alpha: alpha is taken
    assert hub.tasks.project_path("alpha") == home / "projects" / "alpha"
    assert [e for e in seen() if e["type"] == "code_projects"][-1]["hidden"] == [
        str(home / "code" / "alpha")
    ]
    try:
        hub.tasks.resolve_dir(str(home / "code"))  # a root itself is too broad for a session
    except ValueError as exc:
        assert "too broad" in str(exc)
    else:
        raise AssertionError("a folder of projects was taken for a project")
    await hub._handle({"type": "code_project_remove", "path": str(home / "code"), "root": True})
    assert hub.tasks.projects() == ["alpha"]


async def test_a_projects_own_defaults_start_its_sessions_unless_one_is_chosen(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated, client=scripted())
    path = str((tmp_path / "proj").resolve())
    hub.set_feature_prefs(
        {
            "code_project_defaults": {
                path: {"mode": "plan", "effort": "max", "junk": 1, "model": "!"}
            }
        }
    )
    assert hub.prefs.feature("code_project_defaults") == {path: {"mode": "plan", "effort": "max"}}
    await hub._handle({"type": "task_new", "directory": "proj", "prompt": ""})
    await hub._handle({"type": "task_new", "directory": "proj", "prompt": "", "mode": "edits"})
    first, second = sorted(hub.tasks.tasks.values(), key=lambda t: t.id)
    assert (first.mode, first.effort) == ("plan", "max")
    assert (second.mode, second.effort) == ("edits", "max")  # what the composer chose wins
    await end_all(hub)


def test_settings_values_are_checked(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    (tmp_path / "a").mkdir()
    clean = code_projects.clean_folders(3)
    assert clean(
        [str(tmp_path / "a"), str(tmp_path / "a"), str(tmp_path / "gone"), "/etc", 5, "x"]
    ) == [
        str((tmp_path / "a").resolve()),
        str((tmp_path / "gone").resolve()),  # kept while it's away (an unmounted disk)
    ]
    assert clean("nope") is None
    snippets = code_projects.clean_snippets(
        [{"name": "Review", "text": "Review it"}, {"name": "review", "text": "again"},
         {"name": "bad name", "text": "x"}, {"name": "ok", "text": "  "}, {"name": "long", "text": "y" * 9000}]
    )  # fmt: skip
    assert snippets == [
        {"name": "review", "text": "Review it"},
        {"name": "long", "text": "y" * 8000},
    ]
    assert code_projects.clean_groups(["  Backend ", "backend", "", 3, "UI"]) == ["Backend", "UI"]


# ── the sidebar: pins, archive, groups ──


async def test_groups_follow_a_rename_and_archiving_unpins(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated, client=scripted())
    task = await session(hub)
    cs = hub.code_sessions
    await hub._handle({"type": "code_meta_set", "id": task.id, "pinned": True, "group": "Backend"})
    await hub._handle({"type": "code_meta_set", "id": task.id, "group": "backend"})  # the same one
    assert hub.prefs.feature("code_groups") == ["Backend"]
    assert cs.meta_event()["items"][str(task.id)]["group"] == "Backend"
    await hub._handle({"type": "code_group", "action": "rename", "name": "Backend", "to": "Server"})
    assert cs.meta_event()["items"][str(task.id)]["group"] == "Server"
    await hub._handle({"type": "code_group", "action": "remove", "name": "Server"})
    item = cs.meta_event()["items"][str(task.id)]
    assert item["group"] == "" and hub.prefs.feature("code_groups") == []
    await hub._handle({"type": "code_meta_set", "id": task.id, "archived": True})
    item = cs.meta_event()["items"][str(task.id)]
    assert item["archived"] and not item["pinned"]
    await end_all(hub)


# ── /btw ──


async def test_btw_answers_on_the_side_without_touching_the_session(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated, client=scripted(["Three times, in net.py."]))
    seen = events_of(hub)
    task = await session(hub)
    hub.tasks.send(task.id, "add a retry to the fetch")
    assert await until(lambda: task.status == "waiting" and task.result)
    before = list(task.transcript)
    await hub._handle(
        {"type": "code_btw", "id": task.id, "question": "how many retries?", "ref": "b1"}
    )
    answers = [e for e in seen() if e["type"] == "code_btw"]
    assert [e["state"] for e in answers] == ["working", "done"]
    assert answers[-1]["text"] == "Three times, in net.py." and answers[-1]["ref"] == "b1"
    options, prompt = Scripted.asked[0]
    assert "how many retries?" in prompt and "add a retry to the fetch" in prompt
    assert "<session-data>" in prompt
    assert options.model == code_asides.MODEL and options.tools == ["Read", "Glob", "Grep"]
    assert options.setting_sources == [] and options.max_turns == code_asides.BTW_STEPS
    assert task.transcript == before and task.client.queries == ["add a retry to the fetch"]
    # Read-only, inside the project, credentials aside.
    ctx = ToolPermissionContext()
    proj = tmp_path / "proj"
    allow = options.can_use_tool
    assert isinstance(
        await allow("Read", {"file_path": str(proj / "net.py")}, ctx), PermissionResultAllow
    )
    for name, args in (("Read", {"file_path": "/etc/hosts"}), ("Read", {"file_path": str(proj / ".env")}),
                       ("Edit", {"file_path": str(proj / "net.py")}), ("Bash", {"command": "ls"})):  # fmt: skip
        assert isinstance(await allow(name, args, ctx), PermissionResultDeny)
    hub.code_sessions.btw_hour = code_asides.Rate(0, 3600)  # the hour's are used up
    await hub._handle({"type": "code_btw", "id": task.id, "question": "and now?", "ref": "b2"})
    assert [e for e in seen() if e["type"] == "code_btw"][-1]["state"] == "error"
    assert len(Scripted.asked) == 1
    await end_all(hub)


# ── /goal ──


async def test_a_goal_rides_with_each_message_and_is_checked_after_each_turn(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    client = scripted(
        ['{"met": false, "why": "two tests still fail"}', '{"met": true, "why": "all pass"}']
    )
    hub = make_hub(settings, quiet_speaker, isolated, client=client)
    await hub.code_sessions.restore()
    task = await session(hub)
    await hub._handle(
        {"type": "code_goal", "id": task.id, "action": "set", "text": "make the\ntests pass]"}
    )
    goal = hub.code_sessions.meta_event()["items"][str(task.id)]["goal"]
    assert goal["text"] == "make the tests pass)" and not goal["native"]
    assert await until(lambda: goal["state"] == "met", tries=800)
    first, second = task.client.queries
    assert first.startswith('[Note from the app: the session\'s goal is "make the tests pass)".')
    assert first.endswith("]\n\nmake the\ntests pass]")  # the user's words as typed
    assert second.startswith("Not there yet: two tests still fail")  # the app's note, no prefix
    notes = [e["text"] for e in task.transcript if e["role"] == "system"]
    assert "Goal not met yet: two tests still fail. Carrying on (1 of 3)." in notes
    assert "Goal met: all pass" in notes
    assert [e["text"] for e in task.transcript if e["role"] == "user"] == ["make the\ntests pass]"]
    assert [o.model for o, _ in Scripted.asked] == [code_asides.MODEL] * 2
    assert all(o.tools == [] and o.max_turns == 1 for o, _ in Scripted.asked)
    await end_all(hub)


async def test_a_goal_pauses_when_stopped_or_out_of_checks_and_resumes(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated, client=scripted())
    task = await session(hub)
    cs = hub.code_sessions
    cs._meta_of(task)["goal"] = code_asides.new_goal("ship it", native=False)
    cs._turn_ended({"id": task.id, "status": "stopped"})
    goal = cs._meta_of(task)["goal"]
    assert goal["state"] == "paused" and "stopped" in goal["note"]
    assert hub.tasks.turn_note(task) == ""  # paused: nothing rides along
    goal["checks"] = code_asides.CHECKS_PER_GOAL  # its checks are used up
    await hub._handle({"type": "code_goal", "id": task.id, "action": "resume"})
    assert goal["state"] == "active" and hub.tasks.turn_note(task)
    assert await until(lambda: task.client.said[-1:] == ["Carry on toward the goal."])
    await until(lambda: goal["state"] == "paused", tries=800)
    assert goal["state"] == "paused" and Scripted.asked == []  # no check past the cap
    await hub._handle({"type": "code_goal", "id": task.id, "action": "complete"})
    assert goal["state"] == "met"
    await hub._handle({"type": "code_goal", "id": task.id, "action": "clear"})
    assert cs._meta_of(task)["goal"] is None
    await end_all(hub)


async def test_claude_codes_own_goal_is_passed_through(settings, quiet_speaker, isolated, tmp_path):
    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated, client=scripted(commands=[{"name": "goal"}]))
    task = await session(hub)
    await hub._handle(
        {"type": "code_goal", "id": task.id, "action": "set", "text": "a green build"}
    )
    goal = hub.code_sessions._meta_of(task)["goal"]
    assert goal["native"] and hub.code_sessions.native_goal is True
    assert await until(lambda: goal["state"] == "met")  # its turn ends only once the goal holds
    assert task.client.queries == ["/goal a green build"] and Scripted.asked == []
    assert hub.tasks.turn_note(task) == ""
    await end_all(hub)


async def test_a_goal_with_no_session_open_starts_one_working_on_it(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()
    hub = make_hub(
        settings, quiet_speaker, isolated, client=scripted(['{"met": true, "why": "shipped"}'])
    )
    seen = events_of(hub)
    await hub._handle({"type": "code_goal_new", "directory": "proj", "text": "ship the fix"})
    [task] = hub.tasks.tasks.values()
    goal = hub.code_sessions._meta_of(task)["goal"]
    assert goal["text"] == "ship the fix" and not goal["native"]
    assert any(e["type"] == "show_session" and e["id"] == task.id for e in seen())
    assert await until(lambda: goal["state"] == "met", tries=800)
    assert task.client.said == ["ship the fix"]
    await hub._handle({"type": "code_goal_new", "directory": "nowhere", "text": "x"})
    assert len(hub.tasks.tasks) == 1  # (task_new said why)
    await end_all(hub)


def test_goal_verdicts_and_commands_are_read_defensively():
    assert code_asides.verdict('Sure: {"met": true, "why": "done"}') == (True, "done")
    assert code_asides.verdict('{"met": "yes"}') is None and code_asides.verdict("no") is None
    assert code_asides.native_goal_command(["compact", {"name": "/goal"}])
    assert not code_asides.native_goal_command([{"name": "goals"}, 3, None])
    assert (
        code_asides.clean_goal({"text": "x", "state": "weird", "checks": -1})["state"] == "paused"
    )
    assert code_asides.clean_goal({"text": " "}) is None


# ── the board ──


def git(repo, *args):
    subprocess.run(
        ["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t",
         "-c", "commit.gpgsign=false", *args],
        check=True, capture_output=True,
    )  # fmt: skip


async def test_the_board_counts_the_lines_each_session_changed(
    settings, quiet_speaker, isolated, tmp_path
):
    repo = (tmp_path / "proj").resolve()
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    (repo / "a.py").write_text("1\n2\n")
    (repo / "other.py").write_text("x\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "init")
    (repo / "a.py").write_text("1\nX\n2\n3\n")  # +2
    (repo / "other.py").write_text("changed by someone else\n")  # not this session's
    (repo / "b.py").write_text("new\nfile\n")  # +2, untracked
    hub = make_hub(settings, quiet_speaker, isolated, client=scripted())
    seen = events_of(hub)
    task = ClaudeTask(id=7, prompt="x", cwd=repo)
    task.files_changed = {str(repo / "a.py"), str(repo / "b.py"), "/elsewhere/c.py"}
    hub.tasks.tasks[7] = task
    await hub._handle({"type": "code_board"})
    item = [e for e in seen() if e["type"] == "code_board"][-1]["items"]["7"]
    assert (item["added"], item["removed"], item["branch"]) == (4, 0, "main")
