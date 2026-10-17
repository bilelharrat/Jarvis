"""Seeing for the owner through the computer's camera: "what's in front of me?", "read this
letter", "what colour is this shirt?", "which note is this?", "is the stove light on?". Made for
someone who is blind (J.A.R.V.I.S. Daredevil); useful to anyone.

look_through_camera asks the app window for one picture (web/features/camera-look.js opens the
camera, lets it settle, takes a frame and closes it again: the camera's light is on only for
those seconds), and gives the picture to Claude with what the owner wants to know. The picture
is never saved, and it goes nowhere but that request.

Window messages: event camera_cmd {id, wait}; command camera_result {id, image | error}.

Claude cost policy: one picture in the turn the owner asked for; nothing on its own.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from ..picture_files import KEY_FACTS

# The owner may not see the camera, so when something has to be held up, Eden says where
# before the picture is taken, and corrects the position after it, in words they can act on.
POSITIONING = (
    "The owner may be blind, so when they must hold or place something for the camera, say first, "
    "in one or two short sentences, exactly where to put it, then call look_through_camera with "
    "wait_seconds of 6 so they have time (a beep counts the last seconds down and a higher one "
    "marks the picture). The camera is the small lens at the top middle of the laptop screen, "
    "facing them. Tell them: hold it about a hand's length (25 to 30 centimetres, a foot) in "
    "front of the screen, level with the top middle of the screen, facing the screen, held "
    "steady, with the side you need to read toward the camera, fingers off the words, flat and "
    "not curled, and a light in front of them rather than behind. For a page or a note, the "
    "whole sheet in view with its top edge up; for a package, the label side; for a bank note, "
    "held flat by two corners. The picture is the camera's view, so the left of the picture is "
    "the owner's right: when you tell them which way to move, give it from their own side "
    "(toward your left hand, away from your body, a little higher, turn it so the print faces "
    "me) and never in picture terms. After the picture, say in one sentence what to change if "
    "anything is cut off, too close, too far, dark, glaring or blurred, and look again, up to "
    "three tries; when it is in view, say so before you read it."
)
PROMPT = (
    "Seeing for the owner: when they ask what is in front of them, to read something printed or "
    "handwritten (a letter, a page, a label, a sign, a screen across the room), the colour of "
    "something, which bank note or coin, what an object or a package is, whether a light is on, "
    "or to help them find something, call look_through_camera with what they want to know. "
    f"{KEY_FACTS} When they ask for the whole of it, or it is any other printed text, read it in "
    "full, word for word, in reading order, unless they ask for a summary. If the "
    "picture is dark, blurred or cut off, say exactly how to move the thing (closer, further, "
    "left, right, tilt it, turn it over, more light) and offer to look again; wait_seconds gives "
    "them time to hold it in place. Say plainly what you can't make out instead of guessing. Never "
    "say who a person is from their face; describe people only by what they wear and do. "
    f"{POSITIONING}"
)
LABELS = {"look_through_camera": "Looking through the camera"}
WAIT_MAX = 10.0
ANSWER_SECONDS = 30.0


class Camera:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.calls: dict[str, asyncio.Future] = {}

    async def snap(self, wait: float = 1.0) -> tuple[str, str]:
        """(JPEG as base64, "") or ("", why there's none)."""
        if not getattr(self.hub, "browser_available", True):
            return "", "The camera works through the app's window, and it isn't open."
        call_id = uuid.uuid4().hex[:10]
        future = asyncio.get_running_loop().create_future()
        self.calls[call_id] = future
        self.hub.emit("camera_cmd", id=call_id, wait=max(0.0, min(WAIT_MAX, float(wait or 0))))
        try:
            answer = await asyncio.wait_for(future, ANSWER_SECONDS + WAIT_MAX)
        except TimeoutError:
            return "", "The camera didn't answer in time."
        finally:
            self.calls.pop(call_id, None)
        image = str(answer.get("image") or "")
        if image.startswith("data:"):
            image = image.partition(",")[2]
        if not image:
            return "", str(answer.get("error") or "No picture came back from the camera.")[:300]
        return image, ""

    def result(self, msg: dict[str, Any]) -> None:
        future = self.calls.get(str(msg.get("id")))
        if future is not None and not future.done():
            future.set_result(msg)

    def build_server(self) -> Any:
        camera = self

        @tool(
            "look_through_camera",
            "Take one picture with the computer's camera (the picture isn't kept) to see or read "
            "something for the owner. what: what they want to know. wait_seconds: time to hold "
            "the thing in front of the camera first (0 to 10, default 1; use 6 when they have to pick "
            "something up and position it).",
            {
                "type": "object",
                "properties": {"what": {"type": "string"}, "wait_seconds": {"type": "number"}},
            },
        )
        async def look_through_camera(args):
            wait = args.get("wait_seconds")
            image, why = await camera.snap(1.0 if wait is None else float(wait))
            if not image:
                return {"content": [{"type": "text", "text": why}], "is_error": True}
            what = str(args.get("what") or "what is in front of the camera")
            return {
                "content": [
                    {"type": "text", "text": f"The camera's picture, taken just now, for: {what}."},
                    {"type": "image", "data": image, "mimeType": "image/jpeg"},
                ]
            }

        return create_sdk_mcp_server(name="camera", version="0.1.0", tools=[look_through_camera])


def install(hub: Any) -> None:
    camera = Camera(hub)
    hub.camera = camera
    hub.register_command("camera_result", camera.result)
    hub.register_server("camera", camera.build_server, prompt=PROMPT, labels=LABELS)
