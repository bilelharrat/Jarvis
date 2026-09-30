"""Hand back: where a page needs the owner, not JARVIS, JARVIS stops and says it's their
turn; "carry on" (said, typed or the banner's button) picks up from there.

What needs the owner (page-ai-preload.js handback reads the page, only what shows): a
captcha or a "verify you're human" check, a password, card details, a one-time code (unless
the owner lets JARVIS type codes from their mail: Settings, type_codes), or a wall that asks
to sign in first.

- Before JARVIS clicks, types or presses anything, the page it would act on is looked at
  (with watch mode's look at the tabs: the tab the action lands in). A captcha is never
  touched: the action is refused and the page handed back. So are the others, unless the
  owner already did their part on that very page (a carry on clears it for a while).
- After an action or a read lands on such a page, the result says so to Claude: stop, it's
  the user's turn, tell them in a sentence.
- Handing back shows the owner a "Your turn" banner over that page in the dock (the tab is
  brought forward), and until they carry on, anything that would act on that tab is refused.
- "Carry on", "continue", "I'm done", 继续, 好了… while a hand back is open clears it and
  tells Claude, in the app's note, to look at the page again and carry on. The banner's
  Carry on button asks the same in the owner's words; its × lets it go without asking.

A Jarvis Code session gets the same refusal at a captcha and the same note elsewhere, but no
banner; on its own app on this Mac (localhost) nothing here applies: signing in there is its
work.

Cost policy: no model calls; carry on is an ordinary turn the owner asks for.
"""

from __future__ import annotations

import re
import time
from typing import Any

from ... import lang, research
from ...browser_agent import loopback
from .sites import host_of

OPEN_SECONDS = 30 * 60  # a hand back left open this long lets go
CLEARED_SECONDS = 10 * 60  # after a carry on, the same page isn't handed back again this long
DETECT_SECONDS = 3.0
# Results worth a look afterwards: the ones that can land on a new page or show one.
LOOKED_AFTER = frozenset({"open", "click", "act", "back", "wait", "read", "snapshot", "dialog"})
NOTE = (
    "This page needs the user: {what}. It's their turn: stop here, don't type into it or "
    "press anything on it, and never try to solve a captcha. Tell the user in one short "
    "sentence that it's their turn and that they can say 'carry on' when they're done; then "
    "end your turn."
)
WAITING = (
    "It's the user's turn on this page ({what}). Wait until they say 'carry on'; don't act "
    "on it or look for another way."
)
CARRY_ON_NOTE = (
    "the page on {host} needed the user ({what}) and they say they've done their part: look "
    "at the page again (browser_snapshot or browser_read) and carry on with what you were "
    "doing; if it still needs them, say so in a sentence"
)
CARRY_ON_WORDS = "Carry on."
_CARRY_ON_PHRASE = (
    r"(?:(?:you\s+can\s+)?(?:carry\s+on|continue|go\s+on|go\s+ahead|keep\s+going|resume|proceed)"
    r"|i'?m\s+(?:done|finished|in|through|signed\s+in|logged\s+in)|i'?ve\s+(?:done\s+it|signed\s+in|"
    r"logged\s+in|finished)|i\s+(?:did\s+it|signed\s+in|logged\s+in)|(?:all\s+)?done|finished|"
    r"all\s+set|your\s+turn)(?:\s+(?:now|then))?"
)
_CARRY_ON = re.compile(
    r"^(?:(?:ok(?:ay)?|alright|right|great|thanks|thank\s+you|yes|yep|good)[\s,]+)*"
    rf"{_CARRY_ON_PHRASE}(?:[\s,]+(?:and\s+|so\s+)?{_CARRY_ON_PHRASE}){{0,2}}"
    r"(?:[\s,]+(?:please|thanks|thank\s+you))?$"
)
_CARRY_ON_ZH = re.compile(
    r"^(?:好的?|行|嗯|可以|谢谢)?(?:你)?(?:可以)?(?:继续(?:吧|操作|做|下去|弄)?|接着(?:来|做|弄|操作)|"
    r"我?好了|弄好了|完成了|搞定了|可以了|登录好了|我(?:已经)?登录了|登好了|输好了|验证好了|到你了)"
    r"(?:吧|啦)?$"
)


def is_carry_on(text: str, language: str = "en") -> bool:
    """Whether the words tell JARVIS to pick up where it handed back."""
    text = str(text or "")
    if lang.has_cjk(text):  # particles kept (好了 is "done"): only spaces and marks go
        return bool(_CARRY_ON_ZH.match(re.sub(r"[\s\W_]+", "", lang.to_simplified(text))))
    return bool(_CARRY_ON.match(research.normalize(text)))


def _page_key(url: Any) -> str:
    return str(url or "").split("#", 1)[0]


