"""The built-in browser's tools that act on a page, weighed against what a conversation has
read: the turn gate's part for typing, clicking, submitting, scripts and uploads.

Once a turn, or the conversation it's part of, has read the user's private data (mail,
notes, files, texts), anything typed into a page can leave the Mac through the page's own
form. So after such a read, acting on a site the user didn't name in their own words this
turn takes their OK first, on a card that shows what would be typed and why it asks:

- typing (anything a tool carries into the page: text, values, keys) asks each time, with
  the words on the card;
- a press that carries nothing (a click, a tab, a dialog) asks once per site per request;
- an address (a new tab at a URL) can carry data in itself, so it asks as browser_open
  does, named site or not; so does a script run in a page, which can reach any site;
- a file from the Mac leaves with an upload, so an upload asks even when nothing was read.

On a web messaging or mail app (Gmail, Outlook, Slack, WhatsApp, Discord…) a click on Send,
Post, Publish, Delete or Submit, or typing with Return in a chat's box, follows the same
rule as the Mac's own messaging apps (hands_guard), whatever was read: the send card,
unless the user's own words asked for exactly that, and after a read, named the
conversation in full.

Which tool does what is read from its arguments' names, not a list of tools: the browser's
server grows, and a tool added to it later is weighed the same way (brain.browser_acting).

Jarvis Code sessions drive the same browser. For them this module says which site a call
acts on (target) and whether that's this Mac (is_local), where typing is ordinary work.
"""

from __future__ import annotations

import ipaddress
import json
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from . import hands_guard
from .brain import browser_address, host_said

# Arguments by what they carry. Anything else a tool is handed (text, value, keys, fields…)
# is words that go into the page.
_URL_KEYS = frozenset({"url", "urls", "href", "address", "link"})
_FILE_KEYS = frozenset({"path", "paths", "file", "files", "file_path", "filepath", "filename"})
_SCRIPT_KEYS = frozenset({"script", "code", "expression", "js", "javascript", "function"})
_TAB_KEYS = frozenset({"tab", "tabs", "tab_id", "tabid", "tab_index"})
# Where and how to act, not what goes in: a selector, an element's ref or id, a position,
# a verb.
_WHERE_KEYS = frozenset(
    {
        "selector",
        "ref",
        "id",
        "role",
        "element",
        "index",
        "nth",
        "x",
        "y",
        "button",
        "clicks",
        "how",
        "action",
        "direction",
        "amount",
        "timeout",
        "force",
        "frame",
        "wait",
        "delay",
        "modifiers",
        "exact",
        "field",
        "submit",
    }
)
# Tools whose "text" says what to press ("Sign in"), not what to type.
_TEXT_IS_WHERE = frozenset({"browser_click"})
SHOWN = 600  # of the words or script, on the card
SEARCH_HOST = "www.google.com"  # where words the address bar doesn't take for an address go

PageUrl = Callable[[], Awaitable[str | None]]
Where = Callable[[], Awaitable[dict[str, str]]]
Ask = Callable[[str, str, str], Awaitable[bool]]
Send = Callable[[str, str, str, tuple[str, str]], Awaitable[bool]]
# Web messaging and mail apps by their host (and anything under it) -> (name, kind), as
# hands_guard.MESSAGING has the Mac's own; a page whose title names one counts too.
WEB_MESSAGING = {
    "mail.google.com": ("Gmail", "mail"),
    "outlook.live.com": ("Outlook", "mail"),
    "outlook.office.com": ("Outlook", "mail"),
    "outlook.office365.com": ("Outlook", "mail"),
    "mail.yahoo.com": ("Yahoo Mail", "mail"),
    "mail.proton.me": ("Proton Mail", "mail"),
    "icloud.com": ("iCloud Mail", "mail"),
    "slack.com": ("Slack", "chat"),
    "web.whatsapp.com": ("WhatsApp", "chat"),
    "discord.com": ("Discord", "chat"),
    "messenger.com": ("Messenger", "chat"),
    "web.telegram.org": ("Telegram", "chat"),
    "teams.microsoft.com": ("Microsoft Teams", "chat"),
    "teams.live.com": ("Microsoft Teams", "chat"),
    "linkedin.com": ("LinkedIn", "chat"),
    "x.com": ("X", "chat"),
    "twitter.com": ("X", "chat"),
    "facebook.com": ("Facebook", "chat"),
    "instagram.com": ("Instagram", "chat"),
    "reddit.com": ("Reddit", "chat"),
    "bsky.app": ("Bluesky", "chat"),
    "threads.net": ("Threads", "chat"),
}
_VERBS = {"send": "Send", "post": "Post", "publish": "Publish", "delete": "Delete",
          "submit": "Submit"}  # fmt: skip


