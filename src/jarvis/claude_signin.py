"""How every Claude Code run JARVIS starts signs in: its Claude account, as always, or the
user's own Anthropic API key when they pasted one (features/signin.py, Setup's Claude step).

The app people download can't sign its users in with their claude.ai subscription
(Anthropic's terms don't let another product offer that); its way in is the user's own API
key. That key lives where every provider key does (providers.py: the Keychain, sealed to
Anthropic's address), as the provider the feature pref claude_signin names.

Every site that makes a run's options passes them through signed_in(): the conversation
(brain.build_options), Eden Code and research (tasks), and the short background calls
(code_ai, meeting notes, reports, jobs, drafts, triage…). With a key in use, options that
have no settings of their own get JARVIS's key proxy for their address and an apiKeyHelper
that prints a pass made for them (key_proxy: the proxy puts the key in its place on the way
to Anthropic; neither the key nor anything that reads it is ever in an environment or on a
command line), and every other address, credential and model variable pinned to Claude
Code's own defaults, so a cloned repo's settings can't send the key elsewhere; Claude's
models and tiers stay as they are. A run with a provider of
its own (a model picked in Settings › Models) keeps that provider's settings.

With no key set, signed_in() changes nothing: the owner's own login works as it always has.
It acts only once activate() has named the running backend's hub (the feature does, as the
app's hub is made, before its first connection; never for a test's hub).

Eden Plus (account.py): a Mac linked to a Jarvis account runs Claude Code through
askeden.com's Anthropic-compatible proxy, whose own key and the account's allowance pay,
when the owner chose that in Settings (it then comes before an API key), or when JARVIS has
no other way in (no API key, and Claude Code isn't signed in to a Claude account). Those runs
go through the key proxy too, which sends them on to askeden.com's proxy with the account's
device token in the pass's place, as an API key's are: the token is never in an environment
(every command a session runs would inherit it) or on a command line, and every other
credential variable is blank, ANTHROPIC_API_KEY among them. The passes made here are one per
key for as long as the proxy knows them (a fresh one once it has forgotten one).
"""

from __future__ import annotations

import json
import os
import weakref
from typing import Any

PREF = "claude_signin"  # the provider holding the key JARVIS signs in with ("": the account)
KIND = "anthropic"
PLUS_BASE = "https://askeden.com/api/anthropic"
PLUS_CACHE = "jarvis-account"  # _CACHE's entry for Eden Plus's settings

_HUB: weakref.ReferenceType | None = None
# provider id -> (the proxy's address, the pass, the settings JSON): no key in it, and
# made again once the proxy has moved or forgotten the pass.
_CACHE: dict[str, tuple[str, str, str]] = {}


def _cached(name: str) -> str | None:
    from .key_proxy import GRANTS, PROXY

    found = _CACHE.get(name)
    if found is None:
        return None
    address, token, settings = found
    if address != PROXY.address or not GRANTS.alive(token):
        _CACHE.pop(name, None)
        return None
    return settings


def activate(hub: Any) -> None:
    """signed_in() follows this hub's sign-in from now on."""
    global _HUB
    _HUB = weakref.ref(hub)
    _clear()


def deactivate() -> None:
    global _HUB
    _HUB = None
    _clear()


def _clear() -> None:
    from .key_proxy import GRANTS

    for _address, token, _settings in _CACHE.values():
        GRANTS.revoke(token)
    _CACHE.clear()


def provider_of(hub: Any) -> Any:
    """The provider whose key JARVIS signs in with, while it's still there; else None."""
    try:
        pid = hub.prefs.feature(PREF)
        provider = hub.providers.providers.get(pid) if pid else None
    except Exception:
        return None
    return provider if provider is not None and provider.kind == KIND else None


def settings_for(provider: Any, store: Any = None) -> str:
    """The settings a run gets: the key proxy's address, a helper that prints the run's pass,
    and every other address, credential and model variable pinned to Claude Code's own
    (Anthropic's) defaults. store: the providers the key is looked up in (the hub's)."""
    cached = _cached(provider.id)
    if cached is None:
        from .key_proxy import PROXY, token_helper
        from .providers import session_pins

        if store is None:
            hub = _HUB() if _HUB is not None else None
            store = getattr(hub, "providers", None)
        if store is None:
            raise ValueError("No provider list to find the key in.")
        pins = session_pins(provider, "", os.environ)  # (the proxy started, its address)
        token = store.grant_for(provider)
        cached = json.dumps({"apiKeyHelper": token_helper(token), "env": pins})
        _CACHE[provider.id] = (PROXY.address, token, cached)
    return cached


