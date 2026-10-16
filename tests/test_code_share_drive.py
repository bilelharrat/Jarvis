"""Share live's roles and co-control (features/code_share_drive.py) and teams
(features/code_teams.py): personal links with a role each, a driver's requests as cards the
owner sends as their own, every check made again on each request (revoked links, switches
off, members removed or moved down a role), trusted drivers' limits, and the audit trail.
The authorization checks are the point: each refusal here is one a link holder could try."""

import time

import pytest
from test_code_share import client_for, hub, latest, projects, session  # noqa: F401 (fixtures)

from jarvis.features import code_share
from jarvis.features.code_share_drive import PREF_DRIVERS, PREF_TRUSTED


def start(hub, task, **extra):
    hub.code_share.cmd_start({"id": task.id, **extra})
    return next(s for s in hub.code_share.shares.values() if s.task_id == task.id)


def invite(hub, share, **msg):
    hub.code_share.cmd_invite({"share": share.id, **msg})
    event = latest(hub)
    assert "error" not in event, event
    item = next(i for i in event["shares"][-1]["invites"] if i["invite"] == event["invited"])
    return share.drive.invites[item["invite"]], item


def token_of(url):
    return url.rsplit("/", 1)[1]


def watch(client, token, viewer="viewer-one"):
    reply = client.get(f"/share/{token}/state", params={"v": viewer})
    assert reply.status_code == 200, reply.text
    return reply.json()


def act(client, token, viewer="viewer-one", **body):
    return client.post(f"/share/{token}/act", json={"v": viewer, **body})


def question(hub, task, ident="q1"):
    hub.approvals[ident] = {
        "id": ident,
        "task_id": task.id,
        "question": "Allow Bash: npm test?",
        "detail": "npm test",
        "choices": [{"id": "allow", "label": "Allow"}, {"id": "deny", "label": "Deny"}],
    }
    return ident


class Companion:
    def __init__(self):
        self.records = []

    def record(self, device, action, detail=""):
        self.records.append((device.id, device.name, action, detail))


@pytest.fixture
def companion(hub):
    fake = Companion()
    hub.remote.extension = fake
    return fake


async def test_personal_links_need_their_switches(hub, projects):
    task, _ = await session(hub, projects)
    share = start(hub, task)
    shares = hub.code_share
    shares.cmd_invite({"share": share.id, "name": "Sam", "role": "driver"})
    assert latest(hub)["error"].startswith("Turn on Let drivers ask")
    shares.cmd_invite({"share": share.id, "name": "Sam", "role": "commenter"})
    assert latest(hub)["error"].startswith("Turn on suggestions")
    shares.cmd_invite({"share": share.id, "name": "  ", "role": "viewer"})
    assert latest(hub)["error"] == "Give them a name."
    hub.set_feature_prefs({PREF_DRIVERS: True})
    shares.cmd_invite({"share": share.id, "name": "Sam", "role": "driver", "trusted": True})
    assert latest(hub)["error"] == "Trusted drivers are off in the Share pane."
    sam, item = invite(hub, share, name="Sam", role="driver")
    assert item["role_now"] == "driver" and item["url"].startswith("https://studio.local:8765/share/")
    assert token_of(item["url"]) != share.token  # a link of its own
    shares.cmd_invite({"share": "nope", "name": "Sam"})
    assert latest(hub)["error"] == "This share isn't live."


