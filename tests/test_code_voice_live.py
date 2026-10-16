"""Eden's voice in Eden Code (features/code_voice_live.py): the Voice switch opens Eden's ears
on a code backend on demand and closes them, nothing listens at launch unless Voice was left on
and an Eden Code window is open, one listener is shared with Eden Secretary's hands-free,
conversation without the wake word (or with it), hold to talk, the spoken commands, and the
spoken walk through a session's changes. A fake listener and recorder: no microphone opens."""

import asyncio
import time
from dataclasses import replace

import numpy as np
import pytest
from conftest import CALENDAR_TURN, FakeClient
from test_code_changes import Session, make_repo, numbered

from jarvis import hub as hub_module
from jarvis import local_voice
from jarvis.features import code_voice_live as cvl
from jarvis.hub import Hub


class Listener:
    made = 0

    def __init__(self, *args):
        Listener.made += 1
        self.running = False

    def start(self):
        self.running = True

    def stop(self):
        self.running = False


class Transcriber:
    def __init__(self, text="add a retry around the query"):
        self.warmed = 0
        self.text = text

    def warm_up(self):
        self.warmed += 1

    def transcribe(self, _audio, *_hints):
        return self.text


def make_hub(settings, speaker, isolated, recorder=None, transcriber=None):
    class Client(FakeClient):
        script = CALENDAR_TURN

    hub = Hub(
        settings,
        client_factory=Client,
        speaker=speaker,
        transcriber=transcriber or Transcriber(),
        recorder=recorder,
        poll=False,
        **isolated,
    )
    hub.listener_factory = Listener
    return hub


@pytest.fixture
def code(monkeypatch):
    monkeypatch.setenv("JARVIS_PROFILE", "code")


@pytest.fixture
async def started(settings, quiet_speaker, isolated, tmp_path, code):
    (tmp_path / "proj").mkdir()
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    hub.said = []
    hub.say = lambda text, follow_up=True: hub.said.append(text)
    yield hub
    for task in hub.tasks.tasks.values():
        if task.handle and not task.handle.done():
            task.handle.cancel()


def listening(hub):
    return hub._listener is not None and hub._listener.running


def events(hub):
    seen = []
    emit = hub.emit
    hub.emit = lambda kind, **data: (seen.append((kind, data)), emit(kind, **data))[1]
    return seen


# ── on, off, and launch ──


async def test_the_switch_opens_edens_ears_on_a_code_backend_and_closes_them(started):
    hub = started
    assert hub.profile == "code" and not listening(hub)
    assert hub.transcriber.warmed == 0  # nothing at launch
    task = hub.tasks.start("", "proj")
    seen = events(hub)
    await hub.handle({"type": "code_voice_live", "on": True, "id": task.id})
    assert listening(hub) and hub.voicecode.focus == task.id
    assert hub.transcriber.warmed == 1
    assert hub.prefs.feature("code_voice_on") is True
    state = [d for k, d in seen if k == "code_voice_live"][-1]
    assert state["active"] and state["listening"] and state["focus"] == task.id
    assert state["wake"] is False and state["hands_free"] is True
    await hub.handle({"type": "code_voice_live", "on": True, "id": task.id})  # again: one listener
    assert hub.transcriber.warmed == 1
    await hub.handle({"type": "code_voice_live", "on": False})
    assert not listening(hub) and hub.voicecode.focus is None
    assert hub.prefs.feature("code_voice_on") is False
    assert [d for k, d in seen if k == "code_voice_live"][-1]["active"] is False


async def test_nothing_listens_at_launch_unless_voice_was_left_on_and_eden_code_is_open(
    settings, quiet_speaker, isolated, code
):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.prefs.features["code_voice_on"] = True  # left on last time
    await hub.start()
    assert not listening(hub) and hub.transcriber.warmed == 0
    hub.window_joined("eden-code")  # Eden Code's window opens: Voice comes back on
    assert listening(hub) and hub.code_voice_live.active
    hub.window_left("eden-code")  # its last window closes: quiet, still on for next time
    assert not listening(hub) and not hub.code_voice_live.active
    assert hub.prefs.feature("code_voice_on") is True


async def test_voice_left_off_never_listens_when_eden_code_opens(started):
    hub = started
    hub.window_joined("eden-code")
    assert not listening(hub) and hub.transcriber.warmed == 0


async def test_an_eden_secretary_window_alone_doesnt_start_eden_codes_voice(
    settings, quiet_speaker, isolated, code
):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.prefs.features["code_voice_on"] = True
    hub.prefs.hands_free = False  # Eden Secretary's own hands-free is off
    await hub.start()
    hub.window_joined("jarvis")
    assert not listening(hub) and not hub.code_voice_live.active


async def test_saying_exit_code_mode_turns_voice_off(started):
    hub = started
    task = hub.tasks.start("", "proj")
    await hub.handle({"type": "code_voice_live", "on": True, "id": task.id})
    await hub.on_heard("exit code mode")
    assert hub.voicecode.focus is None and not listening(hub)
    assert hub.prefs.feature("code_voice_on") is False


