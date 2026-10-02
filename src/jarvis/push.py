"""Push notifications to the iPhone and Watch app, through Apple's push service (APNs).

The owner pastes in Settings the push key Apple gave them (the .p8 file's contents), its
Key ID, their team's ID and the app's bundle ID; all four go to the Keychain together
(connectors.Vault; a MemoryVault in tests), and are read from it once a run.

Each push carries a token signed with that key (an ES256 JWT), made once and used for 50
minutes: Apple wants a new one at least every hour, and no more often than every 20
minutes. APNs speaks HTTP/2 only (httpx here speaks HTTP/1.1), so a push goes out with
/usr/bin/curl --http2, to api.push.apple.com, or api.sandbox.push.apple.com for an app
built for development, as the device said when it registered. Everything about the
request, the token included, reaches curl on its standard input, never its command line,
where other processes could see it. Neither the key nor a token is ever logged.

What Apple answers decides what happens next: 410 (the app was removed) and a bad or
misdirected device token drop that device's token; a refused key (403) is shown in
Settings; an expired token is made again and the push sent once more.

Without a key of the owner's own, a Mac linked to a Jarvis account (account.py) pushes
through askeden.com instead (POST /push, its Apple key): the same pushes, to the official
app only, and Apple's answer comes back as askeden.com relayed it, into the same Result.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("jarvis")

VAULT_ID = "companion-apns"  # the Keychain entry: "Jarvis connectors" / companion-apns:config
VAULT_KEY = "config"
TEAM_DEFAULT = "9ZSY5R8A5C"  # BSH Ventures' Apple Developer team
BUNDLE_DEFAULT = "com.bshventures.jarvis.companion"  # companion/project.yml
HOSTS = {"production": "api.push.apple.com", "sandbox": "api.sandbox.push.apple.com"}
TOKEN_SECONDS = 50 * 60
CURL = "/usr/bin/curl"
CONNECT_SECONDS = 5
SEND_SECONDS = 15
AT_ONCE = 4  # pushes being sent at the same time (a curl each)
MAX_PAYLOAD = 4096  # bytes: APNs refuses a bigger alert or Live Activity update
_TOKEN = re.compile(r"[0-9a-f]{32,200}")
_TEN = re.compile(r"[A-Z0-9]{10}")
_BUNDLE = re.compile(r"[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+")
# APNs's reasons that mean the device token is no good any more, whatever else is right.
GONE = frozenset({"Unregistered", "BadDeviceToken", "DeviceTokenNotForTopic", "ExpiredToken"})
# ... and those that mean Apple refused the key or the team (Settings says so).
BAD_KEY = frozenset(
    {
        "InvalidProviderToken",
        "MissingProviderToken",
        "BadCertificate",
        "BadCertificateEnvironment",
        "TopicDisallowed",
        "Forbidden",
    }
)

Run = Callable[[list[str], bytes, float], Awaitable[tuple[int, bytes, bytes]]]


def valid_token(value: Any) -> bool:
    """A device (or Live Activity) token as the app registers it: lowercase hex."""
    return isinstance(value, str) and bool(_TOKEN.fullmatch(value))


def valid_bundle(value: Any) -> bool:
    return isinstance(value, str) and len(value) <= 155 and bool(_BUNDLE.fullmatch(value))


class KeyProblem(ValueError):
    """What's wrong with a push key as pasted, in words to show."""


@dataclass(frozen=True)
class Credentials:
    key: str  # the .p8 file's contents (PEM, PKCS#8)
    key_id: str
    team_id: str
    bundle_id: str

    def public(self) -> dict[str, str]:
        """For Settings: never the key itself."""
        return {"key_id": self.key_id, "team_id": self.team_id, "bundle_id": self.bundle_id}

    def topics(self) -> tuple[str, ...]:
        """The app's own bundle ID and its extensions' (the Watch app is one)."""
        return (self.bundle_id,)

    def allows(self, bundle_id: str) -> bool:
        return bundle_id == self.bundle_id or bundle_id.startswith(self.bundle_id + ".")


def _private_key(pem: str) -> Any:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    try:
        key = serialization.load_pem_private_key(pem.encode(), password=None)
    except (ValueError, TypeError):
        raise KeyProblem(
            "That isn't a push key. Paste everything in the .p8 file Apple gave you, from "
            "-----BEGIN PRIVATE KEY----- to -----END PRIVATE KEY-----."
        ) from None
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise KeyProblem("That key isn't an Apple push key (they're P-256 keys, in a .p8 file).")
    return key


