"""The second brain's newer sources, and the rebuild's finishing step (for brain_build).

- conversations: what the owner and JARVIS said to each other, from Claude Code's own
  records of the brain's sessions (the SDK's session listing for its working folder, as
  Jarvis Code reads its history) and the conversations saved to Documents › Jarvis ›
  Conversations. Only the two sides' words: no tool results, none of the app's notes.
- images: the text in screenshots and images in the folders the brain reads (ocr.py).
- safari: Safari's bookmarks and Reading List (Bookmarks.plist, behind Full Disk Access).
- bookmarks: Chrome, Arc, Brave and Edge bookmarks (their own JSON files).
- reminders: Apple Reminders, read only (reminders_kit, EventKit).
- voicememos: Voice Memos, transcribed on this Mac by JARVIS's Whisper model, a few a
  rebuild, each transcript cached by the recording's hash.
- journal: JARVIS's daily notes, Documents › Jarvis › Journal (jarvis.journal writes them).
- browsing: pages the owner read in the built-in browser, kept as text beside the index
  (jarvis.features.browser_ai.memories; its switch is in Settings › Browser).

Each is a switch under Second brain (jarvis.features.brain keeps them, SWITCHES); the app
passes them, and search by meaning's, to the rebuild as args["more"]. Everything is read in
the rebuild's own low-priority process, within the share of time every source has
(knowledge.SOURCE_SECONDS), and what's kept has passwords, keys and card numbers blanked out
like every other source. Nothing here calls Claude or goes online.
"""

from __future__ import annotations

import json
import logging
import os
import plistlib
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import wave
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .knowledge import Note, collect_folder

log = logging.getLogger("jarvis")

HOME = Path.home()

# source -> (its setting in prefs.features, on by default?)
SWITCHES: dict[str, tuple[str, bool]] = {
    "conversations": ("brain_conversations", True),
    "images": ("brain_images", True),
    "safari": ("brain_safari", False),
    "bookmarks": ("brain_bookmarks", False),
    "reminders": ("brain_reminders", False),
    "voicememos": ("brain_voicememos", False),
    "journal": ("brain_journal", True),
    "browsing": ("browser_memories", False),
}
SEMANTIC = ("brain_semantic", False)  # search by meaning: may download Apple's model files
VECTORS = "vectors"  # rebuild_brain(only={VECTORS}): re-read nothing, make vectors
FULL_DISK_ACCESS = (
    "{what} need Full Disk Access: System Settings > Privacy & Security > Full Disk Access, "
    "then turn on J.A.R.V.I.S. and restart it."
)
MAX_BOOKMARKS = 5000  # per browser


def _web_url(url: str) -> bool:
    return bool(re.match(r"https?://[^\s]+$", url, re.IGNORECASE)) and len(url) <= 4000


def _iso(moment: datetime | None) -> str:
    return moment.isoformat(timespec="seconds") if moment else ""


# ── conversations ──


def workspace() -> Path:
    """The brain's working folder (brain._workspace, without making it)."""
    from .prefs import APP_SUPPORT

    return APP_SUPPORT / "workspace"


CONVERSATIONS_DIR = HOME / "Documents" / "Jarvis" / "Conversations"
MAX_SESSIONS = 300
MAX_SESSION_BYTES = 300 * 1024 * 1024  # of records read in one rebuild, newest first
PART_CHARS = 10_000  # a conversation is kept in parts read_note returns whole (12,000)
# Sessions in the brain's folder that aren't conversations with the owner: a meeting's
# write-up (meeting.SUMMARY_PROMPT) and a reply drafted for someone else (delegate's
# conversation_text). test_brain_sources checks these still match what those send.
ONE_OFF = (
    "Below is a machine transcript of a meeting",
    "The conversation so far, oldest first.",
    "Nothing has been said yet. Write the opening message",
)
_ASIDES = re.compile(r"<(system-reminder|preview-annotation-context)>.*?</\1>\s*", re.S)
_APP_NOTE = re.compile(r"^\[Note from the app:.*?\]\n\n", re.S)
_NOT_SAID = (
    "<task-notification>",
    "[Request interrupted",
    "This session is being continued from a previous conversation",
    "<command-name>",
    "<local-command",
)