async def test_a_driver_asks_and_only_the_owner_sends(hub, projects, tmp_path, companion, monkeypatch):
    task, _ = await session(hub, projects)
    hub.set_feature_prefs({PREF_DRIVERS: True})
    share = start(hub, task)
    sam, item = invite(hub, share, name="Sam", role="driver")
    ada, ada_item = invite(hub, share, name="Ada", role="viewer")
    client = client_for(hub, tmp_path)
    token = token_of(item["url"])
    seen = watch(client, token)
    assert seen["role"] == "driver" and seen["you"] == "Sam"
    assert sam.used  # (opened)

    # The share's own link and a viewer's personal link can't ask for anything.
    watch(client, share.token, "viewer-two")
    assert act(client, share.token, "viewer-two", kind="message", text="hi").status_code == 403
    watch(client, token_of(ada_item["url"]), "viewer-three")
    assert act(client, token_of(ada_item["url"]), "viewer-three", kind="message", text="hi").status_code == 403
    # A driver must be watching from where they ask.
    assert act(client, token, "not-watching", kind="message", text="hi").status_code == 403
    assert act(client, token, kind="nonsense").status_code == 403
    assert act(client, token, kind="message", text="   ").status_code == 400

    sent = []
    monkeypatch.setattr(hub.tasks, "send", lambda task_id, text, *a, **k: sent.append((task_id, text)) or True)
    reply = act(client, token, kind="message", text="please run the tests")
    assert reply.status_code == 200 and reply.json()["status"] == "waiting"
    assert sent == [] and task.inbox.empty()  # never to the session by itself
    request = latest(hub, "code_share_request")["request"]
    assert request["name"] == "Sam" and request["kind"] == "message" and request["via"] == "network"
    assert latest(hub)["shares"][-1]["requests"][0]["id"] == request["id"]
    # The owner sends it, as their own; attributed in the share's log and the audit log.
    hub.code_share.cmd_send({"share": share.id, "request": request["id"]})
    assert sent == [(task.id, "please run the tests")]
    assert "error" not in latest(hub)
    hub.code_share.cmd_send({"share": share.id, "request": request["id"]})  # once only
    assert latest(hub)["error"] == "That request is gone." and len(sent) == 1
    actions = [e["action"] for e in share.drive.log]
    assert actions == ["asked_message", "sent"]
    assert [r[2] for r in companion.records] == ["share_asked_message", "share_sent"]
    assert all("please run" not in r[3] for r in companion.records)  # never the words
    assert companion.records[0][1] == "Sam (driver, Share live)"
    # A "!" or "/" message is only ever copied, never sent by the Send button.
    act(client, token, kind="message", text="!rm -rf build")
    bang = latest(hub, "code_share_request")["request"]
    hub.code_share.cmd_send({"share": share.id, "request": bang["id"]})
    assert latest(hub)["error"].startswith("Copy it into the composer") and len(sent) == 1


async def test_every_check_is_made_again_on_each_request(hub, projects, tmp_path, monkeypatch):
    task, _ = await session(hub, projects)
    hub.set_feature_prefs({PREF_DRIVERS: True, code_share.PREF_COMMENTS: True})
    share = start(hub, task)
    sam, item = invite(hub, share, name="Sam", role="driver")
    client = client_for(hub, tmp_path)
    token = token_of(item["url"])
    watch(client, token)
    act(client, token, kind="message", text="one")
    waiting = latest(hub, "code_share_request")["request"]
    # Drivers switched off: Sam is a commenter now (suggestions still on), and can't ask.
    hub.set_feature_prefs({PREF_DRIVERS: False})
    assert watch(client, token)["role"] == "commenter"
    assert act(client, token, kind="message", text="two").status_code == 403
    assert client.post(f"/share/{token}/comment", json={"v": "viewer-one", "name": "Not Sam", "text": "hey"}).status_code == 200
    card = latest(hub, "code_share_comment")["comment"]
    assert card["name"] == "Sam"  # the owner's name for the link, never one typed
    # And the owner's Send on what was asked before is refused now too.
    sent = []
    monkeypatch.setattr(hub.tasks, "send", lambda *a, **k: sent.append(a) or True)
    hub.code_share.cmd_send({"share": share.id, "request": waiting["id"]})
    assert "can't ask for that any more" in latest(hub)["error"] and sent == []
    # Revoked: the link is gone at once, what it asked goes with it.
    hub.set_feature_prefs({PREF_DRIVERS: True})
    act(client, token, kind="message", text="three")
    hub.code_share.cmd_uninvite({"share": share.id, "invite": sam.id})
    assert client.get(f"/share/{token}/state", params={"v": "viewer-one"}).status_code == 404
    assert act(client, token, kind="message", text="four").status_code == 404
    assert latest(hub)["shares"][-1]["requests"] == []
    # The share revoked: every personal link with it.
    other, other_item = invite(hub, share, name="Ada", role="viewer")
    hub.code_share.cmd_revoke({"share": share.id})
    assert client.get(f"/share/{token_of(other_item['url'])}/state", params={"v": "v-ada-0001"}).status_code == 404


