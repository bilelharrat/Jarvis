"""Rename, pin and delete past conversations (features/conversation_manage.py)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from jarvis.features.conversation_manage import ConversationManage

SID = "11111111-2222-3333-4444-555555555555"
OTHER = "66666666-7777-8888-9999-000000000000"


class State:
    def __init__(self):
        self.sessions = {SID: {"reads": None, "cost": 0.0, "at": "", "title": "First request"}}
        self.saved = 0

    def snapshot(self):
        return {"sessions": dict(self.sessions)}

    def save(self, _data=None):
        self.saved += 1


class Hub:
    def __init__(self):
        self.events = []
        self.commands = {}
        self.conversation = SimpleNamespace(state=State())
        self._session_id = OTHER

    def emit(self, kind, **values):
        self.events.append((kind, values))

    def register_command(self, kind, handler, slow=False):
        self.commands[kind] = handler


def made(tmp_path):
    calls = []
    sdk = (
        lambda sid, title, directory: calls.append(("rename", sid, title)),
        lambda sid, directory: calls.append(("delete", sid)),
    )
    hub = Hub()
    manage = ConversationManage(hub, folder=tmp_path, sdk=sdk)
    manage.install()
    manage._directory = lambda: str(tmp_path)
    return hub, manage, calls


def test_rename_changes_both_records_and_the_list_asks_again(tmp_path):
    hub, manage, calls = made(tmp_path)
    asyncio.run(manage.rename({"session_id": SID, "title": "  Trip to Lisbon  "}))
    assert calls == [("rename", SID, "Trip to Lisbon")]
    assert hub.conversation.state.sessions[SID]["title"] == "Trip to Lisbon"
    assert hub.conversation.state.saved == 1
    assert hub.events[-1] == ("conversation_marks", {"pins": []})
    asyncio.run(manage.rename({"session_id": SID, "title": "   "}))  # no title
    asyncio.run(manage.rename({"session_id": "../../etc/passwd", "title": "x"}))  # not an id
    assert len(calls) == 1


def test_pins_are_kept_newest_first_and_survive_a_restart(tmp_path):
    hub, manage, _ = made(tmp_path)
    asyncio.run(manage.pin({"session_id": SID}))
    asyncio.run(manage.pin({"session_id": OTHER}))
    assert manage.pins == [OTHER, SID]
    asyncio.run(manage.pin({"session_id": OTHER, "pinned": False}))
    assert manage.pins == [SID]
    again = ConversationManage(Hub(), folder=tmp_path, sdk=None)
    assert again.pins == [SID]


def test_delete_removes_it_for_good_but_never_the_one_going_on(tmp_path):
    hub, manage, calls = made(tmp_path)
    asyncio.run(manage.pin({"session_id": SID}))
    asyncio.run(manage.delete({"session_id": SID}))
    assert calls == [("delete", SID)]
    assert SID not in hub.conversation.state.sessions and manage.pins == []
    asyncio.run(manage.delete({"session_id": OTHER}))  # the current conversation
    assert calls == [("delete", SID)]
    assert "going on now" in hub.events[-1][1]["text"]


def test_export_writes_markdown_named_for_its_title(tmp_path):
    from jarvis.features.conversation_manage import write_markdown

    entries = [
        {"role": "user", "text": "Plan Lisbon"},
        {"role": "assistant", "text": "Day one: Alfama."},
    ]
    path = write_markdown(tmp_path, "Trip: Lisbon/Porto", entries)
    assert path.name == "Trip LisbonPorto.md"
    assert (
        path.read_text()
        == "# Trip: Lisbon/Porto\n\n**You**\n\nPlan Lisbon\n\n**J.A.R.V.I.S.**\n\nDay one: Alfama.\n"
    )
    assert write_markdown(tmp_path, "Trip: Lisbon/Porto", entries).name == "Trip LisbonPorto (2).md"
