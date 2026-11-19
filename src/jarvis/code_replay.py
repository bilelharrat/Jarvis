"""A past Eden Code session played back step by step: every message, the thinking, each
step with its input and output, what each edit changed, and the files as they were at each
of the owner's messages, read from Claude Code's own record (the export's entries:
code_export.entries_from) and its file checkpoints.

- Steps: the export's entries as a numbered list the Replay pane scrubs through, each with
  the turn it's in (the owner's message that began it) and, for an edit, its diff, made
  from the edit's own input (Edit's old and new text, MultiEdit's edits, Write's whole
  file), so no file is read to show one.
- Checkpoints: before each of the owner's messages Claude Code keeps a copy of every file
  it has changed so far (a "file-history-snapshot" line in the record, and the copies in
  <config>/file-history/<session id>/). That is what rewind_files puts back, and here it is
  the file as it was at that point: a turn's change to a file is its copy at the turn's
  message against its copy at the next one (or the file as it is now, after the last). A
  copy named None means the file wasn't there yet. A file first changed later wasn't
  copied at this point: it was as it was before its first change (its first copy).
- A summary to carry on from (summary): the owner's messages up to a point, the last reply
  and the files changed, as words for a new session's first message (no model writes it).

Bounded everywhere: STEPS_MAX steps, each text cut at TEXT_CHARS, a diff at DIFF_LINES
lines, a file read back at FILE_BYTES. Only a file a checkpoint names is ever read, and a
copy only from the session's own file-history folder.

Nothing here calls a model.
"""

from __future__ import annotations

import difflib
import json
import os
import re
from collections import OrderedDict
from pathlib import Path
from typing import Any

from .code_export import redact_secrets

STEPS_MAX = 3000
TEXT_CHARS = 4000
INPUT_CHARS = 2000
DIFF_LINES = 400
FILE_BYTES = 400_000
SUMMARY_CHARS = 6000
EDIT_TOOLS = frozenset({"Edit", "MultiEdit", "Write", "NotebookEdit"})
AGENT_TOOLS = frozenset({"Task", "Agent"})
_SNAPSHOT_MARK = b'"file-history-snapshot"'
_BACKUP_NAME = re.compile(r"[0-9A-Za-z_-]{4,80}@v\d{1,6}")
_SESSION = re.compile(rb'"sessionId"\s*:\s*"([0-9a-fA-F-]{36})"')


def _cut(text: str, limit: int) -> str:
    text = str(text or "")
    return (
        text
        if len(text) <= limit
        else text[:limit] + f"\n… ({len(text) - limit:,} more characters)"
    )


def _one_line(text: str, limit: int = 120) -> str:
    words = " ".join(str(text or "").split())
    return words if len(words) <= limit else words[: limit - 1] + "…"


# ── an edit's own diff ──


def _unified(before: str, after: str, path: str) -> str:
    lines = list(
        difflib.unified_diff(
            before.splitlines(), after.splitlines(), f"a/{path}", f"b/{path}", n=3, lineterm=""
        )
    )
    if len(lines) > DIFF_LINES:
        lines = [*lines[:DIFF_LINES], f"… ({len(lines) - DIFF_LINES:,} more lines)"]
    return "\n".join(lines)


def edit_diff(name: str, args: dict[str, Any]) -> tuple[str, str]:
    """(path, diff) for one of Claude Code's edits, from its input alone; ("", "") for any
    other step. Write's diff is the whole file as added (what was there before is the
    checkpoint's, not the step's)."""
    if name not in EDIT_TOOLS or not isinstance(args, dict):
        return "", ""
    path = str(args.get("file_path") or args.get("notebook_path") or "")
    if not path:
        return "", ""
    if name == "Edit":
        diff = _unified(str(args.get("old_string") or ""), str(args.get("new_string") or ""), path)
    elif name == "MultiEdit":
        parts = [
            _unified(str(e.get("old_string") or ""), str(e.get("new_string") or ""), path)
            for e in (args.get("edits") or [])[:50]
            if isinstance(e, dict)
        ]
        diff = "\n".join(p for p in parts if p)
    elif name == "Write":
        diff = _unified("", str(args.get("content") or ""), path)
    else:  # NotebookEdit: the cell's new source
        diff = _unified("", str(args.get("new_source") or ""), path)
    return path, diff


