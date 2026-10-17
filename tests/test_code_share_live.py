"""Share live's links through askeden.com (features/code_share_live.py, share_seal.py):
registered with the Mac's own account, pushed sealed over the relay's control line (a frame
opens with the link's key and nothing else, in its own place only), split and joined, stopped
and revoked with the share; and what comes back up (a viewer's sealed message) dropped unless
it opens with the key for exactly its id, is new, is on time, and names a right secret. The
relay and the account are fakes; the sealing is real."""

import asyncio
import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from test_code_share import AWS, KEY, hub, latest, projects, session  # noqa: F401 (fixtures)

from jarvis import share_seal
from jarvis.account import AccountError
from jarvis.companion_api import session_status
from jarvis.features import code_share, code_share_live
from jarvis.features.code_share_drive import PREF_DRIVERS
from jarvis.relay import Relay

VECTOR = json.loads((Path(__file__).parent / "fixtures" / "share_seal_vector.json").read_text())


class FakeAccount:
    def __init__(self, refuse=None):
        self.linked = True
        self.web_base = "https://askeden.com"
        self.calls = []
        self.refuse = refuse

    async def call(self, method, path, *, body=None, ok=(200, 204), **_):
        self.calls.append((method, path, body))
        if self.refuse:
            raise AccountError(*self.refuse)
        return {}


class FakeLine:
    """The relay as code_share_live sees it: its control line's handlers, and what's sent."""

    def __init__(self):
        self.listening = True
        self.sent = []
        self.handlers = {}
        self.on_listening = []

    async def send(self, message):
        if not self.listening:
            return False
        self.sent.append(message)
        return True


@pytest.fixture
def line(hub, monkeypatch):
    monkeypatch.setattr(code_share_live, "PUSH_SECONDS", 0.02)
    fake = FakeLine()
    hub.account = FakeAccount()
    hub.account_desk = SimpleNamespace(relay=fake)
    hub.code_share.live.attach()
    hub.set_feature_prefs({code_share_live.PREF_INTERNET: True})
    return fake


async def until(check, seconds=10.0):
    for _ in range(int(seconds / 0.02)):
        if check():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("never happened")


def pushes(line, share_id):
    """Each whole push, opened: (seq, kind, payload)."""
    joiner, out = share_seal.Joiner(), []
    for m in line.sent:
        if m["type"] != "share_push" or m["share"] != share_id:
            continue
        whole = joiner.add(m["seq"], m["part"], m["parts"], m["blob"])
        if whole is not None:
            out.append((m["seq"], m["kind"], whole))
    return out


def opened(link, seq, blob):
    plain = share_seal.open_sealed(link.key, link.share_id, "down", seq, blob)
    return json.loads(plain) if plain is not None else None


def up(link, payload, message_id=None, key=None, share_id=None, at=None):
    message_id = message_id or share_seal.new_share_id()[:16]
    body = {"at": at if at is not None else _now_ms(), **payload}
    blob = share_seal.seal(key or link.key, share_id or link.share_id, "up", message_id, json.dumps(body).encode())
    return {"type": "share_up", "share": link.share_id, "id": message_id, "blob": blob}


def _now_ms():
    return int(time.time() * 1000)


# ── the sealing ──


def test_the_seal_matches_the_shared_vector_and_nothing_else_opens_it():
    key = share_seal.from_b64url(VECTOR["key"])
    share = VECTOR["share"]
    down, upv = VECTOR["down"], VECTOR["up"]
    assert json.loads(share_seal.open_sealed(key, share, "down", down["seq"], down["blob"])) == json.loads(down["plaintext"])
    assert json.loads(share_seal.open_sealed(key, share, "up", upv["id"], upv["blob"])) == json.loads(upv["plaintext"])
    again = share_seal.seal(key, share, "down", 7, json.dumps(json.loads(down["plaintext"])).encode(), nonce=bytes(range(12)))
    assert again == down["blob"]  # the same bytes the page's WebCrypto check expects
    # Another seq, the other direction, another share, another key, a changed byte: nothing.
    assert share_seal.open_sealed(key, share, "down", 8, down["blob"]) is None
    assert share_seal.open_sealed(key, share, "up", 7, down["blob"]) is None
    assert share_seal.open_sealed(key, "f" * 32, "down", 7, down["blob"]) is None
    assert share_seal.open_sealed(bytes(32), share, "down", 7, down["blob"]) is None
    flipped = down["blob"][:20] + ("A" if down["blob"][20] != "A" else "B") + down["blob"][21:]
    assert share_seal.open_sealed(key, share, "down", 7, flipped) is None
    assert share_seal.open_sealed(key, share, "down", 7, "not base64!") is None


