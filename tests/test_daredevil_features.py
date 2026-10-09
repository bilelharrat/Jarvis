"""J.A.R.V.I.S. Daredevil's accessibility and safety features: long reading's own speed and amount
(accessibility_reading), the screen and the AI model and where the focus went
(accessibility_screen), check my work (check_work), the trusted person (accessibility_helper),
the first-run setup by voice (accessibility_setup), voice typing read back, and voice ID set up
by voice. A test hub, with cards answered by the test, nothing sent and no network."""

from __future__ import annotations

import asyncio
from datetime import date

import pytest
from test_hub import drain, make_hub

from jarvis import computer, voicetype
from jarvis import hub as hub_module
from jarvis.features import accessibility, accessibility_reading, accessibility_screen, check_work
from jarvis.features.accessibility_helper import NO_HELPER


@pytest.fixture(autouse=True)
def _no_windows_answer(monkeypatch):
    monkeypatch.setattr(accessibility.osplat, "screen_reader_running", lambda: None)


async def daredevil(settings, speaker, isolated, voice="reader", **prefs):
    """A hub in screen-reader mode, with the screen reader reading (or Jarvis's voice)."""
    hub = make_hub(settings, speaker, isolated=isolated)
    hub.set_feature_prefs({"a11y_mode": "on", "a11y_voice": voice, **prefs})
    return hub


def cards(hub, *answers):
    """Every card the hub puts up is answered by the next of answers; what each asked."""
    asked = []
    queue = list(answers)

    async def request_approval(question, detail="", choices=None, context=None, spoken=""):
        asked.append({"question": question, "detail": detail, "choices": choices})
        return queue.pop(0)

    hub.request_approval = request_approval
    return asked


# ── the note given to Claude ──


def test_the_note_asks_for_a_second_source_on_medicine_money_and_safety_and_says_how_much_to_read():
    note = accessibility.note_for("normal", "summary")
    assert "second source" in note and "Medicine" in note and "money" in note and "safety" in note
    assert "first say in two or three sentences" in note
    assert "read it in full" in accessibility.note_for("brief")


async def test_short_lines_go_to_the_screen_reader_or_to_jarvis_voice(
    settings, quiet_speaker, isolated
):
    hub = await daredevil(settings, quiet_speaker, isolated)
    q = hub.subscribe()
    hub.accessibility.say("Now in Word.")
    assert {"type": "a11y_say", "text": "Now in Word.", "important": False} in drain(q)
    pushed = []
    hub.speech.push = pushed.append
    quiet_speaker.muted = False
    hub.set_feature_prefs({"a11y_voice": "jarvis"})
    hub.accessibility.say("Now in Excel.")
    assert pushed == ["Now in Excel."]
    hub.set_feature_prefs({"a11y_mode": "off"})
    hub.accessibility.say("Now in Edge.")
    assert pushed == ["Now in Excel."] and not [
        e for e in drain(q) if e["type"] == "a11y_say" and "Edge" in e["text"]
    ]


# ── long reading ──


class FakeSpeaking:
    def __init__(self):
        self.held, self.applied = None, []

    async def apply(self, refresh=True):
        self.applied.append(self.held)
        return False

    def speed(self):
        return 100