def _said(content: Any) -> str:
    """The words in a message's content: its text blocks (not tools, pictures or thinking)."""
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text") or ""))
    return "\n".join(parts)


def _owner_words(text: str) -> str:
    """What the owner said: without the app's notes and reminders, and nothing for the
    conversation's own bookkeeping (a background task's report, an interruption)."""
    text = _ASIDES.sub("", text).strip()
    if text.startswith(_NOT_SAID):
        return ""
    return _APP_NOTE.sub("", text, count=1).strip()


def conversation_lines(messages: list[Any]) -> list[str]:
    lines = []
    for message in messages:
        body = message.message if isinstance(message.message, dict) else {}
        text = _said(body.get("content")).strip()
        if message.type == "user":
            text = _owner_words(text)
            if text:
                lines.append(f"You: {text}")
        elif text:
            lines.append(f"Jarvis: {text}")
    return lines


def _parts(lines: list[str], size: int = PART_CHARS) -> list[list[str]]:
    parts: list[list[str]] = [[]]
    length = 0
    for line in lines:
        line = line[:size]
        if parts[-1] and length + len(line) > size:
            parts.append([])
            length = 0
        parts[-1].append(line)
        length += len(line) + 2
    return [p for p in parts if p]


def collect_conversations(
    folder: Path | None = None,
    saved: Path | None = None,
    *,
    list_sessions: Callable[..., list[Any]] | None = None,
    get_messages: Callable[..., list[Any]] | None = None,
) -> list[Note]:
    """JARVIS's conversations with the owner: one note per part of each session (newest
    MAX_SESSIONS), plus the conversations saved as Markdown."""
    if list_sessions is None or get_messages is None:
        from claude_agent_sdk import get_session_messages
        from claude_agent_sdk import list_sessions as sdk_list

        list_sessions = list_sessions or sdk_list
        get_messages = get_messages or get_session_messages
    folder = folder or workspace()
    notes: list[Note] = []
    if folder.is_dir():
        read = 0
        for info in list_sessions(
            directory=str(folder), limit=MAX_SESSIONS, include_worktrees=False
        ):
            read += int(getattr(info, "file_size", 0) or 0)
            if read > MAX_SESSION_BYTES:
                break
            try:
                messages = get_messages(info.session_id, directory=str(folder))
            except Exception:  # an unreadable record: the others still count
                log.info("second brain: a conversation record couldn't be read")
                continue
            notes += _session_notes(info, messages)
    notes += collect_folder(saved or CONVERSATIONS_DIR, source="conversations")
    return notes


def _session_notes(info: Any, messages: list[Any]) -> list[Note]:
    lines = conversation_lines(messages)
    first = next((line[5:] for line in lines if line.startswith("You: ")), "")
    replied = any(line.startswith("Jarvis: ") for line in lines)
    if not first or first.startswith(ONE_OFF) or not replied:
        return []
    when = datetime.fromtimestamp((getattr(info, "last_modified", 0) or 0) / 1000)
    title = (getattr(info, "custom_title", None) or first).strip().splitlines()[0][:100]
    parts = _parts(lines)
    notes = []
    for n, part in enumerate(parts, 1):
        opener = next((line[5:] for line in part if line.startswith("You: ")), part[0])
        notes.append(
            Note(
                id=f"conversation:{info.session_id}:{n}",
                source="conversations",
                title=(opener.splitlines()[0] if len(parts) > 1 else title)[:100],
                text=f"A conversation with Jarvis, {when:%A %d %B %Y}.\n\n" + "\n\n".join(part),
                ref=str(info.session_id),
                group=title[:60],
                modified=_iso(when),
            )
        )
    return notes


