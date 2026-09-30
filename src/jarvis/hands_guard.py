"""The Mac's own mouse and keyboard, checked in code before a press that pays or sends.

With Settings › Control my Mac without asking on (the default), JARVIS clicks, presses and
types anywhere on the Mac unasked, and so do the instant commands ("click Send"). Two kinds
of press are never left to a line in the prompt:

- A button that buys, books, pays or sends money (Buy, Pay, Place order, Book, Subscribe,
  Confirm purchase, Transfer, Send money, 立即支付, 提交订单…: the purchase guard's own
  final-button words, transactions.is_commit_button, or a bare price like "$4.99") is
  refused outside the built-in browser. Purchases happen there, through
  confirm_transaction and its limits.
- Send, Post, Publish, Delete or Submit in a messaging or mail app (Messages, Mail, Slack,
  WhatsApp, Telegram, Discord, Outlook, WeChat…, and their web versions in a browser),
  and Return, ⌘Return or ⌘⇧D in its message box, goes through the same kind of card as
  send_message: what goes, where, and a yes. Unless the user's own words this turn asked
  for exactly that; and even then, once the conversation has read private data or a web
  page (a look at the screen counts), unless the conversation it goes to is one they
  named in full.

What's under the pointer and what has the keyboard come from a small Swift helper built on
first use (axprobe/jarvis-axprobe.swift: the Accessibility interface, read-only). Until it's
built, or if it can't be, only the app in front is known (lsappinfo), and in a messaging
app any click, Return or Delete asks.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import subprocess
import unicodedata
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import transactions

log = logging.getLogger("jarvis")

AX_SOURCE = Path(__file__).parent / "axprobe" / "jarvis-axprobe.swift"
PROBE_SECONDS = 3.0

# Apps where a press can send, post or delete someone's words: bundle id -> (name, kind).
# "chat": Return in the message box sends; "mail": ⌘Return or ⌘⇧D does, Return is a line.
MESSAGING: dict[str, tuple[str, str]] = {
    "com.apple.MobileSMS": ("Messages", "chat"),
    "com.apple.mail": ("Mail", "mail"),
    "com.tinyspeck.slackmacgap": ("Slack", "chat"),
    "net.whatsapp.WhatsApp": ("WhatsApp", "chat"),
    "desktop.WhatsApp": ("WhatsApp", "chat"),
    "ru.keepcoder.Telegram": ("Telegram", "chat"),
    "org.telegram.desktop": ("Telegram", "chat"),
    "com.hnc.Discord": ("Discord", "chat"),
    "com.microsoft.Outlook": ("Outlook", "mail"),
    "com.microsoft.teams2": ("Microsoft Teams", "chat"),
    "com.microsoft.teams": ("Microsoft Teams", "chat"),
    "org.whispersystems.signal-desktop": ("Signal", "chat"),
    "com.tencent.xinWeChat": ("WeChat", "chat"),
    "com.tencent.qq": ("QQ", "chat"),
    "com.tencent.WeWorkMac": ("WeCom", "chat"),
    "com.alibaba.DingTalkMac": ("DingTalk", "chat"),
    "com.bytedance.macos.feishu": ("Feishu", "chat"),
    "com.electron.lark": ("Lark", "chat"),
    "jp.naver.line.mac": ("LINE", "chat"),
    "com.facebook.archon": ("Messenger", "chat"),
    "com.facebook.archon.developerID": ("Messenger", "chat"),
    "com.skype.skype": ("Skype", "chat"),
    "com.viber.osx": ("Viber", "chat"),
    "im.riot.app": ("Element", "chat"),
    "us.zoom.xos": ("Zoom", "chat"),
    "com.readdle.smartemail-Mac": ("Spark", "mail"),
    "com.readdle.SparkDesktop": ("Spark", "mail"),
    "it.bloop.airmail2": ("Airmail", "mail"),
    "com.superhuman.electron": ("Superhuman", "mail"),
    "com.mimestream.Mimestream": ("Mimestream", "mail"),
    "io.canarymail.mac": ("Canary Mail", "mail"),
    "org.mozilla.thunderbird": ("Thunderbird", "mail"),
}
_BY_NAME = {name.lower(): (name, kind) for name, kind in MESSAGING.values()}
_BY_NAME.update(
    {
        "信息": ("Messages", "chat"),
        "邮件": ("Mail", "mail"),
        "microsoft outlook": ("Outlook", "mail"),
        "微信": ("WeChat", "chat"),
        "企业微信": ("WeCom", "chat"),
        "钉钉": ("DingTalk", "chat"),
        "飞书": ("Feishu", "chat"),
        "zoom.us": ("Zoom", "chat"),
    }
)
# Browsers, where a tab's title says which web app is open.
BROWSERS = frozenset(
    {
        "com.apple.Safari",
        "com.apple.SafariTechnologyPreview",
        "com.google.Chrome",
        "com.google.Chrome.canary",
        "company.thebrowser.Browser",
        "com.brave.Browser",
        "com.microsoft.edgemac",
        "org.mozilla.firefox",
        "com.operasoftware.Opera",
        "com.vivaldi.Vivaldi",
        "com.kagi.kagimacOS",
        "app.zen-browser.zen",
        "org.chromium.Chromium",
    }
)
# Web messaging and mail by a tab's title -> (name, kind).
WEB_APPS: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(p, re.IGNORECASE), name, kind)
    for p, name, kind in (
        (r"\bgmail\b", "Gmail", "mail"),
        (r"\boutlook\b", "Outlook", "mail"),
        (r"\byahoo mail\b", "Yahoo Mail", "mail"),
        (r"\bicloud mail\b", "iCloud Mail", "mail"),
        (r"\bproton ?mail\b", "Proton Mail", "mail"),
        (r"\bslack\b", "Slack", "chat"),
        (r"\bwhatsapp\b", "WhatsApp", "chat"),
        (r"\bdiscord\b", "Discord", "chat"),
        (r"\bmessenger\b", "Messenger", "chat"),
        (r"\btelegram\b", "Telegram", "chat"),
        (r"\bmicrosoft teams\b", "Microsoft Teams", "chat"),
        (r"\blinkedin\b", "LinkedIn", "chat"),
        (r"(?:^|\s)/ x$|\btwitter\b", "X", "chat"),
        (r"\bfacebook\b", "Facebook", "chat"),
        (r"\binstagram\b", "Instagram", "chat"),
        (r"\breddit\b", "Reddit", "chat"),
        (r"\bbluesky\b", "Bluesky", "chat"),
        (r"\bthreads\b", "Threads", "chat"),
        (r"\bmastodon\b", "Mastodon", "chat"),
    )
]

# The words on a button that sends someone words, by what it does. Only a label that
# starts with one ("Send", "Send Later", "Delete for Everyone", "发送"): "Sender",
# "Sent", "Reply" (which opens a message) and "Forward" don't.
_SENDS = [
    ("send", re.compile(r"^(?:send|share|发送|发出|发给|傳送|发送消息)(?![a-z])")),
    ("post", re.compile(r"^(?:post|tweet|reply all and send|发帖|发表)(?![a-z])")),
    ("publish", re.compile(r"^(?:publish|发布)(?![a-z])")),
    (
        "delete",
        re.compile(r"^(?:delete|move to trash|trash|unsend|删除|删掉|撤回|移到废纸篓)(?![a-z])"),
    ),
    ("submit", re.compile(r"^(?:submit|提交)(?![a-z])")),
]
# Keys that press what has the keyboard: a button (Return, Space), a message box's send
# (Return, ⌘Return, ⌘⇧D in Mail), or deleting a selected message.
_RETURNS = {"return", "enter", "cmd+return", "cmd+enter", "ctrl+return", "ctrl+enter",
            "option+return", "alt+return"}  # fmt: skip
_MAIL_SEND = {"cmd+shift+d", "shift+cmd+d", "cmd+return", "cmd+enter"}
_DELETES = {"delete", "backspace", "forwarddelete", "cmd+delete", "cmd+backspace"}
_PRESSES = {"space"}
_TEXT_ROLES = {"AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"}
# Words in a window's title that name the app or the place, not the person or channel.
_PLACE_WORDS = frozenset(
    "slack discord whatsapp telegram messages mail inbox outlook teams microsoft signal "
    "wechat messenger dm channel chat chats thread threads direct message draft drafts new "
    "message re fwd fw the and of in to with".split()
)

Probe = Callable[..., Awaitable[dict[str, Any]]]
Reads = Callable[[], dict[str, Any]]
Asked = Callable[[str], bool]
Send = Callable[[str, str, str, tuple[str, str]], Awaitable[bool]]


def _plain(text: Any) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(text or "")).lower().split())


def purchase_word(labels: Iterable[str]) -> str | None:
    """The first of a control's labels that buys, books or pays (transactions' final-button
    words, or a price alone, like "$4.99")."""
    for label in labels:
        text = str(label or "").strip()
        if not text:
            continue
        if transactions.is_commit_button(text):
            return text
        signed = [m for m in transactions.money_in(text) if m.signed]
        if signed and len(text.split()) <= 4:
            return text
    return None


def send_kind(labels: Iterable[str]) -> str | None:
    """What pressing a control with these labels does to a message: send, post, publish,
    delete or submit. None for anything else."""
    for label in labels:
        text = _plain(label).strip(" .…:!")
        for kind, pattern in _SENDS:
            if pattern.match(text):
                return kind
    return None


def messaging_app(app: str, bundle: str, window: str = "") -> tuple[str, str] | None:
    """(name, "chat" or "mail") for a messaging or mail app, or a browser tab showing one."""
    if bundle in MESSAGING:
        return MESSAGING[bundle]
    found = _BY_NAME.get(_plain(app))
    if found:
        return found
    if bundle in BROWSERS and window:
        for pattern, name, kind in WEB_APPS:
            if pattern.search(window):
                return name, kind
    return None


def _labels(element: Any) -> list[str]:
    """What a control is called (never a text box's contents: clicking into a message that
    says "Buy milk" presses nothing)."""
    if not isinstance(element, dict) or _text_box(element):
        return []
    keys = ("title", "description", "help", "identifier")
    return [str(element[k]) for k in keys if isinstance(element.get(k), str) and element[k]]


def _text_box(element: Any) -> bool:
    return isinstance(element, dict) and (
        element.get("role") in _TEXT_ROLES or bool(element.get("editable"))
    )


def conversation_named(window: str, words: str) -> bool:
    """Whether the user's own words name the conversation a window shows: every word of
    one of its title's parts ("Ann Lee" in "Ann Lee (DM) - BSH - Slack"), the app's and
    the place's own words aside. A first name alone doesn't name "Ann Lee"."""
    said = _plain(words)
    said_words = set(re.findall(r"[^\W_]+", said))
    for part in re.split(r"\s+[-|—–·]\s+|[()\[\]]", window or ""):
        tokens = [t for t in re.findall(r"[^\W_]+", _plain(part)) if t not in _PLACE_WORDS]
        if not tokens:
            continue
        if all(t in said_words or (not t.isascii() and t in said) for t in tokens):
            return True
    return False


# ── the helper ──


def ensure_probe() -> Path | None:
    """Build jarvis-axprobe once (a few seconds with swiftc), cached by the source's hash
    beside the voice player. None if it can't be built."""
    from .prefs import APP_SUPPORT

    if not AX_SOURCE.exists():
        return None
    digest = hashlib.sha256(AX_SOURCE.read_bytes()).hexdigest()[:10]
    binary = APP_SUPPORT / "bin" / f"jarvis-axprobe-{digest}"
    if binary.exists():
        return binary
    binary.parent.mkdir(parents=True, exist_ok=True)
    partial = binary.with_name(f"{binary.name}.{os.getpid()}.part")
    try:
        subprocess.run(
            ["swiftc", "-O", "-o", str(partial), str(AX_SOURCE)],
            check=True,
            capture_output=True,
            timeout=300,
        )
        partial.replace(binary)
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("couldn't build the accessibility probe (%s); the app in front only", exc)
        return None
    finally:
        partial.unlink(missing_ok=True)
    return binary


