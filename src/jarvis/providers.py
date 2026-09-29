"""Models & API keys: other AI models for Jarvis Code, on the owner's own keys.

Jarvis Code sessions are Claude Code, which runs on the owner's Claude sign-in. Claude
Code can also talk to any endpoint that speaks Anthropic's Messages API, so the owner can
bring their own keys: their Anthropic API key (Claude, billed to the API account instead
of the plan), OpenRouter (GPT, Gemini, Grok, DeepSeek and hundreds more behind one key),
or a custom endpoint such as a LiteLLM proxy or a model running on this Mac. JARVIS itself
can use the same list.

This keeps that list and turns a choice into what a session needs: the model id and the
Claude Code settings that point it at the provider. Providers and models are saved in
~/Library/Application Support/Jarvis/providers.json with no secrets in it. Each key lives
in the macOS Keychain (connectors.Vault, under "provider:<id>"), sealed together with its
provider's kind, address and way of sending it, so an edited file can't send the key
anywhere else. It goes only to that address, over https unless the address is this Mac.

A session never gets the key in its environment or on its command line, where its own
shell commands (and so the model, or text planted in a repo) could read it. Claude Code
asks an apiKeyHelper for it instead: a short command that reads the Keychain entry and
prints the key. The session's settings carry that helper and pin every variable that
decides where requests go and with what credential; settings passed that way outrank the
project's own .claude/settings.json, so a cloned repo can't reroute the key or the
session. What no setting can stop: a program running as the owner can run the same
helper, as it could read any of JARVIS's Keychain entries. Hence the advice to use keys
with a spending limit.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import math
import os
import re
import shlex
import sys
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from claude_agent_sdk import create_sdk_mcp_server, tool

from . import jsonstore
from .connectors import SERVICE, Vault
from .prefs import APP_SUPPORT, MODEL_NAMES, MODELS

SERVER_NAME = "providers"
VAULT_PREFIX = "provider:"  # each key: Keychain entry "provider:<id>" / "api_key"
KEY_NAME = "api_key"
RECORD_VERSION = 1  # the Keychain entry is {"v", "key", "kind", "base_url", "auth"}
CUSTOM = "custom:"  # an added model's ref is "custom:<id>"
BUILTIN_NAME = "Claude"  # the built-in models, on the owner's own Claude sign-in
CHECK_TIMEOUT = 15.0  # seconds a provider may take to connect, or between bytes
CHECK_DEADLINE = 2 * CHECK_TIMEOUT  # seconds a whole check may take
MAX_PROVIDERS = 20
MAX_MODELS = 50  # per provider
MAX_LISTED = 2000  # models a check reports back
MAX_BODY = 8_000_000  # bytes a model list may run to
NAME_LIMIT = 40  # characters in a provider's name
LABEL_LIMIT = 60  # characters in a model's label
ANTHROPIC_VERSION = "2023-06-01"
OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key"
KEY_IN_WRONG_FIELD = (
    "That looks like an API key. Keys only go in the key field, which keeps them in the Keychain."
)
KEY_ADVICE = (
    "Set a spending limit on each key at its provider. Jarvis keeps keys in the Keychain and "
    "out of sessions' environment, but a program running as you on this Mac could still use one."
)


@dataclass(frozen=True)
class Kind:
    id: str
    name: str
    base_url: str  # its fixed address; "" when the owner gives one
    auth: str  # how the key is sent: "bearer" or "x-api-key"
    blurb: str
    key_prefix: str = ""  # what its keys start with, for the paste field's hint
    help_url: str = ""
    suggested: tuple[str, ...] = ()


KINDS: dict[str, Kind] = {
    "anthropic": Kind(
        "anthropic",
        "Anthropic API",
        "https://api.anthropic.com",
        "x-api-key",
        "Your own Anthropic API key: Claude, billed to your API account instead of your "
        "Claude plan.",
        "sk-ant-",
        "https://console.anthropic.com/settings/keys",
        tuple(MODELS.values()),
    ),
    "openrouter": Kind(
        "openrouter",
        "OpenRouter",
        "https://openrouter.ai/api",
        "bearer",
        "One key for hundreds of models, GPT, Gemini, Grok and DeepSeek among them, billed "
        "by OpenRouter.",
        "sk-or-",
        "https://openrouter.ai/settings/keys",
        ("openai/gpt-5", "google/gemini-2.5-pro", "x-ai/grok-4", "deepseek/deepseek-r1"),
    ),
    "custom": Kind(
        "custom",
        "Custom endpoint",
        "",
        "bearer",
        "Any server that speaks Anthropic's Messages API, like a LiteLLM proxy or a model "
        "running on this Mac.",
    ),
}
AUTHS = ("bearer", "x-api-key")
_AUTH_WORDS = {
    "bearer": "bearer",
    "token": "bearer",
    "authorization": "bearer",
    "x-api-key": "x-api-key",
    "api-key": "x-api-key",
    "apikey": "x-api-key",
    "header": "x-api-key",
}

# ── what a provider session pins ──
#
# Claude Code applies its settings' env over the process environment, and settings passed
# with --settings outrank the user's, the project's and the local ones. A provider
# session's settings set every variable below, so nothing inherited from the Mac or
# written in a cloned repo's .claude/settings.json can reroute the session or add a
# credential to it. A blank value counts as unset. Names checked against Claude Code
# 2.1.284 (the Agent SDK's bundled CLI); tests/test_providers.py scans the CLI for new ones.

# Where model requests go: the provider's address, and every other address and backend
# switched off.
DESTINATION_ENV = (
    "ANTHROPIC_BASE_URL",
    "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
    "CLAUDE_CODE_API_BASE_URL",
    "ANTHROPIC_UNIX_SOCKET",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "CLAUDE_CODE_SKIP_MANTLE_AUTH",
    "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
    "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
)
# What Claude Code would send instead of the helper's key: other keys and tokens, the
# owner's own sign-in, extra headers, and the switches that make it pass the helper over
# (a host-managed provider, a remote session). The helper's key is the only credential.
CREDENTIAL_ENV = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
    "CLAUDE_CODE_HOST_CREDS_FILE",
    "CLAUDE_CODE_REMOTE",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "ANTHROPIC_AWS_API_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
)
# Claude Code picks a model by tier for side jobs and subagents (titles, quick checks,
# "use haiku for this"). Behind another provider every tier is the chosen model: no
# request goes to a model the owner didn't pick, and a local model keeps it all local.
TIER_ENV = (
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
)
MODEL_ENV = (
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    *TIER_ENV,
)
# How requests reach the network. Pinned to what this Mac already uses (blank when it
# uses none), so a project can't slip in a proxy or turn certificate checks off.
NETWORK_ENV = (
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "CLAUDE_CODE_HTTPS_PROXY",
    "CLAUDE_CODE_HTTP_PROXY",
    "CLAUDE_CODE_PROXY_RESOLVES_HOSTS",
    "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER",
    "NODE_USE_ENV_PROXY",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "NODE_EXTRA_CA_CERTS",
    "CLAUDE_CODE_CERT_STORE",
)
_PROXY_URLS = frozenset(  # the ones that hold a proxy's address, perhaps with a password
    (
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
        "CLAUDE_CODE_HTTPS_PROXY",
        "CLAUDE_CODE_HTTP_PROXY",
    )
)
ROUTING_ENV = (*DESTINATION_ENV, *CREDENTIAL_ENV, *MODEL_ENV, *NETWORK_ENV)

# The apiKeyHelper Claude Code runs (through /bin/sh, in the project's folder) for a
# provider session's key. Python in isolated mode keeps the project's folder and PYTHON*
# variables off its import path, and keyring's macOS backend is used directly so no
# keyring config can swap it. It prints only the key; anything else goes to stderr.
HELPER_CODE = """\
import json, sys
from keyring.backends import macOS
try:
    saved = macOS.Keyring().get_password(sys.argv[1], sys.argv[2])
