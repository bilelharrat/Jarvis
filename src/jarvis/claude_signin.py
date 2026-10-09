"""How every Claude Code run JARVIS starts signs in: its Claude account, as always, or the
user's own Anthropic API key when they pasted one (features/signin.py, Setup's Claude step).

The app people download can't sign its users in with their claude.ai subscription
(Anthropic's terms don't let another product offer that); its way in is the user's own API
key. That key lives where every provider key does (providers.py: the Keychain, sealed to
Anthropic's address), as the provider the feature pref claude_signin names.

Every site that makes a run's options passes them through signed_in(): the conversation
(brain.build_options), Eden Code and research (tasks), and the short background calls
(code_ai, meeting notes, reports, jobs, drafts, triage…). With a key in use, options that
have no settings of their own get an apiKeyHelper that reads the key from the Keychain (the
key itself is never in an environment or on a command line) and every address, credential
and model variable pinned to Claude Code's own defaults, so a cloned repo's settings can't
send the key elsewhere; Claude's models and tiers stay as they are. A run with a provider of
its own (a model picked in Settings › Models) keeps that provider's settings.

With no key set, signed_in() changes nothing: the owner's own login works as it always has.
It acts only once activate() has named the running backend's hub (the feature does, as the
app's hub is made, before its first connection; never for a test's hub).

Jarvis Plus (account.py): a Mac linked to a Jarvis account runs Claude Code through
askeden.com's Anthropic-compatible proxy, whose own key and the account's allowance pay,
when the owner chose that in Settings (it then comes before an API key), or when JARVIS has
no other way in (no API key, and Claude Code isn't signed in to a Claude account). Those runs
get ANTHROPIC_BASE_URL set to the proxy and an apiKeyHelper that reads the account's device
token from the Keychain, as an API key's does: the token is never in an environment (every
command a session runs would inherit it) or on a command line, and every other credential
variable is blank, ANTHROPIC_API_KEY among them.
"""

from __future__ import annotations

import json
import os
import sys
import weakref
from typing import Any

PREF = "claude_signin"  # the provider holding the key JARVIS signs in with ("": the account)
KIND = "anthropic"
PLUS_BASE = "https://askeden.com/api/anthropic"
PLUS_CACHE = "jarvis-account"  # _CACHE's entry for Jarvis Plus's settings
# The apiKeyHelper for Jarvis Plus: the account's device token, read from the Keychain entry
# account.py keeps it in (JARVIS's own Python, which the entry trusts, in isolated mode).
PLUS_HELPER = """\
import sys
from keyring.backends import macOS
try:
    token = macOS.Keyring().get_password(sys.argv[1], sys.argv[2])
except Exception:
    sys.exit("Jarvis could not read its account from the Keychain.")
if not token:
    sys.exit("This Mac isn't linked to a Jarvis account any more.")
sys.stdout.write(token)
"""
if sys.platform == "win32":  # Credential Manager, through keyring
    PLUS_HELPER = """\
import sys
import keyring
try:
    token = keyring.get_password(sys.argv[1], sys.argv[2])
except Exception:
    sys.exit("Jarvis could not read its account from Credential Manager.")
if not token:
    sys.exit("This PC isn't linked to a Jarvis account any more.")
sys.stdout.write(token)
"""

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


def plus_of(hub: Any) -> Any:
    """The account JARVIS's runs go through (Jarvis Plus), or None: linked, and either the
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
    """Jarvis Plus's settings: the proxy's address, the token's helper, every other address,
    credential and model variable blank, and the Mac's own network settings."""
    cached = _CACHE.get(PLUS_CACHE)
    if cached is None:
        import shlex
        import sys
        from types import SimpleNamespace

        from .account import TOKEN_KEY, VAULT_ID
        from .connectors import SERVICE
        from .providers import session_pins

        pins = session_pins(SimpleNamespace(kind=KIND, base_url=""), "", os.environ)
        pins["ANTHROPIC_BASE_URL"] = PLUS_BASE
        helper = shlex.join(
            [sys.executable, "-I", "-c", PLUS_HELPER, SERVICE, f"{VAULT_ID}:{TOKEN_KEY}"]
        )
        cached = json.dumps({"apiKeyHelper": helper, "env": pins})
        _CACHE[PLUS_CACHE] = cached
    return cached


def using_plus() -> bool:
    """Whether JARVIS's runs go through Jarvis Plus now (the running backend's hub)."""
    hub = _HUB() if _HUB is not None else None
    return hub is not None and plus_of(hub) is not None


def signed_in(options: Any) -> Any:
    """A run's options, signed in with the API key when that's how JARVIS signs in. Options
    that already carry settings (a provider's own) are left as they are."""
    hub = _HUB() if _HUB is not None else None
    if hub is None or getattr(options, "settings", None) is not None:
        return options
    from .providers import CREDENTIAL_ENV

    if plus_of(hub) is not None:
        options.settings = plus_settings()
        # No credential of the owner's environment (ANTHROPIC_API_KEY…) rides along.
        options.env = {**(options.env or {}), **dict.fromkeys(CREDENTIAL_ENV, "")}
        return options
    provider = provider_of(hub)
    if provider is None:
        return options
    options.settings = settings_for(provider)
    # A credential inherited from the environment would outrank the helper's key.
    options.env = {**dict.fromkeys(CREDENTIAL_ENV, ""), **(options.env or {})}
    return options
