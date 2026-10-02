"""Voice typing with hands-free: "Jarvis, start typing", and what the owner says is typed
where the keyboard focus is until "stop typing"; "Jarvis, type <words>" types one line.
Nothing is asked of Claude, and no key or mouse event leaves the test (computer's posting
functions are replaced)."""

import pytest
from test_hub import drain, make_hub

from jarvis import computer, voicetype
from jarvis import hub as hub_module


@pytest.mark.parametrize(
    "said, expected",
    [
        ("start typing", ("start", "")),
        ("Start typing.", ("start", "")),
        ("turn on voice typing", ("start", "")),
        ("dictation mode", ("start", "")),
        ("talk to type", ("start", "")),
        ("type for me", ("start", "")),
        ("stop typing", ("stop", "")),
        ("done typing", ("stop", "")),
        ("voice typing off", ("stop", "")),
        ("type see you at eight", ("once", "see you at eight")),
        ("Type: on my way", ("once", "on my way")),
        ("开始打字", ("start", "")),
        ("停止打字", ("stop", "")),
        ("输入 我马上到", ("once", "我马上到")),
        ("write an email to Pepper", None),  # a request for JARVIS, not words to type
        ("what's the weather", None),
        ("type", None),
    ],
)
def test_the_commands(said, expected):
    assert voicetype.command(said) == expected


def test_what_ends_it_without_the_wake_word():
    assert voicetype.ends("stop typing.")
    assert voicetype.ends("Stop")
    assert not voicetype.ends("please stop by the store")
    assert not voicetype.ends("I need to stop typing so much")


def test_spoken_edits():
    assert voicetype.edit("New line.") == "line"
    assert voicetype.edit("new paragraph") == "paragraph"
    assert voicetype.edit("scratch that") == "scratch"
    assert voicetype.edit("press enter") == "enter"
    assert voicetype.edit("the new line of products") is None


def test_phrases_are_spaced_like_writing():
    typing = voicetype.VoiceTyping()
    typing.start()
    first = typing.chunk("Hello Pepper.")
    assert first == "Hello Pepper."
    typing.did_type(first)
    assert typing.chunk("The suit is ready.") == " The suit is ready."
    assert typing.chunk(", and the jet") == ", and the jet"
    typing.did_break()
    assert typing.chunk("Next line.") == "Next line."
    typing.did_type("你好")
    assert typing.chunk("世界") == "世界"
    assert typing.scratch() == 2
    assert typing.scratch() == len(first)
    assert typing.scratch() == 0


@pytest.fixture
def keyboard(monkeypatch):
    posted = []
    monkeypatch.setattr(computer, "_post_text", lambda text: posted.append(("text", text)))
    monkeypatch.setattr(computer, "_post_keys", lambda combo: posted.append(("keys", combo)))
    monkeypatch.setattr(hub_module.subprocess, "Popen", lambda *a, **k: None)  # no chime
    return posted


async def test_start_typing_types_what_is_said_until_stop(
    settings, quiet_speaker, isolated, keyboard
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub.on_heard("Jarvis, start typing")
    assert hub.voice_typing.on
    await hub.on_heard("Dear Pepper,")
    await hub.on_heard("new line")
    await hub.on_heard("The suit is ready.")
    await hub.on_heard("scratch that")
    await hub.on_heard("The jet is fuelled.")
    await hub.on_heard("stop typing")
    assert not hub.voice_typing.on
    await hub.on_heard("this is not typed")
    assert keyboard == [
        ("text", "Dear Pepper,"),
        ("keys", "shift+return"),
        ("text", "The suit is ready."),
        *[("keys", "delete")] * len("The suit is ready."),
        ("text", "The jet is fuelled."),
    ]
    events = drain(q)
    assert {"type": "voice_typing", "on": True} in events
    assert {"type": "voice_typing", "on": False} in events
    assert hub.client is None or hub.client.queries == []  # nothing went to Claude


async def test_jarvis_stop_ends_typing_too(settings, quiet_speaker, isolated, keyboard):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    await hub.set_voice_typing(True)
    await hub.on_heard("Jarvis, stop")
    assert not hub.voice_typing.on
    assert keyboard == []


async def test_type_once_types_one_line(settings, quiet_speaker, isolated, keyboard):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    await hub.on_heard("Jarvis, type on my way")
    assert keyboard == [("text", "on my way")]
    assert not hub.voice_typing.on


async def test_the_window_turns_it_off(settings, quiet_speaker, isolated, keyboard):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    await hub.set_voice_typing(True)
    q = hub.subscribe()
    await hub.handle({"type": "voice_typing", "on": False})
    assert not hub.voice_typing.on
    assert {"type": "voice_typing", "on": False} in drain(q)


async def test_no_accessibility_says_so_and_stops(settings, quiet_speaker, isolated, monkeypatch):
    monkeypatch.setattr(hub_module.subprocess, "Popen", lambda *a, **k: None)

    def refused(_text):
        raise RuntimeError("not trusted")

    monkeypatch.setattr(computer, "_post_text", refused)
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    await hub.set_voice_typing(True)
    q = hub.subscribe()
    await hub.on_heard("hello there")
    events = drain(q)
    assert any(e["type"] == "notice" and "Accessibility" in e["text"] for e in events)
    assert not hub.voice_typing.on
