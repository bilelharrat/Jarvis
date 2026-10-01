"""WhatsApp: talking to JARVIS from the owner's own WhatsApp, through the account linked in
Tools & Accounts (jarvis.features.whatsapp: a device of the owner's own, on the existing
bridge). Nothing new is linked, installed or exposed for it.

Only the owner counts, and only where it can only be them: their own chat with themselves
("Message yourself", the note-to-self chat), where every message is the owner's. A message
anyone else writes to the owner is theirs to answer, never JARVIS's: it's never read as a
request and never replied to. JARVIS's own replies start with "Jarvis:" and are marked by the
bridge (it makes each one's id first), so they're never read back as the owner's.

Approval cards come as words and are answered by a reply: yes, no, "no, because …", or a
quoted reply to the card. /code and the other commands work as in Telegram. Pictures, voice
notes and files aren't read here (text only).

In a group (switched on for WhatsApp, and for that group, in Settings › Chats), the owner's
own message that starts with "Jarvis," or replies to one of JARVIS's messages is a request;
the answer goes to the group from the owner's account, marked "Jarvis:". A group is added
switched off the first time the owner asks there (their account is in all of their groups,
so turning one on is a choice made on the Mac).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import mimetypes
import re
import time
from collections import deque
from pathlib import Path
from typing import Any

from .base import Channel, Inbound, clip, split_text, whatsapp_text
from .words import NEEDS_OK, TEXT_ONLY, hint_for, say

log = logging.getLogger("jarvis")

TAG = "Jarvis:"  # every message JARVIS sends here starts with it
LIMIT = 4000
DETAIL = 600
LINKED_EVERY = 5.0  # seconds a look at whether WhatsApp is linked is trusted
STATE_EVERY = 2.0
TEXT_ONLY_EVERY = 600.0
_PREFIX = re.compile(
    r"^\s*@?(?:(?:hey|ok|okay)[\s,，]+)?(?:jarvis|贾维斯)(?:(?![:：])[\s,，!！.。、]+|$)",
    re.IGNORECASE,
)


class WhatsAppGone(Exception):
    """The bridge isn't connected, or didn't take the message."""


class WhatsAppChat(Channel):
    name = "whatsapp"
    title = "WhatsApp"
    limit = LIMIT
    buttons = False
    pairs = False
    groups = True
    groups_start_on = False
    max_file = 100_000_000

    def __init__(self, router: Any) -> None:
        super().__init__(router)
        self.sent: deque[str] = deque(maxlen=500)  # ids of what JARVIS sent
        self._linked: tuple[float, bool] = (-1e18, False)
        self._told_text_only = -1e18

    # ── the linked account ──

    def wa(self) -> Any:
        return getattr(self.router.hub, "whatsapp", None)

    def ready(self) -> bool:
        wa = self.wa()
        if wa is None:
            return False
        at, linked = self._linked
        if time.monotonic() - at > LINKED_EVERY:
            linked = bool(wa.linked())
            self._linked = (time.monotonic(), linked)
        return linked

    def own(self) -> set[str]:
        """The owner's own addresses: their number's, and its hidden (LID) twin."""
        wa = self.wa()
        me = (getattr(wa, "me", None) or {}) if wa is not None else {}
        found = {str(me.get(k)) for k in ("id", "lid") if me.get(k)}
        if wa is not None:
            found |= {wa.store.canon(j) for j in list(found)}
        kept = self.router.state.bots.get(self.name, {}).get("id")
        if kept:
            found.add(kept)
        return {j for j in found if j}

    def home_chat(self) -> str | None:
        wa = self.wa()
        me = (getattr(wa, "me", None) or {}) if wa is not None else {}
        jid = str(me.get("id") or "") or self.router.state.bots.get(self.name, {}).get("id", "")
        return jid or None

    def connected(self) -> None:
        super().connected()
        self._linked = (-1e18, False)

    def save_secrets(self, secrets_: dict[str, str]) -> None:
        pass  # the link's keys are the WhatsApp feature's

    def forget_secrets(self) -> None:
        pass  # stopping the chat leaves the link alone (Tools & Accounts unlinks it)

    async def verify(self, secrets_: dict[str, str]) -> dict[str, str]:
        raise ValueError("Link WhatsApp in Tools & Accounts first.")

    def public(self) -> dict[str, Any]:
        wa = self.wa()
        from ..features.whatsapp import phone_of

        home = self.home_chat() or ""
        return {
            "linked": self.ready(),
            "link_state": getattr(wa, "state", "off") if wa is not None else "off",
            "phone": phone_of(home),
            "how": "Jarvis,",
        }

    # ── receiving ──

    async def run(self) -> None:
        wa = self.wa()
        if wa is None:
            self.set_state("needs_setup")
            return
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=200)

        def heard(message: dict[str, Any]) -> None:
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(message)

        wa.listeners.append(heard)
        try:
            while True:
                self._note_state(wa)
                try:
                    message = await asyncio.wait_for(queue.get(), STATE_EVERY)
                except TimeoutError:
                    continue
                try:
                    msg = self.parse(message)
                    if msg is not None:
                        await self.router.receive(msg)
                except Exception as exc:  # one odd message never stops the rest
                    log.warning("whatsapp chat: couldn't handle a message (%s)", type(exc).__name__)
        finally:
            with contextlib.suppress(ValueError):
                wa.listeners.remove(heard)

    def _note_state(self, wa: Any) -> None:
        if wa.state == "connected":
            me = getattr(wa, "me", None) or {}
            jid = str(me.get("id") or "")
            kept = self.router.state.bots.get(self.name, {})
            if jid and kept.get("id") != jid:
                from ..features.whatsapp import phone_of

                self.router.state.bots[self.name] = {"id": jid, "name": phone_of(jid) or jid}
                self.router.save_soon()
            self.set_state("listening")
        elif wa.state == "elsewhere":
            self.set_state("error", "WhatsApp is linked in another copy of Jarvis that's running.")
        elif not self.ready():
            self.set_state("needs_setup")
        else:
            self.set_state("reconnecting", "WhatsApp is connecting.")

    def parse(self, m: dict[str, Any]) -> Inbound | None:
        """A live message as the router takes it, or None when it isn't for JARVIS."""
        mid = str(m.get("id") or "")
        text = str(m.get("text") or "")
        if not mid or m.get("jarvis") or mid in self.sent or text.startswith(TAG):
            return None  # JARVIS's own
        chat = str(m.get("chat") or "")
        own = self.own()
        mine = bool(m.get("from_me"))
        quoted_id = str(m.get("quoted_id") or "")
        if not chat.endswith("@g.us"):
            if chat not in own or not mine:
                return None  # someone writing to the owner: theirs, never JARVIS's
            if m.get("kind") == "media":
                self._text_only(chat)
                return None
            return Inbound(
                channel=self.name,
                chat=chat,
                sender=chat,
                name="you",
                text=text,
                at=float(m.get("ts") or 0),
                owner=True,
                reply_to=quoted_id,
            )
        addressed = _PREFIX.match(text)
        mentions = {str(j) for j in m.get("mentions") or []}
        mentioned = bool(addressed) or quoted_id in self.sent or bool(mentions & own)
        if addressed:
            text = text[addressed.end() :]
        quoted, quoted_by = "", ""
        sender = str(m.get("quoted_sender") or "")
        if quoted_id and quoted_id not in self.sent and sender not in own:
            quoted = str(m.get("quoted_text") or "")
            wa = self.wa()
            quoted_by = wa.store.name(sender) if wa is not None and sender else ""
        wa = self.wa()
        group_name = (wa.store.chats.get(chat, {}).get("name") if wa is not None else "") or ""
        return Inbound(
            channel=self.name,
            chat=chat,
            sender=str(m.get("sender") or "") if not mine else "me",
            name="you" if mine else "",
            text=text if m.get("kind") != "media" else "",
            at=float(m.get("ts") or 0),
            direct=False,
            owner=mine,
            mentioned=mentioned,
            group_name=str(group_name),
            quoted=quoted,
            quoted_by=quoted_by,
            reply_to=quoted_id,
        )

    def _text_only(self, chat: str) -> None:
        now = time.monotonic()
        if now - self._told_text_only < TEXT_ONLY_EVERY:
            return
        self._told_text_only = now
        self.router.spawn(self._say_text_only(chat))

    async def _say_text_only(self, chat: str) -> None:
        with contextlib.suppress(Exception):
            await self.send_text(chat, say(TEXT_ONLY, self.router.language), markup=False)

    # ── sending ──

    async def _send(self, chat: str, message: str) -> str:
        wa = self.wa()
        bridge = getattr(wa, "bridge", None) if wa is not None else None
        if bridge is None or wa.state != "connected":
            raise WhatsAppGone("not connected")
        result = await bridge.request("send", to=chat, text=message)
        if not result.get("ok"):
            raise WhatsAppGone(str(result.get("error") or "not sent")[:200])
        sent = str(result.get("id") or "")
        if sent:
            self.sent.append(sent)
        return sent

    async def send_text(
        self, chat: str, text: str, *, title: str = "", markup: bool = True
    ) -> None:
        body = whatsapp_text(text) if markup else text
        if title:
            body = f"*{title}*\n{body}"
        for chunk in split_text(body, LIMIT - len(TAG) - 1):
            await self._send(chat, f"{TAG} {chunk}")

    async def send_card(self, chat: str, card: dict[str, Any], lang: str) -> Any:
        lines = [f"{say(NEEDS_OK, lang)}: {clip(str(card.get('question', '')), 300)}"]
        detail = str(card.get("detail") or "").strip()
        if detail:
            lines.append(detail if len(detail) <= DETAIL else detail[:DETAIL] + "…")
        lines.append(hint_for(card, lang))
        body = "\n".join(lines)
        return {"id": await self._send(chat, f"{TAG} {body[: LIMIT - len(TAG) - 1]}")}

    async def send_file(self, chat: str, path: Path, caption: str = "") -> None:
        wa = self.wa()
        bridge = getattr(wa, "bridge", None) if wa is not None else None
        if bridge is None or wa.state != "connected":
            raise WhatsAppGone("not connected")
        kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        result = await bridge.request(
            "send_file",
            timeout=300,
            to=chat,
            path=str(path),
            name=path.name,
            mimetype=kind,
            caption=f"{TAG} {clip(caption, 900)}" if caption else TAG,
        )
        if not result.get("ok"):
            raise WhatsAppGone(str(result.get("error") or "not sent")[:200])
        if result.get("id"):
            self.sent.append(str(result["id"]))
