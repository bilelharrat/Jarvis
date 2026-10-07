"""The Mac's Jarvis account (jarvis.account, jarvis.features.account): linking with the
iPhone and unsealing the sync key it hands over, the account's status, signing out, pushes
through the account, the companion's one-tap link, Jarvis Plus for Claude Code, and the
hosted voice. askeden.com is a fake (account_fakes.FakeAskeden: an httpx MockTransport),
the Keychain a MemoryVault: never the network, never the owner's real Keychain."""

import asyncio
import base64
import json
from pathlib import Path

import httpx
import pytest
from account_fakes import ACCOUNT_ID, DEVICE_ID, TOKEN, FakeAskeden, sync_key
from claude_agent_sdk import AssistantMessage, ClaudeAgentOptions, TextBlock
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from test_hub import drain, make_hub

from jarvis import account as account_mod
from jarvis import claude_signin, push, remote
from jarvis.account import PLUS_PREF, Account
from jarvis.connectors import MemoryVault
from jarvis.providers import CREDENTIAL_ENV
from jarvis.speech import CloudVoice

FIXTURE = (
    Path(__file__).resolve().parents[1]
    / "companion"
    / "Tests"
    / "Fixtures"
    / "link-seal-vector.json"
)
BUNDLE = "com.askeden.jarvis"


async def instant(_seconds):
    await asyncio.sleep(0)


def client(fake, vault=None, **kw):
    return Account(
        vault or MemoryVault(),
        transport=fake.transport,
        name=lambda: "Studio",
        version=lambda: "0.1.6",
        sleep=instant,
        **kw,
    )


async def linked(fake, vault=None, key=None):
    made = client(fake, vault)
    await made._keep(TOKEN, key)
    return made


async def finish(made):
    if made._poller is not None:
        await asyncio.wait_for(made._poller, 5)


# ── the sealed sync key ──

# A fixed vector (the contract's "Sealing the sync key"), for the iPhone's tests to match:
# X25519 keys, the nonce and the sync key are fixed bytes, so the sealed box is too.
VECTOR = {
    "mac_private": "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
    "mac_public": "B6N8vBQgk8i3VdwbEOhstCY3StFqqFPtC9/AsrhtHHw=",
    "sender_private": "ZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5/gIGCg4Q=",
    "sender_public": "VxR2nRFr92Q2rnS8eT0sMK0ZA8WaxSc4BcfiaYtBDDY=",
    "nonce": "ycrLzM3Oz9DR0tPU",
    "sync_key": "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=",
    "sealed": "ycrLzM3Oz9DR0tPUXAhBiZ7Edqu2Unh+nrKDOQ40+1dxSiaygKtOWL0wEdQcE7zqtG5aqupmY2T/5ZWW",
}


def test_the_fixed_vector_seals_and_opens_as_the_contract_says():
    b = base64.b64decode
    mac = X25519PrivateKey.from_private_bytes(b(VECTOR["mac_private"]))
    sender = X25519PrivateKey.from_private_bytes(b(VECTOR["sender_private"]))
    sealed, sender_public = account_mod.seal(
        b(VECTOR["mac_public"]), b(VECTOR["sync_key"]), sender, b(VECTOR["nonce"])
    )
    assert (sealed, sender_public) == (VECTOR["sealed"], VECTOR["sender_public"])
    assert account_mod.unseal(mac, b(sender_public), sealed) == b(VECTOR["sync_key"])


@pytest.mark.skipif(not FIXTURE.exists(), reason="the iPhone's vector isn't written yet")
def test_the_iphones_own_vector_opens_here():
    """companion/Tests/Fixtures/link-seal-vector.json, sealed by the iPhone's CryptoKit
    code: this Mac opens it, and seals the same bytes from the same keys and nonce."""
    vector = json.loads(FIXTURE.read_text())
    b = account_mod.b64decode
    mac = X25519PrivateKey.from_private_bytes(b(vector["mac_private"]))
    assert mac.public_key().public_bytes_raw() == b(vector["mac_public"])
    opened = account_mod.unseal(mac, b(vector["sender_public"]), vector["sealed_key"])
    assert opened == b(vector["sync_key"])
    sender = X25519PrivateKey.from_private_bytes(b(vector["sender_private"]))
    sealed, sender_public = account_mod.seal(
        b(vector["mac_public"]), b(vector["sync_key"]), sender, b(vector["nonce"])
    )
    assert (sealed, sender_public) == (vector["sealed_key"], vector["sender_public"])


