"""Discord: a bot of the owner's own (from the Discord Developer Portal), its token in the
Keychain, talking to the Gateway over a WebSocket, so nothing on the Mac listens to the
internet. It asks for direct messages only (the DIRECT_MESSAGES intent: a DM's text comes
without the privileged message-content intent), and only the one Discord user who paired
counts. Server channels are ignored.

The connection keeps its heartbeat, resumes where it left off after a drop, and starts a new
session when Discord says so; a refused token stops it until it's connected again. Every
message it sends has mentions switched off, so nothing JARVIS writes can ping anyone. Cards
get buttons, answered over the Gateway. Commands are written with "!" (!stop, !status…):
Discord keeps "/" for its own.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import mimetypes
import random
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from .base import Channel, Inbound, Media, clip, discord_safe, split_text, utf16_len
from .words import BECAUSE, BECAUSE_PLAN, NEEDS_OK, say

log = logging.getLogger("jarvis")

API = "https://discord.com/api/v10"
QUERY = "?v=10&encoding=json"
INTENTS = 1 << 12  # DIRECT_MESSAGES
LIMIT = 2000
DETAIL = 1200
FILE_HOSTS = ("cdn.discordapp.com", "media.discordapp.net")
VOICE_MESSAGE = 1 << 13  # a message flag: a voice message
FATAL = {
    4004: "Discord refused the bot token. Connect it again in Settings.",
    4010: "Discord refused the connection (invalid shard).",
    4011: "Discord wants this bot sharded; that isn't supported.",
    4012: "Discord refused the connection (API version).",
    4013: "Discord refused the connection (intents).",
    4014: "Discord refused the connection (an intent that isn't allowed).",
}
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{20,40}\.[A-Za-z0-9_-]{4,10}\.[A-Za-z0-9_-]{20,60}$")
_ACTION = re.compile(r"^a:([0-9a-f]{6,32}):([\w-]{1,24})$")


class DiscordError(Exception):
    def __init__(self, status: int, what: str = "") -> None:
        super().__init__(f"{status} {what}")
        self.status = status


class Reconnect(Exception):
    """The connection has to be made again (resume: whether the session carries on)."""

    def __init__(self, resume: bool) -> None:
        super().__init__("reconnect")
        self.resume = resume


def _offline(_request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("no network for a hub that doesn't poll")


class NoSocket:
    async def __aenter__(self) -> Any:
        raise OSError("no network for a hub that doesn't poll")

    async def __aexit__(self, *_exc: Any) -> bool:
        return False


def _time(stamp: Any) -> float:
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return 0.0


class Discord(Channel):
    name = "discord"
    title = "Discord"
    limit = LIMIT
    buttons = True
    typing_every = 8.0
    command_mark = "!"
    max_file = 10_000_000
    vault_id = "channel-discord"
    secret_keys = ("token",)

    def __init__(self, router: Any) -> None:
        super().__init__(router)
        self.transport: httpx.AsyncBaseTransport | None = None  # tests: a MockTransport
        self.connect: Any = None  # tests: a fake socket; else websockets
        self._client: httpx.AsyncClient | None = None
        self.session: dict[str, Any] = {"id": "", "seq": None, "url": ""}
        self.me = ""
        self.heartbeat_every = 41.25
        self.backoff = 1.0  # seconds before the next try at connecting

    def home_chat(self) -> str | None:
        owner = self.router.state.owners.get(self.name)
        return owner.chat if owner else None

    def connected(self) -> None:
        super().connected()
        self._client = None
        self.session = {"id": "", "seq": None, "url": ""}

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

        return connect(url, max_size=8 * 1024 * 1024, open_timeout=20)

    # ── REST ──

    async def api(
        self,
        method: str,
        path: str,
        payload: Any = None,
        *,
        token: str = "",
        files: Any = None,
        auth: bool = True,
    ) -> Any:
        """A REST call as the bot (auth False: an interaction's answer, which carries its
        own token in the address)."""
        token = token or (self.secret("token") if auth else "")
        headers = {"Authorization": f"Bot {token}"} if auth and token else {}
        for attempt in range(2):
            try:
                if files is not None:
                    resp = await self.client().request(
                        method,
                        f"{API}{path}",
                        data=payload,
                        files=files,
                        headers=headers,
                        timeout=300.0,
                    )
                else:
                    resp = await self.client().request(
                        method, f"{API}{path}", json=payload, headers=headers
                    )
            except httpx.HTTPError as exc:
                raise DiscordError(0, type(exc).__name__) from None
            if resp.status_code == 429 and attempt == 0:
                try:
                    wait = float(resp.json().get("retry_after") or 1)
                except (ValueError, AttributeError):
                    wait = 1.0
                await asyncio.sleep(min(30.0, wait))
                continue
            if resp.status_code >= 400:
                raise DiscordError(resp.status_code)
            if resp.status_code == 204 or not resp.content:
                return {}
            try:
                return resp.json()
            except ValueError:
                return {}
        raise DiscordError(429)

    async def verify(self, secrets_: dict[str, str]) -> dict[str, str]:
        token = (secrets_.get("token") or "").strip()
        if not _TOKEN.fullmatch(token):
            raise ValueError(
                "That doesn't look like a Discord bot token. Copy it from the Developer "
                "Portal › your app › Bot › Reset Token."
            )
        try:
            me = await self.api("GET", "/users/@me", token=token)
        except DiscordError as exc:
            if exc.status in (401, 403):
                raise ValueError("Discord didn't accept that token. Copy it again.") from None
            raise ValueError("Couldn't reach Discord to check the token. Try again.") from None
        name = str(me.get("username") or "bot")
        return {"id": str(me.get("id") or ""), "name": f"@{name}"}

    # ── the Gateway ──

    async def run(self) -> None:
        """Each wait before trying again is twice the last (a minute at most); a connection
        Discord said READY or RESUMED on starts that over."""
        self.backoff = 1.0
        while True:
            resume = bool(self.session.get("id") and self.session.get("url"))
            try:
                if resume:
                    url = self.session["url"]
                else:
                    found = await self.api("GET", "/gateway/bot")
                    url = str(found.get("url") or "wss://gateway.discord.gg")
                if not url.startswith("wss://"):
                    raise DiscordError(0, "no gateway")
                async with self._socket(url.rstrip("/") + "/" + QUERY) as ws:
                    await self._session(ws, resume)
            except asyncio.CancelledError:
                raise
            except Reconnect as again:
                if not again.resume:
                    self.session = {"id": "", "seq": None, "url": ""}
                await asyncio.sleep(0.5 if again.resume else 1 + random.random() * 4)
                continue
            except DiscordError as exc:
                if exc.status in (401, 403):
                    self.halted = True
                    self.set_state("error", FATAL[4004])
                    return
                self.set_state("reconnecting", "Can't reach Discord. Trying again.")
            except Exception as exc:
                code = getattr(getattr(exc, "rcvd", None), "code", None)
                if code in FATAL:
                    self.halted = True
                    self.set_state("error", FATAL[code])
                    return
                if code in (4007, 4009):  # a sequence or session Discord no longer knows
                    self.session = {"id": "", "seq": None, "url": ""}
                log.info("discord: the connection closed (%s %s)", type(exc).__name__, code or "")
                self.set_state("reconnecting", "Lost the connection to Discord. Reconnecting.")
            await asyncio.sleep(self.backoff)
            self.backoff = min(60.0, self.backoff * 2)

    async def _session(self, ws: Any, resume: bool) -> None:
        hello = json.loads(await ws.recv())
        if hello.get("op") != 10:
            raise Reconnect(resume)
        self.heartbeat_every = max(
            1.0, float((hello.get("d") or {}).get("heartbeat_interval", 41250)) / 1000
        )
        token = self.secret("token")
        if resume:
            await ws.send(
                json.dumps(
                    {
                        "op": 6,
                        "d": {
                            "token": token,
                            "session_id": self.session["id"],
                            "seq": self.session["seq"],
                        },
                    }
                )
            )
        else:
            await ws.send(
                json.dumps(
                    {
                        "op": 2,
                        "d": {
                            "token": token,
                            "intents": INTENTS,
                            "properties": {"os": "macos", "browser": "jarvis", "device": "jarvis"},
                        },
                    }
                )
            )
        acked = asyncio.Event()
        acked.set()
        beat = asyncio.get_running_loop().create_task(self._heartbeat(ws, acked))
        try:
            async for raw in ws:
                if beat.done():
                    raise Reconnect(True)  # no answer to a heartbeat: a dead connection
                await self._handle(ws, json.loads(raw), acked)
        finally:
            beat.cancel()
            with contextlib.suppress(BaseException):
                await beat
        raise Reconnect(True)

    async def _heartbeat(self, ws: Any, acked: asyncio.Event) -> None:
        await asyncio.sleep(self.heartbeat_every * random.random())
        while True:
            if not acked.is_set():
                with contextlib.suppress(Exception):
                    await ws.close(code=4000)
                return
            acked.clear()
            await ws.send(json.dumps({"op": 1, "d": self.session.get("seq")}))
            await asyncio.sleep(self.heartbeat_every)

    async def _handle(self, ws: Any, packet: Any, acked: asyncio.Event) -> None:
        if not isinstance(packet, dict):
            return
        if packet.get("s") is not None:
            self.session["seq"] = packet["s"]
        op = packet.get("op")
        if op == 11:
            acked.set()
        elif op == 1:
            await ws.send(json.dumps({"op": 1, "d": self.session.get("seq")}))
        elif op == 7:
            raise Reconnect(True)
        elif op == 9:
            raise Reconnect(bool(packet.get("d")))
        elif op == 0:
            await self._dispatch(str(packet.get("t") or ""), packet.get("d") or {})

    async def _dispatch(self, kind: str, data: Any) -> None:
        if not isinstance(data, dict):
            return
        if kind == "READY":
            self.session["id"] = str(data.get("session_id") or "")
            self.session["url"] = str(data.get("resume_gateway_url") or "")
            self.me = str((data.get("user") or {}).get("id") or "")
            self.backoff = 1.0  # a good connection: a drop after it is retried promptly
            self.set_state("listening" if self.home_chat() else "needs_pairing")
        elif kind == "RESUMED":
            self.backoff = 1.0
            self.set_state("listening" if self.home_chat() else "needs_pairing")
        elif kind in ("MESSAGE_CREATE", "INTERACTION_CREATE"):
            try:
                if kind == "MESSAGE_CREATE":
                    msg = self._message(data)
                    if msg is not None:
                        await self.router.receive(msg)
                else:
                    await self._interaction(data)
            except Exception as exc:  # one odd event never stops the rest
                log.warning("discord: couldn't handle an event (%s)", type(exc).__name__)

    def _message(self, data: dict[str, Any]) -> Inbound | None:
        author = data.get("author") if isinstance(data.get("author"), dict) else {}
        me = self.me or self.router.state.bots.get(self.name, {}).get("id", "")
        if author.get("bot") or not author.get("id") or str(author.get("id")) == me:
            return None
        text = str(data.get("content") or "")
        reference = (
            data.get("message_reference") if isinstance(data.get("message_reference"), dict) else {}
        )
        snapshots = (
            data.get("message_snapshots") if isinstance(data.get("message_snapshots"), list) else []
        )
        forwarded = bool(snapshots) or reference.get("type") == 1
        attachments = list(data.get("attachments") or [])
        if forwarded and snapshots:
            inner = (snapshots[0] or {}).get("message") or {}
            text = str(inner.get("content") or text)
            attachments += list(inner.get("attachments") or [])
        media = []
        voice_flag = int(data.get("flags") or 0) & VOICE_MESSAGE
        for item in attachments:
            if not isinstance(item, dict):
                continue
            kind_of = str(item.get("content_type") or "")
            kind = (
                "voice"
                if voice_flag or kind_of.startswith("audio/")
                else "image"
                if kind_of.startswith("image/")
                else "file"
            )
            media.append(
                Media(
                    kind,
                    str(item.get("filename") or "file"),
                    kind_of,
                    self._fetcher(str(item.get("url") or "")),
                    size=int(item.get("size") or 0),
                    seconds=float(item.get("duration_secs") or 0),
                )
            )
        return Inbound(
            channel=self.name,
            chat=str(data.get("channel_id") or ""),
            sender=str(author.get("id")),
            name=str(author.get("global_name") or author.get("username") or author.get("id")),
            text=text,
            at=_time(data.get("timestamp")),
            direct="guild_id" not in data,
            media=media,
            forwarded=forwarded,
            reply_to=str(reference.get("message_id") or "")
            if reference.get("type", 0) == 0
            else "",
        )

    async def _interaction(self, data: dict[str, Any]) -> None:
        if data.get("type") != 3:  # a button on a message
            return
        user = data.get("user") or (data.get("member") or {}).get("user") or {}
        found = _ACTION.fullmatch(str((data.get("data") or {}).get("custom_id") or ""))
        interaction, token = str(data.get("id") or ""), str(data.get("token") or "")
        answered = False

        async def ack(text: str) -> None:
            nonlocal answered
            if answered or not interaction or not token:
                return
            answered = True
            body: dict[str, Any] = (
                {
                    "type": 4,
                    "data": {
                        "content": text[:1900],
                        "flags": 64,
                        "allowed_mentions": {"parse": []},
                    },
                }
                if text
                else {"type": 6}
            )
            await self.api(
                "POST", f"/interactions/{interaction}/{token}/callback", body, auth=False
            )

        msg = Inbound(
            channel=self.name,
            chat=str(data.get("channel_id") or ""),
            sender=str(user.get("id") or ""),
            name=str(user.get("global_name") or user.get("username") or ""),
            direct="guild_id" not in data,
            action=(found.group(1), found.group(2)) if found else ("", ""),
            ack=ack,
            reply_to=str((data.get("message") or {}).get("id") or ""),
        )
        await self.router.receive(msg)
        await ack("")  # Discord wants every button press answered within three seconds

    def _fetcher(self, url: str):
        async def fetch() -> bytes:
            parts = urlsplit(url)
            if parts.scheme != "https" or parts.hostname not in FILE_HOSTS:
                raise DiscordError(0, "not a Discord file")
            data = bytearray()
            try:
                async with self.client().stream("GET", url, timeout=120.0) as resp:
                    if resp.status_code != 200:
                        raise DiscordError(resp.status_code)
                    async for chunk in resp.aiter_bytes():
                        data += chunk
                        if len(data) > 30_000_000:
                            raise DiscordError(0, "too big")
            except httpx.HTTPError as exc:
                raise DiscordError(0, type(exc).__name__) from None
            return bytes(data)

        return fetch

    # ── sending ──

    async def send_text(
        self, chat: str, text: str, *, title: str = "", markup: bool = True
    ) -> None:
        head = f"**{discord_safe(title)}**\n" if title else ""
        room = LIMIT - utf16_len(head)
        text = text if markup else discord_safe(text)  # before cutting: it can grow a little
        for i, chunk in enumerate(split_text(text, room, utf16_len) or [""]):
            body = (head if i == 0 else "") + chunk
            if body.strip():
                await self.api(
                    "POST",
                    f"/channels/{chat}/messages",
                    {"content": body, "allowed_mentions": {"parse": []}},
                )

    async def send_card(self, chat: str, card: dict[str, Any], lang: str) -> Any:
        question = clip(str(card.get("question", "")), 500)
        content = f"**{say(NEEDS_OK, lang)}**\n{discord_safe(question)}"
        detail = str(card.get("detail") or "").strip()
        if detail:
            shown = detail if len(detail) <= DETAIL else detail[:DETAIL] + "…"
            content += "\n```\n" + shown.replace("```", "`ˋ`") + "\n```"
        approval_id = str(card.get("id", ""))
        buttons, ids = [], []
        for i, choice in enumerate(card.get("choices") or []):
            cid = str(choice.get("id", ""))
            if not re.fullmatch(r"[\w-]{1,24}", cid):
                continue
            ids.append(cid)
            style = 1 if i == 0 else 4 if cid == "deny" else 2
            buttons.append(
                {
                    "type": 2,
                    "style": style,
                    "label": clip(str(choice.get("label", "")), 80),
                    "custom_id": f"a:{approval_id}:{cid}",
                }
            )
        if "deny" in ids or "plan_keep" in ids:
            why = BECAUSE if "deny" in ids else BECAUSE_PLAN
            buttons.append(
                {
                    "type": 2,
                    "style": 2,
                    "label": say(why, lang),
                    "custom_id": f"a:{approval_id}:why",
                }
            )
        rows = [
            {"type": 1, "components": buttons[i : i + 5]}
            for i in range(0, min(len(buttons), 25), 5)
        ]
        sent = await self.api(
            "POST",
            f"/channels/{chat}/messages",
            {"content": content[:LIMIT], "components": rows, "allowed_mentions": {"parse": []}},
        )
        return {"id": str(sent.get("id") or ""), "text": content[: LIMIT - 200]}

    async def close_card(self, chat: str, ref: Any, outcome: str) -> None:
        if not isinstance(ref, dict) or not ref.get("id"):
            return
        await self.api(
            "PATCH",
            f"/channels/{chat}/messages/{ref['id']}",
            {
                "content": f"{ref.get('text', '')}\n*{discord_safe(outcome)}*",
                "components": [],
                "allowed_mentions": {"parse": []},
            },
        )

    async def typing(self, chat: str) -> None:
        await self.api("POST", f"/channels/{chat}/typing")

    async def send_file(self, chat: str, path: Path, caption: str = "") -> None:
        data = await asyncio.to_thread(path.read_bytes)
        kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        payload = {
            "content": discord_safe(clip(caption, 1800)),
            "allowed_mentions": {"parse": []},
            "attachments": [{"id": 0, "filename": path.name}],
        }
        await self.api(
            "POST",
            f"/channels/{chat}/messages",
            {"payload_json": json.dumps(payload)},
            files={"files[0]": (path.name, data, kind)},
        )

    def public(self) -> dict[str, Any]:
        return {"how": "!pair"}
