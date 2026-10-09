"""Setup's Claude step: signing JARVIS in with the user's own Anthropic API key.

JARVIS and Eden Code run on Claude Code, which signs in with a Claude account (`claude auth
login`). The app people download can't offer that: Anthropic's terms don't let another
product sign its users in with their claude.ai subscription. Its way in is the user's own
Anthropic API key (console.anthropic.com › API keys), billed to their API account.

A pasted key is added as an "Anthropic API" provider named "Claude API key" (providers.py:
the Keychain, sealed to Anthropic's address) once Anthropic has taken it, and the feature
pref claude_signin names it; claude_signin.signed_in() then signs every run in with it.
Removing it (here, or its provider in Settings › Models) goes back to the Claude account.

Window commands: signin_state, signin_key {key}, signin_forget; each answered with a "signin"
event {mode: "account" | "key", hint, status, key_url, error, note}. The key never comes back.

Cost: no model is called. Checking a key lists the models it can use (free): once per paste,
and when the checkup asks.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import Any

from .. import claude_signin
from ..claude_signin import PREF, provider_of
from ..prefs import register_feature_pref

NAME = "Claude API key"
KIND = claude_signin.KIND
KEY_URL = "https://console.anthropic.com/settings/keys"


def _provider_id(value: Any) -> str | None:
    """A provider's id as the store makes them, or "" for the Claude account."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if value == "" or re.fullmatch(r"[a-z0-9]{6,32}", value) else None


register_feature_pref(PREF, "", _provider_id)


Check = Callable[[str], Awaitable[dict[str, Any]]]  # a provider id -> its key's check


class SignIn:
    """The window's side: the key pasted, checked and kept, or removed. check_key asks
    Anthropic (providers.ProviderStore.check); tests pass a stand-in."""

    def __init__(self, hub: Any, check_key: Check | None = None) -> None:
        self.hub = hub
        self.check_key: Check = check_key or (lambda pid: hub.providers.check(pid))

    def public(self) -> dict[str, Any]:
        provider = provider_of(self.hub)
        if provider is None:
            return {"mode": "account", "hint": "", "status": None, "key_url": KEY_URL}
        status = self.hub.providers.status.get(provider.id)
        return {"mode": "key", "hint": provider.key_hint, "status": status, "key_url": KEY_URL}

    def _changed(self, error: str = "", note: str = "") -> None:
        self.hub.emit("signin", **self.public(), error=error, note=note)
        changed = getattr(self.hub, "_providers_changed", None)
        if callable(changed):
            changed()  # Settings › Models shows the key's provider too

    def _reconnect(self) -> None:
        """The conversation's Claude Code was started signed in the old way: it starts again
        signed in the new one (the conversation kept), as when a provider is removed."""
        reload = getattr(self.hub, "_tools_changed", None)
        if callable(reload):
            reload()

    async def state(self, _msg: dict[str, Any] | None = None) -> None:
        self.hub.emit("signin", **self.public(), error="", note="")

    async def check(self) -> dict[str, Any] | None:
        """The key's standing, checked with Anthropic now (the checkup): {"ok", "error",
        "hint"}, or None when JARVIS signs in with the account."""
        provider = provider_of(self.hub)
        if provider is None:
            return None
        result = await self.check_key(provider.id)
        return {
            "ok": bool(result.get("ok")),
            "error": result.get("error", ""),
            "hint": provider.key_hint,
        }

    async def use_key(self, msg: dict[str, Any]) -> None:
        """A pasted key, kept only once Anthropic has taken it. It came from the window once
        and goes only to the Keychain and to Anthropic; it's never logged or sent back.
        While a key is in use another paste is refused (the window offers Remove instead),
        so a wrong paste never takes the place of a working key."""
        store = self.hub.providers
        if provider_of(self.hub) is not None:
            self._changed(error="Remove the key Jarvis has before adding another.")
            return
        try:
            name = NAME if not any(p.name == NAME for p in store.providers.values()) else ""
            added = store.add_provider(KIND, name, msg.get("key", ""))
            result = await self.check_key(added["id"])
            if not result.get("ok"):
                store.remove_provider(added["id"])
                self._changed(error=result.get("error") or "Anthropic didn't take that key.")
                return
            self.hub.set_feature_prefs({PREF: added["id"]})
            claude_signin.forget(added["id"])
            self._changed(note="Signed in with your API key.")
            self._reconnect()
        except ValueError as exc:  # the key's shape, the Keychain: said in words to show
            self._changed(error=str(exc))

    async def forget(self, _msg: dict[str, Any] | None = None) -> None:
        """Back to the Claude account: the key leaves the Keychain."""
        provider = provider_of(self.hub)
        try:
            if provider is not None:
                self.hub.providers.remove_provider(provider.id)
                claude_signin.forget(provider.id)
            self.hub.set_feature_prefs({PREF: ""})
            self._changed(note="The API key is removed; Jarvis signs in with your Claude account.")
            if provider is not None:
                self._reconnect()
        except ValueError as exc:
            self._changed(error=str(exc))


def signin_for(hub: Any) -> SignIn | None:
    return getattr(hub, "signin_desk", None)


def install(hub: Any) -> None:
    signin = SignIn(hub)
    # Kept on the hub, never in a map of this module's: one keyed weakly by the hub still
    # holds its desk, the desk holds the hub, and no hub would ever be freed.
    hub.signin_desk = signin
    hub.register_command("signin_state", signin.state)
    hub.register_command("signin_key", signin.use_key, slow=True)  # checks the key online
    hub.register_command("signin_forget", signin.forget)
    # The real backend only (a test's hub never polls): its runs sign in from here on. Now,
    # as the hub is made, not in a loop: the hub connects to Claude before its loops start,
    # and that first connection must carry the key too.
    if getattr(hub, "poll", False):
        claude_signin.activate(hub)
