"""What every chat channel shares: a message as the router sees it, the channel's side of
sending, how a reply is cut and marked up for each app, pairing codes and rate limits."""

from __future__ import annotations

import html
import re
import secrets
import time
import unicodedata
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .router import Channels

CODE_SECONDS = 600  # a pairing code lasts ten minutes
CODE_TRIES = 5  # wrong codes from one sender within CODE_LOCK: that sender is locked out
CODE_LOCK = 600
CODE_SPENT = 20  # wrong codes from everyone together: the code is spent


@dataclass
class Media:
    """Something sent with a message: a voice note, a picture or a file. fetch() downloads
    it (or reads it from disk); size and seconds are what the app said, 0 when it didn't."""

    kind: str  # voice | image | file
    name: str
    media_type: str
    fetch: Callable[[], Awaitable[bytes]]
    size: int = 0
    seconds: float = 0.0
    path: Path | None = None  # already on this Mac (a file the chat app keeps here)


@dataclass
class Inbound:
    """One message from a chat, as the router takes it."""

    channel: str
    chat: str  # where a reply goes
    sender: str  # the app's id for who wrote it
    name: str = ""  # how they're shown (pairing, the audit log)
    text: str = ""
    at: float = 0.0  # when it was sent (epoch seconds); 0: just now
    direct: bool = True  # a one-to-one chat with the bot, not a group
    media: list[Media] = field(default_factory=list)
    forwarded: bool = False  # someone else's words that the owner passed on
    reply_to: str = ""  # the message it answers, when the app says (a card's)
    action: tuple[str, str] | None = None  # a button pressed: (approval id, choice)
    ack: Callable[[str], Awaitable[None]] | None = None  # answers a button press
    owner: bool | None = None  # decided by the channel itself; None: by its pairing
    team: str = ""  # Slack: the workspace
    # In a group: whether it's addressed to JARVIS (a mention of the bot, or a reply to
    # one of its messages), the group's name, and the message it replies to when someone
    # else wrote that one (data, never instructions).
    mentioned: bool = False
    group_name: str = ""
    quoted: str = ""
    quoted_by: str = ""


