"""Telegram against a fake Bot API (httpx's MockTransport; nothing leaves the machine):
the token is checked and kept in the Keychain only, updates are long-polled from where
they got to, the owner pairs with the code and is answered in escaped HTML (plain text when
Telegram can't parse it), long replies are cut at 4,096, cards get buttons that answer
them, files come and go, and no address holding the token is ever logged or shown."""

import asyncio
import json
import logging
import re
import time

import httpx
import pytest
from channels_fakes import make_hub, settle

from jarvis.channels import telegram as tg
from jarvis.channels import words
from jarvis.channels.router import Card
from jarvis.channels.store import Owner

TOKEN = "123456789:" + "AbCdEfGhIjKlMnOpQrStUvWxYz012345678"


class BotAPI:
    """A pretend api.telegram.org: records every call, answers from a script."""

    def __init__(self):
        self.calls = []
        self.updates = []  # batches getUpdates hands out, then 401 (to end run())
        self.refuse_html = False
        self.files = {}
        self.next_id = 100
        self.status = {}  # method -> (status, body) to answer with instead

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.startswith("/file/bot"):
            token, _, name = path[len("/file/bot") :].partition("/")
            assert token == TOKEN
            return httpx.Response(200, content=self.files.get(name, b""))
        m = re.fullmatch(r"/bot([^/]+)/(\w+)", path)
        assert m, path
        token, method = m.groups()
        if request.headers.get("content-type", "").startswith("multipart/"):
            body = {"multipart": request.content}
        else:
            body = json.loads(request.content or b"{}")
        self.calls.append((method, body))
        if token != TOKEN:
            return httpx.Response(401, json={"ok": False, "description": "Unauthorized"})
        if method in self.status:
            status, answer = self.status[method]
            return httpx.Response(status, json=answer)
        if method == "getMe":
            return self.ok(
                {"id": 555, "is_bot": True, "username": "jarvis_bot", "first_name": "Jarvis"}
            )
        if method == "getUpdates":
            if self.updates:
                return self.ok(self.updates.pop(0))
            return httpx.Response(401, json={"ok": False, "description": "Unauthorized"})
        if method == "sendMessage":
            if self.refuse_html and body.get("parse_mode") == "HTML":
                return httpx.Response(
                    400, json={"ok": False, "description": "Bad Request: can't parse entities"}
                )
            self.next_id += 1
            return self.ok({"message_id": self.next_id})
        if method == "getFile":
            file_id = body["file_id"]
            return self.ok({"file_id": file_id, "file_path": f"docs/{file_id}", "file_size": 10})
        return self.ok(True)

    @staticmethod
    def ok(result):
        return httpx.Response(200, json={"ok": True, "result": result})

    def sent(self, method="sendMessage"):
        return [body for m, body in self.calls if m == method]


def private(text, user=42, date=None, **extra):
    return {
        "message_id": 7,
        "from": {"id": user, "first_name": "Ann", "username": "ann"},
        "chat": {"id": user, "type": "private"},
        "date": int(date if date is not None else time.time()),
        "text": text,
        **extra,
    }