async def test_long_text_from_a_reading_tool_is_read_at_the_reading_speed_until_the_turn_ends(
    settings, quiet_speaker, isolated
):
    hub = await daredevil(settings, quiet_speaker, isolated, voice="jarvis", a11y_read_speed=180)
    speaking = hub.voice_feature.speaking = FakeSpeaking()
    reading = hub.a11y_reading
    short = {
        "tool_name": "mcp__mail__read_email",
        "tool_response": {"content": [{"type": "text", "text": "Hi."}]},
    }
    await reading._after(short, None, None)
    assert speaking.held is None  # an answer, not reading
    long = {
        "tool_name": "mcp__mail__read_email",
        "tool_response": [{"type": "text", "text": "x" * 2000}],
    }
    await reading._after({**long, "tool_name": "mcp__mail__send_email"}, None, None)
    assert speaking.held is None  # not a reading tool
    await reading._after(long, None, None)
    assert speaking.held == 180 and speaking.applied == [180]
    hub.emit("turn_done", rid="r1")
    await asyncio.sleep(0.05)
    assert speaking.held is None and speaking.applied == [180, None]
    assert hub.prefs.feature("voice_speed") == 100  # never saved as the speaking speed
    # The screen reader reads the replies: its own speed, nothing switched.
    hub.set_feature_prefs({"a11y_voice": "reader"})
    await reading._after(long, None, None)
    assert speaking.held is None


async def test_the_reading_speed_is_set_by_voice(settings, quiet_speaker, isolated):
    hub = await daredevil(settings, quiet_speaker, isolated)
    reply = await hub.a11y_reading.instant("reading speed 150 percent")
    assert hub.prefs.feature("a11y_read_speed") == 150 and "150 percent" in reply
    await hub.a11y_reading.instant("read documents at 300 percent")
    assert hub.prefs.feature("a11y_read_speed") == 250
    await hub.a11y_reading.instant("reading speed same as talking")
    assert hub.prefs.feature("a11y_read_speed") == 0
    assert await hub.a11y_reading.instant("talk faster") is None  # the voice feature's words


def test_result_length_reads_every_shape():
    assert accessibility_reading.result_length("abc") == 3
    assert accessibility_reading.result_length({"content": [{"type": "text", "text": "abcd"}]}) == 4
    assert accessibility_reading.result_length([{"text": "ab"}, {"text": "c"}]) == 3
    assert accessibility_reading.result_length(None) == 0


# ── the screen and the AI model ──

READ_WINDOW = {"tool_name": "mcp__computer__read_window", "tool_input": {}}


async def test_the_screen_goes_to_the_model_only_once_the_owner_says_so(
    settings, quiet_speaker, isolated
):
    hub = await daredevil(settings, quiet_speaker, isolated)
    guard = hub.screen_guard
    guard.front = lambda: {"app": "notepad.exe", "title": "Shopping list"}
    asked = cards(hub, "once", "deny")
    assert await guard._before(READ_WINDOW, None, None) == {}  # just this time
    assert len(asked) == 1 and asked[0]["question"] == accessibility_screen.ASK_QUESTION
    assert [c[0] for c in asked[0]["choices"]] == [
        "once",
        "always",
        "deny",
    ]  # (a plain "yes" is just this time)
    assert hub.prefs.feature("a11y_screen_share") == "ask"  # asked again next time
    denied = await guard._before(READ_WINDOW, None, None)
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert hub.prefs.feature("a11y_screen_share") == "off"
    assert (await guard._before(READ_WINDOW, None, None))["hookSpecificOutput"][
        "permissionDecision"
    ] == "deny"
    assert len(asked) == 2  # "no" is kept: not asked again
    assert not guard.shared_without_asking()  # and no picture goes with a question either
    assert hub._screen_shared() is False
    # Not a screen tool: nothing asked.
    assert await guard._before({"tool_name": "mcp__mail__read_email"}, None, None) == {}


async def test_yes_from_now_on_is_kept_and_each_read_says_it_was_sent(
    settings, quiet_speaker, isolated
):
    hub = await daredevil(settings, quiet_speaker, isolated)
    guard = hub.screen_guard
    guard.front = lambda: {"app": "OUTLOOK.EXE", "title": "Inbox - ann@example.com"}
    asked = cards(hub, "always")
    q = hub.subscribe()
    assert await guard._before(READ_WINDOW, None, None) == {}
    assert hub.prefs.feature("a11y_screen_share") == "on" and guard.shared_without_asking()
    await guard._after(READ_WINDOW, None, None)
    said = [(e["text"], e["important"]) for e in drain(q) if e["type"] == "a11y_say"]
    assert said == [(accessibility_screen.PRIVATE_NOTICE, True), (accessibility_screen.SENT, False)]
    assert await guard._before(READ_WINDOW, None, None) == {} and len(asked) == 1


