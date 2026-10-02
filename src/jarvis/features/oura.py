"""The owner's Oura ring: last night's sleep, readiness and yesterday's activity, in the
morning briefing (and so the wake-up call) and whenever they ask ("how did I sleep?").

Oura's API (v2) takes OAuth only: personal access tokens ended in December 2025. The owner
makes a free API application at https://developer.ouraring.com/applications with the
redirect URI connectors.REDIRECT_URI, pastes its client ID and secret in Settings › Oura,
then Connect opens Oura's consent page in the browser; the redirect lands on the sign-in
catcher JARVIS's connectors use (localhost:47823). Client and tokens are kept in the macOS
Keychain (connectors.Vault, "oura:oauth_client" and "oura:oauth_tokens"), never in files;
Oura's refresh tokens are single-use, so each refresh's new one is kept at once.

- Briefing: facts for the "health" section (private), gathered as the briefing is asked for.
- Tool oura_stats {days}: the last days, newest first, for questions.
- Window: commands oura_state, oura_save_client {client_id, client_secret}, oura_connect,
  oura_disconnect, oura_open_apps (Oura's page for making the app); event oura {client, connected, connecting, error, last}.

Claude cost policy: no model is called here; the numbers ride on the briefing's own turn.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
import time
import urllib.parse
import webbrowser
from datetime import date, timedelta
from typing import Any

import httpx
from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import connectors

log = logging.getLogger("jarvis")

CONN = "oura"
AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize"
TOKEN_URL = "https://api.ouraring.com/oauth/token"
API = "https://api.ouraring.com/v2/usercollection"
SCOPES = "personal daily heartrate session spo2"
APPS_URL = "https://developer.ouraring.com/applications"
TIMEOUT = 20.0
CACHE_SECONDS = 15 * 60
MAX_DAYS = 14

PROMPT = (
    "The owner's Oura ring: oura_stats gives their sleep (score, hours, stages, efficiency, "
    "lowest heart rate, HRV), readiness and activity by day. Use it for anything about how "
    "they slept or how recovered they are; in a briefing, a sentence or two: the scores, "
    "the hours, and anything notably better or worse than their week."
)


class OuraError(Exception):
    pass


def minutes(seconds: Any) -> str:
    """Seconds as "7 h 12 min" ("" for nothing)."""
    try:
        total = round(float(seconds) / 60)
    except (TypeError, ValueError):
        return ""
    if total <= 0:
        return ""
    h, m = divmod(total, 60)
    return f"{h} h {m} min" if h else f"{m} min"


def clock(stamp: Any) -> str:
    """ "2026-10-01T07:35:12-07:00" as "07:35"."""
    text = str(stamp or "")
    return text[11:16] if len(text) >= 16 else ""


def main_sleep(periods: list[dict[str, Any]], day: str) -> dict[str, Any] | None:
    """The night's main sleep: the longest period that day (a long_sleep before naps)."""
    found = [p for p in periods if p.get("day") == day and p.get("type") != "deleted"]
    if not found:
        return None
    return max(
        found,
        key=lambda p: (p.get("type") == "long_sleep", p.get("total_sleep_duration") or 0),
    )


def by_day(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(i.get("day")): i for i in items if isinstance(i, dict) and i.get("day")}


