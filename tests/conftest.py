import asyncio
from dataclasses import replace

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from jarvis.config import Settings
from jarvis.speech import Speaker


def strip_note(query):
    """A query without the "[Note from the app: …]" the hub puts in front of it."""
    if isinstance(query, str) and query.startswith("[Note from the app:"):
        return query.split("]\n\n", 1)[-1]
    return query


class FakeClient:
    """Stands in for ClaudeSDKClient: records queries, replays a scripted response (as one
    turn from receive_response, and on the connection's stream from receive_messages)."""

    script: list = []

    def __init__(self, options=None):
        self.options = options
        self.queries = []
        self.interrupted = False
        self.connected = False
        self.stream = None

    def _stream(self):
        if self.stream is None:
            self.stream = asyncio.Queue()
        return self.stream

    async def connect(self):
        self.connected = True

    async def disconnect(self):
        self.connected = False

    @property
    def said(self):
        """The queries as the user put them, without the app's note in front."""
        return [strip_note(q) for q in self.queries]

    async def query(self, text):
        self.queries.append(text)
        for message in self.script:
            self._stream().put_nowait(message)

    async def receive_response(self):
        for message in self.script:
            yield message

    async def receive_messages(self):
        while True:
            yield await self._stream().get()

    async def interrupt(self):
        self.interrupted = True

    async def set_permission_mode(self, mode):
        self.modes = [*getattr(self, "modes", []), mode]

    async def set_model(self, model):
        self.model = model

    async def rewind_files(self, user_message_id):
        self.rewound = [*getattr(self, "rewound", []), user_message_id]

    async def get_context_usage(self):
        return {"percentage": 41.6, "totalTokens": 83000, "maxTokens": 200000}

    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, *exc):
        await self.disconnect()


def result(is_error=False, text="done", cost=0.01):
    return ResultMessage(
        subtype="error" if is_error else "success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=is_error,
        num_turns=1,
        session_id="s",
        total_cost_usd=cost,
        result=text,
    )


CALENDAR_TURN = [
    AssistantMessage(
        content=[ToolUseBlock(id="t1", name="mcp__mac__list_events", input={})], model="m"
    ),
    UserMessage(content=[ToolResultBlock(tool_use_id="t1", content="ok", is_error=False)]),
    AssistantMessage(content=[TextBlock(text="Two meetings tomorrow.")], model="m"),
    result(),
]


@pytest.fixture
def settings(tmp_path):
    return replace(Settings(), bsh_dir=None, projects_dir=tmp_path)


@pytest.fixture
def quiet_speaker():
    speaker = Speaker.__new__(Speaker)
    speaker.voice, speaker.rate, speaker.muted, speaker._procs = "", 190, True, set()
    speaker.effect, speaker.cloud, speaker.cloud_error, speaker._playing = False, None, "", False
    speaker._player = None
    speaker.player_path, speaker._live, speaker._live_lock = None, None, None
    return speaker


@pytest.fixture(autouse=True)
def _quick_saves(monkeypatch):
    """Store saves in tests skip only the drive-cache flush (F_FULLFSYNC, about 5 ms a
    save; a plain fsync still runs): tests check what's written, not the drive's cache.
    test_jsonstore checks that the real saves ask for the flush."""
    import os

    from jarvis import jsonstore

    monkeypatch.setattr(jsonstore, "_sync", os.fsync)


@pytest.fixture(autouse=True)
def _no_real_keychain(monkeypatch):
    """Phone credentials in tests live in a dict, never the login keychain."""
    from jarvis import phone

    class Memory:
        def __init__(self):
            self.items = {}

        def get_password(self, service, user):
            return self.items.get((service, user))

        def set_password(self, service, user, secret):
            self.items[(service, user)] = secret

        def delete_password(self, service, user):
            self.items.pop((service, user), None)

    real = phone.Keychain.__init__

    def init(self, backend=None):
        real(self, backend if backend is not None else Memory())

    monkeypatch.setattr(phone.Keychain, "__init__", init)


@pytest.fixture(autouse=True)
def _no_real_mac_commands(monkeypatch):
    """A request that reads like "open Safari" or "press command T" never opens, clicks or
    types on the real Mac in a test: the instant command says it isn't one (so it goes on to
    the fake Claude). test_system_voice tests the real one with fakes of its own."""
    from jarvis import system_voice

    async def not_here(*_a, **_k):
        return None

    monkeypatch.setattr(system_voice, "carry_out", not_here)


