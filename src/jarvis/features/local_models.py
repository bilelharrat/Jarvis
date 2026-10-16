"""Other models for JARVIS itself: models on this Mac (Ollama, LM Studio) and any other server
that speaks OpenAI's API, through the relay in jarvis.openai_relay, as the fallback or, with
"Always use it", all the time (offline mode); and the utility model (jarvis.utility_model).

What it registers:
- the utility_model setting (prefs.features), by importing jarvis.utility_model;
- window commands: local_models_scan (-> local_models: the model servers found running on
  this Mac, each with the models it lists) and local_models_add {port} (adds that server as
  an OpenAI-compatible provider with the models it listed, then the usual providers event);
- local_models_use {port, model}: Eden Code's pickers (the composer's model menu, Best of N)
  list every model found on this Mac under "On this Mac", the ones not added yet among them
  (providers.ProviderStore.local_unadded); picking one of those adds its server (as
  local_models_add) and the model if the server was added before it was pulled, then says
  which ref to put the session on (-> local_model_ready {ref, model, port}). Its sessions
  run through the relay like any added model (openai_relay, with code_lean's lean mode on
  by default);
- each look also asks the server about its models, so the pickers can show them with their
  size and context: Ollama's /api/tags (size, parameters, quantization) and /api/show for
  each (its context length, and whether it takes tools, from its capabilities), LM Studio's
  /api/v0/models (context, quantization, and its embedding models, left out: they can't
  chat). A server that doesn't answer those is listed all the same, without the details.
  The store keeps what was found (ProviderStore.local_found) and the window hears providers
  again when it changed;
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
from ..providers import CUSTOM, LOCAL_SERVERS, MAX_MODELS

log = logging.getLogger("jarvis")

SCAN_SECONDS = 1.5
SCAN_BYTES = 2_000_000
SHOW_AT_MOST = 12  # models a look asks Ollama's /api/show about (each is a small local call)


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


async def _json_at(
    client: httpx.AsyncClient, port: int, path: str, body: dict[str, Any] | None = None
) -> Any:
    """A server on this Mac's JSON answer at path (POSTed when body is given), or None."""
    url = f"http://127.0.0.1:{port}{path}"
    try:
        if body is None:
            response = await client.get(url, timeout=SCAN_SECONDS)
        else:
            response = await client.post(url, json=body, timeout=SCAN_SECONDS)
    except httpx.HTTPError:
        return None
    if response.status_code != 200 or len(response.content) > SCAN_BYTES:
        return None
    try:
        return json.loads(response.content)
    except (ValueError, RecursionError):
        return None


def _rows(data: Any, key: str) -> list[dict[str, Any]]:
    items = data.get(key) if isinstance(data, dict) else None
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


async def _ollama_details(
    client: httpx.AsyncClient, port: int, models: list[str]
) -> dict[str, dict[str, Any]]:
    """Ollama's own word on its models: size, parameters and quantization (/api/tags), and
    for the first few, the context length and capabilities (/api/show). A model whose
    capabilities don't include "completion" (an embedding model) is marked chat False."""
    out: dict[str, dict[str, Any]] = {}
    for row in _rows(await _json_at(client, port, "/api/tags"), "models"):
        name = row.get("model") or row.get("name")
        if not isinstance(name, str) or name not in models:
            continue
        details = row.get("details") if isinstance(row.get("details"), dict) else {}
        out[name] = {
            "size": row.get("size"),
            "params": details.get("parameter_size"),
            "quant": details.get("quantization_level"),
        }
    wanted = models[:SHOW_AT_MOST]
    shown = await asyncio.gather(
        *(_json_at(client, port, "/api/show", {"model": m}) for m in wanted)
    )
    for name, data in zip(wanted, shown, strict=True):
        if not isinstance(data, dict):
            continue
        row = out.setdefault(name, {})
        info = data.get("model_info") if isinstance(data.get("model_info"), dict) else {}
        for key, value in info.items():
            if str(key).endswith(".context_length"):
                row["context"] = value
                break
        caps = data.get("capabilities")
        if isinstance(caps, list):
            row["tools"] = "tools" in caps
            row["chat"] = "completion" in caps
    return out


