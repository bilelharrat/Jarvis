"""Eden Code's provenance notes: which session, model and prompt wrote each line Eden
committed, kept in git beside the commit, never in it.

People who don't trust agent-written code ask for one thing above the rest: for any line,
which prompt produced it. The obvious place, the commit message, is the wrong one: a
"Co-Authored-by" or "Prompt:" trailer rewrites the owner's own history, can't be taken
back once pushed, and was the reason for a loud backlash when an editor started adding
them by itself. So Eden writes git notes instead, under their own ref (refs/notes/eden,
NOTES_REF): attached to a commit without changing it (its id stays the same), invisible to
`git log` unless asked for (`git log --notes=eden`), and local. git pushes a notes ref only
when it's named (`git push origin refs/notes/eden`), and nothing in Eden ever names it, so
the notes stay on this Mac unless the owner pushes them on purpose.

When a note is written: every time Eden itself commits a session's work. That's the Git
panel's Commit (features/code_git.py), landing an isolated copy (features/code_isolation.py,
and so the merge queue, which lands through it), and the commit a pull request makes of a
copy's uncommitted work (features/code_pr.py). Commits made by hand in Terminal get none.

What a note says (one JSON document per commit, NOTE_FORMAT):
- each session whose work is in the commit: its number, its Claude Code session id, its
  title, the model it ran on, and the engine (this app's version and the Agent SDK's);
- each of that session's turns that wrote something in it: its place in the conversation,
  a digest of the prompt (sha256 of its words, so the same prompt can be recognised
  without its text) and a short summary of it (its first words, at most SUMMARY_MAX
  characters, anything that looks like a key or token replaced by "[secret]"), when it was
  sent, and the transcript entry of the turn's receipt (features/code_receipts.py), so
  the window can go from a line to its proof;
- each hunk of the commit (git diff -U0 against its first parent) that a session wrote:
  the file, the lines it added in the commit (ranges), and which session and turn wrote it.

Per-hunk ownership is the Changes pane's (code_changes.py): every edit a session makes
leaves a mark with the turn it was made in (EditMark.checkpoint), and a hunk is a turn's
when its changed lines are ones that turn's edits wrote or took out (the same _owned test,
asked once per turn). Several turns can have written the same lines: the latest one wins,
as it's the one whose words are in the file. In a shared folder a hunk nobody's marks own
is the owner's (or another tool's) and isn't in the note; in a session's isolated copy
everything is the session's, so a hunk no turn's marks match is still listed, as the
session's, without a turn (a command it ran wrote it, say).

The overlay: the Files pane's editor (web/features/code-editor.js) and the Changes pane
(web/features/code_changes.js) show "which session and prompt wrote this" through
web/features/code-provenance.js. The editor asks code_provenance_blame for an open file:
git blame says which commit, and which line in it, each line comes from; that commit's
note says which hunk, so which session and turn. Lines not committed yet aren't in any
note: the Changes pane covers those, asking code_provenance_hunks, which answers from the
live marks the same way.

Pull requests: with code_provenance_pr on (off by default: a pull request is public, and
prompts can say more than the code does), the description Eden drafts gets a "Provenance"
section made from the notes of the branch's commits (pr_section), once.

Settings (prefs.features): code_provenance (bool, on): write the notes and show the
overlay; code_provenance_pr (bool, off): add the section to pull requests. Turning
code_provenance off stops new notes; the ones written stay in the repository (`git notes
--ref=eden prune`, or deleting the ref, removes them).
Window commands: code_provenance_blame {id | directory, path, ref?} → event
code_provenance_blame {key, path, ref, spans: [[first, last, who]], who: [...], note}; code_provenance_hunks {id, view}
→ event code_provenance_hunks {id, view, hunks: {hunk id: who}}.

Cost policy: no model calls. Everything here is git (notes, diff, blame, rev-list) run in
the project with code_changes.git's timeouts, off the event loop.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any

from .. import code_changes, prefs, secret_scan
from ..code_changes import EMPTY_TREE, FileDiff, git, parse_patch
from ..hub import _msg_int

log = logging.getLogger("jarvis")

PREF = "code_provenance"
PREF_PR = "code_provenance_pr"
prefs.register_feature_pref(PREF, True)
prefs.register_feature_pref(PREF_PR, False)

NOTES_REF = "refs/notes/eden"
NOTE_FORMAT = 1
SUMMARY_MAX = 120
DIGEST_CHARS = 16  # of sha256's hex: plenty to tell prompts apart, short to read
MAX_COMMITS = 200  # a landing's commits noted, at most (newest)
MAX_HUNKS = 2000  # hunks one note lists
BLAME_LINES = 20_000  # a longer file gets no overlay
PR_MARK = "<!-- eden-provenance -->"
PR_TURNS = 30  # turns a pull request's section lists
_ZEROS = "0" * 40
_UNKNOWN_TURN = {"n": 0, "digest": "", "summary": "", "at": "", "receipt": 0}


# ── a prompt, safe to keep ──


def prompt_digest(text: str) -> str:
    """The prompt's fingerprint: sha256 of its words (spacing doesn't count)."""
    words = " ".join(str(text or "").split())
    return "sha256:" + hashlib.sha256(words.encode("utf-8")).hexdigest()[:DIGEST_CHARS]


_LONG = re.compile(r"\S{20,}")


def scrub(text: str) -> str:
    """The text with anything that looks like a key, token or password replaced by
    "[secret]" (the commit secret scan's patterns, secret_scan.py, and any long
    random-looking word)."""
    out = str(text or "")[: secret_scan.LINE_CHARS]
    for _kind, pattern in secret_scan.PATTERNS:
        out = pattern.sub("[secret]", out)

    def value(m: re.Match[str]) -> str:
        start, end = m.span("value")
        whole = m.group(0)
        a, b = start - m.start(), end - m.start()
        return whole[:a] + "[secret]" + whole[b:]

    out = secret_scan.assigned(6).sub(value, out)
    return _LONG.sub(lambda m: "[secret]" if _keyish(m.group(0)) else m.group(0), out)


def _keyish(word: str) -> bool:
    """A long word that reads like a key, not a name: letters and several digits, mixed
    randomly (get_user_by_email_address is a name; a token has digits all through it)."""
    digits = sum(c.isdigit() for c in word)
    return digits >= 3 and any(c.isalpha() for c in word) and secret_scan._random_looking(word)


def prompt_summary(text: str, limit: int = SUMMARY_MAX) -> str:
    """The prompt's first words, on one line, scrubbed, at most limit characters."""
    words = scrub(" ".join(str(text or "").split()))
    return words if len(words) <= limit else words[: limit - 1].rstrip() + "…"


