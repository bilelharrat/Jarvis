"""Eden Code on the phone (features/code_phone.py and _code_phone_routes.py): the page the
companion's server serves, its device-token calls behind the owner's switch, the live
transcript's long poll (new entries, changed ones, streamed words), the rules the page can't
get past (never Bypass, no yes on a Mac-only card, no landing past a secret), and Hand off
to phone's pin and push. A real hub with a fake Claude, Starlette's test client for the
phone, and fakes for the isolated copies and for curl (never the network)."""

from __future__ import annotations

import asyncio
import contextvars
import time
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient
from test_companion_api import api, session  # noqa: F401 (the fixture)
from test_companion_push import ready, settle, setup  # noqa: F401 (the fixture)

from jarvis import remote
from jarvis.features import code_phone
from jarvis.features._code_phone_routes import OFF

GETS = ["/api/code/phone/home", "/api/code/phone/options", "/api/code/phone/session?id=5"]
POSTS = [
    "/api/code/phone/send",
    "/api/code/phone/stop",
    "/api/code/phone/answer",
    "/api/code/phone/mode",
    "/api/code/phone/model",
    "/api/code/phone/new",
    "/api/code/phone/land",
    "/api/code/phone/discard",
    "/api/code/phone/unpin",
]


@pytest.fixture
def phone(api):  # noqa: F811
    api.hub.prefs.features[code_phone.PREF] = True
    return api


def test_every_call_needs_the_device_token_and_then_the_switch(api, tmp_path):  # noqa: F811
    session(api.hub, 5, tmp_path / "alpha")
    for path in GETS:
        assert api.client.get(path).status_code == 401, path
    for path in POSTS:
        assert api.client.post(path, json={"id": 5}).status_code == 401, path
    # Paired, but the owner hasn't turned the page on: refused, saying where to.
    for path in GETS:
        reply = api.get(path)
        assert reply.status_code == 403 and reply.json() == {"error": OFF, "off": True}, path
    for path in POSTS:
        assert api.post(path, {"id": 5}).status_code == 403, path


def test_the_page_installs_with_its_own_manifest_icon_and_worker(api):  # noqa: F811
    page = api.client.get("/code/")
    assert page.status_code == 200 and "Eden Code" in page.text
    assert "/code/phone.js" in page.text and "/code/manifest.webmanifest" in page.text
    csp = page.headers["content-security-policy"]
    assert "script-src 'self'" in csp and "default-src 'none'" in csp
    assert page.headers["referrer-policy"] == "no-referrer"
    assert page.headers["x-frame-options"] == "DENY"
    manifest = api.client.get("/code/manifest.webmanifest").json()
    assert manifest["scope"] == "/code/" and manifest["display"] == "standalone"
    assert manifest["icons"][0]["src"] == "/code/icon.png"
    assert api.client.get("/code/icon.png").headers["content-type"] == "image/png"
    worker = api.client.get("/code/sw.js")
    assert worker.status_code == 200 and "/api" in worker.text  # (it never keeps an answer)
    assert api.client.get("/code/phone.js").headers["content-type"].startswith("text/javascript")
    assert "Jarvis" not in page.text and "Eden Secretary" not in page.text


def test_the_long_poll_sends_new_entries_then_the_ones_that_changed(phone, tmp_path):
    task = session(phone.hub, 5, tmp_path / "alpha")
    task.transcript = [
        {"n": 1, "role": "user", "text": "fix it", "at": "2026-10-15T10:00:00"},
        {"n": 2, "role": "tool", "text": "Bash make test", "status": "running", "at": ""},
    ]
    first = phone.get("/api/code/phone/session?id=5&wait=0").json()
    assert [e["i"] for e in first["entries"]] == [1, 2] and first["next"] == 2
    assert first["changed"] == [] and first["v"]
    # Nothing new: the same answer's v, and no entries.
    again = phone.get(
        f"/api/code/phone/session?id=5&after=2&seen={first['seen']}&v={first['v']}&wait=0"
    ).json()
    assert again["entries"] == [] and again["changed"] == [] and again["v"] == first["v"]
    # The step's outcome comes in after its entry was sent (tasks._tool_result marks it): the
    # phone gets it again, so the step doesn't stay "running" there (the round 2 fix).
    task.transcript[1].update(status="done", output="3 passed", updated=time.time_ns())
    later = phone.get(
        f"/api/code/phone/session?id=5&after=2&seen={first['seen']}&v={first['v']}&wait=0"
    ).json()
    assert [e["i"] for e in later["changed"]] == [2] and "3 passed" in later["changed"][0]["text"]
    assert later["entries"] == [] and later["seen"] > first["seen"]
    assert phone.get("/api/code/phone/session?id=99").status_code == 404