async def test_a_suggested_answer_is_only_for_its_own_session(hub, projects, tmp_path, companion):
    task, _ = await session(hub, projects)
    hub.set_feature_prefs({PREF_DRIVERS: True})
    share = start(hub, task)
    _sam, item = invite(hub, share, name="Sam", role="driver")
    client = client_for(hub, tmp_path)
    token = token_of(item["url"])
    asked = question(hub, task)
    hub.approvals["other"] = {**hub.approvals[asked], "id": "other", "task_id": task.id + 1000}
    seen = watch(client, token)
    assert [a["id"] for a in seen["approvals"]] == ["q1"]  # another session's question isn't shown
    assert act(client, token, kind="approve", approval="other", choice="allow").status_code == 404
    assert act(client, token, kind="approve", approval="q1", choice="always").status_code == 400
    assert act(client, token, kind="approve", approval="q1", choice="allow").status_code == 200
    assert "q1" in hub.approvals  # suggested, not answered: the owner's own tap answers
    request = latest(hub, "code_share_request")["request"]
    assert request["kind"] == "approve" and request["choice"] == "allow" and request["label"] == "Allow"
    # The Send button is for messages: an answer goes through the window's own answer.
    hub.code_share.cmd_send({"share": share.id, "request": request["id"]})
    assert latest(hub)["error"] == "That request is gone."
    hub.code_share.cmd_settle({"share": share.id, "request": request["id"], "outcome": "answered"})
    assert [e["action"] for e in share.drive.log] == ["asked_approve", "answered"]
    assert companion.records[-1][2] == "share_answered"


async def test_a_trusted_driver_skips_the_tap_for_plain_messages_only(hub, projects, tmp_path, monkeypatch):
    task, _ = await session(hub, projects)
    hub.set_feature_prefs({PREF_DRIVERS: True, PREF_TRUSTED: True})
    share = start(hub, task)
    _sam, item = invite(hub, share, name="Sam", role="driver", trusted=True)
    client = client_for(hub, tmp_path)
    token = token_of(item["url"])
    watch(client, token)
    sent = []
    monkeypatch.setattr(hub.tasks, "send", lambda task_id, text, *a, **k: sent.append(text) or True)
    assert act(client, token, kind="message", text="add a test").json()["status"] == "sent"
    assert sent == ["add a test"]
    assert any("trusted driver" in str(e.get("text")) for e in task.transcript)  # attributed in the session
    for text in ("!make deploy", "/bypass"):
        assert act(client, token, kind="message", text=text).json()["status"] == "waiting"
    task.mode = "auto"  # Bypass permissions: every message waits for the owner
    assert act(client, token, kind="message", text="go on").json()["status"] == "waiting"
    task.mode = "ask"
    question(hub, task)
    hub.code_share.limiter = code_share.Limiter()  # (five asks so far: past the burst)
    assert act(client, token, kind="approve", approval="q1", choice="allow").json()["status"] == "waiting"
    assert sent == ["add a test"]
    hub.set_feature_prefs({PREF_TRUSTED: False})  # the switch off: back to the tap
    assert act(client, token, kind="message", text="more").json()["status"] == "waiting"
    assert sent == ["add a test"]


async def test_requests_are_rate_limited_and_capped(hub, projects, tmp_path):
    task, _ = await session(hub, projects)
    hub.set_feature_prefs({PREF_DRIVERS: True})
    share = start(hub, task)
    _sam, item = invite(hub, share, name="Sam", role="driver")
    client = client_for(hub, tmp_path)
    token = token_of(item["url"])
    watch(client, token)
    codes = [act(client, token, kind="message", text=f"m{i}").status_code for i in range(8)]
    assert codes[:4] == [200] * 4 and 429 in codes


