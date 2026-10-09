"""What a request from a group chat may use.

In a group, only the owner's own messages are requests, and everyone in the group reads the
answer, so each group has its own setting (Settings › Chats):

- none: no tools at all, only a web search; JARVIS answers from what it knows.
- read (the default): tools that only look (the calendar, mail, notes, files, the web).
- act: also tools that change things on the Mac, each asking the owner as it always does.

Whatever the setting, a request from a group never sends anything anywhere else (a message,
an email, a file, a call, a WhatsApp, a delegated conversation), never spends (a purchase, a
booking, an order), never drives the mouse, keyboard or built-in browser, and never starts
or steers Eden Code. Those are refused before they run (a PreToolUse hook, so the tools
JARVIS is otherwise allowed to run unasked are weighed too); the owner can ask for them in
their direct chat instead. Approval cards a group's request puts up go to the owner's direct
chat, never to the group, so no one else can answer them.
"""

from __future__ import annotations

import re
from typing import Any

from .. import brain, undo

LEVELS = ("none", "read", "act")

# Whole servers that send, call, delegate or spend.
_NEVER_SERVERS = (
    "mcp__transactions__",
    "mcp__orders__",
    "mcp__calls__",
    "mcp__delegate__",
    f"mcp__{brain.BROWSER_SERVER}__",
    "mcp__computer__",
)
# What reaches someone else, or spends, by name: send_message, email_invoice, call_me,
# reserve_table, whatsapp_send, send_file_to_chat, confirm_transaction…
_ACTS = (
    r"send|email|call|ring|reply|post|share|forward|delegate|book|reserve|buy|pay|purchase|"
    r"order|checkout|transfer|tip|donate|invite|publish|upload|dial"
)
_NEVER_NAME = re.compile(rf"^(?:{_ACTS})(?:_|$)|_(?:{_ACTS})$")
# A tool named for looking (list_calls, read_email, order_status) only looks.
_LOOKS = re.compile(r"^(?:list|read|get|search|find|recent|check|lookup)_|_status$")
_NEVER_TOOLS = frozenset(
    {
        *undo.OUTWARD,
        "undo_action",  # an action, though undo lists it beside the looking ones
        "voice_code",
        "run_claude_code",
        "resume_claude_session",
        "message_claude_task",
        "stop_claude_task",
        "open_url",
        "open_app",
        "quit_app",
        "run_shortcut",
        "hand_control",
    }
)
_PUBLIC = frozenset({"WebSearch"})


def _short(tool_name: str) -> str:
    return str(tool_name).split("__")[-1]


def never_from_a_group(tool_name: str) -> bool:
    name = str(tool_name)
    short = _short(name)
    return (
        name.startswith(_NEVER_SERVERS)
        or short in _NEVER_TOOLS
        or (bool(_NEVER_NAME.search(short)) and not _LOOKS.search(short))
        or name in brain.CODE_TOOLS
        or brain.browser_acting(name)
    )


def allowed(level: str, tool_name: str) -> bool:
    """Whether a request from a group with this setting may run this tool."""
    if tool_name in _PUBLIC:
        return True
    if level not in LEVELS or level == "none" or never_from_a_group(tool_name):
        return False
    if level == "read":
        return undo.looking(tool_name)
    return True


def refusal(level: str, tool_name: str) -> str:
    """What Claude hears when a group's request reaches for a tool it may not use."""
    if level == "none":
        why = "this group is set to answer without tools"
    elif never_from_a_group(tool_name):
        why = "nothing is sent, called, bought or run elsewhere from a group chat"
    else:
        why = "this group is set to read-only"
    return (
        f"Not from a group: {why}. Don't retry it or find another way; answer with what you "
        "have, and tell the owner they can ask for it in their direct chat with you."
    )


def decision(level: str, tool_name: str) -> dict[str, Any]:
    """The PreToolUse hook's answer: {} lets the usual rules decide; a deny stops it."""
    if allowed(level, tool_name):
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": refusal(level, tool_name),
        }
    }
