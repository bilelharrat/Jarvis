"""Eden Code sessions, composer and conversation: the round 1 bug sweep's fixes
(askeden/docs/bug-sweep/r1-eden-code-sessions.md, CA3-CA20). Each test failed before its fix."""

import asyncio
import json
import time
from pathlib import Path

import pytest
from claude_agent_sdk.types import SessionMessage
from code_session_fakes import Stream, end_all, events_of, make_hub, until
from conftest import FakeClient
from starlette.testclient import TestClient

from jarvis import tasks
from jarvis.server import create_app
from jarvis.tasks import ENTRY_MAX, MESSAGE_MAX, TRANSCRIPT_KEEP, ClaudeTask, command_key


@pytest.fixture
def proj(tmp_path):
    (tmp_path / "proj").mkdir()
    return tmp_path / "proj"


# ── CA3: startup never waits on Eden's own Claude Code; the Code profile makes none ──


class Stuck(FakeClient):
    """A Claude Code CLI that never finishes starting (the 951 s start in the sweep)."""

    made = 0

    def __init__(self, options=None):
        super().__init__(options)
        Stuck.made += 1

    async def connect(self):
        await asyncio.Event().wait()


async def test_start_finishes_while_claude_code_is_still_starting(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    hub = make_hub(settings, quiet_speaker, isolated, client=Stuck)
    began = time.monotonic()
    await asyncio.wait_for(hub.start(), 10)  # before the fix: never returned
    assert time.monotonic() - began < 5
    assert hub._connecting is not None and not hub._connecting.done()  # still at it, behind
    hub._connecting.cancel()


def test_health_and_the_page_answer_while_claude_code_starts(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    hub = make_hub(settings, quiet_speaker, isolated, client=Stuck)
    with TestClient(create_app(hub, "t0k"), base_url="http://127.0.0.1:8123") as c:
        assert c.get("/health").json()["ok"] is True
        assert c.get("/?app=code").status_code == 200


async def test_eden_code_alone_starts_no_assistant_connection_until_needed(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.setenv("JARVIS_PROFILE", "code")
    Stuck.made = 0
    hub = make_hub(settings, quiet_speaker, isolated, client=Stuck)
    await hub.start()
    await asyncio.sleep(0.05)
    assert hub._connecting is None and Stuck.made == 0  # no extra claude process at start
    hub.window_joined("jarvis")  # an Eden window: its assistant connects (in the background)
    assert hub._connecting is not None
    await asyncio.sleep(0.05)
    assert Stuck.made == 1
    hub._connecting.cancel()


async def test_a_request_waits_for_the_connection_made_in_the_background(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.setenv("JARVIS_PROFILE", "code")
    hub = make_hub(settings, quiet_speaker, isolated, client=FakeClient)
    await hub.start()
    assert hub.client is None
    await hub._connection_ready()  # what ask() does first: connects now
    assert hub.client is not None and hub.client.connected


# ── the second brain: never built for Eden Code alone ──


async def test_brain_building_waits_for_an_eden_window(settings, quiet_speaker, isolated, monkeypatch):
    monkeypatch.setenv("JARVIS_PROFILE", "code")
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.poll = True  # (only the deferred rebuild is looked at)
    built = []

    async def no_process(*args, **kwargs):  # jarvis.brain_build would read Notes, Mail…
        built.append(args)
        raise AssertionError("brain_build started in Eden Code's profile")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", no_process)
    await hub.rebuild_brain()
    await hub.rebuild_brain(only={"notes"})
    assert built == [] and hub._brain_deferred == {"*", "notes"}
    started = []

    async def rebuild(only=None):
        started.append(only)

    monkeypatch.setattr(hub, "rebuild_brain", rebuild)
    monkeypatch.setattr(hub, "_briefing_clock", lambda: asyncio.sleep(0))
    monkeypatch.setattr(hub, "_spawn_voice_loops", lambda: [])
    monkeypatch.setattr(hub, "_spawn_eden_loops", lambda: None)
    monkeypatch.setattr(hub, "_connect_soon", lambda: None)
    hub.window_joined("jarvis")
    await asyncio.sleep(0)
    assert started == [None] and hub._brain_deferred is None


# ── CA4: "don't ask again" never covers a destructive form or a path outside ──


def test_an_rm_rule_never_covers_the_disk_home_or_outside_the_project(tmp_path):
    cwd = tmp_path / "proj"
    cwd.mkdir()
    assert command_key("rm -rf build", cwd) == "rm"  # the rule as offered still works
    assert command_key("rm notes.txt", cwd) == "rm"
    for dangerous in (
        "rm -rf /",
        "rm -rf ~",
        "rm -rf ~/Documents",
        "rm -rf $HOME/Library",
        "rm -rf ${HOME}",
        "rm -rf ../other",
        "rm -rf .",
        "rm -rf ./",
        f"rm -rf {tmp_path}",
        "rm -rf /Users/someone/Documents",
        "dd if=/dev/zero of=/dev/disk2",
        "chmod -R 777 /",
        "mv build /tmp/x",
    ):
        assert command_key(dangerous, cwd) is None, dangerous
    assert tasks.rule_allows("rm", "rm -rf build", cwd)
    assert not tasks.rule_allows("rm", "rm -rf /", cwd)
    assert not tasks.rule_allows("rm", "rm -rf ~", cwd)
    assert command_key("npm test", cwd) == "npm test"  # other rules as before
    assert command_key("git commit -m 'fix the login'", cwd) == "git commit"


# ── CA6: long entries kept whole (to MESSAGE_MAX), never cut without a marker ──


def test_a_long_reply_is_kept_whole_and_a_huge_one_says_it_was_cut(settings, tmp_path):
    tm = tasks.TaskManager(settings, None, lambda *a, **k: None, FakeClient)
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path)
    reply = "word " * 4000  # 20,000 characters: was cut at 8,000, silently
    tm._log(task, "assistant", reply)
    assert task.transcript[-1]["text"] == reply and "truncated" not in task.transcript[-1]
    tm._log(task, "assistant", "y" * (ENTRY_MAX + 5000))
    entry = task.transcript[-1]
    assert entry["truncated"] == 5000 and entry["text"].endswith("(Cut here: 5,000 more characters.)")


# ── CA7 / CA13 / CA16: what task_new and task_send take ──


async def test_messages_over_the_limit_are_refused_never_cut(settings, quiet_speaker, isolated, proj):
    hub = make_hub(settings, quiet_speaker, isolated)
    seen = events_of(hub)
    await hub.handle({"type": "task_new", "directory": "proj", "prompt": "x" * (MESSAGE_MAX + 1)})
    assert not hub.tasks.tasks  # no session with a 300 KB prompt
    assert any(e["type"] == "error" and "100,000" in e["text"] for e in seen())
    await hub.handle({"type": "task_new", "directory": "proj", "prompt": "hi"})
    (task,) = hub.tasks.tasks.values()
    await until(lambda: not task.busy and Stream.instances and task.client is not None)
    sent = []
    hub.tasks.send = lambda *a, **k: sent.append(a)
    await hub.handle({"type": "task_send", "id": task.id, "text": "y" * (MESSAGE_MAX + 1)})
    assert sent == []  # was cut to 20,000 and sent, its end (the user's words) lost
    long_one = "z" * 25_000 + "END-OF-MESSAGE"
    await hub.handle({"type": "task_send", "id": task.id, "text": long_one})
    assert sent[0][1] == long_one
    await end_all(hub)


async def test_a_new_sessions_title_and_odd_fields(settings, quiet_speaker, isolated, proj):
    hub = make_hub(settings, quiet_speaker, isolated)
    seen = events_of(hub)
    await hub.handle({"type": "task_new", "directory": "proj", "prompt": "a", "title": "t  " * 100_000})
    (task,) = hub.tasks.tasks.values()
    assert task.title == ("t " * 50).strip() and len(task.title) <= 100
    # add_dirs as an object: no traceback, no folder; as a string: not each character
    await hub.handle({"type": "task_new", "directory": "proj", "prompt": "b", "add_dirs": {"a": 1}})
    await hub.handle({"type": "task_new", "directory": "proj", "prompt": "c", "add_dirs": "abc"})
    assert len(hub.tasks.tasks) == 3
    notes = [e["text"] for t in hub.tasks.tasks.values() for e in t.transcript if e["role"] == "system"]
    assert not any("can't be added" in n for n in notes)
    await hub.handle({"type": "task_new", "directory": None, "prompt": "d"})
    errors = [e["text"] for e in seen() if e["type"] == "error"]
    assert errors and "None" not in errors[-1]
    await end_all(hub)


# ── CA8: /add-dir never takes a folder holding the whole home folder ──


def test_add_dir_refuses_the_folders_above_home_and_system_roots(settings, tmp_path, monkeypatch):
    tm = tasks.TaskManager(settings, None, lambda *a, **k: None, FakeClient)
    home = tmp_path / "home" / "me"
    (home / "work").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path / "proj")
    tm.tasks[1] = task
    for broad in (str(home.parent), str(tmp_path), "/private", "/Volumes", "/", "/usr"):
        assert tm.add_dir(1, broad), broad  # refused, with the reason
    assert task.add_dirs == []
    assert tm.add_dir(1, str(home / "work")) == ""  # a project folder still goes


# ── CA9: a change sends the windows that session, not the whole list ──


async def test_a_rename_sends_the_windows_one_session(settings, quiet_speaker, isolated, proj):
    hub = make_hub(settings, quiet_speaker, isolated)
    tasks_made = [hub.tasks.start("", "proj", title=f"s{n}") for n in range(5)]
    await asyncio.sleep(0.2)
    seen = events_of(hub)
    seen()
    hub.tasks.rename(tasks_made[2].id, "renamed")
    events = seen()
    assert not [e for e in events if e["type"] == "tasks"]  # the whole list: snapshot only
    (patch,) = [e for e in events if e["type"] == "tasks_patch"]
    assert [i["id"] for i in patch["items"]] == [tasks_made[2].id] and patch["removed"] == []
    assert patch["items"][0]["title"] == "renamed"
    assert len(json.dumps(patch)) < len(json.dumps(hub.tasks.public()))
    assert hub.snapshot()["tasks"] == hub.tasks.public()  # a new window gets them all
    hub.tasks.rename(tasks_made[2].id, "renamed")  # nothing changed: nothing sent
    assert not [e for e in seen()[len(events):] if e["type"] == "tasks_patch"]
    await end_all(hub)


# ── CA10: the isolated-copy offer shows in its session, one card per folder ──


async def test_the_isolation_offer_is_in_its_session_and_shared_by_a_burst(
    settings, quiet_speaker, isolated, proj, monkeypatch
):
    from jarvis.features import code_isolation

    hub = make_hub(settings, quiet_speaker, isolated)
    iso = hub.code_desk
    asked = []

    async def request_approval(question, detail="", choices=None, context=None, spoken=""):
        asked.append(context)
        await asyncio.sleep(0.05)
        return "share"

    monkeypatch.setattr(hub, "request_approval", request_approval)
    one = ClaudeTask(id=101, prompt="a", cwd=proj)
    two = ClaudeTask(id=102, prompt="b", cwd=proj)
    first = asyncio.create_task(iso.offer(one))
    await asyncio.sleep(0)
    assert one.last_action == code_isolation.WAITING_OFFER
    second = asyncio.create_task(iso.offer(two))
    assert await first is False and await second is False
    assert asked == [{"task_id": 101}]  # one card, in the first session


# ── CA12: /export: all of a long session, Unicode titles, quotes on every line ──


def test_export_keeps_a_long_session_whole_and_its_unicode_title(settings, tmp_path, monkeypatch):
    monkeypatch.setattr(tasks, "EXPORT_DIR", tmp_path / "out")
    tm = tasks.TaskManager(settings, None, lambda *a, **k: None, FakeClient)
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path, title="修复登录错误", session_id="s1")
    tm.tasks[1] = task
    for n in range(450):
        tm._log(task, "user", f"message {n}")
    assert len(task.transcript) == TRANSCRIPT_KEEP
    record = [
        SessionMessage(type="user", uuid=f"u{n}", session_id="s1", message={"role": "user", "content": f"message {n}"})
        for n in range(450)
    ]
    monkeypatch.setattr(tasks, "get_session_messages", lambda sid, directory=None: record)
    path = tm.export(1)
    text = path.read_text()
    assert "修复登录错误" in path.name
    assert "> message 0\n" in text and "> message 449\n" in text  # was the newest 400 only
    tm._log(task, "user", "line one\nline two")
    monkeypatch.setattr(tasks, "get_session_messages", lambda sid, directory=None: [])
    assert "> line one\n> line two" in tm.export(1).read_text()


# ── CA14: undo says its own words, the error as it came ──


async def test_undo_never_rewrites_the_error_it_quotes(settings, tmp_path):
    class Refuses(FakeClient):
        async def rewind_files(self, user_message_id):
            raise RuntimeError("the rewind_files control request timed out (rewind not supported)")

    tm = tasks.TaskManager(settings, None, lambda *a, **k: None, Refuses)
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path, checkpoints=["u1"])
    task.client = Refuses()
    tm.tasks[1] = task
    reply = await tm.undo(1)
    assert reply == "Couldn't undo: the rewind_files control request timed out (rewind not supported)"


