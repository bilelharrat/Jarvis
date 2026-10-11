"""Secrets in code about to be committed or pushed.

Before Eden Code commits (the Git panel, landing an isolated copy) or pushes, the lines
being added are checked for keys and tokens: known formats (AWS, GitHub, Slack, Stripe,
Google, Anthropic, OpenAI, private keys and more), passwords in URLs, and long,
random-looking values given to names like api_key or secret (the entropy check). A
credentials file (.env, a key) being committed at all counts too. A finding blocks, with
what was found and where, masked (never the whole secret, anywhere: not on a card, not in
a log); the owner can still go ahead, explicitly.

Pure functions: no git, no disk, no network.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .code_changes import FileDiff

# (what it is, how it looks). Checked in order; the first match on a span wins.
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("Private key", re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----")),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}")),
    ("GitLab token", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("Slack webhook", re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_-]{20,}")),
    ("Stripe secret key", re.compile(r"\b[sr]k_live_[A-Za-z0-9]{16,}")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}")),
    ("Google OAuth secret", re.compile(r"\bGOCSPX-[A-Za-z0-9_-]{20,}")),
    ("Anthropic API key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}")),
    ("OpenAI API key", re.compile(r"\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}")),
    ("Hugging Face token", re.compile(r"\bhf_[A-Za-z0-9]{30,}")),
    ("npm token", re.compile(r"\bnpm_[A-Za-z0-9]{36}\b")),
    ("PyPI token", re.compile(r"\bpypi-[A-Za-z0-9_-]{50,}")),
    ("SendGrid key", re.compile(r"\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}")),
    ("Twilio key", re.compile(r"\bSK[0-9a-f]{32}\b")),
    ("Mailgun key", re.compile(r"\bkey-[0-9a-f]{32}\b")),
    (
        "Discord bot token",
        re.compile(r"\b[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}"),
    ),
    ("Telegram bot token", re.compile(r"\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b")),
    (
        "JSON Web Token",
        re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    ),
    (
        "Password in a URL",
        re.compile(r"\b[a-z][a-z0-9+.-]{1,20}://[^\s:/@'\"]{1,64}:([^\s/@'\"]{3,128})@[\w.-]+"),
    ),
]
# A value given to a name that says it's secret: `api_key = "…"`, `"password": "…"`.
ASSIGNED = re.compile(
    r"""(?ix)
    (?P<name>[\w.-]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|pwd|auth[_-]?key
        |access[_-]?key|private[_-]?key|client[_-]?secret|credential|signing[_-]?key)[\w.-]*)
    ["']?\s*(?::=|=>|[:=])\s*
    (?P<q>["'`]?)(?P<value>[^\s"'`,;)}\]]{12,256})(?P=q)
    """
)
QUOTED = re.compile(r"""["'`]([A-Za-z0-9+/_=.-]{32,512})["'`]""")
# Values that are plainly not secrets: placeholders, lookups, templates.
_PLACEHOLDER = re.compile(
    r"(?i)example|xxxx|\*\*\*|your[_-]|placeholder|changeme|change_me|dummy|sample|redacted"
    r"|<[^>]*>|\$\{|\{\{|%\(|process\.env|os\.environ|getenv|environ\[|env\[|secrets\.|vault"
    r"|config\.|settings\.|keychain|none$|null$|true$|false$"
)
_HASHY = re.compile(r"(?i)sha\d*|integrity|checksum|digest|hash|fingerprint|etag|nonce|uuid")
LOCKFILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", "uv.lock",
    "poetry.lock", "Pipfile.lock", "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock",
    "Podfile.lock", "Package.resolved", "bun.lockb", "flake.lock",
}  # fmt: skip
MAX_FINDINGS = 50
LINE_CHARS = 4000

# Cheap checks first, so the costly patterns run only on the lines they could match (the
# findings are the same: each check is something a match can't do without). A land's scan
# of 10,000 new files spent most of its time in ASSIGNED's search, tried at every character
# of every line. Each pattern's literals: one of them is in every text it matches (none:
# always tried).
_LITERALS: dict[str, tuple[str, ...]] = {
    "Private key": ("PRIVATE KEY",),
    "AWS access key": ("AKIA", "ASIA", "ABIA", "ACCA"),
    "GitHub token": ("ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"),
    "GitLab token": ("glpat-",),
    "Slack token": ("xox",),
    "Slack webhook": ("https://hooks.slack.com/services/",),
    "Stripe secret key": ("k_live_",),
    "Google API key": ("AIza",),
    "Google OAuth secret": ("GOCSPX-",),
    "Anthropic API key": ("sk-ant-",),
    "OpenAI API key": ("sk-",),
    "Hugging Face token": ("hf_",),
    "npm token": ("npm_",),
    "PyPI token": ("pypi-",),
    "SendGrid key": ("SG.",),
    "Twilio key": ("SK",),
    "Mailgun key": ("key-",),
    "Discord bot token": (".",),
    "Telegram bot token": (":AA",),
    "JSON Web Token": ("eyJ",),
    "Password in a URL": ("://",),
}
_DISCORD = "Discord bot token"
_ONLY_DISCORD = [(kind, pattern) for kind, pattern in PATTERNS if kind == _DISCORD]
# Any of those literals at all (Discord's "." aside: most lines have one): one search
# that rules out most of the patterns on most lines.
_ANY_LITERAL = re.compile(
    "|".join(
        re.escape(lit)
        for lit in sorted(
            {lit for kind, lits in _LITERALS.items() if kind != _DISCORD for lit in lits},
            key=len,
            reverse=True,
        )
    )
)
# ASSIGNED's name always holds one of these (lower-cased), and an "=" or ":" follows it.
_NAME_WORDS = ("key", "secret", "token", "passw", "pwd", "credential")


def _may_assign(text: str) -> bool:
    """Whether ASSIGNED could match text. Its IGNORECASE is plain ASCII case on ASCII text;
    other text (where re also folds the likes of "ſ" and "K") is always tried."""
    if not text.isascii():
        return True
    if "=" not in text and ":" not in text:
        return False
    low = text.lower()
    return any(word in low for word in _NAME_WORDS)


@dataclass(frozen=True)
class Finding:
    path: str
    line: int  # in the new file (0: the whole file)
    kind: str
    preview: str  # masked: its first and last characters, never the secret

    def public(self) -> dict[str, Any]:
        return {"path": self.path, "line": self.line, "kind": self.kind, "preview": self.preview}

    def said(self) -> str:
        where = f"{self.path} line {self.line}" if self.line else self.path
        shown = f" ({self.preview})" if self.preview else ""
        return f"{self.kind} in {where}{shown}"


def entropy(text: str) -> float:
    """Shannon entropy, bits per character: random keys score high, words and names low."""
    if not text:
        return 0.0
    counts = Counter(text)
    total = len(text)
    return -sum(n / total * math.log2(n / total) for n in counts.values())


def mask(secret: str) -> str:
    """Enough to recognize it, never enough to use it."""
    secret = secret.strip()
    if len(secret) <= 10:
        return "•" * 6
    return f"{secret[:4]}…{secret[-2:]}"


def _random_looking(value: str, hexish: bool = False) -> bool:
    classes = sum(
        bool(re.search(p, value)) for p in (r"[a-z]", r"[A-Z]", r"[0-9]", r"[^A-Za-z0-9]")
    )
    if re.fullmatch(r"[0-9a-f]+", value, re.I):
        return len(value) >= 20 and entropy(value) >= 3.0
    return classes >= 2 and entropy(value) >= (3.5 if not hexish else 3.0)


def scan_line(text: str) -> list[tuple[str, str]]:
    """What in one added line looks like a secret: [(kind, masked)]."""
    text = text[:LINE_CHARS]
    found: list[tuple[str, str]] = []
    taken: list[tuple[int, int]] = []

    def free(span: tuple[int, int]) -> bool:
        return all(span[1] <= a or span[0] >= b for a, b in taken)

    some = _ANY_LITERAL.search(text) is not None  # (none: only Discord's could match)
    for kind, pattern in PATTERNS if some else _ONLY_DISCORD:
        literals = _LITERALS.get(kind)
        if literals is not None and not any(lit in text for lit in literals):
            continue
        for m in pattern.finditer(text):
            if not free(m.span()):
                continue
            taken.append(m.span())
            if kind == "Private key":
                found.append((kind, m.group(0)))
            elif kind == "Password in a URL":
                found.append((kind, m.group(0).replace(m.group(1), "••••")))
            else:
                found.append((kind, mask(m.group(0))))
    for m in ASSIGNED.finditer(text) if _may_assign(text) else ():
        value = m.group("value")
        if not free(m.span("value")) or _PLACEHOLDER.search(value):
            continue
        if re.fullmatch(r"[A-Za-z_][\w.]*", value) and not re.search(r"\d", value):
            continue  # another name (settings.api_key), not a value
        if _random_looking(value):
            taken.append(m.span("value"))
            found.append((f"Secret-looking value for {m.group('name')[:40]}", mask(value)))
    quoted = list(QUOTED.finditer(text))  # (cheap; _HASHY's search isn't)
    if quoted and not _HASHY.search(text):
        for m in quoted:
            value = m.group(1)
            if not free(m.span(1)) or _PLACEHOLDER.search(value):
                continue
            mixed = (
                re.search(r"[a-z]", value)
                and re.search(r"[A-Z]", value)
                and re.search(r"\d", value)
            )
            if mixed and entropy(value) >= 4.5:
                taken.append(m.span(1))
                found.append(("High-entropy string", mask(value)))
    return found


def scan(files: list[FileDiff], shown: Any = None) -> list[Finding]:
    """The added lines of a diff, checked. shown(path) is how a path is named to the owner
    (relative to the session's folder); a credentials file being committed is a finding of
    its own, whatever it holds."""
    from .computer import is_sensitive

    name = shown or (lambda p: p)
    findings: list[Finding] = []
    for f in files:
        path = name(f.path)
        if f.status == "D":
            continue
        if f.sensitive or is_sensitive(Path(f.path)):
            findings.append(Finding(path, 0, "Credentials file", ""))
            continue
        if Path(f.path).name in LOCKFILES:
            continue
        for h in f.hunks:
            line = h.new_start
            for tag, text in h.lines:
                if tag == "+":
                    for kind, preview in scan_line(text):
                        findings.append(Finding(path, max(line, 1), kind, preview))
                if tag in " +":
                    line += 1
                if len(findings) >= MAX_FINDINGS:
                    return findings
    return findings


def summary(findings: list[Finding], limit: int = 4) -> str:
    """The card's detail: each finding on a line (masked), and how many more."""
    lines = [f"• {f.said()}" for f in findings[:limit]]
    more = len(findings) - limit
    if more > 0:
        lines.append(f"…and {more} more.")
    return "\n".join(lines)