except Exception:
    sys.exit("Jarvis could not read the key from the Keychain.")
try:
    key = json.loads(saved or "")["key"]
except Exception:
    key = None
if not isinstance(key, str) or not key:
    sys.exit("Jarvis has no key saved for this provider.")
sys.stdout.write(key)
"""

_ID = re.compile(r"[a-z0-9]{6,32}")
_HOST = re.compile(r"[a-z0-9](?:[a-z0-9_.\-]*[a-z0-9])?")
_PATH = re.compile(r"(?:/[A-Za-z0-9._~%\-]+)*")
_V1_TAIL = re.compile(r"(?:/v1(?:/messages|/models)?)?/*$", re.IGNORECASE)
_MODEL_ID = re.compile(r"~?[A-Za-z0-9][A-Za-z0-9._:/@+_\-]{0,190}(?:\[[A-Za-z0-9]{1,8}\])?")
_KEY_CHARS = re.compile(r"[\x21-\x7e]+")
_HINT = re.compile(r"(?:sk-)?(?:…[\x21-\x7e]{4}|••••)")
# What API keys look like: a vendor prefix (at the start, or after a space or other
# separator), Google's AIza, or a long unbroken run of letters and digits. Model ids and
# names are short words between dashes, dots and slashes.
_VENDOR = r"(?:sk|pk|rk|gsk|xai|gh[pousr])[-_]"
_KEYISH = re.compile(
    rf"^{_VENDOR}|(?:^|[^A-Za-z0-9]){_VENDOR}[A-Za-z0-9_\-]{{8,}}"
    r"|AIza[0-9A-Za-z_\-]{20,}|[A-Za-z0-9]{28,}"
)
_KEY_IN_URL = re.compile(r"(?:^|[/.])(?:sk|gsk|xai)[-_]", re.IGNORECASE)
# A dated or "latest" name for an undated model id: claude-opus-4-1-20250805,
# gpt-4o-2024-08-06, claude-3-5-sonnet-v2@20241022, claude-sonnet-4-latest.
_DATED = r"(?:[-@](?:\d{8}|\d{4}-\d{2}-\d{2})|-latest)"


# ── what's kept ──


# Context windows of other providers' models, in tokens, matched on the id's last part (the
# first pattern that matches wins, so specific ones come first). Claude Code knows its own
# models' windows; for anyone else's it guesses, so the window shows these instead. As
# published by each provider; a model not listed shows what Claude Code reports.
CONTEXT_WINDOWS: list[tuple[str, int]] = [
    (r"gemini-1\.5-pro", 2_000_000),
    (r"gemini-(1\.5-flash|2|3)", 1_048_576),
    (r"gpt-5", 400_000),
    (r"gpt-4\.1", 1_047_576),
    (r"gpt-4o|gpt-4-turbo", 128_000),
    (r"\bo[134](-mini|-pro)?\b", 200_000),
    (r"grok-4-fast", 2_000_000),
    (r"grok-4|grok-code", 256_000),
    (r"grok-3", 131_072),
    (r"llama-4-scout", 10_000_000),
    (r"llama-4-maverick", 1_000_000),
    (r"deepseek", 128_000),
    (r"kimi-k2", 262_144),
    (r"qwen3-coder", 262_144),
    (r"mistral-large|codestral", 128_000),
]


def context_window(model: str | None) -> int | None:
    """A non-Claude model's context window in tokens, or None (Claude, or not listed)."""
    name = str(model or "").strip().lower().rsplit("/", 1)[-1]
    if not name or name.startswith("claude"):
        return None
    for pattern, tokens in CONTEXT_WINDOWS:
        if re.search(pattern, name):
            return tokens
    return None


@dataclass
class Provider:
    id: str
    kind: str  # anthropic | openrouter | custom
    name: str
    base_url: str  # the Anthropic-compatible endpoint, without /v1
    auth: str  # how the key is sent: "bearer" or "x-api-key"
    key_hint: str = ""  # the key as the window shows it ("sk-…1234"), never the key
    added: str = ""


@dataclass
class ModelEntry:
    id: str
    provider: str
    model: str  # the id the provider knows it by, e.g. "openai/gpt-5"
    label: str


# ── checking what the owner typed ──


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _plain(value: Any, limit: int) -> str:
    """One line of printable text, whitespace collapsed, at most limit characters."""
    text = "".join(c if c.isprintable() else " " for c in str(value or ""))
    return " ".join(text.split())[:limit].strip()


def looks_like_key(text: Any) -> bool:
    return bool(_KEYISH.search(str(text or "").strip()))


def clean_key(value: Any) -> str:
    """The API key as pasted, minus stray spaces and a "Bearer " in front of it."""
    key = str(value or "").strip()
    if key[:7].lower() == "bearer ":
        key = key[7:].strip()
    if not key:
        raise ValueError("Paste the API key first.")
    if len(key) > 4096:
        raise ValueError("That's far too long for an API key; paste just the key.")
    if not _KEY_CHARS.fullmatch(key):
        raise ValueError("That key has spaces or unusual characters in it; paste just the key.")
    return key


def mask(key: str) -> str:
    """How a key shows in the window: its public prefix and last four, never the rest."""
    prefix = "sk-" if key.startswith("sk-") else ""
    if len(key) < 16:  # too short to show any of it
        return f"{prefix}••••"
    return f"{prefix}…{key[-4:]}"


def is_local(host: str) -> bool:
    """Whether a host is this Mac itself."""
    host = host.strip("[]").lower()
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def clean_base_url(value: Any) -> str:
    """A custom endpoint's address as Claude Code wants it: https (plain http only on this
    Mac), a host, an optional port and path, no /v1 on the end, and no user name,
    password, ? or # in it."""
    text = str(value or "").strip()
    if not text:
        raise ValueError("Give the endpoint's address, like https://llm.example.com.")
    if len(text) > 300 or any(c.isspace() or not c.isprintable() for c in text):
        raise ValueError("That address has spaces or odd characters in it.")
    if "?" in text or "#" in text:
        raise ValueError("The address shouldn't have a ? or # part.")
    try:
        if "://" not in text:
            host = urlsplit(f"//{text}").hostname or ""
            text = f"{'http' if is_local(host) else 'https'}://{text}"
        parts = urlsplit(text)
        host, port = parts.hostname or "", parts.port
    except ValueError:
        raise ValueError("That doesn't look like a web address.") from None
    scheme = parts.scheme.lower()
    if host == "0.0.0.0":  # as a destination that's this Mac (LiteLLM's docs use it)
        host = "127.0.0.1"
    if scheme not in ("http", "https") or not host:
        raise ValueError("The address should start with https://.")
    if parts.username is not None or parts.password is not None:
        raise ValueError(
            "Leave the user name and password out of the address; the key goes in its own field."
        )
    if ":" in host:
        _ipv6(host)
    elif not _HOST.fullmatch(host):
        raise ValueError("That doesn't look like a web address.")
    if scheme == "http" and not is_local(host):
        raise ValueError(
            "Use https: over plain http the key would cross the network unencrypted. Only "
            "this Mac (localhost) may use http."
        )
    path = _V1_TAIL.sub("", parts.path)
    if not _PATH.fullmatch(path):
        raise ValueError("That address has odd characters in its path.")
    if _KEY_IN_URL.search(host) or _KEY_IN_URL.search(path):
        raise ValueError(KEY_IN_WRONG_FIELD)
    netloc = f"[{host}]" if ":" in host else host
    return f"{scheme}://{netloc}{f':{port}' if port is not None else ''}{path}"