# ── CA15: failing saves are said in the windows ──


async def test_sessions_that_cant_be_saved_are_said_once(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = hub.code_sessions
    seen = events_of(hub)
    desk._save_failed(PermissionError(13, "Permission denied"))
    desk._save_failed(PermissionError(13, "Permission denied"))
    toasts = [e for e in seen() if e["type"] == "toast"]
    assert len(toasts) == 1 and "can't save its sessions" in toasts[0]["text"]
    desk._saved({})
    assert "saving its sessions again" in [e for e in seen() if e["type"] == "toast"][-1]["text"]


# ── CA17 / CA18: a failed start said once; a message sent as it ended isn't stranded ──


async def test_a_claude_code_that_wont_start_is_said_once(settings, tmp_path):
    class Refuses(FakeClient):
        async def connect(self):
            raise RuntimeError("Claude Code refused to start")

    tm = tasks.TaskManager(settings, None, lambda *a, **k: None, Refuses)
    (tmp_path / "p").mkdir()
    task = tm.start("hi", "p")
    await until(lambda: task.handle.done())
    await asyncio.sleep(0.05)
    stopped = [e for e in task.transcript if "Stopped with an error" in e["text"]]
    assert len(stopped) == 1 and task.status == "failed"
    assert not task.inbox.empty()  # the message waits for the next send (or Reconnect)


async def test_a_message_sent_as_the_session_ends_opens_it_again(settings, quiet_speaker, isolated, proj):
    hub = make_hub(settings, quiet_speaker, isolated)
    task = hub.tasks.start("first", "proj")
    await until(lambda: task.client is not None and not task.busy and task.turns_pending == 0)
    hub.tasks.cancel(task.id)  # End session…
    hub.tasks.send(task.id, "one more thing")  # … and a message the same moment
    await until(lambda: task.inbox.empty() and task.status == "running")
    assert task.inbox.empty() and any("one more thing" in str(q) for c in Stream.instances for q in c.queries)
    await end_all(hub)


# ── CA20: /context on a session that isn't running gets an answer ──


async def test_context_of_a_closed_session_says_so(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.tasks.tasks[7] = ClaudeTask(id=7, prompt="x", cwd=tmp_path, status="resting")
    seen = events_of(hub)
    await hub.handle({"type": "task_context", "id": 7})  # (in the background: a slow command)
    assert await until(lambda: [e for e in seen() if e["type"] == "task_context"])
    assert [e for e in seen() if e["type"] == "task_context"] == [{"type": "task_context", "id": 7, "closed": True}]


# ── keep awake from a turn's first moment ──


async def test_keep_awake_follows_the_session_list_not_a_five_second_poll(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    calls = []
    monkeypatch.setattr(hub, "_sync_awake", lambda force=False: calls.append(force))
    hub.poll = True
    for name in ("_poll_status", "_vitals_loop", "_refresh_recent", "_awake_loop"):
        monkeypatch.setattr(hub, name, lambda: asyncio.sleep(0))
    try:
        await asyncio.wait_for(hub.start(), 10)
    except Exception:
        pass
    calls.clear()
    hub.emit("tasks", items=[])
    assert calls == [False]
    for t in list(hub._background):
        t.cancel()


# ── CA19: Eden Code's page: its own modules, no web fonts, a favicon ──


def test_eden_codes_page_loads_its_own_modules_only(settings, quiet_speaker, isolated, monkeypatch):
    from jarvis.server import EDEN_ONLY_FEATURES

    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    hub = make_hub(settings, quiet_speaker, isolated)
    with TestClient(create_app(hub, "t0k"), base_url="http://127.0.0.1:8123") as c:
        everything = c.get("/features.json").json()["scripts"]
        code = c.get("/features.json?app=code").json()["scripts"]
        stem = lambda src: src.split("/")[-1].split(".")[0]  # noqa: E731
        assert EDEN_ONLY_FEATURES <= {stem(s) for s in everything}
        assert not EDEN_ONLY_FEATURES & {stem(s) for s in code}
        assert {stem(s) for s in code} >= {"code-sessions", "code-touchid", "code_isolation", "settings-nav"}
        assert "fonts.googleapis.com/css" not in c.get("/?app=code").text
        assert "fonts.googleapis.com/css" in c.get("/").text  # Eden's own window keeps its fonts
        assert c.get("/favicon.ico").status_code == 204
