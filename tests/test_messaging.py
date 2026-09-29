from jarvis import messaging
from jarvis.messaging import build_tools, resolve

BEN = {
    "name": "Ben Ma",
    "phones": [
        {"label": "work", "value": "+1 415 555 0100"},
        {"label": "iPhone", "value": "+1 415 555 0199"},
    ],
    "emails": [{"label": "work", "value": "ben@example.com"}],
}


async def lookup_ben(query):
    return [BEN] if "ben" in query.lower() else []


async def test_resolve_prefers_the_iphone_and_handles_raw_handles():
    assert await resolve("Ben Ma", "imessage", lookup_ben) == ("Ben Ma", "+1 415 555 0199")
    assert await resolve("Ben", "email", lookup_ben) == ("Ben Ma", "ben@example.com")
    assert await resolve("+1 (415) 555-0123", "imessage", lookup_ben) == ("+1 (415) 555-0123",) * 2
    assert "no one called Zed" in await resolve("Zed", "imessage", lookup_ben)

    async def two(_q):
        return [BEN, {**BEN, "name": "Ben Stone"}]

    assert "Several people match" in await resolve("Ben", "imessage", two)


async def test_nothing_is_sent_without_a_yes():
    sent, asked = [], []
    answers = [False, True]

    async def approve(question, detail, spoken):
        asked.append((question, detail, spoken))
        return answers.pop(0)

    async def run(script, *args, **_kw):
        sent.append((script, args))
        return ""

    tools = {t.name: t.handler for t in build_tools(approve, lookup_ben, run)}
    out = await tools["send_message"]({"to": "Ben Ma", "text": "Running 5 late"})
    assert out["is_error"] and sent == []
    assert asked[0] == (
        "Send this to Ben Ma?",
        "To Ben Ma (+1 415 555 0199):\n“Running 5 late”",
        "Here's your message to Ben Ma. Running 5 late. Do you want this message sent?",
    )
    out = await tools["send_message"]({"to": "Ben Ma", "text": "Running 5 late"})
    assert out["content"][0]["text"] == "Sent to Ben Ma."
    assert sent == [(messaging.SEND_IMESSAGE_SCRIPT, ("+1 415 555 0199", "Running 5 late"))]


async def test_what_is_shown_and_read_out_is_exactly_what_is_sent():
    """One limit: the card, the reading and the send all carry the whole text. Longer is
    refused (never cut short after the user saw a shorter version)."""
    sent, asked = [], []

    async def approve(question, detail, spoken):
        asked.append((question, detail, spoken))
        return True

    async def run(script, *args, **_kw):
        sent.append(args)
        return ""

    tools = {t.name: t.handler for t in build_tools(approve, lookup_ben, run)}
    longest = "x" * (messaging.MAX_TEXT - 1) + "!"
    out = await tools["send_message"]({"to": "Ben Ma", "text": longest})
    assert out["content"][0]["text"] == "Sent to Ben Ma."
    assert sent[-1] == ("+1 415 555 0199", longest)
    assert f"“{longest}”" in asked[-1][1] and longest in asked[-1][2]

    too_long = "y" * (messaging.MAX_TEXT + 1)
    out = await tools["send_message"]({"to": "Ben Ma", "text": too_long})
    assert out["is_error"] and "Shorten it" in out["content"][0]["text"]
    out = await tools["send_email"]({"to": "Ben", "subject": "Notes", "body": too_long})
    assert out["is_error"] and "draft_email" in out["content"][0]["text"]
    out = await tools["send_email"]({"to": "Ben", "subject": "s" * 151, "body": "Hi."})
    assert out["is_error"]
    assert len(sent) == 1 and len(asked) == 1  # the refused ones never got as far as a card

    body = "b" * messaging.MAX_TEXT
    await tools["send_email"]({"to": "Ben", "subject": "Deck", "body": body})
    assert sent[-1] == ("ben@example.com", "Deck", body)
    assert asked[-1][1].endswith(body) and body in asked[-1][2]
    assert asked[-1][2].endswith("Do you want this email sent?")


async def test_email_goes_through_mail_after_a_yes():
    sent = []

    async def approve(_q, _d, _s):
        return True

    async def run(script, *args, **_kw):
        sent.append(args)
        return ""

    tools = {t.name: t.handler for t in build_tools(approve, lookup_ben, run)}
    out = await tools["send_email"]({"to": "Ben", "subject": "Deck", "body": "Attached soon."})
    assert out["content"][0]["text"] == "Emailed Ben Ma."
    assert sent == [("ben@example.com", "Deck", "Attached soon.")]


async def test_hub_offers_send_tools_with_a_tap_to_send(settings, quiet_speaker, isolated):
    import asyncio

    from test_hub import drain, make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    assert "mcp__messages" in hub.client.options.allowed_tools
    assert "send_message" in hub.client.options.system_prompt
    q = hub.subscribe()
    pending = asyncio.create_task(hub.send_gate("Send this to Ben Ma?", "To Ben Ma: hi"))
    await asyncio.sleep(0)
    approval = next(e for e in drain(q) if e["type"] == "approval")
    assert [c["label"] for c in approval["choices"]] == ["Send", "Don't send"]
    hub.resolve(approval["id"], "allow")
    assert await pending is True


async def test_a_spoken_yes_counts_only_after_the_text_is_read_out(
    settings, quiet_speaker, isolated
):
    """By voice the message itself is read out, through the speech queue, before a yes
    counts: what the mic hears of that reading ("OK, see you then", the closing question)
    is never taken for the answer, and JARVIS never says its own name doing it."""
    import asyncio

    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    spoken = []
    hub.speech.push = spoken.append
    reading = "Here's your message to Ben Ma. OK, see you then. Do you want this message sent?"
    pending = asyncio.create_task(hub.send_gate("Send this to Ben Ma?", "To Ben Ma: …", reading))
    await asyncio.sleep(0)
    assert spoken == [reading]
    hub.state = "speaking"  # the reading plays; the mic hears the speaker
    await hub.on_heard("OK, see you then.")
    assert not pending.done()
    hub.state, hub._spoke_until = "idle", 0
    await hub.on_heard("Do you want this message sent?")  # the tail of its own reading
    assert not pending.done()
    await hub.on_heard("yes")
    assert await pending is True

    pending = asyncio.create_task(
        hub.send_gate("Send this to Ben Ma?", "…", "Here's your message. Jarvis says hi.")
    )
    await asyncio.sleep(0)
    assert spoken[-1] == "Here's your message. the assistant says hi."  # no wake word
    hub.resolve(next(iter(hub.approvals)), "deny")
    assert await pending is False


async def test_a_misheard_name_still_finds_the_person():
    calls = []

    async def lookup(query):
        calls.append(query)
        return [BEN, {**BEN, "name": "Ben Stone"}] if query == "Ben" else []

    assert await resolve("Ben MA", "imessage", lookup) == ("Ben Ma", "+1 415 555 0199")
    assert calls == ["Ben MA", "Ben"]


async def test_find_contact_lists_numbers_and_addresses():
    async def approve(_q, _d, _s):
        return False

    tools = {t.name: t.handler for t in build_tools(approve, lookup_ben)}
    out = await tools["find_contact"]({"name": "Ben"})
    assert (
        "Ben Ma: work +1 415 555 0100, iPhone +1 415 555 0199; ben@example.com"
        == out["content"][0]["text"]
    )
