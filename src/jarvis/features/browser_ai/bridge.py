"""The hub's calls into the built-in browser for this feature: through the window (its
browser_ai.js passes them to the app's browser-ai.js, which asks the tab), answered over the
window's socket. The same shape as the hub's own browser calls (hub._browser_raw), on the
feature's own event and command, so none of the core's browser code changes for it."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

CALL_SECONDS = 10.0


class Bridge:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self._calls: dict[str, asyncio.Future] = {}

    async def call(
        self, action: str, args: dict[str, Any] | None = None, timeout: float = CALL_SECONDS
    ) -> dict[str, Any]:
        """Ask the app window's browser; its answer, or {"ok": False, "message": why}."""
        if not self.hub.browser_available:
            return {"ok": False, "message": "The built-in browser is only in the J.A.R.V.I.S. app."}
        call_id = uuid.uuid4().hex[:10]
        future = asyncio.get_running_loop().create_future()
        self._calls[call_id] = future
        self.hub.emit("browser_ai_cmd", id=call_id, action=action, args=args or {})
        try:
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            return {"ok": False, "message": "The browser didn't answer in time."}
        finally:
            self._calls.pop(call_id, None)

    def on_result(self, msg: dict[str, Any]) -> None:
        """The window's answer to a call (the browser_ai_result command)."""
        future = self._calls.get(str(msg.get("id")))
        if future is not None and not future.done():
            result = msg.get("result")
            future.set_result(result if isinstance(result, dict) else {"ok": False})