def night_line(
    day: str,
    daily_sleep: dict[str, dict[str, Any]],
    periods: list[dict[str, Any]],
    readiness: dict[str, dict[str, Any]],
) -> str:
    """One night in words: "" when the ring has nothing for it."""
    parts = []
    score = (daily_sleep.get(day) or {}).get("score")
    if score is not None:
        parts.append(f"sleep score {score}")
    sleep = main_sleep(periods, day)
    if sleep:
        slept = minutes(sleep.get("total_sleep_duration"))
        if slept:
            span = ""
            start, end = clock(sleep.get("bedtime_start")), clock(sleep.get("bedtime_end"))
            if start and end:
                span = f" ({start} to {end})"
            parts.append(f"slept {slept}{span}")
        stages = [
            f"{name} {minutes(sleep.get(key))}"
            for name, key in (
                ("deep", "deep_sleep_duration"),
                ("REM", "rem_sleep_duration"),
                ("light", "light_sleep_duration"),
            )
            if minutes(sleep.get(key))
        ]
        if stages:
            parts.append(", ".join(stages))
        if sleep.get("efficiency") is not None:
            parts.append(f"efficiency {sleep['efficiency']}%")
        if sleep.get("lowest_heart_rate"):
            parts.append(f"lowest heart rate {sleep['lowest_heart_rate']}")
        if sleep.get("average_hrv"):
            parts.append(f"average HRV {sleep['average_hrv']} ms")
    ready = readiness.get(day) or {}
    if ready.get("score") is not None:
        parts.append(f"readiness {ready['score']}")
    deviation = ready.get("temperature_deviation")
    if isinstance(deviation, int | float) and abs(deviation) >= 0.3:
        parts.append(f"body temperature {deviation:+.1f} °C from usual")
    return "; ".join(parts)


def week_note(day: str, periods: list[dict[str, Any]]) -> str:
    """How the night compares with the nights before it ("" with fewer than three)."""
    tonight = main_sleep(periods, day)
    if not tonight or not tonight.get("total_sleep_duration"):
        return ""
    others = []
    for n in range(1, 8):
        other = (date.fromisoformat(day) - timedelta(days=n)).isoformat()
        found = main_sleep(periods, other)
        if found and found.get("total_sleep_duration"):
            others.append(found["total_sleep_duration"])
    if len(others) < 3:
        return ""
    average = sum(others) / len(others)
    gap = round((tonight["total_sleep_duration"] - average) / 60)
    if abs(gap) < 15:
        return "about their usual amount of sleep this week"
    return f"{abs(gap)} min {'more' if gap > 0 else 'less'} sleep than their week's average"


def activity_line(day: str, activity: dict[str, dict[str, Any]]) -> str:
    a = activity.get(day) or {}
    parts = []
    if a.get("steps") is not None:
        parts.append(f"{a['steps']:,} steps")
    if a.get("score") is not None:
        parts.append(f"activity score {a['score']}")
    return ", ".join(parts)