async def test_a_waiting_request_answers_when_something_moves(phone, tmp_path):
    hub = phone.hub
    task = session(hub, 5, tmp_path / "alpha", busy=True)
    view = hub.code_phone.view(task, 0, 0)

    async def later():
        await asyncio.sleep(0.3)
        hub.emit("task_stream", id=5, part="text", text="Looking at ")
        hub.emit("task_stream", id=5, part="text", text="the login code")

    started = time.monotonic()
    mover = asyncio.ensure_future(later())
    found = await hub.code_phone.watch(5, view["next"], view["seen"], view["v"], 10)
    await mover
    assert time.monotonic() - started < 3  # (not the whole wait)
    assert found["live"] == "Looking at the login code"
    # The reply's own entry replaces its streamed words.
    hub.emit("task_log", id=5, entry={"n": 1, "role": "assistant", "text": "Done."})
    assert hub.code_phone.view(task, 0, 0)["live"] == ""
    # Nothing moving: it answers when its time is up, with nothing new.
    still = hub.code_phone.view(task, 0, 0)
    quiet = await hub.code_phone.watch(5, still["next"], still["seen"], still["v"], 0.5)
    assert quiet["v"] == still["v"]


def test_a_phone_waits_on_only_a_few_at_once(phone, tmp_path):
    session(phone.hub, 5, tmp_path / "alpha")
    first = phone.get("/api/code/phone/session?id=5").json()
    device = phone.hub.remote.devices.items[0]
    phone.hub.code_phone.waits[device.id] = code_phone.WAITS_PER_DEVICE
    started = time.monotonic()
    reply = phone.get(
        f"/api/code/phone/session?id=5&after={first['next']}&seen={first['seen']}&v={first['v']}&wait=25"
    )
    assert reply.status_code == 200 and time.monotonic() - started < 5  # answered at once


def test_reads_and_actions_have_their_budgets(phone, tmp_path):
    session(phone.hub, 5, tmp_path / "alpha")
    gate = remote.Gate(phone.hub.remote.devices, remote.Limiter({"read": (60, 2), "act": (60, 2)}))
    client = TestClient(remote.create_remote_app(phone.hub, phone.hub.remote.devices, gate=gate,
                                                 extension=phone.companion))  # fmt: skip
    codes = [client.get("/api/code/phone/home", headers=phone.auth).status_code for _ in range(3)]
    assert codes == [200, 200, 429]
    codes = [client.post("/api/code/phone/stop", json={"id": 5}, headers=phone.auth).status_code
             for _ in range(3)]  # fmt: skip
    assert codes[-1] == 429
    big = phone.client.post("/api/code/phone/stop", content=b'{"id": 5, "x": "' + b"x" * 30_000 + b'"}',
                            headers=phone.auth)  # fmt: skip
    assert big.status_code == 413


def test_never_bypass_from_the_page(phone, tmp_path, monkeypatch):
    task = session(phone.hub, 5, tmp_path / "alpha")
    modes = []
    monkeypatch.setattr(
        phone.hub.tasks,
        "set_mode",
        lambda tid, mode: modes.append(mode) or setattr(task, "mode", mode),
    )
    for mode in ("auto", "smart", "plan", "bogus"):
        reply = phone.post("/api/code/phone/mode", {"id": 5, "mode": mode})
        assert (
            reply.status_code == 400
            and "Bypass permissions only on the Mac" in reply.json()["error"]
        )
    assert modes == []
    assert phone.post("/api/code/phone/mode", {"id": 5, "mode": "edits"}).json()["ok"] is True
    assert modes == ["edits"]


