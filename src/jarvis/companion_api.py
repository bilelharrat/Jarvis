"""The companion API beyond remote.py's own calls (the contract both apps follow: push and
Live Activity tokens, and more as the app grows). Every route goes through remote.Gate:
the phone's own token (401), its budget for that kind of call (429), and a cap on what's
read (413) before anything is done."""

from __future__ import annotations

from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from . import push


def _bad(what: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": what}, status_code=status)


class Api:
    def __init__(self, companion: Any, gate: Any) -> None:
        self.companion = companion
        self.gate = gate

    async def _post(
        self, request: Request, kind: str, cap: int | None = None
    ) -> tuple[Any, dict[str, Any], Response | None]:
        """The device and its JSON body, or the refusal: token first, then its budget,
        then the body (at most cap bytes)."""
        from .remote import MAX_BODY

        device, refused = self.gate.admit(request, kind)
        if device is None:
            return None, {}, refused
        data = await self.gate.json(request, cap or MAX_BODY)
        if data is None:
            return None, {}, self.gate.too_big()
        return device, data, None

    # ── push ──

    async def push_register(self, request: Request) -> Response:
        device, data, refused = await self._post(request, "report")
        if refused is not None:
            return refused
        token = str(data.get("token") or "").strip().lower()
        environment = data.get("environment")
        bundle_id = str(data.get("bundle_id") or "").strip()
        if not push.valid_token(token):
            return _bad("token")
        if environment not in push.HOSTS:
            return _bad("environment")
        if not push.valid_bundle(bundle_id):
            return _bad("bundle_id")
        self.companion.store.register(device.id, token, str(environment), bundle_id)
        self.companion.record(device, "push_on")
        self.companion.emit_status()
        return JSONResponse({"ok": True})

    async def push_unregister(self, request: Request) -> Response:
        device, _data, refused = await self._post(request, "report")
        if refused is not None:
            return refused
        self.companion.store.unregister(device.id)
        self.companion.record(device, "push_off")
        self.companion.emit_status()
        return JSONResponse({"ok": True})


def routes(companion: Any, gate: Any) -> list[Route]:
    api = Api(companion, gate)
    return [
        Route("/api/push/register", api.push_register, methods=["POST"]),
        Route("/api/push/unregister", api.push_unregister, methods=["POST"]),
    ]
