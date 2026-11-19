"""Share live's end-to-end encryption for links that work outside the Mac's network
(docs/eden-code-shared-sessions.md, phase 3): what the Mac pushes to askeden.com for a share's
viewers, and what a viewer sends back, sealed with a key askeden.com never has.

A share that goes through askeden.com has two random things, both made here:
- its id, 16 bytes (32 hex characters): askeden.com routes by it, so it is no secret;
- its key, 32 bytes of AES-256-GCM, in the link's fragment only
  (https://askeden.com/live/<id>#k=<key, base64url>): a browser never sends the fragment to a
  server, and the page sets no-referrer.

Each sealed blob is base64(nonce ‖ ciphertext ‖ tag), a fresh 96-bit nonce each time, with
additional data that names what it is for, so a blob can't be moved to another share, the
other direction, or another place in the order:

    eden-live-v1|<share id>|down|<seq>      the Mac's pushes, seq counting up from 1
    eden-live-v1|<share id>|up|<message id> a viewer's message, its own random id (16 hex)

The viewer's page (site/public/live/live.js) does the same with WebCrypto; the test vector in
tests/fixtures/share_seal_vector.json is checked by both sides.

A pushed blob is split into parts that fit askeden.com's 64 KiB frames (PART_CHARS each, text);
Joiner puts parts back together on the other side (the viewer's page has its own).

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import base64
import binascii
import re
import secrets
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

LABEL = "eden-live-v1"
NONCE_BYTES = 12
KEY_BYTES = 32
ID_BYTES = 16
PART_CHARS = 48 * 1024  # base64 characters of a blob in one frame (the frame's JSON around it fits 64 KiB)
MAX_PARTS = 64  # one push, at most (3 MiB of base64): a bigger snapshot is cut by the caller first
MAX_UP_CHARS = 16 * 1024  # a viewer's sealed message, at most
_SHARE_ID = re.compile(r"[0-9a-f]{32}")
_MESSAGE_ID = re.compile(r"[0-9a-f]{16,32}")


def new_share_id() -> str:
    return secrets.token_hex(ID_BYTES)


def new_key() -> bytes:
    return secrets.token_bytes(KEY_BYTES)


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def from_b64url(text: str) -> bytes | None:
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError):
        return None


def valid_share_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_SHARE_ID.fullmatch(value))


def valid_message_id(value: Any) -> bool:
    return isinstance(value, str) and bool(_MESSAGE_ID.fullmatch(value))


def aad(share_id: str, direction: str, seq: int | str) -> bytes:
    return f"{LABEL}|{share_id}|{direction}|{seq}".encode()


def seal(key: bytes, share_id: str, direction: str, seq: int | str, plaintext: bytes,
         nonce: bytes | None = None) -> str:  # fmt: skip
    """base64(nonce ‖ ciphertext ‖ tag). nonce: only a test's own (never reuse one)."""
    nonce = nonce if nonce is not None else secrets.token_bytes(NONCE_BYTES)
    sealed = AESGCM(key).encrypt(nonce, plaintext, aad(share_id, direction, seq))
    return base64.b64encode(nonce + sealed).decode()


def open_sealed(key: bytes, share_id: str, direction: str, seq: int | str, blob: Any) -> bytes | None:
    """The plaintext, or None for anything that isn't this key's blob for exactly this place
    (another share, the other direction, another seq, a changed byte, not base64)."""
    if not isinstance(blob, str) or len(blob) > PART_CHARS * MAX_PARTS:
        return None
    try:
        raw = base64.b64decode(blob, validate=True)
    except (binascii.Error, ValueError):
        return None
    if len(raw) < NONCE_BYTES + 16:
        return None
    try:
        return AESGCM(key).decrypt(raw[:NONCE_BYTES], raw[NONCE_BYTES:], aad(share_id, direction, seq))
    except (InvalidTag, ValueError):
        return None


def split(blob: str, size: int = PART_CHARS) -> list[str]:
    """A blob in parts of at most size characters (at least one part)."""
    return [blob[i : i + size] for i in range(0, len(blob), size)] or [""]


class Joiner:
    """Parts of pushes back together, by seq: a push is whole once all its parts came; a
    newer seq drops what was left of older ones (a lost part never holds the rest up)."""

    def __init__(self) -> None:
        self.seq = 0
        self.parts: dict[int, str] = {}
        self.count = 0

    def add(self, seq: int, part: int, parts: int, piece: str) -> str | None:
        if not (0 < parts <= MAX_PARTS and 0 <= part < parts) or seq < self.seq:
            return None
        if seq != self.seq:
            self.seq, self.parts, self.count = seq, {}, parts
        if parts != self.count:
            return None
        self.parts[part] = piece
        if len(self.parts) < parts:
            return None
        whole = "".join(self.parts[i] for i in range(parts))
        self.parts = {}
        self.seq += 1  # (this seq is done: a part of it again is old)
        return whole
