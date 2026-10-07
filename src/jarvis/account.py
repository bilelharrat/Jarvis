"""This Mac's Jarvis account, at askeden.com (docs/accounts.md is the contract).

Optional, and off until the owner links: everything works without it, as before. Linked,
the Mac gets what it can't do alone: AI included (Jarvis Plus), notifications without a
push key of the owner's own, the phone reaching it from anywhere (relay.py), and memory and
settings synced with their iPhone (account_sync.py).

Linking: the Mac makes an X25519 key pair, asks askeden.com for a code (POST /link/start)
and shows it, big and as a QR code (jarvis-link://CODE). The owner's signed-in iPhone
approves it, sealing the account's sync key to the Mac's public key on the way; the Mac
asks every two seconds (POST /link/poll) until it's approved, denied or expired. Approved,
it keeps the device token and the sync key, unsealed here, in the Keychain
(connectors.Vault, entry jarvis-account: token and sync_key; a MemoryVault in tests). The
private key is never written anywhere: it lives as long as that one code.

The token is a device credential: it's sent to askeden.com alone, as a bearer token, and
never logged, shown or written to a file. A 401 from askeden.com means it was signed out
(unlinked from the phone, the account deleted): it's forgotten here at once and Settings
shows the Mac as not linked.

Approving a browser: a linked Mac can let a browser into the account, as the iPhone can
(Eden at askeden.com shows a code while it waits). The owner types the code in Settings; the
Mac asks what's waiting (GET /link/<code>), shows its name, and approves or denies it with
its own token. Only a browser's sign-in (kind `web`): a Mac is linked from the iPhone,
never from another Mac (askeden.com refuses it too).

Nothing here touches the network until the owner links, or a feature asks for the account's
status while linked.
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
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

log = logging.getLogger("jarvis")

BASE = "https://askeden.com/api"
# The servers a Mac may link to (Settings › Account › Server): askeden.com, or its preview
# (preview.askeden.com, its own accounts). The one a Mac linked to is kept beside its token, so the
# token only ever goes back there; another server needs unlinking first.
SERVERS = ("askeden.com", "preview.askeden.com")
SERVER_PREF = "account_server"  # Settings: the server to link to (askeden.com unless chosen)
SERVER_KEY = "server"  # the Keychain: the server the token belongs to
VAULT_ID = "jarvis-account"  # the Keychain entry: "Jarvis connectors" / jarvis-account:token
TOKEN_KEY = "token"
SYNC_KEY = "sync_key"  # the sync key, base64 (32 bytes)
# Eden sync's (eden_trust.py): this Mac's X25519 private key, and Eden's key with its generation.
EDEN_DEVICE_KEY = "eden_device"
EDEN_KEY = "eden_key"
LINK_INFO = b"jarvis-link-v1"  # HKDF info and AEAD associated data for the sealed sync key
LINK_SCHEME = "jarvis-link://"
POLL_SECONDS = 2.0
STATUS_SECONDS = 60.0  # GET /account is asked again after this
REQUEST_SECONDS = 15.0
RELAY_PREF = "account_relay"  # Settings: reach this Mac through the account (on by default)
PLUS_PREF = "account_plus_ai"  # Settings: Jarvis Plus answers instead of the Claude sign-in
_TOKEN = re.compile(
    r"jv1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{16})\."
    r"[A-Za-z0-9_-]{43}"
)
_CODE = re.compile(r"[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}")
NOT_A_CODE = "That isn't a sign-in code. It has eight letters and numbers, like K7QM-4ZTR."
NOTHING_WAITING = "Nothing is waiting with that code. Check it, or get a new one in the browser."
CODE_EXPIRED = "That code expired. Get a new one in the browser."
MAC_CODE = "That code is for linking a Mac: approve it in the J.A.R.V.I.S. app on your iPhone."


def normalize_code(text: Any) -> str | None:
    """A link code as it's shown (XXXX-XXXX), from what the owner typed: any case, with or
    without the dash, spaces or jarvis-link://. None when it isn't one."""
    if not isinstance(text, str) or len(text) > 64:
        return None
    clean = text.strip()
    if clean.lower().startswith(LINK_SCHEME):
        clean = clean[len(LINK_SCHEME) :]
    clean = re.sub(r"[\s-]", "", clean).upper()
    if len(clean) != 8:
        return None
    code = f"{clean[:4]}-{clean[4:]}"
    return code if _CODE.fullmatch(code) else None


