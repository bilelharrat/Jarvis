"""Waiting out Claude's usage limit in Jarvis Code (features/code_limit.py and the hold in
tasks.py): with the setting on, a session Claude's limit stops waits for the reset, its
queue held and the owner told until when; then it carries on on Claude, the app's note
first. Everything else Claude can't answer still goes to the fallback."""

import asyncio
import time

from test_fallback import LIMIT, Limited
from test_hub import make_hub

from jarvis import tasks as tasks_module
from jarvis.tasks import ClaudeTask


async def until(condition, seconds=10.0):
    for _ in range(int(seconds / 0.005)):
        if condition():
            return True
        await asyncio.sleep(0.005)
    return False


def waiting_hub(settings, quiet_speaker, isolated, monkeypatch, wait=True):
    monkeypatch.setattr(tasks_module, "REOPEN_QUIET", 0.01)
    Limited.made, Limited.limited = [], True
    Limited.resets_at = time.time() + 3 * 3600
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.tasks.client_factory = Limited
    hub.set_feature_prefs({"code_limit_wait": wait})
    hub.alerts = []
    hub.add_notify_sink(lambda alert: hub.alerts.append(alert))
    (settings.projects_dir / "p").mkdir()
    return hub


def queries():
    return [q for client in Limited.made for q in client.queries]