def _ipv6(host: str) -> None:
    try:
        ipaddress.IPv6Address(host)
    except ValueError:
        raise ValueError("That doesn't look like a web address.") from None


def clean_model_id(value: Any) -> str:
    """A model's id as its provider knows it: openai/gpt-5, claude-opus-5-5,
    ~anthropic/claude-opus-latest[1m], deepseek/deepseek-r1:free, …"""
    text = str(value or "").strip()
    if not text:
        raise ValueError("Which model? Give its id, like openai/gpt-5.")
    if looks_like_key(text):
        raise ValueError(KEY_IN_WRONG_FIELD)
    if not _MODEL_ID.fullmatch(text):
        raise ValueError(
            "That doesn't look like a model id; ids look like openai/gpt-5 or claude-opus-5-5."
        )
    return text


def clean_name(value: Any, limit: int = NAME_LIMIT) -> str:
    """A name or label the owner gave; one that looks like a key is refused, since names
    are saved in a plain file."""
    text = _plain(value, limit)
    if looks_like_key(value) or looks_like_key(text):
        raise ValueError(KEY_IN_WRONG_FIELD)
    return text


def _clean_auth(spec: Kind, value: Any) -> str:
    if spec.id != "custom" or value in (None, ""):
        return spec.auth
    way = _AUTH_WORDS.get(str(value).strip().lower())
    if way is None:
        raise ValueError("Send the key as a bearer token or as an x-api-key header.")
    return way


def _check_key_kind(spec: Kind, key: str) -> None:
    """Catch a key pasted under the wrong provider before it's sent anywhere: an
    Anthropic key never goes to OpenRouter, nor an OpenRouter key to Anthropic."""
    if spec.id == "anthropic" and key.startswith("sk-or-"):
        raise ValueError("That's an OpenRouter key; add it as OpenRouter instead.")
    if spec.id == "openrouter" and key.startswith("sk-ant-"):
        raise ValueError(
            "That's an Anthropic key; add it as Anthropic API instead. It shouldn't go to "
            "OpenRouter."
        )


def _id_shaped(label: str) -> bool:
    """A label that reads as a model id (vendor/model), not a name."""
    return "/" in label and bool(_MODEL_ID.fullmatch(label))


# ── the key's Keychain entry ──


def _seal(provider: Provider, key: str) -> str:
    """The Keychain entry: the key with where it may go, so the plain file can't redirect
    it."""
    record = {
        "v": RECORD_VERSION,
        "key": key,
        "kind": provider.kind,
        "base_url": provider.base_url,
        "auth": provider.auth,
    }
    return json.dumps(record, separators=(",", ":"))


def _unseal(saved: str) -> dict[str, str] | None:
    """A Keychain entry read back; None when it isn't one of these (an older bare key)."""
    try:
        record = json.loads(saved)
    except (ValueError, RecursionError):
        return None
    fields = ("key", "kind", "base_url", "auth")
    if not isinstance(record, dict) or record.get("v") != RECORD_VERSION:
        return None
    if not all(isinstance(record.get(name), str) for name in fields) or not record["key"]:
        return None
    return {name: record[name] for name in fields}


def _belongs(record: dict[str, str], provider: Provider) -> bool:
    return (record["kind"], record["base_url"], record["auth"]) == (
        provider.kind,
        provider.base_url,
        provider.auth,
    )


def _mismatch(provider: Provider) -> str:
    return (
        f"{provider.name}'s saved type or address doesn't match the key it was added with, so "
        "I haven't sent the key anywhere. Remove it and add it again in Settings › Models."
    )


def keychain_helper(provider_id: str, python: str | None = None) -> str:
    """The apiKeyHelper command for a provider's key: JARVIS's own Python (the program the
    Keychain entry trusts, so no prompt) running HELPER_CODE on the entry. It names the
    entry, never the key."""
    account = f"{VAULT_PREFIX}{provider_id}:{KEY_NAME}"
    return shlex.join([python or sys.executable, "-I", "-c", HELPER_CODE, SERVICE, account])


# ── reading the file back ──