_ENGINE: dict[str, str] = {}


def engine() -> dict[str, str]:
    """What wrote it: this app's version and the Claude Agent SDK's (read once)."""
    if not _ENGINE:
        try:
            from ..account import app_version

            _ENGINE["eden"] = app_version() or ""
        except Exception:  # (no package.json in a checkout run)
            _ENGINE["eden"] = ""
        try:
            import claude_agent_sdk

            _ENGINE["claude_agent_sdk"] = str(getattr(claude_agent_sdk, "__version__", ""))
        except Exception:  # pragma: no cover - always installed
            _ENGINE["claude_agent_sdk"] = ""
    return dict(_ENGINE)


# ── a session's turns ──


def turns_of(task: Any) -> dict[str, dict[str, Any]]:
    """Each of the session's turns, by its checkpoint (the user message's id): its place in
    the conversation, the prompt's digest and summary, when, and its receipt's entry."""
    out: dict[str, dict[str, Any]] = {}
    current: dict[str, Any] | None = None
    place = 0
    for entry in getattr(task, "transcript", None) or []:
        role = entry.get("role")
        if role == "user":
            place += 1
            uid = str(entry.get("uuid") or "")
            current = None
            if uid:
                text = str(entry.get("text") or "")
                current = out[uid] = {
                    "n": place,
                    "digest": prompt_digest(text),
                    "summary": prompt_summary(text),
                    "at": str(entry.get("at") or ""),
                    "receipt": 0,
                }
        elif current is not None and entry.get("receipt") and not current["receipt"]:
            current["receipt"] = int(entry.get("n") or 0)
    return out


