"""Who is calling: an Eden account, by the short-lived Eden Cloud token askeden.com signs.

Why not the Mac's own device token (jv1.…): that one is the whole account (its relay, its
sync, its plan) and the contract says it goes to askeden.com alone (docs/accounts.md,
Credentials). So the Mac trades it there, at POST /api/cloud/token, for a token that is good
for this service only, for ten minutes: a compact JWS (EdDSA, Ed25519) whose claims are

    { "iss": "askeden.com", "aud": "eden-cloud", "sub": "<account id>", "dev": "<device id>",
      "kind": "mac", "plan": "plus" | "free", "iat": s, "exp": s, "jti": "<16 hex>" }

checked here with askeden.com's public key alone (no call back to askeden.com per request, no
shared secret). A stolen one is good for minutes, for this service, for that account's runs.

Development: EDEN_CLOUD_DEV_TOKENS maps fixed tokens to accounts (plan "plus"), refused in
production (config.Settings.problems).
"""

from __future__ import annotations

import base64
import hmac
import json
import re
import time
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

AUDIENCE = "eden-cloud"
MAX_LIFETIME = 15 * 60  # seconds a token may be good for, whatever it says
SKEW = 60  # seconds of clock difference forgiven
ACCOUNT = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class AuthError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


@dataclass(frozen=True)
class User:
    account: str
    device: str
    plan: str


def _b64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class Verifier:
    def __init__(
        self,
        public_key: str = "",
        issuer: str = "askeden.com",
        dev_tokens: dict[str, str] | None = None,
        clock=time.time,
    ) -> None:
        self.key = (
            Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key)) if public_key else None
        )
        self.issuer = issuer
        self.dev_tokens = dict(dev_tokens or {})
        self.clock = clock

    def verify(self, header: str) -> User:
        match = re.match(r"^Bearer\s+(\S+)$", header or "", re.I)
        if not match:
            raise AuthError(401, "signed_out", "Sign in to your Eden account on this Mac first.")
        token = match.group(1)
        for known, account in self.dev_tokens.items():
            if hmac.compare_digest(known, token):
                return User(account=account.lower(), device="dev", plan="plus")
        if token.startswith("jv1."):
            raise AuthError(
                401, "wrong_token", "That's a device token: trade it at askeden.com first."
            )
        if self.key is None:
            raise AuthError(503, "not_set_up", "This Eden Cloud has no askeden.com key yet.")
        parts = token.split(".")
        if len(parts) != 3 or len(token) > 4096:
            raise AuthError(401, "signed_out", "That isn't an Eden Cloud token.")
        try:
            head = json.loads(_b64url(parts[0]))
            claims = json.loads(_b64url(parts[1]))
            signature = _b64url(parts[2])
        except (ValueError, TypeError):
            raise AuthError(401, "signed_out", "That isn't an Eden Cloud token.") from None
        if not isinstance(head, dict) or head.get("alg") != "EdDSA" or not isinstance(claims, dict):
            raise AuthError(401, "signed_out", "That isn't an Eden Cloud token.")
        try:
            self.key.verify(signature, f"{parts[0]}.{parts[1]}".encode())
        except InvalidSignature:
            raise AuthError(401, "signed_out", "That token wasn't signed by askeden.com.") from None
        now = self.clock()
        try:
            iat, exp = float(claims["iat"]), float(claims["exp"])
        except (KeyError, TypeError, ValueError):
            raise AuthError(401, "signed_out", "That token has no time on it.") from None
        if claims.get("iss") != self.issuer or claims.get("aud") != AUDIENCE:
            raise AuthError(401, "signed_out", "That token isn't for Eden Cloud.")
        if exp < now - SKEW or iat > now + SKEW or exp - iat > MAX_LIFETIME:
            raise AuthError(401, "expired", "That token expired: ask askeden.com for a new one.")
        account = str(claims.get("sub") or "").lower()
        if not ACCOUNT.match(account):
            raise AuthError(401, "signed_out", "That token names no account.")
        if claims.get("kind") != "mac":
            raise AuthError(403, "forbidden", "Eden Cloud runs start from Eden Code on a Mac.")
        plan = "plus" if claims.get("plan") == "plus" else "free"
        return User(account=account, device=str(claims.get("dev") or "")[:32], plan=plan)