def _dicts(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _read_row(read: Callable[[dict[str, Any]], Any], raw: dict[str, Any]) -> Any:
    """One row of the file, or None when it's too odd to read (nested past reason, a
    number past what a float holds): it never stops the rest from loading."""
    try:
        return read(raw)
    except (RecursionError, OverflowError, TypeError, ValueError):
        return None


def _provider_from(raw: dict[str, Any]) -> Provider | None:
    """A provider read back from the file, checked again: the file is plain text anyone
    can edit. Its key's Keychain entry says where the key may go, so an address or kind
    changed here stops the key being sent at all (see ProviderStore._saved)."""
    spec = KINDS.get(str(raw.get("kind", "")))
    pid = str(raw.get("id", ""))
    if spec is None or not _ID.fullmatch(pid):
        return None
    try:
        base_url = clean_base_url(raw.get("base_url")) if spec.id == "custom" else spec.base_url
    except ValueError:
        return None
    try:
        name = clean_name(raw.get("name"))
    except ValueError:  # a key where the name goes: drop the name, keep the provider
        name = ""
    auth = raw.get("auth") if spec.id == "custom" and raw.get("auth") in AUTHS else spec.auth
    hint = str(raw.get("key_hint", ""))
    return Provider(
        id=pid,
        kind=spec.id,
        name=name or spec.name,
        base_url=base_url,
        auth=str(auth),
        key_hint=hint if _HINT.fullmatch(hint) else "",
        added=_plain(raw.get("added"), 32),
    )


def _entry_from(raw: dict[str, Any]) -> ModelEntry | None:
    mid = str(raw.get("id", ""))
    if not _ID.fullmatch(mid):
        return None
    try:
        model = clean_model_id(raw.get("model"))
    except ValueError:
        return None
    try:
        label = clean_name(raw.get("label"), LABEL_LIMIT)
    except ValueError:
        label = ""
    return ModelEntry(
        id=mid, provider=str(raw.get("provider", "")), model=model, label=label or model
    )


# ── the store ──


Helper = Callable[[str], str]  # a provider id -> the apiKeyHelper command for its key


class ProviderStore:
    """The providers and models the owner added. Keys stay in the Keychain."""

    def __init__(
        self, path: Path | None = None, vault: Vault | None = None, *, helper: Helper | None = None
    ) -> None:
        self.path = path or APP_SUPPORT / "providers.json"
        self.vault = vault if vault is not None else Vault()
        self.helper = helper or keychain_helper
        self.providers: dict[str, Provider] = {}
        self.entries: dict[str, ModelEntry] = {}
        self.status: dict[str, dict[str, Any]] = {}  # each provider's last check, this run
        self._versions: dict[str, int] = {}  # bumped when a provider's key changes or goes
        self.unreadable = ""  # why the file can't be read now: nothing is saved over it
        self._load()

    # persistence

    def _load(self) -> None:
        """A damaged file is kept aside and its last good copy read; one that can't be read
        just now is left alone, and nothing is saved over it."""
        try:
            data = jsonstore.load_json(self.path, dict)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            return
        if not isinstance(data, dict):
            return
        for raw in _dicts(data.get("providers"))[: MAX_PROVIDERS * 5]:
            provider = _read_row(_provider_from, raw)
            if provider is None or provider.id in self.providers:
                continue
            if len(self.providers) >= MAX_PROVIDERS:
                break
            # A name that clashes (by hand, or cut short at 40 characters) is numbered,
            # never dropped: dropping it would strand the provider's key in the Keychain.
            provider.name = self._unique_name(provider.name)
            self.providers[provider.id] = provider
        self._load_models(_dicts(data.get("models"))[: MAX_PROVIDERS * MAX_MODELS * 2])

    def _load_models(self, raws: list[dict[str, Any]]) -> None:
        counts: dict[str, int] = {}
        pairs: set[tuple[str, str]] = set()
        for raw in raws:
            entry = _read_row(_entry_from, raw)
            if entry is None or entry.id in self.entries or entry.provider not in self.providers:
                continue
            pair = (entry.provider, entry.model)
            if pair in pairs or counts.get(entry.provider, 0) >= MAX_MODELS:
                continue
            pairs.add(pair)
            counts[entry.provider] = counts.get(entry.provider, 0) + 1
            self.entries[entry.id] = entry
        self._fix_labels()

    def _fix_labels(self) -> None:
        """A label edited in by hand that would pass one model off as another (another
        model's id, or a label shown twice on one provider) goes back to the model's own
        id, which is unique on its provider."""
        for entry in self.entries.values():
            if self._passes_off(entry.provider, entry.model, entry.label, entry.id):
                entry.label = entry.model

    def _save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        data = {
            "version": 1,
            "providers": [asdict(p) for p in self.providers.values()],
            "models": [asdict(m) for m in self.entries.values()],
        }
        jsonstore.save_json(self.path, data)

    def _persist(self) -> None:
        try:
            self._save()
        except OSError as exc:
            raise ValueError(
                f"I couldn't save the model list ({exc.strerror or 'disk error'})."
            ) from None

    def _snapshot(self) -> tuple[dict[str, Provider], dict[str, ModelEntry], dict[str, Any]]:
        return dict(self.providers), dict(self.entries), dict(self.status)

    def _restore(
        self, snapshot: tuple[dict[str, Provider], dict[str, ModelEntry], dict[str, Any]]
    ) -> None:
        providers, entries, status = snapshot
        self.providers.clear()
        self.providers.update(providers)
        self.entries.clear()
        self.entries.update(entries)
        self.status.clear()
        self.status.update(status)

    # the Keychain

    def _read_vault(self, provider_id: str) -> str | None:
        try:
            return self.vault.get(VAULT_PREFIX + provider_id, KEY_NAME)
        except Exception:  # a locked or unavailable Keychain
            raise ValueError(
                "I couldn't read the Keychain. If it's locked, unlock it and try again."
            ) from None

    def _set_key(self, provider: Provider, key: str) -> None:
        try:
            self.vault.set(VAULT_PREFIX + provider.id, KEY_NAME, _seal(provider, key))
        except Exception:  # a locked or unavailable Keychain
            raise ValueError(
                "I couldn't save the key in the Keychain, so nothing changed."
            ) from None

    def _put_back(self, provider_id: str, saved: str | None) -> None:
        """The Keychain entry as it was before a change that couldn't be saved."""
        with contextlib.suppress(Exception):
            if saved is None:
                self.vault.delete(VAULT_PREFIX + provider_id, KEY_NAME)
            else:
                self.vault.set(VAULT_PREFIX + provider_id, KEY_NAME, saved)

    def _saved(self, provider: Provider) -> dict[str, str]:
        """The provider's Keychain entry, once it's certain the key belongs to this very
        provider: its kind, address and way of sending the key as the key was saved with.
        ValueError, in words to show, otherwise."""
        try:
            saved = self._read_vault(provider.id)
        except ValueError:
            raise ValueError(
                f"I couldn't read {provider.name}'s key from the Keychain. If it's locked, "
                "unlock it and try again."
            ) from None
        if not saved:
            raise ValueError(
                f"There's no key saved for {provider.name}. Paste its key again in Settings › Models."
            )
        record = _unseal(saved)
        if record is None:
            raise ValueError(
                f"{provider.name}'s key was saved by an older version of Jarvis. Paste it again "
                "in Settings › Models."
            )
        if not _belongs(record, provider):
            raise ValueError(_mismatch(provider))
        return record

    def _key(self, provider: Provider) -> str:
        return self._saved(provider)["key"]

    def _bump(self, provider_id: str) -> None:
        self._versions[provider_id] = self._versions.get(provider_id, 0) + 1

    # providers

    def add_provider(
        self,
        kind: str,
        name: str,
        api_key: str,
        base_url: str | None = None,
        *,
        auth: str | None = None,
    ) -> dict[str, Any]:
        """Add a provider with its key (kept in the Keychain). base_url is for a custom
        endpoint; auth ("bearer" or "x-api-key") too. An Anthropic API provider comes
        with the Claude models ready to pick. Raises ValueError, in words to show."""
        spec = KINDS.get(str(kind or "").strip().lower())
        if spec is None:
            raise ValueError("Choose Anthropic API, OpenRouter or Custom endpoint.")
        key = clean_key(api_key)
        _check_key_kind(spec, key)
        url = clean_base_url(base_url) if spec.id == "custom" else spec.base_url
        name = self._new_name(spec, name, url)
        way = _clean_auth(spec, auth)
        if len(self.providers) >= MAX_PROVIDERS:
            raise ValueError(f"That's {MAX_PROVIDERS} providers already; remove one first.")
        provider = Provider(uuid.uuid4().hex[:12], spec.id, name, url, way, mask(key), _now())
        self._set_key(provider, key)  # the Keychain first: never a provider without a key
        self.providers[provider.id] = provider
        if spec.id == "anthropic":
            for ref, model in MODELS.items():
                self._add_entry(provider.id, model, MODEL_NAMES[ref])
        try:
            self._persist()
        except ValueError:
            self._forget(provider.id)
            self._put_back(provider.id, None)
            raise
        return self._public_provider(provider)

    def replace_key(self, provider_id: str, api_key: str) -> dict[str, Any]:
        """A new key for a provider (a rotated or mistyped one); its models stay. Refused
        when the provider's saved type or address no longer matches its old key."""
        provider = self._provider(provider_id)
        key = clean_key(api_key)
        before = self._read_vault(provider.id)
        record = _unseal(before) if before else None
        if record is not None and not _belongs(record, provider):
            raise ValueError(_mismatch(provider))  # an edited file: re-pasting can't bless it
        _check_key_kind(KINDS[provider.kind], key)
        self._set_key(provider, key)
        hint, status = provider.key_hint, self.status.pop(provider.id, None)
        provider.key_hint = mask(key)
        self._bump(provider.id)  # a check of the old key still running won't count
        try:
            self._persist()
        except ValueError:
            provider.key_hint = hint
            if status is not None:
                self.status[provider.id] = status
            self._put_back(provider.id, before)
            raise
        return self._public_provider(provider)

    def remove_provider(self, provider_id: str) -> bool:
        """Remove a provider, its key and its models. False if there's no such provider.
        The list is saved first; if the key can't then leave the Keychain, the provider
        stays rather than leave its key behind."""
        provider = self.providers.get(str(provider_id or ""))
        if provider is None:
            return False
        before = self._snapshot()
        self._forget(provider.id)
        self._bump(provider.id)
        try:
            self._persist()
        except ValueError:
            self._restore(before)
            raise
        try:
            self.vault.delete(VAULT_PREFIX + provider.id, KEY_NAME)
        except Exception:  # a locked Keychain: keep the provider rather than orphan its key
            self._restore(before)
            with contextlib.suppress(ValueError):
                self._persist()
            raise ValueError(
                f"I couldn't take {provider.name}'s key out of the Keychain, so I've left it "
                "in place. Try again."
            ) from None
        return True

    def _forget(self, provider_id: str) -> None:
        self.providers.pop(provider_id, None)
        self.status.pop(provider_id, None)
        for entry in self.models_of(provider_id):
            del self.entries[entry.id]

    def _provider(self, provider_id: str) -> Provider:
        provider = self.providers.get(str(provider_id or ""))
        if provider is None:
            raise ValueError("There's no provider like that; it may have been removed.")
        return provider

    def _taken(self, name: str) -> bool:
        return any(p.name.casefold() == name.casefold() for p in self.providers.values())

    def _unique_name(self, stem: str) -> str:
        """stem, or stem numbered ("Box 2") when another provider has it, never over
        NAME_LIMIT characters."""
        stem = stem[:NAME_LIMIT].strip()
        if not self._taken(stem):
            return stem
        for n in range(2, MAX_PROVIDERS * 5 + 2):
            suffix = f" {n}"
            candidate = f"{stem[: NAME_LIMIT - len(suffix)].rstrip()}{suffix}"
            if not self._taken(candidate):
                return candidate
        return f"Provider {uuid.uuid4().hex[:8]}"

    def _new_name(self, spec: Kind, name: Any, base_url: str) -> str:
        given = clean_name(name)
        if given:
            if self._taken(given):
                raise ValueError(f"There's already a provider called {given}; pick another name.")
            return given
        stem = spec.name
        if spec.id == "custom":
            host = _plain(urlsplit(base_url).netloc, NAME_LIMIT)
            stem = spec.name if not host or looks_like_key(host) else host
        return self._unique_name(stem)

    def find_provider(self, text: str) -> Provider | None:
        """A provider by its id or name, or by its kind when there's just one of that kind."""
        want = " ".join(str(text or "").split()).casefold()
        if not want:
            return None
        if want in self.providers:
            return self.providers[want]
        for provider in self.providers.values():
            if provider.name.casefold() == want:
                return provider
        kinds = {k.id for k in KINDS.values() if want in (k.id, k.name.casefold())}
        same = [p for p in self.providers.values() if p.kind in kinds]
        return same[0] if len(same) == 1 else None

    # models

    def can_add(self, provider_id: str, model: Any, label: Any = None) -> tuple[Provider, str, str]:
        """The provider, the tidied model id and the tidied label ("" for none) when that
        model can go on its list; ValueError saying why not otherwise."""
        provider = self.providers.get(str(provider_id or ""))
        if provider is None:
            raise ValueError("Add the provider first, then its models.")
        model_id = clean_model_id(model)
        label = clean_name(label, LABEL_LIMIT)
        if self._offers(provider.id, model_id):
            raise ValueError(f"{model_id} is already on {provider.name}'s list.")
        shown = label or model_id
        if self._passes_off(provider.id, model_id, shown):
            raise ValueError(
                f"{shown} would look like another model on {provider.name}'s list; give it "
                "a label of its own."
            )
        if len(self.models_of(provider.id)) >= MAX_MODELS:
            raise ValueError(f"{provider.name} has {MAX_MODELS} models already; remove one first.")
        return provider, model_id, label

    def _passes_off(self, provider_id: str, model: str, shown: str, own_id: str = "") -> bool:
        """Whether showing model as shown would pass it off as another model: an id-like
        label that isn't its own id, or what another of the provider's models is called
        or shown as. (The provider's name follows every label, so other providers don't
        count.)"""
        want = shown.casefold()
        own = want == model.casefold()
        if not own and _id_shaped(shown):
            return True
        for entry in self.models_of(provider_id):
            if entry.id == own_id:
                continue
            if want == entry.label.casefold() or (not own and want == entry.model.casefold()):
                return True
        return False

    def add_model(self, provider_id: str, model: str, label: str | None = None) -> dict[str, Any]:
        """Add a model to a provider's list; label is how it's shown (default: its id)."""
        provider, model_id, label = self.can_add(provider_id, model, label)
        entry = self._add_entry(provider.id, model_id, label)
        try:
            self._persist()
        except ValueError:
            del self.entries[entry.id]
            raise
        return self._public_model(entry)

    def _add_entry(self, provider_id: str, model: str, label: Any) -> ModelEntry:
        entry = ModelEntry(
            uuid.uuid4().hex[:12], provider_id, model, clean_name(label, LABEL_LIMIT) or model
        )
        self.entries[entry.id] = entry
        return entry

    def remove_model(self, ref: str) -> bool:
        """Remove an added model by its ref ("custom:<id>") or id. False if it isn't there."""
        entry = self._entry(ref)
        if entry is None:
            return False
        before = self._snapshot()
        del self.entries[entry.id]
        try:
            self._persist()
        except ValueError:
            self._restore(before)
            raise
        return True

    def _entry(self, ref: str) -> ModelEntry | None:
        ref = str(ref or "").strip()
        return self.entries.get(ref.removeprefix(CUSTOM))

    def _offers(self, provider_id: str, model: str) -> bool:
        return any(e.model == model for e in self.models_of(provider_id))

    def models_of(self, provider_id: str) -> list[ModelEntry]:
        return [e for e in self.entries.values() if e.provider == provider_id]

    def find_models(self, text: str) -> list[ModelEntry]:
        """Added models matching a ref, an id, a model id or a label (any case)."""
        entry = self._entry(text)
        if entry is not None:
            return [entry]
        want = " ".join(str(text or "").split()).casefold()
        if not want:
            return []
        return [
            e
            for e in self.entries.values()
            if want in (e.model.casefold(), e.label.casefold(), self._title(e).casefold())
        ]

    def models(self) -> list[dict[str, Any]]:
        """Every model a session can use: the built-in Claude ones first (their refs are
        the prefs keys), then the added ones (refs "custom:<id>")."""
        out = [
            {
                "ref": ref,
                "model": model,
                "label": MODEL_NAMES[ref],
                "name": MODEL_NAMES[ref],
                "provider": "",
                "provider_name": BUILTIN_NAME,
                "kind": "builtin",
                "builtin": True,
            }
            for ref, model in MODELS.items()
        ]
        for provider in self.providers.values():
            out += [self._public_model(e) for e in self.models_of(provider.id)]
        return out

    def _title(self, entry: ModelEntry) -> str:
        return f"{entry.label} · {self.providers[entry.provider].name}"

    def describe(self, ref: str | None) -> str:
        """A model's name for people ("Opus 5.5", "openai/gpt-5 · OpenRouter")."""
        ref = str(ref or "").strip()
        if ref in MODELS:
            return MODEL_NAMES[ref]
        for key, model in MODELS.items():
            if model == ref:
                return MODEL_NAMES[key]
        entry = self._entry(ref) if ref.startswith(CUSTOM) else None
        return self._title(entry) if entry is not None else ref

    def known(self, ref: str | None) -> bool:
        """Whether a ref names a model on the list: a built-in key or an added model."""
        ref = str(ref or "").strip()
        return ref in MODELS or (ref.startswith(CUSTOM) and self._entry(ref) is not None)

    # sessions

    def session_config(
        self, ref: str | None, environ: Mapping[str, str] | None = None
    ) -> dict[str, Any]:
        """What a Claude Code session needs for a model: "model" (for the model option),
        "env" (to merge into ClaudeAgentOptions.env) and "settings" (a JSON string for
        ClaudeAgentOptions.settings, or None), plus a "label", the "provider" id ("" for
        Claude on the owner's sign-in) and whether it's a "claude" model.

        A built-in model (or none: the default) runs exactly as before: no settings, no
        extra environment. Another provider's model gets settings with an apiKeyHelper
        that reads its key from the Keychain and env pins that send every request to the
        provider's address with that key and nothing else. The key itself is in none of
        it. env only blanks inherited credentials: applied without the settings, the
        session goes nowhere near the provider. environ is this Mac's environment (for
        the network pins); tests pass their own. Raises ValueError, in words to show,
        for a model that's gone or whose key is missing or doesn't match."""
        ref = str(ref or "").strip()
        if not ref:
            return _config(None, "", "", True)
        if ref in MODELS:
            return _config(MODELS[ref], MODEL_NAMES[ref], "", True)
        if not ref.startswith(CUSTOM):  # a model id as Claude Code knows it, as before
            model = clean_model_id(ref)
            return _config(model, self.describe(model), "", True)
        entry = self._entry(ref)
        provider = self.providers.get(entry.provider) if entry is not None else None
        if entry is None or provider is None:
            raise ValueError("That model isn't on the list any more; pick another one.")
        self._saved(provider)  # a key is there, and it belongs to this very address
        pins = session_pins(provider, entry.model, os.environ if environ is None else environ)
        settings = {"apiKeyHelper": self.helper(provider.id), "env": pins}
        claude = provider.kind == "anthropic" or "claude" in entry.model.lower()
        return _config(
            entry.model,
            self._title(entry),
            provider.id,
            claude,
            env=dict.fromkeys(CREDENTIAL_ENV, ""),
            settings=json.dumps(settings),
        )

    # checking a key

    async def check(
        self, provider_id: str, client: httpx.AsyncClient | None = None
    ) -> dict[str, Any]:
        """Try a provider's key by listing the models it offers: {"ok", "models": [{"id",
        "name", "tools"}], "error", "note", "missing"}; error and note are sentences
        JARVIS can say, missing the added models the provider doesn't list. Never
        raises, and never takes longer than CHECK_DEADLINE."""
        provider = self.providers.get(str(provider_id or ""))
        if provider is None:
            return _checked(False, error="There's no provider like that; it may have been removed.")
        version = self._versions.get(provider.id, 0)
        try:
            key = self._key(provider)
        except ValueError as exc:
            return self._note(provider, version, _checked(False, error=str(exc)))
        try:
            if client is None:
                async with _default_client() as own:
                    result = await _probe(provider, key, own)
            else:
                result = await _probe(provider, key, client)
        except Exception as exc:  # anything unforeseen is a failed check, not a crash
            result = _checked(
                False, error=f"I couldn't check {provider.name} ({type(exc).__name__})."
            )
        return self._note(provider, version, result)

    def _note(self, provider: Provider, version: int, result: dict[str, Any]) -> dict[str, Any]:
        """Keep a check's result as the provider's status, unless the provider went or
        its key changed while the check ran."""
        if self.providers.get(provider.id) is not provider:  # removed while being checked
            return result
        if self._versions.get(provider.id, 0) != version:
            return _checked(
                False, error=f"{provider.name}'s key changed while I was checking it; check again."
            )
        if result["ok"] and result["models"]:
            listed = {m["id"] for m in result["models"]}
            result["missing"] = [
                e.model for e in self.models_of(provider.id) if not _offered(e.model, listed)
            ]
        self.status[provider.id] = {
            "ok": result["ok"],
            "checked": _now(),
            "count": len(result["models"]),
            "error": result["error"],
        }
        return result

    # the window

    def public(self) -> dict[str, Any]:
        """Everything the Models & API keys panel shows. Keys appear only masked."""
        return {
            "kinds": [_public_kind(k) for k in KINDS.values()],
            "providers": [self._public_provider(p) for p in self.providers.values()],
            "models": self.models(),
            "limits": {"providers": MAX_PROVIDERS, "models": MAX_MODELS},
            "advice": KEY_ADVICE,
        }

    def _public_provider(self, provider: Provider) -> dict[str, Any]:
        return {
            "id": provider.id,
            "kind": provider.kind,
            "kind_name": KINDS[provider.kind].name,
            "name": provider.name,
            "base_url": provider.base_url,
            "auth": provider.auth,
            "key_hint": provider.key_hint,
            "added": provider.added,
            "status": self.status.get(provider.id),
            "models": [self._public_model(e) for e in self.models_of(provider.id)],
        }

    def _public_model(self, entry: ModelEntry) -> dict[str, Any]:
        provider = self.providers[entry.provider]
        return {
            "ref": CUSTOM + entry.id,
            "model": entry.model,
            "label": entry.label,
            "name": self._title(entry),
            "provider": provider.id,
            "provider_name": provider.name,
            "kind": provider.kind,
            "builtin": False,
        }


def _public_kind(kind: Kind) -> dict[str, Any]:
    return {
        "id": kind.id,
        "name": kind.name,
        "blurb": kind.blurb,
        "base_url": kind.base_url,
        "needs_base_url": not kind.base_url,
        "auth": kind.auth,
        "auth_choices": list(AUTHS) if kind.id == "custom" else [kind.auth],
        "key_prefix": kind.key_prefix,
        "help_url": kind.help_url,
        "suggested": list(kind.suggested),
    }


def _config(
    model: str | None,
    label: str,
    provider: str,
    claude: bool,
    *,
    env: dict[str, str] | None = None,
    settings: str | None = None,
) -> dict[str, Any]:
    return {
        "model": model,
        "env": env or {},
        "settings": settings,
        "label": label,
        "provider": provider,
        "claude": claude,
    }


def session_pins(provider: Provider, model: str, environ: Mapping[str, str]) -> dict[str, str]:
    """The environment a provider session's settings pin: the provider's address (Claude
    Code's own for Anthropic) and the chosen model; every other address, backend,
    credential and model variable blank; and the network settings this Mac already has.
    Anthropic keeps Claude's own tiers (they're all real Claude models there); any other
    provider gets the chosen model for every tier. No key: that comes from the helper."""
    pins = dict.fromkeys((*DESTINATION_ENV, *CREDENTIAL_ENV, *MODEL_ENV), "")
    pins["ANTHROPIC_MODEL"] = model
    if provider.kind != "anthropic":
        pins["ANTHROPIC_BASE_URL"] = provider.base_url
        pins.update(dict.fromkeys(TIER_ENV, model))
    for name in NETWORK_ENV:
        value = str(environ.get(name) or "")
        if name in _PROXY_URLS and "@" in value:
            continue  # a proxy with a password in it: settings sit on a readable command line
        pins[name] = value
    return pins


# ── asking a provider which models it has ──


class _Failed(Exception):
    """A check that didn't work, said the way JARVIS says it."""


def _default_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=CHECK_TIMEOUT, follow_redirects=False)


