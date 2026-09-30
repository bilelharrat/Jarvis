"""JARVIS's past conversations, read from Claude Code's own records of the brain's sessions
(its working folder, as the second brain's conversations source reads them): listed with
titles and dates, searched, and read back as the two sides' words, never the app's notes,
tool results or pictures.

Every read goes through the SDK's session functions (list_sessions, get_session_messages,
get_session_info), passed in so tests use fakes and never the owner's ~/.claude. The calls
read files: run them in a thread.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .brain_sources import ONE_OFF, conversation_lines, workspace

log = logging.getLogger("jarvis")

MAX_LISTED = 200  # past conversations listed, newest first
SHOWN_ENTRIES = 400  # of a conversation read back, its newest entries
ENTRY_CHARS = 8000
TITLE_CHARS = 100
PREVIEW_CHARS = 200
# The app's note in front of a request, as Claude Code's listing gives the first prompt
# (its newlines made spaces, cut at 200 characters).
_APP_NOTE = re.compile(r"^\[Note from the app:.*?\](?:\s{2,}|$)", re.S)


def _sdk() -> tuple[Callable[..., Any], Callable[..., Any], Callable[..., Any]]:
    from claude_agent_sdk import get_session_info, get_session_messages, list_sessions

    return list_sessions, get_session_messages, get_session_info


def owner_words(text: str | None) -> str:
    """A request as the owner put it: without the app's note in front."""
    text = str(text or "").strip()
    if text.startswith("[Note from the app:"):
        stripped = _APP_NOTE.sub("", text, count=1)
        text = "" if stripped == text else stripped
    return " ".join(text.split())


def one_off(first_prompt: str | None) -> bool:
    """A session in the brain's folder that isn't a conversation with the owner: a
    meeting's write-up, a reply drafted for someone else."""
    return str(first_prompt or "").strip().startswith(ONE_OFF)


def listing(
    folder: Path | None = None,
    titles: dict[str, str] | None = None,
    *,
    list_sessions: Callable[..., Any] | None = None,
    limit: int = MAX_LISTED,
) -> list[dict[str, Any]]:
    """The past conversations, newest first: {session_id, title, preview, at (ms)}. titles:
    what the app knows each one by (its first request), for those Claude Code's own
    listing can't name (its first prompt starts with the app's long note)."""
    lister = list_sessions or _sdk()[0]
    folder = folder or workspace()
    if not folder.is_dir():
        return []
    try:
        found = lister(directory=str(folder), limit=limit, include_worktrees=False)
    except Exception:  # a damaged record: nothing listed rather than an error
        log.warning("past conversations couldn't be listed", exc_info=True)
        return []
    items: list[dict[str, Any]] = []
    for info in found or []:
        sid = str(getattr(info, "session_id", "") or "")
        first = str(getattr(info, "first_prompt", "") or "")
        if not sid or one_off(first):
            continue
        said = owner_words(first)
        custom = " ".join(str(getattr(info, "custom_title", "") or "").split())
        title = (titles or {}).get(sid) or custom or said or ""
        items.append(
            {
                "session_id": sid,
                "title": title[:TITLE_CHARS],
                "preview": said[:PREVIEW_CHARS],
                "at": int(getattr(info, "last_modified", 0) or 0),
            }
        )
    return items


def matching(items: list[dict[str, Any]], query: str, more: set[str] | None = None) -> list:
    """The listed conversations a search finds: every word of it in the title or preview
    (any case), plus those the second brain found by their words (more: session ids)."""
    words = query.casefold().split()
    if not words:
        return items
    found = []
    for item in items:
        text = f"{item['title']} {item['preview']}".casefold()
        if all(w in text for w in words) or item["session_id"] in (more or set()):
            found.append(item)
    return found


def entries(
    session_id: str,
    folder: Path | None = None,
    *,
    get_messages: Callable[..., Any] | None = None,
) -> list[dict[str, str]] | None:
    """A conversation's words, oldest first ({role: user|assistant, text}), its newest
    SHOWN_ENTRIES; None when its record can't be read."""
    reader = get_messages or _sdk()[1]
    try:
        messages = reader(session_id, directory=str(folder or workspace()))
    except Exception:
        log.warning("a past conversation couldn't be read", exc_info=True)
        return None
    out: list[dict[str, str]] = []
    for line in conversation_lines(messages or []):
        if line.startswith("You: "):
            out.append({"role": "user", "text": line[5:][:ENTRY_CHARS]})
        elif line.startswith("Jarvis: "):
            out.append({"role": "assistant", "text": line[8:][:ENTRY_CHARS]})
    return out[-SHOWN_ENTRIES:]


def exists(
    session_id: str,
    folder: Path | None = None,
    *,
    get_info: Callable[..., Any] | None = None,
) -> Any:
    """Claude Code's record of that conversation (its SDKSessionInfo), or None when it
    isn't there any more (cleaned up, or never written)."""
    getter = get_info or _sdk()[2]
    try:
        return getter(session_id, directory=str(folder or workspace()))
    except Exception:
        return None
