"""More from the Mac for the companion (the contract both apps follow, beside
companion_api's): what JARVIS remembers, goals, timers, Apple Reminders, markets,
background tasks, music, Shortcuts, the Mac's switches, the journal, meeting notes,
research reports, invoices and a few settings. Every route goes through remote.Gate as
companion_api's do: the phone's own token (401), its budget (429: lists are "read",
anything that changes or runs something on the Mac is "act") and a cap on the body (413).

A piece this Mac doesn't have answers 404 {"error": ...} (the phone hides it); /api/state
lists the groups it has under "features". Notes, meetings and reports are fetched by an id
from their own listing only: never a path. Settings are an allowlist of a few harmless
ones; nothing a key, a token, a folder or a security switch is ever read or set here."""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from . import lang
from .companion_api import _int

log = logging.getLogger("jarvis")

FEATURES = (
    "memory",
    "goals",
    "timers",
    "reminders",
    "markets",
    "tasks",
    "music",
    "shortcuts",
    "switches",
    "journal",
    "meetings",
    "research",
    "invoices",
    "prefs",
)
# The hub's piece each group needs ("" for one every Mac has).
NEEDS = {
    "memory": "memory",
    "goals": "goal_store",
    "timers": "automation_feature",
    "markets": "markets",
    "tasks": "background",
    "music": "music",
    "shortcuts": "shortcuts",
    "switches": "mac_switches",
    "journal": "memory_desk",
    "invoices": "invoicing",
}
LISTED = 50  # meetings, reports, tasks in one answer
PREVIEW = 240  # characters of a note's preview
TEXT_CHARS = 100_000  # a meeting's notes or a report, as the phone reads one
OUTPUT_CHARS = 2000
# Ids the phone sends back for a file: a listed file's own name, without folders.
_FILE_ID = re.compile(r"[^/\\\x00-\x1f\x7f]{1,200}")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
_STAMP = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2})(\d{2})(\d{2})?\b")
_DATE_LINE = re.compile(r"^[A-Z][a-z]+day \d{1,2} [A-Z][a-z]+ \d{4}(?:, \d{1,2}:\d{2})?$")

# Settings the phone may read and change, each with the JSON type it takes. Never a key, a
# token, a folder, a phone number or a switch that guards anything (control_always, pay_*,
# remote_enabled, code_* ...).
PREFS = {
    "language": str,
    "owner_name": str,
    "address": str,
    "persona": str,
    "humor": int,
    "voice_effect": bool,
    "hands_free": bool,
    "briefing_enabled": bool,
    "briefing_time": str,
    "proactive": bool,
    "proactive_voice": bool,
    "quiet_hours": str,
    "interruptions": str,
}
SETTABLE_SWITCHES = ("dark_mode", "bluetooth")  # Wi-Fi may be how the phone reaches the Mac
SWITCH_LABELS = {"dark_mode": "Dark mode", "wifi": "Wi-Fi", "bluetooth": "Bluetooth"}
MUSIC_ACTIONS = {
    "play": "play",
    "pause": "pause",
    "next": "next track",
    "previous": "previous track",
}
NOW_PLAYING_SCRIPT = """tell application "{player}"
    if player state is stopped then return "stopped"
    set s to (player state as text)
    try
        return s & tab & (name of current track) & tab & (artist of current track) & tab & (album of current track)
    on error
        return s
    end try
end tell"""


def features(hub: Any) -> list[str]:
    """The groups of /api/... this Mac answers, for /api/state."""
    return [f for f in FEATURES if not NEEDS.get(f) or getattr(hub, NEEDS[f], None) is not None]


