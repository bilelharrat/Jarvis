"""Slack in Socket Mode against a fake socket and a fake Web API (nothing leaves the
machine): both tokens are checked and kept in the Keychain only, every envelope is
acknowledged at once, only the paired user's direct messages count (never a bot's, never
twice), buttons answer cards, files come only from Slack's own host, and a refused token
stops it until it's connected again."""

import asyncio
import json
from urllib.parse import parse_qs

import httpx
import pytest
from channels_fakes import make_hub, settle

from jarvis.channels import slack as slackmod
from jarvis.channels.router import Card
from jarvis.channels.store import Owner

APP = "xapp-1-A0123456789-1234567890123-" + "a" * 40
BOT = "xoxb-1234567890-1234567890123-" + "b" * 24


class Socket:
    """A pretend Socket Mode connection: frames to hand out, what was sent back."""

    def __init__(self, frames):
        self.incoming: asyncio.Queue = asyncio.Queue()
        for frame in frames:
            self.incoming.put_nowait(json.dumps(frame) if isinstance(frame, dict) else frame)
        self.sent = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def send(self, text):
        self.sent.append(json.loads(text))

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.incoming.get()
        if item is None:
            raise StopAsyncIteration
        return item


class WebAPI:
    def __init__(self):
        self.calls = []
        self.opened = 0
        self.refuse_after = 1  # apps.connections.open works this many times, then invalid_auth
        self.files = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "files.slack.com" and request.method == "GET":
            assert request.headers["authorization"] == f"Bearer {BOT}"
            return httpx.Response(200, content=self.files.get(request.url.path, b""))
        if request.url.host == "files.slack.com":
            self.calls.append(("upload", request.content))
            return httpx.Response(200, text="OK")
        method = request.url.path.rsplit("/", 1)[-1]
        if request.headers.get("content-type", "").startswith("application/x-www-form-urlencoded"):
            body = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
        else:
            body = json.loads(request.content or b"{}")
        token = request.headers.get("authorization", "")[7:]
        self.calls.append((method, body))
        if method == "apps.connections.open":
            if token != APP:
                return httpx.Response(200, json={"ok": False, "error": "invalid_auth"})
            self.opened += 1
            if self.opened > self.refuse_after:
                return httpx.Response(200, json={"ok": False, "error": "invalid_auth"})
            return httpx.Response(
                200, json={"ok": True, "url": f"wss://wss.slack.test/link/{self.opened}"}
            )
        if token != BOT:
            return httpx.Response(200, json={"ok": False, "error": "invalid_auth"})
        if method == "auth.test":
            return httpx.Response(
                200, json={"ok": True, "user_id": "UJARVIS", "user": "jarvis", "team_id": "T1"}
            )
        if method == "chat.postMessage":
            return httpx.Response(200, json={"ok": True, "ts": f"1700.{len(self.calls)}"})
        if method == "files.getUploadURLExternal":
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "upload_url": "https://files.slack.com/upload/v1/abc",
                    "file_id": "F1",
                },
            )
        return httpx.Response(200, json={"ok": True})

    def sent(self, method="chat.postMessage"):
        return [b for m, b in self.calls if m == method]


def dm(text, user="UANN", event_id="Ev1", channel="D1", **event):
    return {
        "envelope_id": f"env-{event_id}",
        "type": "events_api",
        "payload": {
            "team_id": "T1",
            "event_id": event_id,
            "event": {
                "type": "message",
                "channel": channel,
                "channel_type": "im" if channel.startswith("D") else "channel",
                "user": user,
                "text": text,
                "ts": "0",
                **event,
            },
        },
    }