class HandBack:
    def __init__(self, hub: Any, bridge: Any) -> None:
        self.hub = hub
        self.bridge = bridge
        self.pending: dict[str, Any] | None = None  # {tab, url, host, kind, what, at}
        self._cleared: dict[tuple[Any, str], float] = {}  # (tab, page) -> when carried on

    def live(self) -> dict[str, Any] | None:
        """The hand back that's open, if there is one (they let go after OPEN_SECONDS)."""
        if self.pending and time.monotonic() - self.pending["at"] > OPEN_SECONDS:
            self._let_go()
        return self.pending

    async def _detect(self, tab: Any, url: str) -> dict[str, Any] | None:
        """What the page in this tab needs the owner for, or None."""
        codes = getattr(self.hub.prefs, "type_codes", True) is not False
        args: dict[str, Any] = {"codes": codes}
        if tab is not None:
            args["tab"] = tab
        seen = await self.bridge.call("handback", args, timeout=DETECT_SECONDS)
        kind = str(seen.get("kind") or "") if seen.get("ok") is not False else ""
        if not kind or _page_key(seen.get("url")) != _page_key(url):
            return None
        return {"kind": kind, "what": str(seen.get("what") or "you")[:80]}

    def _is_cleared(self, tab: Any, url: str) -> bool:
        at = self._cleared.get((tab, _page_key(url)))
        return at is not None and time.monotonic() - at < CLEARED_SECONDS

    def _hand_back(self, tab: Any, url: str, found: dict[str, Any]) -> None:
        self.pending = {
            "tab": tab,
            "url": url[:2000],
            "host": host_of(url),
            "kind": found["kind"],
            "what": found["what"],
            "at": time.monotonic(),
        }
        self.hub.emit(
            "browser_ai_handback",
            tab=tab,
            url=url[:500],
            host=host_of(url),
            need=found["kind"],  # (emit's own first argument is called kind)
            what=found["what"],
        )

    def _let_go(self, cleared: bool = False) -> dict[str, Any] | None:
        pending, self.pending = self.pending, None
        if pending is not None:
            if cleared:
                self._cleared[(pending["tab"], _page_key(pending["url"]))] = time.monotonic()
                if len(self._cleared) > 100:
                    oldest = sorted(self._cleared, key=self._cleared.__getitem__)[:50]
                    for key in oldest:
                        del self._cleared[key]
            self.hub.emit("browser_ai_handback", tab=None)
        return pending

    @staticmethod
    def _local_session(owner: str, url: str) -> bool:
        return owner.startswith("code") and loopback(url)

    async def before(
        self, seen: dict[str, Any], action: str, args: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Watch mode's follow-on check (Watch.then), with the tab the action lands in: a
        refusal where the page needs the owner, else None."""
        url, tab = str(seen.get("url") or ""), seen.get("tab")
        owner = str(args.get("owner") or "")
        if not url or self._local_session(owner, url):
            return None
        live = self.live()
        if live is not None and live["tab"] == tab and not owner.startswith("code"):
            return {"ok": False, "message": WAITING.format(what=live["what"])}
        found = await self._detect(tab, url)
        if found is None:
            return None
        if found["kind"] != "captcha" and self._is_cleared(tab, url):
            return None  # the owner did their part here just now
        if not owner.startswith("code"):
            self._hand_back(tab, url, found)
        return {"ok": False, "message": NOTE.format(what=found["what"]), "url": url, "tab": tab}

    async def on_result(
        self, action: str, args: dict[str, Any], result: dict[str, Any]
    ) -> dict[str, Any] | None:
        """hub.add_browser_result: a call that landed on a page needing the owner says so."""
        if action not in LOOKED_AFTER or not isinstance(result, dict):
            return None
        if result.get("error") or result.get("ok") is False:
            return None
        if action == "act" and str(args.get("kind") or "") == "scroll":
            return None
        url = str(result.get("url") or "")
        owner = str(args.get("owner") or "")
        if not host_of(url) or self._local_session(owner, url):
            return None
        tab = result.get("tab")
        live = self.live()
        if live is not None and live["tab"] == tab:
            return None  # already handed back
        found = await self._detect(tab, url)
        if found is None or (found["kind"] != "captcha" and self._is_cleared(tab, url)):
            return None
        if not owner.startswith("code"):
            self._hand_back(tab, url, found)
        note = NOTE.format(what=found["what"])
        out = dict(result)
        out["notices"] = [*(result.get("notices") or []), note]
        out["message"] = f"{note} {result.get('message') or ''}".strip()
        return out

    # ── carrying on ──

    async def context(self, text: str, display: str | None) -> dict[str, Any] | None:
        """hub.add_request_context: "carry on" while a hand back is open."""
        if display is not None or self.live() is None:
            return None
        if not is_carry_on(text, self.hub.language):
            return None
        pending = self._let_go(cleared=True)
        return {"note": CARRY_ON_NOTE.format(host=pending["host"], what=pending["what"])}

    def busy(self) -> bool:
        return self.live() is not None

    def on_carry_on(self, _msg: dict[str, Any]) -> None:
        """browser_ai_carry_on: the banner's button, the owner's own "carry on"."""
        if self.live() is None:
            return
        self.hub._spawn(self.hub.ask(lang.translate(CARRY_ON_WORDS, self.hub.language)))

    def on_cancel(self, _msg: dict[str, Any]) -> None:
        """browser_ai_handback_cancel: the banner's ×, or its tab closed: let go without
        asking."""
        self._let_go(cleared=True)