# ── Safari ──

SAFARI_BOOKMARKS = HOME / "Library" / "Safari" / "Bookmarks.plist"
_SAFARI_FOLDERS = {
    "BookmarksBar": "Favourites",
    "BookmarksMenu": "Bookmarks Menu",
    "com.apple.ReadingList": "Reading List",
}


def collect_safari(path: Path | None = None) -> list[Note]:
    """Safari's bookmarks and Reading List, one note each."""
    path = path or SAFARI_BOOKMARKS
    try:
        with open(path, "rb") as fh:
            data = plistlib.load(fh)
    except FileNotFoundError:
        return []  # Safari has never kept a bookmark here
    except PermissionError as exc:
        raise PermissionError(FULL_DISK_ACCESS.format(what="Safari bookmarks")) from exc
    except (plistlib.InvalidFileException, ValueError, OSError) as exc:
        raise RuntimeError(f"Safari's bookmarks can't be read ({type(exc).__name__})") from exc
    found: list[tuple[dict[str, Any], list[str]]] = []
    _safari_walk(data, [], found, 0)
    notes, seen = [], set()
    for item, trail in found:
        url = str(item.get("URLString") or "")
        uri = item.get("URIDictionary") if isinstance(item.get("URIDictionary"), dict) else {}
        title = str(uri.get("title") or item.get("Title") or url).strip() or url
        reading = item.get("ReadingList") if isinstance(item.get("ReadingList"), dict) else None
        key = str(item.get("WebBookmarkUUID") or url)
        if key in seen:
            continue
        seen.add(key)
        where = " › ".join(trail)
        text = f"{title}\n{url}\nSaved in Safari{': ' + where if where else ''}."
        added = ""
        if reading is not None:
            preview = str(reading.get("PreviewText") or "").strip()
            if preview:
                text += f"\n{preview[:2000]}"
            when = reading.get("DateAdded")
            if isinstance(when, datetime):  # plistlib's are UTC, naive or not
                utc = when if when.tzinfo else when.replace(tzinfo=UTC)
                added = _local(utc.timestamp())
        notes.append(
            Note(
                id=f"safari:{key}",
                source="safari",
                title=title[:140],
                text=text,
                ref=url,
                group=trail[0] if trail else "Safari",
                modified=added,
            )
        )
    return notes


def _safari_walk(node: Any, trail: list[str], out: list, depth: int) -> None:
    if depth > 40 or len(out) >= MAX_BOOKMARKS or not isinstance(node, dict):
        return
    kind = node.get("WebBookmarkType")
    if kind == "WebBookmarkTypeLeaf":
        if _web_url(str(node.get("URLString") or "")):
            out.append((node, trail))
        return
    if kind == "WebBookmarkTypeProxy":
        return  # History: not a bookmark
    title = str(node.get("Title") or "")
    inner = trail + [_SAFARI_FOLDERS.get(title, title)] if title and depth else trail
    children = node.get("Children")
    if isinstance(children, list):
        for child in children:
            _safari_walk(child, inner, out, depth + 1)


# ── Chrome, Arc, Brave and Edge ──

SUPPORT = HOME / "Library" / "Application Support"
CHROMIUM = {
    "Chrome": SUPPORT / "Google" / "Chrome",
    "Brave": SUPPORT / "BraveSoftware" / "Brave-Browser",
    "Edge": SUPPORT / "Microsoft Edge",
    "Arc": SUPPORT / "Arc" / "User Data",
}
ARC_SIDEBAR = SUPPORT / "Arc" / "StorableSidebar.json"
MAX_JSON_BYTES = 60 * 1024 * 1024
CHROME_EPOCH_SECONDS = 11_644_473_600  # 1601-01-01 to 1970-01-01


