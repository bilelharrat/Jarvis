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


class FakeClient:
    """Stands in for ClaudeSDKClient: records queries, replays a scripted response."""

    script: list = []

    def __init__(self, options=None):
        self.options = options
        self.queries = []
        self.interrupted = False
        self.connected = False

    async def connect(self):
        self.connected = True

    async def disconnect(self):
        self.connected = False

    async def query(self, text):
        self.queries.append(text)

    async def receive_response(self):
        for message in self.script:
            yield message

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
    speaker.voice, speaker.rate, speaker.muted, speaker._proc = "", 190, True, None
    speaker.effect, speaker.cloud, speaker.cloud_error, speaker._playing = False, None, "", False
    speaker._player = None
    return speaker


@pytest.fixture
def isolated(tmp_path):
    """Prefs and second-brain index in a temp folder, never the user's real ones."""
    from jarvis.connectors import ConnectorManager, MemoryVault
    from jarvis.knowledge import KnowledgeBase
    from jarvis.memory import MemoryStore
    from jarvis.prefs import PrefsStore
    from jarvis.remote import Devices
    from jarvis.routines import RoutineStore

    async def never_asked(*_args):
        return "deny"

    store = PrefsStore(tmp_path / "prefs.json")
    store.prefs.hands_free = False  # never open the real microphone in tests
    return {
        "prefs_store": store,
        "kb": KnowledgeBase(tmp_path / "brain" / "index.json"),
        "memory": MemoryStore(tmp_path / "memory.json"),
        "routines": RoutineStore(tmp_path / "routines.json"),
        "devices": Devices(tmp_path / "devices.json"),
        "connectors": ConnectorManager(
            lambda *a, **k: None,
            never_asked,
            vault=MemoryVault(),
            store=tmp_path / "connections.json",
        ),
    }