async def test_teams_cap_roles_and_removal_ends_links(hub, projects, tmp_path):
    teams = hub.code_teams
    teams.command({"type": "code_team_create", "name": "Core"})
    team = latest(hub, "code_teams")["teams"][0]
    teams.command({"type": "code_team_invite", "team": team["id"], "name": "Sam", "share_role": "driver"})
    assert latest(hub, "code_teams")["error"] == "Only an admin can be a driver."
    teams.command({"type": "code_team_invite", "team": team["id"], "name": "Sam", "role": "admin", "share_role": "driver"})
    teams.command({"type": "code_team_invite", "team": team["id"], "name": "Ada", "share_role": "commenter"})
    teams.command({"type": "code_team_invite", "team": team["id"], "name": "sam"})
    assert latest(hub, "code_teams")["error"] == "Someone on the team already has that name."
    members = {m["name"]: m for m in latest(hub, "code_teams")["teams"][0]["members"]}
    assert members["Sam"]["role"] == "admin" and members["Ada"]["share_role"] == "commenter"
    assert not members["Sam"]["joined"]
    # Kept on this Mac, and read back the same.
    from jarvis.features.code_teams import Teams

    again = Teams(hub)
    assert [m["name"] for m in again.teams[0]["members"]] == ["Sam", "Ada"]

    task, _ = await session(hub, projects)
    hub.set_feature_prefs({PREF_DRIVERS: True, code_share.PREF_COMMENTS: True})
    share = start(hub, task)
    # Asked for as a driver, Ada is no more than her team role lets her be.
    ada, ada_item = invite(hub, share, team=team["id"], member=members["Ada"]["id"], role="driver")
    assert ada.role == "commenter" and ada.name == "Ada"
    sam, sam_item = invite(hub, share, team=team["id"], member=members["Sam"]["id"], role="driver")
    client = client_for(hub, tmp_path)
    sam_token = token_of(sam_item["url"])
    watch(client, sam_token)
    assert hub.code_teams.member(team["id"], members["Sam"]["id"])["joined"]  # joined on first open
    assert act(client, sam_token, kind="message", text="hi").status_code == 200
    # Moved down to member: no longer a driver, on this share at once.
    teams.command({"type": "code_team_member", "team": team["id"], "member": members["Sam"]["id"], "role": "member"})
    assert hub.code_teams.member(team["id"], members["Sam"]["id"])["share_role"] == "commenter"
    assert act(client, sam_token, kind="message", text="again").status_code == 403
    assert watch(client, sam_token)["role"] == "commenter"
    # Removed: their link stops working.
    teams.command({"type": "code_team_remove", "team": team["id"], "member": members["Sam"]["id"]})
    assert client.get(f"/share/{sam_token}/state", params={"v": "viewer-one"}).status_code == 404
    # The whole team deleted: Ada's link too.
    teams.command({"type": "code_team_delete", "team": team["id"]})
    assert client.get(f"/share/{token_of(ada_item['url'])}/state", params={"v": "viewer-ada1"}).status_code == 404
    assert latest(hub, "code_teams")["teams"] == []


def test_team_files_cannot_make_a_member_a_driver(tmp_path):
    from jarvis.features.code_teams import _member

    row = _member({"id": "ab", "name": "Eve", "role": "member", "share_role": "driver"})
    assert row["share_role"] == "commenter"
    assert _member({"id": "ab", "name": "", "role": "admin"}) is None
    assert _member({"id": "ab", "name": "Al", "role": "owner"})["role"] == "member"  # one owner: the Mac's


async def test_a_member_link_without_its_team_is_no_link(hub, projects, tmp_path):
    task, _ = await session(hub, projects)
    share = start(hub, task)
    hub.code_share.cmd_invite({"share": share.id, "team": "nope", "member": "nobody"})
    assert latest(hub)["error"] == "That member is gone."
    # And the role check refuses an invite whose member vanished behind its back.
    from jarvis.features.code_share_drive import Invite

    ghost = Invite(id="deadbeef", name="Ghost", role="viewer", token="t" * 32, secret="s" * 32,
                   created=time.time(), team="nope", member="nobody")  # fmt: skip
    assert hub.code_share.drive.role_of(share, ghost) == ""
    assert hub.code_share.drive.may(share, ghost, "view") is False
