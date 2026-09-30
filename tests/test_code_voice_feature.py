"""The code-voice feature through the hub: every session by voice whatever the focus
("what's everyone doing?", switching, messages, stop, a session's question), "catch me
up" and the briefing's line, with FakeClient sessions and no model calls."""

import asyncio
import time

import numpy as np
from test_hub import drain as drain_events
from test_hub import make_hub

from jarvis import codelook
from jarvis.features import code_voice


async def hub_with(settings, quiet_speaker, isolated, tmp_path, *folders):
    for folder in folders:
        (tmp_path / folder).mkdir(exist_ok=True)
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    said: list[str] = []
    hub.say = lambda text, follow_up=True: said.append(text)
    return hub, said


def session(hub, folder, title, **attrs):
    task = hub.tasks.start("", folder)
    task.title = title
    for key, value in attrs.items():
        setattr(task, key, value)
    return task


def recording_sends(hub, pictures=None):
    sent: list[tuple[int, str]] = []

    def send(task_id, text, images=None, **_k):
        sent.append((task_id, text))
        if pictures is not None:
            pictures.append(images)
        return True

    hub.tasks.send = send
    return sent


async def ask_for(hub, task, tool="Bash", detail="$ npm test", **context):
    """A session's permission card, as tasks.py puts it up."""
    pending = asyncio.create_task(
        hub._task_approval(
            f"Jarvis Code in {task.cwd.name} wants to run a command",
            detail,
            [("allow", "Yes"), ("deny", "No, and tell Claude what to do differently")],
            {"task_id": task.id, "tool": tool, **context},
        )
    )
    await asyncio.sleep(0)
    return pending


def finish(hub, task, result="Done.", files=(), status="done"):
    hub._task_event(
        "task_finished",
        id=task.id,
        task_kind="code",
        status=status,
        result=result,
        files=list(files),
        folder=task.cwd.name,
        elapsed=0,
        origin="user",
    )


async def until(check, seconds=3.0):
    """Wait for what a background task does (a thread may be looking at the project)."""
    for _ in range(int(seconds / 0.01)):
        if check():
            return True
        await asyncio.sleep(0.01)
    return check()


def close_all(hub):
    for task in hub.tasks.tasks.values():
        if task.handle is not None:
            task.handle.cancel()


# ── everyone, whatever the focus ──


async def test_whats_everyone_doing_is_answered_without_claude(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "jarvis", "bsh")
    busy = session(hub, "jarvis", "Add a retry", busy=True, last_action="Editing hub.py")
    docs = session(hub, "bsh", "Write the docs")
    pending = await ask_for(hub, docs)
    reply = await hub.ask("what's everyone doing?")
    assert reply == (
        f"2 sessions. Session {docs.id} in bsh (Write the docs) needs you: it wants to run a "
        f"command. Session {busy.id} in jarvis (Add a retry) is working: editing hub dot py."
    )
    assert hub.client.queries == []  # no model call
    assert not pending.done()  # read out, never answered for the user
    pending.cancel()
    close_all(hub)


