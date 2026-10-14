"""Eden Code's Share live (Labs): a read-only live view of one session for a teammate, by
a link, through the phone companion's own server (remote.py: HTTPS with the Mac's own
certificate, on the network the Mac is on).

The owner presses Share live on a session: a link with a long random token is made
(https://<this Mac>.local:8765/share/<token>), good for the time they pick (15 minutes
to a day) or until they revoke it, and only while the app runs (shares are kept in memory,
never on disk). Whoever opens it sees the session as it goes: its transcript (the
thinking left out), what it changed (its Changes view, hunk by hunk) and its status. Never
anything else: no other session, no files, no cards, no way to act. The owner sees how many
are watching each share right now.

Everything a viewer gets goes through the redactors first: the session's own (tasks.redact:
a secret given to a session, as its $NAME), then share-safe export's (code_export.redact_
secrets: keys, tokens, passwords), then where things are on this Mac (code_export.
Anonymizer: the project's path, the home folder, the user's name). In the changes, a line
secret_scan flags is withheld whole, and a credentials or binary file is listed without its
lines.

Phase 2, behind its own switch (code_share_comments, off): a share made with suggestions
on lets its viewers post a comment or a suggestion. It arrives as a card for the owner in
the Share pane (and a caption), never as a message to the session: the owner reads it,
and copies it into the composer or dismisses it. Viewers still can't act on anything.

The link works on the Mac's own network. Outside it, it needs askeden.com's relay to carry
viewers too: docs/eden-code-shared-sessions.md (the site is frozen until then).

Window commands: code_share_start {id, minutes?, comments?}, code_share_revoke {share},
code_share_state {}, code_share_dismiss {share, comment}.
Events: code_share {shares: [{share, id, title, url, expires, viewers, comments_on,
comments}], error?}, code_share_comment {share, id, comment}.
HTTP (remote.py's server, its own checks: the share's token, never a device's):
GET /share/<token> (the page), GET /share/<token>/state?v=<viewer>&since=<n>&ck=<key>,
POST /share/<token>/comment {v, name?, text} (only with suggestions on).
Settings (prefs.features): code_share_comments (bool, off).

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import code_changes, lang, prefs, secret_scan
from ..code_export import Anonymizer, redact_secrets
from ..hub import _msg_int
from ..textclean import clean_text

PREF_COMMENTS = "code_share_comments"
prefs.register_feature_pref(PREF_COMMENTS, False)

MINUTES = (15, 60, 240, 1440)
DEFAULT_MINUTES = 60
MAX_SHARES = 10  # live at once, every session together
MAX_VIEWERS = 20  # watching one share at once
VIEWER_SECONDS = 15.0  # a viewer not heard from this long has gone
LOOK_SECONDS = 5.0  # how often the owner's viewer counts are looked at
ENTRIES_AT_ONCE = 200
ENTRY_CHARS = 4000
OUTPUT_CHARS = 1500
CHANGES_SECONDS = 3.0  # a session's changes are worked out at most this often per share
SHARE_FILES = 100
SHARE_LINES = 4000
MAX_COMMENTS = 50  # kept per share
COMMENT_CHARS = 2000
NAME_CHARS = 40
WITHHELD = "(withheld: it looks like a secret)"
ROLES = {"user", "assistant", "tool", "system", "note", "plan", "turn"}
_VIEWER = re.compile(r"[A-Za-z0-9_-]{8,40}")
_TOKEN = re.compile(r"[A-Za-z0-9_-]{20,64}")
RATES = {"view": (90, 20), "comment": (6, 2)}  # a minute's worth, the most at once
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

ZH = {
    "Open a session to share it.": "打开一个会话才能分享它。",
    "Turn on the phone companion in Settings first: the share link is served by it.": "请先在设置里打开手机伴侣：分享链接由它提供。",
    "There are already {n} live shares; revoke one first.": "已经有 {n} 个实时分享了；请先撤销一个。",
    "This Mac has no address on the network, so there's no link to give.": "这台 Mac 在网络上没有地址，所以给不出链接。",
    "Turn on suggestions from viewers in the Share pane first.": "请先在分享面板里打开“允许观看者提建议”。",
    "{name} left a suggestion on {title}.": "{name} 在 {title} 上留了一条建议。",
}
lang.add_texts(ZH)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class Share:
    id: str
    task_id: int
    token: str  # kept in memory only, for the owner to copy the link again
    created: float
    expires: float
    comments_on: bool = False
    revoked: bool = False
    viewers: dict[str, float] = field(default_factory=dict)  # viewer -> last heard (monotonic)
    comments: list[dict[str, Any]] = field(default_factory=list)
    changes: tuple[float, str, Any] = (0.0, "", None)  # (when, key, the view) cached

    def live(self, now: float | None = None) -> bool:
        return not self.revoked and (now if now is not None else time.time()) < self.expires

    def watching(self, now: float | None = None) -> int:
        now = time.monotonic() if now is None else now
        for viewer, seen in list(self.viewers.items()):
            if now - seen > VIEWER_SECONDS:
                del self.viewers[viewer]
        return len(self.viewers)


class Limiter:
    """remote.Limiter's buckets, keyed by share and viewer (it keys by device)."""

    def __init__(self) -> None:
        from ..remote import Limiter as Buckets

        self.buckets = Buckets(RATES)

    def wait(self, key: str, kind: str) -> float:
        return self.buckets.wait(key, kind)


