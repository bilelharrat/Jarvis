"""@-mentions that bring something along (code_mentions), for Eden Code's composer
(web/features/code-mentions.js).

- task_send and task_new: a message with @terminal, @https://… or a later @session-3 is held
  while what they bring is gathered (the terminal's last lines, the page, the other
  session's latest reply), then goes on with it attached as text documents. The same
  session's later messages wait behind it, so they keep their order; any other message
  goes on at once, untouched.
- cw_symbols {id | directory, query, ref}: where names matching a query are defined, for
  the composer's @ suggestions -> cw_symbols {ref, items}.
- cw_mentions {id, text}: a word for the window about the mentions (a page being read, one
  that couldn't be).

A page is fetched only when the message is sent, only one the owner typed, and goes to
Claude marked as web content: data, not instructions.

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from .. import code_mentions, lang
from .code_workspace import folder_of, session_of

log = logging.getLogger("jarvis")

ATTACHED_MAX = 6  # what one message carries (the hub's _attachments takes six)
_DONE = "_cw_mentions"  # set on a message once its mentions are gathered

ZH = {
    "Reading {url} for your message…": "正在为你的消息读取 {url}……",
    "Couldn't read {url}: {why}": "没能读取 {url}：{why}",
    "There's no terminal open in this project to mention.": "这个项目里没有打开的终端可以提及。",
    "There's no other session {n} to mention.": "没有别的会话 {n} 可以提及。",
    "Only six things can go with one message: {names} didn't.": "一条消息最多带六样东西：{names} 没有带上。",
    "That isn't a web address.": "那不是网址。",
    "The page answered {code}.": "网页返回了 {code}。",
    "That's not a page of text ({kind}).": "那不是文字网页（{kind}）。",
    "Couldn't reach it: {error}": "连不上：{error}",
    "It took too long to answer.": "它太久没有回应。",
}
lang.add_texts(ZH)


class Mentions:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.queues: dict[tuple[str, Any], asyncio.Task] = {}
        self.transport: Any = None  # (tests: an httpx MockTransport)

    def say(self, msg: dict[str, Any], template: str, **values: Any) -> None:
        text = lang.tr(template, self.hub.language, **values)
        self.hub.emit("cw_mentions", id=msg.get("id") or 0, text=text)

    # ── a message on its way ──

    def on_send(self, msg: dict[str, Any]) -> bool | None:
        try:
            key: Any = int(msg.get("id") or 0)
        except (TypeError, ValueError, OverflowError):  # (infinity too)
            return False
        return self._take(msg, "text", ("send", key))

    def on_new(self, msg: dict[str, Any]) -> bool | None:
        return self._take(msg, "prompt", ("new", str(msg.get("directory") or "")))

    def _take(self, msg: dict[str, Any], field: str, key: tuple[str, Any]) -> bool | None:
        """False: nothing to bring and nothing ahead of it (it goes on now); None: held."""
        if msg.get(_DONE):
            return False
        found = code_mentions.parse(str(msg.get(field) or ""))
        before = self.queues.get(key)
        if not found and before is None:
            return False
        task = self.hub._spawn(self._send(msg, found, before))
        self.queues[key] = task
        task.add_done_callback(
            lambda t: self.queues.pop(key) if self.queues.get(key) is t else None
        )
        return None

    async def _send(self, msg: dict[str, Any], found: code_mentions.Found, before: Any) -> None:
        if before is not None:
            await asyncio.wait([before])  # (in order: the one ahead of it goes first)
        docs: list[dict[str, str]] = []
        if found:
            try:
                docs = await self._gather(msg, found)
            except Exception:  # whatever went wrong, the message itself still goes
                log.exception("Eden Code: couldn't gather a message's mentions")
        own = [i for i in msg.get("images") or [] if isinstance(i, dict)]
        room = max(0, ATTACHED_MAX - len(own))
        if len(docs) > room:
            left = ", ".join(d["name"] for d in docs[room:])
            self.say(msg, "Only six things can go with one message: {names} didn't.", names=left)
            docs = docs[:room]
        await self.hub._handle_logged({**msg, _DONE: True, "images": [*own, *docs]})

    async def _gather(
        self, msg: dict[str, Any], found: code_mentions.Found
    ) -> list[dict[str, str]]:
        docs: list[dict[str, str]] = []
        session = session_of(self.hub, msg)
        if found.terminal:
            shells = getattr(getattr(self.hub, "code_terminal", None), "shells", None)
            try:
                folder = folder_of(self.hub, msg)
            except ValueError:
                folder = None
            shell = shells.latest(folder) if shells is not None and folder is not None else None
            if shell is None:
                self.say(msg, "There's no terminal open in this project to mention.")
            else:
                text = await asyncio.to_thread(shell.text)
                docs.append(code_mentions.terminal_document(shell.title, folder.name, text))
        for n in found.sessions:
            other = self.hub.tasks.tasks.get(n)
            if (
                other is None
                or other.kind != "code"
                or (session is not None and other.id == session.id)
            ):
                self.say(msg, "There's no other session {n} to mention.", n=n)
                continue
            docs.append(code_mentions.session_document(other))
        if found.urls:
            for url in found.urls:
                self.say(msg, "Reading {url} for your message…", url=url)
            fetched = await code_mentions.fetch_all(found.urls, self.transport)
            for url, doc, why in fetched:
                if doc is not None:
                    docs.append(doc)
                else:
                    why = lang.translate(why, self.hub.language)
                    self.say(msg, "Couldn't read {url}: {why}", url=url, why=why)
        return docs

    # ── the composer's suggestions ──

    async def cmd_symbols(self, msg: dict[str, Any]) -> None:
        ref = str(msg.get("ref") or "")[:200]
        try:
            root = folder_of(self.hub, msg)
        except ValueError:
            self.hub.emit("cw_symbols", ref=ref, items=[])
            return
        query = str(msg.get("query") or "")[:100]
        items = await asyncio.to_thread(code_mentions.symbols, root, query)
        self.hub.emit("cw_symbols", ref=ref, items=items)


def install(hub: Any) -> None:
    mentions = Mentions(hub)
    hub.code_mentions = mentions
    hub.register_command("task_send", mentions.on_send)
    hub.register_command("task_new", mentions.on_new)
    hub.register_command("cw_symbols", lambda msg: hub._spawn(mentions.cmd_symbols(msg)))
