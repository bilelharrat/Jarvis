"""Eden Code on the phone: start a session at the desk, carry on from the phone. A mobile web
page the phone companion's own server serves (remote.py: HTTPS with the Mac's own
certificate), for the owner's paired phone, with the whole of a session in it: the session
list with each one's status and what waits on the owner, the live transcript (streaming), a
message to send, the cards to answer, Stop, the model (Eden chat's list) and the mode, a new
session in a project, landing or discarding its isolated copy, and Exterminator Mode's runs.
It works today, in Safari, with no app update: the iPhone app is in App Review, and its own
screens for this come after (docs/eden-code-phone.md, on the same routes).

The page (https://<this Mac>.local:8765/code/) pairs as the iPhone app does: the six-digit
code from Settings › iPhone & Watch, traded for the device's own long token (remote.Devices),
kept in the page's own storage and sent as a Bearer token with every call. It installs to
the Home Screen (its own manifest, icon and a service worker that keeps only the page's own
files, never an answer). Away from the Mac's Wi-Fi it works over Tailscale (the companion's
address there); the encrypted relay through askeden.com carries the iPhone app only (raw TLS
in a WebSocket, which a browser can't speak: docs/eden-code-shared-sessions.md).

"Hand off to phone" (a session's More menu, or /phone): pins the session to the phone's
view (the page opens it, once per handoff) and sends a push through the existing path
(companion_push: the owner's key or their account), whatever the phone's push settings and
whether the owner is at the Mac (they asked for it, now), with the session's number and the
page's link in it. Today's iPhone app opens the session from it (kind code_done, as a
session that finished: its Destination for a code push); its later screen reads handoff.

Security, the same rules as the iPhone app's calls and stricter where the page can't do what
the app does:
- Every /api/code/phone/* call goes through remote.Gate: the device's own token (401), its
  rate limit for reads or actions (429, remote.RATES), a capped body (413). Then this
  feature's own switch (code_phone_web, off until the owner turns it on: 403 saying where).
- Bypass permissions never comes from here: a new session starts in Manual or Accept edits
  only (always named, so a project whose default is Bypass doesn't start in it), and a mode
  switch is to one of those two. The iPhone app's own Face ID path into Bypass (S11, its
  mode menu and new-session sheet, companion_code) isn't this page's: a browser has no Face
  ID to ask, so it isn't offered and the server refuses it.
- A card only the Mac's window answers (code_touchid.mac_only: one for Touch ID, a risky
  step's, a tap-only one) takes a "no" from here, never a yes. Landing an isolated copy is
  refused while its sessions work or when the work it would commit holds what looks like a
  secret (secret_scan: land it on the Mac, where the card lists them); otherwise Land and
  Discard put up their own cards (code_isolation), answered here or on the Mac.
- What comes from a session (its transcript, a card's words, project and branch names) is
  outside text to the page: put in with textContent only, under a strict CSP (scripts from
  the page's own origin), no-referrer, no framing. What goes to it is what the iPhone app
  gets (companion_api: entries at 4,000 characters, tool output summed up, every entry
  already through the session's redactors).
- A live transcript is a long poll: one request waits up to WAIT_MOST seconds for the
  session to change (a new or changed entry, streamed words, its status, a card), at most
  WAITS_PER_DEVICE of a phone's at once (more answer at once). An entry whose step's outcome
  came in after it was sent is sent again (tasks._tool_result marks it "updated", as Share
  live reads it: the round 2 fix), so a step never stays "running" on the phone.

Window commands: code_phone_state {}, code_phone_handoff {id}, code_phone_unpin {}.
Events: code_phone {on, running, url, qr, short, pinned: {id, title, at} | null, pushed:
{id, sent, said} | null}.
HTTP (remote.py's server): GET /code/ (the page), /code/phone.js, /code/phone.css,
/code/sw.js, /code/manifest.webmanifest, /code/icon.png; with the device token:
GET /api/code/phone/home, /api/code/phone/options, /api/code/phone/session?id&after&seen&v&wait;
POST /api/code/phone/{send, answer, stop, mode, model, new, land, discard, unpin}.
For the native iPhone app (Eden Code's own, 2026-10-16), on the same gate and switch:
GET /api/code/phone/changes?id&view&path (the Changes pane's payload, code_hunks), receipts?id&tail
(the turns' receipts, no pictures), todos (the to-do column and its queues), usage (the meter's
glance); POST /api/code/phone/hunk {id, hunk | hunks, action: keep|unkeep|undo, view} (Keep and
Undo, Undo all), comments {id, comments: [{path, line, side?, excerpt?, text}]} (as one message,
code_api.comment_message), steer {id, text} (into the running step), todo_start {card} (never in
Auto or Bypass: those start on the Mac).
Settings (prefs.features): code_phone_web (bool, off), code_phone_offered (bool: the first-run
card's offer was answered).

Cost policy (Claude): nothing here calls a model. A message sent or a session started from
the phone is the owner's own turn, under the usage caps (code_usage) like the window's.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from .. import lang, prefs

log = logging.getLogger("jarvis")

PREF = "code_phone_web"
prefs.register_feature_pref(PREF, False)
# Whether Eden Code's first-run card has offered the phone page (web/features/code-getstarted.js,
# 2026-10-16). The page stays off until the owner turns it on there or in the Phone pane: it
# serves their sessions to a paired device, so it's their yes, never a default; the card only
# makes sure they hear it exists (carrying on from the phone is among the most-asked features).
PREF_OFFERED = "code_phone_offered"
prefs.register_feature_pref(PREF_OFFERED, False)

PHONE_MODES = ("ask", "edits")  # Manual and Accept edits: never Bypass from the page (S11)
WAIT_MOST = 25.0  # seconds a live transcript's request waits for something new
STIR_CHECK = 0.25  # how often a waiting request looks whether anything happened
WAITS_PER_DEVICE = 3  # a phone's requests waiting at once; more answer at once
LIVE_CHARS = 8000  # streamed words kept per session (the tail), for the phone
ENTRIES_AT_ONCE = 200
UPDATES_AT_ONCE = 50  # entries already sent that changed since (a step's outcome), at most
SESSIONS_SHOWN = 50
RUNS_SHOWN = 5  # Exterminator Mode's runs on the phone, newest first
TEXT_CHARS = 20_000  # a message, as the composer takes it
TEXT_BODY = TEXT_CHARS * 6 + 1024  # ... as JSON: every character escaped at worst
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
# The events that may change what a phone shows of a session (it looks again when one comes).
HEARD = (
    "task_stream", "task_log", "task_log_update", "task_finished", "tasks", "approval",
    "approval_resolved", "code_copies", "code_bugfix", "task_todos",
)  # fmt: skip
# The page's own files: (the file in web/, its type).
FILES = {
    "phone.js": ("code-phone.js", "text/javascript"),
    "phone.css": ("code-phone.css", "text/css"),
    "sw.js": ("code-phone-sw.js", "text/javascript"),
}
HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
        "img-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; "
        "form-action 'none'; frame-ancestors 'none'"
    ),
}

ZH = {
    "Turn on Eden Code on your phone in Eden Code › More › Hand off to phone first.": "请先在 Eden Code › 更多 › 交给手机 里打开“手机上的 Eden Code”。",
    "No such session.": "没有这个会话。",
    "That card isn't up any more.": "那张卡片已经不在了。",
    "Answer this one on your Mac: it needs Touch ID there.": "请在 Mac 上回答这张卡片：它需要在那里用触控 ID 确认。",
    "From the phone a session runs in Manual or Accept edits. Bypass permissions only on the Mac.": "在手机上会话只能用“手动”或“接受编辑”。绕过权限只能在 Mac 上开启。",
    "That model isn't on the list, or needs a key on the Mac first.": "那个模型不在列表里，或者需要先在 Mac 上添加密钥。",
    "A project and what to do.": "选一个项目，并写下要做什么。",
    "The session didn't start.": "会话没有启动。",
    "This session isn't in an isolated copy.": "这个会话不在独立副本里。",
    "It's still working. Stop it first, then land.": "它还在工作。先停下它，再合并。",
    "It's still working. Stop it first, then discard.": "它还在工作。先停下它，再丢弃。",
    "Possible secrets in what it would commit: land it on your Mac, where its card lists them.": "它要提交的内容里可能有密钥：请在 Mac 上合并，那里的卡片会列出它们。",
    "Confirm on its card.": "请在它的卡片上确认。",
    "Write something first.": "请先写点什么。",
    "Carry on from your phone": "在手机上继续",
    "In {folder}": "在 {folder} 中",
    "Handed off to your phone.": "已交给你的手机。",
    "Pinned for your phone. No phone gets Eden's notifications yet: open the link on it.": "已为手机固定。还没有手机接收 Eden 的通知：请在手机上打开链接。",
    "Pinned for your phone. Turn on the phone companion in Settings › iPhone & Watch to reach it.": "已为手机固定。请在设置 › iPhone 与手表里打开手机伴侣，才能连上它。",
    "Open a session to hand it off.": "打开一个会话才能交给手机。",
    "The Changes pane isn't available here.": "这里没有改动面板。",
    "Say which change, and Keep or Undo.": "请说明是哪处改动，以及保留还是撤销。",
    "Each comment needs a file, a line and what to say.": "每条评论都需要文件、行号和内容。",
    "This card would start in Auto or Bypass permissions: start it on your Mac.": "这张卡片会以“自动”或“绕过权限”启动：请在 Mac 上启动它。",
    "Couldn't read the usage meter.": "没能读取用量。",
}  # fmt: skip
lang.add_texts(ZH)

# The isolated copy a phone's Land or Discard is for, while its card goes up (an approval sink
# reads it, in the same task: that card is then the phone's to show and answer).
_COPY: contextvars.ContextVar[str] = contextvars.ContextVar("code_phone_copy", default="")


def _int(value: Any) -> int:
    """A whole number at least 0 from a query or body (0 for anything else)."""
    if isinstance(value, bool):
        return 0
    try:
        return max(0, int(str(value if value is not None else 0)[:30]))
    except (TypeError, ValueError, OverflowError):
        return 0


def _updated(entry: dict[str, Any]) -> int:
    value = entry.get("updated")
    return value if type(value) is int else 0


def _line(text: Any, limit: int) -> str:
    return " ".join(str(text or "").split())[:limit]


def _signature(data: dict[str, Any]) -> str:
    raw = json.dumps(data, sort_keys=True, default=str, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


class CodePhone:
    """The page's state on the Mac: the session pinned for the phone, each session's live
    words, the cards a phone's Land or Discard put up, and a count of what happened (a
    waiting request looks again when it moves)."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.pinned: dict[str, Any] | None = None
        self.pushed: dict[str, Any] | None = None
        self.live: dict[int, str] = {}
        self.generation = 0
        self.waits: dict[str, int] = {}  # device id -> its requests waiting now
        self.copy_cards: dict[str, dict[str, Any]] = {}  # card id -> {slug, risky}
        self._qr: tuple[str, list[str]] = ("", [])
        hub.add_event_sink(HEARD, self._heard)
        hub.add_approval_sink(self._card_up, resolved=self._card_down)

    # ── what's heard ──

    def _heard(self, event: dict[str, Any]) -> None:
        kind, task_id = event.get("type"), event.get("id")
        if kind == "task_stream" and event.get("part") == "text" and isinstance(task_id, int):
            self.live[task_id] = (self.live.get(task_id, "") + str(event.get("text") or ""))[
                -LIVE_CHARS:
            ]
        elif kind == "task_log" and isinstance(task_id, int):
            entry = event.get("entry") if isinstance(event.get("entry"), dict) else {}
            if entry.get("role") == "assistant":  # (the reply's entry replaces its live words)
                self.live.pop(task_id, None)
        elif kind == "task_finished" and isinstance(task_id, int):
            self.live.pop(task_id, None)
        self.generation += 1

    def _card_up(self, card: dict[str, Any]) -> None:
        slug = _COPY.get()
        if not slug or not isinstance(card.get("id"), str):
            return
        desk = getattr(self.hub, "code_desk", None)
        anyway = desk.tr("Land anyway") if desk is not None else "Land anyway"
        labels = {str(c.get("label")) for c in card.get("choices") or [] if isinstance(c, dict)}
        self.copy_cards[card["id"]] = {
            "slug": slug,
            "risky": bool(labels & {"Land anyway", anyway}),
        }

    def _card_down(self, approval_id: str) -> None:
        self.copy_cards.pop(str(approval_id), None)
        self.generation += 1

    # ── words, the switch ──

    def tr(self, text: str, **values: Any) -> str:
        return lang.tr(text, getattr(self.hub, "language", "en"), **values)

    def on(self) -> bool:
        return self.hub.prefs.feature(PREF) is True

    # ── what a phone sees ──

    def session(self, value: Any) -> Any:
        task = self.hub.tasks.tasks.get(_int(value))
        return task if task is not None and task.kind == "code" else None

    def copy_of(self, task: Any) -> Any:
        desk = getattr(self.hub, "code_desk", None)
        if desk is None:
            return None
        try:
            return desk._copy_of(task)
        except Exception:  # (its list unreadable: no copy to offer)
            log.warning("Eden Code phone: couldn't look up a session's copy", exc_info=True)
            return None

    def mac_only(self, card: dict[str, Any]) -> bool:
        """A card the phone may only say no to: one only the Mac's window answers, or a
        Land that would commit what looks like a secret."""
        from .code_touchid import mac_only

        return mac_only(card) or bool(self.copy_cards.get(str(card.get("id")), {}).get("risky"))

    def card(self, card: dict[str, Any]) -> dict[str, Any]:
        from ..companion_api import public_approval

        shown = public_approval(card)
        shown["mac_only"] = self.mac_only(card)
        copy = self.copy_cards.get(str(card.get("id")))
        if copy is not None:
            shown["copy"] = copy["slug"]
        return shown

    def is_code_card(self, card: dict[str, Any]) -> bool:
        return bool(card.get("task_id")) or str(card.get("id")) in self.copy_cards

    def cards_for(self, task: Any) -> list[dict[str, Any]]:
        copy = self.copy_of(task)
        slug = getattr(copy, "slug", "") if copy is not None else ""
        found = []
        for card in list(self.hub.approvals.values()):
            mine = card.get("task_id") == task.id
            mine = mine or (
                slug and self.copy_cards.get(str(card.get("id")), {}).get("slug") == slug
            )
            if mine:
                found.append(self.card(card))
        return found

    def attention(self) -> list[dict[str, Any]]:
        """Every card that waits on the owner in Eden Code, newest last."""
        return [self.card(c) for c in list(self.hub.approvals.values()) if self.is_code_card(c)]

    def summary(self, task: Any, waiting: set[int]) -> dict[str, Any]:
        from ..companion_api import session_status
        from ..tasks import MODE_LABELS

        return {
            "id": task.id,
            "title": _line(task.title or task.prompt, 120),
            "project": task.cwd.name,
            "status": session_status(task, task.id in waiting),
            "mode": task.mode,
            "mode_label": MODE_LABELS.get(task.mode, task.mode),
            "model": task.model_label or task.model or self.hub.tasks.model or "",
            "cost_usd": task.cost_usd,
            "updated_at": (task.transcript[-1].get("at") if task.transcript else "")
            or task.started.isoformat(timespec="seconds"),
        }

    def home(self) -> dict[str, Any]:
        cards = self.attention()
        waiting = {c["task_id"] for c in cards if c.get("task_id")}
        tasks = sorted(
            (t for t in self.hub.tasks.tasks.values() if t.kind == "code"), key=lambda t: -t.id
        )[:SESSIONS_SHOWN]
        pinned = self.pinned if self.pinned and self.session(self.pinned["id"]) else None
        return {
            "sessions": [self.summary(t, waiting) for t in tasks],
            "attention": cards,
            "pinned": pinned,
            "exterminator": self.exterminator(),
        }

    def exterminator(self) -> list[dict[str, Any]]:
        """Exterminator Mode's runs, newest first: where each is and what it found."""
        bugfix = getattr(self.hub, "code_bugfix", None)
        if bugfix is None:
            return []
        try:
            bugfix.load()
            runs = list(bugfix.runs)[-RUNS_SHOWN:]
        except Exception:
            log.warning("Eden Code phone: couldn't read Exterminator Mode's runs", exc_info=True)
            return []
        out = []
        for run in reversed(runs):
            findings = list(run.findings)
            out.append({
                "id": run.id, "project": run.project, "state": run.state, "why": run.why,
                "round": run.round, "rounds": run.rounds, "step": run.step,
                "spent": round(float(run.spent or 0), 2),
                "spend_cap": round(float(run.spend_cap or 0), 2),
                "task_id": run.task_id or None,
                "found": len(findings),
                "fixed": sum(1 for f in findings if f.status == "fixed"),
                "open": sum(1 for f in findings if f.status in ("open", "verified", "failing")),
                "landed": bool(run.landed),
            })  # fmt: skip
        return out

    def view(self, task: Any, after: int, seen: int) -> dict[str, Any]:
        """What a phone that has the entries up to after, as they were at update seen, needs:
        the next ENTRIES_AT_ONCE entries, the ones up to after that changed since seen (a
        step's outcome and output come after its entry: tasks._tool_result marks it
        "updated"), the streamed words, the status, its cards and its copy; v says all of it
        but the entries, so a phone that has it all is answered only once something moves."""
        from ..companion_api import _entry, session_status
        from ..tasks import MODE_LABELS

        transcript = list(task.transcript)
        found = [e for e in transcript if _int(e.get("n")) > after]
        page = found[:ENTRIES_AT_ONCE]
        changed = [e for e in transcript if _int(e.get("n")) <= after and _updated(e) > seen][
            -UPDATES_AT_ONCE:
        ]
        latest = max([seen, *(_updated(e) for e in transcript)])
        cards = self.cards_for(task)
        copy = self.copy_of(task)
        body: dict[str, Any] = {
            "id": task.id,
            "title": _line(task.title or task.prompt, 120),
            "project": task.cwd.name,
            "status": session_status(task, any(c.get("task_id") == task.id for c in cards)),
            "doing": _line(task.last_action, 200) if task.busy else "",
            "mode": task.mode,
            "mode_label": MODE_LABELS.get(task.mode, task.mode),
            "model": task.model_ref or "",
            "model_label": task.model_label or task.model or "",
            "live": self.live.get(task.id, "") if task.busy else "",
            "todos": [
                {"text": _line(t.get("content"), 300), "done": t.get("status") == "completed"}
                for t in task.todos
            ],
            "cards": cards,
            "copy": (
                {"branch": copy.branch, "into": copy.into, "busy": bool(task.busy)}
                if copy is not None
                else None
            ),
            "next": _int(page[-1].get("n")) if page else after,
            "seen": latest,
        }
        body["v"] = _signature(body)
        body["entries"] = [x for x in (_entry(e) for e in page) if x is not None]
        body["changed"] = [x for x in (_entry(e) for e in changed) if x is not None]
        body["more"] = len(found) > len(page)
        return body

    async def watch(self, task_id: int, after: int, seen: int, known: str, wait: float) -> Any:
        """view(), at once when there's something the phone hasn't got; else once something
        moves, or after wait seconds. None: the session went meanwhile."""
        deadline = time.monotonic() + max(0.0, min(wait, WAIT_MOST))
        while True:
            task = self.session(task_id)
            if task is None:
                return None
            generation = self.generation
            view = self.view(task, after, seen)
            if view["v"] != known or view["entries"] or view["changed"]:
                return view
            while self.generation == generation and time.monotonic() < deadline:
                await asyncio.sleep(STIR_CHECK)
            if self.generation == generation:
                return view  # (time's up, nothing new)

    # ── the Mac's side: hand off ──

    def url(self, session_id: int | None = None) -> str:
        """The page's address on this Mac's network ("" while the companion is off)."""
        from ..remote import lan_address

        remote = getattr(self.hub, "remote", None)
        if remote is None or not getattr(remote, "running", False):
            return ""
        public = os.environ.get("JARVIS_PUBLIC_HOST", "").strip()
        host = public or (f"{remote.host_name}.local" if remote.host_name else lan_address() or "")
        if not host:
            return ""
        tail = f"#s={session_id}" if session_id else ""
        return f"https://{host}:{remote.port}/code/{tail}"

    async def publish(self) -> None:
        from .. import qr

        url = self.url() if self.on() else ""
        if url and self._qr[0] != url:
            try:
                self._qr = (url, qr.rows(await asyncio.to_thread(qr.encode, url)))
            except Exception:
                log.warning("Eden Code phone: no QR code for the link", exc_info=True)
                self._qr = (url, [])
        remote = getattr(self.hub, "remote", None)
        identity = getattr(remote, "identity", None)
        pinned = self.pinned if self.pinned and self.session(self.pinned["id"]) else None
        self.hub.emit(
            "code_phone",
            on=self.on(),
            running=bool(getattr(remote, "running", False)),
            url=url,
            qr=self._qr[1] if url and self._qr[0] == url else [],
            short=getattr(identity, "short", "") if identity is not None else "",
            pinned=pinned,
            pushed=self.pushed,
        )

    async def cmd_state(self, _msg: dict[str, Any]) -> None:
        await self.publish()

    async def cmd_unpin(self, _msg: dict[str, Any]) -> None:
        self.pinned = None
        self.generation += 1
        await self.publish()

    async def cmd_handoff(self, msg: dict[str, Any]) -> None:
        from ..hub import _msg_int

        task = self.session(_msg_int(msg, "id"))
        if task is None:
            self.hub.emit("error", text=self.tr("Open a session to hand it off."))
            return
        self.pinned = {
            "id": task.id,
            "title": _line(task.title or task.prompt, 120),
            "at": int(time.time() * 1000),
        }
        self.generation += 1
        sent, said = await self.push(task)
        self.pushed = {"id": task.id, "sent": sent, "said": said}
        self.hub.emit("caption", text=said)
        await self.publish()

    async def push(self, task: Any) -> tuple[int, str]:
        """The handoff's push to every phone registered for Eden's notifications, now: how
        many it went to, and what to tell the owner."""
        from ..companion_push import Note

        remote = getattr(self.hub, "remote", None)
        companion = getattr(remote, "extension", None)
        notifier = getattr(companion, "notifier", None)
        if notifier is None or not getattr(remote, "running", False):
            return 0, self.tr(
                "Pinned for your phone. Turn on the phone companion in Settings › iPhone & Watch to reach it."
            )
        note = Note(
            kind="code_done",  # (today's iPhone app opens the session from a code push)
            ident=f"handoff:{task.id}",
            title=self.tr("Carry on from your phone"),
            body=self.tr("In {folder}", folder=_line(task.cwd.name, 60)),
            setting="code",
            thread=f"code-{task.id}",
            collapse=f"handoff-{task.id}",
            task_id=task.id,
            ttl=3600,
            extra={
                "handoff": True,
                "link": f"jarvis-companion://code/{task.id}",
                "url": self.url(task.id) if self.on() else "",
            },
        )
        try:
            outcome = await notifier.deliver(note, asked=True)
        except Exception:
            log.warning("Eden Code phone: the handoff's push failed", exc_info=True)
            outcome = {}
        sent = sum(1 for v in outcome.values() if v == "sent")
        if sent:
            return sent, self.tr("Handed off to your phone.")
        return 0, self.tr(
            "Pinned for your phone. No phone gets Eden's notifications yet: open the link on it."
        )

    # ── the routes on the companion's server ──

    def routes(self, gate: Any) -> list[Any]:
        from ._code_phone_routes import routes

        return routes(self, gate)


def install(hub: Any) -> None:
    phone = CodePhone(hub)
    hub.code_phone = phone  # (for the tests)
    extra = getattr(hub, "remote_routes", None)
    hub.remote_routes = [*(extra if isinstance(extra, list) else []), phone.routes]
    hub.register_command("code_phone_state", phone.cmd_state)
    hub.register_command("code_phone_handoff", phone.cmd_handoff, slow=True)  # (a push)
    hub.register_command("code_phone_unpin", phone.cmd_unpin)
