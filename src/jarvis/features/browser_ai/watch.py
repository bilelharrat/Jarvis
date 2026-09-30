"""Watch mode, and the owner's say about each site.

On a sensitive site (a bank, their mail, a health portal: sites.py, the owner's list) the
built-in browser acts only while that tab is on show in the dock of a window the owner can
see: in a tab behind, a covered or hidden window, JARVIS or a Jarvis Code session is told to
show the tab first (browser_tabs switch shows it) or to ask the owner to bring the window
forward. Looking (reading, snapshots, pictures, scrolling) goes on as before, and what's
read there counts as the owner's private data for the turn gate, not as a public page.

Each site can also have the owner's rule, set only in Settings › Browser (a window command,
never a tool, so no page can talk JARVIS into changing it): always (acts there as anywhere,
in a tab behind too), ask (a card first, once per request) or never (it doesn't act there
at all).

The check weighs the tab the action lands in (the call's own tab once it's routed, else the
tab on show, or the one last on show while the dock is closed), as the typing gate does:
its address and whether it's on show come from the browser's own list of tabs at that
moment, and whether the J.A.R.V.I.S. window is in view (not hidden, minimized or covered)
from the window itself (browser_ai_page). Nothing in it needs the app's newer parts, so it
holds in an app not yet rebuilt. It comes before every other check of the call
(hub.add_browser_check); the turn gate and the purchase guard still apply after it.
"""

from __future__ import annotations

import time
from typing import Any

from .sites import Sites, host_of

SESSION_ASK_SECONDS = 10 * 60  # a Jarvis Code session's yes to "ask" holds this long
# Browser actions that act on a page. Everything else (reads, snapshots, pictures, waits,
# scrolling, going back, tabs, the console) only looks.
ACTING = frozenset({"click", "type", "act", "dialog", "upload", "search", "eval"})
KIND_WORDS = {
    "bank": "a bank or payments site",
    "email": "the user's email",
    "health": "a health site",
    "other": "a site the user marked sensitive",
}
WATCH = (
    "{host} is sensitive ({kind}), so the browser acts there only while its tab is on show "
    "for the user to watch, and it isn't now. Show it with browser_tabs (switch shows the "
    "tab), or ask the user to bring the J.A.R.V.I.S. window forward, then try again. Reading "
    "and scrolling there work as before."
)
NEVER = (
    "The user set the browser never to act on {host} (Settings › Browser). Don't act there "
    "or look for another way; tell the user in a sentence."
)
UNCHECKED = "I couldn't check which site the browser is on, so I left the page alone. Try again."
DECLINED = "The user said no to acting on {host}. Don't act there or look for another way."
ASK_QUESTION = "Let Jarvis act on {host}?"
ASK_SPOKEN = "Can I act on {host}? You asked me to check first."
ASK_WHY = "You asked me to check before I act on {host} (Settings › Browser)."


def acting(action: str, args: dict[str, Any]) -> bool:
    """Whether a browser call acts on the page (clicks, types, answers, uploads…)."""
    if action == "act":
        return str(args.get("kind") or "click") != "scroll"
    if action == "dialog":
        return args.get("op") != "status"
    return action in ACTING


def what_it_does(action: str, args: dict[str, Any]) -> str:
    """The call, in a few words for the card."""
    label = str(args.get("text") or args.get("label") or args.get("selector") or "").strip()
    if action == "click":
        return f"Press “{label[:120]}”" if label else "Press something on the page"
    if action == "type" or (action == "act" and args.get("kind") in ("type", "fill")):
        return "Type into the page"
    if action == "act":
        return f"{str(args.get('kind') or 'click').capitalize()} on the page"
    if action == "dialog":
        return "Answer the page's question"
    if action == "upload":
        return "Upload a file"
    return "Act on the page"


