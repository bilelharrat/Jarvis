"""The companion contract as the iPhone and Watch apps read it: the Mac's own JSON for every
endpoint, answered by the real routes (a real hub with the fake Claude, temp stores, git on
a temp folder, over "https" so the state says tls), kept in companion/Tests/Fixtures. The
Swift ContractFixtureTests decode those files with the apps' models and check every field
they read against them.

This test fails when the Mac's JSON changes shape (a key appears or goes, or its type
changes) until the fixtures are written again, and the Swift tests then say whether the apps
still read them:

    JARVIS_WRITE_CONTRACT=1 uv run python -m pytest tests/test_companion_contract.py
"""

import asyncio
import base64
import json
import os
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from starlette.testclient import TestClient
from test_companion_api import git, session
from test_companion_phone import picture
from test_hub import make_hub

from jarvis import companion_tls, remote
from jarvis.answering import Call
from jarvis.delegate import Delegation
from jarvis.interrupts import Announced, Item

FIXTURES = Path(__file__).resolve().parents[1] / "companion" / "Tests" / "Fixtures"
WRITE = os.environ.get("JARVIS_WRITE_CONTRACT") == "1"
TOKEN_STAND_IN = "test-token-not-a-secret"


def shape(value, path="$"):
    """Every key path with its JSON type ("$.sessions[].waiting.question: string"); a list's
    items are merged, so an optional key shows up once whichever item has it."""
    if isinstance(value, dict):
        out = {f"{path}: object"}
        for key, item in value.items():
            out |= shape(item, f"{path}.{key}")
        return out
    if isinstance(value, list):
        out = {f"{path}: array"}
        for item in value:
            out |= shape(item, f"{path}[]")
        return out
    kind = {bool: "bool", int: "number", float: "number", str: "string", type(None): "null"}
    return {f"{path}: {kind[type(value)]}"}


