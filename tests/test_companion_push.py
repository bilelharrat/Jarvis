"""What the Mac pushes to the phones, and when (jarvis.companion_push), heard through the
feature kit's sinks and Jarvis Code's events. curl is faked (never the network), the key
lives in a MemoryVault, and whether the owner is at the Mac is set by each test."""

import asyncio
import json
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient
from test_hub import drain, make_hub
from test_push import apns, curl_options, p8

from jarvis import companion_push, push, remote
from jarvis.companion import CompanionStore
from jarvis.interrupts import Interruption
from jarvis.proactive import Alert

BUNDLE = "com.bshventures.jarvis.companion"


class Curl:
    def __init__(self):
        self.calls = []
        self.answers = []

    async def __call__(self, argv, stdin, timeout):
        options = curl_options(stdin)
        self.calls.append(
            {
                "token": options["url"][0].rsplit("/", 1)[-1],
                "headers": options["header"],
                "payload": json.loads(options["data-binary"][0]),
                "raw": stdin,
            }
        )
        return self.answers.pop(0) if self.answers else apns(200)

    def payloads(self):
        return [c["payload"] for c in self.calls]


@pytest.fixture
def setup(settings, quiet_speaker, isolated, monkeypatch):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.remote.host, hub.remote.port, hub.remote.advertiser = "127.0.0.1", 0, None
    hub.prefs.proactive = True
    companion = hub.remote.extension
    curl = Curl()
    companion.sender.run = curl
    away = {"now": True}

    async def is_away():
        return away["now"]

    companion.notifier.away = is_away
    quiet = {"now": False}
    monkeypatch.setattr(companion_push, "in_quiet_hours", lambda _now, _spec: quiet["now"])
    return SimpleNamespace(hub=hub, companion=companion, curl=curl, away=away, quiet=quiet)


async def ready(s, *names, key=True):
    """Phones paired with push turned on in their app (tokens aa…, bb…), and the key set."""
    if key:
        await s.companion.keys.save(push.check(p8(), "ABC123DEFG", "9ZSY5R8A5C", BUNDLE))
    devices = []
    for i, name in enumerate(names or ("iPhone",)):
        s.hub.remote.devices.pair(s.hub.remote.devices.start_pairing(), name)
        device = s.hub.remote.devices.items[-1]
        s.companion.store.register(device.id, "abcdef"[i] * 64, "production", BUNDLE)
        devices.append(device)
    return devices


async def settle(hub):
    for _ in range(20):
        pending = [t for t in list(hub._background) if not t.done()]
        if not pending:
            return
        await asyncio.wait(pending, timeout=2)


def aps(payload):
    return payload["aps"]


# ── approvals ──


async def test_an_approval_reaches_the_phone_with_its_answers_and_never_its_detail(setup):
    s = setup
    await ready(s)
    asked = asyncio.create_task(
        s.hub.send_gate("Send this to Ann Lee?", "Dinner moved to 8, see you there", "")
    )
    await asyncio.sleep(0)
    await settle(s.hub)
    card = next(iter(s.hub.approvals.values()))
    [call] = s.curl.calls
    payload = call["payload"]
    assert aps(payload)["alert"] == {
        "title": "Send this to Ann Lee?",
        "body": "Answer here or on your Mac.",
    }
    assert aps(payload)["category"] == "JARVIS_APPROVAL"
    assert aps(payload)["interruption-level"] == "time-sensitive" and aps(payload)["sound"]
    assert payload["jarvis"]["kind"] == "approval" and payload["jarvis"]["id"] == card["id"]
    assert [c["id"] for c in payload["jarvis"]["choices"]] == ["allow", "deny"]
    assert "task_id" not in payload["jarvis"]
    assert "Dinner moved" not in call["raw"].decode()  # the message itself stays on the Mac
    assert f"apns-collapse-id: a-{card['id']}" in call["headers"]
    assert "apns-push-type: alert" in call["headers"]
    s.hub.resolve(card["id"], "deny")
    assert await asked is False