async def test_the_same_words_go_to_claude_when_no_session_is_open(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    await hub.ask("what's everyone doing?")
    assert hub.client.said == ["what's everyone doing?"]


async def test_while_voice_coding_the_supervisor_hears_it_first(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, said = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    await hub.voice_code("proj")
    focused = hub.voicecode.task
    focused.title = "Add a retry"
    other = session(hub, "proj", "Fix the tests", busy=True, last_action="Running pytest -q")
    sent = recording_sends(hub)
    hub._armed_until = time.monotonic() + 5
    await hub.on_heard("what's everyone doing")
    assert sent == []  # never sent to the focused session as a request
    assert said[-1] == (
        f"2 sessions. Session {other.id} (Fix the tests) is working: running pytest -q. "
        f"Session {focused.id} (Add a retry) is waiting for you."
    )
    await hub.voicecode.handle("add a retry around the query")  # its own requests still go
    assert sent == [(focused.id, "add a retry around the query")]
    close_all(hub)


async def test_switching_voice_focus_by_number_name_or_project(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, said = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj", "api")
    first = session(hub, "proj", "Add a retry")
    second = session(hub, "api", "Fix the login flow")
    reply = await hub.ask(f"switch to session {second.id}")  # not voice coding yet: it starts
    assert hub.voicecode.focus == second.id and reply.startswith("Voice coding in api")
    await hub.voicecode.handle("switch to the retry session")
    assert (
        hub.voicecode.focus == first.id
        and said[-1] == f"Switched to session {first.id} (Add a retry)."
    )
    await hub.voicecode.handle("switch to the retry session")
    assert said[-1] == f"You're already on session {first.id} (Add a retry)."
    await hub.voicecode.handle("switch to the api project")
    assert hub.voicecode.focus == second.id
    await hub.voicecode.handle("switch to session 42")
    assert said[-1] == "There's no Jarvis Code session 42."
    close_all(hub)


async def test_a_message_goes_to_the_session_named(settings, quiet_speaker, isolated, tmp_path):
    hub, said = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj", "docs")
    await hub.voice_code("proj")
    focused = hub.voicecode.task
    docs = session(hub, "docs", "Write the API docs")
    sent = recording_sends(hub)
    await hub.voicecode.handle("tell the docs session to also update the changelog dot md")
    assert sent == [(docs.id, "also update the changelog.md")]
    assert said[-1] == f"Told session {docs.id} (Write the API docs)."
    await hub.voicecode.handle("tell the user session manager to refresh tokens")
    assert sent[-1] == (focused.id, "tell the user session manager to refresh tokens")  # Claude's
    reply = await hub.ask("ask the docs session what it changed")  # not voice coding: the same
    assert sent[-1] == (docs.id, "What you changed?") and reply.startswith("Told")
    await hub.ask("tell the docs session to link readme dot md")  # typed or said to JARVIS
    assert sent[-1] == (docs.id, "link readme.md")  # no "dictated by voice" hint then
    close_all(hub)


async def test_a_name_that_fits_two_sessions_is_asked_about(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, said = await hub_with(settings, quiet_speaker, isolated, tmp_path, "web", "api")
    web = session(hub, "web", "Fix the failing tests")
    api = session(hub, "api", "Fix the failing tests")
    sent = recording_sends(hub)
    assert await hub.ask("tell the tests session to use pytest x") == ""
    await asyncio.sleep(0.01)
    (card,) = hub.approvals.values()
    assert card["ask_kind"] == "question"
    assert [c["id"] for c in card["choices"]] == [f"s{api.id}", f"s{web.id}", "skip"]
    assert sent == []  # nothing goes until the user picks
    hub._spoke_until = 0
    await hub.on_heard("the second one")
    assert await until(lambda: sent)
    assert sent == [(web.id, "use pytest x")] and said[-1].startswith("Told session")
    close_all(hub)


async def test_stop_interrupts_the_named_session(settings, quiet_speaker, isolated, tmp_path):
    hub, said = await hub_with(settings, quiet_speaker, isolated, tmp_path, "api")
    api = session(hub, "api", "Refactor the login", busy=True)
    stopped = []

    async def interrupt(task_id):
        stopped.append(task_id)
        return True

    hub.tasks.interrupt = interrupt
    assert (
        await hub.ask("stop the login session") == f"Stopped session {api.id} (Refactor the login)."
    )
    assert stopped == [api.id]
    close_all(hub)


async def test_a_sessions_question_is_read_out_and_only_the_owner_answers(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "docs")
    docs = session(hub, "docs", "Write the docs")
    pending = await ask_for(hub, docs)
    reply = await hub.ask("what does the docs session want?")
    assert reply == f"Session {docs.id} (Write the docs) wants to run npm test. Should it?"
    await asyncio.sleep(0.01)
    assert not pending.done()  # read out: it waits for the owner
    hub._spoke_until = 0
    await hub.on_heard("yes")
    assert await pending == "allow"
    assert await hub.ask("what does the docs session want?") == (
        f"Session {docs.id} (Write the docs) isn't waiting on you."
    )
    close_all(hub)


async def test_who_needs_me_while_voice_coding(settings, quiet_speaker, isolated, tmp_path):
    hub, said = await hub_with(settings, quiet_speaker, isolated, tmp_path, "a")
    await hub.voice_code("a")
    hub.voicecode.task.title = "First"
    other = session(hub, "a", "Second")
    await hub.voicecode.handle("who needs me?")
    assert said[-1] == "No session needs you right now."
    pending = await ask_for(hub, other)
    await hub.voicecode.handle("who needs me?")
    assert said[-1] == f"Session {other.id} (Second) wants to run npm test. Should it?"
    # Said to JARVIS itself, not voice coding, the same words are its own to answer.
    hub.voicecode.exit()
    await hub.ask("who needs me?")
    assert hub.client.said == ["who needs me?"]
    pending.cancel()
    close_all(hub)


async def test_in_mandarin(settings, quiet_speaker, isolated, tmp_path):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    hub.prefs.language = "zh"
    one = session(hub, "proj", "Add a retry", busy=True)
    sent = recording_sends(hub)
    assert await hub.ask("大家都在做什么") == f"一个会话。会话{one.id}（Add a retry）正在工作。"
    assert await hub.ask("告诉 retry 会话也写个测试") == f"已转告会话{one.id}（Add a retry）。"
    assert sent == [(one.id, "也写个测试")]
    close_all(hub)


# ── catch me up ──


async def test_catch_me_up_tells_what_happened_since_you_last_looked(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    one = session(hub, "proj", "Add a retry")
    tool = {"role": "tool", "tool": "Bash", "tool_id": "t1", "detail": "$ uv run pytest -q"}
    hub._task_event("task_log", id=one.id, entry=tool)
    hub._task_event("task_log_update", id=one.id, tool_id="t1", status="done", output="41 passed")
    finish(
        hub, one, "I added the retry and a test. The rest is fine.", ["/p/hub.py", "/p/test_hub.py"]
    )
    reply = await hub.ask("catch me up")
    assert reply == (
        f"Session {one.id} (Add a retry) finished. It changed 2 files: hub.py, test_hub.py. "
        "41 tests passed. It says: I added the retry and a test."
    )
    assert await hub.ask("catch me up") == "Nothing new in Jarvis Code since you last looked."
    finish(hub, one, "Fixed the typo.")
    await hub.handle({"type": "code_voice_seen", "id": one.id})  # the owner looked at it
    assert await hub.ask("catch me up") == "Nothing new in Jarvis Code since you last looked."
    close_all(hub)


async def test_a_voice_coding_reply_counts_as_heard(settings, quiet_speaker, isolated, tmp_path):
    hub, said = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    await hub.voice_code("proj")
    task = hub.voicecode.task
    task.result = "Added the retry."
    finish(hub, task, "Added the retry.")
    assert said[-1] == "Added the retry."  # read out as it finished
    await hub.voicecode.handle("catch me up")
    assert said[-1] == "Nothing new in Jarvis Code since you last looked."
    await hub.voicecode.handle("what did I miss")  # everyday words, while voice coding
    assert said[-1] == "Nothing new in Jarvis Code since you last looked."
    close_all(hub)


async def test_several_replies_are_condensed_within_the_haiku_cap(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    feature = hub.code_voice
    assert feature.summarize is None  # a test's hub never calls a model by itself
    prompts = []

    async def summarize(prompt, system=None):
        prompts.append(prompt)
        return "It added a retry, then tested it. And more."

    feature.summarize = summarize
    feature.limiter = code_voice.Limiter(1)
    one = session(hub, "proj", "Retry work")
    finish(hub, one, "Added the retry.")
    finish(hub, one, "Wrote a test for it.")
    reply = await hub.ask("catch me up")
    assert reply.endswith("It says: It added a retry, then tested it.")
    assert "Report 1:\nAdded the retry." in prompts[0] and "Report 2:\nWrote a test" in prompts[0]
    finish(hub, one, "Renamed things.")
    finish(hub, one, "Cleaned up the imports.")
    reply = await hub.ask("catch me up")  # past the cap: its own last words instead
    assert len(prompts) == 1 and reply.endswith("It says: Cleaned up the imports.")
    close_all(hub)


async def test_the_morning_briefing_gets_a_line_about_the_night(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    one = session(hub, "proj", "Nightly refactor")
    finish(hub, one, "Refactored it.", ["/p/a.py"])
    await hub.briefing()
    prompt = hub.client.said[-1]
    assert "what Jarvis Code did while the user was away" in prompt
    assert "“Nightly refactor” in proj: finished, 1 file changed" in prompt
    close_all(hub)


# ── the kit this feature added to the hub ──


async def test_instants_that_decline_or_break_leave_the_request_to_claude(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()

    async def broken(_text):
        raise RuntimeError("a broken feature")

    async def declines(_text):
        return None

    async def takes(text):
        return "Taken." if text == "take this" else None

    hub._instants[:0] = [broken, declines, takes]
    assert await hub.ask("take this") == "Taken."
    await hub.ask("what's on tomorrow?")
    assert hub.client.said == ["what's on tomorrow?"]


async def test_task_sinks_and_briefing_notes_never_break_the_hub(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    heard = []
    hub.add_task_sink(lambda kind, data: (_ for _ in ()).throw(RuntimeError("broken sink")))
    hub.add_task_sink(lambda kind, data: heard.append((kind, data["id"])))
    hub._task_event("task_log", id=7, entry={"role": "system", "text": "x"})
    assert heard == [("task_log", 7)]
    hub.add_briefing_note(lambda: 1 / 0)
    hub.add_briefing_note(lambda: "Also the tide.")
    assert hub._briefing_extra().endswith(" Also the tide.")


async def test_a_feature_command_can_leave_a_message_to_the_built_in_one(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    seen = []

    async def only_mine(msg):
        seen.append(msg["changes"])
        return False if "look" in msg["changes"] else None

    hub.register_command("set_prefs", only_mine)
    await hub._handle({"type": "set_prefs", "changes": {"look": "hud"}})  # the built-in's too
    await hub._handle({"type": "set_prefs", "changes": {"humor": 5}})  # the feature's alone
    assert hub.prefs.look == "hud" and hub.prefs.humor != 5 and len(seen) == 2


# ── the focused session: its model, ultracode, its files ──

OR_KEY = "sk-or-v1-" + "0123456789abcdef" * 4


async def test_use_a_model_added_in_settings_by_its_name(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, said = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    provider = hub.providers.add_provider("openrouter", "", OR_KEY)
    pro = hub.providers.add_model(provider["id"], "google/gemini-2.5-pro", "Gemini Pro")["ref"]
    flash = hub.providers.add_model(provider["id"], "google/gemini-2.5-flash", "Gemini Flash")[
        "ref"
    ]
    await hub.voice_code("proj")
    task = hub.voicecode.task
    await hub.voicecode.handle("use gemini pro")
    assert task.model_ref == pro and said[-1] == "Switched this session to Gemini Pro."
    await hub.voicecode.handle("switch to gemini")  # two fit: which one?
    await asyncio.sleep(0.01)
    (card,) = hub.approvals.values()
    assert [c["label"] for c in card["choices"]][:2] == [
        "Gemini Pro · OpenRouter",
        "Gemini Flash · OpenRouter",
    ]
    hub._spoke_until = 0
    await hub.on_heard("the second one")
    assert await until(lambda: task.model_ref == flash)
    await hub.voicecode.handle("use grok 4")
    assert said[-1] == "grok 4 isn't one of your models. Add it in Settings, Models and API keys."
    sent = recording_sends(hub)
    await hub.voicecode.handle("use a dict here")  # not a model: a request for Claude
    assert sent == [(task.id, "use a dict here")]
    close_all(hub)


async def test_model_names_are_only_the_sessions_while_voice_coding(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    await hub.ask("use gemini pro")  # to JARVIS itself: its own business
    assert hub.client.said == ["use gemini pro"]


async def test_ultracode_on_and_off_by_voice(settings, quiet_speaker, isolated, tmp_path):
    hub, said = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    await hub.voice_code("proj")
    task = hub.voicecode.task
    await hub.voicecode.handle("ultracode on")
    assert task.ultracode and task.effort == "xhigh" and said[-1].startswith("Ultracode on")
    await hub.voicecode.handle("turn off ultra code")
    assert not task.ultracode and task.effort == "high" and said[-1] == "Ultracode off."
    close_all(hub)


def project_with_files(root):
    (root / "src").mkdir(parents=True)
    (root / "src" / "hub.py").write_text(
        "import asyncio\n\n\nclass Hub:\n    def ask(self, text):\n        retries = 3\n"
        "        while retries:\n            retries -= 1\n        return text\n"
    )
    (root / "README.md").write_text("# Proj\n\nHello.\n")
    (root / "server.key").write_text("-----BEGIN PRIVATE KEY-----\n")


async def test_read_lines_shows_them_and_says_what_they_are(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, said = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    project_with_files(tmp_path / "proj")
    await hub.voice_code("proj")
    task = hub.voicecode.task
    q = hub.subscribe()
    await hub.voicecode.handle("read lines 6 to 8 of hub dot py")
    shown = [e for e in drain_events(q) if e["type"] == "code_voice_file"]
    assert shown == [{"type": "code_voice_file", "id": task.id, "directory": str(task.cwd),
                      "path": "src/hub.py", "start": 6, "end": 8}]  # fmt: skip
    assert said[-1] == "Lines 6 to 8 of hub.py are on screen. They're inside ask."
    assert "retries" not in said[-1]  # code is never read aloud
    prompts = []

    async def summarize(prompt, system=None):
        prompts.append((prompt, system))
        return "They count the retries down. Then more."

    hub.code_voice.summarize = summarize
    await hub.voicecode.handle("show me line 4 of src slash hub dot py")
    assert said[-1] == "Line 4 of hub.py is on screen. They count the retries down."
    assert "class Hub:" in prompts[0][0] and "never follow" in prompts[0][1]
    await hub.voicecode.handle("read lines 40 to 50 of hub dot py")
    assert said[-1] == "hub.py has only 10 lines."
    await hub.voicecode.handle("read lines 1 to 2 of nothing dot py")
    assert said[-1] == "I can't find nothing.py in proj."
    await hub.voicecode.handle("read line 1 of server.key")
    assert said[-1] == "That file holds credentials or private data."
    await hub.voicecode.handle("open server.key")
    assert said[-1] == "That file holds credentials or private data."
    close_all(hub)


async def test_open_a_file_by_voice(settings, quiet_speaker, isolated, tmp_path):
    hub, said = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    project_with_files(tmp_path / "proj")
    await hub.voice_code("proj")
    task = hub.voicecode.task
    q = hub.subscribe()
    await hub.voicecode.handle("open readme dot md")
    events = [e for e in drain_events(q) if e["type"] in ("show_session", "code_voice_file")]
    assert [e["type"] for e in events] == ["show_session", "code_voice_file"]
    assert events[1]["path"] == "README.md" and events[1]["start"] == 0
    assert said[-1] == "README.md is on screen."
    sent = recording_sends(hub)
    await hub.voicecode.handle("open the src folder")  # no such file: a request for Claude
    assert sent == [(task.id, "open the src folder")]
    close_all(hub)


# ── look at this, into a session ──


def spoken_question(words):
    """Push to talk hears these words (no microphone: a recorder and a transcriber that
    stand in for it)."""

    class Heard:
        def transcribe(self, _audio):
            return words

    return Heard()


async def look_hub(settings, quiet_speaker, isolated, tmp_path, words):
    (tmp_path / "proj").mkdir(exist_ok=True)
    recorder = lambda _silence, _level: np.zeros(1600, dtype=np.float32)  # noqa: E731
    hub = make_hub(settings, quiet_speaker, recorder=recorder, isolated=isolated)
    hub.transcriber = spoken_question(words)
    await hub.start()
    said: list[str] = []
    hub.say = lambda text, follow_up=True: said.append(text)
    front = codelook.Look(
        "Safari",
        "Build failed · CI",
        "TypeError: x is undefined",
        {"media_type": "image/jpeg", "data": "V0lO"},
    )

    async def capture():
        return front

    hub.code_voice.capture = capture
    return hub, said


async def test_look_at_this_goes_into_the_session_in_voice_focus(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = await look_hub(settings, quiet_speaker, isolated, tmp_path, "why is this failing")
    await hub.voice_code("proj")
    task = hub.voicecode.task
    pictures = []
    sent = recording_sends(hub, pictures)
    await hub.handle({"type": "whats_this", "session": 0})
    assert await until(lambda: sent)
    (task_id, text), (images,) = sent[0], pictures
    assert task_id == task.id and text.startswith("why is this failing\n\n(The owner pressed")
    assert "Safari, “Build failed · CI”" in text and "TypeError: x is undefined" in text
    assert images == [{"media_type": "image/jpeg", "data": "V0lO"}]
    assert hub.client.queries == []  # not JARVIS's own What's-this
    close_all(hub)


async def test_look_at_this_with_jarvis_code_in_front_and_the_answer_read_out(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, said = await look_hub(settings, quiet_speaker, isolated, tmp_path, "what does this mean")
    task = session(hub, "proj", "Fix the build")
    sent = recording_sends(hub)
    await hub.handle({"type": "whats_this", "session": task.id})
    assert await until(lambda: sent)
    assert sent[0][0] == task.id and said[-1] == f"Sent to session {task.id} (Fix the build)."
    finish(hub, task, "It's a missing import. I added it.")
    assert said[-1] == "It's a missing import. I added it."  # asked by voice: answered aloud
    finish(hub, task, "Something later.")
    assert said[-1] == "It's a missing import. I added it."  # only that answer
    close_all(hub)


async def test_never_mind_after_the_key_sends_nothing(settings, quiet_speaker, isolated, tmp_path):
    hub, _ = await look_hub(settings, quiet_speaker, isolated, tmp_path, "never mind")
    await hub.voice_code("proj")
    sent = recording_sends(hub)
    q = hub.subscribe()
    await hub.handle({"type": "whats_this"})
    assert await until(lambda: any(e.get("text") == "Nothing sent." for e in drain_events(q)))
    assert sent == []
    close_all(hub)


async def test_hands_free_the_next_thing_said_is_the_question(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = await look_hub(settings, quiet_speaker, isolated, tmp_path, "unused")
    await hub.voice_code("proj")
    task = hub.voicecode.task
    sent = recording_sends(hub)
    armed = []
    hub._listener = type("Listening", (), {"running": True})()
    hub._arm = lambda seconds=0, chime=True: (
        armed.append(seconds) or setattr(hub, "_armed_until", time.monotonic() + seconds)
    )
    await hub.handle({"type": "whats_this"})
    assert await until(lambda: armed)
    await hub.on_heard("is this the flaky test")
    assert await until(lambda: sent)
    assert sent[0][0] == task.id and sent[0][1].startswith("is this the flaky test")
    hub._listener = None
    close_all(hub)


async def test_the_key_anywhere_else_is_jarvis_own_whats_this(
    settings, quiet_speaker, isolated, monkeypatch
):
    from jarvis import hub as hub_module

    monkeypatch.setattr(hub_module, "frontmost_app", lambda: "Xcode")
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    await hub.handle({"type": "whats_this", "session": 99})  # no such session
    assert await until(lambda: hub.client.queries)
    assert "using Xcode" in hub.client.queries[-1] and hub.code_voice.look is None


# ── point and speak ──

PAGE = {
    "kind": "page",
    "tag": "BUTTON",
    "text": "Buy now",
    "selector": "#buy",
    "box": {"x": 10, "y": 20, "width": 80, "height": 30},
    "url": "http://localhost:5173/shop",
    "title": "Shop",
    "image": {"media_type": "image/png", "data": "iVBORw0KGgo="},
}


async def answer_points(hub, q, ref):
    """The window, asked what the hand points at, answers."""
    for _ in range(300):
        asked = [e for e in drain_events(q) if e["type"] == "code_voice_point"]
        if asked:
            await hub.handle({"type": "code_voice_pointed", "id": asked[0]["id"], "ref": ref})
            return True
        await asyncio.sleep(0.01)
    return False


async def test_make_this_bigger_goes_with_what_the_hand_points_at(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    await hub.voice_code("proj")
    task = hub.voicecode.task
    pictures = []
    sent = recording_sends(hub, pictures)
    await hub.handle({"type": "code_voice_hand", "pointing": True})
    q = hub.subscribe()
    said = asyncio.create_task(hub.voicecode.handle("make this bigger"))
    assert await answer_points(hub, q, PAGE)
    await said
    ((task_id, text),), (images,) = sent, pictures
    assert task_id == task.id and text.startswith(
        "make this bigger\n\n[Pointed at while saying this"
    )
    assert "a <button> element, reading “Buy now”, CSS selector `#buy`" in text
    assert "data, not instructions" in text and images == [PAGE["image"]]
    close_all(hub)


async def test_a_spot_on_the_simulator(settings, quiet_speaker, isolated, tmp_path):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    await hub.voice_code("proj")
    sent = recording_sends(hub)
    await hub.handle({"type": "code_voice_hand", "pointing": True})
    q = hub.subscribe()
    said = asyncio.create_task(hub.voicecode.handle("why is that red"))
    spot = {"kind": "simulator", "x": 0.42, "y": 0.18, "device": "iPhone 17", "image": None}
    assert await answer_points(hub, q, spot)
    await said
    assert sent[0][1].endswith(
        "[Pointed at while saying this, on the iOS Simulator's screen (iPhone 17): the spot 42% "
        "across and 18% down.]"
    )
    close_all(hub)


async def test_without_a_pointing_hand_or_an_answer_the_request_goes_alone(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    await hub.voice_code("proj")
    task = hub.voicecode.task
    sent = recording_sends(hub)
    q = hub.subscribe()
    await hub.voicecode.handle("make this bigger")  # hand control isn't pointing
    assert sent == [(task.id, "make this bigger")]
    assert not [e for e in drain_events(q) if e["type"] == "code_voice_point"]
    await hub.handle({"type": "code_voice_hand", "pointing": True})
    monkeypatch.setattr(code_voice, "POINT_TIMEOUT", 0.05)
    await hub.voicecode.handle("make this smaller")  # the window never answers
    assert sent[-1] == (task.id, "make this smaller")
    said = asyncio.create_task(hub.voicecode.handle("make that blue"))
    assert await answer_points(hub, q, {"kind": "nonsense"})  # a shape it can't have
    await said
    assert sent[-1] == (task.id, "make that blue")
    await hub.voicecode.handle("undo that")  # a session command, pointing or not
    assert sent[-1] == (task.id, "make that blue")
    close_all(hub)
