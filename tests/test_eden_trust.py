"""Eden sync's key on the Mac (jarvis.eden_trust, Settings' account_esync_* commands): joining
as a member (a browser that syncs approves this Mac, or the recovery passphrase), then
approving a browser after the owner compared six digits. The crypto is checked against the
vector made with the browser's own eden-crypto.js (companion/Tests/Fixtures/
eden-sync-vector.json, shared with the iPhone's tests). askeden.com is a fake that keeps
eden-sync.js's rules (FakeEdenSync, an httpx MockTransport): never the network."""

import asyncio
import base64
import hashlib
import json
from pathlib import Path

import httpx
import pytest
from account_fakes import ACCOUNT_ID, DEVICE_ID, TOKEN, FakeAskeden
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from test_account import client, instant, setup  # noqa: F401  (setup: the hub fixture)
from test_hub import drain

from jarvis import eden_trust as T
from jarvis.account import EDEN_DEVICE_KEY, EDEN_KEY, VAULT_ID
from jarvis.connectors import MemoryVault

VECTOR = json.loads(
    (
        Path(__file__).resolve().parents[1]
        / "companion"
        / "Tests"
        / "Fixtures"
        / "eden-sync-vector.json"
    ).read_text()
)
b = base64.b64decode
BROWSER = "c0ffee00c0ffee00"
NEW_BROWSER = "beef0000beef0000"
PASSPHRASE = "a long recovery passphrase"


# ── the shared vector (eden-crypto.js's own output) ──


@pytest.mark.parametrize("alg", ["x25519", "p256"])
def test_what_a_browser_sealed_opens_here(alg):
    v = VECTOR[alg]
    me = T.private_from(alg, b(v["private"]))
    assert base64.b64encode(T._raw_public(me)).decode() == v["public"]
    sealed = v["browser_sealed"]
    assert T.open_sealed(me, alg, sealed["sealed_key"], sealed["sender_key"]) == b(VECTOR["secret"])
    # Another label (a team space's key) doesn't open as Eden's key.
    with pytest.raises(ValueError):
        T.open_sealed(
            me, alg, sealed["sealed_key"], sealed["sender_key"], label="eden-space-seal-v1"
        )


@pytest.mark.parametrize("alg", ["x25519", "p256"])
def test_the_mac_seals_the_browsers_bytes_exactly(alg):
    v = VECTOR[alg]
    app = v["app_sealed"]
    sender = T.private_from(alg, b(app["sender_private"]))
    out = T.seal_to(v["public"], alg, b(VECTOR["secret"]), sender=sender, nonce=b(app["nonce"]))
    assert (out["sealed_key"], out["sender_key"], out["alg"]) == (
        app["sealed_key"],
        app["sender_key"],
        alg,
    )


def test_codes_proof_and_passphrase_match_the_browser():
    for alg in ("x25519", "p256"):
        assert T.verify_code(VECTOR[alg]["public"]) == VECTOR[alg]["code"]
    assert T.proof_of(b(VECTOR["secret"])) == VECTOR["proof"]
    p = VECTOR["passphrase"]
    assert T.unwrap(p["passphrase"], p["wrap"]) == b(VECTOR["secret"])  # NFKC, as the browser
    with pytest.raises(ValueError, match="wrong passphrase"):
        T.unwrap(p["passphrase"] + "!", p["wrap"])
    with pytest.raises(ValueError, match="unknown wrap"):
        T.unwrap(p["passphrase"], {**p["wrap"], "iterations": 1000})


def test_a_key_changes_macs_and_chain_match_the_browser():
    rot = VECTOR["rotation"]
    secret, new = b(VECTOR["secret"]), b(rot["next"])
    for alg in ("x25519", "p256"):
        assert T.member_mac(secret, alg, VECTOR[alg]["public"]) == rot["mac"][alg]
    assert T.member_mac(new, "x25519", VECTOR["x25519"]["public"]) == rot["next_mac"]["x25519"]
    [link] = rot["chain"]
    assert T.open_chain_link(new, link["prev"], rot["gen"], 2) == secret
    T.follow_rekey(new, 2, rot["chain"], rot["gen"], secret, 1)  # leads back: fine
    with pytest.raises(ValueError, match="doesn't open"):
        T.open_chain_link(new, link["prev"], "gen-another1", 2)
    with pytest.raises(ValueError):
        T.follow_rekey(bytes(32), 2, rot["chain"], rot["gen"], secret, 1)  # a made-up key
    with pytest.raises(ValueError, match="doesn't follow"):
        T.follow_rekey(new, 2, rot["chain"], rot["gen"], bytes(32), 1)  # not the key it has
    with pytest.raises(ValueError, match="incomplete"):
        T.follow_rekey(new, 2, [], rot["gen"], secret, 1)