async def test_jarvis_code_cards_say_which_kind_they_are(setup):
    s = setup
    await ready(s)
    s.hub.tasks.tasks[7] = SimpleNamespace(cwd=SimpleNamespace(name="alpha"))
    tool = asyncio.create_task(
        s.hub.request_approval(
            "Jarvis Code in alpha wants to run a command",
            "$ curl https://example.com/?token=secret",
            [("allow", "Yes"), ("always", "Yes, always"), ("deny", "No")],
            {"task_id": 7, "tool": "Bash"},
        )
    )
    plan = asyncio.create_task(
        s.hub.request_approval(
            "Jarvis Code in alpha has a plan",
            "1. Rewrite everything",
            [("plan_edits", "Go"), ("plan_ask", "Go, ask"), ("plan_keep", "Keep planning")],
            {"task_id": 7, "ask_kind": "plan"},
        )
    )
    question = asyncio.create_task(
        s.hub.request_approval(
            "Which of Ann's three emails should I answer first?",
            "",
            [("opt0", "First"), ("opt1", "Second"), ("skip", "Skip")],
            {"task_id": 7, "ask_kind": "question"},
        )
    )
    purchase = asyncio.create_task(
        s.hub.request_approval(
            "Confirm purchase: $40 at Books Ltd?",
            "",
            [("allow", "Confirm purchase"), ("deny", "Cancel")],
            {"ask_kind": "purchase"},
        )
    )
    await asyncio.sleep(0)
    await settle(s.hub)
    by_title = {aps(p)["alert"]["title"]: p for p in s.curl.payloads()}
    code = by_title["Jarvis Code in alpha wants to run a command"]
    assert aps(code)["category"] == "JARVIS_CODE_APPROVAL" and code["jarvis"]["task_id"] == 7
    assert code["jarvis"]["kind"] == "code_approval" and aps(code)["thread-id"] == "code-7"
    plan_note = by_title["Jarvis Code in alpha has a plan"]
    assert plan_note["jarvis"]["kind"] == "code_needs_you"  # no "no" to give on the Lock Screen
    assert aps(plan_note)["category"] == "JARVIS_HEADSUP"
    asked = by_title["Jarvis Code has a question"]  # Claude's own words stay on the Mac
    assert aps(asked)["alert"]["body"] == "In alpha" and "Ann" not in json.dumps(asked)
    buy = by_title["Confirm purchase: $40 at Books Ltd?"]
    assert buy["jarvis"]["kind"] == "approval" and aps(buy)["category"] == "JARVIS_HEADSUP"
    assert not any("secret" in c["raw"].decode() for c in s.curl.calls)
    for card in list(s.hub.approvals.values()):
        s.hub.resolve(card["id"], card["choices"][-1]["id"])
    await asyncio.gather(tool, plan, question, purchase)


async def test_nothing_is_pushed_while_the_owner_is_at_the_mac(setup):
    s = setup
    await ready(s)
    s.away["now"] = False
    s.hub.notify(Interruption("m:1", "message", "Message from Ann", "Ann: call me", urgent=True))
    await settle(s.hub)
    assert s.curl.calls == []
    s.hub.set_feature_prefs({companion_push.WHEN_PREF: "always"})  # Settings: always
    s.companion.notifier._away = None
    s.hub.notify(Interruption("m:2", "message", "Message from Ann", "Ann: call me", urgent=True))
    await settle(s.hub)
    assert len(s.curl.calls) == 1


# ── heads-ups ──


