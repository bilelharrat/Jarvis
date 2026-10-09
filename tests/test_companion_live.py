"""Live Activities kept current from the Mac (jarvis.companion_live): registered by the
app, updated as what they follow changes (progress at most every 15 seconds, needing
the owner at once), ended when it's over. curl is faked: no network."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient
from test_hub import make_hub
from test_push import apns, curl_options, p8

from jarvis import companion_live, push, remote
from jarvis.delegate import Delegation
from jarvis.proactive import Alert
from jarvis.tasks import ClaudeTask

BUNDLE = "com.askeden.jarvis"


class Curl:
    def __init__(self):
        self.calls, self.answers = [], []

    async def __call__(self, argv, stdin, timeout):
        options = curl_options(stdin)
        self.calls.append(
            {
                "token": options["url"][0].rsplit("/", 1)[-1],
                "host": options["url"][0].split("/")[2],
                "headers": options["header"],
                "payload": json.loads(options["data-binary"][0]),
            }
        )
        return self.answers.pop(0) if self.answers else apns(200)


@pytest.fixture
def live(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.remote.host, hub.remote.port, hub.remote.advertiser = "127.0.0.1", 0, None
    companion = hub.remote.extension
    curl = Curl()
    companion.sender.run = curl
    clock = {"now": 1_800_000_000.0}
    companion.live.clock = lambda: clock["now"]
    client = TestClient(remote.create_remote_app(hub, hub.remote.devices, extension=companion))
    token = client.post(
        "/api/pair", json={"code": hub.remote.devices.start_pairing(), "device_name": "iPhone"}
    ).json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    device = hub.remote.devices.check(token)
    return SimpleNamespace(
        hub=hub, companion=companion, curl=curl, clock=clock, client=client, auth=auth,
        device=device, tmp=tmp_path,
        post=lambda path, body: client.post(path, json=body, headers=auth),
    )  # fmt: skip


async def keyed(s, environment="production"):
    await s.companion.keys.save(push.check(p8(), "ABC123DEFG", "8CV4X23Y2T", BUNDLE))
    s.companion.store.register(s.device.id, "ab" * 32, environment, BUNDLE)


def code_task(s, task_id=3, **fields):
    folder = s.tmp / "alpha"
    folder.mkdir(exist_ok=True)
    task = ClaudeTask(id=task_id, prompt="Fix the parser for Ann's email", cwd=folder)
    for key, value in fields.items():
        setattr(task, key, value)
    s.hub.tasks.tasks[task_id] = task
    return task


def test_the_app_registers_what_it_follows(live):
    s = live
    body = {"activity": "code:3", "token": "CD" * 32}
    assert s.client.post("/api/live/register", json=body).status_code == 401
    assert s.post("/api/live/register", body).json() == {"ok": True}
    followed = s.companion.store.known(s.device.id)["live"]
    assert followed["code:3"]["token"] == "cd" * 32
    for bad, what in (
        ({"activity": "photo:1", "token": "cd" * 32}, "activity"),
        ({"activity": "code:../1", "token": "cd" * 32}, "activity"),
        ({"activity": "code:", "token": "cd" * 32}, "activity"),
        ({"activity": "code:3", "token": "xyz"}, "token"),
        ({"activity": "code:3", "token": "cd" * 32, "environment": "moon"}, "environment"),
    ):
        reply = s.post("/api/live/register", bad)
        assert reply.status_code == 400 and reply.json() == {"error": what}, bad
    for i in range(10):  # a phone follows a few at a time: the oldest goes
        s.post("/api/live/register", {"activity": f"video:{i}", "token": "ef" * 32})
    assert len(s.companion.store.known(s.device.id)["live"]) == 8


async def test_a_code_session_is_followed_to_its_end(live):
    s = live
    await keyed(s)
    task = code_task(
        s,
        busy=True,
        last_action="Running curl https://x/?token=secret",
        todos=[{"content": "a", "status": "completed"}, {"content": "b", "status": "pending"}],
    )
    s.post("/api/live/register", {"activity": "code:3", "token": "cd" * 32})
    assert await s.companion.live.tick() == [(s.device.id, "code:3", "update")]
    [call] = s.curl.calls
    assert call["token"] == "cd" * 32 and call["host"] == "api.push.apple.com"
    assert f"apns-topic: {BUNDLE}.push-type.liveactivity" in call["headers"]
    assert (
        "apns-push-type: liveactivity" in call["headers"] and "apns-priority: 10" in call["headers"]
    )
    aps = call["payload"]["aps"]
    assert aps["event"] == "update" and aps["timestamp"] == 1_800_000_000
    assert aps["content-state"] == {
        "title": "Eden Code · alpha",
        "status": "Working",
        "detail": "Running a command",  # never the command itself
        "needsYou": False,
        "updatedAt": 1_800_000_000,
        "progress": 0.5,
    }
    assert "secret" not in json.dumps(call) and "Ann" not in json.dumps(call)

    assert await s.companion.live.tick() == []  # nothing new
    task.last_action = "Editing parser.py"
    s.clock["now"] += 5
    assert await s.companion.live.tick() == []  # progress waits its turn
    s.clock["now"] += 15
    assert await s.companion.live.tick() == [(s.device.id, "code:3", "update")]
    state = s.curl.calls[-1]["payload"]["aps"]["content-state"]
    assert (
        state["detail"] == "Editing parser.py" and "apns-priority: 5" in s.curl.calls[-1]["headers"]
    )

    asked = asyncio.create_task(
        s.hub.request_approval(
            "Eden Code in alpha wants to run a command",
            "$ ls",
            [("allow", "Yes"), ("deny", "No")],
            {"task_id": 3},
        )
    )
    await asyncio.sleep(0)
    s.clock["now"] += 1  # needing the owner goes at once
    assert await s.companion.live.tick() == [(s.device.id, "code:3", "update")]
    state = s.curl.calls[-1]["payload"]["aps"]["content-state"]
    assert state["needsYou"] is True and state["status"] == "Needs you"
    s.hub.resolve(next(iter(s.hub.approvals)), "allow")
    await asked

    task.status, task.busy = "closed", False
    s.clock["now"] += 1
    assert await s.companion.live.tick() == [(s.device.id, "code:3", "end")]
    end = s.curl.calls[-1]["payload"]["aps"]
    assert end["event"] == "end" and end["dismissal-date"] == int(s.clock["now"]) + 15 * 60
    assert s.companion.store.known(s.device.id)["live"] == {}  # let go
    assert await s.companion.live.tick() == []


async def test_a_conversation_a_video_and_a_call(live):
    s = live
    await keyed(s, environment="sandbox")
    d = Delegation(
        "d1",
        "Ann Lee",
        "+15550001",
        "imessage",
        "Move the dentist",
        transcript=[{"from": "them", "text": "My PIN is 1234", "at": "t"}],
    )
    s.hub.delegations.items.append(d)
    job = SimpleNamespace(
        title="Q3 all-hands", state="transcribing", active=True, progress=lambda: 0.42
    )
    s.hub.video.jobs[7] = job
    for activity in ("delegation:d1", "video:7", "call:abcd1234"):
        s.post("/api/live/register", {"activity": activity, "token": "cd" * 32})
    sent = await s.companion.live.tick()
    assert sorted(a for _, a, _ in sent) == ["call:abcd1234", "delegation:d1", "video:7"]
    states = {c["payload"]["aps"]["content-state"]["title"]: c for c in s.curl.calls}
    talk = states["Conversation with Ann Lee"]
    assert talk["host"] == "api.sandbox.push.apple.com"  # as the phone's build registered
    assert talk["payload"]["aps"]["content-state"]["detail"] == "1 message"
    assert "1234" not in json.dumps(talk)
    video = states["Q3 all-hands"]["payload"]["aps"]["content-state"]
    assert video["status"] == "Transcribing" and video["progress"] == 0.42
    assert states["Phone call"]["payload"]["aps"]["content-state"]["status"] == "Calling"

    d.status = "waiting_owner"
    job.state, job.active = "ready", False
    s.hub.notify(
        Alert("call:abcd1234", "call", "Phone call", "Ann picked up; the call lasted 42 seconds.")
    )
    s.clock["now"] += 1
    sent = await s.companion.live.tick()
    assert sorted((a, e) for _, a, e in sent) == [
        ("call:abcd1234", "end"),
        ("delegation:d1", "update"),
        ("video:7", "end"),
    ]
    last = {
        c["payload"]["aps"]["content-state"]["title"]: c["payload"]["aps"]
        for c in s.curl.calls[-3:]
    }
    assert (
        last["Phone call"]["content-state"]["detail"]
        == "Ann picked up; the call lasted 42 seconds."
    )
    assert last["Conversation with Ann Lee"]["content-state"]["needsYou"] is True


async def test_a_gone_token_and_an_old_one_are_let_go(live):
    s = live
    await keyed(s)
    code_task(s, busy=True)
    s.post("/api/live/register", {"activity": "code:3", "token": "cd" * 32})
    s.curl.answers = [apns(410, "Unregistered")]
    assert await s.companion.live.tick() == []
    assert s.companion.store.known(s.device.id)["live"] == {}
    s.post("/api/live/register", {"activity": "code:3", "token": "ee" * 32})
    s.clock["now"] += 13 * 3600  # past what iOS keeps an activity for
    assert await s.companion.live.tick() == [(s.device.id, "code:3", "end")]
    assert s.companion.store.known(s.device.id)["live"] == {}


async def test_an_activity_apple_keeps_refusing_is_let_go(live):
    s = live
    await keyed(s)
    code_task(s, busy=True)
    s.post("/api/live/register", {"activity": "code:3", "token": "cd" * 32})
    s.curl.answers = [apns(400, "BadTopic")] * 3
    for _ in range(3):
        assert await s.companion.live.tick() == []
    assert s.companion.store.known(s.device.id)["live"] == {}  # three tries, then let go
    assert len(s.curl.calls) == 3


async def test_nothing_is_pushed_without_a_key_and_an_unpaired_phone_is_forgotten(live):
    s = live
    code_task(s, busy=True)
    s.post("/api/live/register", {"activity": "code:3", "token": "cd" * 32})
    assert await s.companion.live.tick() == [] and s.curl.calls == []
    await keyed(s)
    s.hub.remote.devices.remove(s.device.id)
    assert await s.companion.live.tick() == []
    assert s.companion.store.known(s.device.id)["live"] == {}


async def test_something_gone_ends_its_activity(live):
    s = live
    await keyed(s)
    for activity in ("code:99", "delegation:nope", "video:5"):
        s.post("/api/live/register", {"activity": activity, "token": "cd" * 32})
    sent = await s.companion.live.tick()
    assert sorted(e for _, _, e in sent) == ["end", "end", "end"]


async def test_the_loop_wakes_when_poked(live, monkeypatch):
    s = live
    monkeypatch.setattr(companion_live, "TICK_SECONDS", 30)
    ticks = []

    async def tick():
        ticks.append(1)
        return []

    monkeypatch.setattr(s.companion.live, "tick", tick)
    runner = asyncio.create_task(s.companion.live.loop())
    await asyncio.sleep(0.05)
    assert ticks == [1]
    s.companion.live.poke()  # a card went up: look now, not in thirty seconds
    await asyncio.sleep(0.05)
    assert ticks == [1, 1]
    runner.cancel()
    with pytest.raises(asyncio.CancelledError):
        await runner


def test_the_state_is_in_the_macs_language(live):
    s = live
    s.hub.prefs.language = "zh"
    code_task(s, busy=True, last_action="Reading hub.py")
    state, ended = s.companion.live.state_for("code:3", 0, 5)
    assert state["status"] == "进行中" and state["detail"] == "正在读取 hub.py" and not ended


def test_follow_records_survive_a_restart(live):
    s = live
    s.post(
        "/api/live/register",
        {"activity": "code:3", "token": "cd" * 32, "environment": "sandbox", "bundle_id": BUNDLE},
    )
    asyncio.run(s.companion.flush())
    saved = json.loads(Path(s.companion.store.path).read_text())
    assert saved["devices"][s.device.id]["live"]["code:3"]["environment"] == "sandbox"