def test_a_key_that_isnt_a_device_key_is_refused():
    with pytest.raises(ValueError, match="device key"):
        T.seal_to("c2hvcnQ=", "x25519", b"k" * 32)
    with pytest.raises(ValueError, match="device key"):
        T.seal_to(VECTOR["x25519"]["public"], "p256", b"k" * 32)


# ── a fake askeden.com that keeps eden-sync.js's rules ──


def wrap_of(secret, passphrase=PASSPHRASE, rounds=100_000):
    salt, nonce = b"s" * 16, b"n" * 12
    key = hashlib.pbkdf2_hmac("sha256", passphrase.encode(), salt, rounds, 32)
    data = nonce + AESGCM(key).encrypt(nonce, secret, b"eden-wrap-v1")
    return {
        "v": 1,
        "kdf": "PBKDF2-SHA256",
        "iterations": rounds,
        "salt": base64.b64encode(salt).decode(),
        "data": base64.b64encode(data).decode(),
    }


class FakeEdenSync:
    """/api/esync[/<op>] for this Mac's token (DEVICE_ID); browsers act through methods of
    their own. Anything else goes to FakeAskeden (the account, linking)."""

    def __init__(self, inner=None):
        self.inner = inner or FakeAskeden()
        self.devices = {DEVICE_ID: {"name": "Studio", "kind": "mac"}}
        self.meta = None  # {gen, proof_hash, wrap}
        self.trust = {}  # device id -> {public_key, alg, via}
        self.requests = {}  # device id -> request
        self.calls = []
        self.transport = httpx.MockTransport(self.handle)

    # what browsers do
    def turn_on(self, secret, gen="gen-abcdef12", by=BROWSER, wrap=True):
        self.devices[by] = {"name": "Eden on the web: Chrome on a Mac", "kind": "web"}
        self.meta = {
            "gen": gen,
            "proof_hash": hashlib.sha256(T.proof_of(secret).encode()).hexdigest(),
            "wrap": wrap_of(secret) if wrap else None,
            "epoch": 1,
            "chain": [],
        }
        self.trust[by] = {"public_key": "x", "alg": "x25519", "via": "created", "epoch": 1}

    def remove_a_device(self, old, new, seal_to_mac=True, link=None):
        """What a browser's removeDevice does (eden-crypto.js planRotation): the next epoch, the
        old key under the new one, and the new key sealed to this Mac if its mac checks out."""
        epoch = self.meta["epoch"] + 1
        nonce = b"c" * 12
        box = AESGCM(T._hkdf(new, b"eden-chain-v1")).encrypt(
            nonce, old, f"eden-chain-v1:{self.meta['gen']}:{epoch}".encode()
        )
        self.meta.update(
            epoch=epoch,
            proof_hash=hashlib.sha256(T.proof_of(new).encode()).hexdigest(),
            chain=[
                *self.meta["chain"],
                {"epoch": epoch, "prev": link or base64.b64encode(nonce + box).decode()},
            ],
            wrap=None,
        )
        mine = self.trust.get(DEVICE_ID)
        if (
            mine
            and seal_to_mac
            and mine.get("mac") == T.member_mac(old, "x25519", mine["public_key"])
        ):
            mine["rekey"] = {"epoch": epoch, **T.seal_to(mine["public_key"], "x25519", new)}
            mine["mac"] = T.member_mac(new, "x25519", mine["public_key"])
        else:
            self.trust.pop(DEVICE_ID, None)

    def browser_asks(
        self, device=NEW_BROWSER, alg="p256", name="Eden on the web: Safari on an iPhone"
    ):
        private = T.new_private(alg)
        public = base64.b64encode(T._raw_public(private)).decode()
        self.devices[device] = {"name": name, "kind": "web"}
        self.requests[device] = {
            "device_id": device,
            "name": name,
            "kind": "web",
            "public_key": public,
            "alg": alg,
            "created": 1,
            "expires": 2**53,
            "status": "waiting",
        }
        return private, public

    def browser_approves(self, device_id, secret):
        r = self.requests[device_id]
        r.update(
            T.seal_to(r["public_key"], r["alg"], secret),
            status="approved",
            by_name="Eden on the web: Chrome on a Mac",
        )

    # the API
    def handle(self, request):
        path = request.url.path.removeprefix("/api")
        if not path.startswith("/esync"):
            return self.inner.handle(request)
        body = json.loads(request.content) if request.content else {}
        self.calls.append((request.method, path, body))
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401, json={"error": "Signed out.", "code": "signed_out"})
        op = path.removeprefix("/esync").lstrip("/")
        try:
            return httpx.Response(200, json=getattr(self, f"op_{op or 'status'}")(body))
        except Refused as no:
            return httpx.Response(no.status, json={"error": no.words, "code": no.code})

    def _trusted(self):
        if not self.meta:
            raise Refused(409, "no_key", "Sync isn’t turned on for this account yet.")
        if DEVICE_ID not in self.trust:
            raise Refused(403, "not_trusted", "Not trusted.")

    def op_status(self, _body):
        me = DEVICE_ID in self.trust
        mine = self.requests.get(DEVICE_ID)
        t = self.trust.get(DEVICE_ID) or {}
        return {
            "key": {
                "gen": self.meta["gen"],
                "wrap": bool(self.meta["wrap"]),
                "iterations": 100_000,
                "epoch": self.meta["epoch"],
            }
            if self.meta
            else None,
            "me": {
                "device_id": DEVICE_ID,
                "trusted": me,
                "request": mine,
                "epoch": t.get("epoch", 1) if me else None,
                "mac": bool(t.get("mac")),
                "rekey": t.get("rekey"),
            },
            "chain": self.meta["chain"] if me and self.meta else [],
            "trusted": [
                {
                    "device_id": d,
                    "name": self.devices[d]["name"],
                    "kind": self.devices[d]["kind"],
                    "this": d == DEVICE_ID,
                    **t,
                }
                for d, t in self.trust.items()
            ],
            "requests": [r for r in self.requests.values() if r["status"] == "waiting"]
            if me
            else [],
        }

    def op_request(self, body):
        if not self.meta:
            raise Refused(409, "no_key", "Sync isn’t turned on for this account yet.")
        self.requests[DEVICE_ID] = {
            "device_id": DEVICE_ID,
            "name": "Studio",
            "kind": "mac",
            "public_key": body["public_key"],
            "alg": body["alg"],
            "status": "waiting",
            "expires": 2**53,
        }
        return self.requests[DEVICE_ID]

    def op_poll(self, _body):
        r = self.requests.get(DEVICE_ID)
        if r is None:
            raise Refused(410, "expired", "That request ran out. Ask again.")
        if r["status"] == "denied":
            del self.requests[DEVICE_ID]
            return {"status": "denied"}
        if r["status"] != "approved":
            return {"status": "waiting"}
        return {
            "status": "approved",
            "sealed_key": r["sealed_key"],
            "sender_key": r["sender_key"],
            "alg": r["alg"],
            "by": r["by_name"],
        }

    def op_prove(self, body):
        if hashlib.sha256(body["proof"].encode()).hexdigest() != self.meta["proof_hash"]:
            raise Refused(403, "wrong_key", "That isn’t this account’s sync key.")
        was = self.trust.get(DEVICE_ID) or {}
        same = was.get("public_key") == body["public_key"]
        self.trust[DEVICE_ID] = {
            "public_key": body["public_key"],
            "alg": body["alg"],
            "via": was["via"] if same else body.get("via"),
            "epoch": self.meta["epoch"],
            "mac": body.get("mac") or (was.get("mac") if same else None),
        }
        self.requests.pop(DEVICE_ID, None)
        return {"trusted": True, "epoch": self.meta["epoch"]}

    def op_unwrap(self, _body):
        if not self.meta or not self.meta["wrap"]:
            raise Refused(404, "no_wrap", "There’s no recovery passphrase on this account.")
        return {"gen": self.meta["gen"], "wrap": self.meta["wrap"]}

    def op_approve(self, body):
        self._trusted()
        r = self.requests.get(body["device_id"])
        if not r or r["status"] != "waiting":
            raise Refused(404, "not_found", "That request is gone.")
        if r["public_key"] != body["public_key"]:
            raise Refused(409, "conflict", "That browser’s key changed.")
        if self.trust[DEVICE_ID].get("epoch", 1) != self.meta["epoch"]:
            raise Refused(409, "stale_key", "This device has Eden’s key from before.")
        r.update(
            status="approved",
            sealed_key=body["sealed_key"],
            sender_key=body["sender_key"],
            mac=body.get("mac"),
            by_name="Studio",
        )
        return {"approved": True}

    def op_deny(self, body):
        device = body.get("device_id") or DEVICE_ID
        if device != DEVICE_ID:
            self._trusted()
            self.requests[device]["status"] = "denied"
        else:
            self.requests.pop(device, None)
        return {"denied": True}

    def op_untrust(self, body):
        self.trust.pop(body.get("device_id") or DEVICE_ID, None)
        return {"untrusted": True}