def collect_bookmarks(
    browsers: dict[str, Path] | None = None, arc_sidebar: Path | None = None
) -> list[Note]:
    """Every profile's bookmarks in Chrome, Brave and Edge, and Arc's (its sidebar's saved
    tabs and any Chromium bookmarks it keeps), one note each."""
    browsers = CHROMIUM if browsers is None else browsers
    arc_sidebar = ARC_SIDEBAR if arc_sidebar is None else arc_sidebar
    notes: list[Note] = []
    problems: list[str] = []
    for name, root in browsers.items():
        found: list[tuple[str, str, list[str], str, str]] = []
        for file in _profiles(root):
            try:
                data = _read_json(file)
            except (OSError, ValueError) as exc:
                problems.append(f"{name} ({type(exc).__name__})")
                continue
            roots = data.get("roots") if isinstance(data, dict) else None
            if isinstance(roots, dict):
                for top in roots.values():
                    _chromium_walk(top, [], found, 0)
        if name == "Arc" and arc_sidebar.is_file():
            try:
                _arc_walk(_read_json(arc_sidebar), found, 0)
            except (OSError, ValueError) as exc:
                problems.append(f"Arc ({type(exc).__name__})")
        notes += _bookmark_notes(name, found)
    if problems and not notes:
        raise RuntimeError("Couldn't read the bookmarks of " + ", ".join(problems))
    return notes


def _profiles(root: Path) -> list[Path]:
    try:
        return sorted(p / "Bookmarks" for p in root.iterdir() if (p / "Bookmarks").is_file())
    except OSError:
        return []


def _read_json(path: Path) -> Any:
    if path.stat().st_size > MAX_JSON_BYTES:
        raise ValueError("too big")
    return json.loads(path.read_bytes())


def _chromium_walk(node: Any, trail: list[str], out: list, depth: int) -> None:
    if depth > 40 or len(out) >= MAX_BOOKMARKS or not isinstance(node, dict):
        return
    if node.get("type") == "url":
        url = str(node.get("url") or "")
        if _web_url(url):
            added = _chrome_time(node.get("date_added"))
            out.append(
                (str(node.get("name") or url), url, trail, added, str(node.get("guid") or url))
            )
        return
    name = str(node.get("name") or "")
    inner = trail + [name] if name and depth else trail
    for child in node.get("children") or []:
        _chromium_walk(child, inner, out, depth + 1)


def _chrome_time(value: Any) -> str:
    """Chromium's times: microseconds since 1601 (UTC), as a string; local time out."""
    try:
        micros = int(str(value))
    except (TypeError, ValueError):
        return ""
    return _local(micros / 1e6 - CHROME_EPOCH_SECONDS) if micros > 0 else ""


def _local(unix: float) -> str:
    try:
        return _iso(datetime.fromtimestamp(unix))
    except (OverflowError, OSError, ValueError):
        return ""


def _arc_walk(node: Any, out: list, depth: int) -> None:
    """Arc's sidebar, whatever its shape this version: every saved tab (savedURL)."""
    if depth > 60 or len(out) >= MAX_BOOKMARKS:
        return
    if isinstance(node, dict):
        url = node.get("savedURL")
        if isinstance(url, str) and _web_url(url):
            title = str(node.get("savedTitle") or url)
            out.append((title, url, ["Sidebar"], "", url))
            return
        for value in node.values():
            _arc_walk(value, out, depth + 1)
    elif isinstance(node, list):
        for value in node:
            _arc_walk(value, out, depth + 1)


def _bookmark_notes(browser: str, found: list[tuple[str, str, list[str], str, str]]) -> list[Note]:
    notes, seen = [], set()
    for title, url, trail, added, key in found:
        if url in seen:
            continue
        seen.add(url)
        where = " › ".join(t for t in trail if t)
        notes.append(
            Note(
                id=f"bookmark:{browser}:{key}",
                source="bookmarks",
                title=(title.strip() or url)[:140],
                text=f"{title.strip() or url}\n{url}\nBookmarked in {browser}"
                + (f": {where}." if where else "."),
                ref=url,
                group=browser,
                modified=added,
            )
        )
    return notes


