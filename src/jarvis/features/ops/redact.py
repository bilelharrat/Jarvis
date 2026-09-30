"""Log lines as they may be shown or shared: tokens, keys, passwords, emails and phone
numbers masked, and the home folder's name as ~. Used for the checkup's last few error
lines and for everything in a diagnostics file. Over-masking is fine here (a long hex
checksum goes too); missing a secret isn't."""

from __future__ import annotations

import re
from pathlib import Path

MASK = "[hidden]"
EMAIL = "[email]"
PHONE = "[phone]"

_NAMES = (
    r"(?i)\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|apikey|token|secret|passw(?:or)?d|passwd|pwd"
    r"|auth(?:orization)?|client[_-]?secret|access[_-]?key|private[_-]?key|session[_-]?id"
    r"|cookie|signature|sig)s?)"
)
_RULES: list[tuple[re.Pattern[str], str]] = [
    # A secret after its name: "token=…", "api_key: …", "Authorization: Bearer …", and
    # "token 1a2b…" (a word with a digit in it, so "auth failed" stays readable).
    (
        re.compile(
            _NAMES + r"(\s*[\"']?\s*[:=]\s*[\"']?)(?:bearer\s+|basic\s+|token\s+)?"
            r"(?!\[hidden\])[^\s\"',;&)}\]]{4,}"
        ),
        r"\1\2" + MASK,
    ),
    (
        re.compile(_NAMES + r"(\s+)(?!\[hidden\])(?=[^\s\"',;&)}\]]*\d)[^\s\"',;&)}\]]{8,}"),
        r"\1\2" + MASK,
    ),
    # Bearer and Basic credentials on their own.
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 " + MASK),
    # A key or token in a web address: ?token=…, &key=…, &code=….
    (
        re.compile(
            r"(?i)([?&#](?:token|key|api_key|access_token|refresh_token|code|sig|auth)=)[^&\s#]+"
        ),
        r"\1" + MASK,
    ),
    # Keys that announce themselves.
    (re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}"), MASK),
    (re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat)_[A-Za-z0-9_]{16,}"), MASK),
    (re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}"), MASK),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), MASK),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{30,}"), MASK),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?"), MASK),
    (re.compile(r"\b(?:AC|SK)[0-9a-f]{32}\b"), MASK),  # Twilio account and key ids
    # Emails.
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+"), EMAIL),
    # Phone numbers: international (+…), North American (510) 555-0100, or 10 to 15 digits.
    (re.compile(r"(?<![\w+])\+\d[\d\s().-]{6,18}\d(?!\d)"), PHONE),
    (re.compile(r"(?<![\w.:/-])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.:-])"), PHONE),
    (re.compile(r"(?<![\w.:/-])\d{10,15}(?![\w.:-])"), PHONE),
    # Long random strings: hex of 32 or more, or 32+ letters and digits mixed.
    (re.compile(r"\b[0-9a-fA-F]{32,}\b"), MASK),
    (re.compile(r"\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b"), MASK),
]


def home_pattern(home: Path | None = None) -> re.Pattern[str]:
    root = str(home or Path.home()).rstrip("/")
    return re.compile(re.escape(root) + r"(?=/|\b)")


def line(text: str, home: re.Pattern[str] | None = None, limit: int = 2000) -> str:
    """One line (or a few) with every secret masked; cut to limit characters."""
    out = (home or home_pattern()).sub(
        "~", str(text)[: limit * 2]
    )  # first: a long name isn't a key
    for pattern, replacement in _RULES:
        out = pattern.sub(replacement, out)
    return out if len(out) <= limit else out[: limit - 1] + "…"


def text(body: str, home: re.Pattern[str] | None = None) -> str:
    """A whole log, line by line."""
    pattern = home or home_pattern()
    return "\n".join(line(row, pattern, limit=4000) for row in body.split("\n"))
