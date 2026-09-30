"""Record and replay: a task the owner does once in the built-in browser, recorded as steps
and saved under a name, then done again by name ("run my soup order").

- Recording: the address bar's Record button records the tab on show. page-ai-preload.js
  tells each click, what's typed into a box (on leaving it, or on Enter), a choice from a
  list and a press of Enter, each with where it was: the page's address, a CSS selector, the
  words on what was pressed, the box's label. A password, a card or a one-time code is never
  recorded: that step says the owner types there. A new address typed in the middle becomes
  an Open step. Stop shows the steps to name the task and edit it (what's typed changed, a
  step taken out) before it's saved (browser_macros.json).
- Replay (run_macro, Claude's tool: "run my soup order"; Settings' Run asks for it in the
  owner's words): the recorded start page opens in JARVIS's own tab, as browser_open opens
  one (its egress check first); then each step goes through the guards JARVIS's own browser
  tools go through: the turn gate's acting check (browser_gate, weighed as browser_click,
  browser_type or browser_act would be, on the tab the step lands in), then hub.browser_call,
  with watch mode, the hand back and the purchase guard in front of it; a press the page
  marks as sending, paying or deleting needs the owner's OK.
- It stops safely, and says at which step and why: the page isn't the one recorded (another
  address), what the step presses or types into isn't there (or there are two now: it
  never guesses), a guard or the owner says no, or it's the owner's turn (a password, a
  captcha, a code). from_step picks up from there.

A snapshot's refs (e12) don't outlive the page, so steps keep selectors, words and
addresses, and a ref is found as each step is replayed: a press takes the ref a snapshot
gives the thing with its words (the nth of them, as the page counted), else goes by its
words, never by a selector on a page with prices (the purchase guard's rule); a choice
takes its list's ref.

Cost policy: no model calls of its own; run_macro is a tool call in a turn the owner asked
for (Settings' Run asks for one ordinary turn).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any
from urllib.parse import urlsplit

from claude_agent_sdk import tool

from ... import jsonstore, lang
from ...brain import browser_tool
from ...browser_agent import act_args, jarvis_open, untrusted
from ...browser_gate import read_where
from .sites import host_of

log = logging.getLogger("jarvis")

KINDS = ("open", "click", "type", "select", "press")
MAX_MACROS = 50
MAX_STEPS = 100
NAME_CHARS = 60
TEXT_CHARS = 2000
WAIT_MS = 6000  # after a step, for the page to settle
PROBE_SECONDS = 5.0
LABEL_CHARS = 48  # a press by its words: as long as the window's label for a thing
PRESS_ROLES = frozenset(
    {"button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
     "menuitemradio", "option", "treeitem", "disclosure", "clickable"}
)  # fmt: skip
LIST_ROLES = frozenset({"combobox", "listbox"})
PROMPT = (
    "\n- Recorded tasks: the user records a task in the built-in browser (the address bar's "
    "Record button) and saves it by name; run_macro does it again by name ('run my soup "
    "order'), each step through the browser's guards, and says where it stopped and why if "
    "the page changed or it's the user's turn; list_macros shows them."
)
LABELS = {"run_macro": "Ran a recorded task", "list_macros": "Looked at the recorded tasks"}
RUN_WORDS = "Run my recorded task “{name}”."
SECRET_TURN = "they type this themselves (a password, a card or a code is never recorded)"


def _clip(value: Any, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def page_path(url: Any) -> str:
    """Where a step happens, to tell whether the page is still the one recorded: its host
    and path (a query and a fragment change from visit to visit); "" for no web page."""
    try:
        parts = urlsplit(str(url or "").strip())
        host = parts.hostname
    except ValueError:
        return ""
    if parts.scheme.lower() not in ("http", "https") or not host:
        return ""
    return f"{host.removeprefix('www.')}{parts.path.rstrip('/') or '/'}"


def clean_step(raw: Any) -> dict[str, Any] | None:
    """A step as the page told it or the owner edited it, bounded; None for one that isn't."""
    if not isinstance(raw, dict) or raw.get("kind") not in KINDS:
        return None
    url = str(raw.get("url") or "").strip()[:2000]
    if not page_path(url):
        return None
    kind = raw["kind"]
    step: dict[str, Any] = {"kind": kind, "url": url}
    if kind == "open":
        return step
    step["selector"] = str(raw.get("selector") or "")[:300]
    step["field"] = _clip(raw.get("field"), 80)
    if kind == "type":
        if raw.get("secret"):
            step["secret"] = True
            step["text"] = ""
        else:
            step["text"] = str(raw.get("text") or "")[:TEXT_CHARS]
        if raw.get("submit"):
            step["submit"] = True
    elif kind == "press":
        step["key"] = "Enter"
    else:
        step["text"] = _clip(raw.get("text"), 200)
        if kind == "click":
            step["tag"] = _clip(raw.get("tag"), 20).lower()
        if not (step["selector"] or step["text"]):
            return None
    return step


