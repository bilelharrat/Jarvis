"""The routes of Eden Code on the phone (features/code_phone.py), on the companion's server:
the page and its own files, open to anyone who can reach the server (there's nothing in them
but the page), and the /api/code/phone/* calls, each through remote.Gate first (the device's
own token, its rate limit, a capped body) and then the feature's switch. What each call may
do is said in code_phone's docstring; the checks are here, before anything is done."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from .code_phone import (
    _COPY,
    FILES,
    HEADERS,
    PHONE_MODES,
    TEXT_BODY,
    TEXT_CHARS,
    WAITS_PER_DEVICE,
    WEB_DIR,
    _int,
)

log = logging.getLogger("jarvis")

OFF = "Turn on Eden Code on your phone in Eden Code › More › Hand off to phone first."
NO_CHANGES = "The Changes pane isn't available here."
HUNKS_AT_ONCE = 200  # hunks one Keep or Undo takes (the phone's Undo all)
RECEIPTS_DEFAULT = 5
RECEIPTS_MOST = 20
TODOS_SHOWN = 300
TODO_PHONE_MODES = ("ask", "edits", "plan")  # a to-do card never starts in Auto or Bypass here
PICTURE_KEYS = ("thumb", "image", "picture", "screenshot", "data")


def _phone_line(text: Any, limit: int) -> str:
    return " ".join(str(text or "").split())[:limit]


def _no_pictures(value: Any) -> Any:
    """A receipt without the pictures in it (a check's thumbnail, a self-check's frame):
    the phone shows the words; the window has the pictures."""
    if isinstance(value, dict):
        return {k: _no_pictures(v) for k, v in value.items() if k not in PICTURE_KEYS}
    if isinstance(value, list):
        return [_no_pictures(v) for v in value]
    return value


def routes(phone: Any, gate: Any) -> list[Route]:
    from ..remote import JSONResponse

    hub = phone.hub

    def answer(data: dict[str, Any], status: int = 200) -> Response:
        return JSONResponse(data, status_code=status, headers=HEADERS)

    def bad(text: str, status: int = 400, **more: Any) -> Response:
        return answer({"error": phone.tr(text), **more}, status)

    def admitted(request: Request, kind: str) -> tuple[Any, Response | None]:
        device, refused = gate.admit(request, kind)
        if device is None:
            return None, refused
        if not phone.on():
            return None, bad(OFF, 403, off=True)
        return device, None

    async def posted(
        request: Request, cap: int | None = None
    ) -> tuple[Any, dict[str, Any], Response | None]:
        device, refused = admitted(request, "act")
        if device is None:
            return None, {}, refused
        data = await gate.json(request, cap) if cap else await gate.json(request)
        if data is None:
            return None, {}, gate.too_big()
        return device, data, None

    def record(device: Any, action: str, detail: str = "") -> None:
        companion = getattr(getattr(hub, "remote", None), "extension", None)
        if companion is not None:
            try:
                companion.record(device, action, detail)
            except Exception:  # a record that fails never fails the call
                log.warning("Eden Code phone: couldn't record %s", action, exc_info=True)

    def desk() -> Any:
        from ..companion_code import CodeDesk

        found = getattr(hub, "phone_code_desk", None)
        if found is None:
            found = hub.phone_code_desk = CodeDesk(hub)
        return found

    def models() -> list[dict[str, Any]]:
        """Eden Code's pickers' list (Eden chat's models first), as the phone shows it."""
        try:
            picker = hub.providers.picker()
        except Exception:
            log.warning("Eden Code phone: no model list", exc_info=True)
            picker = []
        return [
            {
                "ref": str(m.get("ref") or ""),
                "name": str(m.get("label") or m.get("name") or m.get("ref") or ""),
                "group": str(m.get("group") or m.get("provider_name") or ""),
                "needs_key": bool(m.get("needs_key")),
            }
            for m in picker
            if m.get("ref")
        ]

    def runnable(ref: str) -> bool:
        return any(m["ref"] == ref and not m["needs_key"] for m in models())

    # ── the page ──

    def asset(name: str, media_type: str):
        async def serve(_request: Request) -> Response:
            return Response((WEB_DIR / name).read_bytes(), media_type=media_type, headers=HEADERS)

        return serve

    async def page(_request: Request) -> Response:
        return Response((WEB_DIR / "code-phone.html").read_bytes(), media_type="text/html",
                        headers=HEADERS)  # fmt: skip

    async def manifest(_request: Request) -> Response:
        return JSONResponse(
            {
                "name": "Eden Code",
                "short_name": "Eden Code",
                "id": "/code/",
                "start_url": "/code/",
                "scope": "/code/",
                "display": "standalone",
                "background_color": "#0d0f14",
                "theme_color": "#0d0f14",
                "icons": [
                    {
                        "src": "/code/icon.png",
                        "sizes": "1024x1024",
                        "type": "image/png",
                        "purpose": "any",
                    }
                ],  # fmt: skip
            },
            media_type="application/manifest+json",
            headers=HEADERS,
        )

    async def icon(_request: Request) -> Response:
        from .. import packaged

        build = packaged.app_dir() / "build"
        for path in (build / "eden-code" / "icon-1024.png", build / "icon-1024.png"):
            if path.is_file():
                return Response(path.read_bytes(), media_type="image/png",
                                headers={**HEADERS, "Cache-Control": "max-age=86400"})  # fmt: skip
        return Response(status_code=404)

    # ── what the phone reads ──

    async def home(request: Request) -> Response:
        _device, refused = admitted(request, "read")
        if refused is not None:
            return refused
        return answer(phone.home())

    async def options(request: Request) -> Response:
        _device, refused = admitted(request, "read")
        if refused is not None:
            return refused
        from ..tasks import MODE_LABELS

        try:
            projects = [
                {"name": p["name"], "branch": p.get("branch") or "", "running": p.get("running", 0)}
                for p in await hub._projects_overview()
            ]
        except Exception:
            log.warning("Eden Code phone: couldn't list the projects", exc_info=True)
            projects = []
        mode = getattr(hub.prefs, "code_mode", "") or "ask"
        return answer(
            {
                "models": models(),
                "modes": [{"id": m, "name": MODE_LABELS.get(m, m)} for m in PHONE_MODES],
                "projects": projects,
                "defaults": {
                    "model": getattr(hub.prefs, "code_model", "") or "",
                    "mode": mode if mode in PHONE_MODES else "ask",
                },
            }
        )

    async def session(request: Request) -> Response:
        device, refused = admitted(request, "read")
        if refused is not None:
            return refused
        query = request.query_params
        task = phone.session(query.get("id"))
        if task is None:
            return bad("No such session.", 404)
        wait = float(_int(query.get("wait")))
        if phone.waits.get(device.id, 0) >= WAITS_PER_DEVICE:
            wait = 0.0  # (a phone's requests waiting at once are capped: this one answers now)
        phone.waits[device.id] = phone.waits.get(device.id, 0) + 1
        try:
            view = await phone.watch(
                task.id, _int(query.get("after")), _int(query.get("seen")),
                str(query.get("v") or "")[:40], wait,
            )  # fmt: skip
        finally:
            left = phone.waits.get(device.id, 1) - 1
            if left > 0:
                phone.waits[device.id] = left
            else:
                phone.waits.pop(device.id, None)
        if view is None:
            return bad("No such session.", 404)
        return answer(view)

    # ── what the phone does ──

    async def send(request: Request) -> Response:
        device, data, refused = await posted(request, TEXT_BODY)
        if refused is not None:
            return refused
        task = phone.session(data.get("id"))
        if task is None:
            return bad("No such session.", 404)
        text = str(data.get("text") or "").strip()[:TEXT_CHARS]
        if not text:
            return bad("Write something first.")
        ok = bool(hub.tasks.send(task.id, text))
        if ok:
            record(device, "code_sent", f"#{task.id}")
        return answer({"ok": ok})

    async def stop(request: Request) -> Response:
        device, data, refused = await posted(request)
        if refused is not None:
            return refused
        task = phone.session(data.get("id"))
        if task is None:
            return bad("No such session.", 404)
        ok = bool(await hub.tasks.interrupt(task.id))
        if ok:
            record(device, "code_stopped", f"#{task.id}")
        return answer({"ok": ok})

    async def answer_card(request: Request) -> Response:
        device, data, refused = await posted(request)
        if refused is not None:
            return refused
        card_id = str(data.get("approval") or "")[:40]
        choice = str(data.get("choice") or "")[:40]
        card = hub.approvals.get(card_id)
        if not isinstance(card, dict) or not phone.is_code_card(card):
            return bad("That card isn't up any more.", 404)
        if choice != "deny" and phone.mac_only(card):
            return bad("Answer this one on your Mac: it needs Touch ID there.", 403)
        feedback = " ".join(str(data.get("feedback") or "").split())[:2000]
        ok = hub.resolve(card_id, choice, feedback)
        if ok:
            record(device, "said_no" if choice == "deny" else "answered", "Eden Code")
        return answer({"ok": ok})

    async def mode(request: Request) -> Response:
        device, data, refused = await posted(request)
        if refused is not None:
            return refused
        task = phone.session(data.get("id"))
        if task is None:
            return bad("No such session.", 404)
        wanted = str(data.get("mode") or "")
        if wanted not in PHONE_MODES:
            return bad(
                "From the phone a session runs in Manual or Accept edits. Bypass permissions only on the Mac."
            )
        heard = await desk().run(
            {"type": "task_mode", "id": task.id, "mode": wanted}, ("error",), 0.3
        )
        problem = next((str(e.get("text") or "") for e in heard if e.get("type") == "error"), "")
        record(device, "code_mode", f"#{task.id}")
        return answer({"ok": not problem and task.mode == wanted, "said": problem})

    async def model(request: Request) -> Response:
        device, data, refused = await posted(request)
        if refused is not None:
            return refused
        task = phone.session(data.get("id"))
        if task is None:
            return bad("No such session.", 404)
        ref = str(data.get("ref") or "")[:200]
        if not runnable(ref):
            return bad("That model isn't on the list, or needs a key on the Mac first.")
        heard = await desk().run(
            {"type": "task_model", "id": task.id, "ref": ref}, ("caption", "error"), 4
        )
        said = next((str(e.get("text") or "") for e in heard), "")
        failed = any(e.get("type") == "error" for e in heard)
        record(device, "code_model", f"#{task.id}")
        return answer({"ok": not failed, "said": said})

    async def new(request: Request) -> Response:
        device, data, refused = await posted(request, TEXT_BODY)
        if refused is not None:
            return refused
        prompt = str(data.get("prompt") or "").strip()[:TEXT_CHARS]
        directory = str(data.get("directory") or "").strip()[:1000]
        if not prompt or not directory:
            return bad("A project and what to do.")
        wanted = str(data.get("mode") or "ask")
        if wanted not in PHONE_MODES:
            return bad(
                "From the phone a session runs in Manual or Accept edits. Bypass permissions only on the Mac."
            )
        # The mode always named: a project whose own default is Bypass doesn't start in it.
        command: dict[str, Any] = {
            "type": "task_new", "prompt": prompt, "directory": directory, "mode": wanted,
        }  # fmt: skip
        ref = str(data.get("model") or "")[:200]
        if ref:
            if not runnable(ref):
                return bad("That model isn't on the list, or needs a key on the Mac first.")
            command["model"] = ref
        if isinstance(data.get("isolated"), bool):
            command["isolated"] = data["isolated"]
        # Found by its launch token, never "whichever is new" (REL3-10, as companion_code).
        from .. import launches

        token = launches.token()
        command[launches.KEY] = token
        found_desk = desk()
        async with found_desk.starting:
            said = await found_desk.run(
                command, ("error",), 3, done=lambda: launches.find(hub.tasks, token) is not None
            )
            found = launches.find(hub.tasks, token)
        if found is None:
            problem = next((e.get("text") for e in said if e.get("type") == "error"), "")
            return answer({"error": str(problem or phone.tr("The session didn't start."))}, 400)
        record(device, "code_started", f"#{found.id}")
        return answer({"ok": True, "id": found.id})

    async def copy_action(request: Request, action: str) -> Response:
        device, data, refused = await posted(request)
        if refused is not None:
            return refused
        task = phone.session(data.get("id"))
        if task is None:
            return bad("No such session.", 404)
        isolation = getattr(hub, "code_desk", None)
        copy = phone.copy_of(task)
        if isolation is None or copy is None:
            return bad("This session isn't in an isolated copy.")
        inside = isolation.tasks_in(copy)
        if any(t.busy for t in inside) or (action == "land" and isolation.working_in(copy.slug)):
            return bad(
                "It's still working. Stop it first, then land."
                if action == "land"
                else "It's still working. Stop it first, then discard.",
                409,
            )
        if action == "land":
            findings = await asyncio.to_thread(isolation._scan_copy, copy)
            if findings:
                return bad(
                    "Possible secrets in what it would commit: land it on your Mac, where its card lists them.",
                    403,
                )
        run = isolation.land if action == "land" else isolation.discard
        marked = _COPY.set(copy.slug)  # (its card, when it goes up, is the phone's to answer)
        try:
            hub._spawn(isolation._reply(run(copy.slug)))
        finally:
            _COPY.reset(marked)
        record(device, f"code_{action}", f"#{task.id}")
        return answer({"ok": True, "said": phone.tr("Confirm on its card.")})

    async def land(request: Request) -> Response:
        return await copy_action(request, "land")

    async def discard(request: Request) -> Response:
        return await copy_action(request, "discard")

    async def unpin(request: Request) -> Response:
        _device, _data, refused = await posted(request)
        if refused is not None:
            return refused
        phone.pinned = None
        phone.generation += 1
        hub._spawn(phone.publish())
        return answer({"ok": True})

    # ── for the iPhone app (Eden Code's own, docs/eden-code-phone.md): its changes, its
    # receipts, line comments, steering, the to-do queue and the usage glance. The same gate
    # and switch as the rest; what each may do is what the window's own pane does. ──

    def hunks() -> Any:
        return getattr(hub, "code_hunks", None)

    async def changes(request: Request) -> Response:
        _device, refused = admitted(request, "read")
        if refused is not None:
            return refused
        query = request.query_params
        task = phone.session(query.get("id"))
        if task is None:
            return bad("No such session.", 404)
        pane = hunks()
        if pane is None:
            return bad(NO_CHANGES, 409)
        from .. import code_changes
        from .code_hunks import VIEWS

        which = query.get("view") if query.get("view") in VIEWS else "session"
        path = str(query.get("path") or "")[:1000]
        view = await asyncio.to_thread(code_changes.task_view, task, which)
        return answer(pane.payload(task, which, view, path))

    async def hunk(request: Request) -> Response:
        """Keep, un-keep or undo hunks by id, as the Changes pane's buttons do (code_hunks):
        one ("hunk") or several at once ("hunks": the phone's Undo all, at most HUNKS_AT_ONCE),
        the window's pane kept in step. Answers with the view as it is now."""
        device, data, refused = await posted(request)
        if refused is not None:
            return refused
        task = phone.session(data.get("id"))
        if task is None:
            return bad("No such session.", 404)
        pane = hunks()
        if pane is None:
            return bad(NO_CHANGES, 409)
        from .. import code_changes
        from .code_hunks import VIEWS

        action = str(data.get("action") or "")
        many = data.get("hunks") if isinstance(data.get("hunks"), list) else [data.get("hunk")]
        ids = [str(h)[:40] for h in many[:HUNKS_AT_ONCE] if isinstance(h, str) and h]
        which = data.get("view") if data.get("view") in VIEWS else "session"
        if not ids or action not in ("keep", "unkeep", "undo"):
            return bad("Say which change, and Keep or Undo.")
        said = ""
        if action == "undo":
            said = await pane.undo(task, which, ids)
            await pane.changes({"id": task.id, "view": which})  # (the window's pane, again)
            hub.emit("code_hunk_undone", id=task.id, undone=said.startswith("Undid"),
                     file=str(data.get("path") or "")[:1000])  # fmt: skip
        else:
            pane.keep(task, ids, action == "keep")
        record(device, f"code_hunk_{action}", f"#{task.id}")
        view = await asyncio.to_thread(code_changes.task_view, task, which)
        return answer({
            "ok": action != "undo" or said.startswith("Undid"),
            "said": phone.tr(said) if said else "",
            "changes": pane.payload(task, which, view),
        })  # fmt: skip

    async def comments(request: Request) -> Response:
        """Line comments, sent to the session as one message worded as the window's Changes
        pane sends them (code_api.comment_message): queued like any message from the phone."""
        device, data, refused = await posted(request, TEXT_BODY)
        if refused is not None:
            return refused
        task = phone.session(data.get("id"))
        if task is None:
            return bad("No such session.", 404)
        from .code_api import Refused, comment_message

        try:
            text = comment_message(data.get("comments"))
        except Refused:
            return bad("Each comment needs a file, a line and what to say.")
        ok = bool(hub.tasks.send(task.id, text[:TEXT_CHARS]))
        if ok:
            record(device, "code_commented", f"#{task.id}")
        return answer({"ok": ok})

    async def receipts(request: Request) -> Response:
        """The turns' receipts (code_receipts) still in the transcript, newest last: the
        card's fields and its words, without pictures (the window has them)."""
        _device, refused = admitted(request, "read")
        if refused is not None:
            return refused
        query = request.query_params
        task = phone.session(query.get("id"))
        if task is None:
            return bad("No such session.", 404)
        tail = max(1, min(RECEIPTS_MOST, _int(query.get("tail")) or RECEIPTS_DEFAULT))
        found = [e for e in task.transcript if isinstance(e.get("receipt"), dict)][-tail:]
        out = [
            {"i": _int(e.get("n")), "at": e.get("at") or "", "text": str(e.get("text") or "")[:4000],
             "receipt": _no_pictures(e["receipt"])}
            for e in found
        ]  # fmt: skip
        return answer({"id": task.id, "receipts": out})

    async def steer(request: Request) -> Response:
        """A message into the running step now, without stopping it (tasks.send steer=True:
        Claude Code takes it up after the tool it's on); queued when the step can't take it."""
        device, data, refused = await posted(request, TEXT_BODY)
        if refused is not None:
            return refused
        task = phone.session(data.get("id"))
        if task is None:
            return bad("No such session.", 404)
        text = str(data.get("text") or "").strip()[:TEXT_CHARS]
        if not text:
            return bad("Write something first.")
        steered = bool(task.steerable)
        ok = bool(hub.tasks.send(task.id, text, steer=True))
        if ok:
            record(device, "code_steered", f"#{task.id}")
        return answer({"ok": ok, "steered": ok and steered})

    def card_view(card: dict[str, Any]) -> dict[str, Any]:
        from pathlib import Path

        folder = str(card.get("folder") or "")
        return {
            "id": str(card.get("id") or ""),
            "project": Path(folder).name if folder else "",
            "directory": folder,
            "title": _phone_line(card.get("title"), 200),
            "prompt": str(card.get("prompt") or "")[:600],
            "model": str(card.get("model") or ""),
            "mode": str(card.get("mode") or ""),
            "state": str(card.get("state") or "todo"),
            "task_id": card.get("task") if type(card.get("task")) is int else None,
            "untrusted": bool(card.get("untrusted")),
        }

    async def todos(request: Request) -> Response:
        """The to-do column (code_todo): each project's cards in the owner's order, and each
        project's queue (on, running, spent of its ceiling)."""
        _device, refused = admitted(request, "read")
        if refused is not None:
            return refused
        todo = getattr(hub, "code_todo", None)
        if todo is None:
            return answer({"cards": [], "queues": {}})
        queue = getattr(hub, "code_queue", None)
        try:
            queues = queue.public() if queue is not None else {}
        except Exception:
            log.warning("Eden Code phone: couldn't read the queues", exc_info=True)
            queues = {}
        cards = [card_view(c) for c in list(todo.board.cards)[:TODOS_SHOWN]]
        return answer({"cards": cards, "queues": queues if isinstance(queues, dict) else {}})

    async def todo_start(request: Request) -> Response:
        """Starts one to-do card as its session, as its Start button does, unless it would
        start in Auto or Bypass permissions (its own mode, or the project's default when it
        names none): those start on the Mac, as every session from the phone is Manual,
        Accept edits or Plan."""
        device, data, refused = await posted(request)
        if refused is not None:
            return refused
        todo = getattr(hub, "code_todo", None)
        card = todo.board.get(data.get("card")) if todo is not None else None
        if card is None:
            return bad("That card isn't there any more.", 404)
        if card.get("state") in ("queued", "running"):
            return bad("That card is already running.", 409)
        mode = todo.message(card).get("mode") or ""
        if not mode:
            try:
                mode = hub.tasks.defaults_for(card["folder"]).get("mode") or ""
            except Exception:
                mode = ""
            mode = mode or getattr(hub.prefs, "code_mode", "") or "ask"
        if mode not in TODO_PHONE_MODES:
            return bad(
                "This card would start in Auto or Bypass permissions: start it on your Mac.", 403
            )
        if todo.starting_now(card["id"]):
            return bad("That card's session is still starting.", 409)
        todo.starting.add(card["id"])
        try:
            task = await todo.start(card)
        finally:
            todo.starting.discard(card["id"])
        if task is None:
            return bad("The session didn't start.")
        card["state"] = "started"
        todo.save()
        todo.emit(started=card["id"])
        record(device, "code_started", f"#{task.id}")
        return answer({"ok": True, "id": task.id})

    async def usage(request: Request) -> Response:
        """The usage glance (code_usage's meter): today's spending and the daily cap, the last
        week, today's projects and Claude's usage windows (five-hour, weekly)."""
        _device, refused = admitted(request, "read")
        if refused is not None:
            return refused
        meter = getattr(hub, "code_usage", None)
        if meter is None:
            return answer(
                {"today": 0.0, "day_cap": 0.0, "recent": [], "by_project": [], "windows": []}
            )
        try:
            found = meter.public()
        except Exception:
            log.warning("Eden Code phone: couldn't read the usage meter", exc_info=True)
            return bad("Couldn't read the usage meter.", 503)
        return answer({
            "today": float(found.get("today") or 0.0),
            "day_cap": float((found.get("defaults") or {}).get("day") or 0.0),
            "recent": list(found.get("recent") or [])[-7:],
            "by_project": list(found.get("by_project") or [])[:8],
            "windows": list(found.get("windows") or []),
        })  # fmt: skip

    return [
        Route("/code", page),
        Route("/code/", page),
        Route("/code/manifest.webmanifest", manifest),
        Route("/code/icon.png", icon),
        *[Route(f"/code/{name}", asset(*found)) for name, found in FILES.items()],
        Route("/api/code/phone/home", home),
        Route("/api/code/phone/options", options),
        Route("/api/code/phone/session", session),
        Route("/api/code/phone/send", send, methods=["POST"]),
        Route("/api/code/phone/stop", stop, methods=["POST"]),
        Route("/api/code/phone/answer", answer_card, methods=["POST"]),
        Route("/api/code/phone/mode", mode, methods=["POST"]),
        Route("/api/code/phone/model", model, methods=["POST"]),
        Route("/api/code/phone/new", new, methods=["POST"]),
        Route("/api/code/phone/land", land, methods=["POST"]),
        Route("/api/code/phone/discard", discard, methods=["POST"]),
        Route("/api/code/phone/unpin", unpin, methods=["POST"]),
        Route("/api/code/phone/changes", changes),
        Route("/api/code/phone/receipts", receipts),
        Route("/api/code/phone/todos", todos),
        Route("/api/code/phone/usage", usage),
        Route("/api/code/phone/hunk", hunk, methods=["POST"]),
        Route("/api/code/phone/comments", comments, methods=["POST"]),
        Route("/api/code/phone/steer", steer, methods=["POST"]),
        Route("/api/code/phone/todo_start", todo_start, methods=["POST"]),
    ]