class Refused(Exception):
    def __init__(self, status, code, words):
        super().__init__(words)
        self.status, self.code, self.words = status, code, words


async def member(fake, vault=None):
    made = client(fake, vault)
    await made._keep(TOKEN, None)
    trust = T.EdenTrust(made, sleep=instant)
    return made, trust


async def finish(trust):
    if trust._poller is not None:
        await asyncio.wait_for(trust._poller, 5)


SECRET = bytes(range(100, 132))


# ── joining ──


async def test_a_browser_that_syncs_approves_the_mac_which_keeps_the_key_and_is_trusted():
    fake = FakeEdenSync()
    fake.turn_on(SECRET)
    vault = MemoryVault()
    made, trust = await member(fake, vault)
    await trust.refresh()
    assert trust.state() == "locked"
    asking = await trust.ask()
    assert trust.state() == "asking"
    request = fake.requests[DEVICE_ID]
    # The browser shows the same six digits for this Mac's key as Settings does.
    assert asking.code == T.verify_code(request["public_key"])
    assert request["alg"] == "x25519"
    fake.browser_approves(DEVICE_ID, SECRET)
    await finish(trust)
    assert asking.state == "joined" and trust.state() == "on"
    assert fake.trust[DEVICE_ID]["via"] == "approved"
    kept = json.loads(vault.get(VAULT_ID, EDEN_KEY))
    assert kept == {
        "account": ACCOUNT_ID,
        "gen": "gen-abcdef12",
        "key": base64.b64encode(SECRET).decode(),
        "epoch": 1,
    }
    assert vault.get(VAULT_ID, EDEN_DEVICE_KEY)
    # Nothing secret reaches the window.
    shown = json.dumps(trust.public())
    assert kept["key"] not in shown and vault.get(VAULT_ID, EDEN_DEVICE_KEY) not in shown
    await made.aclose()


