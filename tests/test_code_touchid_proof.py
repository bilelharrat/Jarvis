"""The Touch ID proof (S30): the app's main process signs macOS's yes under the backend's token
(app/features/touchid.js makeProof); the backend checks it: its kind, its time, its signature,
and once only. The proofs here are made the same way as touchid.js makes them."""

import hashlib
import hmac

from jarvis.features import code_touchid

TOKEN = "ab" * 24


def proof(
    kind="bypass",
    expires_ms=None,
    nonce="0123456789abcdef0123456789abcdef",
    token=TOKEN,
    now=1_800_000_000.0,
):
    expires_ms = int((now + 120) * 1000) if expires_ms is None else expires_ms
    mac = hmac.new(
        token.encode(), f"eden-touchid|v1|{kind}|{expires_ms}|{nonce}".encode(), hashlib.sha256
    ).hexdigest()
    return f"v1.{kind}.{expires_ms}.{nonce}.{mac}"


def test_a_proof_from_the_main_process_holds_once_for_its_kind_until_it_expires():
    now = 1_800_000_000.0
    good = proof(nonce="a" * 32, now=now)
    assert code_touchid.check_proof(TOKEN, good, "bypass", now=now)
    assert not code_touchid.check_proof(TOKEN, good, "bypass", now=now), "once only"
    fresh = proof(nonce="b" * 32, now=now)
    assert not code_touchid.check_proof(TOKEN, fresh, "approve", now=now), "another kind"
    assert not code_touchid.check_proof("cd" * 24, fresh, "bypass", now=now), (
        "another backend's token"
    )
    assert not code_touchid.check_proof(TOKEN, fresh, "bypass", now=now + 121), "expired"
    assert not code_touchid.check_proof(
        TOKEN,
        proof(nonce="c" * 32, expires_ms=int((now + 3600) * 1000), now=now),
        "bypass",
        now=now,
    ), "too far ahead"
    assert not code_touchid.check_proof(TOKEN, fresh.replace("v1.", "v2."), "bypass", now=now)
    assert not code_touchid.check_proof("", fresh, "bypass", now=now)
    assert not code_touchid.check_proof(TOKEN, "yes", "bypass", now=now)
    assert code_touchid.check_proof(TOKEN, fresh, "bypass", now=now)
