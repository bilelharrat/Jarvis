"""An incognito conversation with JARVIS (the conversation feature runs it): nothing from it
is kept.

- Claude Code writes no record of it (its --no-session-persistence): it's never among the
  past conversations, the second brain's conversation recall never finds it, and nothing of
  it can be carried on after a restart or reopened.
- It can't remember or forget anything (memory's writing tools are off for its connection),
  and the hub learns nothing from the words said in it (hub.incognito: hearing's words and
  corrections, suggestions' requests; the action log keeps nothing of it either).
- The conversation from before it stays the one to carry on: after a restart, and when the
  owner leaves incognito.

Everything else is as ever: the gates and cards ask as they always do.
"""

from __future__ import annotations

import re
from typing import Any

from . import lang

# Claude Code's own switch: no transcript written for the session, so nothing to resume.
NO_RECORD = "no-session-persistence"
# memory.build_tools' writing tools; recall still reads what was remembered before.
MEMORY_WRITES = ("mcp__memory__remember", "mcp__memory__forget")

PROMPT = (
    "\n\nThis conversation is incognito: the user asked that nothing from it be kept. Claude "
    "Code keeps no record of it and it won't be recalled later. Remembering and forgetting are "
    "off here: if the user asks you to remember or forget something, say you can't while "
    "incognito, and that saying “leave incognito” first will let you."
)
# For Claude, after a connection made again inside an incognito conversation.
LOST = (
    "the connection to Claude Code was made again, and an incognito conversation keeps no "
    "record, so what was said earlier in it is gone from your context; if the user refers "
    "to it, ask them to say it again"
)


def apply(options: Any) -> bool:
    """A connection's options, made incognito. True when it was to carry a conversation on
    (a reconnect): there's no record to carry on, so it starts afresh."""
    extra = dict(options.extra_args or {})
    extra[NO_RECORD] = None
    options.extra_args = extra
    blocked = list(options.disallowed_tools or [])
    options.disallowed_tools = blocked + [t for t in MEMORY_WRITES if t not in blocked]
    if isinstance(options.system_prompt, str) and PROMPT not in options.system_prompt:
        options.system_prompt += PROMPT
    carried = bool(options.resume)
    options.resume = None
    return carried


# ── asked by voice or typed: whole commands only, never words about incognito ──

_LEAD = (
    r"^(?:(?:ok(?:ay)?|hey|hi|jarvis|please|now|so|and|alright|all\s+right)\b[\s,]*)*"
    r"(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|let'?s\s+|i\s+want\s+to\s+"
    r"|i'?d\s+like\s+to\s+|i\s+would\s+like\s+to\s+)?"
)
_MODE = r"(?:\s+(?:mode|conversation|chat|session))?"
_INC = r"(?:the\s+)?incognito" + _MODE
_END = r"(?:[\s,]+(?:please|now|jarvis|then))*[\s.!?]*$"


def _command(*forms: str) -> re.Pattern[str]:
    return re.compile(_LEAD + "(?:" + "|".join(forms) + ")" + _END, re.IGNORECASE)


# "Go incognito", "start an incognito conversation", "turn on incognito mode".
ON = _command(
    r"go\s+(?:into\s+)?incognito" + _MODE,
    r"(?:turn|switch)\s+on\s+" + _INC,
    r"turn\s+incognito" + _MODE + r"\s+on",
    r"switch\s+(?:to|into)\s+(?:an?\s+)?incognito" + _MODE,
    r"(?:start|begin|open|have)\s+(?:an?\s+|the\s+)?(?:new\s+)?incognito" + _MODE,
    r"enter\s+" + _INC,
    r"incognito" + _MODE + r"\s+on",
)
# "Leave incognito", "exit incognito mode", "turn incognito off".
OFF = _command(
    r"(?:leave|exit|quit|end|stop|close)\s+" + _INC,
    r"(?:turn|switch)\s+off\s+" + _INC,
    r"turn\s+incognito" + _MODE + r"\s+off",
    r"get\s+out\s+of\s+" + _INC,
    r"incognito" + _MODE + r"\s+off",
)
# 开启无痕模式, 进入无痕模式, 开始无痕对话; 退出无痕模式, 关闭无痕, 结束无痕对话.
_LEAD_ZH = r"^(?:(?:好的|好|请|麻烦|帮我|那|嗯|贾维斯|jarvis)[，,\s]*)*"
_MODE_ZH = r"(?:模式|对话|聊天)?"
_END_ZH = r"(?:吧|一下|了|好吗|可以吗)?[。！!.？?\s]*$"
ON_ZH = re.compile(
    _LEAD_ZH
    + r"(?:开启|打开|进入|开始|切换到|切到|换成|用)(?:一段|一个)?无痕"
    + _MODE_ZH
    + _END_ZH,
    re.IGNORECASE,
)
OFF_ZH = re.compile(
    _LEAD_ZH + r"(?:关闭|关掉|退出|离开|结束|停止)无痕" + _MODE_ZH + _END_ZH, re.IGNORECASE
)


def asked(text: str, language: str) -> bool | None:
    """True: the owner asked to go incognito; False: to leave it; None: neither."""
    words = " ".join(str(text or "").split())
    if ON.match(words):
        return True
    if OFF.match(words):
        return False
    if lang.is_zh(language):
        simplified = lang.to_simplified(words)
        if ON_ZH.match(simplified):
            return True
        if OFF_ZH.match(simplified):
            return False
    return None
