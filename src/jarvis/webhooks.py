"""Inbound webhooks: POST /hooks/<name> on the window's own local server (127.0.0.1 only), so
the owner's scripts, cron jobs and other apps on this Mac can tell JARVIS something.

Each hook has its own random token (sent as an X-Jarvis-Token header, "Authorization:
Bearer …", or ?token=…), kept in the Keychain and never in its file; a size cap; and a rate
limit. A request from a web page (it carries an Origin), or naming another host (a
rebinding trick), is refused; so is everything for a while once too many wrong tokens have
been tried. An unknown hook and a wrong token get the same answer, so names can't be
probed.

What a hook is sent is someone else's words, never instructions: the tool-less reader
(jobs.Reader) turns it into a short summary, which becomes a heads-up, or the input of the
routine the hook names (the routine gets the summary, never the payload). A webhook can
never act by itself.

Claude cost: the reader's (Haiku, one turn, at most $0.02) for each call accepted, within
the hook's rate limit (PER_HOUR unless set) and the reader's own caps (30 an hour, 100 a
day across everything it reads); a routine it runs costs what that routine costs.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import time
from collections import deque
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from . import jsonstore
from .textclean import clean_text

log = logging.getLogger("jarvis")

NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
MAX_HOOKS = 20
PER_HOUR = 30
MAX_PER_HOUR = 600
MAX_BYTES = 64 * 1024  # what one call may send
CALLS_KEPT = 20
WRONG_WINDOW = 600.0  # seconds: wrong tokens counted over this long
WRONG_MAX = 20  # … past this many, every hook refuses …
LOCKED_FOR = 600.0  # … for this long
LOOPBACK = {"127.0.0.1", "localhost", "[::1]", "::1"}
VAULT_PREFIX = "webhook-"
NOTE = "Tell me what this says and whether it needs me."


@dataclass
class Hook:
    name: str
    created: str
    routine: str = ""  # a routine's id: it runs with the summary as its input
    note: str = ""  # what the reader is asked to do with what arrives
    per_hour: int = PER_HOUR
    calls: list[dict[str, Any]] = field(default_factory=list)  # the last CALLS_KEPT

    def public(self) -> dict[str, Any]:
        out = asdict(self)
        out["calls"] = list(reversed(self.calls))[:5]
        return out


def clean_name(value: Any) -> str:
    name = str(value or "").strip().lower().replace(" ", "-")
    if not NAME.match(name):
        raise ValueError("a webhook's name is 1-40 lowercase letters, digits and dashes")
    return name


def _hook_from(raw: Any) -> Hook | None:
    if not isinstance(raw, dict):
        return None
    try:
        name = clean_name(raw.get("name"))
    except ValueError:
        return None
    per_hour = raw.get("per_hour")
    calls = [c for c in raw.get("calls") or [] if isinstance(c, dict)][-CALLS_KEPT:]
    return Hook(
        name=name,
        created=str(raw.get("created") or ""),
        routine=str(raw.get("routine") or "")[:40],
        note=" ".join(clean_text(str(raw.get("note") or "")).split())[:500],
        per_hour=per_hour if type(per_hour) is int and 1 <= per_hour <= MAX_PER_HOUR else PER_HOUR,
        calls=calls,
    )


def _hostname(host: str) -> str:
    host = host.strip().lower()
    if host.startswith("["):
        return host.split("]")[0] + "]"
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


class Webhooks:
    """The hooks (webhooks.json, read on first use), their tokens (the vault), and the door:
    handle(name, request) answers one POST.

    vault: connectors' Vault (the Keychain; a MemoryVault in tests). on_call(hook, text): what
    arrived, accepted (the feature reads it and tells the owner or runs the routine).
    spawn(coro): run that in the background. mono(): a monotonic clock (tests pass a fake)."""

    def __init__(
        self,
        path: Path,
        vault: Any,
        on_call: Callable[[Hook, str], Any],
        *,
        spawn: Callable[[Any], Any] | None = None,
        now: Callable[[], datetime] = datetime.now,
        mono: Callable[[], float] = time.monotonic,
        on_change: Callable[[], Any] = lambda: None,
    ) -> None:
        self.path = path
        self.vault = vault
        self.on_call = on_call
        self.spawn = spawn or (lambda coro: asyncio.get_running_loop().create_task(coro))
        self.now = now
        self.mono = mono
        self.on_change = on_change
        self._hooks: list[Hook] | None = None
        self.broken: list[Any] = []
        self.unreadable = ""
        self._tokens: dict[str, str] = {}
        self._recent: dict[str, deque[float]] = {}
        self._wrong: deque[float] = deque()
        self._locked_until = 0.0

    # ── the file and the Keychain ──

    @property
    def hooks(self) -> list[Hook]:
        if self._hooks is None:
            self._hooks = []
            try:
                data = jsonstore.load_json(self.path, list)
            except jsonstore.Unreadable as exc:
                self.unreadable = exc.strerror or "it can't be read"
                data = None
            names: set[str] = set()
            for raw in data or []:
                hook = _hook_from(raw)
                if hook is not None and hook.name not in names:
                    names.add(hook.name)
                    self._hooks.append(hook)
                elif jsonstore.shallow(raw):
                    self.broken.append(raw)
        return self._hooks

    def save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, [asdict(h) for h in self.hooks] + self.broken)

    def find(self, name: str) -> Hook | None:
        return next((h for h in self.hooks if h.name == name), None)

    def _changed(self) -> None:
        try:
            self.on_change()
        except Exception:
            log.exception("webhooks: on_change failed")

    async def token(self, name: str) -> str | None:
        """A hook's token (from the Keychain, then remembered while JARVIS runs)."""
        if name not in self._tokens:
            found = await asyncio.to_thread(self.vault.get, VAULT_PREFIX + name, "token")
            if not found:
                return None
            self._tokens[name] = found
        return self._tokens[name]

    async def _new_token(self, name: str) -> str:
        token = secrets.token_urlsafe(24)
        await asyncio.to_thread(self.vault.set, VAULT_PREFIX + name, "token", token)
        self._tokens[name] = token
        return token

    # ── changes, from Settings ──

    async def add(self, name: Any, routine: str = "", note: str = "") -> Hook:
        name = clean_name(name)
        if self.find(name) is not None:
            raise ValueError(f"there's already a webhook called {name}")
        if len(self.hooks) >= MAX_HOOKS:
            raise ValueError(f"at most {MAX_HOOKS} webhooks")
        hook = Hook(name, self.now().isoformat(timespec="seconds"), routine=routine, note=note)
        await self._new_token(name)
        self.hooks.append(hook)
        try:
            self.save()
        except OSError:
            self.hooks.remove(hook)
            await asyncio.to_thread(self.vault.delete, VAULT_PREFIX + name, "token")
            self._tokens.pop(name, None)
            raise
        self._changed()
        return hook

    async def remove(self, name: str) -> bool:
        hook = self.find(name)
        if hook is None:
            return False
        self.hooks.remove(hook)
        self.save()
        await asyncio.to_thread(self.vault.delete, VAULT_PREFIX + name, "token")
        self._tokens.pop(name, None)
        self._recent.pop(name, None)
        self._changed()
        return True

    async def regenerate(self, name: str) -> str | None:
        """A new token: the old one stops working at once."""
        if self.find(name) is None:
            return None
        token = await self._new_token(name)
        self._changed()
        return token

    def update(self, name: str, **changes: Any) -> Hook | None:
        hook = self.find(name)
        if hook is None:
            return None
        before = asdict(hook)
        if "routine" in changes:
            hook.routine = str(changes["routine"] or "")[:40]
        if "note" in changes:
            hook.note = " ".join(clean_text(str(changes["note"] or "")).split())[:500]
        if "per_hour" in changes:
            try:
                per_hour = int(changes["per_hour"])
            except (TypeError, ValueError):
                per_hour = hook.per_hour
            hook.per_hour = max(1, min(MAX_PER_HOUR, per_hour))
        try:
            self.save()
        except OSError:
            for key, value in before.items():
                setattr(hook, key, value)
            raise
        self._changed()
        return hook

    def public(self) -> list[dict[str, Any]]:
        return [h.public() for h in self.hooks]

    # ── the door ──

    async def handle(self, name: str, request: Any) -> tuple[int, dict[str, Any]]:
        """One POST /hooks/<name>: (status, body). Only the owner's own local tools, with
        the hook's token, within its size and rate limits, get in."""
        headers = request.headers
        if headers.get("origin"):
            return 403, {"error": "webhooks don't take requests from web pages"}
        if _hostname(headers.get("host", "")) not in LOOPBACK:
            return 403, {"error": "only this Mac's own address"}
        stamp = self.mono()
        if stamp < self._locked_until:
            return 429, {"error": "too many wrong tokens; try again later"}
        offered = headers.get("x-jarvis-token") or ""
        auth = headers.get("authorization") or ""
        if not offered and auth.lower().startswith("bearer "):
            offered = auth[7:].strip()
        if not offered:
            offered = request.query_params.get("token", "")
        hook = self.find(name)
        expected = await self.token(name) if hook is not None else None
        good = expected is not None and secrets.compare_digest(
            offered.encode(errors="replace"), expected.encode()
        )
        if not good:
            self._wrong_token(stamp)
            return 401, {"error": "unauthorized"}
        recent = self._recent.setdefault(hook.name, deque())
        while recent and stamp - recent[0] >= 3600:
            recent.popleft()
        if len(recent) >= hook.per_hour:
            wait = int(3600 - (stamp - recent[0])) + 1
            self._note(hook, "rate limited", 0)
            return 429, {"error": "too many calls this hour", "retry_after": wait}
        declared = headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BYTES:
            self._note(hook, "too big", int(declared))
            return 413, {"error": f"at most {MAX_BYTES // 1024} KB"}
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BYTES:
                self._note(hook, "too big", len(body))
                return 413, {"error": f"at most {MAX_BYTES // 1024} KB"}
        recent.append(stamp)
        text = self._text(bytes(body))
        self._note(hook, "accepted", len(body))
        try:
            result = self.on_call(hook, text)
            if asyncio.iscoroutine(result):
                self.spawn(result)
        except Exception:
            log.exception("webhooks: a call couldn't be handed over")
        return 202, {"ok": True}

    @staticmethod
    def _text(body: bytes) -> str:
        """What arrived, as text: JSON shown as JSON (whatever its shape), anything else as
        its characters."""
        raw = body.decode("utf-8", errors="replace")
        try:
            data = json.loads(raw)
        except ValueError:
            return raw.strip()
        return json.dumps(data, ensure_ascii=False, indent=1)[:MAX_BYTES]

    def _wrong_token(self, stamp: float) -> None:
        self._wrong.append(stamp)
        while self._wrong and stamp - self._wrong[0] >= WRONG_WINDOW:
            self._wrong.popleft()
        if len(self._wrong) >= WRONG_MAX:
            self._locked_until = stamp + LOCKED_FOR
            self._wrong.clear()
            log.warning("webhooks: too many wrong tokens; refusing all for a while")

    def _note(self, hook: Hook, status: str, size: int) -> None:
        hook.calls = [
            *hook.calls,
            {"at": self.now().isoformat(timespec="seconds"), "status": status, "bytes": size},
        ][-CALLS_KEPT:]
        try:
            self.save()
        except OSError as exc:
            log.info("webhooks: couldn't save (%s)", exc)
        self._changed()
