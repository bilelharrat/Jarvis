"""Click an element to send it (the code-pick feature): an element of the page Eden Code's
Preview shows (the project's dev server in the built-in browser) goes with the owner's next
message to a session: its outer HTML (trimmed), key computed styles, a unique CSS selector,
the page's address and a cropped picture of it, as a text document and a picture
(element_words.attachments), shown on the composer as one chip ("Element: button.buy").

Two ways to pick one:
- Pick mode (web/features/code-pick.js, app/features/element-pick.js): the Preview pane's
  "Pick an element", the More menu or /pick; the page highlights what the pointer is over,
  a click takes it, Esc gives up. The window sends what was taken (cp_picked) and gets the
  attachments back (cp_attach) for its composer.
- Said, for Eden Daredevil ("pick the button under the price", "select the email field"):
  the window reads the page's accessibility tree (role, name and box of each element) for
  this module (cp_find -> cp_tree), which finds the element the words describe
  (element_words.resolve), says it back and asks on a card answerable by voice ("The button
  “Add to cart”, under “$19.99”. Attach it?"). On a yes the window takes it (cp_capture ->
  cp_captured): into the composer, or while voice coding, with the next request said to
  the session in focus (as point and speak sends what the hand points at).

Trust (audit S29/S31 stay as they are): only a page on this Mac (localhost, a loopback
address, *.localhost: the session's own dev server) or a file the owner opened in the
address bar themselves is ever read or picked from (the app checks the tab, and this module
checks the address again); never a site on the internet. What the page says goes to the
session marked as the page's own content: data, never instructions. A pick said in someone
else's voice (hub._voice_allows) is dropped; nothing here answers a session's question or
changes how it asks (the S9 voice gates are voicecode's and untouched).

Window commands: cp_picked {pick, id, ref}, cp_tree {id, result}, cp_captured {id, pick}.
Events: cp_attach {items, label, id, ref} (ref: the window's own pick, or the capture call it
answered: only that window's composer takes it), cp_find {id}, cp_capture {id, index, find}
(find: the tree call; only the window that answered it takes the element), cp_error {text}.

Cost policy (Claude): no model call. The words are matched by rule; the session's own model
reads what is attached, as part of the owner's message.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from .. import element_words as ew
from ..voicecode import parse as voice_command

log = logging.getLogger("jarvis")

TREE_WAIT = 4.0  # seconds the window has to read the page's tree
CAPTURE_WAIT = 6.0  # ...and to take the element and its picture
NODES_MAX = 800  # elements of a page's tree looked at, at most
NO_PAGE = (
    "Open your dev server's page in the browser first: I can only pick from a page on this Mac."
)


def clean_nodes(raw: Any) -> list[dict[str, Any]]:
    """The page's tree as the window sent it: each node's index, role, name and box only."""
    out: list[dict[str, Any]] = []
    for node in raw if isinstance(raw, list) else []:
        if not isinstance(node, dict) or len(out) >= NODES_MAX:
            continue
        box = node.get("box")
        if not (isinstance(box, list) and len(box) == 4):
            continue
        if not all(isinstance(v, int | float) and not isinstance(v, bool) for v in box):
            continue
        index = node.get("i")
        if isinstance(index, bool) or not isinstance(index, int):
            continue
        out.append(
            {
                "i": index,
                "role": " ".join(str(node.get("role") or "").split())[:40],
                "name": " ".join(str(node.get("name") or "").split())[:200],
                "box": [float(v) for v in box],
            }
        )
    return out


class CodePick:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.calls: dict[str, asyncio.Future] = {}
        # A spoken pick confirmed while voice coding: it goes with the next request said to
        # that session (session id -> its attachments and chip name).
        self.held: dict[int, tuple[list[dict[str, str]], str]] = {}

    def install(self) -> None:
        hub = self.hub
        hub.register_command("cp_picked", self.on_picked)
        hub.register_command("cp_tree", self.on_answer)
        hub.register_command("cp_captured", self.on_answer)
        voicecode = getattr(hub, "voicecode", None)
        if voicecode is not None and hasattr(voicecode, "hooks"):
            voicecode.hooks.append(self.voice_hook)
        hub.register_instant(self.instant)

    def error(self, text: str) -> None:
        self.hub.emit("cp_error", text=text)

    # ── pick mode: the window's click ──

    def on_picked(self, msg: dict[str, Any]) -> None:
        pick = ew.clean_pick(msg.get("pick"))
        if pick is None:
            self.error("Only an element of a page on this Mac can be picked.")
            return
        self.hub.emit(
            "cp_attach",
            items=ew.attachments(pick),
            label=ew.label(pick),
            id=msg.get("id") or 0,
            ref=str(msg.get("ref") or "")[:40],  # the window that clicked: its composer only
        )

    # ── the window's answers ──

    def on_answer(self, msg: dict[str, Any]) -> None:
        future = self.calls.get(str(msg.get("id") or ""))
        if future is not None and not future.done():
            future.set_result(msg)

    async def ask_window(self, event: str, wait: float, **values: Any) -> dict[str, Any] | None:
        call = uuid.uuid4().hex[:12]
        future = asyncio.get_running_loop().create_future()
        self.calls[call] = future
        self.hub.emit(event, id=call, **values)
        try:
            return await asyncio.wait_for(future, wait)
        except TimeoutError:
            return None
        finally:
            self.calls.pop(call, None)

    # ── said: "pick the button under the price" ──

    def code_sessions(self) -> bool:
        tasks = getattr(getattr(self.hub, "tasks", None), "tasks", {}) or {}
        return any(getattr(t, "kind", "") == "code" for t in tasks.values())

    async def voice_hook(self, text: str, task: Any) -> bool:
        """Voice coding: a pick said is ours; so is the next request after a pick, which
        goes to the session with the element."""
        description = ew.pick_request(text)
        if description is not None:
            check = getattr(self.hub, "_heard_voice", None)
            self.hub._spawn(self.spoken_pick(description, check, task))
            return True
        held = self.held.get(getattr(task, "id", -1))
        if held is not None and voice_command(text).kind == "send":
            items, _name = self.held.pop(task.id)
            request = await self.hub.with_code_hints(task, text)
            await self.hub.voicecode._send(task, request, hint=False, images=items)
            return True
        return False

    async def instant(self, text: str) -> str | None:
        """Said or typed to Eden: a pick, when there are Eden Code sessions to send it to."""
        description = ew.pick_request(text)
        if description is None or not self.code_sessions():
            return None
        check = getattr(self.hub, "_heard_voice", None)
        self.hub._spawn(self.spoken_pick(description, check, None))
        return ""

    async def spoken_pick(self, description: ew.Description, check: Any, focus: Any) -> None:
        try:
            await self._spoken_pick(description, check, focus)
        except Exception:  # whatever went wrong, it's said, never left hanging
            log.exception("Eden Code: a spoken pick failed")
            self.hub.say("I couldn't pick that element.")

    async def _spoken_pick(self, description: ew.Description, check: Any, focus: Any) -> None:
        hub = self.hub
        if not await hub._voice_allows(check):
            return  # someone else's voice: dropped, as their other requests are
        answer = await self.ask_window("cp_find", TREE_WAIT)
        result = (answer or {}).get("result") if isinstance(answer, dict) else None
        if not isinstance(result, dict) or not result.get("ok"):
            message = result.get("message") if isinstance(result, dict) else ""
            hub.say(str(message or NO_PAGE)[:300])
            return
        if not ew.pick_url_ok(str(result.get("url") or "")):
            hub.say(NO_PAGE)
            return
        found = ew.resolve(clean_nodes(result.get("nodes")), description)
        if not found:
            hub.say(ew.not_found(description))
            return
        best = found[0]
        spoken = ew.readback(best, description)
        hub._say(spoken)  # said first: the card's yes may then be said too
        detail = ew.node_words(best.node)
        choice = await hub.request_approval(
            "Attach this element?",
            detail[:1].upper() + detail[1:],
            [("allow", "Attach it"), ("deny", "No")],
            context={"source": "code_pick"},
            spoken=spoken,
        )
        if not str(choice).startswith("allow"):
            hub.say("Okay, nothing attached.")
            return
        # Taken by the window that read the tree (find: its call), into its own composer.
        find = str(answer.get("id") or "") if isinstance(answer, dict) else ""
        taken = await self.ask_window("cp_capture", CAPTURE_WAIT, index=best.node["i"], find=find)
        pick = ew.clean_pick((taken or {}).get("pick") if isinstance(taken, dict) else None)
        if pick is None:
            hub.say("The page changed before I could take it. Try again.")
            return
        items, name = ew.attachments(pick), ew.label(pick)
        voicecode = getattr(hub, "voicecode", None)
        task = focus or (getattr(voicecode, "task", None) if voicecode is not None else None)
        if task is not None and getattr(task, "kind", "") == "code":
            self.held[task.id] = (items, name)
            hub.say("Attached. Say what to do with it.")
            return
        ref = str(taken.get("id") or "") if isinstance(taken, dict) else ""
        hub.emit("cp_attach", items=items, label=name, id=0, ref=ref)
        hub.say("Attached to your message. Say or type what to do with it.")


def install(hub: Any) -> None:
    feature = CodePick(hub)
    hub.code_pick = feature
    feature.install()
