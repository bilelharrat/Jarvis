"""Eden sync's key on this Mac, so it can let a new browser sync Eden (docs/accounts.md, "Eden
sync" and "The J.A.R.V.I.S. apps"; ROADMAP H1).

Eden at askeden.com keeps the owner's chat history sealed with Eden's own key (32 bytes, not
the apps' sync key), which a browser gets only sealed to its own key pair, from a device that
already has it, after both screens show the same six digits. This Mac can be that device:

- It joins Eden sync once, as a member with its own X25519 key pair (the private half in the
  Keychain, connectors.Vault jarvis-account:eden_device). Eden's key reaches it sealed to that
  key by a browser that syncs ("Ask a browser that syncs": the browser shows this Mac's six
  digits, Settings shows them too), or opened here with the owner's recovery passphrase
  (PBKDF2-SHA256). It then proves it holds the key (askeden.com keeps only a hash of a proof
  the key makes) and is trusted. The key is kept in the Keychain beside it (eden_key: the key,
  its generation and the account it belongs to).
- Trusted, it sees the browsers waiting to sync, each with its six digits. The owner approves
  one only when the browser shows the same: the key is sealed to that browser's public key
  (the one the digits were made from, echoed back so askeden.com can't swap it) and sent.

The Mac never reads or writes Eden's conversations; it holds the key only to hand it on.
Crypto as eden-crypto.js does it (shared vector: companion/Tests/Fixtures/eden-sync-vector.json):

    sealed = nonce(12) ‖ AES-256-GCM(HKDF-SHA256(ECDH(sender, device), salt = "",
             info = "eden-seal-v1"), aad = "eden-seal-v1", key); sender = a fresh key pair
    proof  = base64url(HKDF-SHA256(key, salt = "", info = "eden-sync-v1-proof", 32 bytes))
    code   = six digits of SHA-256("eden-trust-v1:" + device public key, base64)
    wrap   = nonce(12) ‖ AES-256-GCM(PBKDF2-SHA256(NFKC passphrase, salt, rounds), aad = "eden-wrap-v1", key)
    mac    = base64url(HKDF-SHA256(key, salt = "", info = "eden-member-v1:<alg>:<public key>", 32 bytes))
    link   = nonce(12) ‖ AES-256-GCM(HKDF-SHA256(new key, salt = "", info = "eden-chain-v1"),
             aad = "eden-chain-v1:<gen>:<new epoch>", old key)

A browser's key may be X25519 or (a browser without it) P-256; this Mac's is always X25519.
The passphrase is used once and never kept or logged.

Removing a device in a browser changes Eden's key (a new epoch; docs "Removing a device"): the
browser seals the new key to each member it can vouch for (this Mac sends its `mac` when it
proves) and keeps the old key under the new one (the chain). Asked again, this Mac picks the
new key up (`me.rekey`), but only if the chain from it leads back to the key it has (so
askeden.com can't hand it a key of its own); left out (removed, or nobody vouched for it), it
drops the old key and asks a browser again.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import os
import time
import unicodedata
from dataclasses import dataclass
from typing import Any

from .account import (
    EDEN_DEVICE_KEY,
    EDEN_KEY,
    VAULT_ID,
    Account,
    AccountError,
    SignedOut,
    b64decode,
    b64encode,
)

log = logging.getLogger("jarvis")

SEAL_LABEL = "eden-seal-v1"
SYNC_LABEL = "eden-sync-v1"
WRAP_LABEL = "eden-wrap-v1"
TRUST_LABEL = "eden-trust-v1"
MEMBER_LABEL = "eden-member-v1"
CHAIN_LABEL = "eden-chain-v1"
POLL_SECONDS = 3.0
ASK_SECONDS = 15 * 60  # askeden.com lets a request wait this long
PUBLIC_SIZES = {"x25519": 32, "p256": 65}
NO_KEY = (
    "Eden sync isn't on for your account yet. Turn it on in Eden at askeden.com (Account › Sync)."
)
WRONG_PASSPHRASE = "That isn't the recovery passphrase. Check it and try again."
GONE = "That browser stopped waiting. Ask again from the browser."
KEY_CHANGED = "That browser's key changed. Check its code again."
NOT_TRUSTED = "This Mac doesn't have Eden's key yet."
LEFT_OUT = (
    "Eden's key changed when a device was removed from sync, and this Mac was left out. "
    "Ask a browser that syncs to approve it again."
)
FORGED = (
    "askeden.com offered a new Eden key this Mac couldn't check, so it isn't used. "
    "Stop holding the key here, then ask a browser that syncs again."
)


# ── crypto (eden-crypto.js's, with `cryptography`) ──


def _b64url(data: bytes) -> str:
    return b64encode(data).replace("+", "-").replace("/", "_").rstrip("=")


def _hkdf(ikm: bytes, info: bytes) -> bytes:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    return HKDF(hashes.SHA256(), 32, salt=None, info=info).derive(ikm)


def verify_code(public_b64: str) -> str:
    """The six digits both screens show for a device's key ("123 456")."""
    digest = hashlib.sha256(f"{TRUST_LABEL}:{public_b64}".encode()).digest()
    number = int.from_bytes(digest[:4], "big") % 1_000_000
    text = f"{number:06d}"
    return f"{text[:3]} {text[3:]}"