def _moves(step: dict[str, Any]) -> bool:
    """A step that can take the tab to another page."""
    return step["kind"] in ("click", "press", "select") or bool(step.get("submit"))


def add_step(steps: list[dict[str, Any]], step: dict[str, Any]) -> None:
    """A recorded step onto the list: typing into the same box again keeps what was last in
    it, Enter right after typing there sends it (one step, and the box's own change after
    that is no step), and a step on another page with nothing before it that could have
    gone there (an address typed) comes after an Open."""
    last = steps[-1] if steps else None
    if len(steps) >= MAX_STEPS:
        return
    if last and page_path(step["url"]) != page_path(last["url"]) and not _moves(last):
        steps.append({"kind": "open", "url": step["url"]})
        last = steps[-1]
    same_box = bool(last) and last["kind"] == "type" and last["selector"] == step.get("selector")
    if same_box and step["kind"] == "type" and last.get("submit") and step["text"] == last["text"]:
        return  # the box's change, told after Enter sent it (a page that stays put: its address moved)
    if same_box and step["kind"] == "type" and page_path(last["url"]) == page_path(step["url"]):
        merged = dict(step)
        if last.get("submit"):
            merged["submit"] = True
        steps[-1] = merged
        return
    if same_box and step["kind"] == "press" and not last.get("secret"):
        last["submit"] = True
        return
    steps.append(step)


def describe(step: dict[str, Any]) -> str:
    """A step in words (for Claude; the window has its own, in the owner's language)."""
    kind = step["kind"]
    if kind == "open":
        return f"open {step['url']}"
    if kind == "press":
        return "press Enter"
    into = f" into “{step['field']}”" if step.get("field") else ""
    if kind == "type":
        if step.get("secret"):
            return f"the user types{into} themselves"
        typed = f"type “{_clip(step.get('text'), 120)}”{into}"
        return typed + (", then Enter" if step.get("submit") else "")
    if kind == "select":
        inside = f" in “{step['field']}”" if step.get("field") else ""
        return f"choose “{step.get('text')}”{inside}"
    return f"press “{step.get('text') or step.get('selector')}”"


_ITEM = re.compile(r'^\[(e\d+)\]\s+([^"(=]+?)(?:\s+("(?:[^"\\]|\\.)*"))?(?:\s|$)')


def snapshot_items(text: Any) -> list[tuple[str, str, str]]:
    """A snapshot's controls as (ref, role, name), in the page's order."""
    items = []
    for line in str(text or "").splitlines():
        m = _ITEM.match(line.strip().lstrip("+~").strip())
        if not m:
            continue
        name = ""
        if m.group(3):
            try:
                name = str(json.loads(m.group(3)))
            except ValueError:
                name = ""
        items.append((m.group(1), m.group(2).strip(), name))
    return items


def same_words(name: str, words: str) -> bool:
    """A snapshot's name for a thing and the words recorded on it: the same, any case (the
    snapshot clips a long name with "…")."""
    a, b = _clip(name, 400).lower(), _clip(words, 400).lower()
    if a.endswith("…") and len(a) > 20:
        return b.startswith(a[:-1])
    return bool(a) and a == b


class _Stop(Exception):
    """A step that can't go: its status ("changed", "refused") and why."""

    def __init__(self, status: str, why: str) -> None:
        super().__init__(why)
        self.status, self.why = status, why