@dataclass
class Carried:
    """What one call takes into the page."""

    words: str = ""  # typed text, values, keys
    script: str = ""
    files: list[str] = field(default_factory=list)
    urls: list[str] = field(default_factory=list)
    tab: bool = False  # it names a tab: maybe not the page on show
    submit: bool = False  # it presses Return after typing


def _strings(value: Any, depth: int = 0) -> list[str]:
    """A value's words, whatever shape it came in (a list of fields, a dict of values)."""
    if depth > 4:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, bool) or value is None:
        return []
    if isinstance(value, int | float):
        return [str(value)]
    if isinstance(value, dict):
        items: Iterable[Any] = list(value.values())[:50]
    elif isinstance(value, list | tuple):
        items = list(value)[:50]
    else:
        return []
    return [s for item in items for s in _strings(item, depth + 1)]


def carried(tool: str, args: Any) -> Carried:
    """What a browser tool's call carries, from its arguments' names (in a list of fields
    too: [{"ref": "e8", "value": "…"}] carries the value)."""
    what = Carried()
    words: list[str] = []
    name = tool.rsplit("__", 1)[-1]

    def walk(value: Any, depth: int) -> None:
        if depth > 4:
            return
        if isinstance(value, list | tuple):
            for item in list(value)[:50]:
                walk(item, depth + 1)
            return
        if not isinstance(value, dict):
            words.extend(_strings(value))
            return
        for key, item in list(value.items())[:50]:
            k = str(key).lower()
            if k in _URL_KEYS:
                what.urls.extend(_strings(item))
            elif k in _FILE_KEYS:
                what.files.extend(_strings(item))
            elif k in _SCRIPT_KEYS:
                what.script = "\n".join(filter(None, [what.script, *_strings(item)]))
            elif k in _TAB_KEYS or k.startswith("tab"):
                what.tab = True
            elif k == "submit":
                what.submit = what.submit or item is True
            elif k in ("key", "keys") and str(item).strip().lower() in ("enter", "return"):
                what.submit = True  # a press of Return, by itself
            elif k in _WHERE_KEYS or (k == "text" and depth == 0 and name in _TEXT_IS_WHERE):
                continue
            else:
                walk(item, depth + 1)

    if isinstance(args, dict):
        walk(args, 0)
    what.words = "\n".join(words)
    return what


def page_host(url: Any) -> str | None:
    """The host an http(s) page is on (an IPv6 one without its brackets), or None."""
    try:
        parts = urlsplit(str(url or "").strip())
        host = parts.hostname
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not host:
        return None
    return host.rstrip(".").lower() or None


def is_local(host: str | None) -> bool:
    """This Mac: localhost (and *.localhost), 127.0.0.0/8 and ::1."""
    if not host:
        return False
    host = host.strip("[]").rstrip(".").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    return address.is_loopback or bool(mapped and mapped.is_loopback)


def address_host(text: str) -> str | None:
    """Where an address a tool was handed goes, read as the address bar reads it: words
    that aren't an address go to a search."""
    address = browser_address(text)
    return page_host(address) if address else SEARCH_HOST