def proof_of(secret: bytes, label: str = SYNC_LABEL) -> str:
    """What askeden.com keeps a hash of: only a holder of the key can make it."""
    return _b64url(_hkdf(secret, f"{label}-proof".encode()))


def member_mac(secret: bytes, alg: str, public_b64: str) -> str:
    """A member's public key vouched for with the key: a key change seals the new key only to
    members with one (so askeden.com can't add a key of its own to the members)."""
    return _b64url(_hkdf(secret, f"{MEMBER_LABEL}:{alg}:{public_b64}".encode()))


def open_chain_link(new: bytes, link: str, gen: str, epoch: int) -> bytes:
    """The key before `epoch`, kept under the key of `epoch`; ValueError when it doesn't open."""
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    box = b64decode(link)
    if len(box) != 12 + 32 + 16:
        raise ValueError("The key chain is unreadable.")
    try:
        return AESGCM(_hkdf(new, CHAIN_LABEL.encode())).decrypt(
            box[:12], box[12:], f"{CHAIN_LABEL}:{gen}:{epoch}".encode()
        )
    except InvalidTag:
        raise ValueError("The key chain doesn't open with this key.") from None


def follow_rekey(
    new: bytes, epoch: int, chain: Any, gen: str, mine: bytes, from_epoch: int
) -> None:
    """Checks a key change sealed to this Mac: the chain from the new key (at `epoch`) must
    lead back to the key it has (at `from_epoch`), i.e. a holder of that key made the new one.
    ValueError when it doesn't."""
    links = {
        c.get("epoch"): c.get("prev")
        for c in (chain if isinstance(chain, list) else [])
        if isinstance(c, dict)
    }
    key = new
    for e in range(epoch, from_epoch, -1):
        if not isinstance(links.get(e), str):
            raise ValueError("The key chain is incomplete.")
        key = open_chain_link(key, links[e], gen, e)
    if epoch <= from_epoch or not hmac.compare_digest(key, mine):
        raise ValueError("The new key doesn't follow from this Mac's.")


def _public_key(alg: str, raw: bytes) -> Any:
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PublicKey

    if alg not in PUBLIC_SIZES or len(raw) != PUBLIC_SIZES[alg] or (alg == "p256" and raw[0] != 4):
        raise ValueError("That isn't a device key.")
    try:
        if alg == "x25519":
            return X25519PublicKey.from_public_bytes(raw)
        return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except ValueError:
        raise ValueError("That isn't a device key.") from None