async def test_one_listener_is_shared_with_eden_secretarys_hands_free(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.prefs.hands_free = False
    await hub.start()
    Listener.made = 0
    await hub.handle({"type": "code_voice_live", "on": True})
    hub.set_prefs({"hands_free": True})  # Eden Secretary's too: the same listener
    assert listening(hub) and Listener.made == 1
    await hub.handle({"type": "code_voice_live", "on": False})
    assert listening(hub)  # Eden Secretary still wants it
    hub.set_prefs({"hands_free": False})
    assert not listening(hub)


async def test_a_code_backend_ignores_eden_secretarys_hands_free_setting(started):
    hub = started
    hub.set_prefs({"hands_free": True})  # Eden Secretary's setting, saved in the shared prefs
    assert not listening(hub)


async def test_push_to_talk_only_keeps_the_microphone_closed_until_the_key(started):
    hub = started
    hub.set_feature_prefs({"code_voice_hands_free": False})
    await hub.handle({"type": "code_voice_live", "on": True})
    assert hub.code_voice_live.active and not listening(hub)


# ── talking to the session ──


async def test_conversation_needs_no_wake_word_and_the_wake_word_can_be_asked_for(started):
    hub = started
    task = hub.tasks.start("", "proj")
    sent = []
    hub.tasks.send = lambda task_id, text, **_k: sent.append((task_id, text)) or True
    await hub.handle({"type": "code_voice_live", "on": True, "id": task.id})
    hub.state = "idle"
    await hub.on_heard("add a retry around the query")
    assert sent == [(task.id, "add a retry around the query")]
    hub.set_feature_prefs({"code_voice_wake": True})
    await hub.on_heard("just chatting about lunch")
    assert len(sent) == 1  # no "Eden": not for the session
    await hub.on_heard("Jarvis, and a test for it")  # (the tests' wake word)
    assert sent[-1] == (task.id, "and a test for it")


async def test_voice_off_means_the_wake_word_again(started):
    hub = started
    task = hub.tasks.start("", "proj")
    sent = []
    hub.tasks.send = lambda task_id, text, **_k: sent.append(text) or True
    await hub.voice_code(task_id=task.id)  # voice focus alone (Eden Secretary's way)
    hub._armed_until = 0.0
    await hub.on_heard("add a retry around the query")
    assert sent == []


async def test_hold_to_talk_sends_what_was_said_when_the_key_is_let_go(
    settings, quiet_speaker, isolated, tmp_path, code
):
    (tmp_path / "proj").mkdir()
    calls = []
    holder = {}

    def recorder(silence, _on_level):
        calls.append(silence)
        hub = holder["hub"]
        for _ in range(300):  # held until the window says the key was let go
            finish = hub._ptt_finish
            if finish is None or finish.is_set():
                break
            time.sleep(0.01)
        return np.ones(1600, dtype=np.float32)

    hub = make_hub(settings, quiet_speaker, isolated, recorder=recorder)
    holder["hub"] = hub
    await hub.start()
    hub.say = lambda text, follow_up=True: None
    task = hub.tasks.start("", "proj")
    sent = []
    hub.tasks.send = lambda task_id, text, **_k: sent.append(text) or True
    await hub.handle({"type": "code_voice_ptt", "down": True, "id": task.id})
    for _ in range(100):
        if hub._ptt_finish is not None:
            break
        await asyncio.sleep(0.01)
    assert hub.state == "listening" and hub.voicecode.focus == task.id
    assert calls == [hub_module.HOLD_SILENCE]  # a pause doesn't end it
    await hub.handle({"type": "code_voice_ptt", "down": False})
    for _ in range(200):
        if sent:
            break
        await asyncio.sleep(0.01)
    assert sent == ["add a retry around the query"] and hub.client.queries == []
    assert hub.transcriber.warmed == 1


async def test_hold_to_talk_without_a_session_says_to_pick_one(started):
    hub = started
    seen = events(hub)
    await hub.handle({"type": "code_voice_ptt", "down": True})
    assert hub.state == "idle"
    assert [d["text"] for k, d in seen if k == "caption"] == [
        "Pick a session first, then hold the key and talk."
    ]


async def test_spoken_stop_and_approve_reach_the_session(started):
    hub = started
    task = hub.tasks.start("", "proj")
    await hub.handle({"type": "code_voice_live", "on": True, "id": task.id})
    interrupted = []

    async def interrupt(task_id):
        interrupted.append(task_id)
        return True

    hub.tasks.interrupt = interrupt
    hub.state = "idle"
    await hub.on_heard("stop")
    assert interrupted == [task.id] and hub.said[-1] == "Stopped."
    pending = asyncio.create_task(
        hub._task_approval(
            "Eden Code in proj wants to run a command",
            "$ npm test",
            [("allow", "Yes"), ("deny", "No")],
            {"task_id": task.id, "tool": "Bash"},
        )
    )
    await asyncio.sleep(0)
    hub._spoke_until = 0
    hub.state = "idle"
    await hub.on_heard("approve")
    assert await asyncio.wait_for(pending, 2) == "allow"


# ── the spoken walk through the changes ──


@pytest.mark.parametrize(
    ("said", "walking", "word"),
    [
        ("read me the changes", False, "start"),
        ("Eden, go through the changes one by one please", False, "start"),
        ("walk me through your edits", False, "start"),
        ("next change", False, "next"),
        ("next", True, "next"),
        ("next", False, None),  # outside a walk: for the session
        ("previous change", True, "previous"),
        ("go back", True, "previous"),
        ("keep it", True, "keep"),
        ("keep that one", True, "keep"),
        ("undo it", True, "undo"),
        ("revert this change", True, "undo"),
        ("undo it", False, None),  # outside a walk: voicecode's own undo of the last step
        ("keep it simple", True, None),
        ("read me the changelog", False, None),
        ("读一下改动", False, "start"),
        ("下一处", True, "next"),
        ("保留它", True, "keep"),
        ("撤销它", True, "undo"),
        ("撤销它", False, None),
    ],
)
def test_the_walks_words(said, walking, word):
    assert cvl.walk_word(said, walking) == word


@pytest.fixture
def projects(tmp_path):
    folder = tmp_path / "projects"
    folder.mkdir()
    return folder


@pytest.fixture
async def review_hub(settings, quiet_speaker, isolated, projects):
    from test_hub import make_hub as plain_hub

    hub = plain_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.said = []
    hub.say = lambda text, follow_up=True: hub.said.append(text)
    yield hub
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


def three_changes(hub, projects):
    repo = make_repo(projects / "proj", {"a.py": numbered(60)})
    task = hub.tasks.start("", "proj")
    s = Session(hub.tasks, repo, task=task)
    s.turn("u-1")
    for n, word in ((5, "five"), (25, "twenty-five"), (45, "forty-five")):
        s.edit(repo / "a.py", f"line {n}\n", f"line {word} = {n}\n")
    return repo, task


async def test_read_me_the_changes_then_next_keep_and_undo(review_hub, projects):
    hub = review_hub
    repo, task = three_changes(hub, projects)
    await hub.voicecode.handle("read me the changes", task=task)
    assert hub.said[-1] == "Change 1 of 3, in a.py: 1 added, 1 removed."
    await hub.voicecode.handle("next change", task=task)
    assert hub.said[-1].startswith("Change 2 of 3, in a.py")
    await hub.voicecode.handle("go back", task=task)
    assert hub.said[-1].startswith("Change 1 of 3")
    await hub.voicecode.handle("keep it", task=task)
    assert hub.said[-1] == "Kept. Change 2 of 3, in a.py: 1 added, 1 removed."
    kept = hub.code_hunks.kept[task.id]
    assert len(kept) == 1
    await hub.voicecode.handle("undo it", task=task)  # change 2, not the last step
    assert hub.said[-1].startswith("Undid 1 change.") and "Change 2 of 2" in hub.said[-1]
    text = (repo / "a.py").read_text()
    assert "line five = 5" in text and "line 25\n" in text and "line forty-five = 45" in text
    await hub.voicecode.handle("next", task=task)
    assert hub.said[-1] == "That was the last change."


async def test_a_walk_with_nothing_changed_says_so(review_hub, projects):
    hub = review_hub
    make_repo(projects / "proj", {"a.py": numbered(10)})
    task = hub.tasks.start("", "proj")
    await hub.voicecode.handle("read me the changes", task=task)
    assert hub.said[-1] == "There are no changes to go through yet."


async def test_keep_it_after_the_walk_has_gone_stale_is_for_the_session(review_hub, projects):
    hub = review_hub
    _repo, task = three_changes(hub, projects)
    await hub.voicecode.handle("read me the changes", task=task)
    hub.code_voice_live.walk.at -= cvl.WALK_SECONDS + 1
    sent = []
    hub.tasks.send = lambda task_id, text, *a, **k: sent.append(text) or True
    await hub.voicecode.handle("keep it simple", task=task)
    assert sent == ["keep it simple"]


# ── the voice ──


def test_alice_is_offered_only_when_eden_videos_voices_are_there(tmp_path, monkeypatch):
    assert not local_voice.offered("bf_alice")  # (conftest: an empty folder stands in)
    assert local_voice.offered("bm_george")
    pack = tmp_path / "kokoro"
    pack.mkdir()
    styles = np.arange(510 * 256, dtype=np.float32).reshape(510, 1, 256)
    with open(pack / local_voice.BORROWED_VOICES, "wb") as f:
        np.savez(f, bf_alice=styles)
    monkeypatch.setattr(local_voice, "BORROWED", pack)
    assert local_voice.offered("bf_alice")
    engine = local_voice.Engine(tmp_path / "own")  # this app's own folder: no Alice file
    got = engine.style("bf_alice")
    assert got.shape == (510, 256) and got[1, 0] == 256
    assert local_voice.borrowed_style("af_nicole") is None
