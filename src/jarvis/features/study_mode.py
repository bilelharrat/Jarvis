"""Study mode, as the Claude, ChatGPT and Gemini apps have it: JARVIS tutors instead of only
answering. It works through a problem with the owner step by step, asks what they think
before telling, checks they've understood, and offers a short quiz at the end of a topic.

A setting (prefs.features["study_mode"], off by default), switched from the window (the
features/study-mode.js toggle by the request box) or the phone's settings; while it's on, every
request to Claude carries the tutor's note (hub.add_request_context).

Claude cost policy: no extra model call; the note rides on the request.
"""

from __future__ import annotations

from typing import Any

from ..prefs import register_feature_pref

KEY = "study_mode"
register_feature_pref(KEY, False)

NOTE = (
    "Study mode is on: the user wants to learn, so tutor rather than just answer. Find out "
    "what they already know with one short question when it isn't clear. Work through it "
    "step by step, asking what they think the next step is before giving it; give hints "
    "before answers. Explain the why, with a small example. Check their understanding now and "
    "then. When a topic is done, offer a three-question quiz and go over their answers. Keep "
    "each turn short and conversational."
)


def install(hub: Any) -> None:
    async def context(_text: str, display: str | None) -> dict[str, Any] | None:
        if display is not None:  # words someone else sent on, not the owner asking
            return None
        return {"note": NOTE} if hub.prefs.feature(KEY) is True else None

    hub.add_request_context(context)
