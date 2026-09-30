"""The companion API beyond remote.py's own calls (the contract both apps follow): push
tokens, Jarvis Code, what came in, conversations, spending and routines. Every route goes
through remote.Gate: the phone's own token (401), its budget for that kind of call (429),
and a cap on what's read (413), before anything is done.

What goes to the phone is the owner's own (over the pinned HTTPS connection), capped:
Jarvis Code's transcript entries at 4,000 characters with tool output summed up, a diff
at 40 files of 20 hunks of 200 lines (a credential file listed, never shown), what came
in as short summaries with links and codes taken out."""

from __future__ import annotations

import asyncio
import logging
import re
import subprocess
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from . import push

log = logging.getLogger("jarvis")

ENTRIES_AT_ONCE = 200  # transcript entries in one answer
ENTRY_CHARS = 4000
DIFF_FILES, DIFF_HUNKS, HUNK_LINES, LINE_CHARS = 40, 20, 200, 500
SESSIONS_SHOWN = 50
DIGEST_HOURS = 24
DIGEST_ITEMS = 100
BRANCH_SECONDS = 30.0  # a project's branch, looked up at most this often
# The digest's own words (the rest is who wrote, and a summary of what they wrote).
WORDS = {
    "en": {
        "withheld": "A message that reads like instructions for an AI, not shown.",
        "no_subject": "No subject",
        "attachment": "An attachment",
        "booking": "Asked to book a time",
        "schedule": "Wants a time to meet",
        "missed": "Missed call",
    },
    "zh": {
        "withheld": "这条消息看起来像是写给 AI 的指令，不予显示。",
        "no_subject": "无主题",
        "attachment": "一个附件",
        "booking": "请求预约时间",
        "schedule": "想约个时间见面",
        "missed": "未接来电",
    },
}