# ── Reminders ──


def collect_reminders(run: Callable[[], dict[str, Any]] | None = None) -> list[Note]:
    """Open reminders and the ones done in the last month (reminders_kit), one note each."""
    from .reminders_kit import NO_ACCESS

    found = (run or _reminders_helper)()
    if "error" in found:
        error = str(found["error"])
        raise (PermissionError if error == NO_ACCESS else RuntimeError)(error)
    notes = []
    for r in found.get("reminders") or []:
        if not isinstance(r, dict) or not r.get("title"):
            continue
        title = str(r["title"]).strip()
        lines = [f"Reminder: {title}" + (f" (in {r['list']})" if r.get("list") else "")]
        if r.get("due"):
            lines.append(f"Due {r['due']}.")
        if r.get("completed"):
            lines.append(f"Done {r.get('completed_at') or ''}".strip() + ".")
        if r.get("notes"):
            lines.append(str(r["notes"]))
        if r.get("url") and _web_url(str(r["url"])):
            lines.append(str(r["url"]))
        notes.append(
            Note(
                id=f"reminder:{r.get('id') or title}",
                source="reminders",
                title=title[:140],
                text="\n".join(lines),
                ref=str(r.get("id") or ""),
                group=str(r.get("list") or "Reminders")[:60],
                modified=str(r.get("due") or r.get("modified") or r.get("created") or ""),
            )
        )
    return notes


def _reminders_helper() -> dict[str, Any]:
    try:
        run = subprocess.run(
            [sys.executable, "-m", "jarvis.reminders_kit", "list"],
            capture_output=True,
            text=True,
            timeout=150,
        )
        return json.loads(run.stdout.strip().splitlines()[-1])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return {"error": "Reminders didn't answer."}


# ── Voice Memos ──

VOICE_MEMOS = [
    HOME / "Library" / "Group Containers" / "group.com.apple.VoiceMemos.shared" / "Recordings",
    HOME / "Library" / "Application Support" / "com.apple.voicememos" / "Recordings",
]
MEMO_SUFFIXES = {".m4a", ".qta", ".caf", ".wav", ".mp3", ".aac", ".aiff"}
MAX_MEMOS = 500
TRANSCRIBE_PER_BUILD = 8
TRANSCRIBE_SECONDS = 200.0  # all sources share five minutes of a rebuild
MEMO_MINUTES = 30  # of a recording transcribed
MEMO_LONGEST = 3 * 3600  # seconds: a recording longer than this isn't decoded here at all
APPLE_EPOCH_SECONDS = 978_307_200  # 1970-01-01 to 2001-01-01

Transcribe = Callable[[Path], str]  # a recording's words ("" when nothing was said)