def session_of(task: Any) -> dict[str, Any]:
    title = str(getattr(task, "title", "") or "") or prompt_summary(task.prompt, 80)
    return {
        "task": int(task.id),
        "session": str(getattr(task, "session_id", "") or ""),
        "title": prompt_summary(title, 80),
        "model": str(
            getattr(task, "model_label", "") or getattr(task, "model", "")
            or getattr(task, "model_ref", "") or ""
        ),
        "engine": engine(),
    }  # fmt: skip


# ── which turn wrote a hunk ──


class Owner:
    """One session's marks, ready to ask of hunks: by file, and in each file by turn."""

    def __init__(self, task: Any, top: Path, isolated: bool) -> None:
        self.task = task
        self.isolated = isolated
        order = {uid: i for i, uid in enumerate(getattr(task, "checkpoints", None) or [])}
        self.files: dict[str, list[tuple[str, tuple[set[str], set[str], bool]]]] = {}
        by_file = code_changes.marks_by_file(list(getattr(task, "edit_marks", None) or []), top)
        for path, marks in by_file.items():
            turns: dict[str, list[Any]] = {}
            for m in marks:
                turns.setdefault(m.checkpoint, []).append(m)
            # The latest turn first: it's the one whose words are in the file.
            ordered = sorted(turns, key=lambda uid: order.get(uid, -1), reverse=True)
            self.files[path] = [(uid, code_changes._written(turns[uid])) for uid in ordered]

    def turn(self, f: FileDiff, h: code_changes.Hunk) -> str | None:
        """The checkpoint of the latest turn that wrote the hunk; "" for the session's own
        without a turn (in its copy); None when it isn't the session's."""
        for uid, written in self.files.get(f.path) or self.files.get(f.old_path) or []:
            if code_changes._owned(h, *written):
                return uid
        return "" if self.isolated else None


def owners_for(tasks: list[Any], top: Path) -> list[Owner]:
    """The sessions whose work can be in top's commits: those working in it, isolated when
    it's their own copy."""
    try:
        here = top.resolve()
    except OSError:
        return []
    out = []
    for task in tasks:
        if getattr(task, "kind", "code") != "code":
            continue
        try:
            cwd = Path(task.cwd).resolve()
        except OSError:
            continue
        if cwd != here and here not in cwd.parents:
            continue
        ws = getattr(task, "workspace", None) or {}
        out.append(Owner(task, here, bool(ws)))
    return out


def added_ranges(h: code_changes.Hunk) -> list[list[int]]:
    """The new file's lines the hunk adds, as [first, last] ranges."""
    ranges: list[list[int]] = []
    line = h.new_start
    for tag, _text in h.lines:
        if tag == "+":
            if ranges and ranges[-1][1] == line - 1:
                ranges[-1][1] = line
            else:
                ranges.append([line, line])
            line += 1
        elif tag == " ":
            line += 1
    return ranges


def commit_files(top: Path, commit: str) -> list[FileDiff]:
    """The commit's changes against its first parent (everything, for a first commit), with
    no context, so each hunk is one stretch of change. Credentials and binaries are left
    out: there are no lines to name."""
    parent = git(top, "rev-parse", "-q", "--verify", f"{commit}^1")
    base = parent.out.strip() if parent.ok and parent.out.strip() else EMPTY_TREE
    found = git(
        top, *code_changes._diff_args(), "-U0", "--no-color", "--no-ext-diff", "--no-textconv",
        "-M", base, commit, timeout=60,
    )  # fmt: skip
    if not found.ok:
        return []
    files = parse_patch(found.out)
    return [f for f in files if not f.binary and not code_changes.is_sensitive(top / f.path)]


