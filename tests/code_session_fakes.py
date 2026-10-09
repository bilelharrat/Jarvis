"""Fakes shared by the Eden Code sessions tests (features.code_sessions)."""

import asyncio

from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, UserMessage
from claude_agent_sdk.types import SessionMessage
from conftest import FakeClient

from jarvis.hub import Hub


def res(text="done", total=0.1, sid="s"):
    return ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False,
                         num_turns=1, session_id=sid, total_cost_usd=total, result=text)  # fmt: skip


class Stream(FakeClient):
    """One stream per connection, as the SDK has: each message comes back with its uuid
    (u-N), a reply (a-N) and the turn's end. hold: the next turn waits for release()."""

    instances: list = []

    def __init__(self, options=None):
        super().__init__(options)
        self.total, self.hold, self.held = 0.0, False, []
        Stream.instances.append(self)

    async def query(self, text):
        self.queries.append(text)
        n = len([q for c in Stream.instances for q in c.queries])
        self.total = round(self.total + 0.1, 6)
        turn = [
            UserMessage(content=str(text), uuid=f"u-{n}"),
            AssistantMessage(content=[TextBlock(text=f"reply {n}")], model="m", uuid=f"a-{n}"),
            res(f"reply {n}", self.total),
        ]
        if self.hold:
            self.held += turn
            return
        for m in turn:
            self._stream().put_nowait(m)

    def release(self):
        self.hold = False
        for m in self.held:
            self._stream().put_nowait(m)
        self.held = []


def make_hub(settings, quiet_speaker, isolated, client=Stream):
    return Hub(settings, client_factory=client, speaker=quiet_speaker, poll=False, **isolated)


async def until(condition, tries=400):
    for _ in range(tries):
        if condition():
            return True
        await asyncio.sleep(0.005)
    return False


def events_of(hub):
    seen = []
    queue = hub.subscribe()

    def drain():
        while not queue.empty():
            seen.append(queue.get_nowait())
        return seen

    return drain


async def end_all(hub):
    for task in hub.tasks.tasks.values():
        if task.handle is not None and not task.handle.done():
            task.handle.cancel()
    await asyncio.gather(
        *(t.handle for t in hub.tasks.tasks.values() if t.handle is not None),
        return_exceptions=True,
    )


# A past conversation as Claude Code keeps it: two messages of the user's, each with the
# edits of its round (one of them refused).
CONVERSATION = [
    SessionMessage(type="user", uuid="u-1", session_id="s",
                   message={"role": "user", "content": "add a retry"}),
    SessionMessage(type="assistant", uuid="a-1", session_id="s", message={"role": "assistant", "content": [
        {"type": "tool_use", "id": "e1", "name": "Edit", "input": {"file_path": "/p/net.py"}},
    ]}),
    SessionMessage(type="user", uuid="r-1", session_id="s", message={"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "e1", "content": "ok"},
    ]}),
    SessionMessage(type="assistant", uuid="a-2", session_id="s",
                   message={"role": "assistant", "content": [{"type": "text", "text": "Added."}]}),
    SessionMessage(type="user", uuid="u-2", session_id="s",
                   message={"role": "user", "content": "now the tests"}),
    SessionMessage(type="assistant", uuid="a-3", session_id="s", message={"role": "assistant", "content": [
        {"type": "tool_use", "id": "e2", "name": "Write", "input": {"file_path": "/p/test_net.py"}},
        {"type": "tool_use", "id": "e3", "name": "Edit", "input": {"file_path": "/p/refused.py"}},
    ]}),
    SessionMessage(type="user", uuid="r-2", session_id="s", message={"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "e2", "content": "ok"},
        {"type": "tool_result", "tool_use_id": "e3", "content": "no", "is_error": True},
    ]}),
    SessionMessage(type="assistant", uuid="a-4", session_id="s",
                   message={"role": "assistant", "content": [{"type": "text", "text": "Tested."}]}),
]  # fmt: skip