class AccountError(Exception):
    """askeden.com said no, or couldn't be reached: status 0 for the network. message is
    words for the owner (the server's own when it sent some)."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class SignedOut(AccountError):
    """The token is unknown or revoked: this Mac isn't linked any more."""


def parse_token(token: Any) -> tuple[str, str] | None:
    """(account id, device id) of a device token as askeden.com makes them; None if it
    isn't one."""
    if not isinstance(token, str):
        return None
    found = _TOKEN.fullmatch(token)
    return (found.group(1), found.group(2)) if found else None


def b64decode(text: Any) -> bytes:
    """Base64 as either app writes it: standard or URL-safe, padded or not. ValueError for
    anything else."""
    if not isinstance(text, str) or len(text) > 100_000:
        raise ValueError("not base64")
    clean = text.strip().replace("-", "+").replace("_", "/")
    clean += "=" * (-len(clean) % 4)
    try:
        return base64.b64decode(clean, validate=True)
    except (ValueError, TypeError):
        raise ValueError("not base64") from None


def b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode()


# ── the sealed sync key ──


def _link_key(private: Any, public: bytes) -> bytes:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    shared = private.exchange(X25519PublicKey.from_public_bytes(public))
    return HKDF(hashes.SHA256(), 32, salt=None, info=LINK_INFO).derive(shared)


def unseal(mac_private: Any, sender_public: bytes, sealed: str) -> bytes:
    """The sync key the iPhone sealed to this Mac (the contract's "Sealing the sync key"):
    X25519 with the phone's one-time key, HKDF-SHA256, ChaCha20-Poly1305 over
    nonce ‖ ciphertext ‖ tag. ValueError when it doesn't open."""
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

    raw = b64decode(sealed)
    if len(sender_public) != 32 or len(raw) < 12 + 16:
        raise ValueError("the sealed key is the wrong size")
    try:
        key = _link_key(mac_private, sender_public)
        opened = ChaCha20Poly1305(key).decrypt(raw[:12], raw[12:], LINK_INFO)
    except (InvalidTag, ValueError):
        raise ValueError("the sealed key doesn't open with this Mac's key") from None
    if len(opened) != 32:
        raise ValueError("the sync key is the wrong size")
    return opened


def seal(
    mac_public: bytes, sync_key: bytes, sender_private: Any = None, nonce: bytes | None = None
) -> tuple[str, str]:
    """What the iPhone does (tests, and the interop vector): (sealed, sender public key),
    both base64."""
    import os

    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    sender = sender_private or X25519PrivateKey.generate()
    nonce = nonce or os.urandom(12)
    key = _link_key(sender, mac_public)
    sealed = nonce + ChaCha20Poly1305(key).encrypt(nonce, sync_key, LINK_INFO)
    public = sender.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return b64encode(sealed), b64encode(public)


def _new_key_pair() -> tuple[Any, bytes]:
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    private = X25519PrivateKey.generate()
    return private, private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


# ── the link in progress ──


@dataclass
class Link:
    """One code on screen: what it takes to finish it, and how it's going."""

    code: str
    poll: str
    expires_at: float  # on the account's clock (monotonic)
    private: Any = field(repr=False)  # this code's X25519 key: memory only
    state: str = "waiting"  # waiting | linked | expired | denied | error
    error: str = ""
    qr: list[str] = field(default_factory=list)
    browser: bool = False  # approved in the owner's browser (<server>/link), not on the iPhone

    @property
    def url(self) -> str:
        return LINK_SCHEME + self.code


@dataclass
class Approval:
    """A browser's sign-in this Mac was asked to approve: its code, what it's called, and
    how it's going."""

    code: str
    name: str = ""
    kind: str = ""
    state: str = "asking"  # asking | approved | denied | error
    error: str = ""


def app_version() -> str:
    """The app's version, from its package.json ("" when it can't be read)."""
    from . import packaged

    try:
        data = json.loads((packaged.app_dir() / "package.json").read_text())
    except (OSError, ValueError):
        return ""
    version = data.get("version") if isinstance(data, dict) else None
    return version[:40] if isinstance(version, str) else ""