def note_for(files: list[FileDiff], owners: list[Owner]) -> dict[str, Any] | None:
    """The note for a commit with these changes: None when no session wrote any of it."""
    sessions: list[dict[str, Any]] = []
    index: dict[int, int] = {}  # task id -> its place in sessions
    turn_index: dict[tuple[int, str], int] = {}
    turn_info: dict[int, dict[str, dict[str, Any]]] = {}
    hunks: list[dict[str, Any]] = []
    for f in files:
        for h in f.hunks:
            if len(hunks) >= MAX_HUNKS:
                break
            ranges = added_ranges(h)
            if not ranges:
                continue  # (only lines taken out: nothing left in the file to point at)
            for owner in owners:
                uid = owner.turn(f, h)
                if uid is None:
                    continue
                task = owner.task
                if task.id not in index:
                    index[task.id] = len(sessions)
                    sessions.append({**session_of(task), "turns": []})
                    turn_info[task.id] = turns_of(task)
                s = index[task.id]
                t = 0
                if uid:
                    key = (task.id, uid)
                    if key not in turn_index:
                        # (A turn whose prompt the transcript no longer keeps, it
                        # keeps the newest entries: listed without words.)
                        info = dict(turn_info[task.id].get(uid) or _UNKNOWN_TURN)
                        info["checkpoint"] = uid
                        sessions[s]["turns"].append(info)
                        turn_index[key] = len(sessions[s]["turns"])
                    t = turn_index[key]
                hunks.append({"path": f.path, "lines": ranges, "s": s, "t": t})
                break
    if not hunks:
        return None
    return {"eden_provenance": NOTE_FORMAT, "sessions": sessions, "hunks": hunks}


# ── notes in git ──


def read_note(top: Path, commit: str) -> dict[str, Any] | None:
    shown = git(top, "notes", "--ref", NOTES_REF, "show", commit)
    return parse_note(shown.out) if shown.ok else None


def parse_note(text: str) -> dict[str, Any] | None:
    try:
        note = json.loads(text)
    except (ValueError, TypeError):
        return None
    if not isinstance(note, dict) or note.get("eden_provenance") != NOTE_FORMAT:
        return None
    if not isinstance(note.get("sessions"), list) or not isinstance(note.get("hunks"), list):
        return None
    return note


def merged(old: dict[str, Any] | None, new: dict[str, Any]) -> dict[str, Any]:
    """A note written again for the same commit (a second session, the same landing twice):
    the new one's sessions replace the old one's with the same task, the rest stay."""
    if not old:
        return new
    keep = {s.get("task") for s in new["sessions"]}
    sessions, moved = [], {}
    for i, s in enumerate(old["sessions"]):
        if isinstance(s, dict) and s.get("task") not in keep:
            moved[i] = len(sessions)
            sessions.append(s)
    hunks = [
        {**h, "s": moved[h.get("s")]}
        for h in old["hunks"]
        if isinstance(h, dict) and h.get("s") in moved
    ]
    shift = len(sessions)
    sessions += new["sessions"]
    hunks += [{**h, "s": h["s"] + shift} for h in new["hunks"]]
    return {"eden_provenance": NOTE_FORMAT, "sessions": sessions, "hunks": hunks[:MAX_HUNKS]}


def write_note(top: Path, commit: str, note: dict[str, Any]) -> str:
    """The note on the commit (merged with one already there). "" when done, else why not.
    git notes never runs the repository's hooks, and never touches the commit itself."""
    note = merged(read_note(top, commit), note)
    text = json.dumps(note, ensure_ascii=False, indent=1) + "\n"
    done = git(top, "notes", "--ref", NOTES_REF, "add", "-f", "-F", "-", commit, input=text)
    return "" if done.ok else (done.err or done.out).strip()[:300]


def annotate(top: Path, commits: list[str], owners: list[Owner]) -> int:
    """(In a thread.) A note on each of the commits a session wrote some of. Returns how
    many were noted."""
    count = 0
    for commit in commits[-MAX_COMMITS:]:
        note = note_for(commit_files(top, commit), owners)
        if note is None:
            continue
        problem = write_note(top, commit, note)
        if problem:
            log.info("provenance note on %s not written: %s", commit[:10], problem)
        else:
            count += 1
    return count


def rev(top: Path, name: str) -> str:
    found = git(top, "rev-parse", "-q", "--verify", f"{name}^{{commit}}")
    return found.out.strip() if found.ok else ""


