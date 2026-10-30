"""Phase 0 contract test for the Eden Code agent engine.

Verifies the exact interface between TaskManager / option hooks / features and the
underlying agent engine (today `claude_agent_sdk`, and in Phase 3+ `eden_code.engine`):

1. Every `ClaudeAgentOptions` field that `TaskManager.options_for` and option hooks read or write.
2. Every client method that `TaskManager` calls on `task.client` (`connect`, `query`,
   `receive_messages`, `receive_response`, `interrupt`, `set_permission_mode`, `set_model`,
   `get_mcp_status`, `get_context_usage`, `rewind_files`, `stop_task`,
   `reconnect_mcp_server`, `disconnect`, plus async context manager `__aenter__`/`__aexit__`).
3. Every message and block type and field that `TaskManager._on_task_message` and feature sinks
   inspect (`StreamEvent`, `AssistantMessage`, `UserMessage`, `ResultMessage`, `RateLimitEvent`,
   `TaskStartedMessage`, `TaskProgressMessage`, `TaskUpdatedMessage`, `TaskNotificationMessage`,
   `TextBlock`, `ThinkingBlock`, `ToolUseBlock`, `ToolResultBlock`).
4. Permission types (`PermissionResultAllow`, `PermissionResultDeny`, `ToolPermissionContext`),
   hook types (`HookMatcher`), in-process MCP server helpers (`tool`, `create_sdk_mcp_server`,
   `SdkMcpTool`), and session storage functions (`list_sessions`, `get_session_messages`,
   `get_session_info`, `rename_session`, `delete_session`, `SessionMessage`).
"""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any

import claude_agent_sdk as sdk
import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    HookMatcher,
    PermissionResultAllow,
    PermissionResultDeny,
    RateLimitEvent,
    ResultMessage,
    SdkMcpTool,
    SessionMessage,
    StreamEvent,
    TaskNotificationMessage,
    TaskProgressMessage,
    TaskStartedMessage,
    TaskUpdatedMessage,
    TextBlock,
    ThinkingBlock,
    ToolPermissionContext,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    create_sdk_mcp_server,
    delete_session,
    get_session_info,
    get_session_messages,
    list_sessions,
    rename_session,
    tool,
)

from jarvis.acp import AcpClient
from jarvis.config import Settings
from jarvis.tasks import ClaudeTask, TaskManager

# Every ClaudeAgentOptions field read or mutated across TaskManager.options_for and option_hooks.
REQUIRED_OPTION_FIELDS = (
    "max_buffer_size",
    "model",
    "effort",
    "cwd",
    "tools",
    "system_prompt",
    "allowed_tools",
    "disallowed_tools",
    "permission_mode",
    "can_use_tool",
    "add_dirs",
    "plugins",
    "env",
    "settings",
    "include_partial_messages",
    "thinking",
    "setting_sources",
    "enable_file_checkpointing",
    "extra_args",
    "mcp_servers",
    "hooks",
    "resume",
    "fork_session",
    "resume_session_at",
    "strict_mcp_config",
)

# Every async method TaskManager invokes on a connected client.
REQUIRED_CLIENT_METHODS = (
    "__aenter__",
    "__aexit__",
    "connect",
    "disconnect",
    "query",
    "receive_messages",
    "receive_response",
    "interrupt",
    "set_permission_mode",
    "set_model",
    "get_mcp_status",
    "get_context_usage",
    "rewind_files",
    "stop_task",
    "reconnect_mcp_server",
)


def test_options_fields_and_roundtrip(tmp_path: Path) -> None:
    """All fields set by TaskManager.options_for and option_hooks exist and can be mutated."""
    opts = ClaudeAgentOptions()
    for field_name in REQUIRED_OPTION_FIELDS:
        assert hasattr(opts, field_name), f"ClaudeAgentOptions missing {field_name}"

    tm = TaskManager(Settings(projects_dir=tmp_path), lambda **_k: None, lambda *_a, **_k: None)
    task = ClaudeTask(
        id=1,
        prompt="build feature",
        cwd=tmp_path,
        mode="ask",
        model="claude-opus-5-5",
        effort="high",
    )
    built = tm.options_for(task)
    for field_name in REQUIRED_OPTION_FIELDS:
        assert hasattr(built, field_name), f"options_for result missing {field_name}"
    assert built.cwd == str(tmp_path)
    assert built.include_partial_messages is True
    assert built.enable_file_checkpointing is True
    assert callable(built.can_use_tool)
    assert isinstance(built.mcp_servers, dict)
    assert "TodoWrite" in built.allowed_tools
    assert built.tools == {"type": "preset", "preset": "claude_code"}


@pytest.mark.parametrize("client_cls", [ClaudeSDKClient, AcpClient])
def test_client_surface_methods_exist(client_cls: type[Any]) -> None:
    """Both ClaudeSDKClient and alternative engines expose the full method surface."""
    for method_name in REQUIRED_CLIENT_METHODS:
        attr = getattr(client_cls, method_name, None)
        assert attr is not None, f"{client_cls.__name__} missing {method_name}"
        assert callable(attr), f"{client_cls.__name__}.{method_name} is not callable"


