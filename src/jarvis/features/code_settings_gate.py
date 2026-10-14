"""The settings a window command may not write (round 1 A8): what starts sessions without the
owner (Linear, Slack, GitHub issues, pull request reviews) is set only through each feature's
own card, which checks the project, the people, the commands and the sandbox and says so in
plain words (code_triggers.py, code_issues.py, code_pr_review.py turn_on). A feature_prefs
command naming one of those settings would skip all of that (commands nobody checked, the
sandbox off, no card), so the setting is left as it was and the window is told.

The same for set_prefs {features: {...}}: it replaces every feature setting at once, past
each feature's own gate (Touch ID's code_touchid and Bypass defaults: code_touchid.py, these
ones here). The window never sends it (feature settings go by feature_prefs), so it's dropped
from a window's set_prefs; the rest of the change goes as it came. The hub's own
set_feature_prefs, which the features' cards call, is untouched.

What it adds: handlers for the feature_prefs and set_prefs window commands, before the hub's
own (they leave the message to it, less what's refused).

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import logging
from typing import Any

from .. import lang

log = logging.getLogger("jarvis")

# Each is turned on (or changed) only by its feature's own card.
CARD_ONLY = ("code_linear", "code_slack", "code_issue_repos", "code_pr_review_repos")

REFUSED = (
    "That setting changes only from its own card (Eden Code settings), so it stayed as it was."
)
lang.add_texts({REFUSED: "这个设置只能通过它自己的卡片（Eden Code 设置）更改，所以保持不变。"})


class SettingsGate:
    def __init__(self, hub: Any) -> None:
        self.hub = hub

    def on_features(self, msg: dict[str, Any]) -> bool:
        changes = msg.get("changes")
        if isinstance(changes, dict):
            refused = [key for key in CARD_ONLY if key in changes]
            for key in refused:
                changes.pop(key)
            if refused:
                log.warning("settings: %s from a window command; refused", ", ".join(refused))
                self.hub.emit("error", text=lang.tr(REFUSED, self.hub.language))
        return False

    def on_prefs(self, msg: dict[str, Any]) -> bool:
        changes = msg.get("changes")
        if isinstance(changes, dict) and "features" in changes:
            changes.pop("features")
            log.warning("settings: set_prefs with every feature setting at once; dropped")
        return False


def install(hub: Any) -> None:
    gate = SettingsGate(hub)
    hub.register_command("feature_prefs", gate.on_features)
    hub.register_command("set_prefs", gate.on_prefs)