def commits_between(top: Path, tip: str, since: str) -> list[str]:
    """The commits reachable from tip and not from since, oldest first."""
    args = ["rev-list", "--reverse", f"--max-count={MAX_COMMITS}", tip]
    if since:
        args += ["--not", since]
    found = git(top, *args, timeout=60)
    return [c for c in found.out.split() if c] if found.ok else []


# ── blame ──


def blame(top: Path, rel: str) -> list[tuple[str, int, int, str]]:
    """git blame of the working file: (commit, its line in that commit, the line now, the
    path in that commit) for each line. Lines not committed yet come back with zeros."""
    found = git(top, "blame", "--porcelain", "--", rel, timeout=60)
    if not found.ok:
        return []
    rows: list[tuple[str, int, int, str]] = []
    names: dict[str, str] = {}
    pending: tuple[str, int, int] | None = None
    for line in found.out.splitlines():
        if line.startswith("\t"):
            if pending is not None:
                sha, orig, final = pending
                rows.append((sha, orig, final, names.get(sha, rel)))
                pending = None
            continue
        parts = line.split(" ")
        if len(parts) >= 3 and len(parts[0]) == 40 and parts[1].isdigit() and parts[2].isdigit():
            pending = (parts[0], int(parts[1]), int(parts[2]))
            if len(rows) > BLAME_LINES:
                return []
        elif line.startswith("filename ") and pending is not None:
            names[pending[0]] = code_changes._unquote(line[9:])
    return rows


def notes_of(top: Path, commits: set[str]) -> dict[str, dict[str, Any]]:
    """The notes of these commits that have one, read in one go."""
    listed = git(top, "notes", "--ref", NOTES_REF, "list", timeout=60)
    if not listed.ok:
        return {}
    blobs: dict[str, str] = {}
    for line in listed.out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] in commits:
            blobs[parts[0]] = parts[1]
    if not blobs:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for blob, commit in blobs.items():
        shown = git(top, "cat-file", "blob", blob)
        note = parse_note(shown.out) if shown.ok else None
        if note is not None:
            out[commit] = note
    return out


def who_of(commit: str, note: dict[str, Any], hunk: dict[str, Any]) -> dict[str, Any]:
    s = note["sessions"][hunk["s"]] if 0 <= hunk.get("s", -1) < len(note["sessions"]) else {}
    turns = s.get("turns") or []
    t = turns[hunk["t"] - 1] if 0 < hunk.get("t", 0) <= len(turns) else {}
    return {
        "commit": commit[:10],
        "task": s.get("task", 0),
        "session": s.get("session", ""),
        "title": s.get("title", ""),
        "model": s.get("model", ""),
        "engine": (s.get("engine") or {}).get("eden", ""),
        "turn": t.get("n", 0),
        "summary": t.get("summary", ""),
        "digest": t.get("digest", ""),
        "at": t.get("at", ""),
        "receipt": t.get("receipt", 0),
    }


def overlay(top: Path, rel: str) -> tuple[list[list[int]], list[dict[str, Any]]]:
    """(In a thread.) The file's lines Eden's sessions wrote, as [first, last, who] spans
    (who: an index into the list that follows), from git blame and the commits' notes."""
    rows = blame(top, rel)
    notes = notes_of(top, {sha for sha, *_ in rows if sha != _ZEROS})
    if not notes:
        return [], []
    # Each note's hunks by path, for the lookups below.
    lookup: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for commit, note in notes.items():
        for h in note["hunks"]:
            if isinstance(h, dict) and isinstance(h.get("lines"), list):
                lookup.setdefault((commit, str(h.get("path"))), []).append(h)
    whos: list[dict[str, Any]] = []
    seen: dict[tuple[str, int], int] = {}
    spans: list[list[int]] = []
    for sha, orig, final, path in rows:
        found = None
        for h in lookup.get((sha, path)) or []:
            if any(a <= orig <= b for a, b in h["lines"]):
                found = h
                break
        if found is None:
            continue
        key = (sha, id(found))
        if key not in seen:
            seen[key] = len(whos)
            whos.append(who_of(sha, notes[sha], found))
        w = seen[key]
        if spans and spans[-1][2] == w and spans[-1][1] == final - 1:
            spans[-1][1] = final
        else:
            spans.append([final, final, w])
    return spans, whos


