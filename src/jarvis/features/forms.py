"""A forms helper on a PC (jarvis.winforms does the work through UI Automation): the fields of
the form in the window in front, read out (label, kind, what it holds, whether it must be
filled), and the owner's answers filled in one field at a time, each read back. Made for
someone who can't see the form (J.A.R.V.I.S. Daredevil).

One approval covers a fill: the card lists every field and the answer going into it, and
nothing is touched before the owner allows it. The fields are found again in the same window
(by its handle, not whatever is in front once the card has been answered), and a field whose
label no longer matches is left alone. Password fields are never read or filled, and nothing is
ever submitted: pressing the form's own button is the owner's call (press_control, when they ask).

On a Mac this says it is a PC feature.

Claude cost policy: no model call of its own; these are tools of the ordinary conversation.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import osplat

log = logging.getLogger("jarvis")

PROMPT = (
    "\n- Forms on a PC: when the owner wants to fill in a form (a web page, an app's dialog), "
    "list_form_fields reads the fields of the window in front; say how many there are and which "
    "must be filled, then each by its number, label and what it holds. Ask them for the "
    "answers, then fill_form with all of them at once (field number or label, and the answer; "
    "yes or no for a check box; the choice's name for a drop-down): it asks them once, fills "
    "each field and reads each back. Never guess an answer they didn't give, never fill a "
    "password, and never submit the form unless they ask. On a Mac these tools say it is a PC "
    "feature."
)
LABELS = {"list_form_fields": "Reading the form", "fill_form": "Filling in the form"}
MAC = (
    "Reading and filling forms this way is a feature of the PC edition for now. On this Mac, "
    "I can read the screen and type into a field you name instead."
)


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out


def _quoted(value: str) -> str:
    return f"“{value}”" if value else "nothing"


def field_line(f: dict[str, Any]) -> str:
    parts = [f"{f['number']}. {f['label']}, {f['kind']}"]
    if f["group"]:
        parts[0] += f" in {f['group']}"
    if f["kind"] in ("check box", "option"):
        parts.append(f["value"])
    elif f["kind"] != "password field":
        parts.append(f"holds {_quoted(f['value'])}")
    if f["required"]:
        parts.append("required")
    if not f["enabled"]:
        parts.append("unavailable")
    elif f["readonly"] and f["kind"] == "text field":
        parts.append("read only")
    return ", ".join(parts) + "."


def form_said(form: dict[str, Any]) -> str:
    fields = form.get("fields") or []
    where = form.get("title") or form.get("app") or "the window in front"
    if not fields:
        return f"I found no fields to fill in {where}."
    required = [f for f in fields if f["required"]]
    empty = [f for f in required if f["kind"] not in ("check box", "option") and not f["value"]]
    head = f"{len(fields)} fields in {where}"
    if required:
        head += f", {len(required)} required ({len(empty)} of those still empty)"
    return "\n".join([head + ".", *(field_line(f) for f in fields)])


class Forms:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.form: dict[str, Any] = {}  # the form last read: {title, app, handle, fields}

    async def read(self) -> dict[str, Any]:
        """The form in the window in front, kept for fill_form."""
        from .. import winforms

        form = await asyncio.to_thread(winforms.form_fields, 0)
        if not own_window(form):
            self.form = form
        return form

    def match(self, which: Any) -> dict[str, Any] | None:
        """The field an answer is for: its number, or its label (exact, else the one label
        that holds the words or is held in them)."""
        fields = self.form.get("fields") or []
        text = str(which if which is not None else "").strip()
        if text.isdigit():
            n = int(text)
            return next((f for f in fields if f["number"] == n), None)
        want = " ".join(text.split()).casefold()
        if not want:
            return None
        exact = [f for f in fields if f["label"].casefold() == want]
        if exact:
            return exact[0]
        near = [f for f in fields if want in f["label"].casefold() or f["label"].casefold() in want]
        return near[0] if len(near) == 1 else None

    async def fill(self, answers: list[dict[str, Any]]) -> dict[str, Any]:
        from .. import winforms

        if not self.form.get("fields"):
            await self.read()
        if not self.form.get("fields"):
            return _text("I found no form fields in the window in front.", error=True)
        plan: list[tuple[dict[str, Any], str]] = []
        unknown: list[str] = []
        for answer in answers:
            if not isinstance(answer, dict):
                continue
            which = answer.get("field")
            field = self.match(which)
            value = str(answer.get("value") if answer.get("value") is not None else "")
            if field is None:
                unknown.append(str(which))
            elif field["kind"] == "password field":
                return _text(
                    f"{field['label']} is a password field: they type that themselves.", error=True
                )
            else:
                plan.append((field, value))
        if unknown:
            return _text(
                f"No field like {', '.join(unknown)} in the form. Read it again with list_form_fields.",
                error=True,
            )
        if not plan:
            return _text("No answers were given.", error=True)
        where = self.form.get("title") or self.form.get("app") or "the form"
        count = f"{len(plan)} field{'s' if len(plan) != 1 else ''}"
        question = f"Fill in {count} in {where}?"
        detail = "\n".join(f"{f['number']}. {f['label']}: {value}" for f, value in plan)
        if not await self.hub._ask_user(question, detail):
            return _text("They said no; nothing was filled.")
        lines, filled = [], 0
        handle = int(self.form.get("handle") or 0)
        for field, value in plan:
            got = await asyncio.to_thread(
                winforms.fill_field, handle, field["number"], value, field["label"]
            )
            if not got.get("ok"):
                lines.append(
                    f"{field['number']}. {field['label']}: not filled. {got.get('why', '')}".strip()
                )
                if "closed" in str(got.get("why")) or "changed" in str(got.get("why")):
                    break
                continue
            filled += 1
            now = str(got.get("now") or "")
            line = f"{field['number']}. {field['label']}: now {now if field['kind'] in ('check box', 'option') else 'holds ' + _quoted(now)}."
            if (
                field["kind"] in ("text field", "drop-down", "number box")
                and now.strip().casefold() != value.strip().casefold()
            ):
                line += f" (Not exactly what was asked: {_quoted(value)}.)"
            lines.append(line)
        head = f"Filled {filled} of {len(plan)} fields, each read back:"
        try:
            after = await asyncio.to_thread(winforms.form_fields, handle)
            self.form = after if after.get("fields") else self.form
            missing = [
                f["label"]
                for f in after.get("fields") or []
                if f["required"]
                and f["kind"] not in ("check box", "option")
                and not f["value"]
                and f["kind"] != "password field"
            ]
        except Exception:  # noqa: BLE001 - the summary is extra; the fill is done
            missing = []
        tail = []
        if missing:
            tail.append(f"Still empty and required: {', '.join(missing)}.")
        tail.append("The form isn't submitted: that's for them to say.")
        return _text("\n".join([head, *lines, *tail]))

    def build_tools(self) -> list[Any]:
        forms = self

        @tool(
            "list_form_fields",
            "The fields of the form in the window in front (a PC): each one's number, label, "
            "kind, what it holds, and whether it is required.",
            {"type": "object", "properties": {}},
        )
        async def list_form_fields(_args):
            if not osplat.IS_WIN:
                return _text(MAC)
            try:
                form = await forms.read()
            except Exception:  # noqa: BLE001 - UI Automation failed on that window
                log.info("forms: reading the window failed", exc_info=True)
                return _text("I couldn't read the window in front.", error=True)
            if own_window(form):
                return _text(
                    "The window in front is this app's own. Switch to the form (Alt+Tab), then "
                    "ask again, or ask by voice while the form is in front."
                )
            return _text(form_said(form))

        @tool(
            "fill_form",
            "Fill in the form last read with list_form_fields (a PC): answers is a list of "
            "{field: its number or label, value: the answer (yes or no for a check box, the "
            "choice for a drop-down)}. Asks the owner once, then fills each field and reads it "
            "back. Never submits.",
            {
                "type": "object",
                "properties": {
                    "answers": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "field": {"type": ["string", "integer"]},
                                "value": {"type": "string"},
                            },
                            "required": ["field", "value"],
                        },
                    }
                },
                "required": ["answers"],
            },
        )
        async def fill_form(args):
            if not osplat.IS_WIN:
                return _text(MAC)
            answers = args.get("answers")
            if not isinstance(answers, list):
                return _text("answers must be a list of {field, value}.", error=True)
            try:
                return await forms.fill(answers)
            except Exception:  # noqa: BLE001 - UI Automation failed on that window
                log.info("forms: filling failed", exc_info=True)
                return _text("Something went wrong filling the form.", error=True)

        return [list_form_fields, fill_form]

    def build_server(self) -> Any:
        return create_sdk_mcp_server(name="forms", version="0.1.0", tools=self.build_tools())


OWN_APPS = ("jarvis", "daredevil", "eden")


def own_window(form: dict[str, Any]) -> bool:
    """The window in front is this app's own (the owner typed the request into it)."""
    app = re.sub(r"[^a-z]", "", str(form.get("app") or "").casefold())  # J.A.R.V.I.S..exe
    return any(name in app for name in OWN_APPS)


def install(hub: Any) -> None:
    forms = Forms(hub)
    hub.forms = forms
    hub.register_server("forms", forms.build_server, prompt=PROMPT, labels=LABELS)
