"""A trusted person, and a human to fall back on (J.A.R.V.I.S. Daredevil).

Settings › Accessibility › Trusted person (and the first-run setup) keep a helper: a name, an
email address and, optionally, a phone number (a11y_helper_name, a11y_helper_email,
a11y_helper_phone).

- "Send this to my helper": send_to_helper emails them what Claude wrote about the screen or
  the item in hand (an email, a form, an error), behind a card that shows and reads exactly
  what goes. A picture of the screen goes with it only when the owner asked for one in their
  own words ("send a screenshot to my helper"); the card says so.
- "I need help" (said at once, without Claude): who the helper is and how to reach them, and a
  card offering to email them a short note asking them to get in touch.

The email goes from the owner's own account: Mail on a Mac, the account in Settings › Email
accounts on a PC (features/winmail.py).

Claude cost policy: no model call of its own; "I need help" never reaches Claude, and
send_to_helper is one tool call in the turn that asked.
"""

from __future__ import annotations

import base64
import contextlib
import email.utils as eu
import logging
import re
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import mailbox, osplat
from ..prefs import register_feature_pref

log = logging.getLogger("jarvis")

SERVER_NAME = "helper"
MAX_ABOUT = 3000


def _name(value: Any) -> Any:
    if not isinstance(value, str):
        return None
    return " ".join(value.split())[:80]


def _email(value: Any) -> Any:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if value == "" or mailbox.is_address(value) else None


def _phone(value: Any) -> Any:
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    return value if re.fullmatch(r"[+\d][\d ()./-]{0,29}", value) or value == "" else None


register_feature_pref("a11y_helper_name", "", _name)
register_feature_pref("a11y_helper_email", "", _email)
register_feature_pref("a11y_helper_phone", "", _phone)

PROMPT = (
    "The owner's trusted person (their helper): when they ask to send something to their helper "
    '("send this to my helper", "ask my helper about this", "get help with this screen"), '
    "call send_to_helper with a short, plain description of what they need help with: the app "
    "and window, what it says (an error, a form's fields, the email in hand), and what the owner "
    "was trying to do. Read the screen first only as the owner allows. Set picture true only when "
    "the owner asked for a screenshot or picture in their own words. helper_contact says who the "
    "helper is and how to reach them."
)
LABELS = {"send_to_helper": "Emailing your helper", "helper_contact": "Your helper"}

NEED_HELP = re.compile(
    r"^(?:please\s+)?(?:i\s+need\s+(?:some\s+)?help|help\s+me,?\s+i'?m\s+stuck|i'?m\s+stuck|"
    r"i\s+need\s+(?:a\s+)?(?:human|person|real\s+person|my\s+helper)|(?:get|call|contact|reach)\s+my\s+helper|"
    r"who\s+is\s+my\s+helper)\W*$",
    re.I,
)
PICTURE_WORDS = re.compile(
    r"\b(?:screen\s?shot|screen\s?grab|picture|photo|image|snapshot|snap)\b", re.I
)
NO_HELPER = (
    "You haven't set up a trusted person yet. Add their name and email in Settings, "
    "Accessibility, Trusted person, or say “run setup again”."
)


class HelperError(Exception):
    pass


