"""Settings › Browser: the sensitive sites and the owner's rule for each site, changed only
from the window (these commands; no tool changes them, so no page can talk JARVIS into it).

- browser_ai_sites: the list, as the browser_ai_sites event (sites: {host, kind, default},
  removed: defaults taken off, rules: {host: always | ask | never}).
- browser_ai_site: one change, {op: add (host, kind) | remove (host) | rule (host, rule;
  "" takes the rule off)}; the list comes back as browser_ai_sites, with error set when the
  address isn't a site.
"""

from __future__ import annotations

from typing import Any

from .sites import KINDS, REMOVED_KEY, RULES, RULES_KEY, Sites, clean_host

NOT_A_SITE = "That isn't a site's address."


class SiteSettings:
    def __init__(self, hub: Any, sites: Sites) -> None:
        self.hub = hub
        self.sites = sites

    def payload(self) -> dict[str, Any]:
        feature = self.hub.prefs.feature
        return {
            "sites": self.sites.listed(),
            "removed": list(feature(REMOVED_KEY) or []),
            "rules": dict(feature(RULES_KEY) or {}),
        }

    def on_list(self, _msg: dict[str, Any]) -> None:
        self.hub.emit("browser_ai_sites", **self.payload())

    def on_change(self, msg: dict[str, Any]) -> None:
        op = msg.get("op")
        host = clean_host(msg.get("host"))
        if op not in ("add", "remove", "rule") or host is None:
            self.hub.emit("browser_ai_sites", **self.payload(), error=NOT_A_SITE)
            return
        if op == "add":
            kind = msg.get("kind") if msg.get("kind") in KINDS else "other"
            self.hub.set_feature_prefs(self.sites.add(host, kind))
        elif op == "remove":
            self.hub.set_feature_prefs(self.sites.remove(host))
        else:
            rules = dict(self.hub.prefs.feature(RULES_KEY) or {})
            rule = msg.get("rule")
            if rule in RULES:
                rules[host] = rule
            else:
                rules.pop(host, None)
            self.hub.set_feature_prefs({RULES_KEY: rules})
        self.hub.emit("browser_ai_sites", **self.payload())
