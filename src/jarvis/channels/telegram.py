"""Telegram: the owner's own bot, made with @BotFather, its token in the Keychain.

Updates are long-polled with getUpdates (no webhook: nothing on the Mac listens to the
internet), one request at a time, and where it got to is kept, so a restart neither misses
nor repeats a message. Replies use Telegram's HTML with everything escaped (plain text if
Telegram still can't parse it), cut at 4,096 characters as Telegram counts them. Cards get
inline buttons, "No, because…" asks for the reason in a reply box, and "typing…" shows while
JARVIS works. The token is part of every address Telegram's API uses, so no address, and
no error that could hold one, is ever logged or shown.
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import re
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from .base import (
    Channel,
    Inbound,
    Media,
    clip,
    plain_text,
    split_text,
    telegram_escape,
    telegram_html,
    utf16_len,
)
from .words import BECAUSE, BECAUSE_PLAN, NEEDS_OK, say

log = logging.getLogger("jarvis")

API = "https://api.telegram.org"
POLL_SECONDS = 50
LIMIT = 4096
MAX_DOWNLOAD = 20_000_000  # what the Bot API lets a bot download
DETAIL = 1500  # characters of a card's detail shown
_TOKEN = re.compile(r"^\d{5,12}:[A-Za-z0-9_-]{30,64}$")
_TOKEN_ANYWHERE = re.compile(r"\d{5,12}:[A-Za-z0-9_-]{30,64}")
_ACTION = re.compile(r"^a:([0-9a-f]{6,32}):([\w-]{1,24})$")


class TelegramError(Exception):
    def __init__(self, status: int, description: str = "", retry_after: int = 0) -> None:
        super().__init__(f"{status} {description}")
        self.status, self.description, self.retry_after = status, description, retry_after


def _offline(_request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("no network for a hub that doesn't poll")


def _name(user: dict[str, Any]) -> str:
    name = " ".join(str(user.get(k) or "") for k in ("first_name", "last_name")).strip()
    handle = f"@{user['username']}" if user.get("username") else ""
    return f"{name} ({handle})" if name and handle else name or handle or str(user.get("id", ""))


class Telegram(Channel):
    name = "telegram"
    title = "Telegram"
    limit = LIMIT
    buttons = True
    typing_every = 4.5
    max_file = 50_000_000
    vault_id = "channel-telegram"
    secret_keys = ("token",)

    def __init__(self, router: Any) -> None:
        super().__init__(router)
        self.transport: httpx.AsyncBaseTransport | None = None  # tests: a MockTransport
        self._client: httpx.AsyncClient | None = None

    # ── set-up ──

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
                transport=transport,
                timeout=httpx.Timeout(20.0, read=POLL_SECONDS + 15.0),
                follow_redirects=False,
            )
        return self._client

    async def verify(self, secrets_: dict[str, str]) -> dict[str, str]:
        token = (secrets_.get("token") or "").strip()
        if not _TOKEN.fullmatch(token):
            raise ValueError(
                "That doesn't look like a bot token. @BotFather gives one like 123456789:AAE…"
            )
        try:
            me = await self.api("getMe", token=token)
        except TelegramError as exc:
            if exc.status in (401, 404):
                raise ValueError(
                    "Telegram didn't accept that token. Copy it again from @BotFather."
                ) from None
            raise ValueError("Couldn't reach Telegram to check the token. Try again.") from None
        username = str((me or {}).get("username") or "")
        return {
            "id": str((me or {}).get("id", "")),
            "name": f"@{username}" if username else str((me or {}).get("first_name", "bot")),
        }

    # ── the Bot API ──

    async def api(
        self,
        method: str,
        payload: dict[str, Any] | None = None,
        *,
        token: str = "",
        files: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Any:
        token = token or self.secret("token")
        if not token:
            raise TelegramError(401, "no token")
        url = f"{API}/bot{token}/{method}"
        extra: dict[str, Any] = {} if timeout is None else {"timeout": timeout}
        try:
            if files is not None:
                resp = await self.client().post(url, data=payload or {}, files=files, **extra)
            else:
                resp = await self.client().post(url, json=payload or {}, **extra)
        except httpx.HTTPError as exc:
            raise TelegramError(
                0, type(exc).__name__
            ) from None  # never the URL: it holds the token
        try:
            body = resp.json()
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        if resp.status_code == 200 and body.get("ok"):
            return body.get("result")
        params = body.get("parameters") if isinstance(body.get("parameters"), dict) else {}
        described = _TOKEN_ANYWHERE.sub("…", str(body.get("description") or ""))[:300]
        raise TelegramError(resp.status_code, described, int(params.get("retry_after") or 0))

    async def call(self, method: str, payload: dict[str, Any], **kw: Any) -> Any:
        """A call that waits out one "too many requests" before giving up."""
        try:
            return await self.api(method, payload, **kw)
        except TelegramError as exc:
            if exc.status != 429:
                raise
            await asyncio.sleep(min(30, max(1, exc.retry_after)))
            return await self.api(method, payload, **kw)

    # ── receiving ──

    async def run(self) -> None:
        backoff = 1.0
        while True:
            offset = self.router.state.offsets.get(self.name, 0)
            try:
                updates = await self.api(
                    "getUpdates",
                    {
                        "offset": offset,
                        "timeout": POLL_SECONDS,
                        "allowed_updates": ["message", "callback_query"],
                    },
                    timeout=POLL_SECONDS + 15.0,
                )
            except TelegramError as exc:
                if exc.status in (401, 404):
                    self.halted = True
                    self.set_state(
                        "error", "Telegram refused the bot token. Connect it again in Settings."
                    )
                    return
                if exc.status == 409:
                    self.set_state(
                        "error",
                        "Something else is reading this bot's messages (a webhook, or Jarvis on "
                        "another Mac). Give Jarvis a bot of its own.",
                    )
                    await asyncio.sleep(30)
                    continue
                if exc.status == 429:
                    await asyncio.sleep(min(60, max(1, exc.retry_after)))
                    continue
                self.set_state("reconnecting", "Can't reach Telegram. Trying again.")
                await asyncio.sleep(backoff)
                backoff = min(60.0, backoff * 2)
                continue
            backoff = 1.0
            self.set_state("listening" if self.home_chat() else "needs_pairing")
            await self.handle_updates(updates)

    async def handle_updates(self, updates: Any) -> None:
        for update in updates if isinstance(updates, list) else []:
            if not isinstance(update, dict) or type(update.get("update_id")) is not int:
                continue
            self.router.state.offsets[self.name] = update["update_id"] + 1
            self.router.save_soon()
            try:
                msg = self.parse(update)
                if msg is not None:
                    await self.router.receive(msg)
            except Exception as exc:  # one odd update never stops the rest
                log.warning("telegram: couldn't handle an update (%s)", type(exc).__name__)

    def parse(self, update: dict[str, Any]) -> Inbound | None:
        query = update.get("callback_query")
        if isinstance(query, dict):
            return self._button(query)
        message = update.get("message")
        if not isinstance(message, dict):
            return None
        chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
        sender = message.get("from") if isinstance(message.get("from"), dict) else {}
        media: list[Media] = []
        voice = message.get("voice") or message.get("audio")
        if isinstance(voice, dict) and voice.get("file_id"):
            media.append(
                Media(
                    "voice",
                    str(voice.get("file_name") or "voice note"),
                    str(voice.get("mime_type") or "audio/ogg"),
                    self._fetcher(str(voice["file_id"])),
                    size=int(voice.get("file_size") or 0),
                    seconds=float(voice.get("duration") or 0),
                )
            )
        photos = [p for p in message.get("photo") or [] if isinstance(p, dict) and p.get("file_id")]
        if photos:
            fit = [p for p in photos if max(p.get("width", 0), p.get("height", 0)) <= 1600]
            best = (fit or photos[:1])[-1]
            media.append(
                Media(
                    "image",
                    "photo.jpg",
                    "image/jpeg",
                    self._fetcher(str(best["file_id"])),
                    size=int(best.get("file_size") or 0),
                )
            )
        document = message.get("document")
        if isinstance(document, dict) and document.get("file_id"):
            media.append(
                Media(
                    "file",
                    str(document.get("file_name") or "file"),
                    str(document.get("mime_type") or ""),
                    self._fetcher(str(document["file_id"])),
                    size=int(document.get("file_size") or 0),
                )
            )
        reply = (
            message.get("reply_to_message")
            if isinstance(message.get("reply_to_message"), dict)
            else {}
        )
        forwarded = any(
            message.get(k)
            for k in ("forward_origin", "forward_from", "forward_sender_name", "forward_date")
        )
        return Inbound(
            channel=self.name,
            chat=str(chat.get("id", "")),
            sender=str(sender.get("id", "")),
            name=_name(sender),
            text=str(message.get("text") or message.get("caption") or ""),
            at=float(message.get("date") or 0),
            direct=chat.get("type") == "private" and not message.get("sender_chat"),
            media=media,
            forwarded=forwarded,
            reply_to=str(reply.get("message_id", "")) if reply else "",
        )

    def _button(self, query: dict[str, Any]) -> Inbound:
        message = query.get("message") if isinstance(query.get("message"), dict) else {}
        chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
        sender = query.get("from") if isinstance(query.get("from"), dict) else {}
        m = _ACTION.fullmatch(str(query.get("data") or ""))
        query_id = str(query.get("id") or "")

        async def ack(text: str) -> None:
            payload: dict[str, Any] = {"callback_query_id": query_id}
            if text:
                payload["text"] = text[:190]
            await self.api("answerCallbackQuery", payload)

        return Inbound(
            channel=self.name,
            chat=str(chat.get("id", "")),
            sender=str(sender.get("id", "")),
            name=_name(sender),
            direct=chat.get("type") == "private",
            action=(m.group(1), m.group(2)) if m else ("", ""),
            ack=ack,
            reply_to=str(message.get("message_id", "")),
        )

    def _fetcher(self, file_id: str):
        async def fetch() -> bytes:
            info = await self.api("getFile", {"file_id": file_id})
            path = str((info or {}).get("file_path") or "")
            if not path or ".." in path or int((info or {}).get("file_size") or 0) > MAX_DOWNLOAD:
                raise TelegramError(0, "not a file it can fetch")
            url = f"{API}/file/bot{self.secret('token')}/{quote(path)}"
            data = bytearray()
            try:
                async with self.client().stream("GET", url, timeout=120.0) as resp:
                    if resp.status_code != 200:
                        raise TelegramError(resp.status_code, "download failed")
                    async for chunk in resp.aiter_bytes():
                        data += chunk
                        if len(data) > MAX_DOWNLOAD:
                            raise TelegramError(0, "too big")
            except httpx.HTTPError as exc:
                raise TelegramError(0, type(exc).__name__) from None
            return bytes(data)

        return fetch

    # ── sending ──

    async def _send_html(
        self, chat: str, html_text: str, plain: str, reply_markup: dict[str, Any] | None = None
    ) -> Any:
        payload: dict[str, Any] = {
            "chat_id": chat,
            "text": html_text,
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": True},
        }
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        try:
            return await self.call("sendMessage", payload)
        except TelegramError as exc:
            if exc.status != 400 or "pars" not in exc.description.lower():
                raise
        payload.pop("parse_mode")
        payload["text"] = plain  # Telegram couldn't read the markup: the words, unformatted
        return await self.call("sendMessage", payload)

    async def send_text(
        self, chat: str, text: str, *, title: str = "", markup: bool = True
    ) -> None:
        room = LIMIT - (utf16_len(title) + 1 if title else 0)
        for i, chunk in enumerate(split_text(text, room, utf16_len) or [""]):
            head, plain_head = "", ""
            if title and i == 0:
                head, plain_head = f"<b>{telegram_escape(title)}</b>\n", f"{title}\n"
            if not chunk and not head:
                continue
            body = telegram_html(chunk) if markup else telegram_escape(chunk)
            plain = plain_text(chunk) if markup else chunk
            await self._send_html(chat, (head + body).strip(), (plain_head + plain).strip())

    async def send_card(self, chat: str, card: dict[str, Any], lang: str) -> Any:
        question = clip(str(card.get("question", "")), 500)
        detail = str(card.get("detail") or "").strip()
        text = f"<b>{telegram_escape(say(NEEDS_OK, lang))}</b>\n{telegram_escape(question)}"
        plain = f"{say(NEEDS_OK, lang)}\n{question}"
        if detail:
            shown = detail if len(detail) <= DETAIL else detail[:DETAIL] + "…"
            text += f"\n<pre>{telegram_escape(shown)}</pre>"
            plain += f"\n{shown}"
        approval_id = str(card.get("id", ""))
        rows = [
            [
                {
                    "text": clip(str(c.get("label", "")), 60),
                    "callback_data": f"a:{approval_id}:{c.get('id')}",
                }
            ]
            for c in card.get("choices") or []
            if re.fullmatch(r"[\w-]{1,24}", str(c.get("id", "")))
        ]
        ids = {c.get("id") for c in card.get("choices") or []}
        if "deny" in ids or "plan_keep" in ids:
            why = BECAUSE if "deny" in ids else BECAUSE_PLAN
            rows.append([{"text": say(why, lang), "callback_data": f"a:{approval_id}:why"}])
        sent = await self._send_html(chat, text, plain, {"inline_keyboard": rows})
        return {"id": str((sent or {}).get("message_id", "")), "text": text}

    async def close_card(self, chat: str, ref: Any, outcome: str) -> None:
        message_id = int(ref.get("id") or 0) if isinstance(ref, dict) else 0
        if not message_id:
            return
        try:
            await self.call(
                "editMessageText",
                {
                    "chat_id": chat,
                    "message_id": message_id,
                    "text": f"{ref.get('text', '')}\n\n<i>{telegram_escape(outcome)}</i>",
                    "parse_mode": "HTML",
                    "reply_markup": {"inline_keyboard": []},
                },
            )
        except TelegramError:
            await self.call(
                "editMessageReplyMarkup",
                {
                    "chat_id": chat,
                    "message_id": message_id,
                    "reply_markup": {"inline_keyboard": []},
                },
            )

    async def ask_reason(self, chat: str, text: str) -> None:
        await self.call(
            "sendMessage",
            {"chat_id": chat, "text": text, "reply_markup": {"force_reply": True}},
        )

    async def typing(self, chat: str) -> None:
        await self.api("sendChatAction", {"chat_id": chat, "action": "typing"})

    async def send_file(self, chat: str, path: Path, caption: str = "") -> None:
        data = await asyncio.to_thread(path.read_bytes)
        kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        await self.call(
            "sendDocument",
            {"chat_id": chat, "caption": clip(caption, 1000)},
            files={"document": (path.name, data, kind)},
            timeout=300.0,
        )

    def public(self) -> dict[str, Any]:
        return {"how": "/pair"}