def test_big_blobs_split_and_join_and_a_lost_part_holds_nothing_up():
    blob = "x" * (share_seal.PART_CHARS * 2 + 10)
    parts = share_seal.split(blob)
    assert len(parts) == 3 and all(len(p) <= share_seal.PART_CHARS for p in parts)
    joiner = share_seal.Joiner()
    assert joiner.add(1, 0, 3, parts[0]) is None
    assert joiner.add(1, 2, 3, parts[2]) is None
    assert joiner.add(1, 1, 3, parts[1]) == blob
    assert joiner.add(1, 0, 3, parts[0]) is None  # (seq 1 is done)
    assert joiner.add(2, 0, 2, "ab") is None  # seq 2's second part never comes...
    assert joiner.add(3, 0, 1, "whole") == "whole"  # ...and seq 3 is whole all the same
    assert joiner.add(4, 5, 2, "x") is None and joiner.add(4, 0, 999, "x") is None


# ── pushing ──


async def test_a_share_is_registered_and_pushed_sealed(hub, projects, line):
    task, _ = await session(hub, projects)
    # The session's own start-up settles first (working, then done): a share pushes that change
    # too, so it has to be over before "nothing changed: nothing pushed" can be asked below.
    await until(lambda: session_status(task, False) == "done")
    hub.code_share.cmd_start({"id": task.id, "minutes": 15})
    share = next(iter(hub.code_share.shares.values()))
    link = share.live_link
    await until(lambda: pushes(line, link.share_id))
    method, path, body = hub.account.calls[0]
    assert (method, path) == ("POST", "/live")
    assert body["share"] == link.share_id and body["expires"] == int(share.expires) and body["up"] is True
    secret = share_seal.b64url(link.key)
    assert secret not in json.dumps(hub.account.calls)  # askeden.com never gets the key
    assert all(secret not in json.dumps(m) for m in line.sent)
    url = latest(hub)["shares"][-1]["internet"]["url"]
    assert url == f"https://askeden.com/live/{link.share_id}#k={secret}"
    seq, kind, blob = pushes(line, link.share_id)[0]
    assert kind == "full" and seq == 1
    data = opened(link, seq, blob)
    assert data["title"] == "Fix the login" and data["kind"] == "full"
    text = json.dumps(data)
    assert KEY not in text and AWS not in text and str(Path.home()) not in text  # redacted first
    assert "private thoughts" not in text
    assert any(f["path"] == ".env" and f["withheld"] for f in data["changes"]["files"])
    # Nothing changed: nothing pushed. A new entry: a delta with only it, the changes not again.
    count = len(pushes(line, link.share_id))
    await asyncio.sleep(0.1)
    assert len(pushes(line, link.share_id)) == count
    hub.tasks._log(task, "assistant", "all done")
    await until(lambda: len(pushes(line, link.share_id)) > count)
    seq, kind, blob = pushes(line, link.share_id)[-1]
    delta = opened(link, seq, blob)
    assert kind == "delta" and [e["text"] for e in delta["entries"]] == ["all done"]
    assert delta["changes"] is None
    # askeden.com asks for a full one (its history got long, or the line came back).
    hub.code_share.live.heard_resync({"share": link.share_id})
    await until(lambda: pushes(line, link.share_id)[-1][1] == "full")
    # The viewer count comes from askeden.com.
    hub.code_share.live.heard_viewers({"share": link.share_id, "count": 3})
    assert latest(hub)["shares"][-1]["internet"]["viewers"] == 3
    hub.code_share.live.heard_viewers({"share": link.share_id, "count": True})  # (not a count)
    assert link.viewers == 3


async def test_a_revoked_share_stops_pushing_and_is_deleted_there(hub, projects, line):
    task, _ = await session(hub, projects)
    hub.code_share.cmd_start({"id": task.id})
    share = next(iter(hub.code_share.shares.values()))
    link = share.live_link
    await until(lambda: pushes(line, link.share_id))
    hub.code_share.cmd_revoke({"share": share.id})
    await until(lambda: ("DELETE", f"/live/{link.share_id}", None) in hub.account.calls)
    count = len(line.sent)
    hub.tasks._log(task, "assistant", "after the end")
    await asyncio.sleep(0.15)
    assert len(line.sent) == count and link.state == "ended"
    # What comes up for it now is no one's.
    hub.code_share.live.heard_up(up(link, {"kind": "comment", "text": "late"}))
    assert latest(hub, "code_share_comment") is None


