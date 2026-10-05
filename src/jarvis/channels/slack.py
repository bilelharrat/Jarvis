"""Slack: a Slack app of the owner's own, in Socket Mode, so nothing on the Mac listens to
the internet. It takes two tokens, both kept in the Keychain: an app-level token (xapp-…,
with connections:write) that opens the socket, and the bot token (xoxb-…) that reads and
writes. Only direct messages with the app count, from the one Slack user who paired.

Every event is acknowledged the moment it arrives (Slack wants that within three seconds)
and handled after. Cards get Block Kit buttons; a file is fetched only from Slack's own
file host, the only place the bot token is ever sent besides Slack's API. Slack keeps
"/" for its own commands, so here commands are written with "!" (!stop, !status, …).

In a channel the app was invited to (with groups switched on in Settings), a message that
mentions the app, or replies in a thread it started, is the router's to weigh; only the
owner's count. Progress on a long request is one message, edited (chat.update).
"""

from __future__ import annotations

import asyncio
import html
import json
import logging
import re
from collections import deque
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from .base import Channel, Inbound, Media, clip, slack_escape, slack_mrkdwn, split_text
from .words import BECAUSE, BECAUSE_PLAN, NEEDS_OK, say

log = logging.getLogger("jarvis")

API = "https://slack.com/api"
FILE_HOSTS = ("files.slack.com",)
LIMIT = 3500
DETAIL = 2500
SECTION = 2900  # characters of a card's detail block: with its fences, inside Slack's 3,000
_APP = re.compile(r"^xapp-[A-Za-z0-9-]{20,300}$")
_BOT = re.compile(r"^xoxb-[A-Za-z0-9-]{20,300}$")
_ACTION = re.compile(r"^a:([0-9a-f]{6,32}):([\w-]{1,24})$")
# Slack writes a literal < or > in a message as &lt; and &gt;, so neither is ever inside a
# link or a mention: one stops at the next <. Scanning on to the end from each "<@" instead,
# a message of "<@" over and over (anyone in the workspace can send one, and it's read
# before they're checked to be the owner) took seconds of the event loop.
_LINK = re.compile(r"<((?:https?|mailto):[^|<>]+)(?:\|([^<>]*))?>")
_MENTION = re.compile(r"<[@#!]([^|<>]+)(?:\|([^<>]*))?>")
REFUSED = ("invalid_auth", "not_authed", "token_revoked", "account_inactive", "missing_scope")


class SlackError(Exception):
    def __init__(self, error: str, retry_after: float = 0.0) -> None:
        super().__init__(error)
        self.error, self.retry_after = error, retry_after


