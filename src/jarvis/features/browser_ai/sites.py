"""Which sites are sensitive (banks, email, health), and the owner's say about each site.

The sensitive list starts from the one below and is the owner's to change in Settings ›
Browser: sites they add, and defaults they take off. On a sensitive site JARVIS acts only
while its tab is on show for the owner to watch (watch.py), and what it reads there counts
as the owner's private data, not a public page.

Each site can also have a rule, set only by the owner in the window (never by a tool, so no
page can talk JARVIS into changing it): "always" (JARVIS acts there without asking, even in
a tab behind), "ask" (a card first, once per request) or "never".
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit

from ... import prefs as prefs_module

# The defaults, by kind. A site matches its own host and every host under it.
DEFAULTS: dict[str, tuple[str, ...]] = {
    "bank": (
        "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com",
        "capitalone.com", "usbank.com", "pnc.com", "truist.com", "tdbank.com", "td.com",
        "schwab.com", "fidelity.com", "vanguard.com", "ally.com", "discover.com",
        "americanexpress.com", "sofi.com", "chime.com", "navyfederal.org", "usaa.com",
        "paypal.com", "venmo.com", "wise.com", "revolut.com", "monzo.com", "n26.com",
        "barclays.co.uk", "hsbc.com", "hsbc.co.uk", "lloydsbank.com", "natwest.com",
        "santander.com", "santander.co.uk", "rbc.com", "scotiabank.com", "bmo.com",
        "coinbase.com", "kraken.com", "robinhood.com", "etrade.com", "interactivebrokers.com",
        "icbc.com.cn", "boc.cn", "ccb.com", "abchina.com", "cmbchina.com", "bankcomm.com",
        "alipay.com", "pay.weixin.qq.com",
    ),
    "email": (
        "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com",
        "mail.yahoo.com", "mail.proton.me", "icloud.com", "fastmail.com", "mail.aol.com",
        "mail.zoho.com", "hey.com", "mail.qq.com", "mail.163.com", "mail.126.com",
    ),
    "health": (
        "mychart.com", "kp.org", "myhealth.va.gov", "patient.labcorp.com",
        "myquest.questdiagnostics.com", "onemedical.com", "zocdoc.com", "healthcare.gov",
        "23andme.com", "teladoc.com", "betterhelp.com", "talkspace.com", "goodrx.com",
        "followmyhealth.com", "patientportal.com",
    ),
}  # fmt: skip
# Hosts that are sensitive by their shape: the .bank top-level domain, a hospital's MyChart.
_SHAPES = (
    (re.compile(r"(^|\.)[a-z0-9-]+\.bank$"), "bank"),
    (re.compile(r"^(?:mychart|patientportal|myhealth)\."), "health"),
    (re.compile(r"^(?:online-?banking|netbanking|ebanking)\."), "bank"),
)
KINDS = ("bank", "email", "health", "other")
RULES = ("always", "ask", "never")
ADDED_KEY = "browser_sites_added"  # [{"host", "kind"}]: sites the owner made sensitive
REMOVED_KEY = "browser_sites_removed"  # [host]: defaults the owner took off
RULES_KEY = "browser_site_rules"  # {host: always | ask | never}
_HOST = re.compile(
    r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
)
MAX_SITES = 300


def clean_host(value: Any) -> str | None:
    """A site as the owner types it ("https://www.chase.com/login", "Chase.com"): its host
    without www, or None when it isn't one."""
    text = str(value or "").strip().lower()
    if not text or len(text) > 300:
        return None
    if "://" not in text:
        text = f"https://{text}"
    try:
        host = (urlsplit(text).hostname or "").rstrip(".")
    except ValueError:
        return None
    host = host.removeprefix("www.")
    return host if _HOST.match(host) else None


def host_of(url: Any) -> str:
    """The host a page is on, without www ("" for anything but an http(s) page)."""
    try:
        parts = urlsplit(str(url or ""))
    except ValueError:
        return ""
    if parts.scheme not in ("http", "https"):
        return ""
    return (parts.hostname or "").rstrip(".").lower().removeprefix("www.")


def _under(host: str, site: str) -> bool:
    return host == site or host.endswith("." + site)