async def test_without_the_switch_or_the_account_there_is_no_internet_link(hub, projects, line):
    task, _ = await session(hub, projects)
    hub.set_feature_prefs({code_share_live.PREF_INTERNET: False})
    hub.code_share.cmd_start({"id": task.id})
    assert latest(hub)["shares"][-1]["internet"] == {} and hub.account.calls == []
    hub.set_feature_prefs({code_share_live.PREF_INTERNET: True})
    hub.account.linked = False
    hub.code_share.cmd_start({"id": task.id})
    assert latest(hub)["shares"][-1]["internet"] == {}
    # askeden.com refusing (not deployed yet, signed out): said, and the network link stays.
    hub.account.linked, hub.account.refuse = True, (404, "not_found", "No such thing.")
    hub.code_share.cmd_start({"id": task.id})
    await until(lambda: latest(hub)["shares"][-1]["internet"].get("state") == "failed")
    last = latest(hub)["shares"][-1]
    assert last["internet"]["error"] == "No such thing." and last["internet"]["url"] == ""
    assert last["url"].startswith("https://studio.local:8765/share/")


async def test_a_line_that_drops_mid_push_starts_over_with_a_full_one(hub, projects, line):
    task, _ = await session(hub, projects)
    hub.code_share.cmd_start({"id": task.id})
    share = next(iter(hub.code_share.shares.values()))
    link = share.live_link
    await until(lambda: pushes(line, link.share_id))
    line.listening = False
    hub.tasks._log(task, "assistant", "while away")
    await asyncio.sleep(0.1)
    count = len(pushes(line, link.share_id))
    line.listening = True
    hub.code_share.live.relistened()
    await until(lambda: len(pushes(line, link.share_id)) > count)
    assert pushes(line, link.share_id)[-1][1] == "full"
    data = opened(link, *pushes(line, link.share_id)[-1][::2])
    assert "while away" in [e["text"] for e in data["entries"]]


def test_a_snapshot_too_big_for_one_push_is_cut_to_fit():
    live = code_share_live.Live(SimpleNamespace(hub=None))
    payload = {"kind": "full", "entries": [{"n": i, "text": "y" * 4000} for i in range(800)],
               "changes": {"files": [{"path": "a", "hunks": [{"lines": [["+", "z" * 500]] * 4000}]}]}}  # fmt: skip
    data = live.fit(payload)
    blob = share_seal.seal(bytes(32), "0" * 32, "down", 1, data)
    assert len(share_seal.split(blob)) <= share_seal.MAX_PARTS
    out = json.loads(data)
    assert out["changes"]["too_big"] and out["changes"]["files"][0]["hunks"] == []
    assert out["entries"][-1]["n"] == 799  # the newest kept


# ── what comes back up ──


async def test_what_comes_up_is_dropped_unless_it_opens_new_and_on_time(hub, projects, line):
    task, _ = await session(hub, projects)
    hub.set_feature_prefs({code_share.PREF_COMMENTS: True})
    hub.code_share.cmd_start({"id": task.id, "comments": True})
    share = next(iter(hub.code_share.shares.values()))
    link = share.live_link
    live = hub.code_share.live
    good = up(link, {"kind": "comment", "name": "Alex", "text": "nice"}, message_id="a" * 16)
    live.heard_up(good)
    card = latest(hub, "code_share_comment")["comment"]
    assert card["name"] == "Alex" and card["text"] == "nice"
    live.heard_up(good)  # the same message again (askeden.com replaying it): dropped
    assert len(share.comments) == 1 and link.dropped == 1
    moved = {**up(link, {"kind": "comment", "text": "x"}, message_id="b" * 16), "id": "c" * 16}
    live.heard_up(moved)  # its id changed: it doesn't open for that id
    live.heard_up(up(link, {"kind": "comment", "text": "x"}, key=bytes(32)))  # another key
    live.heard_up(up(link, {"kind": "comment", "text": "x"}, share_id="e" * 32))  # another share's
    live.heard_up(up(link, {"kind": "comment", "text": "x"}, at=_now_ms() - 3_600_000))  # an hour old
    live.heard_up(up(link, {"kind": "steal", "text": "x"}))  # not a kind there is
    live.heard_up({"type": "share_up", "share": link.share_id, "id": "nope", "blob": "x"})
    assert len(share.comments) == 1 and link.dropped == 7
    # The share's own link can't ask for a message, whatever it sends.
    hub.set_feature_prefs({PREF_DRIVERS: True})
    live.heard_up(up(link, {"kind": "message", "text": "rm everything"}))
    assert latest(hub, "code_share_request") is None and task.inbox.empty()


