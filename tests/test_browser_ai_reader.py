"""Reader mode's reading aloud: the article read in JARVIS's voice a paragraph at a time
through the speech queue, with pause, resume, skip, back and again, giving way to a new
request or a "stop"; the words for it in both languages."""

import asyncio

import pytest
from test_hub import make_hub

from jarvis.features import browser_ai
from jarvis.features.browser_ai.reader import Reader, clean_blocks, parse


@pytest.mark.parametrize(
    ("text", "action"),
    [
        ("read this to me", "listen"),
        ("Jarvis, read the article aloud", "listen"),
        ("reader mode", "open"),
        ("open the reader", "open"),
        ("pause", "pause"),
        ("stop reading", "pause"),
        ("continue reading", "resume"),
        ("resume", "resume"),
        ("skip", "skip"),
        ("next paragraph", "skip"),
        ("previous paragraph", "back"),
        ("read that again", "again"),
        ("把这篇文章读给我听", "listen"),
        ("朗读这篇文章", "listen"),
        ("阅读模式", "open"),
        ("暂停", "pause"),
        ("继续读", "resume"),
        ("下一段", "skip"),
        ("上一段", "back"),
        ("再读一遍", "again"),
    ],
)
def test_the_words_for_reading_in_both_languages(text, action):
    language = "zh" if any("一" <= c <= "鿿" for c in text) else "en"
    assert parse(text, language) == action, text


@pytest.mark.parametrize(
    "text", ["read my email", "what does this say", "pause the music playlist", "明天读报告"]
)
def test_other_words_are_left_alone(text):
    language = "zh" if any("一" <= c <= "鿿" for c in text) else "en"
    assert parse(text, language) is None


def test_code_is_never_read_and_the_article_is_bounded():
    blocks = [
        {"kind": "h", "text": "How to start"},
        {"kind": "p", "text": "  Begin   with an onion.  "},
        {"kind": "pre", "text": "print('never read aloud')"},
        {"kind": "li", "text": "Season at the end."},
        {"kind": "script", "text": "x"},
        "junk",
        {"kind": "p", "text": ""},
    ]
    assert clean_blocks(blocks) == ["How to start", "Begin with an onion.", "Season at the end."]
    assert clean_blocks("not a list") == []
    many = [{"kind": "p", "text": "w" * 5000}] * 500
    kept = clean_blocks(many)
    assert all(len(t) == 4000 for t in kept) and sum(map(len, kept)) <= 150_000 + 4000


# ── the reading, with a speech queue and hub that only record ──


class Speech:
    def __init__(self):
        self.pushed = []
        self.cleared = 0
        self.idle = asyncio.Event()
        self.idle.set()
        self.hold = False  # a paragraph plays until let go

    def push(self, text):
        self.pushed.append(text)
        if self.hold:
            self.idle.clear()

    async def drain(self):
        await self.idle.wait()

    def clear(self):
        self.cleared += 1
        self.idle.set()


class Hub:
    language = "en"

    def __init__(self):
        self.speech = Speech()
        self.speaker = type("Speaker", (), {"muted": False})()
        self.events = []
        self._stops = 0

    def emit(self, kind, **data):
        self.events.append((kind, data))

    def _spawn(self, coro):
        return asyncio.get_running_loop().create_task(coro)

    def states(self):
        return [(d["state"], d["at"]) for k, d in self.events if k == "browser_ai_reading"]


BLOCKS = ["First paragraph. It has two sentences.", "Second one.", "Third and last."]


async def settle():
    for _ in range(20):
        await asyncio.sleep(0)


async def test_it_reads_each_paragraph_in_order_then_stops():
    hub = Hub()
    reader = Reader(hub, None, None)
    reader.start(list(BLOCKS), title="Soup", url="https://news.example/soup")
    await settle()
    assert hub.speech.pushed == [
        "First paragraph.",
        "It has two sentences.",
        "Second one.",
        "Third and last.",
    ]
    assert hub.states() == [("playing", 0), ("playing", 1), ("playing", 2), ("idle", 3)]
    assert reader.state == "idle"