def _checked(
    ok: bool, *, models: list[dict[str, Any]] | None = None, error: str = "", note: str = ""
) -> dict[str, Any]:
    return {"ok": ok, "models": models or [], "error": error, "note": note, "missing": []}


def _headers(provider: Provider, key: str) -> dict[str, str]:
    headers = {"Accept": "application/json", "User-Agent": "Jarvis"}
    if provider.auth == "bearer":
        headers["Authorization"] = f"Bearer {key}"
    else:
        headers["x-api-key"] = key
    if provider.kind != "openrouter":
        headers["anthropic-version"] = ANTHROPIC_VERSION
    return headers


async def _probe(provider: Provider, key: str, client: httpx.AsyncClient) -> dict[str, Any]:
    """A whole check, cut off at CHECK_DEADLINE however slowly the provider answers."""
    try:
        async with asyncio.timeout(CHECK_DEADLINE):
            return await _ask(provider, key, client)
    except TimeoutError:
        return _checked(
            False, error=f"{provider.name} didn't answer within {CHECK_DEADLINE:g} seconds."
        )
    except Exception as exc:  # anything unforeseen is a failed check, not a crash
        return _checked(False, error=f"I couldn't check {provider.name} ({type(exc).__name__}).")


async def _ask(provider: Provider, key: str, client: httpx.AsyncClient) -> dict[str, Any]:
    """OpenRouter's model list is public, so its key is tried on its own first."""
    headers = _headers(provider, key)
    note = ""
    try:
        if provider.kind == "openrouter":
            note = _credit(await _get_json(client, OPENROUTER_KEY_URL, headers, provider, key))
        url = f"{provider.base_url}/v1/models?limit=1000"
        payload = await _get_json(client, url, headers, provider, key)
    except _Failed as exc:
        return _checked(False, error=str(exc))
    models = _parse_models(payload)
    if models is None:
        return _checked(
            False,
            error=f"{provider.name} answered, but not with a list of models. Check the address.",
        )
    count = f"{len(models)} model{'' if len(models) == 1 else 's'}"
    return _checked(
        True, models=models, note=f"{provider.name} works: {count} to choose from.{note}"
    )