async def test_a_session_waits_out_the_limit_then_carries_on_on_claude(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = waiting_hub(settings, quiet_speaker, isolated, monkeypatch)
    q = hub.subscribe()
    task = hub.tasks.start(
        "fix the login bug", "p", model="claude-opus-5-5", model_label="Opus 5.5"
    )
    assert await until(lambda: task.hold_until > 0 and not task.busy)
    assert abs(task.hold_until - Limited.resets_at) < 2  # when Claude Code said it resets
    said = [e["text"] for e in task.transcript if e["role"] in ("assistant", "system")]
    assert said[0] == LIMIT
    assert said[-1].startswith("Claude's usage limit is reached: this session waits until")
    assert hub.alerts[-1].text.startswith(
        "Claude's usage limit is reached: Jarvis Code waits until"
    )
    assert task.model_ref == "" and not task.fell_back_from  # never moved to a fallback
    assert task.public()["hold_until"] == task.hold_until
    # What's sent meanwhile waits in the queue.
    assert hub.tasks.send(task.id, "and the signup page")
    await asyncio.sleep(0.3)
    assert queries() == ["fix the login bug"] and task.inbox.qsize() == 1
    events = []
    while not q.empty():
        events.append(q.get_nowait())
    assert not [e for e in events if e["type"] == "task_finished"]  # the stop isn't a failure
    # The limit resets: the note goes first, then what was queued.
    Limited.limited = False
    hub.code_limit.release(task)
    assert await until(lambda: len(queries()) == 3 and not task.busy)
    note, then = queries()[1:]
    assert note.startswith("[Note from the app: Claude's usage limit stopped this session at")
    assert "Carry on with my last request" in note and then == "and the signup page"
    assert task.hold_until == 0 and not task.falling_back
    hub.tasks.cancel(task.id)


async def test_the_wait_ends_by_itself_when_the_limit_resets(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = waiting_hub(settings, quiet_speaker, isolated, monkeypatch)
    task = hub.tasks.start("fix it", "p", model="claude-opus-5-5")
    assert await until(lambda: task.hold_until > 0 and not task.busy)
    Limited.limited = False
    # The reset, a moment away (a real one is hours off; the first wait is replaced).
    hub.code_limit.hold(task, time.time() + 1.5)
    assert await until(lambda: len(queries()) == 2 and not task.busy, seconds=20)
    assert queries()[1].startswith("[Note from the app: Claude's usage limit stopped")
    assert task.hold_until == 0 and hub.code_limit.waits == {}
    hub.tasks.cancel(task.id)


async def test_a_waiting_session_may_still_close_to_make_room_and_opens_after_the_wait(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = waiting_hub(settings, quiet_speaker, isolated, monkeypatch)
    task = hub.tasks.start("fix it", "p", model="claude-opus-5-5")
    assert await until(lambda: task.hold_until > 0 and not task.busy)
    assert hub.tasks.send(task.id, "and the tests")
    task.close_idle = True  # (too many sessions open: the longest idle one closes)
    task.stirred.set()
    assert await until(lambda: task.handle.done() and task.status == "closed")
    await asyncio.sleep(0.2)
    assert len(Limited.made) == 1 and task.inbox.qsize() == 1  # not reopened for it
    Limited.limited = False
    hub.code_limit.release(task)
    assert await until(lambda: len(queries()) == 3 and not task.busy, seconds=20)
    assert queries()[1].startswith("[Note from the app:") and queries()[2] == "and the tests"
    hub.tasks.cancel(task.id)


async def test_with_the_setting_off_or_another_kind_of_trouble_the_fallback_decides(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = waiting_hub(settings, quiet_speaker, isolated, monkeypatch, wait=False)
    heard = []
    down = hub.code_limit.claude_down(lambda task, why, said: heard.append(why) or False)
    task = ClaudeTask(id=1, prompt="", cwd=settings.projects_dir)
    assert down(task, "rate_limit", "") is False and heard == ["rate_limit"]
    hub.set_feature_prefs({"code_limit_wait": True})
    assert down(task, "overloaded", "") is False and heard[-1] == "overloaded"
    task.model_ref = "custom:gem1"  # another provider's model: not Claude's limit
    assert down(task, "rate_limit", "") is False and heard[-1] == "rate_limit"
    task.model_ref = ""
    assert down(task, "rate_limit", "") is True and len(heard) == 3 and task.hold_until > 0
    hub.code_limit.forget()


async def test_the_owner_can_try_now_or_use_the_fallback_from_the_header(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = waiting_hub(settings, quiet_speaker, isolated, monkeypatch)
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    task = ClaudeTask(id=4, prompt="", cwd=settings.projects_dir)
    hub.tasks.tasks[4] = task
    sent, moved = [], []
    monkeypatch.setattr(hub.tasks, "send", lambda tid, text, **kw: sent.append((tid, kw)) or True)
    monkeypatch.setattr(hub, "_code_claude_down", lambda t, why, said: moved.append(why) or False)
    hub.code_limit.hold(task, time.time() + 3600)
    hub.code_limit.cmd({"id": 4, "action": "fallback"})
    assert moved == ["rate_limit"] and task.hold_until > 0  # no fallback model: still waiting
    assert 4 in hub.code_limit.waits and 4 in hub.code_limit.since  # …as it was
    assert hub.events[-1] == ("caption", {"text": "There's no fallback model to move it to."})
    hub.code_limit.cmd({"id": 4, "action": "now"})
    assert task.hold_until == 0 and sent == [(4, {"note": True})]
    assert task.transcript[-1]["text"] == "Trying Claude again now." and not hub.code_limit.waits
    hub.code_limit.cmd({"id": 4, "action": "now"})
    assert hub.events[-1] == ("caption", {"text": "This session isn't waiting for Claude."})


async def test_a_held_session_isnt_reopened_by_a_message_or_by_itself(settings, tmp_path):
    from conftest import FakeClient

    async def approve(*_a, **_k):
        return "deny"

    made = []

    class Client(FakeClient):
        def __init__(self, options=None):
            super().__init__(options)
            made.append(self)

    tm = tasks_module.TaskManager(settings, approve, lambda *a, **k: None, Client)
    (tmp_path / "p").mkdir()
    task = ClaudeTask(id=1, prompt="", cwd=tmp_path / "p", status="closed")
    tm.tasks[1] = task
    task.hold_until = time.time() + 3600
    assert tm.send(1, "later please")
    await asyncio.sleep(0.05)
    assert task.handle is None and made == [] and task.inbox.qsize() == 1
    task.hold_until = 0.0
    assert tm.send(1, "now")
    assert task.handle is not None
    task.handle.cancel()
    await asyncio.gather(task.handle, return_exceptions=True)


async def test_a_session_ended_while_it_waits_doesnt_carry_on_by_itself(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = waiting_hub(settings, quiet_speaker, isolated, monkeypatch)
    task = ClaudeTask(id=4, prompt="", cwd=settings.projects_dir, status="stopped", session_id="s")
    hub.tasks.tasks[4] = task
    sent, started = [], []
    monkeypatch.setattr(hub.tasks, "send", lambda tid, text, **kw: sent.append(tid) or True)
    monkeypatch.setattr(hub.tasks, "start", lambda *a, **kw: started.append((a, kw)) or task)
    hub.code_limit.hold(task, time.time() + 3600)
    hub.code_limit.release(task)
    assert sent == [] and started == [] and task.hold_until == 0
    task.inbox.put("the owner's own message, sent while it waited")
    hub.code_limit.hold(task, time.time() + 3600)
    hub.code_limit.release(task)
    assert sent == [] and started == [(("", str(settings.projects_dir)), {"resume": "s"})]


async def test_the_wait_is_told_in_chinese_to_a_chinese_speaking_owner(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = waiting_hub(settings, quiet_speaker, isolated, monkeypatch)
    hub.prefs.language = "zh"
    task = ClaudeTask(id=4, prompt="", cwd=settings.projects_dir)
    hub.tasks.tasks[4] = task
    hub.code_limit.hold(task, time.time() + 3 * 86400)  # a weekly limit: its day is said
    line = task.transcript[-1]["text"]
    assert line.startswith("已达到 Claude 的用量上限：这个会话会等到周"), line
    assert line.endswith("然后接着做。这期间你发的消息也会等着。"), line
    alert = hub.alerts[-1]
    assert alert.title == "Claude 的用量上限"
    assert alert.text.startswith("已达到 Claude 的用量上限：Jarvis Code 会等到周"), alert.text
    hub.code_limit.forget()