async def test_pause_resume_skip_back_and_again():
    hub = Hub()
    hub.speech.hold = True
    reader = Reader(hub, None, None)
    reader.start(list(BLOCKS))
    await settle()
    assert reader.act("pause") and reader.state == "paused" and reader.at == 0
    assert hub.speech.cleared == 1  # the paragraph playing stops there
    hub.speech.pushed.clear()
    assert reader.act("resume") and reader.state == "playing"
    await settle()
    assert hub.speech.pushed[0] == "First paragraph."  # from the paragraph it was on
    assert reader.act("skip") and reader.at == 1
    await settle()
    assert hub.speech.pushed[-1] == "Second one."
    assert reader.act("again") and reader.at == 1
    assert reader.act("back") and reader.at == 0
    reader.act("pause")
    cleared = hub.speech.cleared
    reader.act("skip")  # paused: it moves on and plays, and the queue isn't its to clear
    assert hub.speech.cleared == cleared and reader.state == "playing" and reader.at == 1
    assert reader.act("stop") and reader.state == "idle" and reader.blocks == []
    assert not reader.act("resume")  # nothing to read


async def test_it_gives_way_to_a_new_request_and_to_stop():
    hub = Hub()
    hub.speech.hold = True
    reader = Reader(hub, None, None)
    reader.start(list(BLOCKS))
    await settle()
    reader.on_turn({"type": "turn"})
    assert reader.state == "paused" and reader.at == 0
    reader.act("resume")
    await settle()
    hub._stops += 1  # the owner said stop: hub.stop() cleared the speech
    hub.speech.idle.set()
    await settle()
    assert reader.state == "paused" and reader.at == 0


async def test_with_the_voice_muted_nothing_is_read():
    hub = Hub()
    hub.speaker.muted = True
    reader = Reader(hub, None, None)
    reader.start(list(BLOCKS))
    await settle()
    assert hub.speech.pushed == [] and reader.state == "paused"
    assert hub.events[-1][1]["muted"] is True  # the window says the voice is off


# ── the window and the voice, on the real hub ──


async def test_the_window_starts_it_and_a_request_pauses_it(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk = browser_ai.desk_for(hub)
    speech = Speech()
    speech.hold = True
    hub.speech = speech  # (so nothing is played: the voice can be on)
    hub.speaker.muted = False
    q = hub.subscribe()
    await hub._handle(
        {"type": "browser_ai_read", "action": "start", "at": 1, "title": "Soup",
         "url": "https://news.example/soup", "blocks": [{"kind": "p", "text": t} for t in BLOCKS]}
    )  # fmt: skip
    await settle()
    assert desk.reader.state == "playing" and speech.pushed == ["Second one."]
    hub.emit("turn", rid="r1", user="what's the weather")  # a request begins
    assert desk.reader.state == "paused"
    events = []
    while not q.empty():
        events.append(q.get_nowait())
    reading = [e for e in events if e["type"] == "browser_ai_reading"]
    assert (
        reading[0]["state"] == "playing"
        and reading[0]["title"] == "Soup"
        and reading[-1]["state"] == "paused"
    )
    await hub._handle({"type": "browser_ai_read", "action": "stop"})
    assert desk.reader.state == "idle"


async def test_said_on_a_page_it_opens_the_reader_and_reads(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk = browser_ai.desk_for(hub)
    calls = []

    async def call(action, args=None, timeout=None):
        calls.append((action, dict(args or {})))
        if action == "front":
            return {"ok": True, "focused": True, "shown": True}
        return {"ok": True}

    desk.bridge.call = call
    desk.page.on_page({"open": True, "url": "https://news.example/soup", "tab": 3})
    assert await desk.reader.instant("read this to me") == ""
    assert calls[-1] == ("page_ui", {"op": "reader", "listen": True})
    assert await desk.reader.instant("reader mode") == ""
    assert calls[-1] == ("page_ui", {"op": "reader", "listen": False})
    # Nothing being read: "pause" is someone else's (the music, say).
    assert await desk.reader.instant("pause") is None
    desk.page.on_page({"open": False, "url": "https://news.example/soup", "tab": 3})
    assert await desk.reader.instant("read this to me") is None
