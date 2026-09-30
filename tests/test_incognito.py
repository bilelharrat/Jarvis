"""What makes a conversation incognito (jarvis.incognito): the connection's options, and the
words that go in and out of it (whole commands only, in English and Chinese)."""

from types import SimpleNamespace

from jarvis import incognito


def options(**changes):
    base = {
        "extra_args": {"debug-to-stderr": None},
        "disallowed_tools": ["Bash"],
        "system_prompt": "You are Jarvis.",
        "resume": None,
    }
    return SimpleNamespace(**{**base, **changes})


def test_an_incognito_connection_keeps_no_record_and_cant_remember():
    made = options()
    assert incognito.apply(made) is False
    assert made.extra_args == {"debug-to-stderr": None, "no-session-persistence": None}
    assert made.disallowed_tools == ["Bash", "mcp__memory__remember", "mcp__memory__forget"]
    assert made.system_prompt.startswith("You are Jarvis.") and "incognito" in made.system_prompt
    again = options(resume="abc", extra_args=None, disallowed_tools=None)
    assert incognito.apply(again) is True and again.resume is None  # nothing to carry on
    assert again.disallowed_tools == list(incognito.MEMORY_WRITES)
    incognito.apply(again)  # twice: said once
    assert again.system_prompt.count("incognito:") == 1
    assert again.disallowed_tools == list(incognito.MEMORY_WRITES)


def test_whole_commands_go_in_and_out():
    for text in [
        "go incognito",
        "Jarvis, go incognito.",
        "Okay, let's go incognito",
        "Turn on incognito mode please",
        "turn incognito on",
        "Switch to incognito",
        "Start an incognito conversation",
        "Can you start a new incognito chat?",
        "enter incognito mode",
        "incognito mode on",
    ]:
        assert incognito.asked(text, "en") is True, text
    for text in [
        "leave incognito",
        "Exit incognito mode.",
        "end the incognito conversation",
        "turn off incognito",
        "turn incognito mode off",
        "get out of incognito mode",
        "Jarvis, stop incognito",
        "incognito off",
    ]:
        assert incognito.asked(text, "en") is False, text
    for text in [
        "What does incognito mode do in Safari?",
        "Open an incognito window",
        "go incognito and search for flights",
        "I went incognito yesterday",
        "incognito",
    ]:
        assert incognito.asked(text, "en") is None, text


def test_chinese_commands_when_its_spoken():
    for text in ["开启无痕模式", "好的，进入无痕模式吧", "开始一段无痕对话", "打开无痕"]:
        assert incognito.asked(text, "zh") is True, text
        assert incognito.asked(text, "en") is None, text
    for text in ["退出无痕模式", "关闭无痕", "结束无痕对话。", "離開無痕模式"]:
        assert incognito.asked(text, "zh") is False, text
    for text in ["无痕模式是什么？", "Safari 的无痕浏览怎么开"]:
        assert incognito.asked(text, "zh") is None, text
    assert incognito.asked("Go incognito", "zh") is True  # English words work in Chinese too