async def test_heads_ups_follow_each_phones_setting_and_hide_what_messages_say(setup):
    s = setup
    urgent_only, everything, none = await ready(s, "Urgent", "All", "Off")
    s.companion.store.set_settings(everything.id, {"headsups": "all"})
    s.companion.store.set_settings(none.id, {"headsups": "off"})
    s.hub.notify(
        Interruption(
            "message:41",
            "message",
            "Message from Ann",
            "Ann says it's urgent: the door code is 4411",
            urgent=True,
        )
    )
    s.hub.notify(Alert("rain:1", "rain", "Rain on the way", "Rain's likely around 4 PM."))
    await settle(s.hub)
    sent = {(c["token"][0], aps(c["payload"])["alert"]["title"]) for c in s.curl.calls}
    assert sent == {
        ("a", "Message from Ann"),
        ("b", "Message from Ann"),
        ("b", "Rain on the way"),
    }
    message = next(c for c in s.curl.calls if "Ann" in aps(c["payload"])["alert"]["title"])
    assert aps(message["payload"])["alert"]["body"] == "Urgent message"
    assert "4411" not in message["raw"].decode() and "door" not in message["raw"].decode()
    rain = next(c for c in s.curl.calls if "Rain" in aps(c["payload"])["alert"]["title"])
    assert aps(rain["payload"])["alert"]["body"] == "Rain's likely around 4 PM."
    assert rain["payload"]["jarvis"]["kind"] == "headsup"


async def test_quiet_hours_are_silent_except_urgent_and_vip(setup):
    s = setup
    [phone] = await ready(s)
    s.companion.store.set_settings(phone.id, {"headsups": "all"})
    s.quiet["now"] = True
    s.hub.notify(Alert("rain:2", "rain", "Rain on the way", "Rain soon."))
    s.hub.notify(
        Interruption("message:7", "message", "Message from Mum", "…", vip=True, breakthrough=True)
    )
    await settle(s.hub)
    by_title = {aps(c["payload"])["alert"]["title"]: c for c in s.curl.calls}
    rain = by_title["Rain on the way"]
    assert aps(rain["payload"])["interruption-level"] == "passive"
    assert "sound" not in aps(rain["payload"]) and "apns-priority: 5" in rain["headers"]
    vip = by_title["Message from Mum"]
    assert aps(vip["payload"])["sound"] == "default" and "apns-priority: 10" in vip["headers"]


async def test_the_same_push_goes_once_and_a_phone_gets_so_many_a_minute(setup):
    s = setup
    [phone] = await ready(s)
    s.companion.store.set_settings(phone.id, {"headsups": "all"})
    for _ in range(3):
        s.hub.notify(Alert("rain:3", "rain", "Rain on the way", "Rain soon."))
    await settle(s.hub)
    assert len(s.curl.calls) == 1
    for i in range(30):
        s.hub.notify(
            Alert(f"soon:{i}", "soon", f"Meeting {i}", f"Meeting {i} starts in 5 minutes.")
        )
    await settle(s.hub)
    assert len(s.curl.calls) <= 1 + companion_push.PUSH_RATE[1]


async def test_calls_voicemail_and_unknown_kinds(setup):
    s = setup
    [phone] = await ready(s)
    s.companion.store.set_settings(phone.id, {"headsups": "all"})
    s.hub.answering.log.calls = [
        SimpleNamespace(id="CA0000000000000000000000abcd1234", who=lambda: "Ann Lee")
    ]
    s.hub.notify(
        Alert("call:12345678", "call", "Phone call", "Ann picked up; the call lasted 42 seconds.")
    )
    s.hub.notify(
        Alert(
            "voicemail:abcd1234",
            "voicemail",
            "Voicemail",
            "Ann Lee left a message: the gate code is 99",
        )
    )
    s.hub.notify(Alert("webhook:1", "webhook", "Anyone's title", "Anyone's words"))
    await settle(s.hub)
    by_title = {aps(c["payload"])["alert"]["title"]: c for c in s.curl.calls}
    call = by_title["Phone call"]["payload"]
    assert aps(call)["alert"]["body"] == "Ann picked up; the call lasted 42 seconds."
    assert call["jarvis"]["kind"] == "call"
    voicemail = by_title["Voicemail"]
    assert aps(voicemail["payload"])["alert"]["body"] == "From Ann Lee"
    assert "gate code" not in voicemail["raw"].decode()
    unknown = by_title["Jarvis"]
    assert aps(unknown["payload"])["alert"]["body"] == "Something new on your Mac."
    assert "Anyone" not in unknown["raw"].decode()

    s.companion.store.set_settings(phone.id, {"calls": False})
    s.curl.calls.clear()
    s.hub.notify(Alert("call:99", "call", "Phone call", "Bo didn't answer."))
    await settle(s.hub)
    assert s.curl.calls == []