@pytest.fixture
def isolated(tmp_path):
    """Prefs and second-brain index in a temp folder, never the user's real ones."""
    from jarvis.connectors import ConnectorManager, MemoryVault
    from jarvis.invoices import InvoiceStore
    from jarvis.knowledge import KnowledgeBase
    from jarvis.memory import MemoryStore
    from jarvis.prefs import PrefsStore
    from jarvis.remote import Devices
    from jarvis.routines import RoutineStore
    from jarvis.screenwatch import ScreenWatcher
    from jarvis.transactions import Transactions

    async def never_asked(*_args):
        return "deny"

    async def no_picture():
        return ""

    async def no_page():
        return {"error": "no browser in tests"}

    from jarvis.answering import CallLog
    from jarvis.delegate import DelegationStore
    from jarvis.documents import DocumentStore
    from jarvis.fileindex import FileIndex
    from jarvis.goals import GoalStore
    from jarvis.hearing import Hearing
    from jarvis.interrupts import Interrupter
    from jarvis.providers import ProviderStore
    from jarvis.suggestions import Suggester
    from jarvis.video import VideoDesk

    store = PrefsStore(tmp_path / "prefs.json")
    store.prefs.hands_free = False  # never open the real microphone in tests
    return {
        "prefs_store": store,
        "kb": KnowledgeBase(tmp_path / "brain" / "index.json"),
        "memory": MemoryStore(tmp_path / "memory.json"),
        "routines": RoutineStore(tmp_path / "routines.json"),
        "devices": Devices(tmp_path / "devices.json"),
        "invoice_store": InvoiceStore(tmp_path / "invoices.json", tmp_path / "Invoices"),
        "screen_watch": ScreenWatcher(capture=no_picture),  # never the real screen
        "connectors": ConnectorManager(
            lambda *a, **k: None,
            never_asked,
            vault=MemoryVault(),
            store=tmp_path / "connections.json",
        ),
        "providers": ProviderStore(tmp_path / "providers.json", MemoryVault()),
        "goal_store": GoalStore(tmp_path / "goals.json"),
        # No real Messages or Mail databases, and its state in the temp folder.
        "delegation_store": DelegationStore(tmp_path / "delegations.json"),
        "file_index": FileIndex(tmp_path / "files.db", [], home=tmp_path),  # never the real home
        "transaction_desk": Transactions(
            no_page, never_asked, lambda: store.prefs, log_path=tmp_path / "transactions.json"
        ),
        "interrupter": Interrupter(
            lambda _alert: None, state_path=tmp_path / "interrupts.json", enabled=lambda: False
        ),
        "hearing_store": Hearing(tmp_path / "hearing.json"),
        # Documents in the temp folder, and never opened in a real app.
        "document_store": DocumentStore(
            tmp_path / "documents.json", folder=tmp_path / "Documents", opener=lambda _p: None
        ),
        # No real calendar or Mail behind it.
        "suggester": Suggester(lambda _s: None, tmp_path / "suggestions.json"),
        # Videos only from the temp folder, and write-ups filed there.
        "video_desk": VideoDesk(roots=[tmp_path], notes_dir=tmp_path / "Videos"),
        # Calls to the Jarvis number: never the real call log or its voicemails.
        "call_log": CallLog(tmp_path / "answering.json"),
    }


@pytest.fixture(autouse=True)
def _no_real_claude_for_jarvis_code(monkeypatch):
    """Jarvis Code's own Claude calls (code_ai: commit messages, reviews, the best-of
    judge) never reach Claude in a test: one a test didn't fake fails loudly instead."""
    from jarvis import code_ai

    async def refuse(*_args, **_kwargs):
        raise AssertionError("a test reached code_ai.complete: fake the feature's .ai")

    monkeypatch.setattr(code_ai, "complete", refuse)


@pytest.fixture(autouse=True)
def _no_real_claude_for_jarvis_itself(monkeypatch):
    """JARVIS's own background calls (utility_model: a skill's triage and draft) never
    reach Claude in a test: one a test didn't fake fails loudly instead."""
    from jarvis import utility_model

    async def refuse(*_args, **_kwargs):
        raise AssertionError("a test reached utility_model.run_turn: fake it")

    monkeypatch.setattr(utility_model, "run_turn", refuse)


@pytest.fixture(autouse=True)
def _no_real_reminders(monkeypatch):
    """The Reminders helper (reminders_desk: EventKit in a subprocess) never starts in a
    test, so a briefing's facts never read the owner's real reminders: whatever asks gets
    an error back. test_proactive_reminders fakes the helper's answers itself."""
    from jarvis import reminders_desk

    async def not_here(*_args, **_kwargs):
        return {"error": "Reminders aren't reachable in tests."}

    monkeypatch.setattr(reminders_desk, "_run", not_here)


@pytest.fixture(autouse=True)
def _no_real_maps(monkeypatch):
    """Apple Maps (maps.run_helper: CoreLocation and MapKit in a subprocess) never answers a
    test, so a briefing's trip or a leave-time heads-up never looks up the real one; tests
    that want travel times fake run_helper themselves."""
    from jarvis import maps

    async def not_here(*_args, **_kwargs):
        return {"error": "Maps isn't reachable in tests."}

    monkeypatch.setattr(maps, "run_helper", not_here)
