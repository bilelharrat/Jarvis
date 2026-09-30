"""What Claude has been used for: every answer's tokens and cost, and the plan's usage limits.

JARVIS runs on the owner's Claude subscription, so nothing is billed per token; the cost is
Claude Code's own API-price figure for the same work (what it would have cost), which is
still the best measure of how much was used. The plan's limits (the five-hour window, the
weekly ones) come from Claude Code as it answers: how much of each is used and when it
resets.

Kept in usage.json beside the settings: a day's totals by where it came from (JARVIS's
voice, Jarvis Code, research) and by model, for 90 days, and the latest of each limit.
Numbers only; never a word of what was asked.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import time
from collections.abc import Callable
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from . import jsonstore

DAYS_KEPT = 90
SAVE_EVERY = 5.0  # seconds: a burst of answers is one write
SOURCES = {"jarvis": "JARVIS", "code": "Jarvis Code", "research": "Research"}
LIMITS = {
    "five_hour": "5-hour limit",
    "seven_day": "Weekly limit",
    "seven_day_opus": "Weekly · Opus",
    "seven_day_sonnet": "Weekly · Sonnet",
    "overage": "Extra usage",
}
TOKEN_KINDS = ("input", "output", "cache_read", "cache_write")

# The plan's windows, asked of Anthropic the way Claude Code's /usage asks: with the Claude
# login Claude Code keeps in the Keychain. Read only: the login is never refreshed or
# written (that's Claude Code's to do), and a login that has run out is simply skipped
# until Claude Code renews it on its next answer.
USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
LOGIN_ITEM = "Claude Code-credentials"
PLAN_WINDOWS = ("five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet")


def login_token(run: Callable[..., Any] = subprocess.run, now: float | None = None) -> str | None:
    """Claude Code's current access token, or None (not signed in, or it has expired)."""
    try:
        out = run(
            ["security", "find-generic-password", "-s", LOGIN_ITEM, "-w"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        login = json.loads(out.stdout or "{}").get("claudeAiOauth") or {}
    except (OSError, ValueError, subprocess.SubprocessError, AttributeError):
        return None
    token = login.get("accessToken")
    expires = login.get("expiresAt")  # milliseconds
    if isinstance(expires, (int, float)) and expires / 1000 < (now or time.time()) + 60:
        return None
    return token if isinstance(token, str) and token else None


def _epoch(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return value / 1000 if value > 1e12 else float(value)
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def parse_plan(data: Any) -> dict[str, dict[str, Any]]:
    """The usage endpoint's answer as limits: {window: {utilization 0-1, resets_at}}. It
    gives utilization in percent."""
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(data, dict):
        return out
    for kind in PLAN_WINDOWS:
        window = data.get(kind)
        if not isinstance(window, dict) or window.get("utilization") is None:
            continue
        try:
            used = float(window["utilization"]) / 100
        except (TypeError, ValueError):
            continue
        out[kind] = {"utilization": max(0.0, used), "resets_at": _epoch(window.get("resets_at"))}
    extra = data.get("extra_usage")
    if isinstance(extra, dict) and extra.get("is_enabled") and extra.get("utilization") is not None:
        try:
            out["overage"] = {"utilization": float(extra["utilization"]) / 100, "resets_at": None}
        except (TypeError, ValueError):
            pass
    return out


async def fetch_plan(client: Any = None, token: str | None = None) -> dict[str, Any] | None:
    """The plan's windows now, or None when they can't be had (signed out, offline)."""
    token = token or await asyncio.to_thread(login_token)
    if not token:
        return None
    import httpx

    headers = {
        "Authorization": f"Bearer {token}",
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
    }
    try:
        if client is None:
            async with httpx.AsyncClient(timeout=8) as own:
                response = await own.get(USAGE_URL, headers=headers)
        else:
            response = await client.get(USAGE_URL, headers=headers)
    except httpx.HTTPError:
        return None
    if response.status_code != 200:
        return None
    try:
        return parse_plan(response.json())
    except ValueError:
        return None


def _tokens(usage: dict[str, Any] | None) -> dict[str, int]:
    usage = usage or {}
    return {
        "input": int(usage.get("input_tokens") or 0),
        "output": int(usage.get("output_tokens") or 0),
        "cache_read": int(usage.get("cache_read_input_tokens") or 0),
        "cache_write": int(usage.get("cache_creation_input_tokens") or 0),
    }


def _blank() -> dict[str, Any]:
    return {"cost": 0.0, "requests": 0, **dict.fromkeys(TOKEN_KINDS, 0)}


def _add(into: dict[str, Any], cost: float, tokens: dict[str, int]) -> None:
    into["cost"] = round(float(into.get("cost") or 0.0) + cost, 6)
    into["requests"] = int(into.get("requests") or 0) + 1
    for kind in TOKEN_KINDS:
        into[kind] = int(into.get(kind) or 0) + tokens[kind]


def _total(bucket: dict[str, Any]) -> int:
    return sum(int(bucket.get(k) or 0) for k in TOKEN_KINDS)


def model_name(model: str) -> str:
    """claude-opus-5-5 -> Opus 5.5; others as they are."""
    parts = str(model or "").removeprefix("claude-").split("-")
    if parts and parts[0] in ("opus", "sonnet", "haiku", "fable"):
        version = ".".join(p for p in parts[1:] if p.isdigit() and len(p) < 3)
        return f"{parts[0].title()} {version}".strip()
    return str(model or "unknown")


class UsageBook:
    def __init__(self, path: Path | None = None, clock: Callable[[], float] = time.time) -> None:
        self.path = path
        self.clock = clock
        self.days: dict[str, dict[str, Any]] = {}
        self.limits: dict[str, dict[str, Any]] = {}
        self.session = _blank()  # since JARVIS started
        self.started = clock()
        self._dirty = False
        self._saved_at = 0.0
        if path is not None:
            try:
                data = jsonstore.load_json(path, dict)
            except jsonstore.Unreadable:
                data = None  # counted afresh; the unreadable file is left as it is
            if isinstance(data, dict):
                days = data.get("days")
                limits = data.get("limits")
                self.days = days if isinstance(days, dict) else {}
                self.limits = limits if isinstance(limits, dict) else {}

    # ── recording ──

    def record(
        self, source: str, cost: float | None, usage: dict[str, Any] | None, model: str = ""
    ) -> None:
        """One answer from Claude: where it came from, its cost and tokens, its model."""
        cost = max(0.0, float(cost or 0.0))
        tokens = _tokens(usage)
        if not cost and not any(tokens.values()):
            return
        day = self.days.setdefault(self._today(), {**_blank(), "sources": {}, "models": {}})
        _add(day, cost, tokens)
        _add(day["sources"].setdefault(source, _blank()), cost, tokens)
        _add(day["models"].setdefault(model_name(model), _blank()), cost, tokens)
        _add(self.session, cost, tokens)
        self._trim()
        self._changed()

    def limit(self, info: Any) -> None:
        """Claude Code's report on one of the plan's limits (a RateLimitInfo)."""
        kind = getattr(info, "rate_limit_type", None) or "five_hour"
        entry = {
            "status": getattr(info, "status", "") or "",
            "utilization": getattr(info, "utilization", None),
            "resets_at": getattr(info, "resets_at", None),
            "seen": self.clock(),
        }
        overage = getattr(info, "overage_status", None)
        if overage:
            entry["overage"] = overage
        self.limits[str(kind)] = entry
        self._changed()

    def plan(self, windows: dict[str, dict[str, Any]]) -> None:
        """The plan's windows as the usage endpoint gave them (fetch_plan)."""
        for kind, window in windows.items():
            used = window.get("utilization") or 0.0
            self.limits[kind] = {
                "status": "rejected"
                if used >= 1
                else "allowed_warning"
                if used >= 0.8
                else "allowed",
                "utilization": used,
                "resets_at": window.get("resets_at"),
                "seen": self.clock(),
            }
        if windows:
            self._changed()

    # ── reading ──

    def summary(self) -> dict[str, Any]:
        today = date.fromtimestamp(self.clock())
        span = lambda n: self._span(today, n)  # noqa: E731
        now = self.clock()
        limits = []
        for kind, label in LIMITS.items():
            entry = self.limits.get(kind)
            if not entry:
                continue
            resets = entry.get("resets_at")
            if isinstance(resets, (int, float)) and resets > 1e12:
                resets = resets / 1000  # milliseconds
            stale = isinstance(resets, (int, float)) and resets < now
            used = entry.get("utilization")
            limits.append(
                {
                    "type": kind,
                    "label": label,
                    # a window that has reset since: nothing of the new one is known yet
                    "utilization": None if stale else used,
                    "status": "allowed" if stale else entry.get("status", ""),
                    "resets_at": None if stale else resets,
                    "seen": entry.get("seen"),
                }
            )
        history = []
        for n in range(13, -1, -1):
            key = (today - timedelta(days=n)).isoformat()
            day = self.days.get(key) or {}
            history.append(
                {
                    "date": key,
                    "cost": round(float(day.get("cost") or 0.0), 4),
                    "tokens": _total(day),
                }
            )
        return {
            "limits": limits,
            "session": self._public(self.session),
            "today": span(1),
            "week": span(7),
            "month": span(30),
            "history": history,
        }

    def _span(self, today: date, days: int) -> dict[str, Any]:
        total, sources, models = _blank(), {}, {}
        for n in range(days):
            day = self.days.get((today - timedelta(days=n)).isoformat())
            if not day:
                continue
            _merge(total, day)
            for name, bucket in (day.get("sources") or {}).items():
                _merge(sources.setdefault(name, _blank()), bucket)
            for name, bucket in (day.get("models") or {}).items():
                _merge(models.setdefault(name, _blank()), bucket)
        out = self._public(total)
        out["sources"] = [
            {"name": SOURCES.get(k, k), **self._public(v)}
            for k, v in sorted(sources.items(), key=lambda kv: -kv[1]["cost"])
        ]
        out["models"] = [
            {"name": k, **self._public(v)}
            for k, v in sorted(models.items(), key=lambda kv: -kv[1]["cost"])
        ]
        return out

    @staticmethod
    def _public(bucket: dict[str, Any]) -> dict[str, Any]:
        return {
            "cost": round(float(bucket.get("cost") or 0.0), 4),
            "requests": int(bucket.get("requests") or 0),
            "tokens": _total(bucket),
            **{k: int(bucket.get(k) or 0) for k in TOKEN_KINDS},
        }

    # ── keeping ──

    def _today(self) -> str:
        return date.fromtimestamp(self.clock()).isoformat()

    def _trim(self) -> None:
        cutoff = (date.fromtimestamp(self.clock()) - timedelta(days=DAYS_KEPT)).isoformat()
        for key in [k for k in self.days if k < cutoff]:
            del self.days[key]

    def _changed(self) -> None:
        self._dirty = True
        if self.clock() - self._saved_at >= SAVE_EVERY:
            self.flush()

    def flush(self) -> None:
        if not self._dirty or self.path is None:
            return
        try:
            jsonstore.save_json(self.path, {"days": self.days, "limits": self.limits})
        except OSError:
            return  # a full disk: the numbers stay in memory
        self._dirty = False
        self._saved_at = self.clock()


def _merge(into: dict[str, Any], bucket: dict[str, Any]) -> None:
    into["cost"] = round(float(into.get("cost") or 0.0) + float(bucket.get("cost") or 0.0), 6)
    into["requests"] = int(into.get("requests") or 0) + int(bucket.get("requests") or 0)
    for kind in TOKEN_KINDS:
        into[kind] = int(into.get(kind) or 0) + int(bucket.get(kind) or 0)


def clock_time(epoch: float) -> str:
    return datetime.fromtimestamp(epoch).strftime("%-I:%M %p")