async def read_where(call: Callable[..., Awaitable[Any]]) -> dict[str, str]:
    """The page on show in the built-in browser, by reading it: {"url", "title"}, empty when
    there's no page or it didn't answer."""
    try:
        page = await call("read", {})
    except Exception:
        return {}
    if not isinstance(page, dict) or page.get("error") or page.get("ok") is False:
        return {}
    url = page.get("url")
    return {"url": str(url), "title": str(page.get("title") or "")} if url else {}


async def read_url(call: Callable[..., Awaitable[Any]]) -> str | None:
    """The address of the page on show in the built-in browser (None when there's none)."""
    return (await read_where(call)).get("url")


def messaging_page(host: str | None, title: str = "") -> tuple[str, str] | None:
    """(name, "chat" or "mail") for a web messaging or mail app: by its host, or a title
    that names one."""
    if host:
        name = host.removeprefix("www.")
        for known, app in WEB_MESSAGING.items():
            if name == known or name.endswith("." + known):
                return app
    for pattern, app_name, kind in hands_guard.WEB_APPS:
        if title and pattern.search(title):
            return app_name, kind
    return None


def send_of(tool: str, args: Any, what: Carried) -> str | None:
    """What a call does to a message, by its own words: a click on Send, Post, Publish,
    Delete or Submit ("send"…), typing with Return ("return": a send in a chat's box), or
    None. A click by a CSS selector or an element's ref says nothing of what it presses."""
    if not isinstance(args, dict):
        return None
    name = tool.rsplit("__", 1)[-1]
    action = str(args.get("action") or "").lower()
    if name == "browser_click" or action in ("click", "press", "tap"):
        labels = [str(args.get(k) or "") for k in ("text", "label", "name")]
        if found := hands_guard.send_kind(x for x in labels if x):
            return found
    if what.submit and (what.words or name == "browser_type" or action in ("press", "key")):
        return "return"
    return None


def _quoted(text: str) -> str:
    text = text.strip()
    return f"“{text[:SHOWN]}{'…' if len(text) > SHOWN else ''}”"


# ── Jarvis Code: which site a call acts on ──


@dataclass(frozen=True)
class Target:
    """The site a browser call acts on: host (None when it can't be told) and whether
    every site it touches is on this Mac."""

    host: str | None
    local: bool
    verb: str  # for the card: "type into example.com", "use the browser"


async def target(tool: str, args: Any, page: PageUrl | None) -> Target:
    """Where a Jarvis Code session's browser call acts: the address it opens, or the page
    on show (a call that names a tab and carries words can't be placed)."""
    name = tool.rsplit("__", 1)[-1]
    what = carried(tool, args)
    hosts: list[str | None] = [address_host(u) for u in what.urls]
    if name != "browser_open":
        if what.tab and (what.words or what.script or what.files):
            hosts.append(None)
        else:
            hosts.append(page_host(await page()) if page is not None else None)
    known = [h for h in hosts if h]
    host = known[0] if known and len(known) == len(hosts) else None
    local = bool(hosts) and len(known) == len(hosts) and all(is_local(h) for h in known)
    if host is None:
        verb = "use the browser"
    elif name == "browser_open":
        verb = f"open {host} in the browser"
    elif what.words or what.submit:
        verb = f"type into {host}"
    else:
        verb = f"click on {host}"
    return Target(host, local, verb)


# ── JARVIS's turn gate ──