def check(key: Any, key_id: Any, team_id: Any, bundle_id: Any) -> Credentials:
    """The four as pasted, cleaned and checked (KeyProblem says what's wrong)."""
    pem = str(key or "").strip().replace("\r\n", "\n")
    if len(pem) > 10_000:
        raise KeyProblem("That's far too long for a push key.")
    _private_key(pem)
    key_id = re.sub(r"\s", "", str(key_id or "")).upper()
    team_id = re.sub(r"\s", "", str(team_id or TEAM_DEFAULT)).upper()
    bundle_id = str(bundle_id or BUNDLE_DEFAULT).strip()
    if not _TEN.fullmatch(key_id):
        raise KeyProblem("The Key ID is the 10 letters and digits beside the key in Apple's list.")
    if not _TEN.fullmatch(team_id):
        raise KeyProblem("The Team ID is 10 letters and digits (yours is 9ZSY5R8A5C).")
    if len(bundle_id) > 155 or not _BUNDLE.fullmatch(bundle_id):
        raise KeyProblem("The bundle ID looks like com.bshventures.jarvis.companion.")
    return Credentials(pem + "\n", key_id, team_id, bundle_id)


@dataclass(frozen=True)
class AccountRoute:
    """Pushes through the owner's Jarvis account (askeden.com's Apple key): only the
    official app's own pushes (askeden.com picks the topic, so a token another bundle
    registered can't be reached this way)."""

    bundle_id: str = BUNDLE_DEFAULT

    def allows(self, bundle_id: str) -> bool:
        return bundle_id == self.bundle_id


class Keys:
    """The credentials in the Keychain, read once (in a thread) and kept for the run.
    error is Apple's latest refusal of them, for Settings; a push that goes clears it."""

    def __init__(self, vault: Any) -> None:
        self.vault = vault
        self._creds: Credentials | None = None
        self._read = False
        self.error = ""
        self._lock = asyncio.Lock()

    async def get(self) -> Credentials | None:
        if not self._read:
            async with self._lock:
                if not self._read:
                    self._creds = await asyncio.to_thread(self._load)
                    self._read = True
        return self._creds

    def _load(self) -> Credentials | None:
        try:
            raw = self.vault.get(VAULT_ID, VAULT_KEY)
        except Exception:  # a locked or unavailable Keychain: pushes wait until it's there
            log.warning("push: the Keychain couldn't be read")
            return None
        if not raw:
            return None
        try:
            data = json.loads(raw)
            return check(data["key"], data["key_id"], data["team_id"], data["bundle_id"])
        except (ValueError, KeyError, TypeError):
            log.warning("push: the saved push key can't be used; paste it again in Settings")
            return None

    async def save(self, creds: Credentials) -> None:
        data = json.dumps({"key": creds.key, **creds.public()})
        await asyncio.to_thread(self.vault.set, VAULT_ID, VAULT_KEY, data)
        self._creds, self._read, self.error = creds, True, ""

    async def forget(self) -> None:
        await asyncio.to_thread(self.vault.delete, VAULT_ID, VAULT_KEY)
        self._creds, self._read, self.error = None, True, ""

    def status(self) -> dict[str, Any]:
        """For Settings: whether a key is set and whose (known once read), and Apple's
        latest refusal."""
        creds = self._creds
        return {
            "known": self._read,
            "configured": creds is not None,
            **(creds.public() if creds else {}),
            "error": self.error,
        }