def _offline(_request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("no network for a hub that doesn't poll")


class NoSocket:
    """What a hub that doesn't poll gets instead of a socket: never a connection."""

    async def __aenter__(self) -> Any:
        raise OSError("no network for a hub that doesn't poll")

    async def __aexit__(self, *_exc: Any) -> bool:
        return False


def unescape(text: str) -> str:
    """Slack's text as the owner typed it: links and mentions back to words, entities back
    to characters."""
    text = _LINK.sub(lambda m: m.group(1).removeprefix("mailto:"), text or "")
    text = _MENTION.sub(lambda m: m.group(2) or m.group(1), text)
    return html.unescape(text)


class Slack(Channel):
    name = "slack"
    title = "Slack"
    limit = LIMIT
    buttons = True
    command_mark = "!"
    edits = True
    groups = True
    max_file = 100_000_000
    vault_id = "channel-slack"
    secret_keys = ("app_token", "bot_token")

    def __init__(self, router: Any) -> None:
        super().__init__(router)
        self.transport: httpx.AsyncBaseTransport | None = None  # tests: a MockTransport
        self.connect: Any = None  # tests: a fake socket; else websockets
        self._client: httpx.AsyncClient | None = None
        self._seen: deque[str] = deque(maxlen=500)  # events already handled (Slack retries)
        self._posts: deque[tuple[str, str]] = deque(maxlen=500)  # (channel, ts) handled
        self._names: dict[str, str] = {}  # a channel's name, once looked up
        self.backoff = 1.0  # seconds before the next try at connecting

    def home_chat(self) -> str | None:
        owner = self.router.state.owners.get(self.name)
        return owner.chat if owner else None

    def connected(self) -> None:
        super().connected()
        self._client = None

    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            transport = self.transport
            if transport is None and self.router.offline:
                transport = httpx.MockTransport(_offline)
            self._client = httpx.AsyncClient(
                transport=transport, timeout=30.0, follow_redirects=False
            )
        return self._client

    def _socket(self, url: str) -> Any:
        if self.connect is not None:
            return self.connect(url)
        if self.router.offline:
            return NoSocket()
        from websockets.asyncio.client import connect

        return connect(url, max_size=4 * 1024 * 1024, open_timeout=20)

    # ── the Web API ──

    async def api(
        self,
        method: str,
        payload: dict[str, Any] | None = None,
        *,
        token: str = "",
        form: bool = False,
    ) -> dict[str, Any]:
        token = token or self.secret("bot_token")
        if not token:
            raise SlackError("not_authed")
        headers = {"Authorization": f"Bearer {token}"}
        for attempt in range(2):
            try:
                if form:
                    resp = await self.client().post(
                        f"{API}/{method}", data=payload or {}, headers=headers
                    )
                else:
                    resp = await self.client().post(
                        f"{API}/{method}", json=payload or {}, headers=headers
                    )
            except httpx.HTTPError as exc:
                raise SlackError(type(exc).__name__) from None
            if resp.status_code == 429 and attempt == 0:
                await asyncio.sleep(min(30.0, float(resp.headers.get("retry-after") or 1)))
                continue
            try:
                body = resp.json()
            except ValueError:
                body = {}
            if not isinstance(body, dict) or not body.get("ok"):
                error = str((body or {}).get("error") or f"http_{resp.status_code}")[:80]
                raise SlackError(error)
            return body
        raise SlackError("ratelimited")

    async def verify(self, secrets_: dict[str, str]) -> dict[str, str]:
        app, bot = (
            (secrets_.get("app_token") or "").strip(),
            (secrets_.get("bot_token") or "").strip(),
        )
        if not _APP.fullmatch(app) or not _BOT.fullmatch(bot):
            raise ValueError(
                "Slack needs both tokens: the app-level token (xapp-…) and the bot token (xoxb-…)."
            )
        try:
            me = await self.api("auth.test", token=bot)
            await self.api("apps.connections.open", token=app)
        except SlackError as exc:
            if exc.error in REFUSED or exc.error.startswith("invalid"):
                raise ValueError(
                    "Slack didn't accept those tokens. Check them in your app's settings "
                    "(Basic Information › App-Level Tokens, and OAuth & Permissions)."
                ) from None
            raise ValueError("Couldn't reach Slack to check the tokens. Try again.") from None
        user = str(me.get("user_id") or "")
        return {"id": user, "name": f"@{me.get('user')}" if me.get("user") else "Slack app"}

    # ── receiving ──

    async def run(self) -> None:
        """Each wait before trying again is twice the last (a minute at most), and a
        connection Slack said hello on starts that over. A new socket goes at once only when
        Slack asks for one; a socket that just closes is tried again after the wait, so a
        link that keeps dropping never becomes a burst of connections."""
        self.backoff = 1.0
        while True:
            try:
                opened = await self.api("apps.connections.open", token=self.secret("app_token"))
                url = str(opened.get("url") or "")
                if not url.startswith("wss://"):
                    raise SlackError("no_socket_url")
            except SlackError as exc:
                if exc.error in REFUSED:
                    self.halted = True
                    self.set_state(
                        "error", "Slack refused the tokens. Connect it again in Settings."
                    )
                    return
                self.set_state("reconnecting", "Can't reach Slack. Trying again.")
                await self._wait()
                continue
            asked = False
            try:
                async with self._socket(url) as ws:
                    asked = await self._read(ws)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.info("slack: the socket closed (%s)", type(exc).__name__)
            if not asked:
                self.set_state("reconnecting", "Lost the connection to Slack. Reconnecting.")
                await self._wait()

    async def _wait(self) -> None:
        await asyncio.sleep(self.backoff)
        self.backoff = min(60.0, self.backoff * 2)

    async def _read(self, ws: Any) -> bool:
        """Hand on what comes in; True when Slack asks for a fresh connection."""
        async for raw in ws:
            try:
                envelope = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if not isinstance(envelope, dict):
                continue
            envelope_id = envelope.get("envelope_id")
            if envelope_id:
                await ws.send(json.dumps({"envelope_id": envelope_id}))
            kind = envelope.get("type")
            if kind == "hello":
                self.backoff = 1.0  # a good connection: a drop after it is retried promptly
                self.set_state("listening" if self.home_chat() else "needs_pairing")
            elif kind == "disconnect":
                return True  # Slack asks for a fresh connection now and then
            elif kind in ("events_api", "interactive"):
                payload = envelope.get("payload")
                if not isinstance(payload, dict):
                    continue
                try:
                    msg = self._event(payload) if kind == "events_api" else self._action(payload)
                    if msg is not None:
                        if not msg.direct and msg.mentioned and not msg.group_name:
                            msg.group_name = await self._channel_name(msg.chat)
                        await self.router.receive(msg)
                except Exception as exc:  # one odd event never stops the rest
                    log.warning("slack: couldn't handle an event (%s)", type(exc).__name__)
        return False

    def _event(self, payload: dict[str, Any]) -> Inbound | None:
        event_id = str(payload.get("event_id") or "")
        if event_id:
            if event_id in self._seen:
                return None
            self._seen.append(event_id)
        event = payload.get("event")
        if not isinstance(event, dict) or event.get("type") not in ("message", "app_mention"):
            return None
        if event.get("bot_id") or event.get("subtype") not in (None, "file_share"):
            return None  # a bot's (JARVIS's own included), an edit, a join
        bot = self.router.state.bots.get(self.name, {}).get("id")
        user = str(event.get("user") or "")
        if not user or user == bot:
            return None
        raw = str(event.get("text") or "")
        direct = event.get("channel_type") == "im"
        post = (str(event.get("channel") or ""), str(event.get("ts") or ""))
        if not direct and post[1]:
            if post in self._posts:
                return None  # a mention comes as a message and as app_mention: one is enough
            self._posts.append(post)
        mentioned = False
        if not direct:
            mark = f"<@{bot}>" if bot else ""
            mentioned = (
                event.get("type") == "app_mention"
                or bool(mark and mark in raw)
                or bool(bot and event.get("parent_user_id") == bot)
            )
            if mark:
                raw = re.sub(rf"<@{re.escape(str(bot))}(?:\|[^<>]*)?>", " ", raw).strip()
        media = []
        for item in event.get("files") or []:
            if not isinstance(item, dict):
                continue
            url = str(item.get("url_private_download") or item.get("url_private") or "")
            kind_of = str(item.get("mimetype") or "")
            kind = (
                "voice"
                if kind_of.startswith("audio/") or item.get("subtype") == "slack_audio"
                else "image"
                if kind_of.startswith("image/")
                else "file"
            )
            media.append(
                Media(
                    kind,
                    str(item.get("name") or item.get("title") or "file"),
                    kind_of,
                    self._fetcher(url),
                    size=int(item.get("size") or 0),
                )
            )
        try:
            at = float(event.get("ts") or 0)
        except (TypeError, ValueError):
            at = 0.0
        return Inbound(
            channel=self.name,
            chat=str(event.get("channel") or ""),
            sender=user,
            name=user,
            text=unescape(raw),
            at=at,
            direct=direct,
            media=media,
            team=str(payload.get("team_id") or event.get("team") or ""),
            mentioned=mentioned,
        )

    async def _channel_name(self, chat: str) -> str:
        """#general for a channel's id (channels:read; "" without it)."""
        if chat not in self._names:
            try:
                found = await self.api("conversations.info", {"channel": chat}, form=True)
                name = str((found.get("channel") or {}).get("name") or "")
            except SlackError:
                name = ""
            if len(self._names) > 200:
                self._names.clear()
            self._names[chat] = f"#{name}" if name else ""
        return self._names[chat]

    def _action(self, payload: dict[str, Any]) -> Inbound | None:
        if payload.get("type") != "block_actions":
            return None
        user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
        container = payload.get("container") if isinstance(payload.get("container"), dict) else {}
        channel = payload.get("channel") if isinstance(payload.get("channel"), dict) else {}
        chat = str(channel.get("id") or container.get("channel_id") or "")
        actions = payload.get("actions") if isinstance(payload.get("actions"), list) else []
        first = actions[0] if actions and isinstance(actions[0], dict) else {}
        m = _ACTION.fullmatch(str(first.get("action_id") or ""))
        team = payload.get("team") if isinstance(payload.get("team"), dict) else {}
        sender = str(user.get("id") or "")

        async def ack(text: str) -> None:
            if text and chat and sender:
                await self.api(
                    "chat.postEphemeral", {"channel": chat, "user": sender, "text": text}
                )

        return Inbound(
            channel=self.name,
            chat=chat,
            sender=sender,
            name=str(user.get("username") or user.get("name") or sender),
            direct=chat.startswith("D"),
            action=(m.group(1), m.group(2)) if m else ("", ""),
            ack=ack,
            reply_to=str(container.get("message_ts") or ""),
            team=str(team.get("id") or user.get("team_id") or ""),
        )

    def _fetcher(self, url: str):
        async def fetch() -> bytes:
            parts = urlsplit(url)
            if parts.scheme != "https" or parts.hostname not in FILE_HOSTS:
                raise SlackError("not_a_slack_file")  # the bot token goes to Slack alone
            headers = {"Authorization": f"Bearer {self.secret('bot_token')}"}
            data = bytearray()
            try:
                async with self.client().stream("GET", url, headers=headers, timeout=120.0) as resp:
                    if resp.status_code != 200:
                        raise SlackError(f"http_{resp.status_code}")
                    async for chunk in resp.aiter_bytes():
                        data += chunk
                        if len(data) > 30_000_000:
                            raise SlackError("too_big")
            except httpx.HTTPError as exc:
                raise SlackError(type(exc).__name__) from None
            return bytes(data)

        return fetch

    # ── sending ──

    async def send_text(
        self, chat: str, text: str, *, title: str = "", markup: bool = True
    ) -> None:
        for i, chunk in enumerate(split_text(text, LIMIT) or [""]):
            body = slack_mrkdwn(chunk) if markup else slack_escape(chunk)
            if title and i == 0:
                body = f"*{slack_escape(title)}*\n{body}".strip()
            if body:
                await self.api(
                    "chat.postMessage",
                    {"channel": chat, "text": body, "unfurl_links": False, "unfurl_media": False},
                )

    async def send_progress(self, chat: str, text: str) -> Any:
        sent = await self.api(
            "chat.postMessage",
            {"channel": chat, "text": slack_escape(text), "unfurl_links": False},
        )
        return {"id": str(sent.get("ts") or "")} if sent.get("ts") else None

    async def edit_text(self, chat: str, ref: Any, text: str, *, markup: bool = True) -> None:
        ts = str(ref.get("id") or "") if isinstance(ref, dict) else ""
        if not ts:
            raise SlackError("no_message")
        for i, chunk in enumerate(split_text(text, LIMIT) or ["…"]):
            body = slack_mrkdwn(chunk) if markup else slack_escape(chunk)
            if i == 0:
                await self.api("chat.update", {"channel": chat, "ts": ts, "text": body or "…"})
            elif body:
                await self.api(
                    "chat.postMessage",
                    {"channel": chat, "text": body, "unfurl_links": False, "unfurl_media": False},
                )

    async def send_card(self, chat: str, card: dict[str, Any], lang: str) -> Any:
        question = clip(str(card.get("question", "")), 500)
        head = f"*{slack_escape(say(NEEDS_OK, lang))}*\n{slack_escape(question)}"
        blocks: list[dict[str, Any]] = [
            {"type": "section", "text": {"type": "mrkdwn", "text": head}}
        ]
        detail = str(card.get("detail") or "").strip()
        if detail:
            shown = detail if len(detail) <= DETAIL else detail[:DETAIL] + "…"
            code = slack_escape(shown).replace("```", "`ˋ`")
            if len(code) > SECTION:  # Slack's limit for a block's text, after escaping
                code = code[:SECTION] + "…"
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": f"```{code}```"}})
        approval_id = str(card.get("id", ""))
        buttons = []
        ids = []
        for i, choice in enumerate(card.get("choices") or []):
            cid = str(choice.get("id", ""))
            if not re.fullmatch(r"[\w-]{1,24}", cid):
                continue
            ids.append(cid)
            button: dict[str, Any] = {
                "type": "button",
                "text": {"type": "plain_text", "text": clip(str(choice.get("label", "")), 70)},
                "action_id": f"a:{approval_id}:{cid}",
                "value": cid,
            }
            if i == 0:
                button["style"] = "primary"
            buttons.append(button)
        if "deny" in ids or "plan_keep" in ids:
            why = BECAUSE if "deny" in ids else BECAUSE_PLAN
            buttons.append(
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": say(why, lang)},
                    "action_id": f"a:{approval_id}:why",
                    "value": "why",
                }
            )
        shown_blocks = list(blocks)
        blocks.append({"type": "actions", "elements": buttons[:25]})
        sent = await self.api(
            "chat.postMessage",
            {"channel": chat, "text": f"{say(NEEDS_OK, lang)}: {question}", "blocks": blocks},
        )
        return {"id": str(sent.get("ts") or ""), "text": question, "blocks": shown_blocks}

    async def close_card(self, chat: str, ref: Any, outcome: str) -> None:
        if not isinstance(ref, dict) or not ref.get("id"):
            return
        blocks = [
            *ref.get("blocks", []),
            {"type": "context", "elements": [{"type": "mrkdwn", "text": slack_escape(outcome)}]},
        ]
        await self.api(
            "chat.update",
            {
                "channel": chat,
                "ts": ref["id"],
                "text": f"{ref.get('text', '')} {outcome}",
                "blocks": blocks,
            },
        )

    async def send_file(self, chat: str, path: Path, caption: str = "") -> None:
        data = await asyncio.to_thread(path.read_bytes)
        slot = await self.api(
            "files.getUploadURLExternal",
            {"filename": path.name, "length": str(len(data))},
            form=True,
        )
        upload = str(slot.get("upload_url") or "")
        parts = urlsplit(upload)
        if parts.scheme != "https" or not (parts.hostname or "").endswith("slack.com"):
            raise SlackError("bad_upload_url")
        try:
            resp = await self.client().post(upload, content=data, timeout=300.0)
        except httpx.HTTPError as exc:
            raise SlackError(type(exc).__name__) from None
        if resp.status_code != 200:
            raise SlackError(f"http_{resp.status_code}")
        await self.api(
            "files.completeUploadExternal",
            {
                "files": json.dumps(
                    [{"id": slot.get("file_id"), "title": clip(caption or path.name, 200)}]
                ),
                "channel_id": chat,
            },
            form=True,
        )

    def public(self) -> dict[str, Any]:
        return {"how": "!pair"}