async def _get_json(
    client: httpx.AsyncClient, url: str, headers: dict[str, str], provider: Provider, key: str
) -> Any:
    """GET a JSON reply, never following a redirect (the key would go along) and never
    reading more than MAX_BODY. None when the reply isn't JSON (or nests too deep)."""
    try:
        async with client.stream(
            "GET", url, headers=headers, timeout=CHECK_TIMEOUT, follow_redirects=False
        ) as response:
            if response.status_code != 200:
                said = await _read(response, 4096, cut=True) or b""
                raise _Failed(_http_problem(provider, response.status_code, said, key))
            body = await _read(response, MAX_BODY)
    except _Failed:
        raise
    except httpx.TimeoutException:
        raise _Failed(f"{provider.name} didn't answer within {CHECK_TIMEOUT:g} seconds.") from None
    except httpx.ConnectError:
        raise _Failed(_unreachable(provider)) from None
    except Exception as exc:  # a closed client, a broken proxy, an odd address
        raise _Failed(f"I couldn't check {provider.name} ({type(exc).__name__}).") from None
    if body is None:
        raise _Failed(f"{provider.name} sent far more than a list of models; check the address.")
    try:
        return json.loads(body)
    except (ValueError, RecursionError):
        return None


async def _read(response: httpx.Response, limit: int, cut: bool = False) -> bytes | None:
    """The body up to limit bytes: cut off there, or None when it runs longer."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        chunks.append(chunk)
        size += len(chunk)
        if size > limit:
            return b"".join(chunks)[:limit] if cut else None
    return b"".join(chunks)


def _http_problem(provider: Provider, status: int, said: bytes, key: str) -> str:
    name = provider.name
    if status in (401, 403):
        text = f"{name} turned the key down ({status}). Check it, or paste a fresh key."
    elif status == 402:
        text = f"{name} says the account is out of credit (402)."
    elif status == 404:
        text = (
            f"Nothing answered at {provider.base_url}/v1/models (404). Check the address."
            if provider.kind == "custom"
            else f"{name} couldn't find its model list (404)."
        )
    elif status == 429:
        text = f"{name} is limiting requests right now (429). Try again in a minute."
    elif 300 <= status < 400:
        text = (
            f"{name} tried to send me to another address ({status}). Check the address: I "
            "don't follow redirects with a key."
        )
    elif status >= 500:
        text = f"{name} had a problem on its side ({status}). Try again shortly."
    else:
        text = f"{name} answered {status}."
    words = _server_words(said, key)
    return f"{text} It said: {words}" if words else text


def _server_words(body: bytes, key: str) -> str:
    """A short, safe line from an error reply: its message, with the key scrubbed out."""
    text = body.decode("utf-8", "replace")
    try:
        data = json.loads(text)
    except RecursionError:
        return ""  # nested past reading: no message in it
    except ValueError:
        data = None
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict):
            text = str(error.get("message") or "")
        elif isinstance(error, str):
            text = error
        else:
            text = str(data.get("message") or data.get("detail") or "")
    elif text.lstrip().startswith("<"):
        return ""  # an HTML error page says nothing worth repeating
    words = _plain(text.replace(key, mask(key)) if key else text, 200)
    if key and _shows_part_of(key, words):
        return ""  # part of the key came back: repeat none of it
    return words if any(c.isalpha() for c in words) else ""


def _shows_part_of(key: str, text: str, width: int = 12) -> bool:
    return any(key[i : i + width] in text for i in range(max(1, len(key) - width + 1)))


def _unreachable(provider: Provider) -> str:
    parts = urlsplit(provider.base_url)
    if is_local(parts.hostname or ""):
        return f"Nothing is answering at {parts.netloc} on this Mac. Is the server running?"
    return f"I couldn't reach {parts.netloc}. Check the address and the internet connection."


def _credit(payload: Any) -> str:
    info = payload.get("data") if isinstance(payload, dict) else None
    left = info.get("limit_remaining") if isinstance(info, dict) else None
    if isinstance(left, int | float) and not isinstance(left, bool) and math.isfinite(left):
        return f" ${left:,.2f} of credit left on this key."
    return ""


def _parse_models(payload: Any) -> list[dict[str, Any]] | None:
    """The models in a /v1/models reply (Anthropic's, OpenAI's and OpenRouter's shapes all
    keep them under "data"), or None if it isn't one."""
    items = payload.get("data") if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        return None
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        model_id = _plain(item["id"], 200)
        if not model_id or model_id in seen:
            continue
        seen.add(model_id)
        params = item.get("supported_parameters")
        name = item.get("display_name") or item.get("name") or model_id
        out.append(
            {
                "id": model_id,
                "name": _plain(name, 120) or model_id,
                "tools": "tools" in params if isinstance(params, list) else None,
            }
        )
        if len(out) >= MAX_LISTED:
            break
    return out if out or not items else None


