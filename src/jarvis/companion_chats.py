"""The Mac's past conversations from the phone, as Conversations shows them in the window:
listed and searched, read, carried on, renamed, pinned, deleted, and a new one started.

- GET /api/chats?q=: {items: [{session_id, title, preview, at (ms), current, pinned}]},
  pinned first, then newest.
- GET /api/chats/one?id=: {session_id, title, current, entries: [{role, text}]} (None
  readable: error "unreadable").
- POST /api/chats/resume {session_id}: carries it on as the current conversation, after the
  Mac's own card ("Carry on the conversation …?"), which the phone answers like any other.
- POST /api/chats/manage {session_id, action: rename|pin|delete, title?, pinned?}
  (features/conversation_manage.py).
- POST /api/chats/new: a new conversation, as the window's New conversation.

Claude cost policy: no model is called here.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from . import conversation_past as past
from .conversation_state import title_line, valid_id
from .remote import JSONResponse  # (an answer with half an emoji in it is still sent)

log = logging.getLogger("jarvis")

LISTED = 100


def _bad(reason: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": reason}, status_code=status)


def routes(api: Any) -> list[Route]:
    hub = api.hub

    def convo() -> Any:
        return getattr(hub, "conversation", None)

    def pins() -> list[str]:
        manage = getattr(hub, "conversation_manage", None)
        return list(getattr(manage, "pins", []) or [])

    async def chats(request: Request) -> Response:
        _device, refused = api._read(request)
        if refused is not None:
            return refused
        c = convo()
        if c is None:
            return JSONResponse({"items": []})
        query = " ".join(str(request.query_params.get("q") or "").split())[:200]
        items = await asyncio.to_thread(
            past.listing, None, c.state.titles(), list_sessions=c.list_sessions
        )
        if query:
            items = past.matching(items, query)
        pinned = pins()
        current = getattr(hub, "_session_id", "")
        shown = [
            {
                **item,
                "current": item["session_id"] == current,
                "pinned": item["session_id"] in pinned,
            }
            for item in items[:LISTED]
        ]
        shown.sort(key=lambda i: (not i["pinned"], -int(i.get("at") or 0)))
        return JSONResponse({"items": shown})

    async def one(request: Request) -> Response:
        _device, refused = api._read(request)
        if refused is not None:
            return refused
        c = convo()
        sid = valid_id(request.query_params.get("id"))
        if c is None or not sid:
            return _bad("no such conversation", 404)
        entries = await asyncio.to_thread(past.entries, sid, None, get_messages=c.get_messages)
        body: dict[str, Any] = {
            "session_id": sid,
            "title": c.state.titles().get(sid, ""),
            "current": sid == getattr(hub, "_session_id", ""),
            "entries": [{"role": e["role"], "text": e["text"]} for e in entries or []],
        }
        if entries is None:
            body["error"] = "unreadable"
        return JSONResponse(body)

    async def resume(request: Request) -> Response:
        device, data, refused = await api._post(request, "act")
        if refused is not None:
            return refused
        c = convo()
        sid = valid_id(data.get("session_id"))
        if c is None or not sid:
            return _bad("no such conversation", 404)
        hub._spawn(c.reopen(sid))  # asks on its card first; the phone answers it
        api.companion.record(device, "chat_resumed", sid[:8])
        return JSONResponse({"ok": True, "asks": True})

    async def manage(request: Request) -> Response:
        device, data, refused = await api._post(request, "act")
        if refused is not None:
            return refused
        desk = getattr(hub, "conversation_manage", None)
        sid = valid_id(data.get("session_id"))
        action = str(data.get("action") or "")
        if desk is None or not sid:
            return _bad("no such conversation", 404)
        if action == "rename":
            title = title_line(data.get("title"))
            if not title:
                return _bad("a title")
            await desk.rename({"session_id": sid, "title": title})
        elif action == "pin":
            await desk.pin({"session_id": sid, "pinned": data.get("pinned") is not False})
        elif action == "delete":
            if sid == getattr(hub, "_session_id", ""):
                return _bad("That’s the conversation going on now. Start a new one first.", 409)
            await desk.delete({"session_id": sid})
        else:
            return _bad("rename, pin or delete")
        api.companion.record(device, f"chat_{action}", sid[:8])
        return JSONResponse({"ok": True})

    async def new(request: Request) -> Response:
        device, _data, refused = await api._post(request, "act")
        if refused is not None:
            return refused
        await hub.reset()
        api.companion.record(device, "chat_new", "")
        return JSONResponse({"ok": True})

    return [
        Route("/api/chats", chats),
        Route("/api/chats/one", one),
        Route("/api/chats/resume", resume, methods=["POST"]),
        Route("/api/chats/manage", manage, methods=["POST"]),
        Route("/api/chats/new", new, methods=["POST"]),
    ]