class Macros:
    def __init__(self, hub: Any, bridge: Any, page: Any) -> None:
        self.hub = hub
        self.bridge = bridge
        self.page = page  # pagectx.PageContext: the tab on show
        self._macros: list[dict[str, Any]] | None = None
        self.unreadable = ""  # the file is there but can't be read: nothing is saved over it
        self.recording: dict[str, Any] | None = None  # {tab, state, steps}

    # ── the saved tasks ──

    @property
    def path(self):
        return self.hub.feature_path("browser_macros.json")

    def macros(self) -> list[dict[str, Any]]:
        if self._macros is None:
            try:
                raw = jsonstore.load_json(self.path, list) or []
            except jsonstore.Unreadable as exc:
                self.unreadable = exc.strerror or "it can't be read"
                log.warning("recorded tasks: %s can't be read (%s)", self.path.name, exc)
                raw = []
            self._macros = [m for m in map(self._clean_macro, raw[:MAX_MACROS]) if m]
        return self._macros

    @staticmethod
    def _clean_macro(raw: Any) -> dict[str, Any] | None:
        if not isinstance(raw, dict) or not isinstance(raw.get("steps"), list):
            return None
        name = _clip(raw.get("name"), NAME_CHARS)
        steps = [s for s in map(clean_step, raw["steps"][:MAX_STEPS]) if s]
        if not name or not steps or steps[0]["kind"] != "open":
            return None
        try:
            saved = float(raw.get("saved") or 0)
        except (TypeError, ValueError, OverflowError):
            saved = 0.0
        return {"name": name, "steps": steps, "saved": saved}

    def find(self, name: str) -> dict[str, Any] | None:
        """A task by its name as said: exactly (any case), else the one name it's part of
        or that's part of it ("my soup order" finds "soup order")."""
        want = _clip(name, 200).strip("“”\"' .").lower()
        if not want:
            return None
        for m in self.macros():
            if m["name"].lower() == want:
                return m
        near = [m for m in self.macros() if want in m["name"].lower() or m["name"].lower() in want]
        return near[0] if len(near) == 1 else None

    async def save(self) -> bool:
        if self.unreadable:
            log.warning("recorded tasks: not saved over a file that can't be read")
            return False
        data = list(self.macros())
        try:
            await asyncio.to_thread(jsonstore.save_json, self.path, data, indent=None)
        except OSError:
            log.warning("recorded tasks: they couldn't be saved")
            return False
        return True

    def payload(self) -> dict[str, Any]:
        items = [
            {"name": m["name"], "steps": len(m["steps"]), "site": host_of(m["steps"][0]["url"])}
            for m in self.macros()
        ]
        return {"items": items}

    def emit(self) -> None:
        self.hub.emit("browser_ai_macros", **self.payload())

    # ── recording ──

    def _emit_recording(self, error: str = "") -> None:
        rec = self.recording
        data: dict[str, Any] = {"state": rec["state"] if rec else "idle"}
        if rec:
            data["tab"] = rec["tab"]
            data["count"] = len(rec["steps"])
            if rec["state"] == "review":
                data["steps"] = rec["steps"]
        if error:
            data["error"] = error
        self.hub.emit("browser_ai_recording", **data)

    async def start(self) -> None:
        state = self.page.page
        if not state.web or state.tab is None:
            self._emit_recording("There's no web page to record.")
            return
        answer = await self.bridge.call("record", {"tab": state.tab, "on": True}, timeout=5.0)
        if answer.get("ok") is False or answer.get("error") or not page_path(answer.get("url")):
            self._emit_recording("This page can't be recorded.")
            return
        start = {"kind": "open", "url": str(answer["url"]).strip()[:2000]}
        self.recording = {"tab": state.tab, "state": "recording", "steps": [start]}
        self._emit_recording()

    async def stop(self, keep: bool) -> None:
        """Stop recording: on to the review (keep, and a step was recorded), else let go."""
        rec = self.recording
        if rec is not None and rec["state"] == "recording":
            await self.bridge.call("record", {"on": False}, timeout=5.0)
            if keep and len(rec["steps"]) > 1:
                rec["state"] = "review"
            else:
                self.recording = None
        elif rec is not None and not keep:
            self.recording = None  # the review let go
        self._emit_recording()

    def on_step(self, msg: dict[str, Any]) -> None:
        """browser_ai_record_step: a step the page told, from the tab being recorded."""
        rec = self.recording
        if rec is None or rec["state"] != "recording" or msg.get("tab") != rec["tab"]:
            return
        step = clean_step(msg.get("step"))
        if step is None or step["kind"] == "open":
            return
        add_step(rec["steps"], step)
        self._emit_recording()

    async def on_record(self, msg: dict[str, Any]) -> None:
        """browser_ai_record: {action: start | stop | cancel}."""
        action = msg.get("action")
        if action == "start":
            if self.recording is not None and self.recording["state"] == "recording":
                self._emit_recording()
                return
            await self.start()
        elif action in ("stop", "cancel"):
            await self.stop(keep=action == "stop")

    async def on_save(self, msg: dict[str, Any]) -> None:
        """browser_ai_macro_save: the reviewed steps under a name (the owner's edits kept; a
        task of the same name is replaced)."""
        name = _clip(msg.get("name"), NAME_CHARS)
        raw = msg.get("steps") if isinstance(msg.get("steps"), list) else []
        steps = [s for s in map(clean_step, raw[:MAX_STEPS]) if s]
        if steps and steps[0]["kind"] != "open":
            steps.insert(0, {"kind": "open", "url": steps[0]["url"]})
        if not name or len(steps) < 2:
            self._emit_recording("Give it a name and keep at least one step.")
            return
        others = [m for m in self.macros() if m["name"].lower() != name.lower()]
        if len(others) >= MAX_MACROS:
            self._emit_recording(f"There are already {MAX_MACROS} recorded tasks.")
            return
        before = self._macros
        self._macros = [*others, {"name": name, "steps": steps, "saved": time.time()}]
        if not await self.save():
            self._macros = before
            self._emit_recording("The task couldn't be saved.")
            return
        self.recording = None
        self._emit_recording()
        self.emit()

    async def on_delete(self, msg: dict[str, Any]) -> None:
        """browser_ai_macro_delete: {name}."""
        name = _clip(msg.get("name"), NAME_CHARS).lower()
        kept = [m for m in self.macros() if m["name"].lower() != name]
        if len(kept) != len(self.macros()):
            before = self._macros
            self._macros = kept
            if not await self.save():
                self._macros = before
        self.emit()

    def on_list(self, _msg: dict[str, Any]) -> None:
        self.emit()
        self._emit_recording()

    def on_run(self, msg: dict[str, Any]) -> None:
        """browser_ai_macro_run: Settings' Run, a request in the owner's words (one turn)."""
        macro = self.find(str(msg.get("name") or ""))
        if macro is not None:
            words = lang.tr(RUN_WORDS, self.hub.language, name=macro["name"])
            self.hub._spawn(self.hub.ask(words))

    def command(self, handler: Any) -> Any:
        """A window command that runs in the background (it waits on the window's answers,
        which come in on the same socket)."""
        return lambda msg: self.hub._spawn(handler(msg))

    # ── replay ──

    async def run(self, name: str, from_step: Any = 1) -> dict[str, Any]:
        macro = self.find(name)
        if macro is None:
            names = ", ".join(f"“{m['name']}”" for m in self.macros()) or "none yet"
            missing = f"There's no recorded task called “{_clip(name, 60)}”. Recorded: {names}."
            return _text(missing, True)
        steps = macro["steps"]
        try:
            first = int(from_step or 1)
        except (TypeError, ValueError):
            first = 1
        first = max(1, min(first, len(steps)))
        done: list[str] = []
        for number in range(first, len(steps) + 1):
            step = steps[number - 1]
            status, note = await self._step(step)
            if status != "ok" or note:
                return _text(self._stopped(macro, number, status, note, done), True)
            done.append(f"{number}. {describe(step)}")
        here = await read_where(self.hub._browser_routed)
        where = f"{here.get('title', '')} — {here.get('url', '')}".strip(" —")
        text = f"“{macro['name']}”: done (steps {first} to {len(steps)})."
        return _text(text + (f" Now on:\n{untrusted(where)}" if where else ""))

    def _stopped(
        self, macro: dict[str, Any], number: int, status: str, note: str, done: list[str]
    ) -> str:
        total = len(macro["steps"])
        step = macro["steps"][number - 1]
        head = f"“{macro['name']}”, step {number} of {total} ({describe(step)})"
        if status == "ok":  # it went, and the page it led to needs the user
            lines = [f"{head} went, and now it's the user's turn: {note}"]
            if number < total:
                lines.append(
                    f"When they've done their part, run_macro with from_step {number + 1} "
                    "carries on."
                )
        elif status == "turn":
            again = "" if step.get("secret") else f" (from_step {number} does that step again)"
            lines = [
                f"Stopped at {head}: it's the user's turn: {note}",
                f"When they've done their part, run_macro with from_step {number + 1} carries "
                f"on after it{again}.",
            ]
        elif status == "refused":
            lines = [
                f"Stopped at {head}: {note}",
                "Don't do the step another way. If what stopped it gets sorted (the user's OK, "
                f"their part on the page), run_macro with from_step {number} tries it again; "
                "else tell the user in a sentence where it stopped and why.",
            ]
        else:  # the page isn't as it was recorded
            lines = [
                f"Stopped at {head}: {note}",
                "The page isn't as it was when it was recorded: tell the user in a sentence "
                "where it stopped and why, and don't try the step another way.",
            ]
        if done:
            lines.append("Done before it: " + "; ".join(done))
        return "\n".join(lines)

    async def _step(self, step: dict[str, Any]) -> tuple[str, str]:
        """One step through the guards: ("ok", "") when it went; ("ok", what) when it went
        and the page needs the user now; else "turn", "refused" or "changed", and why."""
        hub = self.hub
        if step["kind"] == "open":
            if not await hub._egress_ok(browser_tool("browser_open"), {"url": step["url"]}):
                return "refused", "the user didn't OK opening it"
            opened = await jarvis_open(hub, {"url": step["url"]})
            if opened.get("error") or opened.get("ok") is False:
                return "refused", _said(opened)
            if opened.get("turn"):
                return "ok", str(opened["turn"])
            waited = await hub.browser_call("wait", {"idle": True, "ms": WAIT_MS})
            return "ok", str(waited.get("turn") or "")
        here = await read_where(hub._browser_routed)
        if page_path(here.get("url")) != page_path(step["url"]):
            now = here.get("url") or "no page"
            why = f"the page isn't the one recorded (it's {now}; the step was on {step['url']})"
            return "changed", why
        if step["kind"] == "type" and step.get("secret"):
            return "turn", SECRET_TURN
        kind = step["kind"]
        found = await self._probe(step) if kind != "press" else None
        named = step.get("text") if kind == "click" else step.get("field")
        what = f"“{_clip(named or step.get('selector'), 80)}”"
        if found is not None:
            if not found["count"]:
                return "changed", f"{what} isn't on the page any more"
            if found["nth"] < 0:
                return "changed", f"there's more than one {what} on the page now: no guessing"
            if found.get("secret"):
                return "turn", f"the box {what} wants a password, a card or a code now"
            if kind == "select" and found.get("has") is False:
                return "changed", f"the list {what} has no “{step.get('text')}” any more"
        try:
            tool_name, action, gate_args, args = await self._plan(step, found, what)
        except _Stop as stop:
            return stop.status, stop.why
        if await hub.browser_gate.check(browser_tool(tool_name), gate_args) is False:
            return "refused", "the user said no"
        result = await hub.browser_call(action, args)
        if result.get("needsConfirm"):  # it sends, pays or deletes: the user's OK first
            label = str(result.get("label") or step.get("text") or "that")
            asked = f"Click “{label}” in the browser?"
            if not hub.prefs.control_always and not await hub.confirm(asked):
                return "refused", f"the user said no to pressing “{_clip(label, 80)}”"
            result = await hub.browser_call(action, {**args, "force": True})
        if result.get("ok") is False and result.get("turn"):
            return "turn", str(result["turn"])
        if result.get("error") or result.get("ok") is False:
            return "refused", _said(result)
        if result.get("turn"):
            return "ok", str(result["turn"])
        waited = await hub.browser_call("wait", {"idle": True, "ms": WAIT_MS})
        return "ok", str(waited.get("turn") or "")

    async def _plan(
        self, step: dict[str, Any], found: dict[str, Any] | None, what: str
    ) -> tuple[str, str, dict[str, Any], dict[str, Any]]:
        """The call a step makes, as JARVIS's own browser tools make it: (the tool the turn
        gate weighs it as, the browser action, the tool's arguments, the window's). A press
        goes by the ref a snapshot gives the thing with its words (the nth of them, as the
        page counted), else by its words (a page with prices takes nothing else), weighed as
        a press of those words either way; typing goes into the box the page finds now; a
        choice in a list, by the list's ref."""
        kind = step["kind"]
        selector = str((found or {}).get("selector") or step.get("selector") or "")
        if kind == "type":
            gate = {"text": step.get("text", ""), "field": step.get("field", "")}
            gate["submit"] = bool(step.get("submit"))
            return "browser_type", "type", gate, {**gate, "selector": selector}
        if kind == "click" and not step.get("text"):
            return "browser_click", "click", {"selector": selector}, {"selector": selector}
        if kind == "click":
            words = str(step["text"])
            label = words if len(words) <= LABEL_CHARS else words[: LABEL_CHARS - 1] + "…"
            count, nth = (found["count"], found["nth"]) if found is not None else (1, 0)
            ref = await self._press_ref(words, count, nth)
            if not ref and count > 1:
                raise _Stop("changed", f"there's more than one {what} on the page now: no guessing")
            if not ref:
                return "browser_click", "click", {"text": label}, {"text": label}
            args, why = act_args({"action": "click", "ref": ref})
            if args is None:
                raise _Stop("refused", why)
            return "browser_click", "act", {"text": label}, args
        if kind == "press":
            gate = {"action": "press", "key": "Enter"}
        else:
            ref = await self._list_ref(step)
            if not ref:
                raise _Stop("changed", f"the list {what} isn't on the page any more")
            gate = {"action": "select", "ref": ref, "values": [step.get("text", "")]}
        args, why = act_args(gate)
        if args is None:
            raise _Stop("refused", why)
        return "browser_act", "act", gate, args

    async def _probe(self, step: dict[str, Any]) -> dict[str, Any] | None:
        """page-ai-preload.js probe, in the tab the step lands in: whether what the step
        presses, types into or chooses in is there, how many on show have its words and
        which of them it is, and its selector now. None when the page didn't answer (the
        step then goes by its words or its recorded selector, through the guards as ever)."""
        args: dict[str, Any] = {
            "kind": step["kind"],
            "selector": step.get("selector", ""),
            "text": step.get("text", "") if step["kind"] != "type" else "",
            "field": step.get("field", ""),
        }
        tab = self.hub.browser_tabs.jarvis_tab(self.hub._rid)
        if tab:
            args["tab"] = tab
        found = await self.bridge.call("probe", args, timeout=PROBE_SECONDS)
        if found.get("ok") is False or found.get("error") or "selector" not in found:
            return None
        try:
            count, nth = max(0, int(found.get("count") or 0)), int(found.get("nth", -1))
        except (TypeError, ValueError):
            return None
        return {**found, "count": count, "nth": nth if 0 <= nth < count else -1}

    async def _snapshot(self) -> list[tuple[str, str, str]]:
        snap = await self.hub.browser_call("snapshot", {"interactive": True})
        return snapshot_items(snap.get("text"))

    async def _press_ref(self, words: str, count: int, nth: int) -> str:
        """The ref of the nth of count things on show with these words, from a snapshot
        (which lists them in the page's order): "" unless it lists as many as the page
        counted (the page didn't answer: count 1, nth 0, when the snapshot has just one)."""
        hits = [
            ref
            for ref, role, name in await self._snapshot()
            if role in PRESS_ROLES and same_words(name, words)
        ]
        return hits[nth] if len(hits) == count and 0 <= nth < count else ""

    async def _list_ref(self, step: dict[str, Any]) -> str:
        """The ref of the list a choice was made in: the combobox named as the step's field,
        else the only one on the page."""
        want = str(step.get("field") or "")
        lists = [(ref, name) for ref, role, name in await self._snapshot() if role in LIST_ROLES]
        named = [ref for ref, name in lists if want and same_words(name, want)]
        if len(named) == 1:
            return named[0]
        return lists[0][0] if len(lists) == 1 and not named else ""

    def listed(self) -> dict[str, Any]:
        if not self.macros():
            return _text(
                "No recorded tasks yet: the user records one with the address bar's Record button."
            )
        lines = []
        for m in self.macros():
            site = host_of(m["steps"][0]["url"])
            lines.append(f"- “{m['name']}”: {len(m['steps'])} steps on {site}")
            lines += [f"  {n}. {describe(s)}" for n, s in enumerate(m["steps"][:25], start=1)]
        return _text("\n".join(lines))

    def tools(self) -> list:
        macros = self

        @tool(
            "run_macro",
            "Do a task the user recorded in the built-in browser, by its name, step by step "
            "through the browser's guards. It stops, and says where and why, if the page "
            "changed or it's the user's turn; from_step (1 = the start) picks up from a step.",
            {
                "type": "object",
                "properties": {"name": {"type": "string"}, "from_step": {"type": "integer"}},
                "required": ["name"],
            },
        )
        async def run_macro(args):
            return await macros.run(str(args.get("name") or ""), args.get("from_step") or 1)

        @tool(
            "list_macros",
            "The tasks the user recorded in the built-in browser, and their steps.",
            {},
        )
        async def list_macros(_args):
            return macros.listed()

        return [run_macro, list_macros]


def _said(result: dict[str, Any]) -> str:
    return _clip(result.get("error") or result.get("message") or "it didn't work", 400)


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out