def collect_voice_memos(
    cache_path: Path,
    make_transcriber: Callable[[], Transcribe],
    folders: list[Path] | None = None,
    *,
    limit: int = TRANSCRIBE_PER_BUILD,
    seconds: float = TRANSCRIBE_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> list[Note]:
    """Voice Memos with their transcripts: those transcribed already, and up to `limit` new
    ones (newest first) in at most `seconds`. The rest wait for the next rebuild."""
    from .fileindex import redact
    from .ocr import TextCache, content_key

    folder = next((f for f in folders or VOICE_MEMOS if _exists(f)), None)
    if folder is None:
        return []
    try:
        names = [e for e in os.scandir(folder) if e.is_file(follow_symlinks=False)]
    except PermissionError as exc:
        raise PermissionError(FULL_DISK_ACCESS.format(what="Voice Memos")) from exc
    except OSError as exc:
        raise RuntimeError(f"Voice Memos can't be read ({type(exc).__name__})") from exc
    memos = []
    for entry in names:
        if os.path.splitext(entry.name)[1].lower() in MEMO_SUFFIXES:
            try:
                memos.append((entry, entry.stat(follow_symlinks=False)))
            except OSError:
                continue
    memos.sort(key=lambda m: m[1].st_mtime, reverse=True)
    titles = _memo_titles(folder)
    cache = TextCache(cache_path)
    transcribe: Transcribe | None = None
    notes: list[Note] = []
    started, done = clock(), 0
    try:
        for entry, info in memos[:MAX_MEMOS]:
            path = Path(entry.path)
            key = cache.key_for(str(path), info.st_size, info.st_mtime)
            text = cache.text(key) if key else None
            if text is None:
                if done >= limit or clock() - started > seconds:
                    continue  # the next rebuild transcribes it
                try:
                    key = key or content_key(path, limit=64 * 1024 * 1024)
                except OSError:
                    continue
                cache.remember(str(path), info.st_size, info.st_mtime, key)
                text = cache.text(key)
                if text is None:
                    # No model: the whole source says so (and keeps its last copy).
                    transcribe = transcribe or make_transcriber()
                    try:
                        text = redact(transcribe(path).strip())
                    except (OSError, subprocess.SubprocessError, ValueError, EOFError):
                        text = ""  # a recording this Mac can't decode: not tried again
                    done += 1
                    cache.store(key, text)
                    cache.commit()
            if text:
                notes.append(_memo_note(path, info, titles.get(entry.name), text))
    finally:
        cache.close()
    return notes


def _exists(path: Path) -> bool:
    try:
        return path.is_dir()
    except OSError:
        return False


def _memo_titles(folder: Path) -> dict[str, tuple[str, datetime | None]]:
    """File name -> (title, recorded) from Voice Memos' own database, when it can be read."""
    db = folder / "CloudRecordings.db"
    if not db.is_file():
        return {}
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(ZCLOUDRECORDING)")}
            title = next(
                (c for c in ("ZENCRYPTEDTITLE", "ZCUSTOMLABEL", "ZLABEL") if c in cols), None
            )
            if "ZPATH" not in cols or title is None:
                return {}
            date = "ZDATE" if "ZDATE" in cols else "NULL"
            rows = conn.execute(f"SELECT ZPATH, {title}, {date} FROM ZCLOUDRECORDING").fetchall()
        finally:
            conn.close()
    except sqlite3.DatabaseError:
        return {}
    out = {}
    for path, name, stamp in rows:
        if not path:
            continue
        recorded = None
        if isinstance(stamp, int | float):
            try:
                recorded = datetime.fromtimestamp(float(stamp) + APPLE_EPOCH_SECONDS)
            except (OverflowError, OSError, ValueError):
                recorded = None
        out[Path(str(path)).name] = (str(name or "").strip(), recorded)
    return out


def _memo_note(path: Path, info: os.stat_result, known: Any, text: str) -> Note:
    title, recorded = known if known else ("", None)
    recorded = recorded or datetime.fromtimestamp(info.st_mtime)
    title = title or f"Voice memo, {recorded:%d %b %Y}"
    return Note(
        id=f"memo:{path.name}",
        source="voicememos",
        title=title[:140],
        text=f"Voice memo “{title}”, recorded {recorded:%A %d %B %Y %H:%M}.\n\n{text}",
        ref=str(path),
        group=f"{recorded:%B %Y}",
        modified=_iso(recorded),
    )


def whisper_transcriber(model_name: str, language: str) -> Transcribe:
    """JARVIS's own Whisper model (faster-whisper), only as it's already on this Mac: the
    rebuild never downloads one. A recording's sound is made 16 kHz mono by afconvert."""
    from faster_whisper import WhisperModel

    from . import lang

    try:
        model = WhisperModel(
            model_name, device="cpu", compute_type="int8", cpu_threads=4, local_files_only=True
        )
    except Exception as exc:
        raise RuntimeError(
            "Jarvis's speech model isn't on this Mac yet: talk to Jarvis once so it's set up, "
            "then Voice Memos can be transcribed."
        ) from exc
    options = lang.transcribe_options(language)
    options.pop("hotwords", None)

    def transcribe(path: Path) -> str:
        import numpy as np

        from .video import parse_afinfo

        info = subprocess.run(["afinfo", str(path)], capture_output=True, text=True, timeout=60)
        if parse_afinfo(info.stdout) > MEMO_LONGEST:
            return ""  # hours of sound: more than a background rebuild should decode
        with tempfile.TemporaryDirectory(prefix="jarvis-memo-") as tmp:
            wav = Path(tmp) / "memo.wav"
            subprocess.run(
                ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(path), str(wav)],
                check=True,
                capture_output=True,
                timeout=300,
            )
            with wave.open(str(wav), "rb") as w:
                frames = min(w.getnframes(), MEMO_MINUTES * 60 * w.getframerate())
                audio = np.frombuffer(w.readframes(frames), dtype="<i2").astype(np.float32) / 32768
        pieces, _info = model.transcribe(
            audio, beam_size=1, vad_filter=True, condition_on_previous_text=False, **options
        )
        return " ".join(p.text.strip() for p in pieces if p.text.strip())

    return transcribe


