"""Projects for the main chat (features/chat_projects.py): conversations kept together, with
instructions and files that ride on their requests."""

from __future__ import annotations

import asyncio
import base64
from types import SimpleNamespace

from jarvis.features.chat_projects import ChatProjects

SID = "11111111-2222-3333-4444-555555555555"
OTHER = "66666666-7777-8888-9999-000000000000"


class Hub:
    def __init__(self):
        self.events = []
        self.commands = {}
        self.contexts = []
        self.sinks = {}
        self.resets = 0
        self.incognito = False
        self._session_id = ""
        self.conversation = SimpleNamespace(
            state=SimpleNamespace(titles=lambda: {SID: "Pricing plan"})
        )

    def emit(self, kind, **values):
        self.events.append((kind, values))

    def register_command(self, kind, handler, slow=False):
        self.commands[kind] = handler

    def add_request_context(self, context):
        self.contexts.append(context)

    def add_event_sink(self, kinds, sink):
        for kind in kinds:
            self.sinks.setdefault(kind, []).append(sink)

    async def reset(self):
        self.resets += 1
        self._session_id = ""


def made(tmp_path):
    hub = Hub()
    desk = ChatProjects(hub, folder=tmp_path)
    desk.install()
    return hub, desk


def ask(hub, text="what next?", display=None):
    return asyncio.run(hub.contexts[0](text, display))


def finish(hub, sid):
    hub._session_id = sid
    for sink in hub.sinks["turn_done"]:
        sink({"type": "turn_done"})


def test_a_new_project_opens_and_its_conversations_carry_its_instructions(tmp_path):
    hub, desk = made(tmp_path)
    project = desk.save({"name": "  Launch   plan ", "instructions": "Answer in French."})
    assert project["name"] == "Launch plan"
    assert desk.active == project["id"]
    extra = ask(hub)
    assert "Launch plan" in extra["note"] and "Answer in French." in extra["note"]
    finish(hub, SID)
    assert desk.find(project["id"])["sessions"] == [SID]
    # Its conversations list, with titles.
    listing = desk.listing()
    assert listing["items"][0]["conversations"] == [{"session_id": SID, "title": "Pricing plan"}]
    # Kept.
    again = ChatProjects(Hub(), folder=tmp_path)
    assert again.active == project["id"] and again.find(project["id"])["sessions"] == [SID]


def test_files_go_once_per_conversation_and_again_when_changed(tmp_path):
    hub, desk = made(tmp_path)
    pid = desk.save({"name": "Docs"})["id"]
    assert (
        asyncio.run(desk.add_file({"id": pid, "name": "notes.md", "text": "Ship on Friday."})) == ""
    )
    first = ask(hub)["note"]
    assert "Ship on Friday." in first and "notes.md" in first
    finish(hub, SID)
    second = ask(hub)["note"]
    assert "Ship on Friday." not in second
    assert "given earlier in this conversation: notes.md" in second
    finish(hub, SID)
    asyncio.run(desk.add_file({"id": pid, "name": "notes.md", "text": "Ship on Monday."}))
    assert "Ship on Monday." in ask(hub)["note"]
    assert desk.find(pid)["files"][0]["chars"] == len("Ship on Monday.")


def test_a_request_reads_only_the_files_that_go_with_it(tmp_path):
    """Asked on every request: files a conversation already has aren't read from disk
    again, and one whose text is gone is left out while the rest still go."""
    hub, desk = made(tmp_path)
    pid = desk.save({"name": "Docs"})["id"]
    for name, text in (("a.txt", "alpha"), ("b.txt", "beta"), ("c.txt", "gamma")):
        asyncio.run(desk.add_file({"id": pid, "name": name, "text": text}))
    desk._text_path(pid, 1).unlink()  # b.txt's text gone from disk
    read = []
    real = desk._file_text
    desk._file_text = lambda p, indexes: read.append(indexes) or real(p, indexes)
    first = ask(hub)["note"]
    assert "alpha" in first and "beta" not in first and "gamma" in first
    assert read == [[0], [1], [2]]
    finish(hub, SID)
    read.clear()
    second = ask(hub)["note"]
    assert "alpha" not in second and "given earlier in this conversation: a.txt, c.txt" in second
    assert read == [[1]]  # only the one that hasn't gone yet (and still can't be read)