# ── Jarvis Code and conversations ──


async def test_jarvis_code_finishing_is_pushed_once_it_took_a_while(setup):
    s = setup
    await ready(s)
    emit = s.hub.tasks.emit  # the hub's, wrapped by the feature
    emit("task_finished", id=3, task_kind="code", status="done", folder="alpha", elapsed=5)
    emit("task_finished", id=4, task_kind="code", status="stopped", folder="alpha", elapsed=500)
    emit("task_finished", id=5, task_kind="research", status="done", folder="R", elapsed=500)
    await settle(s.hub)
    assert s.curl.calls == []  # a quick one, one the owner stopped, research
    emit("task_finished", id=6, task_kind="code", status="done", folder="alpha", elapsed=300,
         result="I read ~/.ssh/id_rsa and …")  # fmt: skip
    emit("task_finished", id=8, task_kind="code", status="failed", folder="beta", elapsed=2)
    await settle(s.hub)
    done, failed = sorted(s.curl.payloads(), key=lambda p: p["jarvis"]["task_id"])
    assert aps(done)["alert"] == {"title": "Jarvis Code finished", "body": "In alpha"}
    assert done["jarvis"] == {
        "kind": "code_done",
        "id": "code:6",
        "task_id": 6,
        "at": done["jarvis"]["at"],
    }
    assert aps(failed)["alert"]["title"] == "Jarvis Code stopped"
    assert not any("ssh" in c["raw"].decode() for c in s.curl.calls)
    # The session being voice-coded at the Mac speaks for itself.
    s.curl.calls.clear()
    s.hub.voicecode.focus = 9
    emit("task_finished", id=9, task_kind="code", status="done", folder="alpha", elapsed=300)
    await settle(s.hub)
    assert s.curl.calls == []


async def test_a_conversation_waiting_on_the_owner_is_pushed_once(setup):
    from jarvis.delegate import Delegation

    s = setup
    await ready(s)
    old = Delegation("d1", "Bo", "+15550001", "imessage", "Book lunch", status="waiting_owner")
    s.hub.delegations.items.append(old)
    s.companion.notifier.settle_delegations()  # waiting before: not news
    new = Delegation("d2", "Ann Lee", "+15550002", "imessage", "Move the dentist")
    s.hub.delegations.items.append(new)
    s.hub.notify(Alert("delegate:x", "delegate", "Conversation", "Ann said: 'my PIN is 1234'"))
    await settle(s.hub)
    assert s.curl.calls == []  # nothing waiting on the owner yet
    new.status = "waiting_owner"
    s.hub.notify(Alert("delegate:y", "delegate", "Conversation", "Ann said: 'my PIN is 1234'"))
    s.hub.notify(Alert("delegate:z", "delegate", "Conversation", "Still waiting"))
    await settle(s.hub)
    [note] = s.curl.payloads()
    assert aps(note)["alert"] == {
        "title": "Conversation with Ann Lee",
        "body": "It needs you before it goes on.",
    }
    assert note["jarvis"]["kind"] == "delegation" and note["jarvis"]["id"] == "d2"
    assert "1234" not in s.curl.calls[0]["raw"].decode()


# ── what Apple answers ──