class Oura:
    def __init__(self, hub: Any, vault: Any = None, transport: Any = None) -> None:
        self.hub = hub
        self.vault = vault or hub.connectors.vault
        self.transport = transport  # tests: an httpx.MockTransport
        self.callback = connectors.CallbackServer()
        self.connecting = False
        self.error = ""
        self.last = ""  # when data last came
        self._cache: tuple[float, dict[str, Any]] | None = None
        self._lock = asyncio.Lock()
        self._attached = False

    # ── the Keychain ──

    def _json(self, key: str) -> dict[str, Any]:
        try:
            raw = self.vault.get(CONN, key)
            data = json.loads(raw) if raw else {}
        except (ValueError, Exception):
            return {}
        return data if isinstance(data, dict) else {}

    def client(self) -> dict[str, Any]:
        return self._json("oauth_client")

    def tokens(self) -> dict[str, Any]:
        return self._json("oauth_tokens")

    def connected(self) -> bool:
        return bool(self.tokens().get("refresh_token") or self.tokens().get("access_token"))

    def _keep_tokens(self, answer: dict[str, Any]) -> None:
        old = self.tokens()
        tokens = {
            "access_token": answer.get("access_token", ""),
            "refresh_token": answer.get("refresh_token") or old.get("refresh_token", ""),
            "expires_at": time.time() + float(answer.get("expires_in") or 86400) - 60,
        }
        self.vault.set(CONN, "oauth_tokens", json.dumps(tokens))

    # ── signing in ──

    async def save_client(self, msg: dict[str, Any]) -> None:
        """Keeps the owner's Oura app, once Oura says the ID and secret go together."""
        client_id = str(msg.get("client_id") or "").strip()
        client_secret = str(msg.get("client_secret") or "").strip()
        if not client_id or not client_secret:
            self.error = "Paste both the client ID and the client secret."
        elif client_secret == client_id:
            self.error = (
                "The secret box has the client ID in it again. On Oura's page, click Copy "
                "beside Client Secret (it's the longer one), paste it, and save."
            )
        else:
            problem = await self.check_client(client_id, client_secret)
            if problem:
                self.error = problem
            else:
                self.vault.set(
                    CONN,
                    "oauth_client",
                    json.dumps({"client_id": client_id, "client_secret": client_secret}),
                )
                self.error = ""
        if self.error:
            log.info("oura: the app wasn't saved (%s)", self.error[:80])
        self.emit()

    async def check_client(self, client_id: str, client_secret: str) -> str:
        """Why Oura won't take this ID and secret ("" when it does, or can't be asked): a
        made-up code is turned down as invalid_grant for a real app, invalid_client else."""
        try:
            async with self._http() as http:
                reply = await http.post(
                    TOKEN_URL,
                    data={
                        "grant_type": "authorization_code",
                        "code": "jarvis-check",
                        "redirect_uri": connectors.REDIRECT_URI,
                        "client_id": client_id,
                        "client_secret": client_secret,
                    },
                )
            error = str(reply.json().get("error") or "")
        except (httpx.HTTPError, ValueError):
            return ""  # offline: Connect will say
        if error == "invalid_client":
            return (
                "Oura doesn't recognise that client ID and secret together. Copy both again "
                "from your app's page on Oura's developer site (the secret is the longer one)."
            )
        return ""

    def authorize_url(self, state: str) -> str:
        query = {
            "response_type": "code",
            "client_id": self.client().get("client_id", ""),
            "redirect_uri": connectors.REDIRECT_URI,
            "scope": SCOPES,
            "state": state,
        }
        return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(query)}"

    def _http(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=TIMEOUT, transport=self.transport)

    async def _token(self, form: dict[str, str]) -> dict[str, Any]:
        client = self.client()
        form = {
            **form,
            "client_id": client.get("client_id", ""),
            "client_secret": client.get("client_secret", ""),
        }
        async with self._http() as http:
            reply = await http.post(TOKEN_URL, data=form)
        if reply.status_code != 200:
            with contextlib.suppress(ValueError):
                if reply.json().get("error") == "invalid_client":
                    raise OuraError(
                        "Oura doesn't recognise the saved client ID and secret: paste them "
                        "again from your app's page (the secret is the longer one)."
                    )
            raise OuraError(f"Oura turned the sign-in down ({reply.status_code}).")
        answer = reply.json()
        if not answer.get("access_token"):
            raise OuraError("Oura's answer had no token in it.")
        return answer

    async def connect(self, _msg: dict[str, Any] | None = None) -> None:
        if not self.client().get("client_id"):
            self.error = "First paste your Oura app's client ID and secret."
            return self.emit()
        if self.connecting:
            return
        client = self.client()
        problem = await self.check_client(
            client.get("client_id", ""), client.get("client_secret", "")
        )
        if problem:
            self.error = problem
            log.info("oura: not connecting (the saved app isn't Oura's)")
            return self.emit()
        self.connecting = True
        self.error = ""
        self.emit()
        state = secrets.token_urlsafe(16)
        try:
            waiting = asyncio.ensure_future(self.callback.wait_for_code())
            await asyncio.sleep(0.2)  # the catcher listens before the browser opens
            await asyncio.to_thread(webbrowser.open, self.authorize_url(state))
            code, returned = await waiting
            if returned != state:
                raise OuraError("The sign-in came back for a different request; try again.")
            answer = await self._token(
                {
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": connectors.REDIRECT_URI,
                }
            )
            self._keep_tokens(answer)
            self._cache = None
            self.hub.emit(
                "toast", title="Oura", text="Connected. Your sleep is in the briefing now."
            )
        except TimeoutError:
            self.error = "The sign-in timed out. Try Connect again."
        except OSError:
            self.error = "Another sign-in is using the sign-in catcher; try again in a minute."
        except (OuraError, RuntimeError, httpx.HTTPError) as exc:
            self.error = str(exc) or "The sign-in didn't finish."
            log.info("oura: connecting failed (%s)", self.error[:120])
        finally:
            self.connecting = False
            self.emit()

    def disconnect(self, _msg: dict[str, Any] | None = None) -> None:
        self.vault.delete(CONN, "oauth_tokens")
        self._cache = None
        self.error = ""
        self.last = ""
        self.emit()

    async def access_token(self) -> str:
        tokens = self.tokens()
        if not tokens:
            raise OuraError("Oura isn't connected (Settings › Oura).")
        if tokens.get("access_token") and time.time() < float(tokens.get("expires_at") or 0):
            return tokens["access_token"]
        refresh = tokens.get("refresh_token")
        if not refresh:
            raise OuraError("Oura's sign-in ran out: reconnect in Settings › Oura.")
        try:
            answer = await self._token({"grant_type": "refresh_token", "refresh_token": refresh})
        except OuraError:
            raise OuraError("Oura's sign-in ran out: reconnect in Settings › Oura.") from None
        self._keep_tokens(answer)
        return answer["access_token"]

    # ── the data ──

    async def _get(self, http: httpx.AsyncClient, kind: str, start: str, end: str) -> list:
        token = await self.access_token()
        reply = await http.get(
            f"{API}/{kind}",
            params={"start_date": start, "end_date": end},
            headers={"Authorization": f"Bearer {token}"},
        )
        if reply.status_code == 401:
            # A token turned down early: one refresh, then once more.
            tokens = self.tokens()
            tokens["expires_at"] = 0
            self.vault.set(CONN, "oauth_tokens", json.dumps(tokens))
            token = await self.access_token()
            reply = await http.get(
                f"{API}/{kind}",
                params={"start_date": start, "end_date": end},
                headers={"Authorization": f"Bearer {token}"},
            )
        if reply.status_code == 426:
            raise OuraError("Oura asks the owner to update the Oura app first.")
        if reply.status_code == 429:
            raise OuraError("Oura is rate-limiting requests; try again in a few minutes.")
        if reply.status_code != 200:
            raise OuraError(f"Oura didn't answer ({reply.status_code}).")
        data = reply.json().get("data")
        return data if isinstance(data, list) else []

    async def fetch(self, days: int = 8, today: date | None = None) -> dict[str, Any]:
        """The last `days` days of sleep, readiness and activity (cached for a while)."""
        async with self._lock:
            if self._cache and time.monotonic() - self._cache[0] < CACHE_SECONDS:
                cached = self._cache[1]
                if cached.get("days", 0) >= days and cached.get("today") == str(
                    today or date.today()
                ):
                    return cached
            today = today or date.today()
            start = (today - timedelta(days=days)).isoformat()
            end = (today + timedelta(days=1)).isoformat()
            async with self._http() as http:
                daily, periods, ready, active = await asyncio.gather(
                    self._get(http, "daily_sleep", start, end),
                    self._get(http, "sleep", start, end),
                    self._get(http, "daily_readiness", start, end),
                    self._get(http, "daily_activity", start, end),
                )
            data = {
                "today": today.isoformat(),
                "days": days,
                "daily_sleep": by_day(daily),
                "sleep": [p for p in periods if isinstance(p, dict)],
                "readiness": by_day(ready),
                "activity": by_day(active),
            }
            self._cache = (time.monotonic(), data)
            self.last = time.strftime("%H:%M")
            self.error = ""
            return data

    def summary(self, data: dict[str, Any], days: int = 1) -> str:
        """The last `days` nights in words, newest first."""
        today = date.fromisoformat(data["today"])
        lines = []
        for n in range(days):
            day = (today - timedelta(days=n)).isoformat()
            night = night_line(day, data["daily_sleep"], data["sleep"], data["readiness"])
            yesterday = (today - timedelta(days=n + 1)).isoformat()
            moved = activity_line(yesterday, data["activity"])
            if not night and not moved:
                continue
            label = "Last night" if n == 0 else f"The night to {day}"
            line = f"{label}: {night}." if night else f"{label}: no sleep recorded."
            if n == 0 and night:
                week = week_note(day, data["sleep"])
                if week:
                    line += f" That's {week}."
            if moved:
                line += f" The day before: {moved}."
            lines.append(line)
        if not lines:
            return (
                "The Oura ring has nothing for those days yet (it syncs when the Oura app opens)."
            )
        return " ".join(lines)

    async def briefing_facts(self) -> str:
        if not self.connected():
            return ""
        try:
            data = await self.fetch()
        except (OuraError, httpx.HTTPError) as exc:
            self.error = str(exc)
            return ""
        text = self.summary(data, 1)
        if text.startswith("The Oura ring has nothing"):
            return "The Oura ring hasn't synced last night yet: say so in a few words."
        return f"From the Oura ring: {text}"

    # ── the tool and the window ──

    def build_server(self):
        oura = self

        @tool(
            "oura_stats",
            "The owner's Oura ring data for the last days (newest first): sleep score, hours "
            "asleep and when, deep/REM/light sleep, efficiency, lowest heart rate, HRV, "
            "readiness and the day's steps and activity score.",
            {
                "type": "object",
                "properties": {"days": {"type": "integer", "minimum": 1, "maximum": MAX_DAYS}},
            },
        )
        async def oura_stats(args):
            try:
                days = max(1, min(MAX_DAYS, int(args.get("days") or 1)))
            except (TypeError, ValueError):
                days = 1
            try:
                data = await oura.fetch(max(8, days + 1))
                text, error = oura.summary(data, days), False
            except (OuraError, httpx.HTTPError) as exc:
                text, error = str(exc) or "Oura couldn't be reached.", True
            out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
            if error:
                out["is_error"] = True
            return out

        return create_sdk_mcp_server(name="oura", version="0.1.0", tools=[oura_stats])

    def emit(self, _msg: dict[str, Any] | None = None) -> None:
        self.hub.emit(
            "oura",
            client=bool(self.client().get("client_id")),
            connected=self.connected(),
            connecting=self.connecting,
            error=self.error,
            last=self.last,
            redirect_uri=connectors.REDIRECT_URI,
            apps_url=APPS_URL,
        )

    def attach(self) -> bool:
        """Joins the morning briefing's health section (once the briefing is installed)."""
        if self._attached:
            return True
        feature = getattr(self.hub, "proactive_feature", None)
        briefing = getattr(feature, "briefing", None)
        if briefing is None:
            return False
        briefing.add_facts("health", self.briefing_facts, private=True)
        self._attached = True
        return True

    async def loop(self) -> None:
        """Joins the briefing once everything's installed; then keeps the morning's numbers
        warm so the briefing and the wake-up call don't wait on Oura."""
        self.attach()
        while True:
            hour = time.localtime().tm_hour
            if self.connected() and 4 <= hour < 12:
                with contextlib.suppress(Exception):
                    await self.fetch()
            await asyncio.sleep(CACHE_SECONDS)


def install(hub: Any) -> None:
    oura = Oura(hub)
    hub.oura = oura
    hub.register_server(
        "oura", oura.build_server, prompt=PROMPT, labels={"oura_stats": "Read your Oura ring"}
    )
    hub.register_command("oura_state", oura.emit)
    hub.register_command("oura_save_client", oura.save_client, slow=True)
    hub.register_command("oura_connect", oura.connect, slow=True)
    hub.register_command("oura_disconnect", oura.disconnect)
    hub.register_command("oura_open_apps", lambda _msg: webbrowser.open(APPS_URL))
    hub.register_loop("oura", oura.loop)