def _error_of(response: httpx.Response) -> tuple[str, str]:
    """The server's (code, words) from an error answer."""
    try:
        data = response.json()
    except ValueError:
        data = None
    if isinstance(data, dict) and isinstance(data.get("error"), dict):  # Anthropic's shape
        inner = data["error"]
        return str(inner.get("type") or ""), str(inner.get("message") or "")[:300]
    if isinstance(data, dict):
        return str(data.get("code") or ""), str(data.get("error") or "")[:300]
    return "", ""


class Account:
    """The account client: the token and sync key in the Keychain (read once, in a
    thread), the link in progress, the account's status (cached a minute), and askeden.com's
    calls. transport: tests pass an httpx.MockTransport (never the network)."""

    def __init__(
        self,
        vault: Any,
        *,
        base: str = BASE,
        transport: httpx.AsyncBaseTransport | None = None,
        name: Callable[[], str] | None = None,
        version: Callable[[], str] = app_version,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    ) -> None:
        self.vault = vault
        self.base = base.rstrip("/")
        self.server = urlsplit(self.base).hostname or SERVERS[0]  # the host the token is for
        self.transport = transport
        self.name = name or _mac_name
        self.version = version
        self.clock = clock
        self.sleep = sleep
        self.token = ""
        self.sync_key: bytes | None = None
        self.link: Link | None = None
        self.approval: Approval | None = None  # a browser's sign-in, being approved here
        self.info: dict[str, Any] | None = None  # the latest GET /account
        self.error = ""  # the latest problem, in words for Settings
        # Whether Claude Code is signed in to a Claude account (the feature checks it);
        # None: not known. Not signed in and linked: Jarvis Plus answers (claude_signin).
        self.claude_signed_in: bool | None = None
        self.on_change: list[Callable[[], Any]] = []
        self._read = False
        self._lock = asyncio.Lock()
        self._client: httpx.AsyncClient | None = None
        self._poller: asyncio.Task | None = None
        self._info_at = 0.0

    # ── what's kept ──

    @property
    def linked(self) -> bool:
        return bool(self.token)

    @property
    def ids(self) -> tuple[str, str] | None:
        return parse_token(self.token)

    @property
    def account_id(self) -> str | None:
        ids = self.ids
        return ids[0] if ids else None

    @property
    def device_id(self) -> str | None:
        ids = self.ids
        return ids[1] if ids else None

    @property
    def web_base(self) -> str:
        """The server's site (https://askeden.com): its /link page."""
        return self.base.removesuffix("/api")

    @property
    def ws_base(self) -> str:
        """The server's relays (wss://askeden.com/api/relay): the phone's and Eden on the web's."""
        return "wss://" + self.base.split("://", 1)[-1] + "/relay"

    def use_server(self, host: Any) -> bool:
        """Link to `host` (one of SERVERS) from now on: only while not linked or linking (a
        token stays with the server that made it). False when it can't change now."""
        if host not in SERVERS:
            return False
        if host == self.server:
            return True
        if self.linked or self.link is not None:
            return False
        self.server, self.base = host, f"https://{host}/api"
        if self._client is not None:
            client, self._client = self._client, None
            with contextlib.suppress(RuntimeError):
                asyncio.get_running_loop().create_task(client.aclose())
        self.info, self._info_at = None, 0.0
        log.info("account: links go to %s", host)
        self._changed()
        return True

    async def load(self) -> None:
        """The token and sync key from the Keychain, once (a locked Keychain: tried again
        next time)."""
        if self._read:
            return
        async with self._lock:
            if self._read:
                return
            try:
                token, key, server = await asyncio.to_thread(self._load)
            except Exception:
                log.warning("account: the Keychain couldn't be read")
                return
            self.token = token if parse_token(token) else ""
            if self.token and server in SERVERS and server != self.server:
                self.server, self.base = server, f"https://{server}/api"  # where this token lives
            try:
                self.sync_key = b64decode(key) if key else None
            except ValueError:
                self.sync_key = None
            if self.sync_key is not None and len(self.sync_key) != 32:
                self.sync_key = None
            self._read = True

    def _load(self) -> tuple[str, str, str]:
        return (
            self.vault.get(VAULT_ID, TOKEN_KEY) or "",
            self.vault.get(VAULT_ID, SYNC_KEY) or "",
            self.vault.get(VAULT_ID, SERVER_KEY) or "",
        )

    async def _keep(self, token: str, sync_key: bytes | None) -> None:
        def write() -> None:
            self.vault.set(VAULT_ID, TOKEN_KEY, token)
            self.vault.set(VAULT_ID, SERVER_KEY, self.server)
            if sync_key is not None:
                self.vault.set(VAULT_ID, SYNC_KEY, b64encode(sync_key))
            else:
                self.vault.delete(VAULT_ID, SYNC_KEY)

        await asyncio.to_thread(write)
        self.token, self.sync_key, self._read = token, sync_key, True

    async def forget(self) -> None:
        """Not linked any more: the token, the sync key and Eden sync's keys leave the
        Keychain."""
        had = self.linked
        self.token, self.sync_key, self.info, self._read = "", None, None, True
        self.approval = None
        self._info_at = 0.0

        def remove() -> None:
            for key in (TOKEN_KEY, SYNC_KEY, EDEN_DEVICE_KEY, EDEN_KEY, SERVER_KEY):
                self.vault.delete(VAULT_ID, key)

        try:
            await asyncio.to_thread(remove)
        except Exception:
            log.warning("account: the Keychain couldn't be cleared")
        if had:
            log.info("account: this Mac is no longer linked")
        self._changed()

    def _changed(self) -> None:
        for hear in list(self.on_change):
            try:
                hear()
            except Exception:
                log.exception("account: a listener failed")

    # ── talking to askeden.com ──

    def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base, transport=self.transport, timeout=REQUEST_SECONDS
            )
        return self._client

    async def aclose(self) -> None:
        if self._poller is not None:
            self._poller.cancel()
            with contextlib.suppress(BaseException):
                await self._poller
            self._poller = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def send(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: dict[str, Any] | None = None,
        auth: bool = True,
    ) -> httpx.Response:
        """One call. Raises AccountError for the network (status 0) and SignedOut (after
        forgetting the token) for a 401 on an authenticated call; every other answer is
        returned as it came."""
        headers = {}
        if auth:
            await self.load()
            if not self.token:
                raise SignedOut(401, "signed_out", "This Mac isn't linked to a Jarvis account.")
            headers["Authorization"] = f"Bearer {self.token}"
        try:
            response = await self._http().request(
                method, path, json=body, params=params, headers=headers
            )
        except httpx.HTTPError as exc:
            raise AccountError(0, "offline", "Couldn't reach askeden.com.") from exc
        if auth and response.status_code == 401:
            _code, words = _error_of(response)
            await self.forget()
            raise SignedOut(401, "signed_out", words or "This Mac was signed out of the account.")
        return response

    async def call(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: dict[str, Any] | None = None,
        auth: bool = True,
        ok: tuple[int, ...] = (200, 204),
    ) -> Any:
        """One call whose answer must be one of ok: its JSON (None for no body); anything
        else raises AccountError with the server's words."""
        response = await self.send(method, path, body=body, params=params, auth=auth)
        if response.status_code not in ok:
            code, words = _error_of(response)
            raise AccountError(
                response.status_code, code, words or f"askeden.com said {response.status_code}."
            )
        if response.status_code == 204 or not response.content:
            return None
        try:
            return response.json()
        except ValueError:
            raise AccountError(
                response.status_code, "bad_answer", "askeden.com's answer couldn't be read."
            ) from None

    # ── linking ──

    async def link_start(self, browser: bool = False) -> Link:
        """A new code to show (the one before, if any, is let go). The poller runs until
        it's approved, denied or expired. browser: the owner approves it at the server's /link
        page (link_page) rather than on the iPhone; the same code either way."""
        if self._poller is not None and not self._poller.done():
            self._poller.cancel()
        private, public = _new_key_pair()
        name = await asyncio.to_thread(self.name)
        data = await self.call(
            "POST",
            "/link/start",
            body={
                "name": name or "Mac",
                "kind": "mac",
                "public_key": b64encode(public),
                "app_version": self.version(),
            },
            auth=False,
        )
        if not isinstance(data, dict):
            raise AccountError(200, "bad_answer", "askeden.com's answer couldn't be read.")
        code, poll, seconds = data.get("code"), data.get("poll"), data.get("expires_in")
        if not (isinstance(code, str) and _CODE.fullmatch(code) and isinstance(poll, str)):
            raise AccountError(200, "bad_answer", "askeden.com's answer couldn't be read.")
        if not isinstance(seconds, int | float) or isinstance(seconds, bool) or seconds <= 0:
            seconds = 600
        link = Link(code, poll, self.clock() + float(seconds), private, browser=browser)
        from . import qr

        with contextlib.suppress(ValueError):
            link.qr = qr.rows(await asyncio.to_thread(qr.encode, link.url))
        self.link = link
        log.info("account: link code made (good for %d s)", int(seconds))
        self._poller = asyncio.get_running_loop().create_task(self._poll(link))
        self._changed()
        return link

    def link_page(self) -> str:
        """The server's page that approves this Mac's code in the browser (the code after #,
        so it never reaches a server log); "" without a code waiting."""
        link = self.link
        if link is None or link.state != "waiting":
            return ""
        return f"{self.web_base}/link#{link.code}"

    def cancel_link(self) -> None:
        if self._poller is not None and not self._poller.done():
            self._poller.cancel()
        self.link = None
        self._changed()

    def seconds_left(self) -> int:
        link = self.link
        return max(0, round(link.expires_at - self.clock())) if link else 0

    async def _poll(self, link: Link) -> None:
        try:
            while link.state == "waiting" and self.link is link:
                await self.sleep(POLL_SECONDS)
                if self.link is not link:
                    return
                if self.clock() >= link.expires_at:
                    link.state = "expired"
                    break
                try:
                    response = await self.send(
                        "POST",
                        "/link/poll",
                        body={"code": link.code, "poll": link.poll},
                        auth=False,
                    )
                except AccountError:  # offline for a moment: ask again
                    continue
                status = response.status_code
                if status == 202:
                    continue
                if status == 200:
                    await self._linked(link, response)
                elif status == 410:
                    code, _words = _error_of(response)
                    link.state = "denied" if code == "denied" else "expired"
                elif status == 404:
                    link.state = "expired"
                elif status == 429:
                    with contextlib.suppress(ValueError):
                        await self.sleep(min(30.0, float(response.headers.get("retry-after", 5))))
                elif status < 500:
                    _code, words = _error_of(response)
                    link.state, link.error = "error", words or f"askeden.com said {status}."
            if link.state != "linked":
                log.info("account: link code %s", link.state)
        finally:
            if self.link is link:
                self._changed()

    async def _linked(self, link: Link, response: httpx.Response) -> None:
        try:
            data = response.json()
        except ValueError:
            data = None
        token = data.get("token") if isinstance(data, dict) else None
        if parse_token(token) is None:
            link.state, link.error = "error", "askeden.com's answer couldn't be read."
            return
        sync_key, problem = None, ""
        sealed, sender = data.get("sealed_key"), data.get("sender_key")
        if sealed and sender:
            try:
                sync_key = unseal(link.private, b64decode(sender), sealed)
            except ValueError as exc:
                problem = "Linked, but the sync key couldn't be opened."
                log.warning("account: the sync key couldn't be opened (%s)", exc)
        try:
            await self._keep(token, sync_key)
        except Exception:
            link.state = "error"
            link.error = (
                "The Keychain didn't take the account. If it's locked, unlock it and link again."
            )
            log.warning("account: the token couldn't be saved in the Keychain")
            return
        link.state, link.error, link.private = "linked", problem, None
        self.error = problem
        self.info, self._info_at = None, 0.0
        log.info("account: linked (sync key: %s)", "yes" if sync_key else "no")

    # ── approving a browser's sign-in ──

    async def web_peek(self, text: Any) -> Approval:
        """What's waiting with the code the owner typed (GET /link/<code>): kept as the
        approval in hand when it's a browser; AccountError otherwise (a Mac's code is
        refused here, before askeden.com would)."""
        code = normalize_code(text)
        self.approval = None
        if code is None:
            raise AccountError(400, "bad_code", NOT_A_CODE)
        try:
            data = await self.call("GET", f"/link/{code}")
        except SignedOut:
            raise
        except AccountError as exc:
            if exc.status == 404:
                raise AccountError(404, "not_found", NOTHING_WAITING) from None
            if exc.status == 410:
                raise AccountError(410, "expired", CODE_EXPIRED) from None
            raise
        if not isinstance(data, dict):
            raise AccountError(200, "bad_answer", "askeden.com's answer couldn't be read.")
        kind = data.get("kind") if isinstance(data.get("kind"), str) else ""
        if kind != "web":
            raise AccountError(403, "not_web", MAC_CODE)
        name = data.get("name") if isinstance(data.get("name"), str) else ""
        self.approval = Approval(code, " ".join(name.split())[:120] or "Eden on the web", kind)
        self._changed()
        return self.approval

    async def web_answer(self, text: Any, approve: bool) -> Approval:
        """Approve (POST /link/<code>/approve, an empty body: a browser gets no sync key) or
        deny the browser asked about. Only the code peeked at, and only a browser's."""
        code = normalize_code(text)
        held = self.approval
        if held is None or code is None or held.code != code or held.kind != "web":
            raise AccountError(409, "not_peeked", "Type the code again, then approve it.")
        if held.state != "asking":
            return held
        action = "approve" if approve else "deny"
        try:
            await self.call("POST", f"/link/{code}/{action}", body={})
        except SignedOut:
            self.approval = None
            raise
        except AccountError as exc:
            held.state = "error"
            if exc.status == 404:
                held.error = NOTHING_WAITING
            elif exc.status == 410:
                held.error = CODE_EXPIRED
            else:
                held.error = exc.message
            self._changed()
            return held
        held.state = "approved" if approve else "denied"
        log.info("account: a browser's sign-in %s", held.state)
        self._changed()
        return held

    def web_clear(self) -> None:
        self.approval = None
        self._changed()

    # ── the account ──

    async def status(self, fresh: bool = False) -> dict[str, Any] | None:
        """GET /account, kept a minute (fresh: asked now). None when not linked or it can't
        be had (error says why)."""
        await self.load()
        if not self.linked:
            return None
        if not fresh and self.info is not None and self.clock() - self._info_at < STATUS_SECONDS:
            return self.info
        try:
            data = await self.call("GET", "/account")
        except SignedOut:
            return None
        except AccountError as exc:
            self.error = exc.message
            return self.info
        if isinstance(data, dict):
            self.info, self._info_at, self.error = data, self.clock(), ""
        return self.info

    async def unlink(self) -> bool:
        """Sign this Mac out of the account (DELETE /devices/me), then forget it here
        whatever askeden.com said. False when askeden.com couldn't be told."""
        told = True
        try:
            await self.call("DELETE", "/devices/me")
        except SignedOut:
            pass  # already signed out there
        except AccountError as exc:
            told = False
            log.info("account: unlink not confirmed by askeden.com (%s)", exc.status)
        self.cancel_link()
        await self.forget()
        return told

    async def push(self, body: dict[str, Any]) -> tuple[int, str]:
        """POST /push: (APNs's status, its reason) as askeden.com relayed them, or (0, why)
        when it didn't get as far as Apple."""
        try:
            response = await self.send("POST", "/push", body=body)
        except SignedOut:
            return 0, "signed out"
        except AccountError:
            return 0, "network"
        if response.status_code != 200:
            code, _words = _error_of(response)
            return 0, code or f"status {response.status_code}"
        try:
            data = response.json()
        except ValueError:
            return 0, "bad answer"
        status = data.get("status") if isinstance(data, dict) else None
        if not isinstance(status, int) or isinstance(status, bool):
            return 0, "bad answer"
        return status, str(data.get("reason") or "")[:80]

    def public(self) -> dict[str, Any]:
        """For Settings: never the token or the key."""
        link = self.link
        return {
            "linked": self.linked,
            "server": self.server,
            "account_id": self.account_id,
            "device_id": self.device_id,
            "sync_key": self.sync_key is not None,
            "link": {
                "state": link.state,
                "code": link.code,
                "url": link.url,
                "qr": link.qr,
                "seconds": self.seconds_left(),
                "error": link.error,
                "browser": link.browser,
                "page": self.link_page(),
            }
            if link is not None
            else None,
            "approval": {
                "code": self.approval.code,
                "name": self.approval.name,
                "state": self.approval.state,
                "error": self.approval.error,
            }
            if self.approval is not None
            else None,
            "info": self.info,
            "error": self.error,
        }


def _mac_name() -> str:
    from .remote import computer_name

    return computer_name()