# ── pull requests ──


def pr_section(top: Path, fork: str, head: str = "HEAD") -> str:
    """(In a thread.) The "Provenance" section of a pull request's description: each
    session and turn whose work is on the branch, from the notes of its commits."""
    commits = commits_between(top, head, fork) if fork else []
    notes = notes_of(top, set(commits))
    if not notes:
        return ""
    lines: dict[tuple[int, int], int] = {}
    rows: dict[tuple[int, int], dict[str, Any]] = {}
    for commit in commits:
        note = notes.get(commit)
        if note is None:
            continue
        for h in note["hunks"]:
            w = who_of(commit, note, h)
            key = (w["task"], w["turn"])
            rows.setdefault(key, w)
            lines[key] = lines.get(key, 0) + sum(b - a + 1 for a, b in h.get("lines") or [])
    out = [
        PR_MARK,
        "### Provenance",
        "Which Eden Code session and prompt wrote the changes here (from the commits' git "
        f"notes, `{NOTES_REF}`).",
    ]
    for key in list(rows)[:PR_TURNS]:
        w = rows[key]
        who = f"“{w['title']}”" if w["title"] else f"Session {w['task']}"
        bits = [who]
        if w["model"]:
            bits.append(w["model"])
        if w["turn"]:
            said = f"turn {w['turn']}" + (f": “{w['summary']}”" if w["summary"] else "")
            bits.append(said + (f" (`{w['digest']}`)" if w["digest"] else ""))
        n = lines[key]
        bits.append(f"{n} line{'s' if n != 1 else ''}")
        out.append("- " + " · ".join(bits))
    if len(rows) > PR_TURNS:
        out.append(f"- and {len(rows) - PR_TURNS} more")
    return "\n".join(out)


# ── the desk ──