def _clean_added(value: Any) -> list[dict[str, str]] | None:
    if not isinstance(value, list):
        return None
    out: list[dict[str, str]] = []
    for item in value[:MAX_SITES]:
        if not isinstance(item, dict):
            continue
        host = clean_host(item.get("host"))
        kind = item.get("kind") if item.get("kind") in KINDS else "other"
        if host and all(x["host"] != host for x in out):
            out.append({"host": host, "kind": kind})
    return out


def _clean_removed(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    out: list[str] = []
    for item in value[:MAX_SITES]:
        host = clean_host(item)
        if host and host not in out:
            out.append(host)
    return out


def _clean_rules(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    out: dict[str, str] = {}
    for key, rule in list(value.items())[:MAX_SITES]:
        host = clean_host(key)
        if host and rule in RULES:
            out[host] = rule
    return out


prefs_module.register_feature_pref(ADDED_KEY, [], _clean_added)
prefs_module.register_feature_pref(REMOVED_KEY, [], _clean_removed)
prefs_module.register_feature_pref(RULES_KEY, {}, _clean_rules)


class Sites:
    """The owner's sites, read from the settings each time (they change from the window)."""

    def __init__(self, prefs: Any) -> None:
        self._prefs = prefs  # a callable giving the hub's Prefs

    def _feature(self, key: str) -> Any:
        return self._prefs().feature(key)

    def listed(self) -> list[dict[str, Any]]:
        """Every sensitive site, the defaults first: {host, kind, default}."""
        removed = set(self._feature(REMOVED_KEY) or [])
        out = [
            {"host": host, "kind": kind, "default": True}
            for kind, hosts in DEFAULTS.items()
            for host in hosts
            if host not in removed
        ]
        for item in self._feature(ADDED_KEY) or []:
            if all(x["host"] != item["host"] for x in out):
                out.append({"host": item["host"], "kind": item["kind"], "default": False})
        return out

    def sensitive(self, url_or_host: Any) -> str | None:
        """The kind of sensitive site a page (or host) is on, or None."""
        text = str(url_or_host or "")
        host = host_of(text) if "://" in text else text.lower().removeprefix("www.")
        if not host:
            return None
        removed = set(self._feature(REMOVED_KEY) or [])
        for item in self._feature(ADDED_KEY) or []:
            if _under(host, item["host"]):
                return item["kind"]
        for kind, hosts in DEFAULTS.items():
            for site in hosts:
                if _under(host, site) and site not in removed:
                    return kind
        for pattern, kind in _SHAPES:
            if pattern.search(host) and not any(_under(host, r) for r in removed):
                return kind
        return None

    def rule(self, url_or_host: Any) -> str:
        """The owner's rule for a site ("always", "ask", "never"), or "" for none: the
        most specific one that covers it."""
        text = str(url_or_host or "")
        host = host_of(text) if "://" in text else text.lower().removeprefix("www.")
        rules = self._feature(RULES_KEY) or {}
        best = ""
        for site in rules:
            if host and _under(host, site) and len(site) > len(best):
                best = site
        return rules.get(best, "") if best else ""

    def add(self, host: str, kind: str = "other") -> dict[str, Any]:
        """The feature_prefs changes that make a site sensitive (or bring a default back)."""
        removed = [h for h in self._feature(REMOVED_KEY) or [] if h != host]
        added = list(self._feature(ADDED_KEY) or [])
        default = any(host in hosts for hosts in DEFAULTS.values())
        if not default and all(x["host"] != host for x in added):
            added.append({"host": host, "kind": kind if kind in KINDS else "other"})
        return {ADDED_KEY: added, REMOVED_KEY: removed}

    def remove(self, host: str) -> dict[str, Any]:
        """The feature_prefs changes that take a site off the list."""
        added = [x for x in self._feature(ADDED_KEY) or [] if x["host"] != host]
        removed = list(self._feature(REMOVED_KEY) or [])
        if any(host in hosts for hosts in DEFAULTS.values()) and host not in removed:
            removed.append(host)
        return {ADDED_KEY: added, REMOVED_KEY: removed}