def test_a_new_session_always_names_its_mode(phone, tmp_path, monkeypatch):
    """A project (or everyone's) default of Bypass never carries into a session started here:
    the mode is always Manual or Accept edits, named."""
    phone.hub.prefs.code_mode = "auto"
    started = []

    def start(prompt, directory, **kw):
        started.append(kw["mode"])
        return session(phone.hub, 42, tmp_path / "alpha", launch_token=kw["launch_token"])

    monkeypatch.setattr(phone.hub.tasks, "start", start)
    reply = phone.post("/api/code/phone/new", {"prompt": "fix the login", "directory": "alpha"})
    assert reply.json() == {"ok": True, "id": 42} and started == ["ask"]
    refused = phone.post(
        "/api/code/phone/new", {"prompt": "x", "directory": "alpha", "mode": "auto"}
    )
    assert refused.status_code == 400 and started == ["ask"]
    assert (
        phone.post("/api/code/phone/new", {"prompt": "", "directory": "alpha"}).status_code == 400
    )
    options = phone.get("/api/code/phone/options").json()
    assert [m["id"] for m in options["modes"]] == ["ask", "edits"]
    assert options["defaults"]["mode"] == "ask"  # (everyone's is Bypass: not offered here)


def test_models_are_eden_chats_list_and_one_needing_a_key_is_refused(phone, tmp_path, monkeypatch):
    session(phone.hub, 5, tmp_path / "alpha")
    models = phone.get("/api/code/phone/options").json()["models"]
    names = [m["name"] for m in models]
    assert names[:2] == ["Claude Opus 5.5", "Claude Sonnet 5.5"] and "Kimi K3" in names
    keyless = next(m for m in models if m["needs_key"])
    assert phone.post("/api/code/phone/model", {"id": 5, "ref": keyless["ref"]}).status_code == 400
    assert phone.post("/api/code/phone/model", {"id": 5, "ref": "nope"}).status_code == 400
    switched = []

    async def task_model(task_id, ref):
        switched.append((task_id, ref))
        phone.hub.emit("caption", text="Now on Sonnet 5.5.")

    monkeypatch.setattr(phone.hub, "_task_model", task_model)
    reply = phone.post("/api/code/phone/model", {"id": 5, "ref": models[1]["ref"]}).json()
    assert reply == {"ok": True, "said": "Now on Sonnet 5.5."} and switched == [
        (5, models[1]["ref"])
    ]


def _card(hub, **fields):
    card = {"id": fields.pop("id", "c1"), "question": "Run this?", "detail": "",
            "choices": [{"id": "allow", "label": "Allow"}, {"id": "deny", "label": "Not now"}], **fields}  # fmt: skip
    hub.approvals[card["id"]] = card
    hub._futures[card["id"]] = asyncio.get_event_loop_policy().new_event_loop().create_future()
    return card


def test_a_mac_only_card_takes_a_no_from_the_phone_never_a_yes(phone, tmp_path):
    session(phone.hub, 5, tmp_path / "alpha")
    _card(phone.hub, id="risky", task_id=5, tool="Bash", detail="$ rm -rf ~/work")
    _card(phone.hub, id="plain", task_id=5, tool="Bash", detail="$ ls")
    _card(phone.hub, id="mail", question="Send this to Ann?")  # (not Eden Code's)
    shown = {c["id"]: c for c in phone.get("/api/code/phone/home").json()["attention"]}
    assert shown["risky"]["mac_only"] is True and shown["plain"]["mac_only"] is False
    assert "mail" not in shown
    refused = phone.post("/api/code/phone/answer", {"approval": "risky", "choice": "allow"})
    assert refused.status_code == 403 and "Touch ID" in refused.json()["error"]
    assert phone.post("/api/code/phone/answer", {"approval": "risky", "choice": "deny"}).json() == {
        "ok": True
    }
    assert phone.post(
        "/api/code/phone/answer", {"approval": "plain", "choice": "allow"}
    ).json() == {"ok": True}
    assert (
        phone.post("/api/code/phone/answer", {"approval": "mail", "choice": "allow"}).status_code
        == 404
    )
    view = phone.get("/api/code/phone/session?id=5").json()
    assert view["status"] in ("needs_you", "idle")