class Helper:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.send: Any = None  # (subject, body, files) -> what was done; tests give their own

    # ── who ──

    def contact(self) -> dict[str, str]:
        f = self.hub.prefs.feature
        return {
            "name": f("a11y_helper_name") or "",
            "email": f("a11y_helper_email") or "",
            "phone": f("a11y_helper_phone") or "",
        }

    def owner(self) -> str:
        return str(getattr(self.hub.prefs, "owner_name", "") or "")

    def how_to_reach(self, who: dict[str, str]) -> str:
        name = who["name"] or "Your helper"
        ways = []
        if who["phone"]:
            ways.append(f"phone {who['phone']}")
        if who["email"]:
            ways.append(f"email {who['email']}")
        if not ways:
            return f"Your helper is {name}, but there's no phone or email for them in Settings."
        return f"Your helper is {name}. You can reach them by " + " or ".join(ways) + "."

    # ── sending ──

    async def deliver(self, subject: str, body: str, files: list[Path]) -> str:
        """Send the email as the card showed it: what was done, or HelperError."""
        address = self.contact()["email"]
        if self.send is not None:
            return await self.send(subject, body, files)
        if osplat.IS_MAC:
            from .. import mac_tools, mailkit

            try:
                await mac_tools.run_applescript(
                    mailkit.SEND_SCRIPT, address, "", "", subject, body, "",
                    "\n".join(str(f) for f in files), timeout=120,
                )  # fmt: skip
            except mac_tools.ToolFailure as exc:
                raise HelperError(f"Mail couldn't send it: {exc}") from exc
            return "sent"
        winmail = getattr(self.hub, "winmail", None)
        if winmail is None:
            raise HelperError("No email account is set up. Open Settings, then Email accounts.")
        service = winmail.service
        account = service.pick("")
        if isinstance(account, str):
            raise HelperError(account)
        account = service._with_name(account)
        name = self.contact()["name"]
        msg = mailbox.build_message(
            account, [eu.formataddr((name, address)) if name else address], subject, body,
            attachments=files,
        )  # fmt: skip
        result = await service._deliver(account, msg, [address], "sent")
        if result.get("is_error"):
            raise HelperError(result["content"][0]["text"])
        return "sent"

    async def picture(self) -> Path | None:
        """A picture of the screen now, as a file to attach (deleted once sent)."""
        watch = getattr(self.hub, "screen_watch", None)
        if watch is None:
            return None
        frame = await watch.latest(0)
        if frame is None:
            return None
        folder = self.hub.feature_path("helper")
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "screen.jpg"
        path.write_bytes(base64.b64decode(frame.image()["data"]))
        return path

    async def send_to_helper(self, args: dict[str, Any]) -> dict[str, Any]:
        who = self.contact()
        if not who["email"]:
            return _text(
                NO_HELPER
                if not who["name"]
                else f"There's no email address for {who['name']} in Settings.",
                True,
            )
        about = " ".join(str(args.get("about") or "").split())[:MAX_ABOUT]
        if not about:
            return _text("Say what the owner needs help with (about).", True)
        wants_picture = bool(args.get("picture"))
        said = str(getattr(self.hub, "_turn_text", "") or "")
        if wants_picture and not PICTURE_WORDS.search(said):
            return _text(
                "A picture of the screen goes only when the owner asks for one in their own words. "
                "Send the description alone, or ask them.",
                True,
            )
        owner = self.owner() or "Your friend"
        name = who["name"] or who["email"]
        subject = f"{owner} would like your help"
        body = (
            f"Hello {who['name'] or ''},\n\n{owner} asked J.A.R.V.I.S. to send you this and would "
            f"like your help:\n\n{about}\n\n"
            + ("A picture of their screen is attached.\n\n" if wants_picture else "")
            + "Sent by J.A.R.V.I.S. on their behalf. Reply to this email, or get in touch with them."
        ).replace("Hello ,", "Hello,")
        detail = (
            f"To {name} <{who['email']}>\nSubject: {subject}\n"
            + ("With a picture of your screen.\n" if wants_picture else "")
            + f"\n{body}"
        )
        spoken = (
            f"Here's what I'll send {name}: {about} "
            + ("With a picture of your screen. " if wants_picture else "")
            + f"Do you want it sent to {name}?"
        )
        if not await self.hub.send_gate(f"Email {name} for help?", detail, spoken):
            return _text("The owner said no. Nothing was sent.", True)
        files: list[Path] = []
        if wants_picture:
            shot = await self.picture()
            if shot is None:
                return _text("I couldn't take a picture of the screen, so nothing was sent.", True)
            files.append(shot)
        try:
            await self.deliver(subject, body, files)
        except HelperError as exc:
            return _text(f"It wasn't sent: {exc}", True)
        finally:
            for f in files:
                with contextlib.suppress(OSError):
                    f.unlink()
        return _text(f"Emailed {name}" + (" with a picture of the screen." if files else "."))

    # ── "I need help" ──

    async def instant(self, words: str) -> str | None:
        if not NEED_HELP.match(" ".join(str(words or "").split())):
            return None
        who = self.contact()
        if not (who["name"] or who["email"] or who["phone"]):
            # Without one, the words are Claude's to answer, outside screen-reader mode.
            a11y = getattr(self.hub, "accessibility", None)
            return NO_HELPER if a11y is not None and a11y.effective() else None
        how = self.how_to_reach(who)
        if not who["email"]:
            return how
        name = who["name"] or who["email"]
        owner = self.owner() or "Your friend"
        subject = f"{owner} would like your help"
        body = (
            f"Hello {who['name'] or ''},\n\n{owner} asked J.A.R.V.I.S. to tell you they need some "
            "help. Please get in touch with them when you can.\n\nSent by J.A.R.V.I.S. on their behalf."
        ).replace("Hello ,", "Hello,")
        first = name.split()[0]
        ok = await self.hub.send_gate(
            f"Email {name} to ask for help?",
            f"{how}\n\nTo {name} <{who['email']}>\nSubject: {subject}\n\n{body}",
            f"{how} Do you want me to email {first} to ask them to get in touch?",
            (f"Email {first}", "Not now"),
        )
        if not ok:
            return f"{how} I didn't email them."
        try:
            await self.deliver(subject, body, [])
        except HelperError as exc:
            return f"The email to {first} wasn't sent: {exc} {how}"
        return f"Emailed {first} to ask them to get in touch."

    def build_server(self) -> Any:
        helper = self

        @tool(
            "send_to_helper",
            "Email the owner's trusted person (their helper) a description of what they need help "
            "with, after a card the owner answers. about: the description. picture: attach a "
            "screenshot, only when the owner asked for one in their own words.",
            {
                "type": "object",
                "properties": {"about": {"type": "string"}, "picture": {"type": "boolean"}},
                "required": ["about"],
            },
        )
        async def send_to_helper(args):
            return await helper.send_to_helper(args or {})

        @tool("helper_contact", "Who the owner's trusted person is, and how to reach them.", {})
        async def helper_contact(_args):
            who = helper.contact()
            if not (who["name"] or who["email"] or who["phone"]):
                return _text(NO_HELPER)
            return _text(helper.how_to_reach(who))

        return create_sdk_mcp_server(
            name=SERVER_NAME, version="0.1.0", tools=[send_to_helper, helper_contact]
        )


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out


def install(hub: Any) -> None:
    helper = Helper(hub)
    hub.a11y_helper = helper
    hub.register_server(SERVER_NAME, helper.build_server, prompt=PROMPT, labels=LABELS)
    hub.register_instant(helper.instant)