async def test_a_phone_whose_app_is_gone_stops_being_sent_to(setup):
    s = setup
    phone, other = await ready(s, "Old iPhone", "iPad")
    s.curl.answers = [apns(410, "Unregistered"), apns(200)]
    q = s.hub.subscribe()
    results = await s.companion.notifier.test()
    assert sorted(results.values()) == ["gone", "sent"]
    gone = next(d for d, r in results.items() if r == "gone")
    assert s.companion.store.known(gone)["push"] is None
    statuses = [e for e in drain(q) if e["type"] == "companion"]
    device = next(d for d in statuses[-1]["devices"] if d["id"] == gone)
    assert device["push"] == {"registered": False, "environment": "", "since": "", "error": "gone"}
    s.curl.calls.clear()
    await s.companion.notifier.test()
    assert len(s.curl.calls) == 1  # only the one still registered


async def test_a_refused_key_shows_in_settings(setup):
    s = setup
    await ready(s)
    s.curl.answers = [apns(403, "InvalidProviderToken")]
    q = s.hub.subscribe()
    await s.companion.notifier.test()
    status = [e for e in drain(q) if e["type"] == "companion"][-1]
    assert status["push"]["configured"] and status["push"]["error"] == "InvalidProviderToken"


async def test_without_a_key_nothing_is_sent_or_asked(setup):
    s = setup
    await ready(s, key=False)
    asked = asyncio.create_task(s.hub.request_approval("Allow it?"))
    await asyncio.sleep(0)
    await settle(s.hub)
    assert s.curl.calls == []
    s.hub.resolve(next(iter(s.hub.approvals)), "deny")
    await asked


# ── Settings ──


async def test_settings_save_the_key_in_the_vault_and_never_show_it(setup, isolated):
    s = setup
    q = s.hub.subscribe()
    await s.hub._handle({"type": "companion_push_key", "key": "junk", "key_id": "ABC123DEFG"})
    assert "isn't a push key" in [e for e in drain(q) if e["type"] == "companion_push"][-1]["error"]
    key = p8()
    await s.hub._handle(
        {
            "type": "companion_push_key",
            "key": key,
            "key_id": "abc123defg",
            "team_id": "",
            "bundle_id": "",
        }
    )
    events = drain(q)
    assert any(e["type"] == "companion_push" and e.get("saved") for e in events)
    status = [e for e in events if e["type"] == "companion"][-1]
    assert status["push"]["configured"] and status["push"]["key_id"] == "ABC123DEFG"
    assert key.splitlines()[1] not in json.dumps(events)  # never back to the window
    stored = isolated["connectors"].vault.get(push.VAULT_ID, push.VAULT_KEY)
    assert json.loads(stored)["team_id"] == push.TEAM_DEFAULT
    await s.hub._handle({"type": "companion_push_forget"})
    assert isolated["connectors"].vault.get(push.VAULT_ID, push.VAULT_KEY) is None


async def test_settings_change_what_a_phone_is_sent(setup):
    s = setup
    [phone] = await ready(s)
    q = s.hub.subscribe()
    await s.hub._handle(
        {
            "type": "companion_device",
            "id": phone.id,
            "settings": {"headsups": "all", "code": False, "calls": "no"},
        }
    )
    await s.hub._handle({"type": "companion_device", "id": "nobody", "settings": {"code": False}})
    device = [e for e in drain(q) if e["type"] == "companion"][-1]["devices"][0]
    assert device["settings"] == {
        "approvals": True,
        "headsups": "all",
        "code": False,
        "delegations": True,
        "calls": True,  # "no" isn't a yes or no
    }
    assert s.companion.store.known("nobody") is None


async def test_a_test_push_goes_to_the_phone_asked_for_wherever_the_owner_is(setup):
    s = setup
    phone, other = await ready(s, "iPhone", "iPad")
    s.away["now"] = False
    q = s.hub.subscribe()
    await s.hub._handle({"type": "companion_push_test", "id": other.id})
    [event] = [e for e in drain(q) if e["type"] == "companion_push_test"]
    assert event["results"] == {other.id: "sent"}
    [call] = s.curl.calls
    assert aps(call["payload"])["alert"]["body"] == "Push notifications from this Mac work."
    assert "apns-expiration: 0" in call["headers"]


# ── the phone's side: registering ──


