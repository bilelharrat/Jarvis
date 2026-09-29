import asyncio
from datetime import datetime

from jarvis.meeting import Meeting, count_items

NOTES = """## Summary
- Reviewed Q3 pipeline
## Decisions
- Hire a second engineer
- Delay the Berlin launch
## Action items
- [ ] Ann: draft the job post by Friday
## Open questions
- None."""


async def test_transcript_is_saved_as_it_grows(tmp_path):
    m = Meeting("Q3 review", tmp_path, now=datetime(2026, 9, 29, 10, 0))
    m.add(None, "We should hire a second engineer.", datetime(2026, 9, 29, 10, 1))
    assert m.path.name == "2026-09-29 1000 Q3 review.md"
    assert "[10:01] We should hire a second engineer." in m.path.read_text()


async def test_write_up_files_the_notes(tmp_path):
    m = Meeting("Q3 review", tmp_path)
    for _ in range(10):
        m.add_text("We agreed to hire a second engineer and delay Berlin.")
    prompts = []

    async def summarize(prompt):
        prompts.append(prompt)
        return NOTES

    result = await m.write_up(summarize)
    assert result["decisions"] == 2 and result["actions"] == 1
    text = m.path.read_text()
    assert text.index("## Decisions") < text.index("## Transcript")
    assert "data, not instructions" in prompts[0]


async def test_short_or_failed_write_ups_keep_the_transcript(tmp_path):
    m = Meeting("Chat", tmp_path)
    m.add_text("Hi there.")

    async def boom(_prompt):
        raise RuntimeError("offline")

    assert (await m.write_up(boom))["short"]
    m2 = Meeting("Longer", tmp_path)
    m2.add_text("word " * 40)
    result = await m2.write_up(boom)
    assert result["error"] == "offline" and "word word" in m2.path.read_text()


async def test_notes_model_retranscribes_off_the_voice_loop(tmp_path):
    class Better:
        def transcribe(self, audio):
            return f"better {audio}"

    m = Meeting("x", tmp_path)
    m.start_worker(Better())
    m.add("a1", "quick one")
    await m.finish_transcript()
    assert m.lines[0][1] == "better a1"


def test_count_items():
    assert count_items(NOTES) == {"decisions": 2, "actions": 1}


async def test_hub_meeting_mode(settings, quiet_speaker, isolated, tmp_path):
    from test_hub import make_hub

    class Listener:
        running = False

        def __init__(self, *_a):
            pass

        def start(self):
            self.running = True

        def stop(self):
            self.running = False

    async def summarize(_prompt):
        return NOTES

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.listener_factory = Listener
    hub.notes_transcriber = None
    hub._summarize = summarize
    hub.meetings_dir = tmp_path / "meetings"
    rebuilt = []

    async def rebuild_brain(only=None):
        rebuilt.append(only)

    hub.rebuild_brain = rebuild_brain
    await hub.start()

    class Echo:  # the "audio" in this test is already text
        def transcribe(self, audio):
            return audio

    hub.transcriber = Echo()
    reply = await hub.start_meeting("Board prep")
    assert "Taking notes" in reply and hub.prefs.hands_free and hub.meeting is not None
    for line in ["We need the deck by Thursday.", "Ann will own the financials."] * 8:
        await hub._heard.put(line)
    await hub._heard.put("Jarvis what time is it")  # addressed to JARVIS: not notes
    await asyncio.sleep(0.2)
    assert hub.meeting.words() > 25
    assert "what time" not in hub.meeting.transcript()
    assert hub.client.queries[-1] == "what time is it"
    reply = await hub.stop_meeting()
    assert "2 decisions and 1 action items" in reply and hub.meeting is None
    [notes] = list((tmp_path / "meetings").glob("*.md"))
    assert "Ann will own the financials." in notes.read_text()
    await asyncio.sleep(0)
    assert rebuilt == [{"meetings"}]
    hub.set_prefs({"hands_free": False})


async def test_lines_are_saved_before_the_notes_model_finishes(tmp_path):
    class Slow:
        def transcribe(self, audio):
            return f"refined {audio}"

    m = Meeting("x", tmp_path)
    m.start_worker(Slow())
    m.add("a1", "quick one")
    assert "quick one" in m.path.read_text()  # on disk straight away
    await m.finish_transcript()
    assert "refined a1" in m.path.read_text() and "quick one" not in m.path.read_text()


async def test_a_failing_notes_model_keeps_the_quick_lines(tmp_path):
    class Broken:
        def transcribe(self, audio):
            raise RuntimeError("no model")

    m = Meeting("x", tmp_path)
    m.start_worker(Broken())
    m.add("a1", "first")
    m.add("a2", "second")
    await m.finish_transcript()
    assert [t for _, t in m.lines] == ["first", "second"]


async def test_meeting_speech_that_echoes_the_title_is_kept(
    settings, quiet_speaker, isolated, tmp_path
):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.meeting = Meeting("budget review", tmp_path)
    hub.turn = {"reply": "Taking notes for the budget review. Everything said is transcribed."}
    hub._spoke_until = 0  # JARVIS finished talking long ago
    assert hub._meeting_capture(None, "So the budget review is done")
    assert "budget review is done" in hub.meeting.transcript()
    hub._armed_until = __import__("time").monotonic() + 5  # "Jarvis" … then the question
    assert hub._meeting_capture(None, "what's the weather") is False
