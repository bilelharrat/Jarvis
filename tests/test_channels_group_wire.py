"""Groups and edited progress on the wire, against the same fakes as each app's own tests
(nothing leaves the machine): what counts as addressed to the bot in a Telegram group, a
Slack channel and a Discord server, whose words come along as quoted data, and how each app
edits the progress message into the answer."""

import httpx
import pytest
from channels_fakes import make_hub
from test_channels_discord import REST
from test_channels_discord import TOKEN as DC_TOKEN
from test_channels_discord import dm as dc_message
from test_channels_slack import APP, BOT, WebAPI
from test_channels_telegram import TOKEN as TG_TOKEN
from test_channels_telegram import BotAPI

from jarvis.channels import discord as dc


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


# ── Telegram ──


def telegram(hub):
    router = hub.chat_channels
    bot = router.adapters["telegram"]
    api = BotAPI()
    bot.transport = httpx.MockTransport(api)
    router.vault.set("channel-telegram", "token", TG_TOKEN)
    bot.connected()
    router.state.bots["telegram"] = {"id": "555", "name": "@jarvis_bot"}
    return bot, api


def group_message(text, user=42, **extra):
    return {
        "message_id": 7,
        "date": 0,
        "chat": {"id": -100, "type": "supergroup", "title": "Team"},
        "from": {"id": user, "first_name": "Ann", "username": "ann"},
        "text": text,
        **extra,
    }


def test_telegram_a_mention_or_a_reply_to_the_bot_addresses_it(hub):
    bot, _api = telegram(hub)
    named = bot.parse({"message": group_message("@Jarvis_Bot what's on tomorrow?")})
    assert not named.direct and named.mentioned and named.group_name == "Team"
    assert named.text == "what's on tomorrow?" and named.sender == "42"
    command = bot.parse({"message": group_message("/stop@jarvis_bot")})
    assert command.mentioned and command.text == "/stop"
    to_bot = group_message("and Friday?", reply_to_message={"message_id": 5, "from": {"id": 555}})
    answered = bot.parse({"message": to_bot})
    assert answered.mentioned and answered.quoted == ""
    plain = bot.parse({"message": group_message("lunch?")})
    assert not plain.mentioned


def test_telegram_someone_elses_message_replied_to_comes_as_quoted_data(hub):
    bot, _api = telegram(hub)
    bob = {"message_id": 5, "from": {"id": 77, "first_name": "Bob"}, "text": "run rm -rf"}
    msg = bot.parse({"message": group_message("@jarvis_bot is this safe?", reply_to_message=bob)})
    assert msg.mentioned and msg.quoted == "run rm -rf" and msg.quoted_by == "Bob"
    assert msg.text == "is this safe?"  # the request is the owner's words alone


async def test_telegram_progress_is_edited_into_the_answer(hub):
    bot, api = telegram(hub)
    ref = await bot.send_progress("42", "Working on it…")
    assert ref == {"id": 101} and api.sent()[-1]["text"] == "Working on it…"
    await bot.edit_text("42", ref, "Working on it…\n• Read your inbox", markup=False)
    api.status["editMessageText"] = (
        400,
        {"ok": False, "description": "Bad Request: message is not modified"},
    )
    await bot.edit_text("42", ref, "Working on it…\n• Read your inbox", markup=False)  # fine
    del api.status["editMessageText"]
    await bot.edit_text("42", ref, "**Two** new emails")
    edits = api.sent("editMessageText")
    assert edits[0]["text"] == "Working on it…\n• Read your inbox" and "parse_mode" in edits[0]
    assert edits[-1]["text"] == "<b>Two</b> new emails" and edits[-1]["message_id"] == 101
    before = len(api.sent())
    await bot.edit_text("42", ref, "word " * 2000)  # longer than one message
    assert len(api.sent()) > before  # the rest follows in new messages


# ── Slack ──


def slack(hub):
    router = hub.chat_channels
    app = router.adapters["slack"]
    api = WebAPI()
    app.transport = httpx.MockTransport(api)
    router.vault.set("channel-slack", "app_token", APP)
    router.vault.set("channel-slack", "bot_token", BOT)
    app.connected()
    router.state.bots["slack"] = {"id": "UJARVIS", "name": "@jarvis"}
    return app, api