def front_app() -> dict[str, Any]:
    """The app in front, from lsappinfo (asks the window server; no permission needed)."""
    try:
        front = subprocess.run(
            ["lsappinfo", "front"], capture_output=True, text=True, timeout=3
        ).stdout.strip()
        info = subprocess.run(
            ["lsappinfo", "info", front], capture_output=True, text=True, timeout=3
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    name = re.match(r'\s*"([^"]+)"', info)
    bundle = re.search(r'bundleID="([^"]+)"', info)
    return {"app": name.group(1) if name else "", "bundle": bundle.group(1) if bundle else ""}


class AXProbe:
    """Runs jarvis-axprobe; until it's built (prepare()), or when it can't be, only the app
    in front is known ({"app", "bundle", "fallback": True}). enabled False (tests, a hub
    that doesn't poll): nothing on the Mac is looked at, and nothing is known."""

    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self.binary: Path | None = None
        self._building: asyncio.Task | None = None

    async def prepare(self) -> None:
        if self.enabled and self.binary is None:
            self.binary = await asyncio.to_thread(ensure_probe)

    async def __call__(self, *argv: str) -> dict[str, Any]:
        if not self.enabled:
            return {}
        if self.binary is None:
            if self._building is None:  # built in the background; meanwhile, the app only
                self._building = asyncio.ensure_future(self.prepare())
            return {**await asyncio.to_thread(front_app), "fallback": True}
        try:
            proc = await asyncio.create_subprocess_exec(
                str(self.binary),
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            out, _ = await asyncio.wait_for(proc.communicate(), PROBE_SECONDS)
            found = json.loads(out.decode(errors="replace").strip().splitlines()[-1])
        except (OSError, ValueError, IndexError, TimeoutError) as exc:
            log.info("accessibility probe failed (%s)", type(exc).__name__)
            return {**await asyncio.to_thread(front_app), "fallback": True}
        if not isinstance(found, dict):
            return {"fallback": True}
        if not found.get("trusted"):
            found["fallback"] = True  # the app's name only: no Accessibility yet
        return found


# ── the guard ──


@dataclass
class Scene:
    """What a press lands on: the app (and its window), the control it presses (labels),
    and the text box with the keyboard, when those are known."""

    app: str = ""
    bundle: str = ""
    window: str = ""
    labels: list[str] = field(default_factory=list)
    focused: dict[str, Any] = field(default_factory=dict)
    known: bool = False  # False: the helper couldn't say what's there


class HandsGuard:
    """reads(): what the turn and its conversation have read (hub._gate_reads); words(): the
    user's own words this turn; asked(kind): they asked for that kind of send (send, post,
    publish, delete, submit) in their own words; send(question, detail, spoken, choices):
    the card (hub.send_gate); probe: AXProbe.

    Each check returns None to go ahead, or what to say instead (refused, or declined).
    said: an instant command's own words, when they name this press ("click send", "press
    return"): the user asked for exactly it. own: an instant command at all ("click" where
    the pointer is), so what's said back is for the user, not for Claude."""

    def __init__(
        self,
        *,
        reads: Reads,
        words: Callable[[], str],
        asked: Asked,
        send: Send,
        probe: Probe | None = None,
    ) -> None:
        self._reads, self._words, self._asked, self._send = reads, words, asked, send
        self.probe = probe or AXProbe()

    # ── what each tool is about to do ──

    async def press(
        self, labels: list[str], app: str = "", said: str = "", own: bool = False
    ) -> str | None:
        """A control found by name (press_button, "click Save"), before it's pressed."""
        labels = [str(x) for x in labels if x]
        own = own or bool(said)
        if refused := self._paying(labels, own):
            return refused
        found = await self.probe("focus")
        scene = Scene(
            app=app or str(found.get("app") or ""),
            bundle=str(found.get("bundle") or ""),
            window=str(found.get("window") or ""),
            labels=labels,
            focused=found.get("focused") if isinstance(found.get("focused"), dict) else {},
            known=True,
        )
        return await self._check(scene, "press", said, own)

    async def click(self, x: float, y: float, said: str = "", own: bool = False) -> str | None:
        """A click at a point on the screen (global points)."""
        found = await self.probe("point", f"{x:.1f}", f"{y:.1f}")
        target = found.get("press") or found.get("at")
        scene = Scene(
            app=str(found.get("at_app") or found.get("app") or ""),
            bundle=str(found.get("at_bundle") or found.get("bundle") or ""),
            window=str(found.get("at_window") or found.get("window") or ""),
            labels=_labels(target),
            focused=found.get("at_focused") or found.get("focused") or {},
            known=isinstance(target, dict) and not found.get("fallback"),
        )
        return await self._check(scene, "click", said, own)

    async def keys(self, combo: str, said: str = "", own: bool = False) -> str | None:
        """A key or shortcut, pressed where the keyboard is."""
        combo = "+".join(p for p in _plain(combo).replace(" ", "+").split("+") if p)
        if combo not in _RETURNS | _MAIL_SEND | _DELETES | _PRESSES:
            return None  # moving around, copying, a new tab: nothing is pressed or sent
        found = await self.probe("focus")
        focused = found.get("focused") if isinstance(found.get("focused"), dict) else {}
        scene = Scene(
            app=str(found.get("app") or ""),
            bundle=str(found.get("bundle") or ""),
            window=str(found.get("window") or ""),
            focused=focused,
            known="focused" in found and not found.get("fallback"),
        )
        if not _text_box(focused):
            scene.labels = _labels(focused)  # Return or Space on a button presses it
        return await self._check(scene, "keys", said, own, combo)

    async def typing(self, text: str, said: str = "", own: bool = False) -> str | None:
        """Text typed where the keyboard is: a line break in a chat's message box sends."""
        if "\n" not in text and "\r" not in text:
            return None
        found = await self.probe("focus")
        focused = found.get("focused") if isinstance(found.get("focused"), dict) else {}
        scene = Scene(
            app=str(found.get("app") or ""),
            bundle=str(found.get("bundle") or ""),
            window=str(found.get("window") or ""),
            focused=focused,
            known="focused" in found and not found.get("fallback"),
        )
        return await self._check(scene, "type", said, own, "return", text)

    # ── the rules ──

    @staticmethod
    def _paying(labels: list[str], own: bool = False) -> str | None:
        paying = purchase_word(labels)
        if not paying:
            return None
        label = paying[:60]
        if own:  # the user's own instant command: said back to them
            return (
                f"“{label}” buys, books or pays for something. I only do that in the built-in "
                "browser, where you confirm it first, so press this one yourself."
            )
        return (
            f"“{label}” buys, books or pays for something, and I only do that in the "
            "built-in browser, where the purchase is confirmed first. Open the page there, or "
            "leave this one for the user to press."
        )

    async def _check(
        self, scene: Scene, how: str, said: str, own: bool, combo: str = "", typed: str = ""
    ) -> str | None:
        own = own or bool(said)
        if refused := self._paying(scene.labels, own):
            return refused
        app = messaging_app(scene.app, scene.bundle, scene.window)
        if app is None:
            return None
        name, kind = app
        send = self._sends(scene, how, kind, combo)
        if send is None:
            return None
        if self._clear(send, said, scene):
            return None
        return await self._card(send, name, scene, said, own, combo, typed)

    @staticmethod
    def _sends(scene: Scene, how: str, kind: str, combo: str) -> str | None:
        """What this press does to a message in a messaging app, or None."""
        if how in ("press", "click"):
            found = send_kind(scene.labels)
            if found or scene.known:
                return found
            return "send"  # can't tell what's under the pointer: it may end a message
        if how == "type":
            box = _text_box(scene.focused)
            return "send" if kind == "chat" and (box or not scene.known) else None
        if combo in _PRESSES:
            return send_kind(scene.labels)
        if combo in _DELETES:
            return "delete" if not _text_box(scene.focused) else None
        box = _text_box(scene.focused) or not scene.known
        if combo in _MAIL_SEND and box:
            return "send"
        if combo in _RETURNS and box and kind == "chat":
            return "send"
        return send_kind(scene.labels) if combo in _RETURNS else None

    def _clear(self, send: str, said: str, scene: Scene) -> bool:
        """The user's own words asked for exactly this, and nothing read since could have
        put the words in, or it goes to a conversation they named in full."""
        asked = bool(said) or self._asked(send)
        if not asked:
            return False
        reads = self._reads()
        if not (reads.get("private") or reads.get("web")):
            return True
        return conversation_named(scene.window, said or self._words())

    async def _card(
        self, send: str, app: str, scene: Scene, said: str, own: bool, combo: str, typed: str
    ) -> str | None:
        verb = {"send": "Send", "post": "Post", "publish": "Publish", "delete": "Delete",
                "submit": "Submit"}[send]  # fmt: skip
        message = str(scene.focused.get("value") or "").strip() if scene.focused else ""
        if typed:
            message = f"{message}{typed}".strip()
        lines = [f"In: {app}" + (f" · {scene.window}" if scene.window else "")]
        if message and send != "delete":
            lines.append(f"Message: “{message[:600]}{'…' if len(message) > 600 else ''}”")
        if scene.labels:
            lines.append(f"Button: “{scene.labels[0][:80]}”")
        elif combo:
            lines.append(f"Key: {combo}")
        lines.append("")
        lines.append(self._why(send, said))
        question = f"{verb} this in {app}?"
        spoken = (
            f"Here's your message in {app}: {message} Do you want it sent?"
            if send in ("send", "post") and message and len(message) <= 300
            else f"Can I press {verb} in {app}?"
        )
        choices = (verb, f"Don't {verb.lower()}")
        if await self._send(question, "\n".join(lines), spoken, choices):
            return None
        if own:
            return "Okay, I left it."
        return f"The user said no, so it wasn't done ({verb} in {app}). Don't try it another way."

    def _why(self, send: str, said: str) -> str:
        reads = self._reads()
        if (said or self._asked(send)) and (reads.get("private") or reads.get("web")):
            seen = "; ".join(list(reads.get("what") or [])[:6]) or "outside content"
            return (
                f"Earlier: {seen}. That could have put words or a recipient here, and you "
                "didn't name this conversation in full, so check it before it goes."
            )
        return "You didn't ask me to do this in your own words just now."


ASKED = {
    "hands_send": r"(?:(?:press|hit|click|tap|push)\s+(?:the\s+)?)?(?:send|share"
    r"|text\s+(?!me\b)\S|message\s+(?!me\b)\S|dm\s+\S|email\s+(?!me\b)\S|e-mail\s+\S"
    r"|reply\b|respond\b|write\s+back|tell\s+(?!me\b|us\b)\S|ping\s+\S)",
    "hands_post": r"(?:(?:press|hit|click|tap)\s+(?:the\s+)?)?(?:post|tweet|share)\b",
    "hands_publish": r"(?:(?:press|hit|click|tap)\s+(?:the\s+)?)?(?:publish|post)\b",
    "hands_delete": r"(?:(?:press|hit|click|tap)\s+(?:the\s+)?)?(?:delete|trash|unsend"
    r"|remove\s+(?:the|that|this|it|my)\b|get\s+rid\s+of)",
    "hands_submit": r"(?:(?:press|hit|click|tap)\s+(?:the\s+)?)?(?:submit|send)\b",
}