def _offered(model: str, listed: set[str]) -> bool:
    """Whether a provider's list covers a model, allowing for OpenRouter's ~aliases,
    [1m] markers and :variants, and an undated id whose dated (or -latest) name is
    listed. A longer relative (gpt-5-mini for gpt-5) doesn't count."""
    if model.startswith("~"):
        return True
    base = re.sub(r"\[[^\]]*\]$", "", model)
    if base in listed or base.split(":", 1)[0] in listed:
        return True
    dated = re.compile(re.escape(base) + _DATED)
    return any(dated.fullmatch(item) for item in listed)


# ── Claude's tools ──

Gate = Callable[[str, str], Awaitable[bool]]


async def _always(_action: str, _question: str) -> bool:
    return True


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out


def _named(model: str, label: str) -> str:
    """A model as an approval card names it: always its exact id, and its label too."""
    return f"{model} (shown as “{label}”)" if label and label != model else model


def _listed(entry: ModelEntry) -> str:
    """A model as the list tool shows it: its label, its exact id when that differs, and
    the ref that picks it."""
    shown = entry.label if entry.label == entry.model else f"{entry.label} ({entry.model})"
    return f"{shown} [{CUSTOM}{entry.id}]"


def listing(store: ProviderStore) -> str:
    """Every model a session can use, one provider a line, with the refs that pick them."""
    builtin = ", ".join(f"{MODEL_NAMES[ref]} [{ref}]" for ref in MODELS)
    lines = [f"{BUILTIN_NAME}, on the owner's own sign-in: {builtin}"]
    for provider in store.providers.values():
        models = ", ".join(_listed(e) for e in store.models_of(provider.id))
        kind = KINDS[provider.kind].name
        heading = provider.name if provider.name == kind else f"{provider.name} ({kind})"
        lines.append(f"{heading}: {models or 'no models added yet'}")
    if not store.providers:
        lines.append(
            "Nothing else is added. The owner adds a provider with its API key in Settings › Models."
        )
    return "\n".join(lines)


