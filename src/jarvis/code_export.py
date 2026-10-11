"""An Eden Code session exported whole: every message, each step with its full input and
output, and Claude's thinking, read from Claude Code's own record of the session (not the
400 entries a window keeps), as a page to read (HTML) or to print (PDF, laid out by the
app's window).

- Share-safe: keys, tokens and passwords blanked out everywhere (the formats the pre-commit
  secret scan knows, a value given to a secret's name, "password: …" in words, and long
  random-looking quoted strings), and pictures left out. File paths and commit hashes stay:
  a coding session is full of them.
- Paths hidden, when asked: the project's folder becomes <project>, the home folder ~, and
  the user's name <user>.
- Bounded: a step's input and output are cut at STEP_CHARS characters each, a message at
  TEXT_CHARS, pictures (a full export's) at PICTURES_BYTES in all, and the page at
  PAGE_CHARS (the rest is said to be left out).

Nothing here calls a model.
"""

from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from . import secret_scan
from .fileindex import _SECRET_VALUE

STEP_CHARS = 20_000
TEXT_CHARS = 60_000
PICTURE_BYTES = 5_000_000  # one picture, as base64
PICTURES_BYTES = 20_000_000  # all of them
PAGE_CHARS = 40_000_000
REDACTED = "[redacted]"


# ── what the session said and did ──