async def test_by_voice_and_with_the_mode_off(settings, quiet_speaker, isolated):
    hub = await daredevil(settings, quiet_speaker, isolated)
    assert "won't be sent" in await hub.screen_guard.instant("stop sharing my screen")
    assert hub.prefs.feature("a11y_screen_share") == "off"
    assert "goes to Claude" in await hub.screen_guard.instant("share my screen with Claude")
    assert hub.prefs.feature("a11y_screen_share") == "on"
    hub.set_feature_prefs({"a11y_mode": "off", "a11y_screen_share": "off"})
    assert await hub.screen_guard.allowed() and hub._screen_shared()  # the plain app: as before


@pytest.mark.parametrize(
    "front, private",
    [
        ({"app": "chrome.exe", "title": "Chase Online Banking - Accounts"}, True),
        ({"app": "msedge.exe", "title": "MyChart - Lab results"}, True),
        ({"app": "OUTLOOK.EXE", "title": "Inbox"}, True),
        ({"app": "WINWORD.EXE", "title": "Lecture notes.docx"}, False),
        ({"app": "notepad.exe", "title": "Otherwise fine"}, False),
    ],
)
def test_which_windows_look_private(front, private):
    assert accessibility_screen.looks_private(front) is private


async def test_where_the_focus_went_is_said_after_an_action_that_changes_it(
    settings, quiet_speaker, isolated
):
    hub = await daredevil(settings, quiet_speaker, isolated)
    guard = hub.screen_guard
    front = {"app": "WINWORD.EXE", "title": "Lecture notes.docx - Word"}
    guard.front = lambda: dict(front)
    q = hub.subscribe()
    await guard._after({"tool_name": "mcp__computer__focus_window"}, None, None)
    await guard._after(
        {"tool_name": "mcp__computer__press_keys"}, None, None
    )  # still there: nothing
    front.update(app="msedge.exe", title="Course page")
    hub.emit("tool", id="mac-r2", label="Controlled the Mac", status="done", at="")
    await asyncio.sleep(0.05)
    await guard._after({"tool_name": "mcp__mail__read_email"}, None, None)  # changes nothing
    said = [e["text"] for e in drain(q) if e["type"] == "a11y_say"]
    assert said == ["Now in Lecture notes.docx - Word.", "Now in Edge: Course page."]
    hub.set_feature_prefs({"a11y_say_focus": False})
    front.update(title="Elsewhere")
    await guard.focus_moved()
    assert not [e for e in drain(q) if e["type"] == "a11y_say"]


# ── check my work ──

TODAY = date(2026, 10, 8)  # a Thursday


def test_check_finds_what_a_reader_would_miss():
    problems, numbers = check_work.findings(
        "Hi Bob,\n\nPlease see the attached report. We meet on Monday 14 October at 3 pm, "
        "for three (4) hours. The the budget is $1,200.",
        subject="",
        to=["Ann Lee <ann@example.com>", "carl@example"],
        email=True,
        today=TODAY,
    )
    text = " ".join(problems)
    assert "The subject is empty." in problems
    assert "nothing is attached" in text
    assert "Wednesday, not a Monday" in text  # 14 October 2026
    assert "three (4)" in text and "“The the”" in text
    assert "carl@example" in text and "Bob isn't among the recipients" in text
    assert "$1,200" in numbers and "3 pm" in numbers