def test_a_sealed_key_for_another_mac_or_tampered_never_opens():
    sync = sync_key()
    mine, other = X25519PrivateKey.generate(), X25519PrivateKey.generate()
    sealed, sender = account_mod.seal(other.public_key().public_bytes_raw(), sync)
    with pytest.raises(ValueError):
        account_mod.unseal(mine, base64.b64decode(sender), sealed)
    sealed, sender = account_mod.seal(mine.public_key().public_bytes_raw(), sync)
    raw = bytearray(base64.b64decode(sealed))
    raw[-1] ^= 1
    with pytest.raises(ValueError):
        account_mod.unseal(mine, base64.b64decode(sender), base64.b64encode(bytes(raw)).decode())
    # URL-safe base64 without padding is read too
    url = sealed.replace("+", "-").replace("/", "_").rstrip("=")
    assert account_mod.unseal(mine, base64.b64decode(sender), url) == sync


def test_tokens_are_read_for_their_ids_only_when_well_formed():
    assert account_mod.parse_token(TOKEN) == (ACCOUNT_ID, DEVICE_ID)
    assert account_mod.parse_token("jv1.nope") is None
    assert account_mod.parse_token(TOKEN + "x") is None
    assert account_mod.parse_token(None) is None


# ── linking ──


async def test_linking_shows_a_code_then_keeps_the_token_and_the_unsealed_sync_key():
    key = sync_key()
    fake = FakeAskeden(sync_key=key)
    fake.polls = ["waiting", "waiting", "approve"]
    vault = MemoryVault()
    made = client(fake, vault)
    heard = []
    made.on_change.append(lambda: heard.append(made.link.state if made.link else None))
    link = await made.link_start()
    assert link.code == "K7QM-4ZTR" and link.url == "jarvis-link://K7QM-4ZTR"
    assert link.qr and set("".join(link.qr)) <= {"0", "1"}  # the QR code's rows
    start = fake.calls[0]
    assert start[:2] == ("POST", "/link/start")
    assert start[2]["kind"] == "mac" and start[2]["name"] == "Studio"
    assert start[2]["app_version"] == "0.1.6"
    assert len(base64.b64decode(start[2]["public_key"])) == 32
    await finish(made)
    assert link.state == "linked" and made.linked
    assert made.account_id == ACCOUNT_ID and made.device_id == DEVICE_ID
    assert made.sync_key == key
    assert vault.data["jarvis-account:token"] == TOKEN
    assert base64.b64decode(vault.data["jarvis-account:sync_key"]) == key
    assert [c[1] for c in fake.calls].count("/link/poll") == 3
    assert heard[-1] == "linked" and link.private is None  # the one-time key let go
    public = made.public()
    assert TOKEN not in json.dumps(public) and public["sync_key"] is True
    # read back by a fresh client, as at the next launch
    again = client(fake, vault)
    await again.load()
    assert again.token == TOKEN and again.sync_key == key


async def test_a_phone_without_a_sync_key_links_the_mac_all_the_same():
    fake = FakeAskeden(sync_key=None)
    fake.polls = ["approve"]
    made = client(fake)
    await made.link_start()
    await finish(made)
    assert made.linked and made.sync_key is None


@pytest.mark.parametrize(("step", "state"), [("deny", "denied"), ("expire", "expired")])
async def test_a_code_the_phone_turns_down_or_lets_lapse_ends_there(step, state):
    fake = FakeAskeden()
    fake.polls = ["waiting", step]
    made = client(fake)
    await made.link_start()
    await finish(made)
    assert made.link.state == state and not made.linked


async def test_a_code_past_its_time_expires_without_asking_again():
    fake = FakeAskeden()
    now = [0.0]
    made = client(fake, clock=lambda: now[0])

    async def later(_seconds):
        now[0] += 700
        await asyncio.sleep(0)

    made.sleep = later
    await made.link_start()
    await finish(made)
    assert made.link.state == "expired"
    assert "/link/poll" not in [c[1] for c in fake.calls]