def _fake_copy(hub, task, monkeypatch, *, findings=(), busy=False):
    copy = SimpleNamespace(slug="s1", branch="eden/fix-login", into="main", repo="r")
    desk = hub.code_desk
    monkeypatch.setattr(desk, "_copy_of", lambda t: copy if t is task else None)
    monkeypatch.setattr(desk, "tasks_in", lambda c: [task])
    monkeypatch.setattr(desk, "working_in", lambda slug: False)
    monkeypatch.setattr(desk, "_scan_copy", lambda c: list(findings))
    monkeypatch.setattr(desk, "_reply", lambda coro: coro)  # (the spawn below closes it)
    task.busy = busy
    spawned = []

    def spawn(coro):
        spawned.append(contextvars.copy_context())
        coro.close()

    monkeypatch.setattr(hub, "_spawn", spawn)
    return copy, spawned


def test_land_is_refused_while_working_or_past_a_secret(phone, tmp_path, monkeypatch):
    task = session(phone.hub, 5, tmp_path / "alpha")
    _copy, spawned = _fake_copy(phone.hub, task, monkeypatch, busy=True)
    assert phone.post("/api/code/phone/land", {"id": 5}).status_code == 409
    task.busy = False
    monkeypatch.setattr(phone.hub.code_desk, "_scan_copy", lambda c: ["a key"])
    refused = phone.post("/api/code/phone/land", {"id": 5})
    assert refused.status_code == 403 and "secrets" in refused.json()["error"] and spawned == []
    # Discard keeps the work (30 days): only its own card asks.
    assert phone.post("/api/code/phone/discard", {"id": 5}).json()["ok"] is True
    assert spawned[0][code_phone._COPY] == "s1"  # (its card is the phone's to answer)
    view = phone.get("/api/code/phone/session?id=5").json()
    assert view["copy"] == {"branch": "eden/fix-login", "into": "main", "busy": False}


def test_land_puts_up_its_card_for_the_phone(phone, tmp_path, monkeypatch):
    task = session(phone.hub, 5, tmp_path / "alpha")
    _copy, spawned = _fake_copy(phone.hub, task, monkeypatch)
    reply = phone.post("/api/code/phone/land", {"id": 5}).json()
    assert reply == {"ok": True, "said": "Confirm on its card."}
    assert spawned[0][code_phone._COPY] == "s1"
    assert phone.post("/api/code/phone/land", {"id": 99}).status_code == 404
    other = session(phone.hub, 6, tmp_path / "beta")
    assert phone.post("/api/code/phone/land", {"id": other.id}).status_code == 400  # (no copy)


async def test_a_landing_card_with_a_secret_on_it_is_the_macs(phone, tmp_path, monkeypatch):
    hub = phone.hub
    task = session(hub, 5, tmp_path / "alpha")
    monkeypatch.setattr(
        hub.code_desk, "_copy_of", lambda t: SimpleNamespace(slug="s1") if t is task else None
    )
    marked = code_phone._COPY.set("s1")
    try:
        asked = asyncio.ensure_future(
            hub.code_desk.ask(
                "Land eden/x in main?", "", [("land", "Land anyway"), ("deny", "Don't land")]
            )
        )
        await asyncio.sleep(0)
    finally:
        code_phone._COPY.reset(marked)
    [card] = [c for c in hub.approvals.values() if c["question"].startswith("Land")]
    shown = hub.code_phone.cards_for(task)
    assert shown and shown[0]["copy"] == "s1" and shown[0]["mac_only"] is True
    hub.resolve(card["id"], "deny")
    assert await asked == "deny"
    assert hub.code_phone.copy_cards == {}


def test_send_and_stop_go_to_the_session(phone, tmp_path, monkeypatch):
    session(phone.hub, 5, tmp_path / "alpha")
    sent, stopped = [], []
    monkeypatch.setattr(
        phone.hub.tasks, "send", lambda tid, text, *a, **k: sent.append((tid, text)) or True
    )

    async def interrupt(tid):
        stopped.append(tid)
        return True

    monkeypatch.setattr(phone.hub.tasks, "interrupt", interrupt)
    assert phone.post("/api/code/phone/send", {"id": 5, "text": "  and the docs "}).json() == {
        "ok": True
    }
    assert phone.post("/api/code/phone/send", {"id": 5, "text": " "}).status_code == 400
    assert phone.post("/api/code/phone/stop", {"id": 5}).json() == {"ok": True}
    assert sent == [(5, "and the docs")] and stopped == [5]
    actions = [i["action"] for i in phone.companion.audit.items]
    assert "code_sent" in actions and "code_stopped" in actions