def _raw_public(private: Any) -> bytes:
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    if isinstance(private, ec.EllipticCurvePrivateKey):
        return private.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def _shared(private: Any, public: Any) -> bytes:
    from cryptography.hazmat.primitives.asymmetric import ec

    if isinstance(private, ec.EllipticCurvePrivateKey):
        return private.exchange(ec.ECDH(), public)  # the x coordinate, as Web Crypto's deriveBits
    return private.exchange(public)


def new_private(alg: str = "x25519") -> Any:
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    return (
        X25519PrivateKey.generate() if alg == "x25519" else ec.generate_private_key(ec.SECP256R1())
    )


def private_from(alg: str, raw: bytes) -> Any:
    """A private key from its raw bytes (X25519's 32, or P-256's scalar)."""
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

    if alg == "x25519":
        return X25519PrivateKey.from_private_bytes(raw)
    return ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())


def seal_to(
    public_b64: str,
    alg: str,
    secret: bytes,
    *,
    label: str = SEAL_LABEL,
    sender: Any = None,
    nonce: bytes | None = None,
) -> dict[str, str]:
    """`secret` sealed to a device's public key: {sealed_key, sender_key, alg}. A fresh sender
    key and nonce each time, unless a test gives them."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    recipient = _public_key(alg, b64decode(public_b64))
    sender = sender if sender is not None else new_private(alg)
    nonce = nonce if nonce is not None else os.urandom(12)
    key = _hkdf(_shared(sender, recipient), label.encode())
    sealed = nonce + AESGCM(key).encrypt(nonce, secret, label.encode())
    return {
        "sealed_key": b64encode(sealed),
        "sender_key": b64encode(_raw_public(sender)),
        "alg": alg,
    }


def open_sealed(
    private: Any, alg: str, sealed_key: str, sender_key: str, label: str = SEAL_LABEL
) -> bytes:
    """What seal_to (or a browser's sealTo) made, opened; ValueError when it isn't ours."""
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    sender = _public_key(alg, b64decode(sender_key))
    box = b64decode(sealed_key)
    if len(box) < 12 + 16:
        raise ValueError("The sealed key is unreadable.")
    key = _hkdf(_shared(private, sender), label.encode())
    try:
        return AESGCM(key).decrypt(box[:12], box[12:], label.encode())
    except InvalidTag:
        raise ValueError("The sealed key didn't open with this Mac's key.") from None


def unwrap(passphrase: str, wrap: Any) -> bytes:
    """Eden's key from the recovery passphrase's wrap; ValueError("wrong passphrase") when it
    doesn't open. Slow on purpose (hundreds of thousands of rounds): run it in a thread."""
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not isinstance(wrap, dict) or wrap.get("v") != 1 or wrap.get("kdf") != "PBKDF2-SHA256":
        raise ValueError("unknown wrap")
    rounds = wrap.get("iterations")
    if (
        not isinstance(rounds, int)
        or isinstance(rounds, bool)
        or not 100_000 <= rounds <= 10_000_000
    ):
        raise ValueError("unknown wrap")
    box = b64decode(wrap.get("data"))
    words = unicodedata.normalize("NFKC", str(passphrase)).encode()
    key = hashlib.pbkdf2_hmac("sha256", words, b64decode(wrap.get("salt")), rounds, 32)
    try:
        return AESGCM(key).decrypt(box[:12], box[12:], WRAP_LABEL.encode())
    except (InvalidTag, ValueError):
        raise ValueError("wrong passphrase") from None


# ── this Mac as a member of Eden sync ──


@dataclass
class Asking:
    """This Mac's own request to be trusted, while a browser that syncs approves it."""

    code: str
    expires_at: float
    state: str = "waiting"  # waiting | joined | denied | expired | error
    error: str = ""


def _name(request: dict[str, Any]) -> str:
    name = request.get("name") if isinstance(request.get("name"), str) else ""
    name = " ".join(name.split()).removeprefix("Eden on the web: ")
    return name[:120] or "A browser"


class EdenTrust:
    """Eden sync's key on this Mac and what it does with it, over the account's token
    (POST /api/esync/<op>). For Settings: public()."""

    def __init__(
        self, account: Account, *, clock: Any = time.monotonic, sleep: Any = asyncio.sleep
    ) -> None:
        self.account = account
        self.clock = clock
        self.sleep = sleep
        self.server: dict[str, Any] | None = None  # the latest GET /esync
        self.asking: Asking | None = None
        self.done = ""  # what was done last, in words (approved, denied, joined)
        self.error = ""
        self.on_change: list[Any] = []
        self._private: Any = None
        self._secret: bytes | None = None
        self._gen = ""
        self._epoch = 1  # which of the account's keys (a new one each time a device is removed)
        self._for = ""  # the account the key is for
        self._read = False
        self._poller: asyncio.Task | None = None

    # ── what's kept ──

    @property
    def has_key(self) -> bool:
        return self._secret is not None and bool(self._for) and self._for == self.account.account_id

    @property
    def trusted(self) -> bool:
        me = (self.server or {}).get("me") or {}
        return self.has_key and me.get("trusted") is True

    async def load(self) -> None:
        if self._read:
            return
        await self.account.load()
        try:
            device, kept = await asyncio.to_thread(self._load)
        except Exception:
            log.warning("eden sync: the Keychain couldn't be read")
            return
        with contextlib.suppress(ValueError, TypeError):
            self._private = private_from("x25519", b64decode(device)) if device else None
        try:
            data = json.loads(kept) if kept else None
            secret = b64decode(data["key"]) if isinstance(data, dict) else None
            if secret is not None and len(secret) == 32:
                self._secret, self._gen, self._for = (
                    secret,
                    str(data.get("gen") or ""),
                    str(data.get("account") or ""),
                )
                epoch = data.get("epoch")
                self._epoch = epoch if isinstance(epoch, int) and epoch > 0 else 1
        except (ValueError, KeyError, TypeError):
            self._secret = None
        self._read = True

    def _load(self) -> tuple[str, str]:
        vault = self.account.vault
        return vault.get(VAULT_ID, EDEN_DEVICE_KEY) or "", vault.get(VAULT_ID, EDEN_KEY) or ""

    async def _device(self) -> Any:
        """This Mac's key pair for Eden sync, made once and kept in the Keychain."""
        await self.load()
        if self._private is None:
            from cryptography.hazmat.primitives.serialization import (
                Encoding,
                NoEncryption,
                PrivateFormat,
            )

            private = new_private("x25519")
            raw = private.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
            await asyncio.to_thread(
                self.account.vault.set, VAULT_ID, EDEN_DEVICE_KEY, b64encode(raw)
            )
            self._private = private
        return self._private

    async def _public(self) -> str:
        return b64encode(_raw_public(await self._device()))

    async def _keep(self, secret: bytes, gen: str, epoch: int = 1) -> None:
        account = self.account.account_id or ""
        record = json.dumps(
            {"account": account, "gen": gen, "key": b64encode(secret), "epoch": epoch}
        )
        await asyncio.to_thread(self.account.vault.set, VAULT_ID, EDEN_KEY, record)
        self._secret, self._gen, self._for, self._epoch = secret, gen, account, epoch

    async def _drop_key(self) -> None:
        self._secret, self._gen, self._for, self._epoch = None, "", "", 1
        with contextlib.suppress(Exception):
            await asyncio.to_thread(self.account.vault.delete, VAULT_ID, EDEN_KEY)

    def reset(self) -> None:
        """The account went (unlinked): account.forget() already took the keys out of the
        Keychain; nothing of them stays in memory either."""
        self._stop()
        self._private, self._secret, self._gen, self._for, self._epoch = None, None, "", "", 1
        self.server, self.asking, self.done, self.error, self._read = None, None, "", "", False

    def _changed(self) -> None:
        for hear in list(self.on_change):
            try:
                hear()
            except Exception:
                log.exception("eden sync: a listener failed")

    # ── askeden.com ──

    async def _op(self, op: str, body: dict[str, Any] | None = None) -> Any:
        return await self.account.call("POST", f"/esync/{op}", body=body or {})

    async def refresh(self) -> dict[str, Any] | None:
        """GET /esync, then this Mac's key squared with it: a key from before "Start over"
        (another generation) is dropped; a new key sealed to this Mac after a device was
        removed is picked up when it checks out (and the Mac left out drops the old one); a key
        this device id isn't trusted with yet (the Mac linked again) is proved again."""
        await self.load()
        if not self.account.linked:
            self.server = None
            return None
        try:
            data = await self.account.call("GET", "/esync")
        except SignedOut:
            return None
        except AccountError as exc:
            self.error = exc.message
            return self.server
        if not isinstance(data, dict):
            return self.server
        self.server, self.error = data, ""
        key = data.get("key") if isinstance(data.get("key"), dict) else None
        me = data.get("me") if isinstance(data.get("me"), dict) else {}
        epoch = key.get("epoch") if key else None
        epoch = epoch if isinstance(epoch, int) and epoch > 0 else 1
        if self._secret is not None and (
            not self.has_key or not key or key.get("gen") != self._gen
        ):
            log.info(
                "eden sync: this Mac's key is from before (another account or a new start); dropped"
            )
            await self._drop_key()
        elif self.has_key and epoch > self._epoch:
            await self._key_changed(data, me, epoch)
        elif self.has_key and not me.get("trusted"):
            try:
                await self._prove("approved")
                self.server = await self.account.call("GET", "/esync")
            except AccountError as exc:
                if exc.status == 403 and exc.code == "wrong_key":
                    await self._drop_key()  # not the key of now: removed while signed out
                self.error = exc.message
        elif self.has_key and not me.get("mac"):
            # Trusted before members vouched for themselves: now, so a key change includes it.
            with contextlib.suppress(AccountError):
                await self._prove("approved")
        return self.server

    async def _key_changed(self, data: dict[str, Any], me: dict[str, Any], epoch: int) -> None:
        """A device was removed and Eden's key changed (`epoch`): the new key sealed to this
        Mac is taken only if the chain from it leads back to the key it has."""
        rekey = me.get("rekey") if isinstance(me.get("rekey"), dict) else None
        if not me.get("trusted") or not rekey or rekey.get("epoch") != epoch:
            log.info("eden sync: the key changed and this Mac was left out; dropped")
            await self._drop_key()
            self.error = LEFT_OUT
            return
        assert self._secret is not None
        try:
            if rekey.get("alg", "x25519") != "x25519":
                raise ValueError("not this Mac's kind of key")
            new = open_sealed(
                await self._device(), "x25519", rekey.get("sealed_key"), rekey.get("sender_key")
            )
            follow_rekey(new, epoch, data.get("chain"), self._gen, self._secret, self._epoch)
        except (ValueError, TypeError) as exc:
            log.warning("eden sync: a new key didn't check out (%s); not used", exc)
            self.error = FORGED
            return
        old = (self._secret, self._epoch)
        self._secret = new
        try:
            await self._prove("approved")
        except AccountError as exc:
            self._secret, self._epoch = old
            self.error = exc.message
            return
        await self._keep(new, self._gen, epoch)
        log.info("eden sync: this Mac picked up Eden's new key")
        with contextlib.suppress(AccountError, SignedOut):
            self.server = await self.account.call("GET", "/esync")

    async def _prove(self, via: str) -> int:
        """Proves the key (and vouches for this Mac's public key with it); the key's epoch."""
        assert self._secret is not None
        public = await self._public()
        got = await self._op(
            "prove",
            {
                "proof": proof_of(self._secret),
                "public_key": public,
                "alg": "x25519",
                "via": via,
                "mac": member_mac(self._secret, "x25519", public),
            },
        )
        epoch = got.get("epoch") if isinstance(got, dict) else None
        return epoch if isinstance(epoch, int) and epoch > 0 else 1

    # ── joining ──

    async def ask(self) -> Asking:
        """Ask a browser that syncs for Eden's key: this Mac's public key goes to askeden.com,
        and its six digits are shown until a browser approves (polled here), says no, or 15
        minutes pass."""
        self._stop()
        public = await self._public()
        await self._op("request", {"public_key": public, "alg": "x25519"})
        self.asking = Asking(verify_code(public), self.clock() + ASK_SECONDS)
        self.done = ""
        self._poller = asyncio.get_running_loop().create_task(self._poll(self.asking))
        self._changed()
        return self.asking

    def _stop(self) -> None:
        if self._poller is not None and not self._poller.done():
            self._poller.cancel()
        self._poller = None

    async def cancel(self) -> None:
        """Stops asking (askeden.com forgets the request)."""
        self._stop()
        self.asking = None
        with contextlib.suppress(AccountError):
            await self._op("deny")
        self._changed()

    async def _poll(self, asking: Asking) -> None:
        try:
            while asking.state == "waiting" and self.asking is asking:
                await self.sleep(POLL_SECONDS)
                if self.asking is not asking:
                    return
                if self.clock() >= asking.expires_at:
                    asking.state = "expired"
                    break
                try:
                    got = await self._op("poll")
                except SignedOut:
                    asking.state = "error"
                    break
                except AccountError as exc:
                    if exc.status == 410:
                        asking.state = "expired"
                    elif exc.status and exc.status < 500 and exc.status != 429:
                        asking.state, asking.error = "error", exc.message
                    continue
                status = got.get("status") if isinstance(got, dict) else None
                if status == "denied":
                    asking.state = "denied"
                elif status == "approved":
                    await self._joined(asking, got)
        finally:
            if self.asking is asking:
                self._changed()

    async def _joined(self, asking: Asking, got: dict[str, Any]) -> None:
        try:
            if got.get("alg") != "x25519":
                raise ValueError("not this Mac's kind of key")
            secret = open_sealed(
                await self._device(), "x25519", got.get("sealed_key"), got.get("sender_key")
            )
            if len(secret) != 32:
                raise ValueError("the key is the wrong size")
        except ValueError as exc:
            log.warning("eden sync: the approved key didn't open (%s)", exc)
            asking.state, asking.error = (
                "error",
                "The key that came didn't open with this Mac's. Ask again.",
            )
            return
        self._secret, self._for = secret, self.account.account_id or ""
        try:
            epoch = await self._prove("approved")
            status = await self.account.call("GET", "/esync")
            await self._keep(secret, str(((status or {}).get("key") or {}).get("gen") or ""), epoch)
        except AccountError as exc:
            self._secret, self._for = None, ""
            asking.state, asking.error = "error", exc.message
            return
        by = got.get("by") if isinstance(got.get("by"), str) else ""
        asking.state = "joined"
        self.done = (
            f"This Mac has Eden's key now (from {_name({'name': by})})."
            if by
            else "This Mac has Eden's key now."
        )
        log.info("eden sync: this Mac joined (approved)")
        await self.refresh()

    async def unlock(self, passphrase: Any) -> None:
        """Eden's key from the recovery passphrase (askeden.com keeps it wrapped), then
        proved. AccountError with words for the owner when it doesn't open."""
        if not isinstance(passphrase, str) or not passphrase or len(passphrase) > 1000:
            raise AccountError(400, "bad_passphrase", WRONG_PASSPHRASE)
        got = await self._op("unwrap")
        if not isinstance(got, dict):
            raise AccountError(200, "bad_answer", "askeden.com's answer couldn't be read.")
        try:
            secret = await asyncio.to_thread(unwrap, passphrase, got.get("wrap"))
        except ValueError:
            raise AccountError(403, "wrong_passphrase", WRONG_PASSPHRASE) from None
        self._stop()
        self.asking = None
        self._secret, self._for = secret, self.account.account_id or ""
        try:
            epoch = await self._prove("passphrase")
        except AccountError:
            self._secret, self._for = None, ""
            raise
        await self._keep(secret, str(got.get("gen") or ""), epoch)
        self.done = "This Mac has Eden's key now."
        log.info("eden sync: this Mac joined (recovery passphrase)")
        await self.refresh()
        self._changed()

    async def forget(self) -> None:
        """Stops being a member: askeden.com untrusts this Mac, and its key goes."""
        self._stop()
        self.asking = None
        with contextlib.suppress(AccountError):
            await self._op("untrust")
        await self._drop_key()
        self.done = "This Mac no longer has Eden's key."
        await self.refresh()
        self._changed()

    # ── approving a browser ──

    def _waiting(self, device_id: Any) -> dict[str, Any] | None:
        for request in (self.server or {}).get("requests") or []:
            if (
                isinstance(request, dict)
                and request.get("device_id") == device_id
                and request.get("status") == "waiting"
            ):
                return request
        return None

    async def approve(self, device_id: Any, public_key: Any) -> None:
        """Seals Eden's key to the browser whose code the owner checked (public_key: the key
        those digits were made from), after asking askeden.com again what's waiting."""
        await self.refresh()
        if not self.trusted or self._secret is None:
            raise AccountError(403, "not_trusted", NOT_TRUSTED)
        request = self._waiting(device_id)
        if request is None:
            raise AccountError(404, "not_found", GONE)
        if request.get("public_key") != public_key:
            raise AccountError(409, "conflict", KEY_CHANGED)
        try:
            sealed = seal_to(request["public_key"], str(request.get("alg") or ""), self._secret)
        except ValueError as exc:
            raise AccountError(400, "bad_key", str(exc)) from None
        await self._op(
            "approve",
            {
                "device_id": request["device_id"],
                "public_key": request["public_key"],
                "sealed_key": sealed["sealed_key"],
                "sender_key": sealed["sender_key"],
                # vouches for the key whose code matched, for a later key change
                "mac": member_mac(
                    self._secret, str(request.get("alg") or ""), request["public_key"]
                ),
            },
        )
        self.done = f"Approved. {_name(request)} syncs Eden now."
        log.info("eden sync: a browser was approved from this Mac")
        await self.refresh()
        self._changed()

    async def deny(self, device_id: Any) -> None:
        request = self._waiting(device_id)
        await self._op("deny", {"device_id": device_id})
        self.done = f"Turned down. {_name(request or {})} doesn't get Eden's key."
        await self.refresh()
        self._changed()

    # ── for Settings ──

    def state(self) -> str:
        """off (no Eden sync on the account) | locked (this Mac hasn't the key) | asking | on
        | unknown (not asked yet, or askeden.com couldn't be reached)."""
        if self.server is None:
            return "unknown"
        if not self.server.get("key"):
            return "off"
        if self.trusted:
            return "on"
        if self.asking is not None and self.asking.state == "waiting":
            return "asking"
        return "locked"

    def public(self) -> dict[str, Any]:
        """Never the key, the passphrase or the private key."""
        server = self.server or {}
        asking = self.asking
        state = self.state()
        return {
            "state": state,
            "wrap": bool((server.get("key") or {}).get("wrap"))
            if isinstance(server.get("key"), dict)
            else False,
            "asking": {"code": asking.code, "state": asking.state, "error": asking.error}
            if asking
            else None,
            "requests": [
                {
                    "device_id": r.get("device_id"),
                    "name": _name(r),
                    "kind": r.get("kind") or "web",
                    "public_key": r.get("public_key"),
                    "code": verify_code(str(r.get("public_key") or "")),
                    "expires": r.get("expires"),
                }
                for r in (server.get("requests") or [])
                if isinstance(r, dict) and r.get("status") == "waiting" and state == "on"
            ],
            "trusted": [
                {"name": _name(t), "kind": t.get("kind") or "", "this": bool(t.get("this"))}
                for t in (server.get("trusted") or [])
                if isinstance(t, dict)
            ],
            "done": self.done,
            "error": self.error,
        }

    async def aclose(self) -> None:
        if self._poller is not None:
            self._poller.cancel()
            with contextlib.suppress(BaseException):
                await self._poller
            self._poller = None
