"""Other models for JARVIS itself: models on this Mac (Ollama, LM Studio) and any other server
that speaks OpenAI's API, through the relay in jarvis.openai_relay, as the fallback or, with
"Always use it", all the time (offline mode); and the utility model (jarvis.utility_model).

What it registers:
- the utility_model setting (prefs.features), by importing jarvis.utility_model;
- window commands: local_models_scan (-> local_models: the model servers found running on
  this Mac, each with the models it lists) and local_models_add {port} (adds that server as
  an OpenAI-compatible provider with the models it listed, then the usual providers event);
- a loop that closes the relay when the app quits (loops run only with the app).

Looking for servers asks only this Mac (127.0.0.1) on the usual ports; nothing leaves it.

Cost: none here. A model on this Mac costs nothing; the utility model's own callers state
theirs (jarvis.utility_model).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any
from urllib.parse import urlsplit

import httpx

from .. import openai_relay, utility_model  # noqa: F401  (registers the utility model setting)
from ..providers import LOCAL_SERVERS, MAX_MODELS

log = logging.getLogger("jarvis")

SCAN_SECONDS = 1.5
SCAN_BYTES = 2_000_000


async def _models_at(client: httpx.AsyncClient, port: int) -> list[str] | None:
    """The models a server on this Mac lists at /v1/models, or None when nothing answers
    there (or it isn't an OpenAI-compatible server)."""
    try:
        response = await client.get(f"http://127.0.0.1:{port}/v1/models", timeout=SCAN_SECONDS)
    except httpx.HTTPError:
        return None
    if response.status_code != 200 or len(response.content) > SCAN_BYTES:
        return None
    try:
        data = json.loads(response.content)
    except (ValueError, RecursionError):
        return None
    items = data.get("data") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return None
    names = [
        str(i["id"])[:190]
        for i in items
        if isinstance(i, dict) and isinstance(i.get("id"), str) and i["id"].strip()
    ]
    return list(dict.fromkeys(names))[:200]


class LocalModels:
    def __init__(self, hub: Any, client: httpx.AsyncClient | None = None) -> None:
        self.hub = hub
        self.client = client  # tests give one; the app makes one per scan
        self.found: dict[int, list[str]] = {}

    def _added(self, port: int) -> str:
        """The provider already added for this server ("" when none)."""
        for provider in self.hub.providers.providers.values():
            if provider.kind != "openai":
                continue
            parts = urlsplit(provider.base_url)
            if parts.hostname in ("127.0.0.1", "localhost", "::1") and parts.port == port:
                return provider.id
        return ""

    def payload(self) -> dict[str, Any]:
        return {
            "servers": [
                {
                    "port": port,
                    "name": LOCAL_SERVERS[port],
                    "models": models[:12],
                    "count": len(models),
                    "added": self._added(port),
                }
                for port, models in sorted(self.found.items())
            ]
        }

    async def scan(self, _msg: dict[str, Any] | None = None) -> None:
        own = self.client is None
        client = self.client or httpx.AsyncClient(follow_redirects=False)
        try:
            ports = sorted(LOCAL_SERVERS)
            results = await asyncio.gather(*(_models_at(client, p) for p in ports))
        finally:
            if own:
                await client.aclose()
        self.found = {p: m for p, m in zip(ports, results, strict=True) if m is not None}
        self.hub.emit("local_models", **self.payload())

    async def add(self, msg: dict[str, Any]) -> None:
        """The owner's click: the server found on this port, added with its models."""
        try:
            port = int(msg.get("port", 0))
        except (TypeError, ValueError, OverflowError):  # null, words, infinity: no server
            port = 0
        store = self.hub.providers
        if port not in self.found:
            self.hub.emit("providers_error", text="Look for it again first: it isn't running.")
            return
        if self._added(port):
            self.hub.emit("providers_error", text=f"{LOCAL_SERVERS[port]} is added already.")
            return
        try:
            # Ollama and LM Studio don't check keys; the placeholder still goes to the
            # Keychain, sealed with this address like any key.
            added = store.add_provider("openai", "", "local", f"http://localhost:{port}")
            store.add_models(added["id"], [(m, None) for m in self.found[port][:MAX_MODELS]])
        except ValueError as exc:
            self.hub.emit("providers_error", text=str(exc))
            return
        await openai_relay.ready(store)
        self.hub._providers_changed()
        self.hub.emit("local_models", **self.payload())

    async def keep_relay(self) -> None:
        """Runs with the app; when it's cancelled (the app quitting), the relay closes."""
        try:
            await asyncio.Event().wait()
        finally:
            if openai_relay.PROXY.port:
                await openai_relay.PROXY.close()


def install(hub: Any) -> None:
    local = LocalModels(hub)
    hub.local_models = local
    hub.register_command("local_models_scan", local.scan)
    hub.register_command("local_models_add", local.add)
    hub.register_loop("openai_relay", local.keep_relay)