async def test_a_new_code_lets_the_one_before_go():
    fake = FakeAskeden()
    made = client(fake)
    made.sleep = lambda _s: asyncio.sleep(3600)
    await made.link_start()
    first = made._poller
    await made.link_start()
    await asyncio.sleep(0)
    assert first.cancelled() or first.done()
    made.cancel_link()
    await made.aclose()
    assert made.link is None


# ── the account ──


async def test_the_status_is_asked_once_a_minute_at_most():
    fake = FakeAskeden()
    now = [0.0]
    made = await linked(fake)
    made.clock = lambda: now[0]
    info = await made.status()
    assert info["id"] == ACCOUNT_ID and info["devices"][0]["this"] is True
    await made.status()
    now[0] += 61
    await made.status()
    await made.status(fresh=True)
    assert [c[1] for c in fake.calls].count("/account") == 3


async def test_a_401_means_signed_out_and_the_mac_forgets_the_account():
    fake = FakeAskeden()
    vault = MemoryVault()
    made = await linked(fake, vault, key=sync_key())
    fake.tokens.clear()  # unlinked from the phone
    assert await made.status(fresh=True) is None
    assert not made.linked and made.sync_key is None and vault.data == {}


async def test_unlinking_signs_the_mac_out_there_then_forgets_it_here():
    fake = FakeAskeden()
    vault = MemoryVault()
    made = await linked(fake, vault, key=sync_key())
    assert await made.unlink() is True
    assert ("DELETE", "/devices/me", None) in fake.calls
    assert not made.linked and vault.data == {}


async def test_unlinking_while_offline_still_forgets_it_here():
    def offline(_request):
        raise httpx.ConnectError("offline")

    made = Account(MemoryVault(), transport=httpx.MockTransport(offline))
    await made._keep(TOKEN, None)
    assert await made.unlink() is False and not made.linked


# ── pushes through the account ──


def phone_push():
    return push.Push(
        device_token="ab" * 32,
        environment="sandbox",
        topic=BUNDLE,
        payload=push.alert("Jarvis", "Hello"),
        collapse_id="c1",
        expiration=1790000000,
    )


async def test_without_a_key_of_its_own_a_linked_mac_pushes_through_the_account():
    fake = FakeAskeden()
    made = await linked(fake)
    keys = push.Keys(MemoryVault())
    sender = push.Sender(keys, account=lambda: made)
    assert isinstance(await sender.route(), push.AccountRoute)
    assert sender.through_account()
    result = await sender.send(phone_push())
    assert result.ok
    assert fake.pushes == [
        {
            "apns_token": "ab" * 32,
            "apns_env": "sandbox",
            "push_type": "alert",
            "priority": 10,
            "payload": push.alert("Jarvis", "Hello"),
            "collapse_id": "c1",
            "expiration": 1790000000,
        }
    ]


async def test_apples_answers_through_the_account_keep_their_meaning():
    fake = FakeAskeden()
    made = await linked(fake)
    sender = push.Sender(push.Keys(MemoryVault()), account=lambda: made)
    fake.push_answers = [
        {"status": 410, "reason": "Unregistered"},
        {"status": 400, "reason": "BadDeviceToken"},
        {"status": 400, "reason": "PayloadEmpty"},
        503,
    ]
    gone = await sender.send(phone_push())
    assert gone.status == 410 and gone.gone
    bad = await sender.send(phone_push())
    assert bad.gone and bad.reason == "BadDeviceToken"
    other = await sender.send(phone_push())
    assert not other.ok and not other.gone
    unset = await sender.send(phone_push())
    assert (unset.status, unset.reason) == (0, "not_set_up")


async def test_the_owners_own_key_comes_first_and_unlinked_means_no_push():
    fake = FakeAskeden()
    made = client(fake)
    sender = push.Sender(push.Keys(MemoryVault()), account=lambda: made)
    assert await sender.route() is None
    assert (await sender.send(phone_push())).reason == "no key"
    assert push.AccountRoute().allows(BUNDLE) and not push.AccountRoute().allows(BUNDLE + ".watch")