def _blocks(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [b for b in content or [] if isinstance(b, dict)]


def _result_text(content: Any) -> str:
    if isinstance(content, list):
        return "\n".join(
            str(c.get("text", ""))
            for c in content
            if isinstance(c, dict) and c.get("type") == "text"
        )
    return str(content or "")


def _pictures(blocks: list[dict[str, Any]]) -> list[dict[str, str]]:
    out = []
    for b in blocks:
        source = b.get("source") if b.get("type") == "image" else None
        if isinstance(source, dict) and source.get("type") == "base64":
            out.append(
                {
                    "media_type": str(source.get("media_type") or ""),
                    "data": str(source.get("data") or ""),
                }
            )
        elif b.get("type") == "image":
            out.append({"media_type": "", "data": ""})  # (a picture by address: not fetched)
    return out


def entries_from(messages: list[Any], said: Any) -> list[dict[str, Any]]:
    """Claude Code's record (SDK SessionMessages) as the export's entries: user, assistant,
    thinking, step (with its output), note and system. said(text) -> (role, text) reads a
    user message as the transcript does (tasks._history_said)."""
    out: list[dict[str, Any]] = []
    steps: dict[str, dict[str, Any]] = {}
    for m in messages:
        body = m.message if isinstance(getattr(m, "message", None), dict) else {}
        blocks = _blocks(body.get("content"))
        uuid = str(getattr(m, "uuid", "") or "")
        if m.type == "assistant":
            for b in blocks:
                kind = b.get("type")
                if kind == "text" and str(b.get("text") or "").strip():
                    out.append({"kind": "assistant", "text": str(b["text"]), "uuid": uuid})
                elif kind == "thinking" and str(b.get("thinking") or "").strip():
                    out.append({"kind": "thinking", "text": str(b["thinking"]), "uuid": uuid})
                elif kind == "redacted_thinking":
                    out.append({"kind": "thinking", "text": "", "hidden": True, "uuid": uuid})
                elif kind == "tool_use":
                    step = {
                        "kind": "step",
                        "name": str(b.get("name") or "tool"),
                        "input": b.get("input") if isinstance(b.get("input"), dict) else {},
                        "id": str(b.get("id") or ""),
                        "output": None,
                        "error": False,
                        "pictures": [],
                        "uuid": uuid,
                    }
                    steps[step["id"]] = step
                    out.append(step)
            continue
        texts: list[str] = []
        files: list[str] = []
        for b in blocks:
            kind = b.get("type")
            if kind == "tool_result":
                step = steps.get(str(b.get("tool_use_id") or ""))
                if step is not None:
                    content = b.get("content")
                    step["output"] = _result_text(content)
                    step["error"] = bool(b.get("is_error"))
                    step["pictures"] = _pictures(
                        _blocks(content) if isinstance(content, list) else []
                    )
            elif kind == "text":
                texts.append(str(b.get("text") or ""))
            elif kind == "document":
                files.append(str(b.get("title") or "file")[:200])
        pictures = _pictures(blocks)
        if not (texts or pictures or files):
            continue
        role, text = said("\n\n".join(texts)) if texts else ("user", "")
        if role == "user" and (text or pictures or files):
            out.append(
                {"kind": "user", "text": text, "pictures": pictures, "files": files, "uuid": uuid}
            )
        elif role != "user" and text:
            out.append({"kind": "note" if role == "note" else "system", "text": text, "uuid": uuid})
    return out


def entries_from_transcript(transcript: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """A session with no record yet (it never connected): what the window's transcript kept."""
    out = []
    for e in transcript:
        role, text = e.get("role"), str(e.get("text") or "")
        if role == "user":
            out.append(
                {"kind": "user", "text": text, "pictures": [], "files": list(e.get("files") or [])}
            )
        elif role == "assistant" and text:
            out.append({"kind": "assistant", "text": text})
        elif role == "tool":
            out.append({"kind": "step", "name": str(e.get("tool") or "tool"), "input": {"about": text},
                        "output": str(e.get("output") or "") or None, "error": e.get("status") == "failed", "pictures": []})  # fmt: skip
        elif role in ("system", "note", "plan") and text:
            out.append({"kind": "note" if role == "plan" else "system", "text": text})
    return out


# ── share-safe ──


def redact_secrets(text: str) -> str:
    """Keys, tokens and passwords blanked out: the formats secret_scan knows (a private key
    whole), a value given to a secret's name (api_key = "…", "password": "…", password: …,
    密码：…), and long random-looking quoted strings. Placeholders stay."""
    text = _formats(text)

    def assigned(m: re.Match[str]) -> str:
        value = m.group("value")
        if secret_scan._PLACEHOLDER.search(value) or REDACTED in value:
            return m.group(0)
        return m.group(0).replace(value, REDACTED)

    def said(m: re.Match[str]) -> str:
        value = m.group(3)
        if REDACTED in value or secret_scan._PLACEHOLDER.search(value):
            return m.group(0)
        return f"{m.group(1)}{m.group(2)}{REDACTED}"

    def quoted(m: re.Match[str]) -> str:
        value = m.group(1)
        mixed = (
            re.search(r"[a-z]", value) and re.search(r"[A-Z]", value) and re.search(r"\d", value)
        )
        if (
            mixed
            and secret_scan.entropy(value) >= 4.5
            and not secret_scan._PLACEHOLDER.search(value)
        ):
            return m.group(0).replace(value, REDACTED)
        return m.group(0)

    text = _assigned_sub(assigned, text)
    text = _secret_value_sub(said, text)
    return secret_scan.QUOTED.sub(quoted, text)


def _formats(text: str, more: bool = False) -> str:
    """The formats secret_scan knows, masked (a private key whole; a URL's password). A
    pattern is tried only on text holding one of its literals (it can't match without).
    more: the output-only formats too (_MORE_KEYS)."""
    for kind, pattern in secret_scan.PATTERNS:
        literals = secret_scan._LITERALS.get(kind)
        if literals is not None and not any(lit in text for lit in literals):
            continue
        if kind == "Password in a URL":
            text = pattern.sub(lambda m: m.group(0).replace(m.group(1), REDACTED), text)
        elif kind == "Private key":
            text = _PRIVATE_KEY.sub(REDACTED, text)
        else:
            text = pattern.sub(REDACTED, text)
    if more:
        for literals, pattern in _MORE_KEYS:
            if any(lit in text for lit in literals):
                text = pattern.sub(REDACTED, text)
    return text


_NAME_CHAR = re.compile(r"[\w.-]*")
# What follows a secret's name in ASSIGNED (its name ends where a [\w.-] run does).
_ASSIGN_TAIL = re.compile(r"""["']?\s*(?::=|=>|[:=])\s*(["'`]?)[^\s"'`,;)}\]]{12,256}\1""")
_KEY_TAIL = re.compile(r"""["']?\s*(?::=|=>|[:=])""")
# The words in each of ASSIGNED's names (lower case), and the first word of each of
# _SECRET_VALUE's (its English ones: a text with any other letter takes the patterns' own
# search).
_NAME_WORDS = secret_scan._NAME_WORDS
_SAID_WORDS = (
    "pass", "pwd", "pin", "secret", "token", "api", "access", "private", "client", "account",
    "routing", "iban", "cvv", "cvc", "ssn",
)  # fmt: skip


def _words_at(text: str, words: tuple[str, ...]) -> list[tuple[int, int]]:
    """Where the words are in an ASCII text, in any case: [(start, end)], in order (str.find
    is a fast scan; a regex alternation of them, tried at every character, isn't)."""
    low = text.lower()
    found = []
    for word in words:
        at = low.find(word)
        while at >= 0:
            found.append((at, at + len(word)))
            at = low.find(word, at + 1)
    found.sort()
    return found


def _named_sub(pattern: re.Pattern[str], tail: re.Pattern[str], repl: Any, text: str, hits: Any) -> str:
    """pattern.sub(repl, text) for a pattern whose name part is a whole [\w.-] run holding a
    name word (hits: where those words are, in order), then what tail matches: each run
    tried once, from its start, and only when tail follows it. (Searched at every
    character, ASSIGNED's name part was quadratic on long runs: seconds on a JSON log.)"""
    out: list[str] = []
    done = 0  # text before this is in out
    seen = 0  # runs before this were tried
    for hit_start, hit_end in hits:
        if hit_start < seen:
            continue  # (in a run already tried, or a value already matched)
        start = hit_start
        while start > done and (text[start - 1].isalnum() or text[start - 1] in "_.-"):
            start -= 1
        end = _NAME_CHAR.match(text, hit_end).end()
        seen = end
        if not tail.match(text, end):
            continue
        m = pattern.match(text, start)
        if m is None:
            continue
        out.append(text[done : m.start()])
        out.append(repl(m))
        done = seen = m.end()
    if not out:
        return text
    out.append(text[done:])
    return "".join(out)


def _assigned_sub(repl: Any, text: str) -> str:
    """secret_scan.ASSIGNED.sub(repl, text), linear: tried only where a secret's name stands."""
    if text.isascii():
        hits: Any = _words_at(text, _NAME_WORDS)
    else:  # (IGNORECASE folds the likes of "ſ" and "K": the pattern's own search)
        hits = ((m.start(), m.end()) for m in _SECRET_NAME.finditer(text))
    return _named_sub(secret_scan.ASSIGNED, _ASSIGN_TAIL, repl, text, hits)


def _secret_value_sub(repl: Any, text: str) -> str:
    """_SECRET_VALUE.sub(repl, text), tried only where one of its words starts (in an ASCII
    text: the same matches, a fraction of the time)."""
    if not text.isascii():
        return _SECRET_VALUE.sub(repl, text)
    out: list[str] = []
    done = 0
    for start, _ in _words_at(text, _SAID_WORDS):
        if start < done:
            continue
        m = _SECRET_VALUE.match(text, start)
        if m is None:
            continue
        out.append(text[done:start])
        out.append(repl(m))
        done = m.end()
    if not out:
        return text
    out.append(text[done:])
    return "".join(out)


_PRIVATE_KEY = re.compile(
    r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----.*?"
    r"(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|\Z)",
    re.DOTALL,
)


# ── an app's output, on its way to a session ──
#
# Stricter than redact_secrets (which a share-safe export uses, and which leaves alone what
# looks like a placeholder): a dev server's log, a failing test's message or a checker's
# report goes to Claude, so a value given to a secret's name is masked whatever words it
# holds (MyVault2024 is a password, not a placeholder), and the shapes a log prints a secret
# in are known too: credentials in any URL (an empty user, a password holding @ or /, any
# scheme's case), Authorization headers, cookies, connection strings, OAuth query values,
# command lines (-p, -u user:…, --password), netrc and pgpass lines, Docker and npm auths, a
# key a logger wrapped onto the next line, a private key whose BEGIN line was cut off (or
# both its ends), a PuTTY key, and a key \u-escaped or base64-encoded; also formats the
# pre-commit scan doesn't block on (test keys, more providers' tokens). What a log says that
# isn't a secret stays: words after "password:" ("must be at least 8 characters"), token
# counts, ARNs, and a failing test's values. Every pass is linear: masking runs on every
# tool answer. The owner's own panes show the output as it is.

_ANSI = re.compile(
    r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]"
)
# user:password@host, the password up to the last @ before a host (it may hold @, / and :);
# never a port and its path (http://localhost:3000/a?to=b@c.d), nor past a query.
_URL_CREDS = re.compile(
    r"(?i)\b([a-z][a-z0-9+.-]{1,30}://[^\s/@:'\"<>]*:)(?!\d{1,5}(?:[/?#\s'\"<>,;)\]]|$))"
    r"([^\s'\"<>?#]{1,256})(@[\w.-]+(?::\d+)?(?=[/?#\s'\",;)\]}>]|$))"
)
_AUTH_HEADER = re.compile(
    r"(?i)\b((?:proxy-)?authori[sz]ation\b[\"']?\s*[:=]\s*[\"']?"
    r"(?:(?:bearer|basic|token|digest|negotiate|ntlm|apikey|key)\s+)?)([^\s\"',;]{6,})"
)
# (a token has a digit: "bearer authentication" is words)
_BEARER = re.compile(r"(?i)\b(bearer\s+)((?=[A-Za-z._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,})")
_COOKIE = re.compile(r"(?i)\b((?:set-)?cookie\b[\"']?\s*[:=]\s*[\"']?)([^\r\n\"']+)")
_COOKIE_PAIR = re.compile(r"(^|;\s*)([^=;\s]+)=([^;]*)")
_COOKIE_ATTRS = {"path", "domain", "expires", "max-age", "samesite", "priority", "version"}
_CONN_STRING = re.compile(
    r"(?i)\b((?:AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd)\s*=\s*)"
    r"([^;\s\"']{4,})"
)
_QUERY_SECRET = re.compile(
    r"(?i)([?&](?:code|access_token|refresh_token|id_token|token|client_secret|secret|password"
    r"|passwd|pwd|api_key|apikey|key|sig|signature|auth|session)=)([^&\s#\"'<>]{6,})"
)
# A private key's END line (a body before it, its BEGIN line cut off: _key_body).
_KEY_END = re.compile(r"(?m)^-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----")
_KEY_LINE = re.compile(r"[A-Za-z0-9+/=]{16,}\r?")
_U_ESCAPE = re.compile(r"\\u00([2-7][0-9a-fA-F])")
_B64_RUN = re.compile(r"(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{20,4096}={0,2}")
# What a secret's name may be given that isn't a secret: a reference to one, a template, a
# mask (or a saved secret's $NAME, put in by the session's own redaction).
_REFERENCE = re.compile(
    r"(?i)^[\"'`]?(?:\$\{?[A-Za-z_]\w*\}?|\{\{.*\}\}|<[^>]*>|%\(\w+\)s|(?:process\.env|os\.environ"
    r"|import\.meta\.env|env)\b.*|(?:os\.)?getenv\(.*|[*•x.]{3,}|\[redacted\]|none|null|true|false"
    r"|undefined)[\"'`]?$"
)
# Formats a session is never sent but the pre-commit scan doesn't block on (test keys, more
# providers): (literals, one of which each match holds; the pattern), masked whole.
_MORE_KEYS: list[tuple[tuple[str, ...], re.Pattern[str]]] = [
    (("k_test_",), re.compile(r"\b[sr]k_test_[A-Za-z0-9]{16,}")),
    (("whsec_",), re.compile(r"\bwhsec_[A-Za-z0-9+/=]{24,}")),
    (("ya29.",), re.compile(r"\bya29\.[A-Za-z0-9_-]{20,}")),
    (("1//0",), re.compile(r"(?<![\w/:.])1//0[A-Za-z0-9_-]{40,}")),  # Google refresh token
    (
        ("Q~",),  # an Azure app's client secret
        re.compile(
            r"(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.-]{3}\dQ~[A-Za-z0-9_~.-]{31,34}(?![A-Za-z0-9_~.-])"
        ),
    ),
    (("xapp-",), re.compile(r"\bxapp-\d-[A-Za-z0-9-]{20,}")),
    (("dckr_pat_",), re.compile(r"\bdckr_pat_[A-Za-z0-9_-]{20,}")),
    (("hvs.", "hvb.", "hvr."), re.compile(r"\bhv[sbr]\.[A-Za-z0-9_-]{24,}")),
    (("shp",), re.compile(r"\bshp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}")),
    (("dp.",), re.compile(r"\bdp\.(?:st|ct|sa|scim|audit|pt)\.[A-Za-z0-9_.-]{20,}")),
    (("_v1_",), re.compile(r"\bdo[por]_v1_[a-f0-9]{64}")),
    (("gsk_",), re.compile(r"\bgsk_[A-Za-z0-9]{40,}")),
    (("xai-",), re.compile(r"\bxai-[A-Za-z0-9]{40,}")),
    (("pplx-",), re.compile(r"\bpplx-[A-Za-z0-9]{40,}")),
    (("AGE-SECRET-KEY-1",), re.compile(r"\bAGE-SECRET-KEY-1[0-9A-Z]{50,}")),
    (("-us",), re.compile(r"\b[0-9a-f]{32}-us\d{1,2}\b")),  # Mailchimp
    (("lin_api_",), re.compile(r"\blin_api_[A-Za-z0-9]{40}")),
    (("ntn_",), re.compile(r"\bntn_[A-Za-z0-9]{40,}")),
    (("figd_",), re.compile(r"\bfigd_[A-Za-z0-9_-]{40,}")),
    (("gl",), re.compile(r"\bgl(?:ptt|dt|rt|cbt|oas)-[A-Za-z0-9_-]{20,}")),
    (("rubygems_",), re.compile(r"\brubygems_[a-f0-9]{48}")),
    (("pat",), re.compile(r"\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b")),  # Airtable
]
# The formats a logger may wrap onto the next line: (literals, pattern).
_WRAPPED: list[tuple[tuple[str, ...], re.Pattern[str]]] = [
    (secret_scan._LITERALS[kind], p)
    for kind, p in secret_scan.PATTERNS
    if kind not in ("Private key", "Password in a URL")
] + _MORE_KEYS
_WRAP_LITERALS = re.compile(
    "|".join(
        re.escape(lit)
        for lit in sorted({lit for lits, _ in _WRAPPED for lit in lits if lit != "."}, key=len)[::-1]
    )
)
WRAP_WINDOW = 512  # a wrapped key's halves: in the last and first this many characters
_HEAD = re.compile(r"[ \t]*(\S+)")
# The words ASSIGNED needs in a secret's name: a line without one is never looked through
# with it.
_SECRET_NAME = re.compile(
    r"(?i)api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|pwd|auth[_-]?key|access[_-]?key"
    r"|private[_-]?key|credential|signing[_-]?key"
)
# A key's name that ASSIGNED doesn't know (a bare *_KEY): ENCRYPTION_KEY=…, APP_KEY=…,
# "master_key": "…" (an upper-case env name, or a key word before it).
_KEY_ASSIGNED = re.compile(
    r"(?<![\w.-])((?:[A-Z][A-Z0-9]*_)+KEY|(?i:(?:encryption|master|app|enc|hmac|cipher|crypto|aes"
    r"|jwt|license|signing|webhook|secret|private|decryption)[_-]?key))"
    r"([\"']?\s*(?::=|=>|[:=])\s*[\"'`]?)([^\s\"'`,;)}\]]{8,256})"
)
# Command lines that carry a password: (the part before it, the password).
_COMMANDS = [
    re.compile(
        r"(?i)(\b(?:docker|podman|nerdctl|helm|buildah|skopeo|oras|crane)\b[^\n]{0,200}?"
        r"\blogin\b[^\n]{0,200}?\s(?:-p|--password)(?:[ =]\s*))([^\s'\"]+)"
    ),
    re.compile(r"(\bmysql(?:dump|admin|sh|import)?\b[^\n]{0,200}?\s-p)([^\s'\"-][^\s'\"]*)"),
    re.compile(r"(\bsshpass\s+-p\s*)([^\s'\"]+)"),
    re.compile(
        r"(?i)(\b(?:curl|wget|http)\b[^\n]{0,200}?\s(?:-u|--user)(?:[ =]\s*)?['\"]?[^\s:'\"]+:)"
        r"([^\s'\"@]+)"
    ),
    re.compile(
        r"(?i)((?<![\w-])--(?:password|passwd|pass|token|api-key|apikey|secret|client-secret)"
        r"(?:=|\s+)['\"]?)([^\s'\"]+)"
    ),
    re.compile(r"(?i)(\bmachine\s+\S+\s+(?:login\s+\S+\s+)?password\s+)(\S+)"),  # netrc
    re.compile(r"(?i)(\bdefault\s+login\s+\S+\s+password\s+)(\S+)"),
    # pgpass: host:port:database:user:password
    re.compile(r"(?m)^([A-Za-z0-9_.*-]+:(?:\d{1,5}|\*):[A-Za-z0-9_.*-]+:[A-Za-z0-9_.*@-]+:)(\S+)$"),
]
_SECRET_STR = re.compile(r"(\b(?:SecretStr|SecretBytes)\(\s*b?['\"])([^'\"\n]+)")  # pydantic's
# A Docker or npm auth: base64 of user:password.
_AUTH_B64 = re.compile(r"(?i)([\"']?\b_?auth[\"']?\s*[:=]\s*[\"']?)([A-Za-z0-9+/]{12,}={0,2})")
# An AWS secret key printed bare after its key id.
_AWS_PAIR = re.compile(
    r"(\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}[\s,:;'\"=|]{1,5})([A-Za-z0-9+/]{40})(?![A-Za-z0-9+/=])"
)
# A secret's name, then (a space, no "=" or ":") a random-looking value: "token 6f9b…".
_SAID_BARE = re.compile(
    r"(?i)\b(token|secret|api[ _-]?key|key|password|passwd|pwd|passphrase|credentials?)"
    r"(s?\s+(?:is\s+|of\s+)?)([A-Za-z0-9_\-+/=.~]{20,})"
)
# A PuTTY key's private part.
_PUTTY = re.compile(
    r"(?m)^(Private-Lines:[ \t]*\d+[ \t]*\r?\n)((?:[A-Za-z0-9+/=]{4,}[ \t]*\r?(?:\n|\Z))+)"
)
_PEM_LINE = re.compile(r"[ \t]*([A-Za-z0-9+/]{64}|[A-Za-z0-9+/]{70})[ \t]*\r?")
_PEM_LAST = re.compile(r"[ \t]*[A-Za-z0-9+/]{4,69}={0,2}[ \t]*\r?")
# Not a secret, though a secret's name comes before it.
_NUMBER = re.compile(r"[-+]?\d+(?:[.,]\d+)*(?:e[-+]?\d+)?")
_COUNT_NAME = re.compile(r"(?i)tokens|token_?(?:count|limit|len|length|usage|budget|type)")
_PROSE = re.compile(r"[A-Za-z][a-z]+")
_IDENT = re.compile(r"[A-Za-z_][\w.]*")
_B64_MOST = 200  # base64-looking runs decoded, at most, in one text
_B64_CHARS = 400_000  # and their characters, at most
_PRINTABLE = bytes([9, 10, 13, *range(32, 127)])
MASK_SECONDS = 10.0  # mask_async's budget, then the crude mask


def strip_ansi(text: str) -> str:
    return _ANSI.sub("", text)


Saved = tuple[re.Pattern[str], dict[str, str]]  # (every form, as one pattern; form -> $NAME)


def _saved_variants(saved: dict[str, str]) -> Saved | None:
    """One pattern for every form a saved secret is printed in: as it is, URL-encoded,
    JSON-escaped, base64 (alone, or as a Basic header's user:value can't be known: those
    are caught by decoding), in any case."""
    import base64
    from urllib.parse import quote, quote_plus

    forms: dict[str, str] = {}
    for value, placeholder in saved.items():
        if not value:
            continue
        raw = value.encode()
        for form in (
            value,
            quote(value, safe=""),
            quote_plus(value),
            json.dumps(value)[1:-1],
            json.dumps(value, ensure_ascii=True)[1:-1],
            html.escape(value),
            base64.b64encode(raw).decode().rstrip("="),
            base64.urlsafe_b64encode(raw).decode().rstrip("="),
        ):
            if len(form) >= 4:
                forms.setdefault(form.lower(), placeholder)
    if not forms:
        return None
    alternation = "|".join(re.escape(f) for f in sorted(forms, key=len, reverse=True))
    return re.compile(alternation, re.IGNORECASE), forms


def _masked_value(m: re.Match[str], group: int | str = 2) -> str:
    value = m.group(group)
    if REDACTED in value or _REFERENCE.match(value):
        return m.group(0)
    start, end = m.span(group)
    whole = m.group(0)
    return whole[: start - m.start()] + REDACTED + whole[end - m.start() :]


def _plainly_not_secret(m: re.Match[str], name: str, group: int | str) -> bool:
    """A value given to a secret's name that a log says isn't one: a count (max_tokens:
    4096), words ("password: must be at least 8 characters"), another name
    (secretsmanager:GetSecretValue), a part of an ARN, a publishable key."""
    value = m.group(group)
    start, end = m.span(group)
    text = m.string
    bare = value.strip("\"'`")
    if _NUMBER.fullmatch(bare) and _COUNT_NAME.search(name):
        return True
    if bare.startswith(("pk_live_", "pk_test_")):
        return True
    if bare == value and _PROSE.fullmatch(value) and re.match(r" +[A-Za-z]", text[end : end + 3]):
        return True
    gap = text[m.start() + len(name) : start] if text.startswith(name, m.start()) else ""
    if gap == ":" and _IDENT.fullmatch(value) and not re.search(r"\d", value):
        return True
    # (in an ARN: arn:aws:secretsmanager:us-east-1:…:secret:prod/db)
    head = text[max(0, m.start() - 300) : m.start()]
    word = re.split(r"[\s\"'=(,]", head)[-1]
    return word.startswith("arn:")


def _output_value(m: re.Match[str], group: int | str, name: str) -> str:
    if _plainly_not_secret(m, name, group):
        return m.group(0)
    return _masked_value(m, group)


def _auth(m: re.Match[str]) -> str:
    """An Authorization header's credentials: after its scheme (Bearer, Basic…), or a bare
    value with a digit in it ("authorization: required" is words)."""
    if m.group(1).rstrip()[-1:].isalpha() or re.search(r"\d", m.group(2)):
        return _masked_value(m)
    return m.group(0)


def _cookie(m: re.Match[str]) -> str:
    def pair(p: re.Match[str]) -> str:
        name, value = p.group(2), p.group(3).strip()
        if name.lower() in _COOKIE_ATTRS or len(value) < 6 or REDACTED in value:
            return p.group(0)
        return f"{p.group(1)}{name}={REDACTED}"

    return m.group(1) + _COOKIE_PAIR.sub(pair, m.group(2))


def _auth_b64(m: re.Match[str]) -> str:
    """A Docker or npm auth: masked when it is base64 of user:password."""
    import base64

    try:
        raw = base64.b64decode(m.group(2) + "=" * (-len(m.group(2)) % 4))
    except ValueError:
        return m.group(0)
    if b":" in raw and not raw.translate(None, _PRINTABLE):
        return _masked_value(m)
    return m.group(0)


def _random_value(value: str) -> bool:
    """Letters and digits, random-looking, and not a path or an address."""
    if value.startswith(("/", "./", "../", "~/")) or "://" in value:
        return False
    if not (re.search(r"\d", value) and re.search(r"[A-Za-z]", value)):
        return False
    return secret_scan.entropy(value) >= 3.5


def _said_bare(m: re.Match[str]) -> str:
    return _masked_value(m, 3) if _random_value(m.group(3)) else m.group(0)


def _key_assigned(m: re.Match[str]) -> str:
    """A bare *_KEY name's value: masked when it's random-looking (CACHE_KEY=user:cart and
    I18N_KEY=checkout.title aren't secrets)."""
    bare = m.group(3).strip("\"'`")
    if not (_random_value(bare) or (len(bare) >= 20 and secret_scan.entropy(bare) >= 3.5)):
        return m.group(0)
    return _output_value(m, 3, m.group(1))


def _command_value(m: re.Match[str]) -> str:
    """A password on a command line: not a usage text's stand-in (--token TOKEN, <pass>)."""
    if re.fullmatch(r"[A-Z][A-Z_]*|<[^>]*>?|\[[^\]]*\]?|\.{3}", m.group(2)):
        return m.group(0)
    return _masked_value(m)


def _key_body(text: str) -> str:
    """A private key's body whose BEGIN line was cut off (a log's tail), up to its END line:
    each line looked at once (a pattern for it consumed every following line at each line's
    start, waiting for an END line that wasn't there: quadratic)."""
    if "-----END " not in text or "PRIVATE KEY" not in text:
        return text
    out: list[str] = []
    done = 0
    for m in _KEY_END.finditer(text):
        cut = m.start()
        while cut > done and text[cut - 1] == "\n":
            begin = text.rfind("\n", 0, cut - 1) + 1
            if begin < done or not _KEY_LINE.fullmatch(text, begin, cut - 1):
                break
            cut = begin
        if cut < m.start():
            out += [text[done:cut], REDACTED + "\n"]
            done = m.start()
    out.append(text[done:])
    return "".join(out)


def _pem_lines(text: str) -> str:
    """A private key's body with both its ends cut off (the middle of a log): three or more
    lines of a key's width (64, or OpenSSH's 70) of random base64. A certificate's or a
    public key's body stays."""
    if text.count("\n") < 2:
        return text
    lines = text.split("\n")
    public = False
    run: list[int] = []
    hits: list[int] = []

    def close() -> None:
        if len(run) >= 3:
            hits.extend(run)
            last = run[-1] + 1
            if last < len(lines) and _PEM_LAST.fullmatch(lines[last]):
                hits.append(last)
        run.clear()

    for i, line in enumerate(lines):
        if line.lstrip().startswith("-----"):
            close()
            if "-----BEGIN " in line:
                public = "PRIVATE" not in line
            elif "-----END " in line:
                public = False
            continue
        m = None if public else _PEM_LINE.fullmatch(line)
        body = m.group(1) if m else ""
        if (
            body
            and re.search(r"[A-Z]", body)
            and re.search(r"[a-z]", body)
            and re.search(r"\d", body)
        ):
            run.append(i)
        else:
            close()
    close()
    if not hits:
        return text
    for i in hits:
        lines[i] = REDACTED
    return "\n".join(lines)


def _across_lines(text: str) -> str:
    """A key of a known format that a logger wrapped onto the next line: both halves."""
    if "\n" not in text:
        return text
    lines = text.split("\n")
    for i in range(len(lines) - 1):
        line = lines[i]
        if not line or line[-1].isspace():
            continue  # (a wrapped key ends its line)
        start = max(line.rfind(" "), line.rfind("\t"), len(line) - WRAP_WINDOW - 1) + 1
        head = _HEAD.match(lines[i + 1])
        if not head:
            continue
        a, b = line[start:], head.group(1)[:WRAP_WINDOW]
        joined = a + b
        if "." not in joined and not _WRAP_LITERALS.search(joined):
            continue  # (no format's literal: none of them can match)
        for literals, pattern in _WRAPPED:
            if not any(lit in joined for lit in literals):
                continue
            m = pattern.search(joined)
            if not m or not m.start() < len(a) < m.end():
                continue
            # A whole key that ends its line is masked where it is: the next line's first
            # word is taken for its rest only when it looks like one (8 or more, a digit).
            alone = pattern.search(a)
            rest = joined[len(a) : m.end()]
            if alone and alone.end() == len(a) and not (len(rest) >= 8 and re.search(r"\d", rest)):
                continue
            lines[i] = line[: start + m.start()] + REDACTED
            cut = head.start(1) + (m.end() - len(a))
            lines[i + 1] = lines[i + 1][: head.start(1)] + REDACTED + lines[i + 1][cut:]
            break
    return "\n".join(lines)


def _unescape(m: re.Match[str]) -> str:
    char = chr(int(m.group(1), 16))
    return char if char.isalnum() or char in "-_.+/=:@" else m.group(0)


def _core(text: str, saved: Saved | None) -> str:
    if saved is not None:
        pattern, forms = saved
        text = pattern.sub(lambda m: forms.get(m.group(0).lower(), REDACTED), text)
    if "Secret" in text:
        text = _SECRET_STR.sub(_masked_value, text)
    if "://" in text:
        text = _URL_CREDS.sub(lambda m: f"{m.group(1)}{REDACTED}{m.group(3)}", text)
    text = _AUTH_HEADER.sub(_auth, text)
    text = _BEARER.sub(_masked_value, text)
    text = _COOKIE.sub(_cookie, text)
    text = _CONN_STRING.sub(_masked_value, text)
    text = _QUERY_SECRET.sub(_masked_value, text)
    text = _key_body(text)
    if "Private-Lines:" in text:
        text = _PUTTY.sub(lambda m: m.group(1) + REDACTED + "\n", text)
    text = _pem_lines(text)
    for pattern in _COMMANDS:
        text = pattern.sub(_command_value, text)
    text = _AUTH_B64.sub(_auth_b64, text)
    if any(k in text for k in ("AKIA", "ASIA", "ABIA", "ACCA")):
        text = _AWS_PAIR.sub(_masked_value, text)
    # A value given to a secret's name, whatever words it holds (but not what a log says
    # that isn't one: _plainly_not_secret).
    text = _assigned_sub(lambda m: _output_value(m, "value", m.group("name")), text)
    if text.isascii():
        hits: Any = _words_at(text, ("key",))
    else:
        hits = ((m.start(), m.end()) for m in re.finditer("(?i)key", text))
    text = _named_sub(_KEY_ASSIGNED, _KEY_TAIL, _key_assigned, text, hits)
    text = _secret_value_sub(lambda m: _output_value(m, 3, m.group(1)), text)
    text = _across_lines(text)
    text = _SAID_BARE.sub(_said_bare, text)
    return _formats(text, more=True)


def mask_output(text: str, saved: dict[str, str] | None = None) -> str:
    """An app's output (a server's log, a test's failure, a checker's problem) as a session
    is sent it: terminal codes out, \\u-escaped letters read, and every secret masked, the
    owner's saved ones ({value: $NAME}) in any of their printed forms. Linear in the text:
    a few milliseconds a kilobyte at most (mask_async runs it off the event loop)."""
    if not text:
        return text
    import base64

    text = strip_ansi(text)
    if "\\u00" in text:
        text = _U_ESCAPE.sub(_unescape, text)
    if "\\/" in text:
        text = text.replace("\\/", "/")  # (a JSON-escaped URL, its credentials seen)
    pattern = _saved_variants(saved) if saved else None
    text = _core(text, pattern)

    # A secret inside base64 (a Basic header's user:password, a base64 env file): the runs
    # that decode to text, each masked as the output is.
    def decoded(m: re.Match[str]) -> str:
        nonlocal tried, chars
        run = m.group(0)
        if REDACTED in run or tried >= _B64_MOST or chars >= _B64_CHARS:
            return run
        tried += 1
        chars += len(run)
        try:
            raw = base64.b64decode(
                run.replace("-", "+").replace("_", "/") + "=" * (-len(run) % 4), validate=False
            )
        except ValueError:
            return run
        if len(raw) < 8 or len(raw.translate(None, _PRINTABLE)) > len(raw) * 0.05:
            return run
        inner = raw.decode("utf-8", errors="replace")
        return REDACTED if _core(inner, pattern) != inner else run

    tried = chars = 0
    return _B64_RUN.sub(decoded, text)


_CRUDE_KEEP = re.compile(r"[A-Za-z]+[.,:;!?)\]]*|\(?[A-Za-z]+|\d{1,6}[.,:;)]*|[^\w\s]{1,3}")


def crude_mask(text: str, saved: dict[str, str] | None = None) -> str:
    """When masking runs out of time (mask_async): the saved secrets' forms, then every
    word that isn't plain letters or a short number, blanked. Nothing random-looking left;
    what the output says in words stays readable."""
    text = strip_ansi(text or "")
    pattern = _saved_variants(saved) if saved else None
    if pattern is not None:
        regex, forms = pattern
        text = regex.sub(lambda m: forms.get(m.group(0).lower(), REDACTED), text)
    return re.sub(
        r"\S+",
        lambda m: m.group(0)
        if _CRUDE_KEEP.fullmatch(m.group(0)) or m.group(0).startswith("$")
        else REDACTED,
        text,
    )


async def mask_async(
    text: str, saved: dict[str, str] | None = None, seconds: float = MASK_SECONDS
) -> str:
    """mask_output in a worker thread, so the event loop (every window, voice, the other
    sessions) is never held by it: within seconds, else crude_mask (nothing leaks)."""
    import asyncio

    if not text:
        return text
    try:
        return await asyncio.wait_for(asyncio.to_thread(mask_output, text, saved), seconds)
    except asyncio.TimeoutError:
        import logging

        logging.getLogger(__name__).warning(
            "Eden Code: masking %d characters took over %.0f s; crude mask used", len(text), seconds
        )
        return crude_mask(text, saved)


@dataclass
class Anonymizer:
    """Where things are on this Mac, replaced by stand-ins."""

    project: str
    home: str
    user: str

    @classmethod
    def for_session(cls, cwd: Path | str) -> Anonymizer:
        home = Path.home()
        return cls(project=str(Path(cwd)), home=str(home), user=home.name)

    def __call__(self, text: str) -> str:
        for real, stand_in in ((self.project, "<project>"), (self.home, "~")):
            if real and len(real) > 1:
                text = text.replace(real, stand_in)
        if len(self.user) >= 3:
            text = re.sub(rf"(?<![\w.-]){re.escape(self.user)}(?![\w-])", "<user>", text)
        return text


# ── the page ──

_CSS = """
:root { color-scheme: light; }
body { margin: 0; background: #f5f5f7; color: #1d1d1f; font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 32px 24px 64px; }
header h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -0.01em; }
header p { margin: 0; color: #6e6e73; font-size: 12.5px; }
.entry { margin: 14px 0; }
.who { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #86868b; margin-bottom: 4px; }
.user .body { background: #0a84ff; color: #fff; border-radius: 14px; padding: 10px 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.assistant .body { background: #fff; border-radius: 14px; padding: 10px 14px; box-shadow: 0 0 0 0.5px rgba(0,0,0,0.08); overflow-wrap: anywhere; }
.assistant .body p { margin: 0 0 8px; }
.assistant .body > :last-child { margin-bottom: 0; }
.assistant .body > :first-child { margin-top: 0; }
.assistant h2, .assistant h3, .assistant h4, .assistant h5, .assistant h6 { margin: 14px 0 6px; line-height: 1.3; }
.assistant h2 { font-size: 18px; } .assistant h3 { font-size: 16px; } .assistant h4, .assistant h5, .assistant h6 { font-size: 14px; }
.assistant ul, .assistant ol { margin: 0 0 8px; padding-left: 1.4em; }
.assistant li { margin: 2px 0; }
.assistant .task { display: inline-block; width: 13px; height: 13px; margin-right: 6px; border-radius: 4px; box-shadow: inset 0 0 0 1.2px #c7c7cc; vertical-align: -1px; font-size: 10px; line-height: 13px; text-align: center; color: #fff; }
.assistant .task.done { background: #0a84ff; box-shadow: none; }
.assistant blockquote { margin: 0 0 8px; padding: 2px 0 2px 12px; border-left: 3px solid #b6d4f5; color: #515154; }
.assistant table { border-collapse: collapse; margin: 4px 0 10px; font-size: 13px; }
.assistant th, .assistant td { padding: 5px 10px; border-bottom: 0.5px solid #d2d2d7; text-align: left; vertical-align: top; }
.assistant th { background: #f5f5f7; font-weight: 600; }
.assistant th.r, .assistant td.r { text-align: right; } .assistant th.c, .assistant td.c { text-align: center; }
.assistant ul.tasks { list-style: none; padding-left: 0.3em; }
.assistant hr { border: 0; height: 0.5px; background: #d2d2d7; margin: 12px 0; }
.assistant a { color: #0066cc; text-decoration: none; }
code { font: 12.5px ui-monospace, "SF Mono", Menlo, monospace; background: #f2f2f5; border-radius: 5px; padding: 1px 5px; }
pre code { background: none; padding: 0; border-radius: 0; font: inherit; }
pre { margin: 6px 0; padding: 10px 12px; background: #1d1d1f; color: #f5f5f7; border-radius: 10px; font: 12px/1.5 ui-monospace, "SF Mono", Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
details { background: #fff; border-radius: 12px; box-shadow: 0 0 0 0.5px rgba(0,0,0,0.08); padding: 8px 12px; }
details summary { cursor: pointer; font-size: 13px; }
details .label { font-weight: 600; }
details .state.failed { color: #d70015; font-weight: 600; }
details h4 { margin: 10px 0 2px; font-size: 11px; color: #86868b; text-transform: uppercase; letter-spacing: 0.04em; }
.thinking summary { color: #6e6e73; font-style: italic; }
.thinking pre { background: #f5f5f7; color: #424245; }
.note, .system { color: #6e6e73; font-size: 12.5px; font-style: italic; }
.note pre { font-style: normal; }
.files { font-size: 12px; opacity: 0.85; margin-top: 6px; }
img { display: block; max-width: 100%; margin: 8px 0; border-radius: 8px; }
.picture { font-size: 12px; color: #6e6e73; }
.cut { color: #6e6e73; font-size: 12px; }
@media print { body { background: #fff; } main { padding: 0; } details, .assistant .body { box-shadow: 0 0 0 0.5px #ccc; } }
"""


def _when(at: str) -> str:
    """When a message was written (an ISO time in UTC), as a local time of day."""
    try:
        return datetime.fromisoformat(str(at).replace("Z", "+00:00")).astimezone().strftime("%H:%M")
    except ValueError:
        return ""


def _who(name: str, e: dict[str, Any]) -> str:
    at = _when(e["at"]) if e.get("at") else ""
    return f'<div class="who">{html.escape(name)}{f" · {at}" if at else ""}</div>'


def _cut(text: str, limit: int) -> str:
    return (
        text
        if len(text) <= limit
        else text[:limit] + f"\n… ({len(text) - limit:,} more characters left out)"
    )


# ── Claude's words: Markdown, drawn as HTML (everything escaped: never markup of its own) ──

_MD_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_MD_HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$")
_MD_RULE = re.compile(r"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$")
_MD_QUOTE = re.compile(r"^ {0,3}> ?")
_MD_ITEM = re.compile(r"^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$")
_MD_DELIM_CELL = re.compile(r"^:?-+:?$")
_MD_DEPTH = 8  # quotes and lists inside each other, at most
_CODE_SPAN = re.compile(r"(`+)(.+?)\1", re.DOTALL)
_LINK = re.compile(
    r"\[([^\]\n]{1,300})\]\(<?([^()\s<>]{1,2000}(?:\([^()\s]*\)[^()\s<>]*)?)>?(?:\s+\"[^\"\n]*\")?\)"
)
_BARE_URL = re.compile(r"(?<![\w/\"'=])https?://[^\s<>\"'`]+")
_STRONG = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1")
_EM = re.compile(
    r"(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])"
)
_DEL = re.compile(r"~~(?=\S)(.+?)(?<=\S)~~")


def _width(lead: str) -> int:
    return len(lead.replace("\t", "    "))


def _lead(line: str) -> str:
    return line[: len(line) - len(line.lstrip(" \t"))]


def _starts_block(line: str) -> bool:
    return bool(
        _MD_FENCE.match(line)
        or _MD_HEADING.match(line)
        or _MD_RULE.match(line)
        or _MD_QUOTE.match(line)
    )


def _cells(line: str) -> list[str]:
    """A table row's cells: split on | outside `code`."""
    row = line.strip()
    row = row[1:] if row.startswith("|") else row
    row = row[:-1] if row.endswith("|") and not row.endswith("\\|") else row
    cells, cell, ticks = [], "", 0
    i = 0
    while i < len(row):
        c = row[i]
        if c == "\\" and row[i + 1 : i + 2] == "|":
            cell, i = cell + "|", i + 2
            continue
        if c == "`":
            run = len(row[i:]) - len(row[i:].lstrip("`"))
            ticks = 0 if ticks == run else ticks or run
            cell, i = cell + "`" * run, i + run
            continue
        if c == "|" and not ticks:
            cells.append(cell.strip())
            cell = ""
        else:
            cell += c
        i += 1
    cells.append(cell.strip())
    return cells


def _row(cells: list[str], tag: str, sides: list[str]) -> str:
    """A table row, each cell aligned as its column says."""
    out = []
    for k, side in enumerate(sides):
        cls = f' class="{side[0]}"' if side else ""  # l, r or c (a class: no style attributes)
        out.append(f"<{tag}{cls}>{_inline(cells[k] if k < len(cells) else '')}</{tag}>")
    return f"<tr>{''.join(out)}</tr>"


def _inline(text: str) -> str:
    """One block's words: `code`, links (web addresses only), bold, italics, strikethrough,
    line breaks; everything else escaped."""
    kept: list[str] = []

    def keep(markup: str) -> str:
        kept.append(markup)
        return f"\x00{len(kept) - 1}\x00"

    text = _CODE_SPAN.sub(lambda m: keep(f"<code>{html.escape(m.group(2).strip())}</code>"), text)

    def link(m: re.Match[str]) -> str:
        label, target = m.group(1), m.group(2)
        if re.match(r"(?i)https?://", target):
            return keep(f'<a href="{html.escape(target)}">{html.escape(label)}</a>')
        return keep(html.escape(label))  # a path or anything else: its words only

    text = _LINK.sub(link, text)
    text = _BARE_URL.sub(
        lambda m: (
            keep(
                f'<a href="{html.escape(m.group(0).rstrip(".,;:!?)"))}">{html.escape(m.group(0).rstrip(".,;:!?)"))}</a>'
            )
            + html.escape(m.group(0)[len(m.group(0).rstrip(".,;:!?)")) :])
        ),
        text,
    )
    text = html.escape(text, quote=False)
    text = _STRONG.sub(r"<strong>\2</strong>", text)
    text = _EM.sub(lambda m: f"<em>{m.group(1) or m.group(2)}</em>", text)
    text = _DEL.sub(r"<del>\1</del>", text)
    text = text.replace("\n", "<br>")
    return re.sub(r"\x00(\d+)\x00", lambda m: kept[int(m.group(1))], text)


def markdown_html(text: str, depth: int = 0) -> str:
    """Claude's Markdown as HTML: headings, paragraphs, lists (nested, numbered, to-dos),
    tables, quotes, rules and code blocks, with _inline's words."""
    lines = str(text or "").replace("\r\n", "\n").split("\n")
    out: list[str] = []
    para: list[str] = []

    def flush() -> None:
        if para:
            out.append(f"<p>{_inline(chr(10).join(para))}</p>")
            para.clear()

    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            flush()
            i += 1
            continue
        m = _MD_FENCE.match(line)
        if m and not (m.group(1)[0] == "`" and "`" in m.group(2)):
            flush()
            closer = re.compile(
                rf"^ {{0,3}}{re.escape(m.group(1)[0])}{{{len(m.group(1))},}}[ \t]*$"
            )
            body = []
            i += 1
            while i < len(lines) and not closer.match(lines[i]):
                body.append(lines[i])
                i += 1
            i += 1
            out.append(f"<pre><code>{html.escape(chr(10).join(body))}</code></pre>")
            continue
        m = _MD_HEADING.match(line)
        if m:
            flush()
            level = min(len(m.group(1)) + 1, 6)  # (the page's own title is the h1)
            out.append(f"<h{level}>{_inline((m.group(2) or '').strip())}</h{level}>")
            i += 1
            continue
        if _MD_RULE.match(line):
            flush()
            out.append("<hr>")
            i += 1
            continue
        if _MD_QUOTE.match(line):
            flush()
            inner = []
            while i < len(lines) and _MD_QUOTE.match(lines[i]):
                inner.append(_MD_QUOTE.sub("", lines[i], count=1))
                i += 1
            quoted = chr(10).join(inner)
            body = (
                markdown_html(quoted, depth + 1)
                if depth < _MD_DEPTH
                else f"<p>{_inline(quoted)}</p>"
            )
            out.append(f"<blockquote>{body}</blockquote>")
            continue
        if "|" in line and i + 1 < len(lines) and "-" in lines[i + 1]:
            head, align = _cells(line), _cells(lines[i + 1])
            if all(_MD_DELIM_CELL.match(a) for a in align) and len(head) == len(align):
                flush()
                sides = [
                    "center"
                    if a.startswith(":") and a.endswith(":")
                    else "right"
                    if a.endswith(":")
                    else "left"
                    if a.startswith(":")
                    else ""
                    for a in align
                ]

                rows = [_row(head, "th", sides)]
                i += 2
                while (
                    i < len(lines)
                    and lines[i].strip()
                    and "|" in lines[i]
                    and not _starts_block(lines[i])
                ):
                    rows.append(_row(_cells(lines[i]), "td", sides))
                    i += 1
                out.append(f"<table>{''.join(rows)}</table>")
                continue
        m = _MD_ITEM.match(line)
        if (
            m
            and _width(m.group(1)) <= 3
            and (not para or not re.match(r"\d", m.group(2)) or m.group(2)[:-1] == "1")
        ):
            flush()
            html_list, i = _list(lines, i, depth)
            out.append(html_list)
            continue
        para.append(line)
        i += 1
    flush()
    return "".join(out)


def _list(lines: list[str], i: int, depth: int) -> tuple[str, int]:
    first = _MD_ITEM.match(lines[i])
    assert first is not None
    base = _width(first.group(1))
    ordered = bool(re.match(r"\d", first.group(2)))
    start = int(first.group(2)[:-1]) if ordered else 1
    items: list[str] = []
    tasks = False
    while i < len(lines):
        m = _MD_ITEM.match(lines[i])
        if not m or _width(m.group(1)) != base or bool(re.match(r"\d", m.group(2))) != ordered:
            break
        column = base + len(m.group(2)) + 1
        body = [m.group(3)]
        i += 1
        while i < len(lines):
            line = lines[i]
            if not line.strip():
                ahead = next((x for x in lines[i + 1 :] if x.strip()), "")
                if ahead and _width(_lead(ahead)) > base:
                    body.append("")
                    i += 1
                    continue
                break
            at = _width(_lead(line))
            if at >= column or (_MD_ITEM.match(line) and at >= base + 2):
                body.append(
                    line.lstrip(" \t") if at <= column else " " * (at - column) + line.lstrip(" \t")
                )
                i += 1
                continue
            if not _MD_ITEM.match(line) and not _starts_block(line):
                body.append(line.strip())  # (its text running on)
                i += 1
                continue
            break
        task = re.match(r"^\[([ xX])\][ \t]+", body[0])
        if task:
            body[0] = body[0][task.end() :]
        inner = chr(10).join(body).strip("\n")
        content = (
            markdown_html(inner, depth + 1) if depth < _MD_DEPTH else f"<p>{_inline(inner)}</p>"
        )
        if content.startswith("<p>") and content.count("<p>") == 1 and content.endswith("</p>"):
            content = content[3:-4]
        if task:
            done = task.group(1) != " "
            content = (
                f'<span class="task{" done" if done else ""}">{"✓" if done else ""}</span>{content}'
            )
        items.append(f"<li>{content}</li>")
        tasks = tasks or bool(task)
    tag = "ol" if ordered else "ul"
    begin = f' start="{start}"' if ordered and start != 1 else ""
    begin += ' class="tasks"' if tasks else ""
    return f"<{tag}{begin}>{''.join(items)}</{tag}>", i


class Page:
    def __init__(self, safe: bool, clean: Any, printing: bool) -> None:
        self.safe, self.clean, self.printing = safe, clean, printing
        self.picture_budget = PICTURES_BYTES

    def pictures(self, items: list[dict[str, str]]) -> str:
        out = []
        for p in items:
            kind, data = p.get("media_type", ""), p.get("data", "")
            fits = (
                kind.startswith("image/")
                and data
                and len(data) <= min(PICTURE_BYTES, self.picture_budget)
            )
            if (
                self.safe
                or self.printing
                or not fits
                or not re.fullmatch(r"[A-Za-z0-9+/=\s]+", data[:200])
            ):
                why = "left out of a share-safe export" if self.safe else "not included"
                out.append(f'<p class="picture">[a picture, {why}]</p>')
                continue
            self.picture_budget -= len(data)
            out.append(f'<img alt="" src="data:{html.escape(kind)};base64,{data}">')
        return "".join(out)

    def entry(self, e: dict[str, Any]) -> str:
        c = self.clean
        kind = e["kind"]
        if kind == "user":
            files = e.get("files") or []
            extra = (
                f'<div class="files">Attached: {html.escape(c(", ".join(files)))}</div>'
                if files
                else ""
            )
            body = html.escape(c(_cut(e.get("text") or "", TEXT_CHARS)))
            return f'<section class="entry user">{_who("You", e)}<div class="body">{body}{extra}</div>{self.pictures(e.get("pictures") or [])}</section>'
        if kind == "assistant":
            return f'<section class="entry assistant">{_who("Eden Code", e)}<div class="body">{markdown_html(c(_cut(e["text"], TEXT_CHARS)))}</div></section>'
        if kind == "thinking":
            text = (
                "(Its thinking here isn't shown by the model.)"
                if e.get("hidden")
                else _cut(e["text"], TEXT_CHARS)
            )
            opened = " open" if self.printing else ""
            return f'<details class="entry thinking"{opened}><summary>Thinking</summary><pre>{html.escape(c(text))}</pre></details>'
        if kind == "step":
            args = json.dumps(e.get("input") or {}, indent=2, ensure_ascii=False)
            state = (
                ""
                if e.get("output") is not None
                else ' <span class="state">(no result recorded)</span>'
            )
            if e.get("error"):
                state = ' <span class="state failed">failed</span>'
            output = e.get("output")
            out_html = (
                f"<h4>Output</h4><pre>{html.escape(c(_cut(output, STEP_CHARS)))}</pre>"
                if output
                else ""
            )
            opened = " open" if self.printing else ""
            about = html.escape(c(_about(e["name"], e.get("input") or {})))
            return (
                f'<details class="entry step"{opened}><summary><span class="label">{html.escape(e["name"])}</span>'
                f"{' · ' + about if about else ''}{state}</summary>"
                f"<h4>Input</h4><pre>{html.escape(c(_cut(args, STEP_CHARS)))}</pre>{out_html}"
                f"{self.pictures(e.get('pictures') or [])}</details>"
            )
        body = e.get("text") or ""
        if kind == "note":
            return f'<section class="entry note"><pre>{html.escape(c(_cut(body, TEXT_CHARS)))}</pre></section>'
        return f'<section class="entry system">{html.escape(c(_cut(body, TEXT_CHARS)))}</section>'


def _about(name: str, args: dict[str, Any]) -> str:
    from .tasks import describe_tool

    try:
        return describe_tool(name, args)[:160]
    except Exception:
        return ""


def render(
    entries: list[dict[str, Any]],
    *,
    title: str,
    project: str,
    model: str = "",
    safe: bool = False,
    anonymize: Any = None,
    printing: bool = False,
    when: datetime | None = None,
) -> str:
    """The export as one self-contained HTML page (no scripts, nothing fetched)."""
    steps = [lambda t: t]
    if anonymize is not None:  # (first: a path is itself, not a random-looking run, to hide)
        steps.append(anonymize)
    if safe:
        steps.append(redact_secrets)

    def clean(text: str) -> str:
        for step in steps:
            text = step(text)
        return text

    page = Page(safe, clean, printing)
    when = when or datetime.now()
    what = "A share-safe export" if safe else "The whole session"
    facts = [
        project,
        f"{len(entries)} {'entry' if len(entries) == 1 else 'entries'}",
        f"exported {when:%d %B %Y, %H:%M}",
    ]
    if model:
        facts.insert(1, model)
    head = (
        f"<header><h1>{html.escape(clean(title))}</h1>"
        f"<p>{html.escape(clean(' · '.join(f for f in facts if f)))}</p>"
        f"<p>{what}: every message, each step with its input and output, and the thinking.</p></header>"
    )
    body: list[str] = []
    size = len(head)
    for n, e in enumerate(entries):
        piece = page.entry(e)
        if size + len(piece) > PAGE_CHARS:
            body.append(
                f'<p class="cut">… the last {len(entries) - n:,} entries are left out: the page is full.</p>'
            )
            break
        body.append(piece)
        size += len(piece)
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">"
        f"<title>{html.escape(clean(title))}</title><style>{_CSS}</style></head>"
        f"<body><main>{head}{''.join(body)}</main></body></html>"
    )


def file_stem(title: str, safe: bool, when: datetime | None = None) -> str:
    when = when or datetime.now()
    # Letters and digits of any language ("修复登录 bug" kept whole), spaces; nothing a
    # file name can't hold (/ : NUL) or that isn't a word (✓, controls).
    words = re.sub(r"[^\w ]+", " ", title or "Session").split()
    slug = " ".join(words)[:60].strip() or "Session"
    return f"{when:%Y-%m-%d %H%M} {slug}{' (share-safe)' if safe else ''}"