def _bad(what: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": what}, status_code=status)


def _ok(ok: bool = True) -> JSONResponse:
    return JSONResponse({"ok": ok})


def _int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _line(text: Any, limit: int) -> str:
    return " ".join(str(text or "").split())[:limit]


# ── Jarvis Code ──


def public_approval(card: dict[str, Any]) -> dict[str, Any]:
    """A card as the phone shows it, JARVIS's or a Jarvis Code session's."""
    task_id = card.get("task_id")
    out: dict[str, Any] = {
        "id": card.get("id"),
        "question": str(card.get("question") or "")[:500],
        "detail": str(card.get("detail") or "")[:4000],
        "choices": [
            {"id": str(c.get("id")), "label": str(c.get("label"))}
            for c in card.get("choices") or []
            if isinstance(c, dict)
        ],
        "source": "code" if task_id else "jarvis",
    }
    if task_id:
        out["task_id"] = task_id
    return out


def session_status(task: Any, waiting: bool) -> str:
    """working | needs_you | done | failed | idle | resting: a session as the phone shows
    it (tasks.py's own status says more than a phone needs)."""
    if waiting:
        return "needs_you"
    if task.status == "failed":
        return "failed"
    if task.busy or task.status == "running":
        return "working"
    if task.status in ("waiting", "done"):
        return "done" if task.transcript else "idle"
    if task.status in ("closed", "stopped"):
        return "resting"  # its connection closed; a message opens it again
    return "idle"


def branch_of(cwd: Path) -> str:
    """The checked-out branch, from .git/HEAD (a worktree's too): "" outside git."""
    for folder in [cwd, *list(cwd.parents)[:20]]:
        git = folder / ".git"
        try:
            if git.is_file():
                pointer = git.read_text(errors="replace").strip()
                if not pointer.startswith("gitdir:"):
                    return ""
                git = (folder / pointer[7:].strip()).resolve()
            elif not git.is_dir():
                continue
            head = (git / "HEAD").read_text(errors="replace").strip()
        except OSError:
            return ""
        if head.startswith("ref: refs/heads/"):
            return head[16:][:120]
        return head[:12]  # detached: the commit
    return ""


def _entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    """One transcript entry as the phone gets it; None for what it doesn't show (thinking,
    the to-do list, which comes on its own)."""
    role = entry.get("role")
    text = str(entry.get("text") or "")
    if role in ("tool", "subtool"):
        out = "tool"
        status = entry.get("status")
        if status == "failed":
            text += " (failed)"
        output = str(entry.get("output") or "").strip()
        if output:  # tool output, summed up: its first lines
            head = output.splitlines()[:3]
            text += "\n" + "\n".join(line[:200] for line in head)
            if len(output.splitlines()) > 3 or len(output) > 600:
                text += "\n…"
    elif role in ("user", "assistant"):
        out = role
    elif role in ("system", "plan"):
        out = "note"
    else:
        return None
    return {"i": entry.get("n"), "role": out, "text": text[:ENTRY_CHARS], "at": entry.get("at", "")}


def _hunk_lines(block: list[str]) -> list[str]:
    return [line[:LINE_CHARS] for line in block[:HUNK_LINES]]


def parse_unified(diff: str) -> list[dict[str, Any]]:
    """git diff's unified output as files, each with its hunks' lines."""
    files: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    hunk: dict[str, Any] | None = None
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            m = re.match(r"diff --git a/(.+?) b/(.+)$", line)
            current = {
                "path": m.group(2) if m else line[11:],
                "status": "M",
                "added": 0,
                "removed": 0,
                "hunks": [],
            }
            files.append(current)
            hunk = None
        elif current is None:
            continue
        elif line.startswith("new file mode"):
            current["status"] = "A"
        elif line.startswith("deleted file mode"):
            current["status"] = "D"
        elif line.startswith(("--- ", "+++ ", "index ", "similarity", "rename ", "Binary ")):
            continue
        elif line.startswith("@@"):
            hunk = {"header": line[:200], "lines": []}
            current["hunks"].append(hunk)
        elif hunk is not None and line[:1] in (" ", "+", "-"):
            if line[:1] == "+":
                current["added"] += 1
            elif line[:1] == "-":
                current["removed"] += 1
            hunk["lines"].append(line)
    return files


def _git(cwd: Path, *args: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout if out.returncode == 0 else None


def collect_diff(cwd: Path) -> list[dict[str, Any]]:
    """The project's working changes against HEAD, and its new files, capped. A credential
    file (.env, a key) is listed with no lines; a new link, never followed. Blocking."""
    from .computer import is_sensitive

    if not (_git(cwd, "rev-parse", "--is-inside-work-tree") or "").strip():
        return []
    raw = _git(
        cwd, "diff", "HEAD", "--relative", "--no-color", "--no-ext-diff", "-U3", "--no-renames"
    )
    files = parse_unified(raw or "")
    for item in (_git(cwd, "ls-files", "--others", "--exclude-standard") or "").splitlines()[:200]:
        path = cwd / item
        lines: list[str] = []
        if not path.is_symlink() and path.is_file() and not is_sensitive(path):
            try:
                if path.stat().st_size <= 256_000:
                    text = path.read_bytes()
                    if b"\0" not in text[:8000]:
                        lines = ["+" + line for line in text.decode(errors="replace").splitlines()]
            except OSError:
                lines = []
        files.append(
            {
                "path": item,
                "status": "A",
                "added": len(lines),
                "removed": 0,
                "hunks": [{"header": f"@@ -0,0 +1,{len(lines)} @@", "lines": lines}]
                if lines
                else [],
            }
        )
    out = []
    for item in files[:DIFF_FILES]:
        if is_sensitive(cwd / item["path"]):
            item["hunks"] = []  # listed, never shown
        item["hunks"] = [
            {"header": h["header"], "lines": _hunk_lines(h["lines"])}
            for h in item["hunks"][:DIFF_HUNKS]
        ]
        out.append(item)
    return out


# ── routines ──


def next_run(routine: Any, now: datetime) -> datetime | None:
    """When a routine next runs; None when it's paused, or a one-off already past."""
    if not routine.enabled:
        return None
    hour, minute = map(int, routine.time.split(":"))
    if routine.kind == "once":
        try:
            when = datetime.fromisoformat(routine.date).replace(hour=hour, minute=minute)
        except ValueError:
            return None
        return when if when > now else None
    for ahead in range(8):
        day = (now + timedelta(days=ahead)).replace(
            hour=hour, minute=minute, second=0, microsecond=0
        )
        if day <= now:
            continue
        if routine.kind == "weekdays" and day.weekday() >= 5:
            continue
        if routine.kind == "weekly" and day.weekday() not in routine.days:
            continue
        return day
    return None


def _days(value: Any) -> list[int] | None:
    if not isinstance(value, list) or len(value) > 7:
        return None
    days = {_int(d) for d in value}
    if not days or None in days or not all(0 <= d <= 6 for d in days):  # type: ignore[operator]
        return None
    return sorted(days)  # type: ignore[arg-type]


class Api:
    def __init__(self, companion: Any, gate: Any) -> None:
        self.companion = companion
        self.hub = companion.hub
        self.gate = gate
        self._branches: dict[Path, tuple[float, str]] = {}

    def _read(self, request: Request) -> tuple[Any, Response | None]:
        return self.gate.admit(request, "read")

    async def _post(
        self, request: Request, kind: str, cap: int | None = None
    ) -> tuple[Any, dict[str, Any], Response | None]:
        """The device and its JSON body, or the refusal: token first, then its budget,
        then the body (at most cap bytes)."""
        from .remote import MAX_BODY

        device, refused = self.gate.admit(request, kind)
        if device is None:
            return None, {}, refused
        data = await self.gate.json(request, cap or MAX_BODY)
        if data is None:
            return None, {}, self.gate.too_big()
        return device, data, None

    # ── push ──

    async def push_register(self, request: Request) -> Response:
        device, data, refused = await self._post(request, "report")
        if refused is not None:
            return refused
        token = str(data.get("token") or "").strip().lower()
        environment = data.get("environment")
        bundle_id = str(data.get("bundle_id") or "").strip()
        if not push.valid_token(token):
            return _bad("token")
        if environment not in push.HOSTS:
            return _bad("environment")
        if not push.valid_bundle(bundle_id):
            return _bad("bundle_id")
        self.companion.store.register(device.id, token, str(environment), bundle_id)
        self.companion.record(device, "push_on")
        self.companion.emit_status()
        return JSONResponse({"ok": True})

    async def push_unregister(self, request: Request) -> Response:
        device, _data, refused = await self._post(request, "report")
        if refused is not None:
            return refused
        self.companion.store.unregister(device.id)
        self.companion.record(device, "push_off")
        self.companion.emit_status()
        return JSONResponse({"ok": True})

    # ── Jarvis Code ──

    def _session(self, value: Any) -> Any:
        task = self.hub.tasks.tasks.get(_int(value) or 0)
        return task if task is not None and task.kind == "code" else None

    def waiting_for(self, task_id: int) -> dict[str, str] | None:
        """The card a session is waiting on, if any."""
        for card in self.hub.approvals.values():
            if card.get("task_id") == task_id:
                return {"approval_id": card["id"], "question": _line(card.get("question"), 300)}
        return None

    async def _branches_of(self, tasks: list[Any]) -> dict[Path, str]:
        now = time.monotonic()
        stale = {
            t.cwd for t in tasks if now - self._branches.get(t.cwd, (-1e9, ""))[0] > BRANCH_SECONDS
        }
        if stale:
            found = await asyncio.to_thread(lambda: {cwd: branch_of(cwd) for cwd in stale})
            for cwd, branch in found.items():
                self._branches[cwd] = (now, branch)
        return {t.cwd: self._branches.get(t.cwd, (0.0, ""))[1] for t in tasks}

    async def code_sessions(self, request: Request) -> Response:
        _device, refused = self._read(request)
        if refused is not None:
            return refused
        tasks = sorted(
            (t for t in self.hub.tasks.tasks.values() if t.kind == "code"), key=lambda t: -t.id
        )[:SESSIONS_SHOWN]
        branches = await self._branches_of(tasks)
        sessions = []
        for task in tasks:
            waiting = self.waiting_for(task.id)
            item: dict[str, Any] = {
                "id": task.id,
                "title": _line(task.title or task.prompt, 120),
                "project": task.cwd.name,
                "branch": branches.get(task.cwd, ""),
                "status": session_status(task, waiting is not None),
                "mode": task.mode,
                "model": task.model_label or task.model or self.hub.tasks.model,
                "cost_usd": task.cost_usd,
                "updated_at": (task.transcript[-1].get("at") if task.transcript else "")
                or task.started.isoformat(timespec="seconds"),
            }
            if waiting is not None:
                item["waiting"] = waiting
            sessions.append(item)
        return JSONResponse({"sessions": sessions})

    async def code_session(self, request: Request) -> Response:
        _device, refused = self._read(request)
        if refused is not None:
            return refused
        task = self._session(request.query_params.get("id"))
        if task is None:
            return _bad("no such session", 404)
        after = _int(request.query_params.get("after")) or 0
        entries = []
        for raw in task.transcript:
            if (_int(raw.get("n")) or 0) <= after:
                continue
            entry = _entry(raw)
            if entry is not None:
                entries.append(entry)
                if len(entries) >= ENTRIES_AT_ONCE:
                    break
        waiting = self.waiting_for(task.id)
        body: dict[str, Any] = {
            "id": task.id,
            "title": _line(task.title or task.prompt, 120),
            "status": session_status(task, waiting is not None),
            "entries": entries,
            "todos": [
                {"text": _line(t.get("content"), 300), "done": t.get("status") == "completed"}
                for t in task.todos
            ],
        }
        if waiting is not None:
            body["waiting"] = waiting
        return JSONResponse(body)

    async def code_diff(self, request: Request) -> Response:
        _device, refused = self._read(request)
        if refused is not None:
            return refused
        task = self._session(request.query_params.get("id"))
        if task is None:
            return _bad("no such session", 404)
        files = await asyncio.to_thread(collect_diff, task.cwd)
        return JSONResponse({"files": files})

    async def code_send(self, request: Request) -> Response:
        device, data, refused = await self._post(request, "act")
        if refused is not None:
            return refused
        task = self._session(data.get("id"))
        if task is None:
            return _bad("no such session", 404)
        text = str(data.get("text") or "").strip()[:20000]
        if not text:
            return _bad("empty")
        ok = self.hub.tasks.send(task.id, text)  # queued as the composer queues it
        if ok:
            self.companion.record(device, "code_sent", f"#{task.id}")
        return _ok(ok)

    async def code_stop(self, request: Request) -> Response:
        device, data, refused = await self._post(request, "act")
        if refused is not None:
            return refused
        task = self._session(data.get("id"))
        if task is None:
            return _bad("no such session", 404)
        ok = await self.hub.tasks.interrupt(task.id)
        if ok:
            self.companion.record(device, "code_stopped", f"#{task.id}")
        return _ok(ok)

    # ── what came in ──

    def digest_items(self, now: datetime) -> list[dict[str, Any]]:
        """Texts and email of the last day that what_did_i_miss has for the owner (without
        taking them from it), what was said out loud, and calls to the Jarvis number: who,
        what kind, and a short summary (links and codes out; a message written for an AI
        not shown at all)."""
        from . import lang as lang_mod
        from .interrupts import STRONG, URGENT, snippet, who_said

        lang = getattr(self.hub.prefs, "language", "en")
        words = WORDS["zh" if lang_mod.is_zh(lang) else "en"]
        since = now - timedelta(hours=DIGEST_HOURS)
        watch = self.hub.interrupts
        items = list(watch.waiting) + [told.item for told in watch.told_back]
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in items:
            if item.key in seen or item.at < since:
                continue
            seen.add(item.key)
            if item.suspicious:
                summary = words["withheld"]
            elif item.source == "mail":
                subject = snippet(item.text, lang, 100) or words["no_subject"]
                preview = snippet(item.preview, lang, 100)
                summary = subject + (f" · {preview}" if preview else "")
            else:
                summary = snippet(item.text, lang) or words["attachment"]
            out.append(
                {
                    "who": who_said(item, lang),
                    "kind": "email" if item.source == "mail" else "text",
                    "summary": summary,
                    "at": item.at.isoformat(timespec="seconds"),
                    "urgent": item.score >= URGENT or bool(STRONG & set(item.words)),
                }
            )
        answering = getattr(self.hub, "answering", None)
        for call in getattr(getattr(answering, "log", None), "calls", None) or []:
            try:
                at = datetime.fromisoformat(call.at)
            except (TypeError, ValueError):
                continue
            if at.tzinfo is not None:
                at = at.astimezone().replace(tzinfo=None)
            if at < since:
                continue
            said = snippet(call.words, lang) if call.words else ""
            out.append(
                {
                    "who": call.who(),
                    "kind": "voicemail" if call.kind == "message" else "call",
                    "summary": said or words.get(call.kind, words["missed"]),
                    "at": at.isoformat(timespec="seconds"),
                    "urgent": False,
                }
            )
        out.sort(key=lambda i: i["at"], reverse=True)
        return out[:DIGEST_ITEMS]

    async def digest(self, request: Request) -> Response:
        _device, refused = self._read(request)
        if refused is not None:
            return refused
        return JSONResponse({"items": self.digest_items(datetime.now())})

    # ── conversations JARVIS holds ──

    async def delegations(self, request: Request) -> Response:
        _device, refused = self._read(request)
        if refused is not None:
            return refused
        items = []
        for d in reversed(self.hub.delegations.items[-SESSIONS_SHOWN:]):
            last = d.transcript[-1].get("at", "") if d.transcript else ""
            items.append(
                {
                    "id": d.id,
                    "with": d.contact,
                    "goal": _line(d.goal, 300),
                    "status": d.status,
                    "messages": len(d.transcript),
                    "updated_at": last or d.created,
                }
            )
        return JSONResponse({"items": items})

    async def delegation_stop(self, request: Request) -> Response:
        device, data, refused = await self._post(request, "act")
        if refused is not None:
            return refused
        wanted = str(data.get("id") or "")
        if not any(d.id == wanted and d.is_open for d in self.hub.delegations.items):
            return _bad("no such conversation", 404)  # by its id only, never a name
        try:
            self.hub.delegate.stop(wanted)
        except (ValueError, OSError) as exc:
            return _bad(str(exc)[:200], 409)
        self.companion.record(device, "delegation_stopped")
        return _ok()

    # ── spending ──

    async def spending(self, request: Request) -> Response:
        _device, refused = self._read(request)
        if refused is not None:
            return refused
        desk = self.hub.transactions
        info = desk.public()
        limits = desk.limits()
        return JSONResponse(
            {
                "recent": [
                    {
                        "at": e.get("time"),
                        "merchant": e.get("merchant"),
                        "amount": e.get("amount"),
                        "currency": e.get("currency"),
                        "kind": e.get("kind"),
                    }
                    for e in info.get("recent") or []
                ],
                "limits": {
                    "purchase": limits.purchase,
                    "transfer": limits.transfer,
                    "day": limits.day,
                    "currency": limits.currency,
                },
                "today_total": info.get("spent_today"),
            }
        )

    # ── routines ──

    def _routine(self, value: Any) -> Any:
        wanted = str(value or "")
        return next((r for r in self.hub.routines.items if r.id == wanted), None)

    async def routines(self, request: Request) -> Response:
        _device, refused = self._read(request)
        if refused is not None:
            return refused
        now = datetime.now()
        items = []
        for r in self.hub.routines.items:
            upcoming = next_run(r, now)
            items.append(
                {
                    "id": r.id,
                    "name": r.name,
                    "schedule_text": r.describe(),
                    "enabled": r.enabled,
                    "next_run": upcoming.isoformat(timespec="minutes") if upcoming else None,
                }
            )
        return JSONResponse({"items": items})

    async def routine_update(self, request: Request) -> Response:
        """enabled, time ("HH:MM") and days (0 = Monday … 6 = Sunday, as routines keep
        them): every day is daily, Monday to Friday is weekdays, else weekly."""
        from . import routines as routines_mod

        device, data, refused = await self._post(request, "act")
        if refused is not None:
            return refused
        routine = self._routine(data.get("id"))
        if routine is None:
            return _bad("no such routine", 404)
        kind, when, days = routine.kind, routine.time, list(routine.days)
        if "days" in data:
            picked = _days(data.get("days"))
            if picked is None or routine.kind == "once":
                return _bad("days")
            days = picked
            kind = (
                "daily"
                if len(picked) == 7
                else "weekdays"
                if picked == [0, 1, 2, 3, 4]
                else "weekly"
            )
        if "time" in data:
            when = str(data.get("time") or "")
        try:
            kind, when, days, date = routines_mod.validate(kind, when, days, routine.date)
        except ValueError as exc:
            return _bad(str(exc)[:200])
        enabled = routine.enabled
        if "enabled" in data:
            if not isinstance(data["enabled"], bool):
                return _bad("enabled")
            enabled = data["enabled"]
        before = (
            routine.kind,
            routine.time,
            list(routine.days),
            routine.date,
            routine.enabled,
            routine.last_run,
        )
        timing = (kind, when, days) != (routine.kind, routine.time, routine.days)
        routine.kind, routine.time, routine.days, routine.date = kind, when, days, date
        routine.enabled = enabled
        if timing and kind != "once":  # as a new routine: a time already past today waits
            latest = routine.latest(datetime.now())
            if latest is not None:
                routine.last_run = latest.isoformat(timespec="minutes")
        try:
            self.hub.routines.save()
        except OSError:
            (
                routine.kind,
                routine.time,
                routine.days,
                routine.date,
                routine.enabled,
                routine.last_run,
            ) = before
            return _bad("couldn't save", 503)
        self.hub._routines_changed()
        self.companion.record(device, "routine_changed", routine.name)
        return _ok()

    async def routine_run(self, request: Request) -> Response:
        device, data, refused = await self._post(request, "ask")
        if refused is not None:
            return refused
        routine = self._routine(data.get("id"))
        if routine is None:
            return _bad("no such routine", 404)
        if not await self.hub.remote_command({"type": "routine_run", "id": routine.id}):
            return self.gate.busy()
        self.companion.record(device, "routine_run", routine.name)
        return _ok()

    async def routine_delete(self, request: Request) -> Response:
        device, data, refused = await self._post(request, "act")
        if refused is not None:
            return refused
        routine = self._routine(data.get("id"))
        if routine is None:
            return _bad("no such routine", 404)
        try:
            self.hub.routines.remove(routine.id)
        except OSError:
            return _bad("couldn't save", 503)
        self.hub._routines_changed()
        self.companion.record(device, "routine_deleted", routine.name)
        return _ok()


def routes(companion: Any, gate: Any) -> list[Route]:
    api = Api(companion, gate)
    return [
        Route("/api/push/register", api.push_register, methods=["POST"]),
        Route("/api/push/unregister", api.push_unregister, methods=["POST"]),
        Route("/api/code/sessions", api.code_sessions),
        Route("/api/code/session", api.code_session),
        Route("/api/code/diff", api.code_diff),
        Route("/api/code/send", api.code_send, methods=["POST"]),
        Route("/api/code/stop", api.code_stop, methods=["POST"]),
        Route("/api/digest", api.digest),
        Route("/api/delegations", api.delegations),
        Route("/api/delegations/stop", api.delegation_stop, methods=["POST"]),
        Route("/api/spending", api.spending),
        Route("/api/routines", api.routines),
        Route("/api/routines/update", api.routine_update, methods=["POST"]),
        Route("/api/routines/run", api.routine_run, methods=["POST"]),
        Route("/api/routines/delete", api.routine_delete, methods=["POST"]),
    ]