@pytest.fixture
def setup(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.remote.host, hub.remote.port, hub.remote.advertiser = "127.0.0.1", 0, None
    fake = FakeAskeden()
    hub.account.transport = fake.transport
    hub.account.sleep = instant
    hub.account.name = lambda: "Studio"
    return hub, fake


async def test_the_companions_pushes_go_through_the_account_and_a_gone_phone_is_dropped(setup):
    hub, fake = setup
    companion = hub.remote.extension
    await hub.account._keep(TOKEN, None)
    hub.remote.devices.pair(hub.remote.devices.start_pairing(), "iPhone")
    device = hub.remote.devices.items[-1]
    companion.store.register(device.id, "cd" * 32, "production", BUNDLE)

    async def away():
        return True

    companion.notifier.away = away
    fake.push_answers = [{"status": 410, "reason": "Unregistered"}]
    outcome = await companion.notifier.test()
    assert outcome == {device.id: "gone"}
    assert fake.pushes[0]["apns_token"] == "cd" * 32
    assert companion.store.known(device.id)["push"] is None
    assert companion.status()["push"]["via"] == "account"
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    hub.account_desk.emit()
    assert events[-1][1]["push_via_account"] is True


# ── the companion's one tap ──


def phone_client(hub):
    """The companion's routes on the test's own event loop (as the app serves them on its
    loop): what a call starts, the link's poller, outlives the call."""
    app = remote.create_remote_app(hub, hub.remote.devices, extension=hub.remote.extension)
    test = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://studio.local:8765"
    )
    token = hub.remote.devices.pair(hub.remote.devices.start_pairing(), "iPhone")
    return test, {"Authorization": f"Bearer {token}"}


async def test_a_paired_phone_links_the_mac_in_one_tap(setup):
    hub, fake = setup
    test, auth = phone_client(hub)
    assert (await test.get("/api/account")).status_code == 401
    assert (await test.get("/api/account", headers=auth)).json() == {
        "linked": False,
        "account_id": None,
        "device_id": None,
    }
    assert "account" not in (await test.get("/api/state", headers=auth)).json()
    fake.polls = ["approve"]
    answer = await test.post("/api/account/link", headers=auth, json={})
    assert answer.status_code == 200 and answer.json() == {"code": "K7QM-4ZTR"}
    await finish(hub.account)
    assert hub.account.linked
    assert (await test.get("/api/account", headers=auth)).json() == {
        "linked": True,
        "account_id": ACCOUNT_ID,
        "device_id": DEVICE_ID,
    }
    state = (await test.get("/api/state", headers=auth)).json()
    assert state["account"] == {"device_id": DEVICE_ID} and "account" in state["features"]
    assert TOKEN not in json.dumps(state)
    await test.aclose()


async def test_an_unpaired_caller_cant_start_a_link(setup):
    hub, fake = setup
    test, _auth = phone_client(hub)
    assert (await test.post("/api/account/link", json={})).status_code == 401
    assert fake.calls == []
    await test.aclose()


# ── Settings ──


async def test_settings_link_shows_the_code_and_qr_then_the_account(setup):
    hub, fake = setup
    q = hub.subscribe()
    await hub._handle({"type": "account"})
    first = [e for e in drain(q) if e["type"] == "account"][-1]
    assert first["linked"] is False and first["link"] is None and fake.calls == []
    fake.polls = ["waiting", "approve"]
    await hub._handle({"type": "account_link"})
    await asyncio.sleep(0)
    shown = [e for e in drain(q) if e["type"] == "account"]
    waiting = next(e for e in shown if e["link"] and e["link"]["state"] == "waiting")
    assert waiting["link"]["code"] == "K7QM-4ZTR" and waiting["link"]["qr"]
    await finish(hub.account)
    await hub._handle({"type": "account"})
    last = [e for e in drain(q) if e["type"] == "account"][-1]
    assert last["linked"] and last["info"]["plan"]["name"] == "free"
    assert last["relay"]["on"] is True and last["plus"] == {"chosen": False, "in_use": False}
    assert last["eden_link"]["on"] is True and set(last["eden_link"]) == {"on", "state", "error"}
    # The line's changes reach Settings by themselves (jarvis.eden_link's on_change).
    hub.account_desk.eden_link._set("waiting", "Couldn’t reach askeden.com.")
    heard = [e for e in drain(q) if e["type"] == "account"][-1]["eden_link"]
    assert heard == {"on": True, "state": "waiting", "error": "Couldn’t reach askeden.com."}
    hub.set_feature_prefs({"account_eden_link": False})
    await asyncio.sleep(0)
    assert [e for e in drain(q) if e["type"] == "account"][-1]["eden_link"]["on"] is False
    assert TOKEN not in json.dumps(last)
    await hub._handle({"type": "account_unlink"})
    assert not hub.account.linked


