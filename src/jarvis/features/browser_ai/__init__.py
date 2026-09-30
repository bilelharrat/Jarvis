"""AI-native browsing and browser safety for the built-in browser.

- Hidden text (flags.py, aitext.py): text no one can see is left out of reads and snapshots
  (app/page-preload.js, app/browser-agent-core.js); page words written to an AI are flagged
  to Claude as the page's own and told to the owner.

Everything here is registered through the feature kit; install() only registers.

Cost policy (Claude): nothing here calls a model on its own.
"""

from __future__ import annotations

import weakref
from typing import Any

_DESKS: weakref.WeakKeyDictionary[Any, Any] = weakref.WeakKeyDictionary()


def desk_for(hub: Any) -> Any:
    """The hub's browser desk (tests reach it here)."""
    return _DESKS.get(hub)


def install(hub: Any) -> None:
    from .desk import BrowserAi

    desk = BrowserAi(hub)
    _DESKS[hub] = desk
    desk.install()