# ── the steps ──


def _title(e: dict[str, Any]) -> str:
    kind = e.get("kind")
    if kind == "step":
        name = str(e.get("name") or "tool")
        args = e.get("input") if isinstance(e.get("input"), dict) else {}
        if name in AGENT_TOOLS:
            return f"Agent: {_one_line(args.get('description') or args.get('subagent_type') or 'a subagent', 80)}"
        about = (
            args.get("file_path")
            or args.get("notebook_path")
            or args.get("command")
            or args.get("pattern")
            or args.get("url")
            or args.get("query")
            or ""
        )
        return f"{name}: {_one_line(about, 100)}" if about else name
    if kind == "thinking":
        return "Thinking" if not e.get("hidden") else "Thinking (hidden)"
    return _one_line(e.get("text") or "", 120) or {"user": "Your message"}.get(str(kind), "")


def steps_from(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The export's entries as the replay's numbered steps. turn is the uuid of the
    owner's message the step's turn began with ("" before the first one)."""
    out: list[dict[str, Any]] = []
    turn = ""
    for e in entries:
        if len(out) >= STEPS_MAX:
            break
        kind = str(e.get("kind") or "")
        if kind == "user" and e.get("uuid"):
            turn = str(e["uuid"])
        step: dict[str, Any] = {
            "n": len(out),
            "kind": kind,
            "title": _title(e),
            "turn": turn,
            "at": str(e.get("at") or ""),
            "uuid": str(e.get("uuid") or ""),
        }
        if kind == "step":
            name = str(e.get("name") or "tool")
            args = e.get("input") if isinstance(e.get("input"), dict) else {}
            step["kind"] = "agent" if name in AGENT_TOOLS else "tool"
            step["tool"] = name
            if name in AGENT_TOOLS:
                step["agent"] = str(args.get("subagent_type") or "general-purpose")[:80]
            path, diff = edit_diff(name, args)
            if path:
                step["path"], step["diff"] = path, diff
            shown = {
                k: v
                for k, v in args.items()
                if not (
                    path and k in ("content", "old_string", "new_string", "edits", "new_source")
                )
            }
            step["input"] = _cut(json.dumps(shown, ensure_ascii=False, indent=1), INPUT_CHARS)
            step["output"] = None if e.get("output") is None else _cut(e["output"], TEXT_CHARS)
            step["error"] = bool(e.get("error"))
        else:
            step["text"] = _cut(e.get("text") or "", TEXT_CHARS)
            if e.get("hidden"):
                step["hidden"] = True
            if kind == "user":
                step["pictures"] = len(e.get("pictures") or [])
                step["files"] = [str(f)[:200] for f in (e.get("files") or [])][:20]
        out.append(step)
    return out


# ── checkpoints ──


def config_dir() -> Path:
    """Claude Code's own folder (CLAUDE_CONFIG_DIR, as it reads it; else ~/.claude)."""
    given = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return Path(given).expanduser() if given else Path.home() / ".claude"


def snapshots(record: Path | None) -> tuple[OrderedDict[str, dict[str, str | None]], list[str]]:
    """The record's checkpoints, in order: the owner's message uuid -> {file's path: its
    copy's name, or None (it wasn't there yet)}, the latest line for each message (a turn
    adds the files it changes to its message's checkpoint as it goes); and the session ids
    the record's lines carry (a fork's record starts with its original's, whose copies are
    in the original's folder)."""
    found: OrderedDict[str, dict[str, str | None]] = OrderedDict()
    sessions: list[str] = []
    if record is None:
        return found, sessions
    try:
        with record.open("rb") as f:
            for raw in f:
                sid = _SESSION.search(raw[-4096:]) or (
                    None if len(raw) > 65536 else _SESSION.search(raw)
                )
                if (
                    sid is not None
                    and (s := sid.group(1).decode()) not in sessions
                    and len(sessions) < 20
                ):
                    sessions.append(s)
                if _SNAPSHOT_MARK not in raw[:200]:
                    continue
                try:
                    line = json.loads(raw)
                except ValueError:
                    continue
                snap = line.get("snapshot") if isinstance(line, dict) else None
                if not isinstance(snap, dict):
                    continue
                uid = str(line.get("messageId") or snap.get("messageId") or "")
                files = snap.get("trackedFileBackups")
                if not uid or not isinstance(files, dict):
                    continue
                kept: dict[str, str | None] = {}
                for path, backup in list(files.items())[:2000]:
                    name = backup.get("backupFileName") if isinstance(backup, dict) else None
                    kept[str(path)] = str(name) if isinstance(name, str) else None
                if uid in found:
                    found[uid].update(kept)
                else:
                    found[uid] = kept
    except OSError:
        return OrderedDict(), sessions
    return found, sessions


def state_at(snaps: OrderedDict[str, dict[str, str | None]], uid: str) -> dict[str, str | None]:
    """Every file the session changed, as it was at that message: its copy there, or (one
    first changed later) its first copy. {} for a message with no checkpoint."""
    if uid not in snaps:
        return {}
    state = dict(snaps[uid])
    order = list(snaps)
    for later in order[order.index(uid) + 1 :]:
        for path, name in snaps[later].items():
            state.setdefault(path, name)
    return state


def history_dirs(session_ids: list[str]) -> list[Path]:
    root = config_dir() / "file-history"
    return [root / s for s in session_ids if re.fullmatch(r"[0-9a-fA-F-]{36}", s)]


def read_copy(dirs: list[Path], name: str | None) -> bytes | None:
    """A checkpoint's copy of a file (bounded), from the session's own folders only; None
    when there's none (the file wasn't there, or the copy is gone)."""
    if not name or not _BACKUP_NAME.fullmatch(name):
        return None
    for folder in dirs:
        path = folder / name
        try:
            if path.is_file() and not path.is_symlink():
                with path.open("rb") as f:
                    return f.read(FILE_BYTES + 1)
        except OSError:
            continue
    return None


def as_text(data: bytes | None) -> tuple[str | None, bool]:
    """(text, binary): a file's bytes as text to show; binary when it isn't text."""
    if data is None:
        return None, False
    cut = len(data) > FILE_BYTES
    data = data[:FILE_BYTES]
    if b"\0" in data[:8192]:
        return None, True
    text = data.decode("utf-8", errors="replace")
    return (text + "\n… (cut here)" if cut else text), False


def file_change(before: str | None, after: str | None, path: str) -> str:
    return _unified(before or "", after or "", path)


# ── carrying on from a point ──


def summary(title: str, steps: list[dict[str, Any]], upto: int, files: list[str]) -> str:
    """Words for a new session's first message: what the session was asked, its last
    reply and the files it changed, up to step upto. Secrets blanked out."""
    shown = steps[: upto + 1]
    asked = [s["text"] for s in shown if s.get("kind") == "user" and s.get("text")]
    reply = next((s["text"] for s in reversed(shown) if s.get("kind") == "assistant"), "")
    lines = [
        f"Carrying on from the session “{_one_line(title, 80)}”, from step {upto + 1} of {len(steps)}.",
        "",
        "What I asked there:",
    ]
    for text in asked[-6:]:
        lines.append(f"- {_one_line(text, 400)}")
    if len(asked) > 6:
        lines.insert(3, f"- (and {len(asked) - 6} earlier messages)")
    if reply:
        lines += ["", "Its last reply:", _cut(reply, 1500)]
    if files:
        shown_files = files[:20]
        more = f" and {len(files) - 20} more" if len(files) > 20 else ""
        lines += ["", f"Files it had changed: {', '.join(shown_files)}{more}."]
    lines += ["", "Pick up from there: "]
    return redact_secrets("\n".join(lines))[:SUMMARY_CHARS]
