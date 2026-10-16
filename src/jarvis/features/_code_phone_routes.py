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
    ]