@pytest.fixture
def mac(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.remote.host, hub.remote.port, hub.remote.advertiser = "127.0.0.1", 0, None
    companion = hub.remote.extension
    companion.inbox_folder = tmp_path / "Inbox"
    identity = companion_tls.create(tmp_path / "tls")
    roomy = remote.Limiter({kind: (6000, 1000) for kind in remote.RATES})
    app = remote.create_remote_app(
        hub,
        hub.remote.devices,
        identity=identity,
        mac_name="Studio",
        extension=companion,
        gate=remote.Gate(hub.remote.devices, roomy),
    )
    client = TestClient(app, base_url="https://studio.local:8765")
    answers: dict[str, dict] = {}

    async def remote_ask(text, timeout=120, **ask):
        return json.loads(json.dumps(answers["next"]))

    return SimpleNamespace(
        hub=hub,
        companion=companion,
        identity=identity,
        client=client,
        app=app,
        answers=answers,
        fake_ask=remote_ask,
        fixtures={},
    )


def keep(mac, name, reply, status=200):
    assert reply.status_code == status, (name, reply.status_code, reply.text)
    body = reply.json()
    mac.fixtures[name] = {"status": status, "body": body}
    return body


async def test_every_answer_the_phone_reads_matches_its_fixture(mac, tmp_path, monkeypatch):
    hub, client = mac.hub, mac.client
    fingerprint = mac.identity.fingerprint

    # ── pairing ──
    keep(
        mac,
        "error_pair_fingerprint",
        client.post("/api/pair", json={"code": "000000", "fingerprint": "ab" * 32}),
        409,
    )
    hub.remote.devices.start_pairing()
    keep(mac, "error_pair_code", client.post("/api/pair", json={"code": "000000"}), 403)
    paired = keep(
        mac,
        "pair",
        client.post(
            "/api/pair",
            json={
                "code": hub.remote.devices.start_pairing(),
                "device_name": "Tony’s iPhone",
                "name": "Tony’s iPhone",
                "fingerprint": fingerprint,
            },
        ),
    )
    assert paired["fingerprint"] == fingerprint and paired["mac_name"] == "Studio"
    auth = {"Authorization": f"Bearer {paired['token']}"}

    def get(path):
        return client.get(path, headers=auth)

    def post(path, body):
        return client.post(path, json=body, headers=auth)

    keep(mac, "error_unpaired", client.get("/api/state"), 401)

    # ── what the Mac has going on ──
    repo = tmp_path / "suit"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "jarvis/login")
    (repo / "login.js").write_text("".join(f"line {i}\n" for i in range(20)))
    (repo / ".env").write_text("TOKEN=old\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "first")
    (repo / "login.js").write_text(
        "".join(f"line {i}\n" if i != 10 else "fixed\n" for i in range(20))
    )
    (repo / ".env").write_text("TOKEN=new\n")
    (repo / "login.test.js").write_text("test('works', () => {});\n")
    session(
        hub,
        4,
        repo,
        title="Fix the login bug",
        status="waiting",
        model_label="Sonnet",
        cost_usd=0.42,
        transcript=[
            {"n": 1, "role": "user", "text": "Fix the login bug.", "at": "2026-09-30T09:00:00"},
            {"n": 2, "role": "thinking", "text": "hmm", "at": "2026-09-30T09:00:02"},
            {
                "n": 3,
                "role": "tool",
                "text": "Read · login.js",
                "status": "done",
                "output": "\n".join(f"line {i}" for i in range(6)),
                "at": "2026-09-30T09:00:05",
            },
            {
                "n": 4,
                "role": "assistant",
                "text": "Fixed the handler.",
                "at": "2026-09-30T09:01:00",
            },
            {"n": 5, "role": "plan", "text": "1. Run the tests", "at": "2026-09-30T09:01:05"},
            {"n": 6, "role": "system", "text": "Interrupted.", "at": "2026-09-30T09:01:10"},
        ],
        todos=[
            {"content": "Fix the handler", "status": "completed"},
            {"content": "Run the tests", "status": "in_progress"},
        ],
    )
    session(hub, 5, tmp_path / "arc", title="Write the docs", busy=True)
    session(hub, 6, tmp_path / "tidy", title="Tidy imports", status="failed")
    hub.delegations.items += [
        Delegation(
            "d1",
            "Dr. Chen's office",
            "+15550001",
            "imessage",
            "Book a cleaning next week",
            created="2026-09-29T09:00:00",
            transcript=[{"from": "me", "text": "Hi", "at": "2026-09-30T08:00:00"}],
        ),
        Delegation(
            "d2",
            "Garage",
            "+15550002",
            "imessage",
            "Quote for tires",
            status="done",
            created="2026-09-01T09:00:00",
        ),
    ]
    mine = asyncio.create_task(hub.request_approval("Send the email to Pepper?", "Dinner at 8"))
    code = asyncio.create_task(
        hub.request_approval(
            "Jarvis Code in suit wants to run a command",
            "$ npm test",
            [("allow", "Yes"), ("deny", "No")],
            {"task_id": 4, "tool": "Bash"},
        )
    )
    await asyncio.sleep(0)
    cards = list(hub.approvals.values())
    jarvis_card = next(c for c in cards if not c.get("task_id"))
    code_card = next(c for c in cards if c.get("task_id"))
    hub.weather = {
        "city": "Malibu",
        "region": "California, United States",
        "temp": 21,
        "feels": 20,
        "humidity": 60,
        "wind": 12,
        "unit": "°C",
        "wind_unit": "km/h",
        "code": 1,
        "summary": "mainly clear",
        "high": 24,
        "low": 16,
        "rain_chance": 10,
        "tomorrow": {"high": 23, "low": 15, "rain_chance": 20, "summary": "partly cloudy"},
    }
    begin = (datetime.now() + timedelta(hours=2)).replace(second=0, microsecond=0)
    hub.status["next_event"] = {
        "title": "Design review",
        "begin": begin.isoformat(timespec="minutes"),
        "location": "Studio",
    }
    brief = hub.routines.add("Morning brief", "Give me my briefing", "weekdays", "07:00")
    hub.routines.add("Weekly review", "Review the week", "weekly", "16:00", days=[4])
    off = hub.routines.add("Portfolio check", "Check the portfolio", "weekly", "16:00", days=[0, 4])
    off.enabled = False
    hub.routines.add(
        "Welcome home",
        "Turn on the lights",
        "event",
        "",
        spec={"trigger": {"type": "place", "place": "home", "event": "arrive"}},
    )
    hub.routines.add(
        "Stretch",
        "Remind me to stretch",
        "interval",
        "",
        spec={"every": 60, "start": "09:00", "end": "17:00"},
    )
    hub.routines.add(
        "Dentist",
        "Remind me of the dentist",
        "once",
        "09:00",
        date=(date.today() + timedelta(days=2)).isoformat(),
    )
    hub.routines.save()

    # A real exchange through the fake Claude, for the history.
    done = await hub.remote_ask("What's next on my calendar today?", 20)
    assert done["done"] and done["reply"]

    assert post(
        "/api/push/register",
        {
            "token": "ab" * 32,
            "environment": "sandbox",
            "bundle_id": "com.bshventures.jarvis.companion",
        },
    ).json() == {"ok": True}
    state = keep(mac, "state", get("/api/state"))
    assert state["tls"] is True and state["pending_approvals"] == 2
    assert state["push"] == {"enabled": False, "registered": True}
    assert {s["status"] for s in state["code_sessions"]} == {"needs_you", "working", "failed"}
    assert state["history"] and state["weather"] and state["next_event"]

    # ── asking ──
    monkeypatch.setattr(hub, "remote_ask", mac.fake_ask)
    mac.answers["next"] = done
    keep(mac, "ask_done", post("/api/ask", {"text": "What's next on my calendar today?"}))
    mac.answers["next"] = {"reply": "", "done": False, "approvals": [jarvis_card]}
    keep(mac, "ask_needs_ok", post("/api/ask", {"text": "Email Pepper about dinner"}))
    mac.answers["next"] = {"reply": "", "done": False, "approvals": [], "busy": True}
    keep(mac, "error_busy", post("/api/ask", {"text": "And another thing"}), 429)
    keep(mac, "command", post("/api/command", {"type": "stop"}))

    # ── Jarvis Code ──
    keep(mac, "code_sessions", get("/api/code/sessions"))
    keep(mac, "code_session", get("/api/code/session?id=4"))
    keep(mac, "code_session_after", get("/api/code/session?id=4&after=4"))
    keep(mac, "code_diff", get("/api/code/diff?id=4"))
    keep(mac, "error_no_session", get("/api/code/session?id=99"), 404)
    unknown = get("/api/not-yet")  # an endpoint this Mac doesn't have: not JSON
    assert unknown.status_code == 404
    mac.fixtures["error_unknown_endpoint"] = {"status": 404, "text": unknown.text}
    monkeypatch.setattr(hub.tasks, "send", lambda task_id, text: True)

    async def interrupt(task_id):
        return True

    monkeypatch.setattr(hub.tasks, "interrupt", interrupt)
    keep(mac, "code_send", post("/api/code/send", {"id": 4, "text": "Also add a test"}))
    keep(mac, "code_stop", post("/api/code/stop", {"id": 5}))

    # ── what came in ──
    now = datetime.now()
    hub.interrupts._waiting = {
        i.key: i
        for i in (
            Item(
                "message",
                1,
                "+15550001",
                "Pepper",
                "Dinner moved to 8, at the usual place.",
                now - timedelta(hours=1),
                contact="Pepper Potts",
                score=4,
            ),
            Item(
                "mail",
                2,
                "happy@example.com",
                "Happy",
                "The car is ready",
                now - timedelta(hours=2),
                preview="The shop closes at 6",
                contact="Happy Hogan",
            ),
        )
    }
    hub.interrupts.told_back = [
        Announced(
            Item("message", 3, "+15550003", "Rhodey", "Running late", now - timedelta(minutes=5))
        )
    ]
    hub.answering.log.calls = [
        Call(
            "CA1",
            number="+15550009",
            name="Dr. Chen's office",
            at=(now - timedelta(hours=4)).isoformat(timespec="seconds"),
            kind="message",
            words="Confirming Thursday's cleaning at 10",
        ),
        Call(
            "CA2",
            number="+15550010",
            at=(now - timedelta(hours=5)).isoformat(timespec="seconds"),
            kind="missed",
        ),
    ]
    digest = keep(mac, "digest", get("/api/digest"))
    assert {i["kind"] for i in digest["items"]} == {"text", "email", "voicemail", "call"}
    keep(mac, "delegations", get("/api/delegations"))
    keep(mac, "delegation_stop", post("/api/delegations/stop", {"id": "d1"}))

    # ── spending and routines ──
    hub.transactions.ledger.record(
        "purchase", "Blue Bottle Coffee", 6.5, "USD", "https://x.example"
    )
    hub.transactions.ledger.record("transfer", "Pepper Potts", 40.0, "USD", "https://y.example")
    keep(mac, "spending", get("/api/spending"))
    routines = keep(mac, "routines", get("/api/routines"))
    assert {r["name"] for r in routines["items"] if r["next_run"] is None} >= {"Portfolio check"}
    keep(mac, "routine_update", post("/api/routines/update", {"id": brief.id, "enabled": False}))
    keep(mac, "error_no_routine", post("/api/routines/run", {"id": "gone"}), 404)

    # ── what the phone sends ──
    keep(
        mac,
        "location",
        post(
            "/api/location",
            {"lat": 34.03, "lon": -118.78, "accuracy": 35, "at": int(now.timestamp())},
        ),
    )
    keep(mac, "health", post("/api/health", {"day": date.today().isoformat(), "steps": 8123}))
    keep(
        mac,
        "live_register",
        post(
            "/api/live/register",
            {
                "activity": "code:4",
                "token": "cd" * 32,
                "environment": "sandbox",
                "bundle_id": "com.bshventures.jarvis.companion",
            },
        ),
    )
    keep(mac, "share", post("/api/share", {"kind": "url", "url": "https://example.com/article"}))
    mac.answers["next"] = {"reply": "", "done": False, "approvals": []}
    keep(
        mac,
        "share_asked",
        post(
            "/api/share", {"kind": "text", "text": "Notes from the call", "note": "Summarize this"}
        ),
    )
    keep(
        mac,
        "error_share_refused",
        post("/api/share", {"kind": "image", "data_base64": "aGVsbG8="}),
        400,
    )
    mac.answers["next"] = {"reply": "It's a cat.", "done": True, "approvals": []}
    jpeg = base64.b64encode(picture(tmp_path, 64, 48)).decode()
    keep(mac, "photo", post("/api/photo", {"data_base64": jpeg, "question": "What is this?"}))
    keep(mac, "approve", post("/api/approve", {"id": code_card["id"], "choice": "allow"}))
    keep(
        mac,
        "approve_gone",
        post("/api/approve", {"id": code_card["id"], "choice": "deny", "feedback": "Not now"}),
    )
    keep(
        mac,
        "error_too_big",
        client.post("/api/ask", content=b'{"text": "' + b"x" * 30_000 + b'"}', headers=auth),
        413,
    )
    keep(mac, "unregister", post("/api/push/unregister", {}))

    hub.resolve(jarvis_card["id"], "deny")
    await asyncio.gather(mine, code)

    # The pairing token is this test's own; the fixture carries a stand-in. A share is
    # saved where the Mac keeps them (~/Documents/Jarvis/Inbox), not in this test's folder.
    mac.fixtures["pair"]["body"]["token"] = TOKEN_STAND_IN
    inbox = str(mac.companion.inbox_folder)
    for fixture in mac.fixtures.values():
        body = fixture.get("body")
        if isinstance(body, dict) and isinstance(body.get("saved_as"), str):
            body["saved_as"] = body["saved_as"].replace(inbox, "~/Documents/Jarvis/Inbox")
    written = json.dumps(mac.fixtures)
    assert str(tmp_path) not in written and str(Path.home()) not in written
    if WRITE:
        FIXTURES.mkdir(parents=True, exist_ok=True)
        for name, fixture in mac.fixtures.items():
            text = json.dumps(fixture, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
            (FIXTURES / f"{name}.json").write_text(text)
    kept = {p.stem for p in FIXTURES.glob("*.json")}
    assert kept == set(mac.fixtures), (
        "fixtures missing or left over: write them again (see this file's docstring)",
        sorted(kept ^ set(mac.fixtures)),
    )
    for name, fixture in mac.fixtures.items():
        committed = json.loads((FIXTURES / f"{name}.json").read_text())
        assert committed["status"] == fixture["status"], name
        assert ("body" in committed) == ("body" in fixture), name
        changed = shape(fixture.get("body", fixture.get("text"))) ^ shape(
            committed.get("body", committed.get("text"))
        )
        assert not changed, (
            f"the Mac's answer for {name} changed shape: write the fixtures again and run the "
            "Swift ContractFixtureTests (see this file's docstring)",
            sorted(changed),
        )