class Shares:
    """One hub's live shares."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.shares: dict[str, Share] = {}  # share id -> share
        self.by_hash: dict[str, str] = {}  # the token's hash -> share id
        self.limiter = Limiter()
        self._looking: asyncio.Task | None = None
        self._counts: dict[str, int] = {}  # what the windows were last told

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    # ── the owner's side ──

    def url_for(self, share: Share) -> str:
        """The link: the Mac's .local name (its address when it has none) and the
        companion server's port."""
        from ..remote import lan_address

        remote = self.hub.remote
        host = f"{remote.host_name}.local" if remote.host_name else (lan_address() or "")
        return f"https://{host}:{remote.port}/share/{share.token}" if host else ""

    def public(self) -> list[dict[str, Any]]:
        self.prune()
        out = []
        for share in self.shares.values():
            task = self.hub.tasks.tasks.get(share.task_id)
            title = (task.title or task.prompt) if task is not None else ""
            identity = getattr(self.hub.remote, "identity", None)
            out.append(
                {
                    "share": share.id,
                    "id": share.task_id,
                    "title": " ".join(title.split())[:120],
                    "url": self.url_for(share),
                    "fingerprint": identity.short if identity is not None else "",
                    "created": share.created,
                    "expires": share.expires,
                    "viewers": share.watching(),
                    "comments_on": share.comments_on,
                    "comments": list(share.comments),
                }
            )
        return out

    def publish(self, **extra: Any) -> None:
        shares = self.public()
        self._counts = {s["share"]: s["viewers"] for s in shares}
        self.hub.emit("code_share", shares=shares, comments_allowed=self.comments_allowed(),
                      **extra)  # fmt: skip

    def comments_allowed(self) -> bool:
        return self.hub.prefs.feature(PREF_COMMENTS) is True

    def prune(self) -> None:
        now = time.time()
        for share in [s for s in self.shares.values() if not s.live(now)]:
            self.shares.pop(share.id, None)
            self.by_hash.pop(_hash(share.token), None)

    def cmd_state(self, _msg: dict[str, Any]) -> None:
        self.publish()

    def cmd_start(self, msg: dict[str, Any]) -> None:
        said = self.start(msg)
        if said:
            self.publish(error=self.tr(said))
        else:
            self.publish()

    def start(self, msg: dict[str, Any]) -> str:
        """A new share of one session: "" when made, else why not."""
        task = self.hub.tasks.tasks.get(_msg_int(msg, "id"))
        if task is None or task.kind != "code":
            return "Open a session to share it."
        remote = getattr(self.hub, "remote", None)
        if remote is None or not remote.running:
            return "Turn on the phone companion in Settings first: the share link is served by it."
        self.prune()
        if len(self.shares) >= MAX_SHARES:
            return f"There are already {len(self.shares)} live shares; revoke one first."
        comments = msg.get("comments") is True
        if comments and not self.comments_allowed():
            return "Turn on suggestions from viewers in the Share pane first."
        try:
            minutes = int(msg.get("minutes") or DEFAULT_MINUTES)
        except (TypeError, ValueError, OverflowError):
            minutes = DEFAULT_MINUTES
        minutes = minutes if minutes in MINUTES else DEFAULT_MINUTES
        now = time.time()
        share = Share(
            id=secrets.token_hex(4),
            task_id=task.id,
            token=secrets.token_urlsafe(24),
            created=now,
            expires=now + minutes * 60,
            comments_on=comments,
        )
        if not self.url_for(share):
            return "This Mac has no address on the network, so there's no link to give."
        self.shares[share.id] = share
        self.by_hash[_hash(share.token)] = share.id
        self._look_soon()
        return ""

    def cmd_revoke(self, msg: dict[str, Any]) -> None:
        self.revoke(str(msg.get("share") or ""))
        self.publish()

    def revoke(self, share_id: str) -> bool:
        share = self.shares.pop(share_id, None)
        if share is None:
            return False
        share.revoked = True
        self.by_hash.pop(_hash(share.token), None)
        return True

    def cmd_dismiss(self, msg: dict[str, Any]) -> None:
        share = self.shares.get(str(msg.get("share") or ""))
        if share is not None:
            wanted = str(msg.get("comment") or "")
            share.comments = [c for c in share.comments if c["id"] != wanted]
        self.publish()

    def _look_soon(self) -> None:
        if self._looking is None or self._looking.done():
            self._looking = self.hub._spawn(self._look())

    async def _look(self) -> None:
        """While any share is live: the windows hear when a share's viewer count changes
        (a viewer gone quiet included) or a share ends by itself."""
        while self.shares:
            await asyncio.sleep(LOOK_SECONDS)
            before = dict(self._counts)
            self.prune()
            now = {s.id: s.watching() for s in self.shares.values()}
            if now != before:
                self.publish()

    # ── the viewer's side ──

    def find(self, token: str) -> Share | None:
        if not _TOKEN.fullmatch(token or ""):
            return None
        share_id = self.by_hash.get(_hash(token))
        share = self.shares.get(share_id or "")
        if share is None or not share.live():
            return None
        task = self.hub.tasks.tasks.get(share.task_id)
        return share if task is not None else None

    def clean(self, task: Any, text: Any, limit: int = ENTRY_CHARS) -> str:
        """Text for a viewer: the session's redactors, share-safe's, and this Mac's paths."""
        text = str(text or "")[: limit * 2]
        text = self.hub.tasks.redact(task, text)
        text = redact_secrets(text)
        text = Anonymizer.for_session(task.cwd)(text)
        return text[:limit]

    def entries(self, task: Any, since: int) -> list[dict[str, Any]]:
        """The transcript after entry since (its last ENTRIES_AT_ONCE), cleaned."""
        out = []
        found = [e for e in list(task.transcript) if int(e.get("n") or 0) > since]
        for e in found[-ENTRIES_AT_ONCE:]:
            role = str(e.get("role") or "")
            if role not in ROLES:
                continue  # (the thinking, and anything this build doesn't know)
            item: dict[str, Any] = {
                "n": int(e.get("n") or 0),
                "role": role,
                "text": self.clean(task, e.get("text")),
                "at": str(e.get("at") or "")[:25],
            }
            if role == "tool":
                item["tool"] = self.clean(task, e.get("tool"), 80)
                item["status"] = str(e.get("status") or "")[:20]
                if e.get("output"):
                    item["output"] = self.clean(task, e.get("output"), OUTPUT_CHARS)
            out.append(item)
        return out

    def status(self, task: Any) -> dict[str, Any]:
        from ..companion_api import session_status

        waiting = any(a.get("task_id") == task.id for a in list(self.hub.approvals.values()))
        return {
            "title": self.clean(task, " ".join((task.title or task.prompt).split()), 120),
            "project": task.cwd.name,
            "status": session_status(task, waiting),
            "doing": self.clean(task, task.last_action, 200) if task.busy else "",
            "model": self.clean(task, task.model_label or task.model, 60),
        }

    async def changes(self, share: Share, task: Any) -> tuple[str, Any]:
        """The session's changes for a viewer, and a key for them (a viewer that has these
        already isn't sent them again): worked out at most every CHANGES_SECONDS."""
        when, key, found = share.changes
        if time.monotonic() - when < CHANGES_SECONDS and key:
            return key, found
        view = await asyncio.to_thread(code_changes.task_view, task, "session")
        found = self.view_for_viewer(task, view)
        key = hashlib.sha1(json.dumps(found, sort_keys=True).encode()).hexdigest()[:16]
        share.changes = (time.monotonic(), key, found)
        return key, found

    def view_for_viewer(self, task: Any, view: code_changes.View | None) -> dict[str, Any]:
        if view is None:
            return {"git": False, "files": [], "totals": {}}
        files = []
        budget = SHARE_LINES
        for number, f, h in view.numbered():
            shown = self.clean(task, view.repo.shown(f.path), 300)
            item = next((x for x in files if x["path"] == shown), None)
            if item is None:
                item = {"path": shown, "status": f.status, "added": f.added,
                        "removed": f.removed, "withheld": f.sensitive or f.binary,
                        "hunks": []}  # fmt: skip
                if len(files) >= SHARE_FILES:
                    break
                files.append(item)
            if item["withheld"] or budget <= 0:
                continue
            lines = []
            for tag, text in h.lines[:budget]:
                if tag == "\\":
                    continue
                if secret_scan.scan_line(text):
                    lines.append([tag, WITHHELD])
                else:
                    lines.append([tag, self.clean(task, text, 500)])
            budget -= len(lines)
            item["hunks"].append({"n": number, "line": h.first_changed,
                                  "where": self.clean(task, h.where, 120), "lines": lines})  # fmt: skip
        for f in view.files:  # credentials and binary files have no numbered hunks
            shown = self.clean(task, view.repo.shown(f.path), 300)
            if (f.sensitive or f.binary) and not any(x["path"] == shown for x in files):
                if len(files) < SHARE_FILES:
                    files.append({"path": shown, "status": f.status, "added": f.added,
                                  "removed": f.removed, "withheld": True, "hunks": []})  # fmt: skip
        return {
            "git": True,
            "files": files,
            "totals": {
                "files": len(view.files),
                "added": sum(f.added for f in view.files),
                "removed": sum(f.removed for f in view.files),
            },
        }

    def heard(self, share: Share, viewer: str) -> bool:
        """A viewer counted as watching (False: the share has as many as it takes)."""
        if viewer not in share.viewers and share.watching() >= MAX_VIEWERS:
            return False
        fresh = viewer not in share.viewers
        share.viewers[viewer] = time.monotonic()
        if fresh:
            self.publish()
        return True

    def comment(self, share: Share, viewer: str, name: Any, text: Any) -> dict[str, Any] | str:
        """A viewer's suggestion, as a card for the owner (never a message to the session)."""
        task = self.hub.tasks.tasks.get(share.task_id)
        if task is None:
            return "gone"
        if not share.comments_on or not self.comments_allowed():
            return "off"
        words = clean_text(str(text or "")).strip()[:COMMENT_CHARS]
        if not words:
            return "empty"
        who = " ".join(clean_text(str(name or "")).split())[:NAME_CHARS] or "A viewer"
        card = {
            "id": secrets.token_hex(4),
            "name": who,
            "text": words,
            "at": time.time(),
            "viewer": hashlib.sha256(viewer.encode()).hexdigest()[:8],
        }
        share.comments = [*share.comments, card][-MAX_COMMENTS:]
        self.hub.emit("code_share_comment", share=share.id, id=share.task_id, comment=card)
        title = " ".join((task.title or task.prompt).split())[:60] or "a session"
        self.hub.emit("caption", text=lang.tr("{name} left a suggestion on {title}.",
                                              self.hub.language, name=who, title=title))  # fmt: skip
        self.publish()
        return card

    # ── the routes on the companion's server ──

    def routes(self, gate: Any) -> list[Any]:
        from starlette.responses import Response
        from starlette.routing import Route

        from ..remote import JSONResponse

        headers = {
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",  # (the token is in the address)
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": (
                "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
                "img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
            ),
        }

        def gone() -> Any:
            return JSONResponse(
                {"error": "This share isn't live: it ended, was revoked, or never was."},
                status_code=404,
                headers=headers,
            )

        def viewer_of(request: Any) -> str:
            viewer = str(request.query_params.get("v") or "")
            return viewer if _VIEWER.fullmatch(viewer) else ""

        def limited(share: Share, viewer: str, kind: str) -> Any:
            wait = self.limiter.wait(f"{share.id}:{viewer}", kind)
            if not wait:
                return None
            return JSONResponse(
                {"error": "Too many requests. Try again in a moment."},
                status_code=429,
                headers={**headers, "Retry-After": str(max(1, round(wait)))},
            )

        def asset(name: str, media_type: str):
            async def serve(_request: Any) -> Any:
                return Response((WEB_DIR / name).read_bytes(), media_type=media_type,
                                headers=headers)  # fmt: skip

            return serve

        async def page(request: Any) -> Any:
            if self.find(str(request.path_params.get("token") or "")) is None:
                return Response(
                    (WEB_DIR / "share-gone.html").read_bytes(), status_code=404,
                    media_type="text/html", headers=headers,
                )  # fmt: skip
            return Response((WEB_DIR / "share.html").read_bytes(), media_type="text/html",
                            headers=headers)  # fmt: skip

        async def state(request: Any) -> Any:
            share = self.find(str(request.path_params.get("token") or ""))
            viewer = viewer_of(request)
            if share is None:
                return gone()
            if not viewer:
                return JSONResponse({"error": "viewer"}, status_code=400, headers=headers)
            refused = limited(share, viewer, "view")
            if refused is not None:
                return refused
            if not self.heard(share, viewer):
                return JSONResponse({"error": "This share has as many viewers as it takes."},
                                    status_code=429, headers=headers)  # fmt: skip
            task = self.hub.tasks.tasks[share.task_id]
            try:
                since = max(0, int(request.query_params.get("since") or 0))
            except (TypeError, ValueError, OverflowError):
                since = 0
            key, found = await self.changes(share, task)
            known = str(request.query_params.get("ck") or "")
            return JSONResponse(
                {
                    **self.status(task),
                    "entries": self.entries(task, since),
                    "changes_key": key,
                    "changes": None if known == key else found,
                    "expires": share.expires,
                    "comments": share.comments_on and self.comments_allowed(),
                },
                headers=headers,
            )

        async def comment(request: Any) -> Any:
            share = self.find(str(request.path_params.get("token") or ""))
            if share is None:
                return gone()
            data = await gate.json(request, cap=COMMENT_CHARS * 4 + 1000)
            if data is None:
                return gate.too_big()
            viewer = str(data.get("v") or "")
            if not _VIEWER.fullmatch(viewer):
                return JSONResponse({"error": "viewer"}, status_code=400, headers=headers)
            if not share.comments_on or not self.comments_allowed():
                return JSONResponse({"error": "Suggestions are off for this share."},
                                    status_code=403, headers=headers)  # fmt: skip
            refused = limited(share, viewer, "comment")
            if refused is not None:
                return refused
            card = self.comment(share, viewer, data.get("name"), data.get("text"))
            if card == "empty":
                return JSONResponse({"error": "Write something first."}, status_code=400,
                                    headers=headers)  # fmt: skip
            if not isinstance(card, dict):
                return gone()
            return JSONResponse({"ok": True}, headers=headers)

        return [
            Route("/share.js", asset("share.js", "text/javascript")),
            Route("/share.css", asset("share.css", "text/css")),
            Route("/share/{token}", page),
            Route("/share/{token}/state", state),
            Route("/share/{token}/comment", comment, methods=["POST"]),
        ]


def install(hub: Any) -> None:
    shares = Shares(hub)
    hub.code_share = shares  # (for the tests)
    extra = getattr(hub, "remote_routes", None)
    hub.remote_routes = [*(extra if isinstance(extra, list) else []), shares.routes]
    hub.register_command("code_share_start", shares.cmd_start)
    hub.register_command("code_share_revoke", shares.cmd_revoke)
    hub.register_command("code_share_state", shares.cmd_state)
    hub.register_command("code_share_dismiss", shares.cmd_dismiss)