class Watch:
    def __init__(self, hub: Any, sites: Sites, page: Any) -> None:
        self.hub = hub
        self.sites = sites
        self.page = page  # pagectx.PageContext: the window's word on the tab on show
        # Sites the owner OK'd under "ask": for a JARVIS request, (request id, hosts); for a
        # Jarvis Code session, owner -> {host: until}.
        self._asked: tuple[str, set[str]] = ("", set())
        self._session_yes: dict[str, dict[str, float]] = {}
        # Checks that weigh the same tab after these (the hand back): (seen, action, args),
        # each answering None or a refusal, with the tab looked up once.
        self.then: list[Any] = []

    async def check(self, action: str, args: dict[str, Any]) -> dict[str, Any] | None:
        """hub.add_browser_check: None lets the call go; a refusal otherwise."""
        if not acting(action, args):
            return None
        seen = await self._where(args)
        if seen is None:
            return None  # no tab or no browser there: the call itself says so
        if not seen:
            return {"ok": False, "message": UNCHECKED}  # never acts on a site it can't name
        host = host_of(seen.get("url"))
        if not host:
            return None  # not a web page (a blank tab)
        rule = self.sites.rule(host)
        if rule == "never":
            return {"ok": False, "message": NEVER.format(host=host)}
        kind = self.sites.sensitive(host)
        if kind and rule != "always" and not seen.get("visible"):
            return {
                "ok": False,
                "message": WATCH.format(host=host, kind=KIND_WORDS.get(kind, kind)),
                "url": seen.get("url"),
                "tab": seen.get("tab"),
            }
        if rule == "ask" and not await self._ask(host, action, args):
            return {"ok": False, "message": DECLINED.format(host=host)}
        for more in self.then:
            refusal = await more(seen, action, args)
            if refusal is not None:
                return refusal
        return None

    def _watched(self, url: Any) -> bool:
        host = host_of(url)
        return bool(host) and bool(self.sites.sensitive(host) or self.sites.rule(host))

    async def _where(self, args: dict[str, Any]) -> dict[str, Any] | None:
        """The tab a call lands in: {tab, url, visible}; None when there's no such tab or no
        browser (the call itself says so); {} when it can't be told which of the open tabs
        it is and one of them is watched."""
        if not self.hub.browser_available:
            return None
        listing = await self.hub._browser_raw("tabs", {"op": "list"})
        if not isinstance(listing, dict) or listing.get("error") or listing.get("ok") is False:
            return {}
        tabs = [t for t in listing.get("tabs") or [] if isinstance(t, dict)]
        wanted = args.get("tab")
        if wanted not in (None, ""):
            target = next((t for t in tabs if str(t.get("id")) == str(wanted)), None)
            if target is None:
                return None  # closed
        else:  # the tab on show; with the dock closed, the one last on show
            target = next((t for t in tabs if t.get("shown")), None)
            if target is None:
                on_show = self.page.page.tab
                target = next(
                    (t for t in tabs if on_show is not None and t.get("id") == on_show), None
                )
            if target is None and len(tabs) == 1:
                target = tabs[0]
            if target is None:
                return {} if any(self._watched(t.get("url")) for t in tabs) else None
        # In view: on show in the dock, and the window itself isn't hidden, minimized or covered.
        visible = bool(target.get("shown")) and self.page.page.visible
        return {"tab": target.get("id"), "url": str(target.get("url") or ""), "visible": visible}

    async def _ask(self, host: str, action: str, args: dict[str, Any]) -> bool:
        owner = str(args.get("owner") or "")
        now = time.monotonic()
        if owner.startswith("code"):
            if self._session_yes.get(owner, {}).get(host, 0.0) > now:
                return True
        else:
            rid = str(getattr(self.hub, "_rid", "") or "")
            if self._asked[0] != rid:
                self._asked = (rid, set())
            if rid and host in self._asked[1]:
                return True
        detail = f"{what_it_does(action, args)}\nOn: {host}\n\n{ASK_WHY.format(host=host)}"
        allowed = await self.hub._ask_user(
            ASK_QUESTION.format(host=host), detail, ASK_SPOKEN.format(host=host)
        )
        if allowed:
            if owner.startswith("code"):
                yes = self._session_yes.setdefault(owner, {})
                yes[host] = now + SESSION_ASK_SECONDS
            else:
                self._asked[1].add(host)
        return allowed

    async def on_result(
        self, action: str, args: dict[str, Any], result: dict[str, Any]
    ) -> dict[str, Any] | None:
        """hub.add_browser_result: what JARVIS reads on a sensitive site is the owner's
        private data (the turn gate then weighs it so), not a public page. A Jarvis Code
        session's reads are its own: they never taint JARVIS's turns."""
        if not isinstance(result, dict) or result.get("error") or result.get("ok") is False:
            return None
        if str(args.get("owner") or "").startswith("code") or not getattr(self.hub, "_rid", ""):
            return None
        host = host_of(result.get("url"))
        kind = self.sites.sensitive(host) if host else None
        if kind:
            self.hub.mark_turn_untrusted(f"a page on {host}")
        return None