# ── what the rebuild calls (brain_build) ──


def extra_sources(args: dict[str, Any]) -> dict[str, Callable[[], list[Note]]]:
    """The newer sources that are switched on, for knowledge.Collector.run(extra=...)."""
    more = args.get("more") if isinstance(args.get("more"), dict) else {}
    store = Path(args["store"])
    sources: dict[str, Callable[[], list[Note]]] = {}
    if more.get("conversations"):
        sources["conversations"] = collect_conversations
    if more.get("images"):
        from .ocr import collect_images
        from .sources import COMPUTER_FOLDERS

        folders = [Path(f) for f in args.get("folders") or []]
        if args.get("computer"):
            folders = COMPUTER_FOLDERS + folders
        if folders:
            sources["images"] = lambda: collect_images(folders, store.with_name("images.db"))
    if more.get("safari"):
        sources["safari"] = collect_safari
    if more.get("bookmarks"):
        sources["bookmarks"] = collect_bookmarks
    if more.get("reminders"):
        sources["reminders"] = collect_reminders
    if more.get("journal"):
        from .journal import JOURNAL_DIR

        sources["journal"] = lambda: collect_folder(
            JOURNAL_DIR, source="journal", limit=400, newest_first=True
        )
    if more.get("voicememos"):
        whisper = more.get("whisper") if isinstance(more.get("whisper"), dict) else {}
        model = str(whisper.get("model") or "base.en")
        language = str(whisper.get("language") or "en")
        sources["voicememos"] = lambda: collect_voice_memos(
            store.with_name("voicememos.db"), lambda: whisper_transcriber(model, language)
        )
    if more.get("browsing"):
        from .features.browser_ai.memories import collect_browsing, folder_for

        sources["browsing"] = lambda: collect_browsing(folder_for(store))
    return sources


def finisher(args: dict[str, Any]) -> Callable[[Any, Callable[[str], None]], None] | None:
    """With search by meaning on: vectors for the new passages, then links by meaning."""
    more = args.get("more") if isinstance(args.get("more"), dict) else {}
    if not more.get("semantic"):
        return None

    def finish(kb: Any, progress: Callable[[str], None]) -> None:
        from . import embeddings, swift_helper

        def make() -> embeddings.Embedder | None:
            binary = swift_helper.ensure(embeddings.HELPER)
            return embeddings.HelperEmbedder(binary) if binary is not None else None

        progress("Search by meaning: finding what's new…")
        vectors, rows = embeddings.embed_index(
            kb.notes, kb.built_at, embeddings.vectors_path(kb.store), make, progress
        )
        links, with_vectors = embeddings.note_links(vectors, rows, len(kb.notes))
        if links:
            kb.edges = embeddings.merged_links(kb.edges, links, with_vectors)
            kb._galaxy = None

    return finish