class ActingGate:
    """The turn gate's call for a built-in browser tool that acts on a page. reads(): what
    the turn and its conversation have read (hub._gate_reads); words(): the user's own
    words this turn; turn(): the request's id; page(): the page on show ({"url",
    "title"}); ask(question, detail, spoken): a card, said aloud; asked(kind): the user's
    own words asked for that kind of send; send(question, detail, spoken, choices): the
    send card (hub.send_gate); free(): Control my Mac without asking is on (with it off,
    the browser asks before any click that sends, deletes or pays by itself). check()
    returns None when there's nothing to weigh (the mouse-and-keyboard rules decide), else
    whether the user said yes."""

    def __init__(
        self,
        *,
        reads: Callable[[], dict[str, Any]],
        words: Callable[[], str],
        turn: Callable[[], str],
        page: Where,
        ask: Ask,
        asked: Callable[[str], bool] | None = None,
        send: Send | None = None,
        free: Callable[[], bool] = lambda: True,
    ) -> None:
        self._reads, self._words, self._turn = reads, words, turn
        self._page, self._ask = page, ask
        self._asked, self._send, self._free = asked, send, free
        self._approved: tuple[str, set[str]] = ("", set())

    def approve(self, host: str | None) -> None:
        """The user OK'd this site for the current request (opening it, say): presses that
        carry nothing go ahead there for the rest of it. Typing still asks."""
        if host:
            self._sites().add(host)

    def _sites(self) -> set[str]:
        turn = self._turn()
        if self._approved[0] != turn:
            self._approved = (turn, set())
        return self._approved[1]

    async def check(self, tool: str, args: Any) -> bool | None:
        reads = self._reads()
        what = carried(tool, args)
        name = tool.rsplit("__", 1)[-1]
        seen: dict[str, str] | None = None

        async def page() -> dict[str, str]:  # read once, whichever check needs it first
            nonlocal seen
            if seen is None:
                found = await self._page()
                seen = found if isinstance(found, dict) else {}
            return seen

        send = send_of(tool, args, what)
        if send == "return" or (send and self._free()):  # else the click asks by itself
            decided = await self._send_check(send, reads, await page(), what, args)
            if decided is not None:
                return decided
        if not (reads.get("private") or what.files):
            return None
        # A file, a script or an address carries whatever it's given, to a site the user
        # named or not (as browser_open does once private data is in): those always ask.
        if what.files:
            kind = "upload"
        elif what.script or "eval" in name:
            kind = "script"
        elif what.urls:
            kind = "open"
        elif what.words or what.submit:
            kind = "type"
        else:
            kind = "use"
        hosts: list[str | None] = [address_host(u) for u in what.urls]
        url = None
        if what.tab and kind != "use":
            hosts.append(None)  # a tab named for what it carries: maybe not the page on show
        else:
            url = (await page()).get("url")
            hosts.append(page_host(url))
        known = list(dict.fromkeys(h for h in hosts if h))
        certain = bool(known) and None not in hosts
        said = self._words()
        if certain and kind in ("type", "use") and all(host_said(h, said) for h in known):
            return None
        if certain and kind == "use" and set(known) <= self._sites():
            return None
        site = " and ".join(known) if certain else "this page"
        question, spoken = self._questions(kind, site)
        lines = [f"On: {url}"] if url else []
        lines.append(self._what(kind, name, what, args))
        detail = "\n".join(lines) + f"\n\n{self._why(reads, kind)}"
        if not await self._ask(question, detail, spoken):
            return False
        if certain and kind == "use":
            self._sites().update(known)
        return True

    async def _send_check(
        self, send: str, reads: dict[str, Any], page: dict[str, str], what: Carried, args: Any
    ) -> bool | None:
        """A send on a web messaging app: the send card unless the user asked for exactly
        that and, after a read, named the conversation (the page's title) in full. None:
        not a send there, or one that may go ahead (the other checks still apply)."""
        app = messaging_page(page_host(page.get("url")), page.get("title", ""))
        if app is None or self._send is None:
            return None
        app_name, app_kind = app
        if send == "return":  # Return sends in a chat's box; in mail it's a new line
            if app_kind != "chat":
                return None
            send = "send"
        asked = self._asked is not None and self._asked(send)
        tainted = bool(reads.get("private") or reads.get("web"))
        if asked and (
            not tainted or hands_guard.conversation_named(page.get("title", ""), self._words())
        ):
            return None
        verb = _VERBS[send]
        lines = [f"In: {app_name}" + (f" · {page['title']}" if page.get("title") else "")]
        if page.get("url"):
            lines.append(f"On: {page['url']}")
        if what.words:
            lines.append(f"Message: {_quoted(what.words)}")
        label = str(args.get("text") or "").strip() if isinstance(args, dict) else ""
        lines.append(f"Button: {_quoted(label)}" if label and not what.words else "Key: return")
        if asked and tainted:
            seen = "; ".join(list(reads.get("what") or [])[:6]) or "outside content"
            why = (
                f"Earlier: {seen}. That could have put words or a recipient here, and you "
                "didn't name this conversation in full, so check it before it goes."
            )
        else:
            why = "You didn't ask me to do this in your own words just now."
        spoken = (
            f"Here's your message in {app_name}: {what.words.strip()} Do you want it sent?"
            if send in ("send", "post") and what.words and len(what.words) <= 300
            else f"Can I press {verb} in {app_name}?"
        )
        question = f"{verb} this in {app_name}?"
        detail = "\n".join(lines) + f"\n\n{why}"
        return await self._send(question, detail, spoken, (verb, f"Don't {verb.lower()}"))

    @staticmethod
    def _questions(kind: str, site: str) -> tuple[str, str]:
        if kind == "upload":
            return (
                f"Upload a file to {site}?",
                f"Can I upload a file from your Mac to {site}?",
            )
        if kind == "script":
            return (
                f"Run a script on {site} in the built-in browser?",
                f"Can I run a script on {site} in the built-in browser?",
            )
        if kind == "type":
            return (
                f"Type into {site} in the built-in browser?",
                f"Can I type into {site} in the built-in browser?",
            )
        if kind == "open":
            return (
                f"Open {site} in the built-in browser?",
                f"Can I open {site} in the built-in browser?",
            )
        return (
            f"Use {site} in the built-in browser?",
            f"Can I use {site} in the built-in browser?",
        )

    @staticmethod
    def _what(kind: str, name: str, what: Carried, args: Any) -> str:
        if kind == "upload":
            return "Files:\n" + "\n".join(what.files[:10])
        if kind == "script":
            return f"The script:\n{_quoted(what.script)}"
        if kind == "open":
            return "Address:\n" + "\n".join(u.strip()[:SHOWN] for u in what.urls[:5])
        if kind == "type":
            typed = f"What I'd type:\n{_quoted(what.words)}" if what.words else "Nothing typed."
            return typed + ("\nThen it presses Return." if what.submit else "")
        if name == "browser_click" and isinstance(args, dict):
            label = str(args.get("text") or args.get("selector") or "").strip()
            if label:
                return f"Press {_quoted(label)}"
        try:
            shown = json.dumps(args, ensure_ascii=False)[:300]
        except (TypeError, ValueError):
            shown = ""
        return f"{name} {shown}".strip()

    @staticmethod
    def _why(reads: dict[str, Any], kind: str) -> str:
        if kind == "upload" or not reads.get("private"):
            return (
                "A file from your Mac goes to this site with it, so check it before you allow it."
            )
        seen = "; ".join(list(reads.get("what") or [])[:6]) or "private content"
        where = "this conversation" if reads.get("earlier") else "this request"
        if kind == "script":
            return (
                f"Earlier in {where}: {seen}. A script can send some of that to any site, so "
                "check it before you allow it."
            )
        if kind == "open":
            return (
                f"Earlier in {where}: {seen}. An address like this can carry some of that "
                "out, so check it before you allow it."
            )
        return (
            f"Earlier in {where}: {seen}. What I type or press there can carry some of that "
            "off the Mac, and you didn't name this site yourself, so check it before you "
            "allow it."
        )