def test_a_phone_registers_its_token_and_the_state_says_so(setup):
    s = setup
    client = TestClient(
        remote.create_remote_app(s.hub, s.hub.remote.devices, extension=s.companion)
    )
    body = {"token": "AB" * 32, "environment": "sandbox", "bundle_id": BUNDLE}
    assert client.post("/api/push/register", json=body).status_code == 401
    token = client.post(
        "/api/pair", json={"code": s.hub.remote.devices.start_pairing(), "device_name": "iPhone"}
    ).json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/state", headers=auth).json()["push"] == {
        "enabled": False,
        "registered": False,
    }
    for bad, error in (
        ({**body, "token": "nothex"}, "token"),
        ({**body, "environment": "staging"}, "environment"),
        ({**body, "bundle_id": "not a bundle"}, "bundle_id"),
    ):
        reply = client.post("/api/push/register", json=bad, headers=auth)
        assert reply.status_code == 400 and reply.json() == {"error": error}
    assert client.post("/api/push/register", json=body, headers=auth).json() == {"ok": True}
    device = s.hub.remote.devices.check(token)
    assert s.companion.store.known(device.id)["push"]["token"] == "ab" * 32  # lower case
    assert client.get("/api/state", headers=auth).json()["push"]["registered"] is True
    assert client.post("/api/push/unregister", json={}, headers=auth).json() == {"ok": True}
    assert s.companion.store.known(device.id)["push"] is None
    assert client.post("/api/push/register", content=b"x" * 30_000, headers=auth).status_code == 413


async def test_the_store_keeps_each_phone_apart_and_reads_defensively(tmp_path):
    path = tmp_path / "companion.json"
    store = CompanionStore(path)
    store.register("d1", "ab" * 32, "production", BUNDLE)
    store.set_settings("d1", {"headsups": "off"})
    store.follow("d1", "code:3", "cd" * 32, 100.0)
    await store.saver.flush()
    again = CompanionStore(path)
    assert again.known("d1")["push"]["token"] == "ab" * 32
    assert again.known("d1")["settings"]["headsups"] == "off"
    assert again.known("d1")["live"] == {"code:3": {"token": "cd" * 32, "at": 100.0}}
    again.prune({"d2"})
    assert again.known("d1") is None
    # The file is edited by hand below: the store's own save of the prune (a thread of its
    # own) must be done first, or it can land after the edit and replace it.
    await again.saver.flush()
    path.write_text(
        json.dumps(
            {
                "devices": {
                    "ok": {
                        "push": {
                            "token": "ab" * 32,
                            "environment": "production",
                            "bundle_id": BUNDLE,
                        }
                    },
                    "bad": {
                        "push": {"token": "zz", "environment": "moon", "bundle_id": 5},
                        "settings": "x",
                    },
                    "7": "junk",
                },
                "health": {"2026-09-28": {"steps": 5}},
            }
        )
    )
    odd = CompanionStore(path)
    assert odd.known("ok")["push"]["environment"] == "production"
    assert odd.known("bad")["push"] is None and odd.known("bad")["settings"]["approvals"] is True
    assert odd.known("7") is None
    assert odd.extra("health") == {"2026-09-28": {"steps": 5}}  # the rest of the file is kept


def test_a_heads_up_heard_with_no_event_loop_leaves_nothing_unrun(
    settings, quiet_speaker, isolated, caplog
):
    """hub.notify is plain code, which a test (or any caller) may use with no event loop
    running. The app always calls it on its loop; here nothing can be pushed, so the
    notifier drops it quietly: no coroutine left never awaited, no failed sink logged."""
    import gc
    import warnings

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.prefs.proactive = True
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        hub.notify(Alert("rain:1", "rain", "Rain", "Rain in an hour."), speak=False)
        hub.notify(Alert("call:1", "call", "Call", "Ann called."), speak=False)
        gc.collect()
    assert not [w for w in caught if "never awaited" in str(w.message)]
    assert "sink failed" not in caplog.text