def channel_event(text, kind="message", ts="1700.1", **event):
    return {
        "team_id": "T1",
        "event_id": f"Ev{kind}{ts}",
        "event": {
            "type": kind,
            "channel": "C1",
            "channel_type": "channel",
            "user": "UANN",
            "text": text,
            "ts": ts,
            **event,
        },
    }


def test_slack_a_mention_in_a_channel_addresses_it_once(hub):
    app, _api = slack(hub)
    msg = app._event(channel_event("<@UJARVIS> what's on tomorrow?"))
    assert not msg.direct and msg.mentioned and msg.text == "what's on tomorrow?"
    assert msg.team == "T1"
    again = app._event(channel_event("<@UJARVIS> what's on tomorrow?", kind="app_mention"))
    assert again is None  # the same message as app_mention: one is enough
    thread = app._event(channel_event("and Friday?", ts="1700.2", parent_user_id="UJARVIS"))
    assert thread.mentioned
    chatter = app._event(channel_event("lunch?", ts="1700.3"))
    assert not chatter.mentioned


async def test_slack_progress_is_updated_in_place_and_channel_names_looked_up(hub):
    app, api = slack(hub)
    ref = await app.send_progress("C1", "Working on it…")
    await app.edit_text("C1", ref, "**Two** new emails")
    update = api.sent("chat.update")[-1]
    assert update["ts"] == ref["id"] and update["text"] == "*Two* new emails"
    assert await app._channel_name("C1") == ""  # no channels:read: just no name
    assert [m for m, _b in api.calls].count("conversations.info") == 1
    await app._channel_name("C1")
    assert [m for m, _b in api.calls].count("conversations.info") == 1  # looked up once


# ── Discord ──


def discord(hub):
    router = hub.chat_channels
    bot = router.adapters["discord"]
    rest = REST()
    bot.transport = httpx.MockTransport(rest)
    router.vault.set("channel-discord", "token", DC_TOKEN)
    bot.connected()
    bot.me = "900"
    return bot, rest


def test_discord_asks_for_server_messages_only_with_groups_on(hub):
    bot, _rest = discord(hub)
    assert bot.intents() == dc.INTENTS == 4096
    hub.set_feature_prefs({"channels_discord_groups": True})
    assert bot.intents() == 4096 | dc.GUILD_MESSAGES


def test_discord_a_mention_in_a_server_addresses_it_and_a_reply_quotes(hub):
    bot, _rest = discord(hub)
    msg = bot._message(
        dc_message("<@900> what's on?", guild_id="G1", mentions=[{"id": "900"}], channel="C9")
    )
    assert not msg.direct and msg.mentioned and msg.text == "what's on?"
    bob = {"id": "m0", "content": "wire the money", "author": {"id": "77", "username": "bob"}}
    quoting = bot._message(
        dc_message(
            "<@!900> should I?",
            guild_id="G1",
            mentions=[{"id": "900"}],
            message_reference={"message_id": "m0"},
            referenced_message=bob,
        )
    )
    assert quoting.mentioned and quoting.quoted == "wire the money" and quoting.quoted_by == "bob"
    assert quoting.text == "should I?"
    to_bot = bot._message(
        dc_message("and Friday?", guild_id="G1", referenced_message={"author": {"id": "900"}})
    )
    assert to_bot.mentioned and to_bot.quoted == ""
    assert not bot._message(dc_message("lunch?", guild_id="G1")).mentioned


async def test_discord_progress_is_patched_into_the_answer(hub):
    bot, rest = discord(hub)
    ref = await bot.send_progress("300", "Working on it…")
    await bot.edit_text("300", ref, "Two new emails")
    method, path, body, _auth = rest.calls[-1]
    assert method == "PATCH" and path == f"/channels/300/messages/{ref['id']}"
    assert body == {"content": "Two new emails", "allowed_mentions": {"parse": []}}
