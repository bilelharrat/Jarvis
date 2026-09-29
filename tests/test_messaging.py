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

    async def approve(question, detail):
        asked.append((question, detail))
        return answers.pop(0)

    async def run(script, *args, **_kw):
        sent.append((script, args))
        return ""

    tools = {t.name: t.handler for t in build_tools(approve, lookup_ben, run)}
    out = await tools["send_message"]({"to": "Ben Ma", "text": "Running 5 late"})
    assert out["is_error"] and sent == []
    assert asked[0] == ("Send this to Ben Ma?", "To Ben Ma (+1 415 555 0199):\n“Running 5 late”")
    out = await tools["send_message"]({"to": "Ben Ma", "text": "Running 5 late"})
    assert out["content"][0]["text"] == "Sent to Ben Ma."
    assert sent == [(messaging.SEND_IMESSAGE_SCRIPT, ("+1 415 555 0199", "Running 5 late"))]


async def test_email_goes_through_mail_after_a_yes():
    sent = []

    async def approve(_q, _d):
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


async def test_a_misheard_name_still_finds_the_person():
    calls = []

    async def lookup(query):
        calls.append(query)
        return [BEN, {**BEN, "name": "Ben Stone"}] if query == "Ben" else []

    assert await resolve("Ben MA", "imessage", lookup) == ("Ben Ma", "+1 415 555 0199")
    assert calls == ["Ben MA", "Ben"]


async def test_find_contact_lists_numbers_and_addresses():
    async def approve(_q, _d):
        return False

    tools = {t.name: t.handler for t in build_tools(approve, lookup_ben)}
    out = await tools["find_contact"]({"name": "Ben"})
    assert (
        "Ben Ma: work +1 415 555 0100, iPhone +1 415 555 0199; ben@example.com"
        == out["content"][0]["text"]
    )