def _bad(what: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": what}, status_code=status)


def _missing() -> JSONResponse:
    return _bad("This Mac doesn't have that.", 404)


def _line(text: Any, limit: int) -> str:
    return " ".join(str(text or "").split())[:limit]


def _stamp(epoch: float) -> str:
    return datetime.fromtimestamp(epoch).isoformat(timespec="seconds")


def _preview(text: str) -> str:
    """A note's first words that aren't its title, date line or a heading."""
    kept = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or _DATE_LINE.match(line):
            continue
        if line.startswith("_") and line.endswith("_"):  # a note's own italic aside
            continue
        kept.append(line.lstrip("-*> ").strip())
        if sum(len(k) for k in kept) > PREVIEW:
            break
    return _line(" ".join(kept), PREVIEW)


def _title(text: str, fallback: str) -> str:
    for line in text.splitlines()[:8]:
        if line.startswith("# "):
            return _line(line[2:], 200) or fallback
    return fallback


def notes_in(folder: Path, limit: int = LISTED) -> list[Path]:
    """The Markdown files directly in a folder, newest first (no links, no hidden ones)."""
    try:
        files = [
            p
            for p in folder.glob("*.md")
            if not p.name.startswith(".") and not p.is_symlink() and p.is_file()
        ]
        files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return []
    return files[:limit]


def note_by_id(folder: Path, wanted: Any) -> Path | None:
    """A listed note by its id (its file name without .md): exactly one of the folder's own
    Markdown files, or None. Never a path: no folders, no dots first, nothing resolved."""
    wanted = str(wanted or "")
    if not _FILE_ID.fullmatch(wanted) or wanted.startswith(".") or ".." in wanted:
        return None
    try:
        for path in folder.glob("*.md"):
            if path.stem == wanted and not path.is_symlink() and path.is_file():
                return path
    except OSError:
        return None
    return None


def note_date(path: Path) -> str:
    """When a note is from: its name's "YYYY-MM-DD HHMM", else when it was last changed."""
    m = _STAMP.match(path.stem)
    if m:
        try:
            return datetime.fromisoformat(
                f"{m.group(1)}T{m.group(2)}:{m.group(3)}:{m.group(4) or '00'}"
            ).isoformat(timespec="seconds")
        except ValueError:
            pass
    try:
        return _stamp(path.stat().st_mtime)
    except OSError:
        return ""


def list_notes(folder: Path) -> list[dict[str, Any]]:
    """Meeting notes or reports as the phone lists them. Blocking: run in a thread."""
    out = []
    for path in notes_in(folder):
        try:
            with path.open("rb") as handle:
                head = handle.read(8000).decode("utf-8", "replace")
        except OSError:
            continue
        out.append(
            {
                "id": path.stem,
                "title": _title(head, path.stem),
                "date": note_date(path),
                "preview": _preview(head),
            }
        )
    return out


def read_note(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("rb") as handle:
            text = handle.read(TEXT_CHARS * 4).decode("utf-8", "replace")[:TEXT_CHARS]
    except OSError:
        return None
    return {
        "id": path.stem,
        "title": _title(text, path.stem),
        "date": note_date(path),
        "text": text,
    }


def public_fact(fact: Any) -> dict[str, Any]:
    return {
        "id": fact.id,
        "text": fact.text,
        "kind": fact.category,
        "created": fact.learned or fact.at,
        "updated": fact.at,
        "expires": fact.expires or None,
        "confidence": fact.confidence,
    }


def public_reminder(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(row.get("id") or ""),
        "title": _line(row.get("title"), 200),
        "list": _line(row.get("list"), 80),
        "due": row.get("due") or None,
        "priority": row.get("priority") or 0,
        "notes": str(row.get("notes") or "")[:500],
    }


def public_quote(q: dict[str, Any]) -> dict[str, Any]:
    return {
        "symbol": q.get("symbol"),
        "name": q.get("name"),
        "price": q.get("last"),
        "change": q.get("change"),
        "change_pct": q.get("pct"),
        "status": q.get("status"),
    }


class More:
    def __init__(self, api: Any) -> None:
        self.api = api
        self.companion = api.companion
        self.hub = api.hub

    def _piece(self, name: str) -> Any:
        return getattr(self.hub, name, None)

    def _meetings(self) -> Path:
        from . import knowledge

        return Path(getattr(self.hub, "meetings_dir", None) or knowledge.MEETINGS_DIR)

    @staticmethod
    def _research() -> Path:
        from . import knowledge

        return Path(knowledge.RESEARCH_DIR)

    # ── memory ──

    def _changed_memory(self) -> None:
        desk = self._piece("memory_desk")
        if desk is not None:
            desk.changed()
        else:
            self.hub._memory_changed()

    async def memory(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        from .memory import expired

        store = self.hub.memory
        query = _line(request.query_params.get("q"), 200)
        found = (
            store.search(query) if query else [f for f in reversed(store.facts) if not expired(f)]
        )
        body: dict[str, Any] = {
            "items": [public_fact(f) for f in found],
            "people": [],
            "promises": [],
        }
        desk = self._piece("memory_desk")
        if desk is not None:
            from . import people

            promises = desk.promises
            body["people"] = people.known_people(
                store.facts, promises.items, desk.intents.items, self.hub.prefs.vips
            )
            body["promises"] = [
                {
                    "id": p["id"],
                    "text": p["text"],
                    "to": p["to"],
                    "due": p["due"] or None,
                    "status": p["status"],
                    "made": p["sent"] or None,
                }
                for p in promises.public()[:150]
            ]
        return JSONResponse(body)

    async def memory_add(self, request: Request) -> Response:
        device, data, refused = await self.api._post(request, "act")
        if refused is not None:
            return refused
        text, kind = data.get("text"), data.get("kind")
        if not isinstance(text, str) or not text.strip():
            return _bad("text")
        try:
            fact = self.hub.memory.add(
                text,
                category=kind if isinstance(kind, str) else None,
                source="settings",
                origin="iPhone",
            )
        except ValueError as exc:
            return _bad(str(exc)[:200])
        self._changed_memory()
        self.hub._add_style_note(
            f"the user added this to what you remember about them: {fact.text}"
        )
        self.companion.record(device, "memory_added")
        return JSONResponse(
            {
                "ok": True,
                "item": public_fact(fact),
                "forgotten": [f.text for f in self.hub.memory.forgotten],
            }
        )

    async def memory_forget(self, request: Request) -> Response:
        device, data, refused = await self.api._post(request, "act")
        if refused is not None:
            return refused
        fact = self.hub.memory.get(str(data.get("id") or ""))  # by its id only, never words
        if fact is None:
            return _bad("no such memory", 404)
        try:
            self.hub.memory.remove([fact])
        except ValueError as exc:
            return _bad(str(exc)[:200], 503)
        self._changed_memory()
        self.hub._add_style_note(
            "the user deleted some remembered facts from their phone; stop using them."
        )
        self.companion.record(device, "memory_forgot")
        return JSONResponse({"ok": True})

    # ── goals ──

    async def goals(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        if self._piece("goal_store") is None:
            return _missing()
        found = self.hub._goals_payload()
        return JSONResponse(
            {
                "items": found.get("goals") or [],
                "constraints": found.get("constraints") or [],
                "priorities": found.get("priorities") or [],
            }
        )

    # ── timers ──

    def _timers(self) -> Any:
        feature = self._piece("automation_feature")
        return getattr(feature, "timers", None)

    async def timers(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        timers = self._timers()
        if timers is None:
            return _missing()
        now = timers.now()
        language = "zh" if lang.is_zh(self.hub.language) else "en"
        items = []
        for t in sorted(
            {
                t.id: t for t in [*(r for r, _ in timers.ringing.values()), *timers.store.items]
            }.values(),
            key=lambda t: t.instant(),
        ):
            items.append(
                {
                    "id": t.id,
                    "kind": t.kind,
                    "label": t.label,
                    "ends_at": _stamp(t.instant()),
                    "left": max(0, round(t.instant() - now.timestamp())),
                    "when": t.summary(now, language),
                    "every": t.every or None,
                    "until": t.until or None,
                    "ringing": t.id in timers.ringing,
                }
            )
        return JSONResponse({"items": items})

    async def timer_cancel(self, request: Request) -> Response:
        device, data, refused = await self.api._post(request, "act")
        if refused is not None:
            return refused
        timers = self._timers()
        if timers is None:
            return _missing()
        wanted = str(data.get("id") or "")
        found = [t for t in timers.store.items if wanted and t.id == wanted]
        ringing = wanted in timers.ringing
        if not found and not ringing:
            return _bad("no such timer", 404)
        if ringing:
            timers.stop(wanted)
        if found:
            try:
                timers.cancel(found)
            except OSError:
                return _bad("couldn't save", 503)
        self.companion.record(device, "timer_cancelled", found[0].label if found else "")
        return JSONResponse({"ok": True})

    # ── Apple Reminders ──

    async def reminders(self, request: Request) -> Response:
        """Open reminders, soonest due first. Never puts macOS's access question up on the
        Mac (nobody may be there to answer it): without access, "available" is false."""
        from . import reminders_desk

        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        found = await reminders_desk.fetch_open(ask=False)
        if "error" in found:
            reason = found["error"]
            if reason == reminders_desk.NOT_ASKED:
                reason = "Reminders hasn't been allowed on the Mac yet: ask Jarvis there once."
            return JSONResponse(
                {"items": [], "lists": [], "available": False, "reason": _line(reason, 300)}
            )
        return JSONResponse(
            {
                "items": [public_reminder(r) for r in found.get("reminders") or []],
                "lists": [
                    {"title": _line(x.get("title"), 80), "default": bool(x.get("default"))}
                    for x in found.get("lists") or []
                    if x.get("title") and x.get("writable", True)
                ],
                "available": True,
            }
        )

    async def reminder_add(self, request: Request) -> Response:
        from . import reminders_desk

        device, data, refused = await self.api._post(request, "act")
        if refused is not None:
            return refused
        try:
            spec = reminders_desk.clean_new(
                {k: data[k] for k in ("title", "list", "due", "notes", "priority") if k in data}
            )
        except ValueError as exc:
            return _bad(str(exc)[:200])
        done = await reminders_desk.add_reminder(spec)
        if "added" not in done:
            return _bad(_line(done.get("error") or "Reminders didn't answer.", 300), 503)
        self.companion.record(device, "reminder_added")
        return JSONResponse({"ok": True, "item": public_reminder(done["added"])})

    async def reminder_complete(self, request: Request) -> Response:
        from . import reminders_desk

        device, data, refused = await self.api._post(request, "act")
        if refused is not None:
            return refused
        wanted = str(data.get("id") or "")
        found = await reminders_desk.fetch_open(ask=False)
        if "error" in found:
            return _bad(_line(found["error"], 300), 503)
        if not wanted or not any(r.get("id") == wanted for r in found.get("reminders") or []):
            return _bad("no such reminder", 404)  # only an open one the phone was shown
        done = await reminders_desk.complete_reminder(wanted)
        if "completed" not in done:
            return _bad(_line(done.get("error") or "Reminders didn't answer.", 300), 503)
        self.companion.record(device, "reminder_done")
        return JSONResponse({"ok": True})

    # ── markets ──

    async def markets(self, request: Request) -> Response:
        """What the Mac last fetched (it refreshes on its own): no quote is fetched here."""
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        summary = self.hub.markets.summary
        quotes = {q.get("symbol"): q for q in (summary or {}).get("watchlist") or []}
        body: dict[str, Any] = {
            "summary": None,
            "watchlist": [
                public_quote(quotes[s]) if s in quotes else {"symbol": s, "price": None}
                for s in self.hub.prefs.watchlist
            ],
            "alerts": [],
        }
        if summary:
            zh = lang.is_zh(self.hub.language) and summary.get("headline_zh")
            body["summary"] = {
                "as_of": summary.get("as_of"),
                "status": summary.get("status"),
                "headline": summary.get("headline_zh") if zh else summary.get("headline"),
                "indices": [public_quote(q) for q in summary.get("indices") or []],
            }
        stocks = self._piece("stocks")
        if stocks is not None:
            body["alerts"] = [
                {
                    "id": a["id"],
                    "symbol": a["symbol"],
                    "name": a["name"],
                    "kind": a["kind"],
                    "value": a["value"],
                    "fired": a["fired"] or None,
                }
                for a in stocks.store.public().get("items") or []
            ]
        return JSONResponse(body)

    # ── background tasks ──

    async def tasks(self, request: Request) -> Response:
        from .background import outcome

        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        desk = self._piece("background")
        if desk is None:
            return _missing()
        running = {t.id for t in desk.running()}
        items = []
        for t in desk.mine()[:LISTED]:
            items.append(
                {
                    "id": t.id,
                    "title": _line(t.title or t.prompt, 200),
                    "status": "running" if t.id in running else t.status,
                    "started": t.started.isoformat(timespec="seconds"),
                    "last_action": _line(t.last_action, 200),
                    "outcome": outcome(t.result, 300) if t.id not in running else "",
                    "cost_usd": t.cost_usd,
                }
            )
        return JSONResponse({"items": items})

    async def task_stop(self, request: Request) -> Response:
        device, data, refused = await self.api._post(request, "act")
        if refused is not None:
            return refused
        desk = self._piece("background")
        if desk is None:
            return _missing()
        wanted = _int(data.get("id"))
        task = next((t for t in desk.running() if wanted is not None and t.id == wanted), None)
        if task is None:
            return _bad("no such task", 404)
        ok = desk.stop(task.id)
        if ok:
            self.companion.record(device, "task_stopped", f"#{task.id}")
        return JSONResponse({"ok": ok})

    # ── music ──

    async def _now_playing(self) -> dict[str, Any] | None:
        """What Spotify or Music is playing (the one that's open: none is opened to ask)."""
        from . import mac_tools

        player = await asyncio.to_thread(mac_tools._active_player)
        if player is None:
            return None
        try:
            raw = await mac_tools.run_applescript(
                NOW_PLAYING_SCRIPT.replace("{player}", player), timeout=15
            )
        except mac_tools.ToolFailure:
            return None
        parts = raw.strip().split("\t")
        state = parts[0] if parts[0] in ("playing", "paused", "stopped") else "stopped"
        return {
            "player": player,
            "state": state,
            "title": _line(parts[1], 200) if len(parts) > 1 else None,
            "artist": _line(parts[2], 200) if len(parts) > 2 else None,
            "album": _line(parts[3], 200) if len(parts) > 3 else None,
        }

    async def music(self, request: Request) -> Response:
        from . import mac_tools

        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        music = self._piece("music")
        if music is None:
            return _missing()
        playlists: list[str] = []
        if await asyncio.to_thread(mac_tools.app_running, "Music"):  # never opened to list
            try:
                playlists = (await music.playlists())[:200]
            except mac_tools.ToolFailure:
                playlists = []
        return JSONResponse({"now_playing": await self._now_playing(), "playlists": playlists})

    async def music_control(self, request: Request) -> Response:
        from . import mac_tools
        from .music import NotFound

        device, data, refused = await self.api._post(request, "act")
        if refused is not None:
            return refused
        music = self._piece("music")
        if music is None:
            return _missing()
        action = data.get("action")
        try:
            if action == "playlist":
                name = data.get("name")
                if not isinstance(name, str) or name not in await music.playlists():
                    return _bad("no such playlist", 404)
                await music.play(name, "playlist")
            elif action in MUSIC_ACTIONS:
                player = await asyncio.to_thread(mac_tools._active_player)
                if player is None:
                    if action != "play":
                        return _bad("No music app is open.", 409)
                    player = "Music"
                await mac_tools.run_applescript(
                    f'tell application "{player}" to {MUSIC_ACTIONS[action]}', timeout=15
                )
            else:
                return _bad("action")
        except NotFound as exc:
            return _bad(str(exc)[:200], 404)
        except mac_tools.ToolFailure as exc:
            return _bad(_line(exc, 200) or "Music didn't answer.", 502)
        self.companion.record(device, "music", str(action))
        return JSONResponse({"ok": True})

    # ── Shortcuts ──

    async def shortcuts(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        names = await self.hub.shortcuts.refresh()
        return JSONResponse({"items": [{"name": n} for n in names]})

    async def shortcut_run(self, request: Request) -> Response:
        from . import mac_tools

        device, data, refused = await self.api._post(request, "act")
        if refused is not None:
            return refused
        name = data.get("name")
        if not isinstance(name, str) or name not in await self.hub.shortcuts.refresh():
            return _bad("no such shortcut", 404)  # only one the Mac lists, by its own name
        try:  # (it runs two minutes at most)
            out = await self.hub.shortcuts.run(name)
        except mac_tools.ToolFailure as exc:
            return _bad(_line(exc, 200) or "The shortcut failed.", 502)
        self.companion.record(device, "shortcut_run", name)
        return JSONResponse({"ok": True, "output": str(out or "").strip()[:OUTPUT_CHARS]})

    # ── the Mac's switches ──

    async def switches(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        desk = self._piece("mac_switches")
        if desk is None:
            return _missing()
        found = await desk.switches.status()
        items = []
        for name, label in SWITCH_LABELS.items():
            value = found.get(name)
            items.append(
                {
                    "name": name,
                    "label": label,
                    "on": value if isinstance(value, bool) else None,
                    "settable": name in SETTABLE_SWITCHES,
                    "note": None if isinstance(value, bool) else _line(value, 300) or None,
                }
            )
        return JSONResponse({"items": items})

    async def switch_set(self, request: Request) -> Response:
        """Dark mode and Bluetooth, the owner's own tap (as Settings): no card. Wi-Fi
        isn't switched from the phone: it may be how the phone reaches this Mac."""
        from . import mac_tools
        from .switches import Unavailable

        device, data, refused = await self.api._post(request, "act")
        if refused is not None:
            return refused
        desk = self._piece("mac_switches")
        if desk is None:
            return _missing()
        name, on = data.get("name"), data.get("on")
        if name == "wifi":
            return _bad("Wi-Fi can't be switched from the phone: it may be how it reaches the Mac.")
        if name not in SETTABLE_SWITCHES:
            return _bad("name")
        if not isinstance(on, bool):
            return _bad("on")
        try:
            if name == "dark_mode":
                said = await desk.switches.set_dark_mode(on)
            else:
                said = await desk.switches.set_bluetooth(on)
        except Unavailable as exc:
            return _bad(_line(exc, 300), 409)
        except mac_tools.ToolFailure as exc:
            return _bad(_line(exc, 200) or "That didn't work.", 502)
        self.companion.record(device, "switch_set", f"{name} {'on' if on else 'off'}")
        return JSONResponse({"ok": True, "said": said})

    # ── the journal ──

    async def journal(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        desk = self._piece("memory_desk")
        if desk is None:
            return _missing()
        book = desk.journal

        def listing() -> list[dict[str, Any]]:
            return [
                {"day": n["day"], "preview": _preview(book.read(n["day"], 4000)), "size": n["size"]}
                for n in book.recent(14)
            ]

        return JSONResponse({"items": await asyncio.to_thread(listing)})

    async def journal_item(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        desk = self._piece("memory_desk")
        if desk is None:
            return _missing()
        day = str(request.query_params.get("day") or "")
        book = desk.journal
        if not _DAY.fullmatch(day) or day not in {n["day"] for n in book.recent(14)}:
            return _bad("no such note", 404)
        text = await asyncio.to_thread(book.read, day, TEXT_CHARS)
        return JSONResponse({"day": day, "text": text})

    # ── meeting notes and research reports ──

    async def meetings(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        return JSONResponse({"items": await asyncio.to_thread(list_notes, self._meetings())})

    async def meeting_item(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        return await self._note(self._meetings(), request.query_params.get("id"), "meeting")

    async def research(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        return JSONResponse({"items": await asyncio.to_thread(list_notes, self._research())})

    async def research_item(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        return await self._note(self._research(), request.query_params.get("id"), "report")

    @staticmethod
    async def _note(folder: Path, wanted: Any, what: str) -> Response:
        def find() -> dict[str, Any] | None:
            path = note_by_id(folder, wanted)
            return read_note(path) if path is not None else None

        found = await asyncio.to_thread(find)
        if found is None:
            return _bad(f"no such {what}", 404)
        return JSONResponse(found)

    # ── invoices ──

    async def invoices(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        desk = self._piece("invoicing")
        if desk is None:
            return _missing()
        return JSONResponse(desk.public())

    # ── settings ──

    def _prefs(self) -> dict[str, Any]:
        current = self.hub.prefs.public()
        return {k: current.get(k) for k in PREFS}

    async def prefs(self, request: Request) -> Response:
        _device, refused = self.api._read(request)
        if refused is not None:
            return refused
        return JSONResponse(
            {
                "prefs": self._prefs(),
                "choices": {
                    "language": ["en", "zh"],
                    "persona": lang.personas_payload(self.hub.language),
                    "interruptions": ["urgent", "all", "off"],
                },
            }
        )

    async def prefs_set(self, request: Request) -> Response:
        """Only PREFS, each of its own type and as Settings would take it: anything else
        refuses the whole change (400), so nothing is half applied."""
        from . import prefs as prefs_mod

        device, data, refused = await self.api._post(request, "act")
        if refused is not None:
            return refused
        changes = data.get("changes")
        if not isinstance(changes, dict) or not changes:
            return _bad("changes")
        for key, value in changes.items():
            kind = PREFS.get(key)
            if kind is None:
                return _bad(f"{str(key)[:40]} can't be changed from the phone")
            if type(value) is not kind or prefs_mod._clean(key, value) is None:
                return _bad(str(key))
        changed = self.hub.set_prefs(dict(changes))
        if changed:
            self.companion.record(device, "prefs_changed", ", ".join(changed))
        return JSONResponse({"ok": True, "changed": changed, "prefs": self._prefs()})


def routes(api: Any) -> list[Route]:
    more = More(api)
    return [
        Route("/api/memory", more.memory),
        Route("/api/memory/add", more.memory_add, methods=["POST"]),
        Route("/api/memory/forget", more.memory_forget, methods=["POST"]),
        Route("/api/goals", more.goals),
        Route("/api/timers", more.timers),
        Route("/api/timers/cancel", more.timer_cancel, methods=["POST"]),
        Route("/api/reminders", more.reminders),
        Route("/api/reminders/add", more.reminder_add, methods=["POST"]),
        Route("/api/reminders/complete", more.reminder_complete, methods=["POST"]),
        Route("/api/markets", more.markets),
        Route("/api/tasks", more.tasks),
        Route("/api/tasks/stop", more.task_stop, methods=["POST"]),
        Route("/api/music", more.music),
        Route("/api/music", more.music_control, methods=["POST"]),
        Route("/api/shortcuts", more.shortcuts),
        Route("/api/shortcuts/run", more.shortcut_run, methods=["POST"]),
        Route("/api/switches", more.switches),
        Route("/api/switches/set", more.switch_set, methods=["POST"]),
        Route("/api/journal", more.journal),
        Route("/api/journal/item", more.journal_item),
        Route("/api/meetings", more.meetings),
        Route("/api/meetings/item", more.meeting_item),
        Route("/api/research", more.research),
        Route("/api/research/item", more.research_item),
        Route("/api/invoices", more.invoices),
        Route("/api/prefs", more.prefs),
        Route("/api/prefs", more.prefs_set, methods=["POST"]),
    ]