@pytest.fixture
def world(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    router = hub.chat_channels
    bot = router.adapters["telegram"]
    api = BotAPI()
    bot.transport = httpx.MockTransport(api)
    router.vault.set("channel-telegram", "token", TOKEN)
    bot.connected()
    hub.set_feature_prefs({"channels_telegram_on": True})
    return hub, router, bot, api


async def test_a_token_is_checked_and_kept_in_the_keychain_only(world):
    hub, router, bot, api = world
    router.vault.delete("channel-telegram", "token")
    bot.connected()
    assert await bot.verify({"token": TOKEN}) == {"id": "555", "name": "@jarvis_bot"}
    with pytest.raises(ValueError, match="doesn't look like"):
        await bot.verify({"token": "not a token"})
    with pytest.raises(ValueError, match="didn't accept"):
        await bot.verify({"token": "987654321:" + "Z" * 35})
    await router.command({"type": "channels_connect", "channel": "telegram", "token": TOKEN})
    await settle(router)
    assert router.vault.get("channel-telegram", "token") == TOKEN
    assert router.state.bots["telegram"]["name"] == "@jarvis_bot"
    await router.flush()
    assert TOKEN.split(":")[1] not in router.state.path.read_text()


async def test_pairing_then_a_request_over_long_polling(world):
    hub, router, bot, api = world
    await hub.start()
    code = router.codes["telegram"].start()
    api.updates = [
        [
            {"update_id": 10, "message": private(f"/pair {code}")},
            {"update_id": 11, "message": private("what's on tomorrow?")},
        ]
    ]
    await bot.run()  # the batch, then Telegram refuses the token and it stops
    await settle(router)
    assert router.state.owners["telegram"] == Owner(
        "42", "42", "Ann (@ann)", router.state.owners["telegram"].since
    )
    assert router.state.offsets["telegram"] == 12
    texts = [b["text"] for b in api.sent()]
    assert texts[0].startswith("Paired.") and texts[-1] == "Two meetings tomorrow."
    assert all(b["chat_id"] == "42" for b in api.sent())
    assert api.sent("sendChatAction") and api.sent("sendChatAction")[0]["action"] == "typing"
    assert bot.halted and "refused the bot token" in bot.error
    polled = [b for m, b in api.calls if m == "getUpdates"]
    assert polled[0]["offset"] == 0 and polled[1]["offset"] == 12  # never the same update twice


async def test_it_polls_from_where_it_got_to(world):
    hub, router, bot, api = world
    router.state.offsets["telegram"] = 500
    await bot.run()
    assert [b["offset"] for m, b in api.calls if m == "getUpdates"] == [500]


async def test_a_stranger_is_refused_and_a_group_ignored(world):
    hub, router, bot, api = world
    router.state.owners["telegram"] = Owner("42", "42", "Ann")
    group = private("hi bot", user=7) | {"chat": {"id": -9, "type": "group"}}
    await bot.handle_updates(
        [
            {"update_id": 1, "message": private("open the garage", user=99)},
            {"update_id": 2, "message": group},
        ]
    )
    assert [(b["chat_id"], b["text"]) for b in api.sent()] == [("99", words.PRIVATE)]
    assert hub.commands == 0


async def test_replies_are_escaped_html_and_plain_when_telegram_cant_parse_them(world):
    hub, router, bot, api = world
    await bot.send_text("42", "**Done** <b>not bold</b> & `x<y`")
    body = api.sent()[-1]
    assert body["parse_mode"] == "HTML"
    assert body["text"] == "<b>Done</b> &lt;b&gt;not bold&lt;/b&gt; &amp; <code>x&lt;y</code>"
    api.refuse_html = True
    await bot.send_text("42", "**Done** [x](https://a.b)")
    fallback = api.sent()[-1]
    assert "parse_mode" not in fallback and fallback["text"] == "Done x (https://a.b)"


async def test_a_long_reply_is_cut_at_telegrams_limit(world):
    hub, router, bot, api = world
    await bot.send_text("42", ("A sentence that goes on. " * 40 + "\n\n") * 12)
    texts = [b["text"] for b in api.sent()]
    assert len(texts) >= 3 and all(tg.utf16_len(t) <= 4096 for t in texts)


async def test_a_heads_up_is_shown_exactly_as_written(world):
    hub, router, bot, api = world
    await bot.send_text(
        "42", "Pay **now** at [bank](https://evil.example)", title="Email from Bob", markup=False
    )
    text = api.sent()[-1]["text"]
    assert text == "<b>Email from Bob</b>\nPay **now** at [bank](https://evil.example)"
    assert "<a " not in text


async def test_a_card_gets_buttons_and_its_answer_closes_it(world):
    hub, router, bot, api = world
    card = {
        "id": "abcdef123456",
        "question": "Send this to <Ann>?",
        "detail": "To Ann: see you at 3",
        "choices": [{"id": "allow", "label": "Allow"}, {"id": "deny", "label": "Not now"}],
    }
    ref = await bot.send_card("42", card, "en")
    sent = api.sent()[-1]
    assert (
        "Send this to &lt;Ann&gt;?" in sent["text"]
        and "<pre>To Ann: see you at 3</pre>" in sent["text"]
    )
    keyboard = sent["reply_markup"]["inline_keyboard"]
    assert [row[0]["callback_data"] for row in keyboard] == [
        "a:abcdef123456:allow",
        "a:abcdef123456:deny",
        "a:abcdef123456:why",
    ]
    assert keyboard[-1][0]["text"] == words.BECAUSE
    await bot.close_card("42", ref, "You chose: Allow.")
    edit = api.sent("editMessageText")[-1]
    assert edit["message_id"] == int(ref["id"]) and edit["reply_markup"] == {"inline_keyboard": []}
    assert edit["text"].endswith("<i>You chose: Allow.</i>")


async def test_pressing_a_button_answers_the_card_through_the_hub(world):
    hub, router, bot, api = world
    router.state.owners["telegram"] = Owner("42", "42", "Ann")
    asked = asyncio.create_task(hub.request_approval("Open the page?", ""))
    await asyncio.sleep(0)
    approval_id = next(iter(hub.approvals))
    router.cards[approval_id] = Card(approval_id, [("telegram", "42", {"id": "101", "text": "x"})])
    press = {
        "update_id": 3,
        "callback_query": {
            "id": "q1",
            "from": {"id": 42, "first_name": "Ann"},
            "message": {"message_id": 101, "chat": {"id": 42, "type": "private"}},
            "data": f"a:{approval_id}:allow",
        },
    }
    stranger = json.loads(json.dumps(press))
    stranger["callback_query"]["from"]["id"] = 99
    await bot.handle_updates([stranger])
    assert approval_id in hub.approvals  # someone else's press answers nothing
    await bot.handle_updates([press])
    assert await asked == "allow"
    answered = api.sent("answerCallbackQuery")
    assert answered[-1] == {"callback_query_id": "q1", "text": "You chose: Allow."}


async def test_no_because_opens_a_reply_box(world):
    hub, router, bot, api = world
    await bot.ask_reason("42", words.INSTEAD)
    assert api.sent()[-1]["reply_markup"] == {"force_reply": True}


async def test_voice_notes_photos_and_files_are_read(world):
    hub, router, bot, api = world
    message = private(
        "look",
        voice={"file_id": "v1", "duration": 4, "mime_type": "audio/ogg", "file_size": 900},
        photo=[
            {"file_id": "p-small", "width": 320, "height": 240},
            {"file_id": "p-big", "width": 1280, "height": 960},
            {"file_id": "p-huge", "width": 2560, "height": 1920},
        ],
        document={
            "file_id": "d1",
            "file_name": "Q3.pdf",
            "mime_type": "application/pdf",
            "file_size": 20,
        },
        forward_origin={"type": "user"},
    )
    msg = bot.parse({"update_id": 1, "message": message})
    assert [m.kind for m in msg.media] == ["voice", "image", "file"]
    assert msg.media[0].seconds == 4 and msg.forwarded and msg.text == "look"
    api.files = {"docs/p-big": b"\xff\xd8\xff photo", "docs/d1": b"%PDF-1.4"}
    assert await msg.media[1].fetch() == b"\xff\xd8\xff photo"  # the biggest under 1,600 px
    assert await msg.media[2].fetch() == b"%PDF-1.4"
    assert [b["file_id"] for b in api.sent("getFile")] == ["p-big", "d1"]


async def test_a_file_path_that_leaves_telegrams_folder_is_refused(world):
    hub, router, bot, api = world
    api.status["getFile"] = (200, {"ok": True, "result": {"file_path": "../../etc/passwd"}})
    fetch = bot._fetcher("x")
    with pytest.raises(tg.TelegramError):
        await fetch()


async def test_a_file_it_made_goes_as_a_document(world, tmp_path):
    hub, router, bot, api = world
    memo = tmp_path / "Q3 memo.txt"
    memo.write_text("the plan")
    await bot.send_file("42", memo, "Q3 memo")
    body = api.calls[-1]
    assert body[0] == "sendDocument"
    raw = body[1]["multipart"]
    assert b'name="chat_id"' in raw and b"the plan" in raw and b'filename="Q3 memo.txt"' in raw


async def test_the_token_never_reaches_the_log_or_the_window(world, caplog):
    hub, router, bot, api = world
    caplog.set_level(logging.DEBUG)

    def down(request):
        raise httpx.ConnectError(f"can't connect to {request.url}")

    bot.transport = httpx.MockTransport(down)
    bot.connected()
    with pytest.raises(tg.TelegramError) as caught:
        await bot.api("getMe")
    assert TOKEN not in str(caught.value)
    runs = asyncio.create_task(bot.run())
    await asyncio.sleep(0.05)
    runs.cancel()
    with pytest.raises(asyncio.CancelledError):
        await runs
    shown = json.dumps(router.public())
    assert TOKEN not in caplog.text and TOKEN.split(":")[1] not in caplog.text
    assert TOKEN.split(":")[1] not in shown and bot.state == "reconnecting"


async def test_a_second_reader_of_the_bot_is_said_plainly(world, monkeypatch):
    hub, router, bot, api = world
    api.status["getUpdates"] = (
        409,
        {"ok": False, "description": "Conflict: terminated by other getUpdates"},
    )
    naps = []

    async def nap(seconds):
        naps.append(seconds)
        raise asyncio.CancelledError

    monkeypatch.setattr(tg.asyncio, "sleep", nap)
    with pytest.raises(asyncio.CancelledError):
        await bot.run()
    assert bot.state == "error" and "Something else is reading" in bot.error and naps == [30]


async def test_too_many_requests_waits_as_telegram_says(world, monkeypatch):
    hub, router, bot, api = world
    replies = [
        httpx.Response(
            429,
            json={
                "ok": False,
                "description": "Too Many Requests",
                "parameters": {"retry_after": 3},
            },
        ),
        httpx.Response(200, json={"ok": True, "result": {"message_id": 5}}),
    ]
    bot.transport = httpx.MockTransport(lambda _r: replies.pop(0))
    bot.connected()
    naps = []

    async def nap(seconds):
        naps.append(seconds)

    monkeypatch.setattr(tg.asyncio, "sleep", nap)
    await bot.send_text("42", "hello")
    assert naps == [3] and not replies


def test_a_hub_that_doesnt_poll_never_reaches_telegram(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    bot = hub.chat_channels.adapters["telegram"]
    hub.chat_channels.vault.set("channel-telegram", "token", TOKEN)
    bot.connected()

    async def attempt():
        with pytest.raises(tg.TelegramError):
            await bot.api("getMe")

    asyncio.run(attempt())


def test_the_update_offset_is_read_back_defensively(tmp_path):
    from jarvis.channels.store import ChannelState

    path = tmp_path / "channels.json"
    path.write_text(
        json.dumps({"offsets": {"telegram": "12"}, "owners": {"telegram": {"user": "1"}}})
    )
    state = ChannelState(path)
    assert state.offsets == {} and state.owners == {}  # a string offset, an owner without a chat
    path.write_text("{not json")
    assert ChannelState(path).owners == {}  # damaged: set aside, nothing trusted
    assert list(tmp_path.glob("channels.json.bad-*"))
