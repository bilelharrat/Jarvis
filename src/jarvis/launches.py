"""One-time launch tokens: how a feature that starts an Eden Code session through the hub's
task_new knows which new session is its own, and how "its request is anyone's words" stays
with that session.

A task_new doesn't always start its session at once: code_mentions holds a message with an
@url or @terminal while it gathers them (up to 20 s for a page), code_router while a route is
rated, code_cloud passes it on as a session with no prompt, and meanwhile other sessions start
too, anywhere. Finding "the new session with the card's prompt" after a fixed wait missed
the late ones (they started unlinked, and an issue's not locked down), and taking the first
new session took another's. So the starter puts a token in its message (token(), as KEY); every
feature that holds or re-sends a task_new copies the message whole, token included; the
hub's task_new hands it to TaskManager.start, which stamps it on the task (task.launch_token).
The starter then finds its session by the stamp (find / started), however late it comes.

untrusted travels the same way (the message's "untrusted": True, stamped as task.untrusted):
a session started for an issue or a card from outside is locked down by its stamp (the
to-do board's lock-down, code_cloud never moving it), and such a message's text is never
read for @-mentions (code_mentions, code_voice): an issue's body naming
http://127.0.0.1:3000/admin, @terminal or @session-2 would fetch from the Mac, or bring the
owner's terminal and other sessions into it.

A window can send these keys too: a token only names a session (nobody else knows it), and
untrusted only ever locks one down.
"""

from __future__ import annotations

import asyncio
import secrets
from typing import Any

KEY = "launch_token"  # the token's key in a task_new message
TOKEN_MAX = 64  # characters of a token taken from a message


def token() -> str:
    return secrets.token_hex(16)


def stamp(msg: dict[str, Any]) -> dict[str, Any]:
    """TaskManager.start's launch_token and untrusted, from a task_new message."""
    return {
        "launch_token": str(msg.get(KEY) or "")[:TOKEN_MAX],
        "untrusted": msg.get("untrusted") is True,
    }


def find(tasks: Any, launch: str) -> Any:
    """The session started with this token (the newest, should there be two); None yet."""
    if not launch:
        return None
    mine = [t for t in tasks.tasks.values() if getattr(t, "launch_token", "") == launch]
    return max(mine, key=lambda t: t.id) if mine else None


async def started(tasks: Any, launch: str, wait: float, step: float = 0.05) -> Any:
    """The session started with this token, waited for up to wait seconds; None if it
    hasn't appeared by then (it may still: find it later by the same token)."""
    waited = 0.0
    while True:
        task = find(tasks, launch)
        if task is not None or waited >= wait:
            return task
        await asyncio.sleep(step)
        waited += step