def test_message_and_block_types_and_fields() -> None:
    """All streamed message and content block types construct and expose expected attributes."""
    tb = TextBlock(text="hello")
    assert tb.text == "hello"

    thb = ThinkingBlock(thinking="let me think", signature="sig-1")
    assert thb.thinking == "let me think"
    assert thb.signature == "sig-1"

    tub = ToolUseBlock(id="tu_1", name="Read", input={"file_path": "/tmp/a.py"})
    assert tub.id == "tu_1"
    assert tub.name == "Read"
    assert tub.input == {"file_path": "/tmp/a.py"}

    trb = ToolResultBlock(tool_use_id="tu_1", content="1\thello\n", is_error=False)
    assert trb.tool_use_id == "tu_1"
    assert trb.content == "1\thello\n"
    assert trb.is_error is False

    am = AssistantMessage(
        content=[thb, tb, tub],
        model="gemini-4-argon",
        parent_tool_use_id=None,
        error=None,
        uuid="msg-a-1",
    )
    assert am.content == [thb, tb, tub]
    assert am.model == "gemini-4-argon"
    assert am.parent_tool_use_id is None
    assert am.error is None
    assert am.uuid == "msg-a-1"

    um = UserMessage(
        content=[trb],
        uuid="msg-u-1",
        parent_tool_use_id=None,
    )
    assert um.content == [trb]
    assert um.uuid == "msg-u-1"
    assert um.parent_tool_use_id is None

    se = StreamEvent(
        uuid="ev-1",
        session_id="sess-1",
        event={"type": "content_block_delta", "delta": {"type": "text_delta", "text": "hi"}},
        parent_tool_use_id=None,
    )
    assert se.uuid == "ev-1"
    assert se.session_id == "sess-1"
    assert se.event["type"] == "content_block_delta"
    assert se.parent_tool_use_id is None

    rm = ResultMessage(
        subtype="success",
        duration_ms=120,
        duration_api_ms=100,
        is_error=False,
        num_turns=2,
        session_id="sess-1",
        total_cost_usd=0.01,
        usage={"input_tokens": 100, "output_tokens": 50},
        result="hello",
        stop_reason="end_turn",
    )
    assert rm.subtype == "success"
    assert rm.is_error is False
    assert rm.num_turns == 2
    assert rm.session_id == "sess-1"
    assert rm.total_cost_usd == 0.01
    assert rm.usage == {"input_tokens": 100, "output_tokens": 50}
    assert rm.result == "hello"
    assert rm.stop_reason == "end_turn"

    for cls in (
        RateLimitEvent,
        TaskStartedMessage,
        TaskProgressMessage,
        TaskUpdatedMessage,
        TaskNotificationMessage,
    ):
        assert inspect.isclass(cls)


@pytest.mark.asyncio
async def test_permissions_hooks_and_inprocess_mcp_contract() -> None:
    """Permission types, HookMatcher, and @tool / create_sdk_mcp_server work as TaskManager expects."""
    allow = PermissionResultAllow(updated_input={"x": 1}, updated_permissions=[])
    assert allow.behavior == "allow"
    assert allow.updated_input == {"x": 1}

    deny = PermissionResultDeny(message="blocked", interrupt=True)
    assert deny.behavior == "deny"
    assert deny.message == "blocked"
    assert deny.interrupt is True

    ctx = ToolPermissionContext(signal=None, suggestions=[])
    assert hasattr(ctx, "suggestions")
    assert hasattr(ctx, "tool_use_id")
    assert hasattr(ctx, "agent_id")

    async def sample_hook(data: dict[str, Any], tool_use_id: str | None, context: Any) -> dict[str, Any]:
        return {}

    matcher = HookMatcher(matcher="Bash", hooks=[sample_hook])
    assert matcher.matcher == "Bash"
    assert matcher.hooks == [sample_hook]

    @tool("ping", "Return pong", {"text": str})
    async def ping_tool(args: dict[str, Any]) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": f"pong:{args['text']}"}]}

    assert isinstance(ping_tool, SdkMcpTool)
    assert ping_tool.name == "ping"
    assert ping_tool.description == "Return pong"
    res = await ping_tool.handler({"text": "ok"})
    assert res == {"content": [{"type": "text", "text": "pong:ok"}]}

    srv = create_sdk_mcp_server(name="test_srv", version="1.0.0", tools=[ping_tool])
    assert srv["type"] == "sdk"
    assert srv["name"] == "test_srv"
    assert "instance" in srv


def test_session_storage_functions_signature() -> None:
    """Session persistence functions used by tasks.py and history UI exist with expected signatures."""
    for fn in (list_sessions, get_session_messages, get_session_info, rename_session, delete_session):
        assert callable(fn)
    sm = SessionMessage(
        type="user",
        uuid="u-1",
        session_id="s-1",
        message={"role": "user", "content": [{"type": "text", "text": "hi"}]},
    )
    assert sm.type == "user"
    assert sm.uuid == "u-1"
    assert sm.session_id == "s-1"
    assert hasattr(sdk, "__all__")