def test_a_clean_draft_has_nothing_mechanical_wrong():
    problems, _ = check_work.findings(
        "Dear Ann,\n\nThe report is attached. See you on Thursday, October 15, 2026.",
        subject="Report",
        to=["Ann Lee <ann@example.com>"],
        attachments=["report.pdf"],
        email=True,
        today=TODAY,
    )
    assert problems == []
    assert check_work.date_problems("Friday 31 February", TODAY) == [
        "“Friday 31 February” is not a real date."
    ]
    assert check_work.date_problems("Thursday 2026-10-08", TODAY) == []


def test_an_email_being_written_is_read_off_the_window():
    outline = "\n".join(
        [
            "edit: To, contains “ann@example.com; Bob <bob@example.com>”",
            "edit: Cc, contains “carl@example.com”",
            "edit: Subject, contains “Notes for Monday”",
            "  list item: lecture-3.pdf",
            "document: Message, contains “Hi Ann, notes attached.”",
        ]
    )
    parsed = check_work.parse_window(outline)
    assert parsed == {
        "to": ["ann@example.com", "Bob <bob@example.com>"],
        "cc": ["carl@example.com"],
        "subject": "Notes for Monday",
        "attachments": ["lecture-3.pdf"],
    }


async def test_check_my_work_gives_claude_the_text_and_the_findings(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.check_work.today = lambda: TODAY
    out = await hub.check_work.check(
        {"text": "As attached.", "to": ["ann@example.com"], "subject": "Hi"}
    )
    text = out["content"][0]["text"]
    assert "As attached." in text and "nothing is attached" in text and "check the spelling" in text
    if not hub_module.osplat.IS_WIN:
        out = await hub.check_work.check({"source": "field"})
        assert out.get("is_error") and "PC" in out["content"][0]["text"]


# ── the trusted person ──


async def helper_hub(settings, speaker, isolated, answers=(), **prefs):
    hub = await daredevil(settings, speaker, isolated, **prefs)
    gates, sent = [], []

    async def send_gate(question, detail, spoken="", choices=("Send", "Don't send")):
        gates.append({"question": question, "detail": detail, "spoken": spoken, "choices": choices})
        return answers[len(gates) - 1]

    async def send(subject, body, files):
        sent.append({"subject": subject, "body": body, "files": [f.name for f in files]})
        return "sent"

    hub.send_gate = send_gate
    hub.a11y_helper.send = send
    return hub, gates, sent


async def test_send_this_to_my_helper_shows_a_card_and_a_picture_goes_only_when_asked_for(
    settings, quiet_speaker, isolated
):
    hub, gates, sent = await helper_hub(
        settings, quiet_speaker, isolated, answers=(True, True),
        a11y_helper_name="Ann Lee", a11y_helper_email="ann@example.com",
    )  # fmt: skip
    hub.prefs.owner_name = "Robert"
    helper = hub.a11y_helper
    hub._turn_text = "send this to my helper"
    out = await helper.send_to_helper(
        {"about": "Word says the file is read-only.", "picture": True}
    )
    assert out.get("is_error") and "own words" in out["content"][0]["text"] and not gates
    out = await helper.send_to_helper({"about": "Word says the file is read-only."})
    assert out["content"][0]["text"] == "Emailed Ann Lee."
    assert (
        gates[0]["question"] == "Email Ann Lee for help?"
        and "ann@example.com" in gates[0]["detail"]
    )
    assert "Word says the file is read-only." in gates[0]["spoken"]
    assert sent[0]["subject"] == "Robert would like your help" and sent[0]["files"] == []

    class Frame:
        def image(self):
            return {"media_type": "image/jpeg", "data": "aGk="}

    async def latest(_age=0):
        return Frame()

    hub.screen_watch.latest = latest
    hub._turn_text = "send a screenshot to my helper"
    out = await helper.send_to_helper({"about": "This dialog.", "picture": True})
    assert "with a picture" in out["content"][0]["text"] and sent[1]["files"] == ["screen.jpg"]
    assert "With a picture of your screen." in gates[1]["detail"]
    assert not (hub.feature_path("helper") / "screen.jpg").exists()  # deleted once sent


async def test_a_no_on_the_card_sends_nothing(settings, quiet_speaker, isolated):
    hub, gates, sent = await helper_hub(
        settings, quiet_speaker, isolated, answers=(False,), a11y_helper_email="ann@example.com"
    )
    out = await hub.a11y_helper.send_to_helper({"about": "Help."})
    assert out.get("is_error") and sent == [] and len(gates) == 1


async def test_i_need_help_says_how_to_reach_the_helper_and_offers_an_email(
    settings, quiet_speaker, isolated
):
    hub, gates, sent = await helper_hub(
        settings, quiet_speaker, isolated, answers=(True, False),
        a11y_helper_name="Ann Lee", a11y_helper_email="ann@example.com", a11y_helper_phone="+1 555 0100",
    )  # fmt: skip
    reply = await hub.a11y_helper.instant("I need help")
    assert reply == "Emailed Ann to ask them to get in touch."
    assert "phone +1 555 0100 or email ann@example.com" in gates[0]["spoken"]
    assert gates[0]["choices"] == ("Email Ann", "Not now") and len(sent) == 1
    reply = await hub.a11y_helper.instant("I need a human")
    assert "phone +1 555 0100" in reply and "I didn't email them" in reply and len(sent) == 1
    assert await hub.a11y_helper.instant("I need help with my essay") is None  # Claude's


async def test_without_a_helper_set_up(settings, quiet_speaker, isolated):
    hub, _gates, _sent = await helper_hub(settings, quiet_speaker, isolated)
    assert await hub.a11y_helper.instant("I need help") == NO_HELPER
    hub.set_feature_prefs({"a11y_mode": "off"})
    assert await hub.a11y_helper.instant("I need help") is None  # the plain app: Claude answers
    hub.set_feature_prefs({"a11y_helper_email": "not an address"})
    assert hub.prefs.feature("a11y_helper_email") == ""


# ── the first-run setup, by voice ──


async def test_the_setup_by_voice(settings, quiet_speaker, isolated):
    hub = await daredevil(settings, quiet_speaker, isolated)
    setup = hub.a11y_setup
    q = hub.subscribe()
    assert await setup.instant("next") is None  # not open: not the setup's
    assert await setup.instant("run setup again") == "Opening the setup."
    assert {"type": "a11y_setup_cmd", "action": "open"} in drain(q)
    await hub.handle({"type": "a11y_setup", "open": True, "step": "look"})
    assert await setup.instant("Next.") == ""
    assert await setup.instant("skip setup") == ""
    assert [e["action"] for e in drain(q) if e["type"] == "a11y_setup_cmd"] == ["next", "finish"]
    assert await setup.instant("yellow on blue") == "Colours: yellow on blue."
    assert hub.prefs.feature("a11y_colors") == "yellow-blue"
    assert await setup.instant("larger text") == "Text size: larger."
    assert await setup.instant("my screen reader") == "Your screen reader reads the replies."
    assert hub.prefs.feature("a11y_voice") == "reader"
    assert await setup.instant("talk faster") is None  # the voice feature's own
    assert hub.prefs.feature("a11y_setup_done") is False
    await hub.handle({"type": "a11y_setup", "open": False, "done": True})
    assert hub.prefs.feature("a11y_setup_done") is True and not setup.is_open()
    assert await setup.instant("next") is None


async def test_the_setup_is_answered_without_claude(settings, quiet_speaker, isolated):
    hub = await daredevil(settings, quiet_speaker, isolated)
    await hub.start()
    await hub.ask("run setup again")
    assert hub.client is None or hub.client.queries == []


# ── voice typing, read back ──


def test_read_back_is_a_command_and_an_edit_and_keeps_what_was_typed():
    assert voicetype.command("read that back") == ("readback", "")
    assert voicetype.command("read the last line") == ("lastline", "")
    assert voicetype.edit("Read it back.") == "readback"
    assert voicetype.read_back_request("read me the last line") == "lastline"
    assert voicetype.read_back_request("read me the news") is None
    typing = voicetype.VoiceTyping()
    typing.start()
    typing.did_type(typing.chunk("Dear Pepper,"))
    typing.did_break()
    typing.did_type(typing.chunk("The suit is ready."))
    typing.did_type(typing.chunk("Wrong words."))
    typing.scratch()
    assert typing.read_back() == "Dear Pepper,\nThe suit is ready."
    assert typing.read_back("lastline") == "The suit is ready."
    typing.stop()
    assert typing.read_back("lastline") == "The suit is ready."  # kept after it stops
    typing.start()
    assert typing.read_back() == ""


async def test_read_that_back_while_typing_is_said_and_never_typed(
    settings, quiet_speaker, isolated, monkeypatch
):
    posted = []
    monkeypatch.setattr(computer, "_post_text", lambda text: posted.append(("text", text)))
    monkeypatch.setattr(computer, "_post_keys", lambda combo: posted.append(("keys", combo)))
    monkeypatch.setattr(hub_module.subprocess, "Popen", lambda *a, **k: None)
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub.on_heard("Jarvis, start typing")
    await hub.on_heard("See you at eight.")
    await hub.on_heard("read that back")
    await hub.on_heard("stop typing")
    await hub.on_heard("Jarvis, read the last line")
    assert posted == [("text", "See you at eight.")]
    captions = [e["text"] for e in drain(q) if e["type"] == "caption"]
    assert captions == ["You typed: See you at eight.", "The last line: See you at eight."]
    hub.voice_typing.start()
    assert hub.read_typed_back() == "Nothing has been typed by voice yet."


# ── voice ID, set up by voice ──


async def test_voice_id_is_set_up_by_voice_with_each_step_said(settings, quiet_speaker, isolated):
    import numpy as np

    from jarvis import voiceprint
    from jarvis.features import voice_id

    rng = np.random.default_rng(3)
    owner = np.eye(64, dtype=np.float32)[0]

    def embedder(_audio):
        return voiceprint.unit(owner + 0.1 * rng.standard_normal(64).astype(np.float32))

    clips = [np.full(int(voiceprint.SAMPLE_RATE * 1.5), 0.01, dtype=np.float32) for _ in range(4)]
    clips.insert(1, None)  # one it didn't hear

    hub = make_hub(settings, quiet_speaker, recorder=lambda *_: clips.pop(0), isolated=isolated)
    guard = voice_id.guard_for(hub)
    guard.reader_wait = lambda _text: 0
    q = hub.subscribe()
    reply = await guard.instant("learn my voice")
    assert hub.prefs.feature("voice_id_on") is True
    assert "voice model" in reply  # none here yet: said what's needed first
    guard.model_path.parent.mkdir(parents=True, exist_ok=True)
    guard.model_path.write_bytes(b"fake")
    guard.embedder_factory = lambda _path: embedder
    clips.append(np.full(int(voiceprint.SAMPLE_RATE * 1.5), 0.01, dtype=np.float32))
    assert await guard.instant("Learn my voice.") == ""
    for _ in range(200):
        await asyncio.sleep(0.01)
        if guard.enrolling is None and guard.print is not None:
            break
    said = [e["text"] for e in drain(q) if e["type"] == "caption"]
    assert (
        said[0].startswith("Let's learn your voice.")
        and "Sentence 1 of 5. Say after me: The quick brown fox" in said[0]
    )
    assert said[1].startswith("Got it. Sentence 2 of 5.")
    assert said[2].startswith("I didn't catch that. Once more. Say after me: Jarvis,")
    assert said[-1] == "Done. I know your voice now."
    assert guard.print is not None and guard.print.clips == 5
    assert await guard.instant("stop learning my voice") == "I'm not learning your voice just now."