async def test_settings_says_why_when_askeden_cant_be_reached(setup):
    hub, _fake = setup

    def offline(_request):
        raise httpx.ConnectError("offline")

    hub.account.transport = httpx.MockTransport(offline)
    q = hub.subscribe()
    await hub._handle({"type": "account_link"})
    event = [e for e in drain(q) if e["type"] == "account"][-1]
    assert event["error"] == "Couldn't reach askeden.com." and event["link"] is None


# ── Jarvis Plus ──


def options():
    return ClaudeAgentOptions(
        model="claude-haiku-4-5", env={"ANTHROPIC_API_KEY": "sk-own", "X": "1"}
    )


@pytest.fixture
def plus(setup):
    hub, fake = setup
    yield hub, fake
    claude_signin.deactivate()


async def test_jarvis_plus_runs_claude_code_through_the_proxy_with_the_token_kept_out_of_sight(
    plus,
):
    hub, _fake = plus
    claude_signin.activate(hub)
    assert claude_signin.signed_in(options()).settings is None  # not linked: as before
    await hub.account._keep(TOKEN, None)
    assert claude_signin.signed_in(options()).settings is None  # linked, not chosen
    hub.set_feature_prefs({PLUS_PREF: True})
    made = claude_signin.signed_in(options())
    settings = json.loads(made.settings)
    assert settings["env"]["ANTHROPIC_BASE_URL"] == "https://askeden.com/api/anthropic"
    assert all(settings["env"][name] == "" for name in CREDENTIAL_ENV)
    assert (
        "jarvis-account:token" in settings["apiKeyHelper"] and " -I -c " in settings["apiKeyHelper"]
    )
    assert made.env["ANTHROPIC_API_KEY"] == "" and made.env["X"] == "1"
    assert TOKEN not in made.settings and TOKEN not in json.dumps(made.env)
    assert claude_signin.using_plus()
    own = ClaudeAgentOptions(settings='{"apiKeyHelper": "a provider of its own"}')
    assert claude_signin.signed_in(own).settings == '{"apiKeyHelper": "a provider of its own"}'


async def test_a_linked_mac_with_no_other_way_in_uses_jarvis_plus(plus):
    hub, _fake = plus
    claude_signin.activate(hub)
    await hub.account._keep(TOKEN, None)
    hub.account.claude_signed_in = True
    assert claude_signin.signed_in(options()).settings is None
    hub.account.claude_signed_in = False
    assert "askeden.com/api/anthropic" in claude_signin.signed_in(options()).settings


async def test_the_allowance_used_up_is_said_plainly_not_as_a_sign_in_error(plus):
    hub, fake = plus
    await hub.account._keep(TOKEN, None)
    desk = hub.account_desk
    assert desk.error_words("billing_error") == ""  # Plus not in use: Claude Code's words
    hub.set_feature_prefs({PLUS_PREF: True})
    assert "trial is used up" in desk.error_words("billing_error")
    fake.plan = {"name": "plus", "active": True}
    await hub.account.status(fresh=True)
    assert "allowance for this month is used up" in desk.error_words("billing_error")
    assert desk.error_words("rate_limit") == ""
    hub.prefs.fallback_model = "off"
    hub.turn = {"reply": ""}
    q = hub.subscribe()
    said = AssistantMessage(
        content=[TextBlock(text="API Error: 402 billing_error")], model="m", error="billing_error"
    )
    await hub._on_message("r1", said)
    replies = [e["text"] for e in drain(q) if e["type"] == "reply"]
    assert replies and "allowance for this month is used up" in replies[-1]
    assert "402" not in replies[-1]


async def test_jarvis_code_says_the_allowance_too(plus):
    hub, _fake = plus
    await hub.account._keep(TOKEN, None)
    hub.set_feature_prefs({PLUS_PREF: True})
    assert hub.tasks.error_words("billing_error").startswith("Your Jarvis Plus")