class Channel:
    """One chat app. A subclass receives in run() (handing each message to
    router.receive) and sends with the methods below."""

    name = ""
    title = ""
    limit = 4000  # characters in one message
    buttons = False  # approval cards get buttons (else they're answered in words)
    typing_every = 0.0  # seconds between "typing…" signals while a reply is written
    pairs = True  # the owner is bound with a pairing code (else the channel is set up)
    command_mark = "/"  # how commands are written in help ("!" where / is the app's own)
    max_file = 50_000_000  # the biggest file it sends
    vault_id = ""  # its Keychain entries: (vault_id, key) for each of secret_keys
    secret_keys: tuple[str, ...] = ()
    edits = False  # it can change a message it sent (progress is one message, edited)
    groups = False  # it can be asked in a group chat (when mentioned or replied to)
    groups_start_on = True  # a group it's first asked in answers at once (the bot was added)

    def __init__(self, router: Channels) -> None:
        self.router = router
        self.state = "off"  # off | starting | listening | reconnecting | error | needs_setup
        self.error = ""
        self.halted = False  # stopped for good (a token refused): until it's set up again
        self._secrets: dict[str, str] | None = None

    # ── its tokens, in the Keychain only ──

    def secret(self, key: str) -> str:
        """A token, read from the Keychain once and then kept in memory."""
        if self._secrets is None:
            found: dict[str, str] = {}
            for k in self.secret_keys:
                try:
                    value = self.router.vault.get(self.vault_id, k)
                except Exception:  # a locked or unavailable Keychain: not set up, for now
                    self._secrets = None
                    return ""
                if value:
                    found[k] = value
            self._secrets = found
        return self._secrets.get(key, "")

    def save_secrets(self, secrets_: dict[str, str]) -> None:
        """Into the Keychain (a thread's work: the Keychain can be slow)."""
        for key in self.secret_keys:
            value = (secrets_.get(key) or "").strip()
            if value:
                self.router.vault.set(self.vault_id, key, value)
        self._secrets = None

    def forget_secrets(self) -> None:
        for key in self.secret_keys:
            self.router.vault.delete(self.vault_id, key)
        self._secrets = None

    def connected(self) -> None:
        """Its tokens changed (connected, disconnected): start afresh."""
        self._secrets = None

    # ── what the router asks ──

    def ready(self) -> bool:
        """Set up enough to run (a token saved, a conversation picked)."""
        return all(self.secret(k) for k in self.secret_keys) if self.secret_keys else False

    def home_chat(self) -> str | None:
        """Where heads-ups and cards go: the owner's chat, once there is one."""
        return None

    def is_owner(self, msg: Inbound) -> bool:
        owner = self.router.state.owners.get(self.name)
        return (
            owner is not None
            and msg.direct
            and msg.sender == owner.user
            and msg.chat == owner.chat
            and (not owner.team or msg.team == owner.team)
        )

    def set_state(self, state: str, error: str = "") -> None:
        if (state, error) != (self.state, self.error):
            self.state, self.error = state, error
            self.router.publish()

    # ── what a channel does ──

    async def run(self) -> None:
        raise NotImplementedError

    async def send_text(
        self, chat: str, text: str, *, title: str = "", markup: bool = True
    ) -> None:
        """A reply (markup: Claude's Markdown, shown the app's way) or a notice (markup
        False: someone else's words may be in it, so it's shown exactly as written). title
        goes first, in bold where the app has bold."""
        raise NotImplementedError

    async def send_card(self, chat: str, card: dict[str, Any], lang: str) -> Any:
        """An approval card; returns what close_card needs to find it again."""
        raise NotImplementedError

    async def close_card(self, chat: str, ref: Any, outcome: str) -> None:
        """The card is answered (or gone): its buttons go, and outcome is shown."""

    async def typing(self, chat: str) -> None:
        """Show that a reply is being written, where the app can."""

    async def ask_reason(self, chat: str, text: str) -> None:
        """After "No, because…": ask what to do instead (a reply box where the app has one)."""
        await self.send_text(chat, text, markup=False)

    async def send_file(self, chat: str, path: Path, caption: str = "") -> None:
        raise NotImplementedError

    async def send_progress(self, chat: str, text: str) -> Any:
        """A progress line (plain words) that edit_text can change later; what it needs to
        find the message again (None when it can't be found)."""
        await self.send_text(chat, text, markup=False)
        return None

    async def edit_text(self, chat: str, ref: Any, text: str, *, markup: bool = True) -> None:
        """Change a message sent with send_progress: a newer progress line (markup False), or
        the reply itself (Claude's Markdown, as send_text shows it). A reply longer than one
        message fills this one and the rest follows in new ones."""
        raise NotImplementedError

    async def verify(self, secrets_: dict[str, str]) -> dict[str, str]:
        """Check pasted tokens with the service: the bot's own id and name. ValueError, in
        words to show, when they're refused."""
        raise NotImplementedError

    def public(self) -> dict[str, Any]:
        """What Settings shows beyond the router's common fields."""
        return {}


# ── rate limits and pairing ──