# ── the provider token ──


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_token(creds: Credentials, now: float) -> str:
    """The provider token: a JWT signed ES256 with the push key (r and s, 32 bytes each)."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    header = _b64(json.dumps({"alg": "ES256", "kid": creds.key_id}, separators=(",", ":")).encode())
    claims = _b64(
        json.dumps({"iss": creds.team_id, "iat": int(now)}, separators=(",", ":")).encode()
    )
    signing_input = f"{header}.{claims}".encode()
    der = _private_key(creds.key).sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der)
    return f"{header}.{claims}.{_b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


# ── one push ──


@dataclass
class Push:
    device_token: str  # hex, as the app registered it
    environment: str  # "production" or "sandbox"
    topic: str  # the bundle ID (<bundle ID>.push-type.liveactivity for a Live Activity)
    payload: dict[str, Any]
    push_type: str = "alert"  # alert | background | liveactivity
    priority: int = 10  # 10 now; 5 when it can wait (and costs the app no budget)
    collapse_id: str = ""  # a newer push with the same id replaces this one on the phone
    expiration: int = 0  # epoch seconds Apple may keep trying until; 0: now or never


@dataclass
class Result:
    status: int  # Apple's HTTP status; 0 when no answer came
    reason: str = ""  # Apple's reason ("BadDeviceToken"), or why it didn't go out

    @property
    def ok(self) -> bool:
        return self.status == 200

    @property
    def gone(self) -> bool:
        """The device token is no good any more: the app should register again."""
        return self.status == 410 or self.reason in GONE

    @property
    def bad_key(self) -> bool:
        return self.status == 403 and self.reason != "ExpiredProviderToken"


def body_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()


def _quoted(value: str) -> str:
    """A value for curl's config file: in double quotes, with \\ and " escaped."""
    if "\n" in value or "\r" in value:
        raise ValueError("no line breaks in a curl option")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def curl_config(push: Push, token: str) -> bytes:
    """Everything curl needs, as the config it reads on stdin (curl --config -)."""
    host = HOSTS.get(push.environment, HOSTS["production"])
    headers = [
        f"authorization: bearer {token}",
        f"apns-topic: {push.topic}",
        f"apns-push-type: {push.push_type}",
        f"apns-priority: {push.priority}",
        f"apns-expiration: {push.expiration}",
        "content-type: application/json",
    ]
    if push.collapse_id:
        headers.append(f"apns-collapse-id: {push.collapse_id}")
    lines = [
        f"url = {_quoted(f'https://{host}/3/device/{push.device_token}')}",
        "http2",
        "silent",
        "show-error",
        'request = "POST"',
        f"connect-timeout = {CONNECT_SECONDS}",
        f"max-time = {SEND_SECONDS}",
        *(f"header = {_quoted(h)}" for h in headers),
        f"data-binary = {_quoted(body_bytes(push.payload).decode())}",
        'write-out = "\\n%{http_code}"',
    ]
    return ("\n".join(lines) + "\n").encode()


async def run_curl(argv: list[str], stdin: bytes, timeout: float) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(stdin), timeout)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        await proc.wait()
        return -1, b"", b"timed out"
    return proc.returncode or 0, out, err


def parse(code: int, out: bytes) -> Result:
    """curl's exit code and output (the body, a line break, the status) as a Result."""
    if code != 0:
        return Result(0, f"network ({code})")
    body, _, status = out.rpartition(b"\n")
    try:
        http = int(status.strip() or 0)
    except ValueError:
        return Result(0, "no status")
    reason = ""
    if body.strip():
        try:
            data = json.loads(body)
            reason = str(data.get("reason", ""))[:80] if isinstance(data, dict) else ""
        except ValueError:
            reason = ""
    return Result(http, reason)


