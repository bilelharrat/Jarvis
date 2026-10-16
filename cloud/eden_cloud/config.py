"""Eden Cloud's settings, all from the environment (EDEN_CLOUD_*), with defaults safe for a
first deployment: one run at a time per user, short runs, small budgets, Plus accounts only.

Nothing here is a secret except the dev tokens (development only; refused when the service
says it's in production) and the backend's own credentials (the Fly API token): the askeden
public key is public, and no user key ever lives in the settings.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _int(env: dict[str, str], key: str, default: int, low: int = 0, high: int = 10**9) -> int:
    try:
        value = int(env.get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(low, min(high, value))


def _float(env: dict[str, str], key: str, default: float, low: float = 0.0) -> float:
    try:
        value = float(env.get(key, default))
    except (TypeError, ValueError):
        value = default
    return max(low, value)


@dataclass
class Settings:
    data_dir: Path = Path("./eden-cloud-data")
    # The address the runners call back on (the service as a container reaches it).
    public_url: str = "http://host.docker.internal:8790"
    production: bool = False
    backend: str = "docker"  # docker | fly | gcp | aws | fake
    runner_image: str = "eden-cloud-runner:dev"
    # askeden.com's Ed25519 public key for Eden Cloud tokens (base64, 32 bytes).
    askeden_public_key: str = ""
    token_issuer: str = "askeden.com"
    # Development only: "token=account-id,…" (refused in production).
    dev_tokens: dict[str, str] = field(default_factory=dict)
    # Who may run: "plus" (Eden Plus accounts) or "" (any signed-in account).
    require_plan: str = "plus"
    allowed_accounts: tuple[str, ...] = ()  # empty: every account the plan lets in
    # Limits.
    max_running_per_user: int = 1
    max_queued_per_user: int = 3
    max_running_total: int = 4
    max_minutes_per_run: int = 60
    default_minutes: int = 30
    daily_minutes_per_user: int = 180
    max_budget_usd_per_run: float = 20.0
    default_budget_usd: float = 5.0
    daily_budget_usd_per_user: float = 50.0
    max_source_mb: int = 200
    max_result_mb: int = 200
    max_events_mb: int = 50
    max_brief_chars: int = 20000
    keep_hours: int = 24  # events and results kept for the Mac to fetch, then deleted
    start_seconds: int = 300  # a run that hasn't called back by then failed to start
    cpus: float = 2.0
    memory_mb: int = 4096
    # Fly Machines (backend fly).
    fly_app: str = ""
    fly_token: str = ""
    fly_region: str = ""

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Settings:
        env = dict(os.environ if env is None else env)
        dev = {}
        for pair in str(env.get("EDEN_CLOUD_DEV_TOKENS", "")).split(","):
            token, _, account = pair.strip().partition("=")
            if len(token) >= 24 and account:
                dev[token] = account.strip()
        s = cls(
            data_dir=Path(env.get("EDEN_CLOUD_DATA", "./eden-cloud-data")),
            public_url=env.get("EDEN_CLOUD_PUBLIC_URL", cls.public_url).rstrip("/"),
            production=env.get("EDEN_CLOUD_ENV", "") == "production",
            backend=env.get("EDEN_CLOUD_BACKEND", "docker"),
            runner_image=env.get("EDEN_CLOUD_RUNNER_IMAGE", cls.runner_image),
            askeden_public_key=env.get("EDEN_CLOUD_ASKEDEN_PUBLIC_KEY", ""),
            token_issuer=env.get("EDEN_CLOUD_TOKEN_ISSUER", "askeden.com"),
            dev_tokens=dev,
            require_plan=env.get("EDEN_CLOUD_REQUIRE_PLAN", "plus").strip().lower(),
            allowed_accounts=tuple(
                a.strip().lower()
                for a in str(env.get("EDEN_CLOUD_ACCOUNTS", "")).split(",")
                if a.strip()
            ),
            max_running_per_user=_int(env, "EDEN_CLOUD_MAX_RUNNING_PER_USER", 1, 1, 20),
            max_queued_per_user=_int(env, "EDEN_CLOUD_MAX_QUEUED_PER_USER", 3, 1, 100),
            max_running_total=_int(env, "EDEN_CLOUD_MAX_RUNNING", 4, 1, 1000),
            max_minutes_per_run=_int(env, "EDEN_CLOUD_MAX_MINUTES", 60, 1, 24 * 60),
            default_minutes=_int(env, "EDEN_CLOUD_DEFAULT_MINUTES", 30, 1, 24 * 60),
            daily_minutes_per_user=_int(env, "EDEN_CLOUD_DAILY_MINUTES", 180, 1, 24 * 60),
            max_budget_usd_per_run=_float(env, "EDEN_CLOUD_MAX_BUDGET_USD", 20.0, 0.01),
            default_budget_usd=_float(env, "EDEN_CLOUD_DEFAULT_BUDGET_USD", 5.0, 0.01),
            daily_budget_usd_per_user=_float(env, "EDEN_CLOUD_DAILY_BUDGET_USD", 50.0, 0.01),
            max_source_mb=_int(env, "EDEN_CLOUD_MAX_SOURCE_MB", 200, 1, 10_000),
            max_result_mb=_int(env, "EDEN_CLOUD_MAX_RESULT_MB", 200, 1, 10_000),
            max_events_mb=_int(env, "EDEN_CLOUD_MAX_EVENTS_MB", 50, 1, 10_000),
            keep_hours=_int(env, "EDEN_CLOUD_KEEP_HOURS", 24, 1, 24 * 30),
            start_seconds=_int(env, "EDEN_CLOUD_START_SECONDS", 300, 10, 3600),
            cpus=_float(env, "EDEN_CLOUD_CPUS", 2.0, 0.25),
            memory_mb=_int(env, "EDEN_CLOUD_MEMORY_MB", 4096, 256, 65536),
            fly_app=env.get("EDEN_CLOUD_FLY_APP", ""),
            fly_token=env.get("EDEN_CLOUD_FLY_TOKEN", ""),
            fly_region=env.get("EDEN_CLOUD_FLY_REGION", ""),
        )
        s.default_minutes = min(s.default_minutes, s.max_minutes_per_run)
        s.default_budget_usd = min(s.default_budget_usd, s.max_budget_usd_per_run)
        return s

    def problems(self) -> list[str]:
        """What stops the service from starting as configured (empty: it can start)."""
        out = []
        if self.production and self.dev_tokens:
            out.append("EDEN_CLOUD_DEV_TOKENS is set in production: remove it.")
        if self.production and not self.askeden_public_key:
            out.append("EDEN_CLOUD_ASKEDEN_PUBLIC_KEY is needed in production.")
        if self.production and not self.public_url.startswith("https://"):
            out.append("EDEN_CLOUD_PUBLIC_URL must be https:// in production.")
        if self.production and self.backend in ("fake", "docker"):
            out.append(f"The {self.backend} backend is for development only.")
        if self.require_plan not in ("", "plus"):
            out.append('EDEN_CLOUD_REQUIRE_PLAN is "plus" or empty.')
        return out