class RateLimit:
    """A bucket of burst messages that refills over per seconds."""

    def __init__(self, burst: int, per: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.burst, self.rate, self.clock = burst, burst / per, clock
        self.tokens = float(burst)
        self.at = clock()

    def take(self) -> bool:
        now = self.clock()
        self.tokens = min(self.burst, self.tokens + (now - self.at) * self.rate)
        self.at = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False


class PairingCode:
    """A six-digit code shown on the Mac, good once for CODE_SECONDS. Each sender gets
    CODE_TRIES wrong guesses within CODE_LOCK, and CODE_SPENT wrong guesses from everyone
    spend the code: a stranger can't guess their way in, or lock the owner out."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self.clock = clock
        self.code: str | None = None
        self.expires = 0.0
        self.wrong = 0
        self.failures: dict[str, deque[float]] = {}

    def start(self) -> str:
        self.code = f"{secrets.randbelow(10**6):06d}"
        self.expires = self.clock() + CODE_SECONDS
        self.wrong = 0
        return self.code

    def active(self) -> bool:
        if self.code is not None and self.clock() >= self.expires:
            self.code = None
        return self.code is not None

    def seconds_left(self) -> int:
        return max(0, round(self.expires - self.clock())) if self.active() else 0

    def cancel(self) -> None:
        self.code = None

    def locked(self, sender: str) -> bool:
        now = self.clock()
        for who in list(self.failures):
            times = self.failures[who]
            while times and now - times[0] > CODE_LOCK:
                times.popleft()
            if not times:
                del self.failures[who]
        return len(self.failures.get(sender, ())) >= CODE_TRIES

    def check(self, code: str, sender: str) -> str:
        """ok (and the code is used up), wrong, locked, or none (no code on the Mac)."""
        if self.locked(sender):
            return "locked"
        if not self.active():
            return "none"
        if secrets.compare_digest(code.encode(), (self.code or "").encode()):
            self.code = None
            self.failures.pop(sender, None)
            return "ok"
        if len(self.failures) < 1000 or sender in self.failures:
            self.failures.setdefault(sender, deque()).append(self.clock())
        self.wrong += 1
        if self.wrong >= CODE_SPENT:
            self.code = None
        return "wrong"


_PAIR = re.compile(r"^\s*[/!]?(?:pair|配对)(?:@\w+)?[\s:：]*([\d\s-]{0,20})\s*$", re.IGNORECASE)


def pair_code(text: str) -> str | None:
    """The code in "/pair 123 456" (or "pair 123456", "配对 123456", in a Chinese keyboard's
    full-width digits too); "" for a pairing message without a proper code; None when it
    isn't one."""
    m = _PAIR.match(unicodedata.normalize("NFKC", text or ""))  # ６ is 6
    if m is None:
        return None
    digits = re.sub(r"[^0-9]", "", m.group(1))  # (\d is any script's digits: ٦ is no code)
    return digits if len(digits) == 6 else ""


# Commands, in English after / or ! (Slack keeps / for its own), and their Chinese twins,
# which also work as a whole message on their own.
COMMANDS = ("stop", "brief", "status", "new", "help", "code", "cancel", "start")
_COMMANDS_ZH = {
    "停止": "stop",
    "停下": "stop",
    "简报": "brief",
    "状态": "status",
    "新对话": "new",
    "帮助": "help",
    "代码": "code",
    "取消": "cancel",
}
_BARE = {"stop": "stop", "help": "help", "停": "stop"}  # whole messages that are commands
_COMMAND = re.compile(r"^\s*[/!]([a-z]+)(?:@\w+)?(?:\s+(.*))?\s*$", re.IGNORECASE | re.DOTALL)
_COMMAND_ZH = re.compile(
    r"^\s*[/!]?(停止|停下|简报|状态|新对话|帮助|代码|取消)(?:\s+(.*))?\s*$", re.DOTALL
)


def parse_command(text: str) -> tuple[str, str] | None:
    """(command, the rest) for "/status", "/code 3 run the tests", "停止"; None otherwise."""
    text = (text or "").strip()
    bare = _BARE.get(text.lower().rstrip(".!。！"))
    if bare:
        return bare, ""
    m = _COMMAND.match(text)
    if m and m.group(1).lower() in COMMANDS:
        return m.group(1).lower(), (m.group(2) or "").strip()
    m = _COMMAND_ZH.match(text)
    if m:
        return _COMMANDS_ZH[m.group(1)], (m.group(2) or "").strip()
    return None


# ── cutting a reply into messages ──

_FENCE = "```"


def utf16_len(text: str) -> int:
    """Length as Telegram and Discord count it: characters past U+FFFF count twice."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _fits(text: str, limit: int, measure: Callable[[str], int]) -> int:
    """How many characters of text fit in limit, as measure counts them (a character
    counts as one at least, and a longer start of the text never measures less). Only the
    first limit characters are ever measured: measuring all that's left of a long reply
    for each message cost it its length again every time, half a minute for a megabyte."""
    if len(text) <= limit and measure(text) <= limit:
        return len(text)
    if measure is len:
        return limit
    low, high = 0, min(len(text), limit)  # the most that fit is in between
    while low < high:
        mid = (low + high + 1) // 2
        if measure(text[:mid]) <= limit:
            low = mid
        else:
            high = mid - 1
    return low


_BREAKS = ("\n\n", "\n", "。", "！", "？", ". ", "! ", "? ", "；", "; ", "，", ", ", " ")


def _cut(text: str, n: int) -> int:
    """Where to cut text so the first part has at most n characters: after a paragraph, a
    line, a sentence or a space in the second half, else right at n."""
    window = text[:n]
    for sep in _BREAKS:
        at = window.rfind(sep)
        if at >= n // 2:
            return at + len(sep)
    return max(1, n)


def split_text(text: str, limit: int, measure: Callable[[str], int] = len) -> list[str]:
    """A reply as messages of at most limit characters (as measure counts them). A code
    block cut in two is closed at the end of one message and opened again in the next."""
    text = (text or "").replace("\r\n", "\n").strip()
    out: list[str] = []
    carry = ""  # the fence reopened at the start of the next message
    room = max(40, limit - 8)  # space for the fence closed at the end
    while text:
        n = _fits(text, room - len(carry), measure)
        if n >= len(text):
            piece, text = text, ""
        else:
            cut = _cut(text, n)
            piece, text = text[:cut].rstrip(), text[cut:].lstrip("\n")
            if not text.strip():
                text = ""
        chunk, carry = carry + piece, ""
        if chunk.count(_FENCE) % 2:
            chunk += "\n" + _FENCE
            carry = _FENCE + "\n"
        if chunk.strip() and chunk.strip() != _FENCE + "\n" + _FENCE:
            out.append(chunk)
    return out


# ── Markdown as each app shows it ──

_FENCED = re.compile(r"```([\w+#.-]{0,20})[ \t]*\n?(.*?)```", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`\n]{1,2000})`")
_BOLD = re.compile(r"\*\*(?=\S)([^\n]+?)(?<=\S)\*\*")
_HEADING = re.compile(r"^[ \t]*#{1,6}[ \t]+([^\n]+?)[ \t]*#*[ \t]*$", re.MULTILINE)
_LINK = re.compile(r"\[([^\[\]\n]{1,300})\]\((https?://[^\s()<>\"]{1,2000})\)")
_BULLET = re.compile(r"^([ \t]*)[-*][ \t]+", re.MULTILINE)


def _blocks(text: str) -> list[tuple[str, str, str]]:
    """The text as ("text", words, "") and ("code", code, language) pieces. A fence left
    open makes the rest code."""
    out: list[tuple[str, str, str]] = []
    pos = 0
    for m in _FENCED.finditer(text):
        if m.start() > pos:
            out.append(("text", text[pos : m.start()], ""))
        out.append(("code", m.group(2).rstrip("\n"), m.group(1)))
        pos = m.end()
    tail = text[pos:]
    at = tail.find(_FENCE)
    if at >= 0:
        if at:
            out.append(("text", tail[:at], ""))
        out.append(("code", tail[at + 3 :].lstrip("\n").rstrip("\n"), ""))
    elif tail:
        out.append(("text", tail, ""))
    return out


def _inline(text: str) -> list[tuple[bool, str]]:
    """(is code, piece) for text with `inline code` in it."""
    out: list[tuple[bool, str]] = []
    pos = 0
    for m in _INLINE_CODE.finditer(text):
        out.append((False, text[pos : m.start()]))
        out.append((True, m.group(1)))
        pos = m.end()
    out.append((False, text[pos:]))
    return out


def _escape(text: str) -> str:
    return html.escape(text, quote=False)


def _tg_words(text: str) -> str:
    s = _escape(text)
    s = _HEADING.sub(lambda m: f"<b>{m.group(1).replace('**', '')}</b>", s)
    s = _LINK.sub(lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>', s)
    s = _BOLD.sub(r"<b>\1</b>", s)
    return _BULLET.sub(r"\1• ", s)


def telegram_html(text: str) -> str:
    """Claude's Markdown as Telegram's HTML: everything escaped, then code, bold, headings,
    links (http and https only) and bullets. Telegram refuses HTML it can't parse, so the
    caller falls back to plain text when it does."""
    out: list[str] = []
    for kind, body, language in _blocks(text):
        if kind == "code":
            code = _escape(body)
            out.append(
                f'<pre><code class="language-{language}">{code}</code></pre>'
                if language
                else f"<pre>{code}</pre>"
            )
            continue
        for is_code, piece in _inline(body):
            out.append(f"<code>{_escape(piece)}</code>" if is_code else _tg_words(piece))
    return "".join(out)


def telegram_escape(text: str) -> str:
    return _escape(text)


def _slack_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _slack_words(text: str) -> str:
    s = _slack_escape(text)
    s = _HEADING.sub(lambda m: f"*{m.group(1).replace('**', '')}*", s)
    s = _LINK.sub(lambda m: f"<{m.group(2)}|{m.group(1).replace('|', '/')}>", s)
    s = _BOLD.sub(r"*\1*", s)
    return _BULLET.sub(r"\1• ", s)


def slack_mrkdwn(text: str) -> str:
    """Claude's Markdown as Slack's mrkdwn: &, < and > escaped, **bold** as *bold*,
    [text](url) as <url|text>; code blocks and `code` as they are."""
    out: list[str] = []
    for kind, body, _language in _blocks(text):
        if kind == "code":
            out.append(f"```\n{_slack_escape(body)}\n```")
            continue
        for is_code, piece in _inline(body):
            out.append(f"`{_slack_escape(piece)}`" if is_code else _slack_words(piece))
    return "".join(out)


def slack_escape(text: str) -> str:
    return _slack_escape(text)


def _wa_words(text: str) -> str:
    s = _HEADING.sub(lambda m: f"*{m.group(1).replace('**', '')}*", text)
    s = _LINK.sub(r"\1 (\2)", s)
    s = _BOLD.sub(r"*\1*", s)
    return _BULLET.sub(r"\1• ", s)


def whatsapp_text(text: str) -> str:
    """Claude's Markdown as WhatsApp writes it: *bold*, ```code``` and `code` as they are,
    links as "text (address)", bullets as •."""
    out: list[str] = []
    for kind, body, _language in _blocks(text):
        if kind == "code":
            out.append(f"```{body}```")
            continue
        for is_code, piece in _inline(body):
            out.append(f"`{piece}`" if is_code else _wa_words(piece))
    return "".join(out)


def plain_text(text: str) -> str:
    """Claude's Markdown as plain text (an app without markup): code as it is, no marks around words,
    links as "text (address)", bullets as •."""
    out: list[str] = []
    for kind, body, _language in _blocks(text):
        if kind == "code":
            out.append(body)
            continue
        for is_code, piece in _inline(body):
            if is_code:
                out.append(piece)
                continue
            s = _HEADING.sub(lambda m: m.group(1).replace("**", ""), piece)
            s = _LINK.sub(r"\1 (\2)", s)
            s = _BOLD.sub(r"\1", s)
            out.append(_BULLET.sub(r"\1• ", s))
    return "".join(out)


def discord_safe(text: str) -> str:
    """Someone else's words in a Discord message: its Markdown can't open a code block or
    hide a link (mentions never ping: allowed_mentions is empty on every message)."""
    return text.replace("```", "`ˋ`").replace("](", "] (")


def clip(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"
