"""How every Claude Code run JARVIS starts signs in: its Claude account, as always, or the
user's own Anthropic API key when they pasted one (features/signin.py, Setup's Claude step).

The app people download can't sign its users in with their claude.ai subscription
(Anthropic's terms don't let another product offer that); its way in is the user's own API
key. That key lives where every provider key does (providers.py: the Keychain, sealed to
Anthropic's address), as the provider the feature pref claude_signin names.

Every site that makes a run's options passes them through signed_in(): the conversation
(brain.build_options), Jarvis Code and research (tasks), and the short background calls
(code_ai, meeting notes, reports, jobs, drafts, triage…). With a key in use, options that
have no settings of their own get an apiKeyHelper that reads the key from the Keychain (the
key itself is never in an environment or on a command line) and every address, credential
and model variable pinned to Claude Code's own defaults, so a cloned repo's settings can't
send the key elsewhere; Claude's models and tiers stay as they are. A run with a provider of
its own (a model picked in Settings › Models) keeps that provider's settings.

With no key set, signed_in() changes nothing: the owner's own login works as it always has.
It acts only once activate() has named the running backend's hub (the feature does, as the
app's hub is made, before its first connection; never for a test's hub).
"""

from __future__ import annotations

import json
import os
import weakref
from typing import Any

PREF = "claude_signin"  # the provider holding the key JARVIS signs in with ("": the account)
KIND = "anthropic"

_HUB: weakref.ReferenceType | None = None
_CACHE: dict[str, str] = {}  # provider id -> its settings JSON (nothing secret in it)


def activate(hub: Any) -> None:
    """signed_in() follows this hub's sign-in from now on."""
    global _HUB
    _HUB = weakref.ref(hub)
    _CACHE.clear()


def deactivate() -> None:
    global _HUB
    _HUB = None
    _CACHE.clear()


def provider_of(hub: Any) -> Any:
    """The provider whose key JARVIS signs in with, while it's still there; else None."""
    try:
        pid = hub.prefs.feature(PREF)
        provider = hub.providers.providers.get(pid) if pid else None
    except Exception:
        return None
    return provider if provider is not None and provider.kind == KIND else None


def settings_for(provider: Any) -> str:
    """The settings a run gets: the Keychain helper for the key, and every address,
    credential and model variable pinned to Claude Code's own (Anthropic's) defaults."""
    cached = _CACHE.get(provider.id)
    if cached is None:
        from .providers import keychain_helper, session_pins

        pins = session_pins(provider, "", os.environ)
        cached = json.dumps({"apiKeyHelper": keychain_helper(provider.id), "env": pins})
        _CACHE[provider.id] = cached
    return cached


def forget(provider_id: str) -> None:
    _CACHE.pop(provider_id, None)


def signed_in(options: Any) -> Any:
    """A run's options, signed in with the API key when that's how JARVIS signs in. Options
    that already carry settings (a provider's own) are left as they are."""
    hub = _HUB() if _HUB is not None else None
    if hub is None or getattr(options, "settings", None) is not None:
        return options
    provider = provider_of(hub)
    if provider is None:
        return options
    from .providers import CREDENTIAL_ENV

    options.settings = settings_for(provider)
    # A credential inherited from the environment would outrank the helper's key.
    options.env = {**dict.fromkeys(CREDENTIAL_ENV, ""), **(options.env or {})}
    return options
