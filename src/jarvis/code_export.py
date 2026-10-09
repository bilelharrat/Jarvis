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
    for kind, pattern in secret_scan.PATTERNS:
        if kind == "Password in a URL":
            text = pattern.sub(lambda m: m.group(0).replace(m.group(1), REDACTED), text)
        elif kind == "Private key":
            text = _PRIVATE_KEY.sub(REDACTED, text)
        else:
            text = pattern.sub(REDACTED, text)

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

    text = secret_scan.ASSIGNED.sub(assigned, text)
    text = _SECRET_VALUE.sub(said, text)
    return secret_scan.QUOTED.sub(quoted, text)


_PRIVATE_KEY = re.compile(
    r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----.*?"
    r"(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|\Z)",
    re.DOTALL,
)


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
    slug = re.sub(r"[^A-Za-z0-9 ]+", "", title or "Session").strip()[:60] or "Session"
    return f"{when:%Y-%m-%d %H%M} {slug}{' (share-safe)' if safe else ''}"
