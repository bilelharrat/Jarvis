"""Eden chat's keys for Eden Code's models (code_models): Eden Code's model pickers offer
exactly Eden chat's models (providers.EDEN_CHAT_MODELS: Claude on the owner's sign-in, GPT,
Gemini and Kimi on the owner's own keys). One whose key isn't in Settings › Models & API
keys yet is still listed, marked "needs a key"; when Eden chat on this Mac already has that
key, picking it offers to use the same key here, in one click, instead of pasting it again.

Where Eden chat on this Mac keeps its keys (askeden's src/chat/keys.ts resolveKey, with
eval/with-keys.sh): the login Keychain, a generic password whose service is "model-router"
($MODEL_ROUTER_KEYCHAIN_SERVICE) and whose account is the variable (OPENAI_API_KEY,
GEMINI_API_KEY, MOONSHOT_API_KEY), else ~/.config/model-router/keys.json
($MODEL_ROUTER_CHAT_DIR, $XDG_CONFIG_HOME). Whether one is there is looked up without
reading it (the Keychain's attributes only); the key itself is read only when the owner asks
to use it, then goes straight to Eden Code's own store (providers.ProviderStore.add_provider:
the Keychain, sealed with its provider's address) like a pasted one, and from there only to
that provider, through the key proxy and relays: never into a session, a log or the window.

Window commands:
- eden_chat_keys: which of Eden chat's keys this Mac has -> the providers event again, its
  picker's keyless models with from_eden_chat set where one is.
- eden_chat_key_use {group}: group "openai", "gemini" or "kimi": add Eden chat's key for it as
  a provider here (OpenAI at api.openai.com, Google Gemini, Moonshot at api.moonshot.ai/v1),
  which puts Eden chat's models of that provider on it -> providers (or providers_error
  saying why not).

Cost policy: no model is called here. Adding a key calls nothing either; the models it
brings cost what they cost on the owner's key when a session runs on them, under the usage
caps (code_usage) like any other.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path
from typing import Any

from .. import lang
from ..providers import EDEN_CHAT_HOW, EDEN_CHAT_KEYS

SECURITY = "/usr/bin/security"
LOOKUP_TIMEOUT = 10.0  # seconds the Keychain may take to answer one lookup
KEY_FILE_LIMIT = 64_000  # bytes of Eden chat's keys.json read, at most

ZH = {
    "Eden chat on this Mac has no {what} to use. Paste one in Settings › Models & API keys.":
        "这台 Mac 上的 Eden 聊天没有可用的{what}。请在“设置 › 模型和 API 密钥”中粘贴一个。",
    "Choose OpenAI, Google Gemini or Moonshot Kimi.": "请选择 OpenAI、Google Gemini 或 Moonshot Kimi。",
}  # fmt: skip
lang.add_texts(ZH)


def _testing() -> bool:
    """Under pytest: the owner's real Keychain and files are never looked at."""
    return bool(os.environ.get("PYTEST_CURRENT_TEST"))


class EdenChatKeys:
    """Eden chat's keys on this Mac: has(var) without reading it, read(var) when asked."""

    def service(self) -> str:
        return (os.environ.get("MODEL_ROUTER_KEYCHAIN_SERVICE") or "").strip() or "model-router"

    def _security(self, var: str, secret: bool) -> subprocess.CompletedProcess[str] | None:
        if _testing() or not Path(SECURITY).is_file():
            return None
        args = [SECURITY, "find-generic-password", "-s", self.service(), "-a", var]
        try:
            return subprocess.run(
                [*args, "-w"] if secret else args,
                capture_output=True, text=True, timeout=LOOKUP_TIMEOUT, check=False,
            )  # fmt: skip
        except (OSError, subprocess.SubprocessError):
            return None

    def _file(self) -> dict[str, Any]:
        if _testing():
            return {}
        env = os.environ
        folder = (env.get("MODEL_ROUTER_CHAT_DIR") or "").strip()
        if not folder:
            base = (env.get("XDG_CONFIG_HOME") or "").strip() or str(Path.home() / ".config")
            folder = str(Path(base) / "model-router")
        try:
            with open(Path(folder) / "keys.json", "rb") as f:
                data = json.loads(f.read(KEY_FILE_LIMIT))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def has(self, var: str) -> bool:
        done = self._security(var, secret=False)
        if done is not None and done.returncode == 0:
            return True
        return bool(self._from_file(var))

    def read(self, var: str) -> str:
        done = self._security(var, secret=True)
        if done is not None and done.returncode == 0 and done.stdout.strip():
            return done.stdout.strip()
        return self._from_file(var)

    def _from_file(self, var: str) -> str:
        # keys.json is by askeden's provider id, which is the group's
        group = next((g for g, (_, _, v) in EDEN_CHAT_KEYS.items() if v == var), "")
        value = self._file().get(group) if group else None
        return value.strip() if isinstance(value, str) else ""


class Models:
    def __init__(self, hub: Any, keys: EdenChatKeys | None = None) -> None:
        self.hub = hub
        self.keys = keys or EdenChatKeys()

    def tr(self, text: str, **values: Any) -> str:
        return lang.tr(text, getattr(self.hub, "language", "en"), **values)

    async def on_keys(self, _msg: dict[str, Any]) -> None:
        found = {}
        for group, (_, _, var) in EDEN_CHAT_KEYS.items():
            found[group] = await asyncio.to_thread(self.keys.has, var)
        self.hub.providers.chat_keys = found
        self.hub._providers_changed()

    async def on_use(self, msg: dict[str, Any]) -> None:
        group = str(msg.get("group") or "")
        if group not in EDEN_CHAT_KEYS:
            self.hub.emit(
                "providers_error", text=self.tr("Choose OpenAI, Google Gemini or Moonshot Kimi.")
            )
            return
        what, url, var = EDEN_CHAT_KEYS[group]
        key = await asyncio.to_thread(self.keys.read, var)
        if not key:
            self.hub.providers.chat_keys[group] = False
            self.hub.emit(
                "providers_error",
                text=self.tr(
                    "Eden chat on this Mac has no {what} to use. Paste one in Settings › Models & API keys.",
                    what=what,
                ),
            )
            self.hub._providers_changed()
            return
        kind = EDEN_CHAT_HOW[group][0]
        # The hub's own Add, as if the key were pasted: the relay started, Gemini's
        # starters numbered, the window told; the key lives in this call only.
        await self.hub._providers_command(
            "providers_add", {"kind": kind, "name": "", "key": key, "base_url": url}
        )


def install(hub: Any) -> None:
    models = Models(hub)
    hub.code_models = models
    hub.register_command("eden_chat_keys", models.on_keys, slow=True)
    hub.register_command("eden_chat_key_use", models.on_use, slow=True)