def build_tools(
    store: ProviderStore,
    gate: Gate = _always,
    on_change: Callable[[], None] | None = None,
    client: httpx.AsyncClient | None = None,
) -> list:
    """gate(action, question) decides whether a change may go ahead: the hub's
    feature_gate lets it through when the owner plainly asked this turn, and asks them
    otherwise. Questions always name the exact model id. No tool takes or shows a key:
    keys are only pasted in Settings › Models."""

    def changed() -> None:
        if on_change is not None:
            on_change()

    def unknown_provider() -> dict[str, Any]:
        names = ", ".join(p.name for p in store.providers.values())
        more = (
            f"The added providers are: {names}."
            if names
            else "None are added yet: the owner adds one with its API key in Settings › Models."
        )
        return _text(f"No provider called that. {more}", error=True)

    @tool(
        "list_ai_models",
        "The AI models Jarvis Code sessions can run on: Claude on the owner's own sign-in, "
        "and any the owner added with their own API keys (their Anthropic key, OpenRouter, "
        "or a custom endpoint), each with the ref that picks it.",
        {},
    )
    async def list_ai_models(_args):
        return _text(listing(store))

    @tool(
        "add_ai_model",
        "Add a model to an added provider's list so Jarvis Code can use it. provider: its "
        "name (e.g. OpenRouter); model: the id the provider uses, e.g. openai/gpt-5, "
        "google/gemini-2.5-pro, x-ai/grok-4, deepseek/deepseek-r1; label: optional display "
        "name. New providers and keys are only added by the owner in Settings › Models.",
        {
            "type": "object",
            "properties": {
                "provider": {"type": "string"},
                "model": {"type": "string"},
                "label": {"type": "string"},
            },
            "required": ["provider", "model"],
        },
    )
    async def add_ai_model(args):
        provider = store.find_provider(str(args.get("provider", "")))
        if provider is None:
            return unknown_provider()
        try:
            provider, model, label = store.can_add(
                provider.id, args.get("model"), args.get("label")
            )
        except ValueError as exc:
            return _text(str(exc), error=True)
        question = f"Add {_named(model, label)} from {provider.name} to Jarvis Code's models?"
        if not await gate("models", question):
            return _text("The user didn't want that model added.", error=True)
        try:
            entry = store.add_model(provider.id, model, label or None)
        except ValueError as exc:
            return _text(str(exc), error=True)
        changed()
        return _text(f"Added {entry['name']} (ref {entry['ref']}).")

    @tool(
        "remove_ai_model",
        "Take an added model off Jarvis Code's list, by its ref, its id or its label. The "
        "built-in Claude models always stay.",
        {"model": str},
    )
    async def remove_ai_model(args):
        want = str(args.get("model", "")).strip()
        found = store.find_models(want)
        builtin = want in MODELS or want.casefold() in {n.casefold() for n in MODEL_NAMES.values()}
        if not found and builtin:
            return _text(
                "The built-in Claude models always stay; only added ones come off.", error=True
            )
        if not found:
            return _text("That model isn't on the list.", error=True)
        if len(found) > 1:
            where = ", ".join(store.describe(CUSTOM + e.id) for e in found)
            return _text(f"More than one matches: {where}. Say which provider.", error=True)
        entry = found[0]
        name = store.describe(CUSTOM + entry.id)
        where = store.providers[entry.provider].name
        question = f"Take {_named(entry.model, entry.label)} from {where} off Jarvis Code's models?"
        if not await gate("models", question):
            return _text("The user said no.", error=True)
        try:
            store.remove_model(CUSTOM + entry.id)
        except ValueError as exc:
            return _text(str(exc), error=True)
        changed()
        return _text(f"Removed {name}.")

    @tool(
        "check_ai_provider",
        "Check that an added provider's API key works: asks the provider for its model list "
        "and says how many models it offers, or what went wrong. provider: its name.",
        {"provider": str},
    )
    async def check_ai_provider(args):
        provider = store.find_provider(str(args.get("provider", "")))
        if provider is None:
            return unknown_provider()
        result = await store.check(provider.id, client)
        changed()  # the window shows the latest check
        if not result["ok"]:
            return _text(result["error"], error=True)
        missing = result["missing"]
        extra = f" It doesn't list: {', '.join(missing)}." if missing else ""
        return _text(result["note"] + extra)

    return [list_ai_models, add_ai_model, remove_ai_model, check_ai_provider]


def build_server(
    store: ProviderStore,
    gate: Gate = _always,
    on_change: Callable[[], None] | None = None,
    client: httpx.AsyncClient | None = None,
):
    return create_sdk_mcp_server(
        name=SERVER_NAME, version="0.1.0", tools=build_tools(store, gate, on_change, client)
    )


PROMPT = (
    "\n- Models: Jarvis Code sessions run on Claude through the owner's own sign-in (Opus, "
    "Sonnet, Haiku, Fable), or on models the owner added in Settings › Models with their own "
    "API keys: their Anthropic key, OpenRouter (GPT, Gemini, Grok, DeepSeek and more) or a "
    "custom endpoint. list_ai_models lists them with the refs that pick them; add_ai_model and "
    "remove_ai_model change the list; check_ai_provider tests that a provider's key works. "
    "Keys are only ever pasted into Settings › Models: never ask for one, repeat one or take "
    "one in chat."
)