def test_a_pdf_is_read_to_text(tmp_path, monkeypatch):
    from jarvis.features import chat_projects

    monkeypatch.setattr(chat_projects, "_pdf_text", lambda data: f"[Page 1]\n{data.decode()}")
    hub, desk = made(tmp_path)
    pid = desk.save({"name": "Reports"})["id"]
    pdf = base64.b64encode(b"Revenue grew 12%").decode()
    assert asyncio.run(desk.add_file({"id": pid, "name": "q3.pdf", "pdf": pdf})) == ""
    assert "Revenue grew 12%" in ask(hub)["note"]
    assert asyncio.run(desk.add_file({"id": pid, "name": "bad.pdf", "pdf": "%%%"})) != ""
    assert asyncio.run(desk.add_file({"id": pid, "name": "empty.txt", "text": "  "})) != ""


def test_a_file_taken_away_no_longer_goes(tmp_path):
    hub, desk = made(tmp_path)
    pid = desk.save({"name": "Docs"})["id"]
    asyncio.run(desk.add_file({"id": pid, "name": "a.txt", "text": "alpha"}))
    asyncio.run(desk.add_file({"id": pid, "name": "b.txt", "text": "beta"}))
    desk.remove_file({"id": pid, "name": "a.txt"})
    note = ask(hub)["note"]
    assert "alpha" not in note and "beta" in note


def test_opening_a_project_starts_a_conversation_in_it(tmp_path):
    hub, desk = made(tmp_path)
    pid = desk.save({"name": "Trip"})["id"]
    desk.active = ""
    hub._session_id = OTHER  # a conversation outside it goes on
    assert ask(hub) is None
    asyncio.run(desk.use({"id": pid}))
    assert hub.resets == 1 and desk.active == pid
    assert "Trip" in ask(hub)["note"]
    # One already its own carries on as it is.
    finish(hub, SID)
    asyncio.run(desk.use({"id": pid}))
    assert hub.resets == 1
    # Closed: new conversations are nobody's, the project's own still carry its note.
    asyncio.run(desk.use({"id": ""}))
    assert desk.active == "" and "Trip" in ask(hub)["note"]
    hub._session_id = ""
    assert ask(hub) is None


def test_a_conversation_from_outside_stays_out_while_a_project_is_open(tmp_path):
    hub, desk = made(tmp_path)
    desk.save({"name": "Trip"})
    hub._session_id = OTHER
    assert ask(hub) is None
    finish(hub, OTHER)
    assert desk.project_of(OTHER) is None


def test_moving_and_deleting(tmp_path):
    hub, desk = made(tmp_path)
    a = desk.save({"name": "A"})["id"]
    b = desk.save({"name": "B"})["id"]
    desk.assign({"session_id": SID, "id": a})
    desk.assign({"session_id": SID, "id": b})
    assert desk.find(a)["sessions"] == [] and desk.find(b)["sessions"] == [SID]
    desk.assign({"session_id": SID, "id": ""})
    assert desk.project_of(SID) is None
    asyncio.run(desk.add_file({"id": b, "name": "x.txt", "text": "x"}))
    desk.delete({"id": b})
    assert desk.find(b) is None and desk.active == ""
    assert not (tmp_path / "chat-projects" / b).exists()


def test_incognito_and_words_sent_on_get_nothing(tmp_path):
    hub, desk = made(tmp_path)
    desk.save({"name": "Trip"})
    assert ask(hub, "from a link", "from a link") is None
    hub.incognito = True
    assert ask(hub) is None
    finish(hub, SID)
    assert desk.project_of(SID) is None


def test_renaming_keeps_the_rest(tmp_path):
    hub, desk = made(tmp_path)
    pid = desk.save({"name": "Old", "instructions": "Be brief."})["id"]
    desk.save({"id": pid, "name": "New"})
    assert desk.find(pid)["name"] == "New" and desk.find(pid)["instructions"] == "Be brief."
    desk.save({"id": pid, "instructions": ""})
    assert desk.find(pid)["instructions"] == "" and desk.find(pid)["name"] == "New"
    assert hub.events[-1][0] == "chat_projects"
