"""The Mac's Projects from the phone (features/chat_projects.py): listed, opened or closed,
made and changed, their files added and taken away, conversations moved in and out.

- GET /api/projects: {items: [{id, name, instructions, files: [{name, chars, added}],
  conversations: [{session_id, title}], created}], active, current}
- POST /api/projects/save {id?, name, instructions}: {ok, id}
- POST /api/projects/delete {id}
- POST /api/projects/use {id or ""}
- POST /api/projects/file {id, name, text | pdf (base64)}: {ok} or {error}
- POST /api/projects/unfile {id, name}
- POST /api/projects/assign {session_id, id or ""}

Each answers with the listing too (as GET), so the phone draws it at once.

Claude cost policy: no model is called here.
"""

from __future__ import annotations

from typing import Any

from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from .remote import JSONResponse  # (an answer with half an emoji in it is still sent)

FILE_CAP = 36 * 1024 * 1024  # a 25 MB PDF as base64, in JSON


def routes(api: Any) -> list[Route]:
    hub = api.hub

    def desk() -> Any:
        return getattr(hub, "chat_projects", None)

    def missing() -> JSONResponse:
        return JSONResponse({"error": "Projects aren’t on in this Jarvis."}, status_code=404)

    async def listing(request: Request) -> Response:
        _device, refused = api._read(request)
        if refused is not None:
            return refused
        d = desk()
        return JSONResponse(d.listing() if d else {"items": [], "active": "", "current": ""})

    def changed(name: str, cap: int | None = None, upload: bool = False):
        async def route(request: Request) -> Response:
            device, data, refused = await api._post(request, "act", cap=cap, upload=upload)
            if refused is not None:
                return refused
            d = desk()
            if d is None:
                return missing()
            body: dict[str, Any] = {"ok": True}
            if name == "save":
                project = d.save(data)
                if project is None:
                    return JSONResponse({"error": "A project needs a name."}, status_code=400)
                body["id"] = project["id"]
            elif name == "delete":
                d.delete(data)
            elif name == "use":
                await d.use(data)
            elif name == "file":
                problem = await d.add_file(data)
                if problem:
                    return JSONResponse({"error": problem}, status_code=400)
            elif name == "unfile":
                d.remove_file(data)
            elif name == "assign":
                d.assign(data)
            api.companion.record(device, f"project_{name}", str(data.get("id") or "")[:8])
            return JSONResponse({**body, **d.listing()})

        return route

    return [
        Route("/api/projects", listing),
        Route("/api/projects/save", changed("save"), methods=["POST"]),
        Route("/api/projects/delete", changed("delete"), methods=["POST"]),
        Route("/api/projects/use", changed("use"), methods=["POST"]),
        Route("/api/projects/file", changed("file", FILE_CAP, True), methods=["POST"]),
        Route("/api/projects/unfile", changed("unfile"), methods=["POST"]),
        Route("/api/projects/assign", changed("assign"), methods=["POST"]),
    ]