@pytest.fixture
def world(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    router = hub.chat_channels
    slack = router.adapters["slack"]
    api = WebAPI()
    slack.transport = httpx.MockTransport(api)
    router.vault.set("channel-slack", "app_token", APP)
    router.vault.set("channel-slack", "bot_token", BOT)
    slack.connected()
    router.state.bots["slack"] = {"id": "UJARVIS", "name": "@jarvis"}
    hub.set_feature_prefs({"channels_slack_on": True})
    return hub, router, slack, api


async def test_both_tokens_are_checked(world):
    hub, router, slack, api = world
    assert await slack.verify({"app_token": APP, "bot_token": BOT}) == {
        "id": "UJARVIS",
        "name": "@jarvis",
    }
    with pytest.raises(ValueError, match="both tokens"):
        await slack.verify({"bot_token": BOT})
    with pytest.raises(ValueError, match="didn't accept"):
        await slack.verify({"app_token": APP, "bot_token": "xoxb-" + "z" * 40})
    router.vault.delete("channel-slack", "app_token")
    slack.connected()
    assert not slack.ready()


async def test_the_owners_dm_is_answered_and_every_envelope_acknowledged(world):
    hub, router, slack, api = world
    await hub.start()
    router.state.owners["slack"] = Owner("UANN", "D1", "UANN", team="T1")
    frames = [
        {"type": "hello"},
        dm("what's on tomorrow?", event_id="Ev1"),
        dm("what's on tomorrow?", event_id="Ev1"),  # Slack sending it again
        dm("I'm a bot", event_id="Ev2", bot_id="B9"),
        dm("in a channel", event_id="Ev3", channel="C1"),
        dm("edited", event_id="Ev4", subtype="message_changed"),
        {"type": "disconnect", "reason": "refresh_requested"},
    ]
    sockets = [Socket(frames)]
    slack.connect = lambda url: sockets.pop(0)
    await slack.run()  # one connection, a refresh, then the token is refused
    await settle(router)
    assert hub.commands == 1 and hub.client.said[-1] == "what's on tomorrow?"
    assert api.sent()[-1] == {
        "channel": "D1",
        "text": "Two meetings tomorrow.",
        "unfurl_links": False,
        "unfurl_media": False,
    }
    assert slack.halted and "refused the tokens" in slack.error


async def test_acks_go_out_before_the_work(world):
    hub, router, slack, api = world
    router.state.owners["slack"] = Owner("UANN", "D1", "UANN", team="T1")
    socket = Socket([{"type": "hello"}, dm("/status", event_id="Ev9"), None])
    order = []
    real_receive = router.receive

    async def receive(msg):
        order.append(("handled", list(socket.sent)))
        await real_receive(msg)

    router.receive = receive
    await slack._read(socket)
    assert order == [("handled", [{"envelope_id": "env-Ev9"}])]


async def test_someone_else_in_the_workspace_is_refused(world):
    hub, router, slack, api = world
    router.state.owners["slack"] = Owner("UANN", "D1", "UANN", team="T1")
    await slack._read(Socket([dm("hi", user="UBOB", channel="D2", event_id="Ev5"), None]))
    assert api.sent()[-1]["text"] == "This is a private assistant." and hub.commands == 0


async def test_pairing_with_a_bare_pair_message(world):
    hub, router, slack, api = world
    code = router.codes["slack"].start()
    await slack._read(Socket([dm(f"pair {code}", event_id="Ev6"), None]))
    owner = router.state.owners["slack"]
    assert (owner.user, owner.chat, owner.team) == ("UANN", "D1", "T1")
    assert "!help" in api.sent()[-1]["text"]


async def test_a_button_answers_a_card(world):
    hub, router, slack, api = world
    router.state.owners["slack"] = Owner("UANN", "D1", "UANN", team="T1")
    asked = asyncio.create_task(hub.request_approval("Run the shortcut?", ""))
    await asyncio.sleep(0)
    approval_id = next(iter(hub.approvals))
    router.cards[approval_id] = Card(approval_id, [("slack", "D1", {"id": "1700.1"})])
    press = {
        "envelope_id": "env-a",
        "type": "interactive",
        "payload": {
            "type": "block_actions",
            "user": {"id": "UANN", "team_id": "T1"},
            "channel": {"id": "D1"},
            "container": {"message_ts": "1700.1", "channel_id": "D1"},
            "team": {"id": "T1"},
            "actions": [{"action_id": f"a:{approval_id}:allow", "value": "allow"}],
        },
    }
    socket = Socket([press, None])
    await slack._read(socket)
    assert await asked == "allow" and socket.sent == [{"envelope_id": "env-a"}]


async def test_a_card_has_buttons_and_closing_it_keeps_the_question(world):
    hub, router, slack, api = world
    card = {
        "id": "abcdef123456",
        "question": "Send this to <Ann>?",
        "detail": "```rm -rf /```",
        "choices": [{"id": "allow", "label": "Allow"}, {"id": "deny", "label": "Not now"}],
    }
    await slack.send_card("D1", {**card, "detail": "a & b " * 800}, "en")
    long_detail = api.sent()[-1]["blocks"][1]["text"]["text"]
    assert len(long_detail) <= 3000 and long_detail.startswith("```a &amp; b")
    ref = await slack.send_card("D1", card, "en")
    blocks = api.sent()[-1]["blocks"]
    assert "Send this to &lt;Ann&gt;?" in blocks[0]["text"]["text"]
    assert blocks[1]["text"]["text"].count("```") == 2  # its own fences only
    actions = blocks[-1]["elements"]
    assert [a["action_id"] for a in actions] == [
        "a:abcdef123456:allow",
        "a:abcdef123456:deny",
        "a:abcdef123456:why",
    ]
    await slack.close_card("D1", ref, "You chose: Allow.")
    update = api.sent("chat.update")[-1]
    assert update["ts"] == ref["id"] and update["blocks"][-1]["type"] == "context"
    assert all(b["type"] != "actions" for b in update["blocks"])


async def test_files_come_only_from_slacks_host(world):
    hub, router, slack, api = world
    api.files = {"/files-pri/T1-F1/q3.pdf": b"%PDF-1.4"}
    msg = slack._event(
        {
            "team_id": "T1",
            "event": {
                "type": "message",
                "subtype": "file_share",
                "channel": "D1",
                "channel_type": "im",
                "user": "UANN",
                "text": "",
                "files": [
                    {
                        "name": "q3.pdf",
                        "mimetype": "application/pdf",
                        "size": 8,
                        "url_private_download": "https://files.slack.com/files-pri/T1-F1/q3.pdf",
                    },
                    {
                        "name": "x.pdf",
                        "mimetype": "application/pdf",
                        "size": 8,
                        "url_private_download": "https://evil.example/steal",
                    },
                    {
                        "name": "clip.webm",
                        "mimetype": "audio/webm",
                        "subtype": "slack_audio",
                        "url_private_download": "https://files.slack.com/files-pri/T1-F2/clip.webm",
                    },
                ],
            },
        }
    )
    assert [m.kind for m in msg.media] == ["file", "file", "voice"]
    assert await msg.media[0].fetch() == b"%PDF-1.4"
    with pytest.raises(slackmod.SlackError):
        await msg.media[1].fetch()  # the bot token never goes anywhere else


async def test_a_file_it_made_is_uploaded_in_three_steps(world, tmp_path):
    hub, router, slack, api = world
    report = tmp_path / "report.md"
    report.write_text("# Report")
    await slack.send_file("D1", report, "Solar report")
    kinds = [m for m, _b in api.calls]
    assert kinds == ["files.getUploadURLExternal", "upload", "files.completeUploadExternal"]
    done = api.calls[-1][1]
    assert done["channel_id"] == "D1" and json.loads(done["files"])[0]["title"] == "Solar report"


def test_text_from_slack_reads_as_typed():
    assert slackmod.unescape("see <https://x.y|x.y> &amp; ask <@U123|ann> &lt;3") == (
        "see https://x.y & ask ann <3"
    )