class Provenance:
    def __init__(self, hub: Any) -> None:
        self.hub = hub

    def enabled(self) -> bool:
        try:
            return bool(self.hub.prefs.feature(PREF))
        except Exception:
            return True

    def pr_enabled(self) -> bool:
        try:
            return self.enabled() and bool(self.hub.prefs.feature(PREF_PR))
        except Exception:
            return False

    def tasks(self) -> list[Any]:
        return list(getattr(self.hub.tasks, "tasks", {}).values())

    async def committed(self, top: Path, tasks: list[Any] | None = None) -> int:
        """Eden just committed in top (the Git panel, a pull request's commit): its HEAD
        noted with what the sessions there wrote of it. Never raises."""
        if not self.enabled():
            return 0
        try:
            return await asyncio.to_thread(self._committed, Path(top), tasks)
        except Exception:
            log.exception("provenance note after a commit")
            return 0

    def _committed(self, top: Path, tasks: list[Any] | None) -> int:
        head = rev(top, "HEAD")
        owners = owners_for(self.tasks() if tasks is None else tasks, top)
        return annotate(top, [head], owners) if head and owners else 0

    def tip_of(self, copy: Any) -> str:
        """(In a thread.) Where the branch a copy lands in is now, before it lands."""
        return rev(Path(copy.repo), f"refs/heads/{copy.into}")

    async def landed(self, copy: Any, commit: str, before: str) -> int:
        """A copy just landed (code_isolation): every commit it brought (since where its
        branch was, before) noted, the sessions in it owning all of it. Never raises."""
        if not self.enabled() or not commit:
            return 0
        try:
            return await asyncio.to_thread(self._landed, copy, commit, before)
        except Exception:
            log.exception("provenance notes after a landing")
            return 0

    def _landed(self, copy: Any, commit: str, before: str) -> int:
        checkout = Path(copy.checkout)
        top = checkout if checkout.is_dir() else Path(copy.repo)
        owners = owners_for(self.tasks(), checkout) if checkout.is_dir() else []
        if not owners:
            return 0
        commits = commits_between(top, commit, before or copy.base)
        return annotate(top, commits, owners)

    def pr_body(self, top: Path, fork: str, body: str) -> str:
        """(In a thread.) The pull request's description with the Provenance section, when
        the owner turned it on, once."""
        if not self.pr_enabled() or PR_MARK in body:
            return body
        try:
            section = pr_section(Path(top), fork)
        except Exception:
            log.exception("provenance section for a pull request")
            return body
        return f"{body}\n\n{section}".strip() if section else body

    # ── window commands ──

    def _folder(self, msg: dict[str, Any]) -> tuple[Path, str] | None:
        """The folder a command is about, as the Files pane names it (code_workspace's
        folder_of: the session's, its own copy when it has one, or a project), and the key
        the window knows it by."""
        from .code_workspace import folder_of, session_of

        try:
            folder = folder_of(self.hub, msg)
        except (ValueError, OSError):
            return None
        task = session_of(self.hub, msg)
        key = f"id:{task.id}" if task is not None else f"dir:{msg.get('directory') or ''}"
        return Path(folder), key

    def cmd_blame(self, msg: dict[str, Any]) -> None:
        self.hub._spawn(self.send_blame(msg))

    async def send_blame(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        where = self._folder(msg)
        rel = str(msg.get("path") or "")
        if where is None or not rel:
            return None
        folder, key = where
        event: dict[str, Any] = {
            "key": key, "path": rel, "ref": str(msg.get("ref") or "")[:2000],
            "spans": [], "who": [], "note": "",
        }  # fmt: skip
        if not self.enabled():
            event["note"] = "Provenance is off in Settings."
        else:
            found = await asyncio.to_thread(self._blame, folder, rel)
            if isinstance(found, str):
                event["note"] = found
            else:
                event["spans"], event["who"] = found
        self.hub.emit("code_provenance_blame", **event)
        return event

    @staticmethod
    def _blame(folder: Path, rel: str) -> tuple[list[list[int]], list[dict[str, Any]]] | str:
        repo = code_changes.repo_of(folder)
        if repo is None:
            return "This folder isn't a git repository."
        try:
            target = (folder / rel).resolve()
            inside = target.relative_to(repo.top.resolve()).as_posix()
        except (OSError, ValueError):
            return "That file isn't in this repository."
        if code_changes.is_sensitive(target):
            return ""
        return overlay(repo.top, inside)

    def cmd_hunks(self, msg: dict[str, Any]) -> None:
        self.hub._spawn(self.send_hunks(msg))

    async def send_hunks(self, msg: dict[str, Any]) -> dict[str, Any] | None:
        """The Changes pane's hunks (not committed yet), each with the turn that wrote it,
        from the session's live marks."""
        task = self.hub.tasks.tasks.get(_msg_int(msg, "id"))
        if task is None or task.kind != "code":
            return None
        view = str(msg.get("view") or "session")
        if view not in ("turn", "session", "branch"):
            view = "session"
        hunks: dict[str, dict[str, Any]] = {}
        if self.enabled():
            hunks = await asyncio.to_thread(self._hunks, task, view)
        event = {"id": task.id, "view": view, "hunks": hunks}
        self.hub.emit("code_provenance_hunks", **event)
        return event

    @staticmethod
    def _hunks(task: Any, view: str) -> dict[str, dict[str, Any]]:
        found = code_changes.task_view(task, view)
        if found is None:
            return {}
        owner = Owner(task, found.repo.top, bool(getattr(task, "workspace", None)))
        turns = turns_of(task)
        session = session_of(task)
        out: dict[str, dict[str, Any]] = {}
        for f in found.files:
            for h in f.hunks:
                uid = owner.turn(f, h)
                if uid is None:
                    continue
                t = turns.get(uid) or {}
                out[h.id] = {
                    "task": session["task"],
                    "title": session["title"],
                    "model": session["model"],
                    "turn": t.get("n", 0),
                    "summary": t.get("summary", ""),
                    "digest": t.get("digest", ""),
                    "at": t.get("at", ""),
                    "receipt": t.get("receipt", 0),
                }
        return out


def install(hub: Any) -> None:
    desk = Provenance(hub)
    hub.code_provenance = desk  # (for code_git, code_isolation, code_pr and the tests)
    hub.register_command("code_provenance_blame", desk.cmd_blame, slow=True)
    hub.register_command("code_provenance_hunks", desk.cmd_hunks, slow=True)
