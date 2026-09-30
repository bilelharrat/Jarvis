"""Push notifications through APNs (jarvis.push): the key kept in the vault (a
MemoryVault, never the Keychain), the ES256 token checked with the key's public half, the
request as curl gets it on stdin (curl itself faked: no network), and what each of
Apple's answers leads to."""

import asyncio
import base64
import json
import logging

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from jarvis import push
from jarvis.connectors import MemoryVault


def p8(curve=None) -> str:
    key = ec.generate_private_key(curve or ec.SECP256R1())
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()


@pytest.fixture
def creds():
    return push.check(p8(), "ABC123DEFG", "9ZSY5R8A5C", "com.bshventures.jarvis.companion")


def unb64(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def curl_options(config: bytes) -> dict[str, list[str]]:
    """curl's config file read back: option -> its values (quoted ones unescaped)."""
    out: dict[str, list[str]] = {}
    for line in config.decode().splitlines():
        name, _, value = line.partition(" = ")
        if value.startswith('"'):
            body, i, text = value[1:], 0, ""
            while body[i] != '"':
                if body[i] == "\\":
                    i += 1
                text += body[i]
                i += 1
            value = text
        out.setdefault(name.strip(), []).append(value)
    return out


class Curl:
    """Stands in for /usr/bin/curl: answers from a script, records what it was given."""

    def __init__(self, *answers):
        self.answers = list(answers) or [(0, b"\n200")]
        self.calls = []

    async def __call__(self, argv, stdin, timeout):
        self.calls.append((argv, stdin, timeout))
        return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]


def apns(status: int, reason: str = "") -> tuple[int, bytes, bytes]:
    body = json.dumps({"reason": reason}).encode() if reason else b""
    return 0, body + b"\n" + str(status).encode(), b""


async def ready_sender(creds, curl, clock=lambda: 1_700_000_000.0):
    keys = push.Keys(MemoryVault())
    await keys.save(creds)
    return push.Sender(keys, run=curl, clock=clock)


def a_push(**extra):
    base = {
        "device_token": "ab" * 32,
        "environment": "production",
        "topic": "com.bshventures.jarvis.companion",
        "payload": push.alert("Send this to Ann?", "Answer here or on your Mac."),
    }
    return push.Push(**{**base, **extra})


# ── the key ──


def test_a_pasted_key_is_checked_and_tidied():
    made = push.check("  \r\n" + p8() + "\n\n", " abc123defg ", "", "")
    assert made.key_id == "ABC123DEFG" and made.team_id == push.TEAM_DEFAULT
    assert made.bundle_id == push.BUNDLE_DEFAULT and made.key.endswith("-----\n")
    assert made.allows("com.bshventures.jarvis.companion.watchkitapp")
    assert not made.allows("com.bshventures.jarvis.companionX")
    rsa_pem = (
        rsa.generate_private_key(public_exponent=65537, key_size=2048)
        .private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        .decode()
    )
    for key, key_id, team, bundle, words in (
        ("not a key", "ABC123DEFG", "", "", "isn't a push key"),
        (rsa_pem, "ABC123DEFG", "", "", "P-256"),
        (p8(ec.SECP384R1()), "ABC123DEFG", "", "", "P-256"),
        (p8(), "SHORT", "", "", "Key ID"),
        (p8(), "ABC123DEFG", "team!", "", "Team ID"),
        (p8(), "ABC123DEFG", "", "not a bundle", "bundle ID"),
    ):
        with pytest.raises(push.KeyProblem, match=words):
            push.check(key, key_id, team, bundle)


async def test_the_key_lives_in_the_vault_and_is_read_once(creds):
    vault = MemoryVault()
    keys = push.Keys(vault)
    assert await keys.get() is None and keys.status()["configured"] is False
    await keys.save(creds)
    stored = json.loads(vault.get(push.VAULT_ID, push.VAULT_KEY))
    assert stored["key"] == creds.key and stored["key_id"] == "ABC123DEFG"
    status = keys.status()
    assert status["configured"] and status["team_id"] == "9ZSY5R8A5C"
    assert "key" not in status and creds.key not in json.dumps(status)

    again = push.Keys(vault)
    assert await again.get() == creds
    vault.set(push.VAULT_ID, push.VAULT_KEY, "{damaged")
    assert await push.Keys(vault).get() is None  # can't be used: pasted again in Settings
    await again.forget()
    assert vault.get(push.VAULT_ID, push.VAULT_KEY) is None and await again.get() is None