def forget(provider_id: str) -> None:
    from .key_proxy import GRANTS

    found = _CACHE.pop(provider_id, None)
    if found is not None:
        GRANTS.revoke(found[1])


def plus_of(hub: Any) -> Any:
    """The account Jarvis's runs go through (Eden Plus), or None: linked, and either the
    owner chose it, or there's no other way in (no API key, Claude Code not signed in)."""
    account = getattr(hub, "account", None)
    if account is None or not getattr(account, "linked", False):
        return None
    from .account import PLUS_PREF

    try:
        chosen = hub.prefs.feature(PLUS_PREF) is True
    except Exception:
        chosen = False
    if chosen:
        return account
    if provider_of(hub) is None and getattr(account, "claude_signed_in", None) is False:
        return account
    return None


def plus_settings() -> str:
    """Eden Plus's settings: the key proxy's address (it sends each request on to askeden.com's
    proxy with the device token), a helper that prints the run's pass, every other address,
    credential and model variable blank, and the Mac's own network settings."""
    cached = _cached(PLUS_CACHE)
    if cached is None:
        from types import SimpleNamespace

        from .key_proxy import DIRECT, GRANTS, PROXY, token_helper
        from .providers import session_pins

        # (as an Anthropic key's: through the proxy, with every tier Claude's own)
        pins = session_pins(SimpleNamespace(kind=KIND, base_url=""), "", os.environ)
        token = GRANTS.mint(DIRECT, _plus_target)
        cached = json.dumps({"apiKeyHelper": token_helper(token), "env": pins})
        _CACHE[PLUS_CACHE] = (PROXY.address, token, cached)
    return cached


def _plus_target() -> tuple[str, str] | None:
    """Where an Eden Plus run's requests go, with the account's device token: while this Mac
    is still linked (the token as account.py holds it, read from the Keychain once)."""
    hub = _HUB() if _HUB is not None else None
    account = getattr(hub, "account", None)
    token = getattr(account, "token", "") if account is not None else ""
    if not token or not getattr(account, "linked", False):
        return None
    return PLUS_BASE, token


def using_plus() -> bool:
    """Whether Jarvis's runs go through Eden Plus now (the running backend's hub)."""
    hub = _HUB() if _HUB is not None else None
    return hub is not None and plus_of(hub) is not None


def signed_in(options: Any) -> Any:
    """A run's options, signed in with the API key when that's how JARVIS signs in. Options
    that already carry settings (a provider's own) are left as they are."""
    hub = _HUB() if _HUB is not None else None
    if hub is None or getattr(options, "settings", None) is not None:
        return options
    from .providers import CREDENTIAL_ENV

    wanted_model = str(getattr(options, "model", "") or "")
    if wanted_model.startswith("gemini"):
        store = getattr(hub, "providers", None)
        if store is not None:
            for item in getattr(store, "providers", ()):
                if item.get("kind") == "gemini":
                    try:
                        cfg = store.session_pins(item["id"], wanted_model)
                        options.settings = cfg["settings"]
                        options.env = {
                            **dict.fromkeys(CREDENTIAL_ENV, ""),
                            **(options.env or {}),
                            **(cfg.get("env") or {}),
                        }
                        return options
                    except Exception:
                        break
    if plus_of(hub) is not None:
        options.settings = plus_settings()
        # No credential of the owner's environment (ANTHROPIC_API_KEY…) rides along.
        options.env = {**(options.env or {}), **dict.fromkeys(CREDENTIAL_ENV, "")}
        return options
    provider = provider_of(hub)
    if provider is None:
        return options
    try:
        options.settings = settings_for(provider, hub.providers)
    except ValueError:  # (no provider list: the account's own sign-in, as without a key)
        return options
    # A credential inherited from the environment would outrank the helper's key.
    options.env = {**dict.fromkeys(CREDENTIAL_ENV, ""), **(options.env or {})}
    return options