class Sender:
    """Sends pushes with the owner's key: a few at a time, each with the token of the
    hour; without one, through their Jarvis account when this Mac is linked. run: how curl
    is run (tests pass a fake: no network, ever). account: gives the account client
    (account.Account) or None."""

    def __init__(
        self,
        keys: Keys,
        run: Run | None = None,
        clock=time.time,
        account: Callable[[], Any] | None = None,
    ) -> None:
        self.keys = keys
        self.run = run or run_curl
        self.clock = clock
        self.account = account or (lambda: None)
        self._token: tuple[tuple[str, str, str], str, float] | None = None
        self._gate = asyncio.Semaphore(AT_ONCE)

    def _linked(self) -> Any:
        try:
            account = self.account()
        except Exception:
            return None
        return account if account is not None and getattr(account, "linked", False) else None

    async def route(self) -> Credentials | AccountRoute | None:
        """How a push would go now: the owner's own key, their Jarvis account, or not at
        all (None). Each says which apps' tokens it reaches (allows)."""
        creds = await self.keys.get()
        if creds is not None:
            return creds
        account = self._linked()
        if account is not None:
            await account.load()
            if account.linked:
                return AccountRoute()
        return None

    def through_account(self) -> bool:
        """Settings: no key of the owner's own (as last read), and linked."""
        return self.keys.status()["configured"] is False and self._linked() is not None

    def token(self, creds: Credentials, fresh: bool = False) -> str:
        who = (creds.key_id, creds.team_id, creds.key)
        now = self.clock()
        if (
            fresh
            or self._token is None
            or self._token[0] != who
            or now - self._token[2] >= TOKEN_SECONDS
        ):
            self._token = (who, make_token(creds, now), now)
        return self._token[1]

    async def send(self, push: Push) -> Result:
        route = await self.route()
        if route is None:
            return Result(0, "no key")
        if not _TOKEN.fullmatch(push.device_token) or push.environment not in HOSTS:
            return Result(0, "BadDeviceToken")
        if len(body_bytes(push.payload)) > MAX_PAYLOAD:
            return Result(0, "PayloadTooLarge")
        if isinstance(route, AccountRoute):
            async with self._gate:
                result = await self._relayed(push)
            if not (result.ok or result.gone):
                log.info(
                    "push: not delivered through the account (%s %s)", result.status, result.reason
                )
            return result
        creds = route
        async with self._gate:
            result = await self._once(push, self.token(creds))
            if result.status == 403 and result.reason == "ExpiredProviderToken":
                result = await self._once(push, self.token(creds, fresh=True))
        if result.bad_key:
            self.keys.error = result.reason or "Forbidden"
            log.warning("push: Apple refused the push key (%s)", self.keys.error)
        elif result.ok:
            self.keys.error = ""
        elif not result.gone:
            log.info("push: not delivered (%s %s)", result.status, result.reason)
        return result

    async def _relayed(self, push: Push) -> Result:
        """One push through askeden.com: Apple's status and reason as it relayed them
        (status 0 when it never got to Apple: offline, signed out, over the account's
        limit)."""
        account = self._linked()
        if account is None:
            return Result(0, "no key")
        body: dict[str, Any] = {
            "apns_token": push.device_token,
            "apns_env": push.environment,
            "push_type": push.push_type,
            "priority": push.priority,
            "payload": push.payload,
        }
        if push.collapse_id:
            body["collapse_id"] = push.collapse_id
        if push.expiration:
            body["expiration"] = push.expiration
        status, reason = await account.push(body)
        return Result(status, reason)

    async def _once(self, push: Push, token: str) -> Result:
        try:
            config = curl_config(push, token)
        except ValueError:
            return Result(0, "bad request")
        try:
            code, out, _err = await self.run([CURL, "--config", "-"], config, SEND_SECONDS + 5)
        except OSError as exc:  # no curl
            return Result(0, f"curl couldn't run ({exc.strerror or exc})")
        return parse(code, out)


# ── what a push says ──


def alert(
    title: str,
    body: str,
    *,
    category: str = "",
    thread: str = "",
    sound: bool = True,
    level: str = "active",
    jarvis: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """An alert push's payload. level: passive (no sound, the screen stays dark),
    active, or time-sensitive (breaks through a Focus the owner allows it to)."""
    aps: dict[str, Any] = {"alert": {"title": title[:120], "body": body[:240]}}
    if sound and level != "passive":
        aps["sound"] = "default"
    if category:
        aps["category"] = category
    if thread:
        aps["thread-id"] = thread[:64]
    aps["interruption-level"] = level
    payload: dict[str, Any] = {"aps": aps}
    if jarvis is not None:
        payload["jarvis"] = jarvis
    return payload


def live_update(
    state: dict[str, Any],
    *,
    event: str = "update",
    now: float | None = None,
    dismiss_after: float = 15 * 60,
    alert_text: tuple[str, str] | None = None,
) -> dict[str, Any]:
    """A Live Activity update (event "update") or its end ("end": it stays on the Lock
    Screen dismiss_after seconds more)."""
    at = int(now if now is not None else time.time())
    aps: dict[str, Any] = {"timestamp": at, "event": event, "content-state": state}
    if event == "end":
        aps["dismissal-date"] = at + int(dismiss_after)
    else:
        aps["stale-date"] = at + 2 * 60 * 60  # shown as out of date if nothing new comes
    if alert_text is not None:
        aps["alert"] = {"title": alert_text[0][:120], "body": alert_text[1][:240]}
    return {"aps": aps}