async def _lmstudio_details(client: httpx.AsyncClient, port: int) -> dict[str, dict[str, Any]]:
    """LM Studio's own word (its /api/v0/models): context, quantization, and which are
    embedding models (chat False)."""
    out: dict[str, dict[str, Any]] = {}
    for row in _rows(await _json_at(client, port, "/api/v0/models"), "data"):
        if not isinstance(row.get("id"), str):
            continue
        out[row["id"]] = {
            "context": row.get("max_context_length"),
            "quant": row.get("quantization"),
            "chat": row.get("type") not in ("embeddings", "embedding"),
        }
    return out


class LocalModels:
    def __init__(self, hub: Any, client: httpx.AsyncClient | None = None) -> None:
        self.hub = hub
        self.client = client  # tests give one; the app makes one per scan
        self.found: dict[int, list[str]] = {}
        self.details: dict[int, dict[str, dict[str, Any]]] = {}  # port -> model -> details

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
            self.found = {p: m for p, m in zip(ports, results, strict=True) if m is not None}
            details = await asyncio.gather(*(self._details(client, p) for p in self.found))
        finally:
            if own:
                await client.aclose()
        self.details = dict(zip(self.found, details, strict=True))
        self.hub.emit("local_models", **self.payload())
        self._tell_pickers()

    async def _details(self, client: httpx.AsyncClient, port: int) -> dict[str, dict[str, Any]]:
        name = LOCAL_SERVERS.get(port, "")
        try:
            if name == "Ollama":
                return await _ollama_details(client, port, self.found[port])
            if name == "LM Studio":
                return await _lmstudio_details(client, port)
        except Exception:  # an odd answer costs the details, never the look
            log.exception("local models: %s's details", name)
        return {}

    def _tell_pickers(self) -> None:
        """The store's copy of what was found (chat models only), and the window's pickers
        told when it changed."""
        found = {
            port: {
                m: self.details.get(port, {}).get(m, {})
                for m in models
                if self.details.get(port, {}).get(m, {}).get("chat", True) is not False
            }
            for port, models in self.found.items()
        }
        store = self.hub.providers
        if getattr(store, "local_found", None) != found:
            store.local_found = found
            self.hub._providers_changed()

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

    async def use(self, msg: dict[str, Any]) -> None:
        """A model found on this Mac, picked in Eden Code: its server added if it isn't, the
        model added to it if it isn't, then local_model_ready with its ref."""
        try:
            port = int(msg.get("port", 0))
        except (TypeError, ValueError, OverflowError):
            port = 0
        model = str(msg.get("model") or "")
        store = self.hub.providers
        if port not in self.found or model not in self.found[port]:
            self.hub.emit("providers_error", text="Look for it again first: it isn't running.")
            return
        try:
            pid = self._added(port)
            if not pid:
                added = store.add_provider("openai", "", "local", f"http://localhost:{port}")
                pid = added["id"]
                wanted = [model, *(m for m in self.found[port] if m != model)][:MAX_MODELS]
                store.add_models(pid, [(m, None) for m in wanted])
            entry = next((e for e in store.models_of(pid) if e.model == model), None)
            if entry is None:  # pulled after its server was added
                store.add_model(pid, model)
                entry = next(e for e in store.models_of(pid) if e.model == model)
        except ValueError as exc:
            self.hub.emit("providers_error", text=str(exc))
            return
        await openai_relay.ready(store)
        self.hub._providers_changed()
        self.hub.emit("local_models", **self.payload())
        self.hub.emit("local_model_ready", ref=CUSTOM + entry.id, model=model, port=port)

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
    hub.register_command("local_models_scan", local.scan, slow=True)  # (it waits on servers)
    hub.register_command("local_models_add", local.add)
    hub.register_command("local_models_use", local.use)
    hub.register_loop("openai_relay", local.keep_relay)