async def test_turned_down_or_cancelled_the_mac_has_no_key():
    fake = FakeEdenSync()
    fake.turn_on(SECRET)
    made, trust = await member(fake)
    await trust.refresh()
    asking = await trust.ask()
    fake.requests[DEVICE_ID]["status"] = "denied"
    await finish(trust)
    assert asking.state == "denied" and not trust.has_key
    await trust.ask()
    await trust.cancel()
    assert DEVICE_ID not in fake.requests and trust.asking is None
    await made.aclose()


async def test_the_recovery_passphrase_unlocks_the_mac_and_a_wrong_one_says_so():
    fake = FakeEdenSync()
    fake.turn_on(SECRET)
    made, trust = await member(fake)
    await trust.refresh()
    with pytest.raises(T.AccountError, match="isn't the recovery passphrase"):
        await trust.unlock("not the passphrase at all")
    assert DEVICE_ID not in fake.trust
    await trust.unlock(PASSPHRASE)
    assert trust.state() == "on" and fake.trust[DEVICE_ID]["via"] == "passphrase"
    assert not any(PASSPHRASE in json.dumps(c) for c in fake.calls), "the passphrase never leaves"
    await made.aclose()


async def test_with_eden_sync_off_there_is_nothing_to_join():
    fake = FakeEdenSync()
    made, trust = await member(fake)
    await trust.refresh()
    assert trust.state() == "off"
    with pytest.raises(T.AccountError, match="isn’t turned on"):
        await trust.ask()
    await made.aclose()


async def test_linked_again_the_mac_proves_its_key_and_a_new_start_drops_it():
    fake = FakeEdenSync()
    fake.turn_on(SECRET)
    vault = MemoryVault()
    made, trust = await member(fake, vault)
    await trust.unlock(PASSPHRASE)
    fake.trust.pop(DEVICE_ID)  # as for a new device id
    again = T.EdenTrust(made, sleep=instant)
    await again.refresh()
    assert again.state() == "on" and fake.trust[DEVICE_ID]["via"] == "approved"
    fake.turn_on(bytes(32), gen="gen-another1")  # "Start over" in a browser
    fake.trust.pop(DEVICE_ID)
    await again.refresh()
    assert not again.has_key and vault.get(VAULT_ID, EDEN_KEY) is None and again.state() == "locked"
    await made.aclose()