async def test_a_driver_through_askeden_is_who_their_secret_says(hub, projects, line, monkeypatch):
    task, _ = await session(hub, projects)
    hub.set_feature_prefs({PREF_DRIVERS: True})
    hub.code_share.cmd_start({"id": task.id})
    share = next(iter(hub.code_share.shares.values()))
    link = share.live_link
    hub.code_share.cmd_invite({"share": share.id, "name": "Sam", "role": "driver"})
    item = next(i for i in latest(hub)["shares"][-1]["invites"] if i["name"] == "Sam")
    sam = share.drive.invites[item["invite"]]
    assert item["internet_url"] == f"https://askeden.com/live/{link.share_id}#k={share_seal.b64url(link.key)}&i={sam.id}.{sam.secret}"
    hub.code_share.cmd_invite({"share": share.id, "name": "Ada", "role": "viewer"})
    ada = next(i for i in share.drive.invites.values() if i.name == "Ada")
    live = hub.code_share.live
    # A wrong secret is no one's: dropped, never taken as the share's own link either.
    live.heard_up(up(link, {"kind": "message", "invite": f"{sam.id}.{'x' * 32}", "text": "hi"}))
    assert latest(hub, "code_share_request") is None and link.dropped == 1
    # A viewer's secret can't ask.
    live.heard_up(up(link, {"kind": "message", "invite": f"{ada.id}.{ada.secret}", "text": "hi"}))
    assert latest(hub, "code_share_request") is None
    live.heard_up(up(link, {"kind": "hello", "invite": f"{sam.id}.{sam.secret}"}))
    assert sam.used
    live.heard_up(up(link, {"kind": "message", "invite": f"{sam.id}.{sam.secret}", "text": "run it", "name": "Not Sam"}))
    request = latest(hub, "code_share_request")["request"]
    assert request["name"] == "Sam" and request["via"] == "internet" and request["text"] == "run it"
    assert task.inbox.empty()
    # The roles go out sealed with each push, so a driver's page knows to show its box.
    await until(lambda: any(opened(link, s, b).get("roles", {}).get(sam.id) == "driver" for s, _k, b in pushes(line, link.share_id)))
    # Revoked: the same secret is nothing now.
    hub.code_share.cmd_uninvite({"share": share.id, "invite": sam.id})
    before = link.dropped
    live.heard_up(up(link, {"kind": "message", "invite": f"{sam.id}.{sam.secret}", "text": "again"}))
    assert link.dropped == before + 1


# ── the relay's control line carries it ──


async def test_the_relay_routes_share_messages_and_sends_on_its_line():
    from test_relay import FakeRelay
    from websockets.asyncio.server import serve

    fake = FakeRelay()
    server = await serve(fake.handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    account = SimpleNamespace(linked=True, token="jv1.x", forget=None)
    relay = Relay(account, lambda: None, base=f"ws://127.0.0.1:{port}")
    heard = []
    relay.handlers["share_viewers"] = heard.append
    ups = []

    async def on_up(message):
        ups.append(message)

    relay.handlers["share_up"] = on_up
    relisten = []
    relay.on_listening.append(lambda: relisten.append(1))
    assert await relay.send({"type": "share_push"}) is False  # (the line isn't up)
    task = asyncio.get_running_loop().create_task(relay.run())
    try:
        await asyncio.wait_for(fake.listening.wait(), 5)
        await until(lambda: relay.listening)
        assert relisten == [1]
        await fake.listen.send(json.dumps({"type": "share_viewers", "share": "s", "count": 2}))
        await fake.listen.send(json.dumps({"type": "share_up", "share": "s", "id": "i", "blob": "b"}))
        await until(lambda: heard and ups)
        assert heard[0]["count"] == 2 and ups[0]["blob"] == "b"
        assert await relay.send({"type": "share_push", "share": "s", "blob": "x"}) is True
        await until(lambda: any("share_push" in m for m in fake.heard))
        assert await relay.send({"type": "share_push", "blob": "x" * 70_000}) is False  # over a frame
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        server.close()
        await server.wait_closed()
