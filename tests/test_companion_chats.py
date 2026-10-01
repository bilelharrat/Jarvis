"""The Mac's past conversations from the phone (companion_chats.py)."""

from __future__ import annotations

from types import SimpleNamespace

from test_companion_api import api  # noqa: F401 (the fixture)

A = "11111111-2222-3333-4444-555555555555"
B = "66666666-7777-8888-9999-000000000000"


def faked(api):  # noqa: F811
    convo = api.hub.conversation
    convo.list_sessions = lambda directory, limit, include_worktrees: [
        SimpleNamespace(
            session_id=A, first_prompt="Plan the Lisbon trip", custom_title="", last_modified=2000
        ),
        SimpleNamespace(
            session_id=B, first_prompt="Reverse a list", custom_title="", last_modified=1000
        ),
    ]

    def get_messages(sid, directory):
        if sid == A:
            raise OSError("damaged record")
        return []

    convo.get_messages = get_messages
    return convo


def test_the_past_conversations_list_pinned_first(api, tmp_path, monkeypatch):  # noqa: F811
    faked(api)
    monkeypatch.setattr("jarvis.conversation_past.workspace", lambda: tmp_path)
    api.hub.conversation_manage.pins = [B]
    items = api.get("/api/chats").json()["items"]
    assert [i["session_id"] for i in items] == [B, A]
    assert items[0]["pinned"] is True and items[1]["title"] == "Plan the Lisbon trip"
    found = api.get("/api/chats?q=lisbon").json()["items"]
    assert [i["session_id"] for i in found] == [A]


def test_a_conversation_reads_or_says_it_cant(api, tmp_path, monkeypatch):  # noqa: F811
    faked(api)
    monkeypatch.setattr("jarvis.conversation_past.workspace", lambda: tmp_path)
    readable = api.get(f"/api/chats/one?id={B}").json()
    assert readable["entries"] == [] and "error" not in readable
    unreadable = api.get(f"/api/chats/one?id={A}").json()
    assert unreadable["error"] == "unreadable"
    assert api.get("/api/chats/one?id=nope/../x").status_code == 404


def test_rename_pin_delete_and_a_new_one(api, monkeypatch):  # noqa: F811
    desk = api.hub.conversation_manage
    done = []

    async def rename(msg):
        done.append(("rename", msg["title"]))

    async def pin(msg):
        done.append(("pin", msg["pinned"]))

    async def delete(msg):
        done.append(("delete", msg["session_id"]))

    monkeypatch.setattr(desk, "rename", rename)
    monkeypatch.setattr(desk, "pin", pin)
    monkeypatch.setattr(desk, "delete", delete)
    api.hub._session_id = A
    assert api.post(
        "/api/chats/manage", {"session_id": B, "action": "rename", "title": " Trip "}
    ).json() == {"ok": True}
    api.post("/api/chats/manage", {"session_id": B, "action": "pin"})
    assert api.post("/api/chats/manage", {"session_id": A, "action": "delete"}).status_code == 409
    api.post("/api/chats/manage", {"session_id": B, "action": "delete"})
    assert done == [("rename", "Trip"), ("pin", True), ("delete", B)]

    reset = []

    async def fake_reset():
        reset.append(True)

    monkeypatch.setattr(api.hub, "reset", fake_reset)
    assert api.post("/api/chats/new", {}).json() == {"ok": True} and reset == [True]