async def test_unlinking_the_mac_takes_eden_syncs_keys_out_of_the_keychain():
    fake = FakeEdenSync()
    fake.turn_on(SECRET)
    vault = MemoryVault()
    made, trust = await member(fake, vault)
    await trust.unlock(PASSPHRASE)
    await made.forget()
    trust.reset()
    assert vault.get(VAULT_ID, EDEN_KEY) is None and vault.get(VAULT_ID, EDEN_DEVICE_KEY) is None
    assert not trust.has_key and trust.state() == "unknown"


# ── approving a browser ──


async def test_the_mac_approves_a_browser_whose_code_matched_and_only_that_key_opens_it():
    fake = FakeEdenSync()
    fake.turn_on(SECRET)
    made, trust = await member(fake)
    await trust.unlock(PASSPHRASE)
    private, public = fake.browser_asks()
    await trust.refresh()
    [shown] = trust.public()["requests"]
    assert shown == {
        "device_id": NEW_BROWSER,
        "name": "Safari on an iPhone",
        "kind": "web",
        "public_key": public,
        "code": T.verify_code(public),
        "expires": 2**53,
    }
    await trust.approve(NEW_BROWSER, public)
    r = fake.requests[NEW_BROWSER]
    assert r["status"] == "approved"
    # What the browser does with it (eden-crypto.js openSealed, P-256 here).
    assert T.open_sealed(private, "p256", r["sealed_key"], r["sender_key"]) == SECRET
    assert "Safari on an iPhone" in trust.done
    await made.aclose()


async def test_a_swapped_key_or_a_request_gone_is_never_sealed_to():
    fake = FakeEdenSync()
    fake.turn_on(SECRET)
    made, trust = await member(fake)
    await trust.unlock(PASSPHRASE)
    _private, public = fake.browser_asks()
    await trust.refresh()
    _other, swapped = (
        fake.browser_asks()
    )  # askeden.com shows another key than the code was made from
    with pytest.raises(T.AccountError, match="key changed"):
        await trust.approve(NEW_BROWSER, public)
    assert not any(path == "/esync/approve" for _m, path, _b in fake.calls)
    with pytest.raises(T.AccountError, match="stopped waiting"):
        await trust.approve("0000000000000000", swapped)
    await made.aclose()


async def test_only_a_trusted_mac_approves_and_the_owner_can_deny():
    fake = FakeEdenSync()
    fake.turn_on(SECRET)
    made, trust = await member(fake)
    _private, public = fake.browser_asks()
    await trust.refresh()
    assert trust.public()["requests"] == []
    with pytest.raises(T.AccountError, match="doesn't have Eden's key"):
        await trust.approve(NEW_BROWSER, public)
    await trust.unlock(PASSPHRASE)
    await trust.deny(NEW_BROWSER)
    assert fake.requests[NEW_BROWSER]["status"] == "denied" and "Turned down" in trust.done
    await trust.forget()
    assert DEVICE_ID not in fake.trust and not trust.has_key
    await made.aclose()


# ── a device removed: Eden's key changes ──

NEW_SECRET = bytes(range(200, 232))


async def test_the_mac_vouches_for_itself_and_picks_up_a_new_key_that_follows_from_its_own():
    fake = FakeEdenSync()
    fake.turn_on(SECRET)
    vault = MemoryVault()
    made, trust = await member(fake, vault)
    await trust.unlock(PASSPHRASE)
    mine = fake.trust[DEVICE_ID]
    assert mine["mac"] == T.member_mac(SECRET, "x25519", mine["public_key"])
    fake.remove_a_device(SECRET, NEW_SECRET)  # a browser removed another one
    await trust.refresh()
    assert trust.state() == "on" and trust.error == ""
    kept = json.loads(vault.get(VAULT_ID, EDEN_KEY))
    assert (kept["key"], kept["epoch"]) == (base64.b64encode(NEW_SECRET).decode(), 2)
    assert fake.trust[DEVICE_ID]["epoch"] == 2 and fake.trust[DEVICE_ID]["via"] == "passphrase"
    # It approves with the new key, vouching for the browser whose code matched.
    private, public = fake.browser_asks()
    await trust.approve(NEW_BROWSER, public)
    r = fake.requests[NEW_BROWSER]
    assert T.open_sealed(private, "p256", r["sealed_key"], r["sender_key"]) == NEW_SECRET
    assert r["mac"] == T.member_mac(NEW_SECRET, "p256", public)
    await made.aclose()


