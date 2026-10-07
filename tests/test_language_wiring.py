"""Chinese in the hub: the wake word, window commands and card answers in Mandarin; a
purchase still needs the deliberate phrase; switching the language changes the replies'
instructions and the voice."""

import asyncio

from test_hub import make_hub

PURCHASE = {
    "ask_kind": "purchase",
    "question": "Buy 2 tickets from Example Shop for $42.00?",
    "choices": [{"id": "allow", "label": "Confirm purchase"}, {"id": "deny", "label": "Cancel"}],
}


async def settle():
    for _ in range(30):
        await asyncio.sleep(0)


async def test_mandarin_wake_word_opens_the_settings(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.set_prefs({"language": "zh"})
    await settle()
    applied = []

    async def window_apply(command):
        applied.append((command.action, command.name))
        return {"ok": True}

    hub.window_apply = window_apply
    await hub.on_heard("贾维斯，打开设置")
    for _ in range(50):
        if applied:
            break
        await asyncio.sleep(0.01)
    assert applied == [("panel", "settings")]
    assert hub.client is None or hub.client.queries == []  # done at once, no Claude


async def test_a_purchase_needs_the_phrase_in_chinese_too(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.prefs.language = "zh"
    assert hub._voice_answer("确认购买", PURCHASE) == ("allow", "")
    assert hub._voice_answer("好的", PURCHASE)[0] not in ("allow",)
    assert hub._voice_answer("不要", PURCHASE) == ("deny", "")
    assert hub._voice_answer("confirm purchase", PURCHASE) == ("allow", "")


async def test_switching_to_chinese_changes_the_replies_and_the_voice(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    assert "Simplified Chinese" not in hub.client.options.system_prompt
    hub.set_prefs({"language": "zh"})
    await settle()
    await hub.reset()
    assert "Simplified Chinese" in hub.client.options.system_prompt
    assert hub.speaker.clean("3 files") != "3 files"  # numbers said in Chinese
    assert hub._filler_phrases()[0].endswith("。")
    assert hub._speakable("I need your OK on screen.") != "I need your OK on screen."
    hub.set_prefs({"language": "en"})
    await settle()
    assert hub.speaker.clean("3 files") == "3 files"
    assert hub._speakable("I need your OK on screen.") == "I need your OK on screen."


async def test_chinese_requests_count_for_the_ask_gates(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.prefs.language = "zh"
    asked = []

    async def ask_user(question):
        asked.append(question)
        return False

    hub._ask_user = ask_user
    hub._turn_text = "记住我的会议都在上午"
    assert await hub.feature_gate("remember", "Remember it?")
    assert asked == []


async def test_instant_replies_are_in_chinese_too(settings, quiet_speaker, isolated, monkeypatch):
    """A shortcut run at once, and a Research Center command that failed, answer in the
    language chosen, as the other instant commands do (they answered in English)."""
    from jarvis import home

    async def ran(*_args, **_kw):
        return ""

    monkeypatch.setattr(home.mac_tools, "run_command", ran)
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.prefs.language = "zh"
    hub.prefs.instant_shortcuts = ["电影模式"]
    assert await hub._instant_shortcut("r1", "电影模式")
    assert hub.turn["reply"] == "好了。"
    hub.research_available = True
    hub.research = {"open": True, "title": "Markets", "url": "u", "locked": True}
    sent = []

    def emit(kind, **data):
        sent.append((kind, data))
        if kind == "research_cmd":
            late = {"error": "The Research Center didn't answer in time."}
            hub._research_calls[data["id"]].set_result(late)

    hub.emit = emit
    assert await hub._instant_research("r2", "返回")
    assert ("reply", {"rid": "r2", "text": "研究中心没有及时响应。"}) in sent
