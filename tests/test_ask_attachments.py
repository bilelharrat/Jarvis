"""A request can carry pictures and files (counted as the owner's private data by the turn
gate) and a note saying where it came from (a chat): a request from elsewhere never gets a
look at the Mac's screen by itself, and one with a picture is never taken for an instant
Mac command."""

from test_hub import make_hub

from jarvis import screenwatch


async def blocks_of(query):
    out = []
    async for item in query:
        out += item["message"]["content"]
    return out


async def test_attachments_ride_with_the_request_and_count_as_private(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    reply = await hub.ask(
        "open settings",  # an instant window command, but it came with a file: for Claude
        silent=True,
        attachments=[
            {"media_type": "application/pdf", "data": "JVBERi0xLjQ=", "name": "Q3.pdf"},
            {"media_type": "image/png", "data": "iVBORw0KGgo=", "name": ""},
            {"media_type": "text/plain", "data": "hello", "name": "notes.txt"},
        ],
        note="this request came from the owner's Telegram chat",
    )
    assert reply == "Two meetings tomorrow."
    blocks = await blocks_of(hub.client.queries[-1])
    assert [b["type"] for b in blocks] == ["document", "image", "document", "text"]
    assert blocks[0] == {
        "type": "document",
        "source": {"type": "base64", "media_type": "application/pdf", "data": "JVBERi0xLjQ="},
        "title": "Q3.pdf",
    }
    assert blocks[2]["source"] == {"type": "text", "media_type": "text/plain", "data": "hello"}
    assert blocks[3]["text"].startswith("[Note from the app: this request came from the owner's")
    assert blocks[3]["text"].endswith("open settings")
    assert (
        hub._session_reads["private"]
        and "the picture or file you sent" in hub._session_reads["what"]
    )


async def test_a_request_from_elsewhere_gets_no_look_at_the_screen(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    hub.prefs.screen_aware = True
    looked = []

    async def latest(seconds):
        looked.append(seconds)
        return None

    hub.screen_watch.latest = latest
    await hub.ask("what's this error on my screen?", silent=True, note="from Telegram")
    assert looked == []
    await hub.ask("what's this error on my screen?")
    assert looked  # at the Mac it still does


async def test_without_attachments_or_a_note_a_request_is_as_before(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    await hub.ask("what's on tomorrow?")
    assert isinstance(hub.client.queries[-1], str)
    assert not hub._session_reads["private"]


async def test_a_screen_picture_is_built_as_before():
    blocks = await blocks_of(
        screenwatch.user_message("look", [{"media_type": "image/jpeg", "data": "abc"}])
    )
    assert blocks == [
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "abc"}},
        {"type": "text", "text": "look"},
    ]