async def test_a_new_key_that_doesnt_follow_from_the_macs_is_never_used():
    fake = FakeEdenSync()
    fake.turn_on(SECRET)
    vault = MemoryVault()
    made, trust = await member(fake, vault)
    await trust.unlock(PASSPHRASE)
    # askeden.com seals a key of its own to the Mac, with a chain made without the old key.
    nonce = b"f" * 12
    fake_link = nonce + AESGCM(T._hkdf(NEW_SECRET, b"eden-chain-v1")).encrypt(
        nonce, bytes(32), b"eden-chain-v1:gen-abcdef12:2"
    )
    fake.remove_a_device(SECRET, NEW_SECRET, link=base64.b64encode(fake_link).decode())
    await trust.refresh()
    assert trust.error == T.FORGED
    assert json.loads(vault.get(VAULT_ID, EDEN_KEY))["key"] == base64.b64encode(SECRET).decode()
    assert not any(
        p == "/esync/prove" and c.get("proof") == T.proof_of(NEW_SECRET) for _m, p, c in fake.calls
    )
    await made.aclose()


async def test_left_out_of_a_key_change_the_mac_drops_the_old_key_and_can_ask_again():
    fake = FakeEdenSync()
    fake.turn_on(SECRET)
    vault = MemoryVault()
    made, trust = await member(fake, vault)
    await trust.unlock(PASSPHRASE)
    fake.remove_a_device(SECRET, NEW_SECRET, seal_to_mac=False)  # this Mac was the one removed
    await trust.refresh()
    assert not trust.has_key and trust.state() == "locked" and trust.error == T.LEFT_OUT
    assert vault.get(VAULT_ID, EDEN_KEY) is None
    asking = await trust.ask()
    fake.browser_approves(DEVICE_ID, NEW_SECRET)
    await finish(trust)
    assert asking.state == "joined" and json.loads(vault.get(VAULT_ID, EDEN_KEY))["epoch"] == 2
    await made.aclose()


async def test_trusted_before_macs_the_mac_vouches_for_itself_when_it_next_asks():
    fake = FakeEdenSync()
    fake.turn_on(SECRET)
    made, trust = await member(fake)
    await trust.unlock(PASSPHRASE)
    fake.trust[DEVICE_ID].pop("mac")  # as joined with an older version
    await trust.refresh()
    mine = fake.trust[DEVICE_ID]
    assert mine["mac"] == T.member_mac(SECRET, "x25519", mine["public_key"])
    await made.aclose()


# ── Settings ──


async def test_settings_commands_answer_with_account_esync_events(setup):  # noqa: F811
    hub, inner = setup
    fake = FakeEdenSync(inner)
    fake.turn_on(SECRET)
    hub.account.transport = fake.transport
    await hub.account._keep(TOKEN, None)
    hub.account_desk.trust.sleep = instant
    q = hub.subscribe()
    await hub._handle({"type": "account_esync"})
    assert [e for e in drain(q) if e["type"] == "account_esync"][-1]["state"] == "locked"
    await hub._handle({"type": "account_esync_unlock", "passphrase": "wrong wrong wrong"})
    event = [e for e in drain(q) if e["type"] == "account_esync"][-1]
    assert "isn't the recovery passphrase" in event["problem"]
    await hub._handle({"type": "account_esync_unlock", "passphrase": PASSPHRASE})
    _private, public = fake.browser_asks()
    await hub._handle({"type": "account_esync"})
    event = [e for e in drain(q) if e["type"] == "account_esync"][-1]
    assert event["state"] == "on" and event["requests"][0]["code"] == T.verify_code(public)
    await hub._handle(
        {"type": "account_esync_approve", "device_id": NEW_BROWSER, "public_key": public}
    )
    events = [e for e in drain(q) if e["type"] == "account_esync"]
    assert fake.requests[NEW_BROWSER]["status"] == "approved" and events[-1]["requests"] == []
    seen = json.dumps(events)
    assert base64.b64encode(SECRET).decode() not in seen and PASSPHRASE not in seen
    await hub._handle({"type": "account_unlink"})
    assert hub.account_desk.trust.state() == "unknown"