# ── the provider token ──


def test_the_token_is_es256_signed_with_the_key(creds):
    token = push.make_token(creds, 1_700_000_123.9)
    header, claims, signature = token.split(".")
    assert json.loads(unb64(header)) == {"alg": "ES256", "kid": "ABC123DEFG"}
    assert json.loads(unb64(claims)) == {"iss": "9ZSY5R8A5C", "iat": 1_700_000_123}
    raw = unb64(signature)
    assert len(raw) == 64  # r and s, 32 bytes each (JOSE), not DER
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    public = serialization.load_pem_private_key(creds.key.encode(), None).public_key()
    public.verify(der, f"{header}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))  # no raise


async def test_a_token_is_kept_fifty_minutes(creds):
    now = [1_700_000_000.0]
    sender = await ready_sender(creds, Curl(), clock=lambda: now[0])
    first = sender.token(creds)
    now[0] += push.TOKEN_SECONDS - 1
    assert sender.token(creds) == first
    now[0] += 1
    assert sender.token(creds) != first  # made again once fifty minutes are up
    other = push.check(p8(), "ZZZ123DEFG", "9ZSY5R8A5C", "com.bshventures.jarvis.companion")
    assert json.loads(unb64(sender.token(other).split(".")[0]))["kid"] == "ZZZ123DEFG"


# ── the request ──


async def test_curl_gets_everything_on_stdin_never_its_command_line(creds):
    curl = Curl(apns(200))
    sender = await ready_sender(creds, curl)
    note = push.alert('He said "hi" \\ 你好', "Answer here", category="JARVIS_APPROVAL")
    result = await sender.send(
        a_push(payload=note, environment="sandbox", collapse_id="a-123", priority=5)
    )
    assert result.ok and result.status == 200
    argv, stdin, timeout = curl.calls[0]
    assert argv == ["/usr/bin/curl", "--config", "-"] and timeout > push.SEND_SECONDS
    options = curl_options(stdin)
    assert options["url"] == [f"https://api.sandbox.push.apple.com/3/device/{'ab' * 32}"]
    assert "http2" in options and options["request"] == ["POST"]
    headers = options["header"]
    token = next(h for h in headers if h.startswith("authorization: bearer "))
    assert token.split()[-1].count(".") == 2
    for expected in (
        "apns-topic: com.bshventures.jarvis.companion",
        "apns-push-type: alert",
        "apns-priority: 5",
        "apns-collapse-id: a-123",
        "content-type: application/json",
    ):
        assert expected in headers
    assert json.loads(options["data-binary"][0]) == note  # quotes, backslashes, Chinese intact
    assert int(options["max-time"][0]) == push.SEND_SECONDS


async def test_production_goes_to_apples_production_host(creds):
    curl = Curl(apns(200))
    sender = await ready_sender(creds, curl)
    await sender.send(a_push())
    assert curl_options(curl.calls[0][1])["url"][0].startswith("https://api.push.apple.com/3/")


async def test_what_apple_answers_decides_what_happens(creds):
    for answer, ok, gone, bad_key in (
        (apns(200), True, False, False),
        (apns(410, "Unregistered"), False, True, False),
        (apns(400, "BadDeviceToken"), False, True, False),
        (apns(400, "DeviceTokenNotForTopic"), False, True, False),
        (apns(403, "InvalidProviderToken"), False, False, True),
        (apns(429, "TooManyRequests"), False, False, False),
        (apns(503, "ServiceUnavailable"), False, False, False),
        ((28, b"", b"timed out"), False, False, False),
    ):
        sender = await ready_sender(creds, Curl(answer))
        result = await sender.send(a_push())
        assert (result.ok, result.gone, result.bad_key) == (ok, gone, bad_key), answer
        assert (sender.keys.error != "") == bad_key
    assert (await (await ready_sender(creds, Curl((7, b"", b"")))).send(a_push())).reason == (
        "network (7)"
    )


async def test_an_expired_token_is_made_again_and_the_push_sent_once_more(creds):
    now = [1_700_000_000.0]
    curl = Curl(apns(403, "ExpiredProviderToken"), apns(200))
    sender = await ready_sender(creds, curl, clock=lambda: now[0])
    sender.token(creds)
    now[0] += 30  # the same second would sign the same claims
    result = await sender.send(a_push())
    assert result.ok and len(curl.calls) == 2
    tokens = [
        next(h for h in curl_options(c[1])["header"] if h.startswith("authorization"))
        for c in curl.calls
    ]
    assert tokens[0] != tokens[1]


async def test_a_refused_key_shows_and_a_push_that_goes_clears_it(creds):
    curl = Curl(apns(403, "InvalidProviderToken"))
    sender = await ready_sender(creds, curl)
    await sender.send(a_push())
    assert sender.keys.status()["error"] == "InvalidProviderToken"
    curl.answers = [apns(200)]
    await sender.send(a_push())
    assert sender.keys.status()["error"] == ""


async def test_nothing_goes_without_a_key_a_good_token_or_room(creds):
    curl = Curl()
    sender = push.Sender(push.Keys(MemoryVault()), run=curl)
    assert (await sender.send(a_push())).reason == "no key"
    sender = await ready_sender(creds, curl)
    assert (await sender.send(a_push(device_token="nothex"))).reason == "BadDeviceToken"
    assert (await sender.send(a_push(environment="staging"))).reason == "BadDeviceToken"
    huge = push.alert("x", "y")
    huge["jarvis"] = {"pad": "x" * 5000}
    assert (await sender.send(a_push(payload=huge))).reason == "PayloadTooLarge"
    assert curl.calls == []


async def test_no_curl_is_an_answer_not_a_crash(creds):
    async def missing(*_a):
        raise FileNotFoundError(2, "No such file")

    sender = await ready_sender(creds, missing)
    assert "curl couldn't run" in (await sender.send(a_push())).reason


async def test_the_key_and_token_are_never_logged(creds, caplog):
    caplog.set_level(logging.DEBUG)
    curl = Curl(apns(403, "InvalidProviderToken"), apns(500, "InternalServerError"))
    sender = await ready_sender(creds, curl)
    await sender.send(a_push())
    await sender.send(a_push())
    token = sender.token(creds)
    body = creds.key.splitlines()[1]
    assert token not in caplog.text and body not in caplog.text
    assert "InvalidProviderToken" in caplog.text  # the reason is


async def test_curl_runs_with_a_deadline():
    code, out, _err = await push.run_curl(["/bin/cat"], b"config on stdin", 5)
    assert (code, out) == (0, b"config on stdin")
    started = asyncio.get_running_loop().time()
    code, _out, err = await push.run_curl(["/bin/sleep", "5"], b"", 0.2)
    assert code == -1 and err == b"timed out"
    assert asyncio.get_running_loop().time() - started < 3


def test_curl_output_is_read_as_body_then_status():
    assert push.parse(0, b'{"reason":"BadDeviceToken"}\n400') == push.Result(400, "BadDeviceToken")
    assert push.parse(0, b"\n200") == push.Result(200, "")
    assert push.parse(0, b"not json\n500") == push.Result(500, "")
    assert push.parse(0, b"garbage") == push.Result(0, "no status")
    assert push.parse(35, b"") == push.Result(0, "network (35)")


def test_payloads():
    note = push.alert(
        "t" * 200,
        "b" * 400,
        category="JARVIS_HEADSUP",
        thread="rain",
        level="passive",
        jarvis={"kind": "headsup", "id": "rain:1", "at": 5},
    )
    aps = note["aps"]
    assert len(aps["alert"]["title"]) == 120 and len(aps["alert"]["body"]) == 240
    assert "sound" not in aps and aps["interruption-level"] == "passive"  # silent
    assert note["jarvis"]["kind"] == "headsup"
    assert push.alert("a", "b")["aps"]["sound"] == "default"
    state = {"title": "t", "status": "Working", "detail": "", "needsYou": False, "updatedAt": 5}
    update = push.live_update(state, now=100)
    assert update["aps"]["event"] == "update" and update["aps"]["content-state"] == state
    assert update["aps"]["timestamp"] == 100 and update["aps"]["stale-date"] > 100
    end = push.live_update(state, event="end", now=100, dismiss_after=60)
    assert end["aps"]["dismissal-date"] == 160 and "stale-date" not in end["aps"]