def test_exterminator_runs_show_where_they_are(phone, tmp_path):
    from jarvis.features.code_bugfix import BugRun, Finding

    bugfix = phone.hub.code_bugfix
    bugfix._loaded = True
    run = BugRun(
        id="r1", project="alpha", round=2, step="fix", spent=1.234, spend_cap=10, task_id=5
    )
    run.findings = [Finding("f1", 1, "sweep", "security", "high", "a.py", 3, "x", "y", status="fixed"),
                    Finding("f2", 1, "sweep", "tests", "low", "b.py", 4, "x", "y")]  # fmt: skip
    bugfix.runs = [run]
    [shown] = phone.get("/api/code/phone/home").json()["exterminator"]
    assert shown["round"] == 2 and shown["step"] == "fix" and shown["spent"] == 1.23
    assert shown["found"] == 2 and shown["fixed"] == 1 and shown["open"] == 1


# ── Hand off to phone ──


async def test_hand_off_pins_the_session_and_pushes_its_link_now(setup, tmp_path):  # noqa: F811
    s = setup
    hub = s.hub
    hub.prefs.features[code_phone.PREF] = True
    hub.remote._task = SimpleNamespace(done=lambda: False)
    hub.remote.host_name, hub.remote.port = "studio", 8765
    [device] = await ready(s)
    s.companion.store.set_settings(device.id, {"code": False})  # (its own setting says no)
    s.away["now"] = False  # the owner is at the Mac: they asked, so it goes anyway
    session(hub, 5, tmp_path / "alpha", title="Login fix")
    events = []
    hub.add_event_sink(("code_phone",), events.append)
    await hub.handle({"type": "code_phone_handoff", "id": 5})
    await settle(hub)
    [call] = s.curl.calls
    payload = call["payload"]
    assert payload["jarvis"]["kind"] == "code_done" and payload["jarvis"]["task_id"] == 5
    assert payload["jarvis"]["handoff"] is True
    assert payload["jarvis"]["link"] == "jarvis-companion://code/5"
    assert payload["jarvis"]["url"] == "https://studio.local:8765/code/#s=5"
    assert payload["aps"]["alert"]["title"] == "Carry on from your phone"
    assert "Login fix" not in call["raw"].decode()  # (a push never carries a session's words)
    assert hub.code_phone.pinned["id"] == 5
    last = events[-1]
    assert last["pinned"]["title"] == "Login fix" and last["pushed"]["sent"] == 1
    assert last["url"] == "https://studio.local:8765/code/" and last["qr"]
    await hub.handle({"type": "code_phone_unpin"})
    assert hub.code_phone.pinned is None


async def test_hand_off_without_a_phone_for_notifications_says_so(setup, tmp_path):  # noqa: F811
    s = setup
    hub = s.hub
    hub.remote._task = SimpleNamespace(done=lambda: False)
    hub.remote.host_name = "studio"
    session(hub, 5, tmp_path / "alpha")
    events = []
    hub.add_event_sink(("code_phone",), events.append)
    await hub.handle({"type": "code_phone_handoff", "id": 5})
    await settle(hub)
    assert s.curl.calls == []
    assert events[-1]["pushed"]["sent"] == 0 and "open the link" in events[-1]["pushed"]["said"]
    assert events[-1]["url"] == ""  # (the page is off: no link to give)
    hub.remote._task = None
    await hub.handle({"type": "code_phone_handoff", "id": 5})
    await settle(hub)
    assert "Turn on the phone companion" in events[-1]["pushed"]["said"]


def test_the_phone_opens_what_was_handed_off(phone, tmp_path):
    session(phone.hub, 5, tmp_path / "alpha", title="Login fix")
    assert phone.get("/api/code/phone/home").json()["pinned"] is None
    phone.hub.code_phone.pinned = {"id": 5, "title": "Login fix", "at": 1}
    assert phone.get("/api/code/phone/home").json()["pinned"]["id"] == 5
    assert phone.post("/api/code/phone/unpin", {}).json() == {"ok": True}
    assert phone.hub.code_phone.pinned is None