# ── the hosted voice ──


def test_the_hosted_voice_counts_against_the_account_when_linked():
    voice = CloudVoice("hosted", "f" * 32, "v", bearer=lambda: TOKEN)
    request = voice._hosted("Hello", "wav")
    assert request["headers"] == {"X-Jarvis-Install": "f" * 32, "Authorization": f"Bearer {TOKEN}"}
    alone = CloudVoice("hosted", "f" * 32, "v", bearer=lambda: "")._hosted("Hello", "wav")
    assert alone["headers"] == {"X-Jarvis-Install": "f" * 32}


async def test_the_speaking_desk_hands_the_hosted_voice_the_token(setup):
    hub, _fake = setup
    from jarvis.speaking import Speaking

    desk = Speaking(hub)

    async def no_key(_provider):
        return ""

    desk._key = no_key
    voice = await desk.jarvis_voice(1.0)
    assert "Authorization" not in voice._hosted("Hi", "wav")["headers"]
    await hub.account._keep(TOKEN, None)
    voice = await desk.jarvis_voice(1.0)
    assert voice._hosted("Hi", "wav")["headers"]["Authorization"] == f"Bearer {TOKEN}"


# ── the server: askeden.com or its preview ──


async def test_the_server_is_chosen_while_unlinked_and_stays_with_the_token():
    fake = FakeAskeden(sync_key=None)
    fake.polls = ["waiting", "approve"]
    vault = MemoryVault()
    made = client(fake, vault)
    assert made.server == "askeden.com" and made.ws_base == "wss://askeden.com/api/relay"
    assert made.use_server("evil.example") is False and made.server == "askeden.com"
    assert made.use_server("preview.askeden.com") is True
    assert made.base == "https://preview.askeden.com/api"
    assert made.ws_base == "wss://preview.askeden.com/api/relay"
    link = await made.link_start(browser=True)
    assert link.browser and made.link_page() == "https://preview.askeden.com/link#K7QM-4ZTR"
    assert made.public()["link"]["page"] == made.link_page()
    assert made.use_server("askeden.com") is False, "not while a code is up"
    await finish(made)
    assert made.linked and made.link_page() == ""
    assert vault.data["jarvis-account:server"] == "preview.askeden.com"
    assert made.use_server("askeden.com") is False and made.server == "preview.askeden.com"
    # The next launch talks to the server the token is for, whatever the default.
    again = client(fake, vault)
    await again.load()
    assert again.server == "preview.askeden.com" and again.token == TOKEN
    await again.forget()
    assert vault.data == {}
    assert again.use_server("askeden.com") is True


async def test_settings_links_this_mac_in_the_browser_at_the_chosen_server(setup):
    hub, fake = setup
    opened = []
    hub.connectors.open_url = opened.append
    q = hub.subscribe()
    hub.set_feature_prefs({"account_server": "preview.askeden.com"})
    await asyncio.sleep(0)
    assert hub.account.server == "preview.askeden.com"
    assert hub.account_desk.eden_link.base == "wss://preview.askeden.com/api/relay"
    fake.polls = ["waiting", "approve"]
    await hub._handle({"type": "account_link", "browser": True})
    await asyncio.sleep(0)
    assert opened == ["https://preview.askeden.com/link#K7QM-4ZTR"]
    waiting = next(
        e for e in drain(q) if e["type"] == "account" and e["link"] and e["link"]["browser"]
    )
    assert waiting["server"] == "preview.askeden.com" and waiting["link"]["page"] == opened[0]
    await hub._handle({"type": "account_link_open"})
    assert opened == [opened[0]] * 2
    await finish(hub.account)
    await hub._handle({"type": "account"})
    last = [e for e in drain(q) if e["type"] == "account"][-1]
    assert last["linked"] and last["server"] == "preview.askeden.com"
    assert last["servers"] == ["askeden.com", "preview.askeden.com"]
    # Linked: the setting changing doesn't move the token elsewhere.
    hub.set_feature_prefs({"account_server": "askeden.com"})
    await asyncio.sleep(0)
    assert hub.account.server == "preview.askeden.com"
    await hub._handle({"type": "account_link_open"})
    assert len(opened) == 2, "no code waiting: nothing opens"
