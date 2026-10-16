"""Share live's roles and co-control (docs/eden-code-shared-sessions.md, phase 4): personal
links with a role each, and what a teammate with one may ask of the session. Part of Share
live (Labs); code_share.py's routes and code_share_live.py's relay both come through here,
so the same checks hold on the Mac's network and through askeden.com.

The share's own link (phase 1) is a viewer's: anyone holding it watches. A personal link
(an invite) is made for one person by name (the owner's words, or a team member's: code_
teams.py), with a role:
- viewer: watches;
- commenter: also sends suggestions, as cards for the owner (phase 2; needs Let viewers send
  suggestions on);
- driver: also asks for a message to the session or an answer to one of its questions (needs
  Let drivers ask on, code_share_drivers, off by default).

What a driver sends is still never a message to the session by itself: it arrives as a card
in the Share pane naming who sent it, and the owner's tap sends it as the owner's own
(Send), or puts it in the composer to edit (Copy), or drops it. An answer to a question goes
through the window's own answer (jarvisFeatures.answerApproval), so Touch ID asks for a
risky step exactly as on its card; the window says how it went (code_share_settle). A message
that starts with "!" (a shell command) or "/" (a command) only ever offers Copy.

A trusted driver (the invite's trusted, and code_share_trusted_drivers on, off by default)
skips the tap for plain messages only: never an answer to a question, never "!" or "/", never
while the session is in Bypass permissions.

Every check is made again on each thing sent, from what holds now (the invite revoked, the
share ended, a switch turned off, the member removed from their team or moved down a role),
never from what held when the link was made, and once more when the owner taps Send. Every
request, and what the owner did with it, is attributed (the invite's name and role) and kept
in the share's log (the Share pane) and the companion's audit log (Settings › iPhone: who,
what kind, the session's number, never the words).

A personal link's secret: on the Mac's network, the link's own token (looked up by its
SHA-256, as the share's); through askeden.com, "<invite id>.<secret>" in the link's fragment,
sent back inside each sealed message (askeden.com never sees it), checked against its SHA-256.

Settings (prefs.features): code_share_drivers (bool, off), code_share_trusted_drivers (bool, off).

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

from .. import lang, prefs
from ..textclean import clean_text
from .code_teams import SHARE_ROLES, lower_role, share_rank

PREF_DRIVERS = "code_share_drivers"
PREF_TRUSTED = "code_share_trusted_drivers"
prefs.register_feature_pref(PREF_DRIVERS, False)
prefs.register_feature_pref(PREF_TRUSTED, False)

MAX_INVITES = 20  # per share
MAX_REQUESTS = 30  # waiting per share
LOG_KEPT = 100  # per share
TEXT_CHARS = 2000
NAME_CHARS = 40
REQUEST_KINDS = ("message", "approve")
_INVITE_ID = re.compile(r"[0-9a-f]{8}")
_SECRET = re.compile(r"[A-Za-z0-9_-]{20,64}")
# What the companion's audit log calls each (companion.ACTIONS has their words).
AUDIT = {
    "asked_message": "share_asked_message",
    "asked_approve": "share_asked_approve",
    "sent": "share_sent",
    "answered": "share_answered",
    "dismissed": "share_dismissed",
    "trusted_sent": "share_trusted_sent",
}

ZH = {
    "Turn on Let drivers ask in the Share pane first.": "请先在分享面板里打开“允许驾驶员提出请求”。",
    "Turn on suggestions from viewers in the Share pane first.": "请先在分享面板里打开“允许观看者提建议”。",
    "Trusted drivers are off in the Share pane.": "分享面板里的“受信任的驾驶员”已关闭。",
    "There are already {n} personal links on this share.": "这个分享已经有 {n} 个个人链接了。",
    "Give them a name.": "请给对方起个名字。",
    "{name} asked to send a message to {title}.": "{name} 请求向 {title} 发送一条消息。",
    "{name} suggested an answer on {title}.": "{name} 为 {title} 建议了一个回答。",
    "That request is gone.": "这个请求已经不在了。",
    "Copy it into the composer to send it yourself: it starts with ! or /.": "它以 ! 或 / 开头：请复制到输入框里自己发送。",
    "{name} can't ask for that any more.": "{name} 已经不能再提出这样的请求了。",
}
lang.add_texts(ZH)


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _name(value: Any) -> str:
    return " ".join(clean_text(str(value or "")).split())[:NAME_CHARS]


@dataclass
class Invite:
    """One person's link to one share."""

    id: str
    name: str
    role: str
    token: str  # the link's token on the Mac's network (in memory only, to copy it again)
    secret: str  # the secret in the internet link's fragment (in memory only)
    created: float
    team: str = ""
    member: str = ""
    trusted: bool = False
    revoked: bool = False
    used: float = 0.0  # when first opened

    @property
    def secret_hash(self) -> str:
        return _hash(self.secret)

    def public(self, role_now: str) -> dict[str, Any]:
        return {
            "invite": self.id,
            "name": self.name,
            "role": self.role,
            "role_now": role_now,  # what it may do now ("" none: removed, revoked)
            "team": self.team,
            "member": self.member,
            "trusted": self.trusted,
            "used": self.used,
        }


@dataclass
class Seat:
    """What a share keeps for co-control (Share.drive)."""

    invites: dict[str, Invite] = field(default_factory=dict)
    requests: list[dict[str, Any]] = field(default_factory=list)
    log: list[dict[str, Any]] = field(default_factory=list)


class Drive:
    """Roles and requests for one hub's shares (shares: code_share.Shares)."""

    def __init__(self, shares: Any) -> None:
        self.shares = shares
        self.hub = shares.hub
        self.by_token: dict[str, tuple[str, str]] = {}  # the token's hash -> (share, invite)

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    def feature(self, key: str) -> bool:
        return self.hub.prefs.feature(key) is True

    @property
    def teams(self) -> Any:
        return getattr(self.hub, "code_teams", None)

    # ── invites ──

    def invite(self, share: Any, msg: dict[str, Any]) -> Invite | str:
        """A personal link on a share: by a team member (their name and the most their team
        role lets them be) or by a name the owner types."""
        seat: Seat = share.drive
        live = [i for i in seat.invites.values() if not i.revoked]
        if len(live) >= MAX_INVITES:
            return f"There are already {len(live)} personal links on this share."
        role = msg.get("role") if msg.get("role") in SHARE_ROLES else "viewer"
        team_id, member_id, name = str(msg.get("team") or ""), str(msg.get("member") or ""), ""
        if team_id or member_id:
            member = self.teams.member(team_id, member_id) if self.teams is not None else None
            if member is None:
                return "That member is gone."
            name = member["name"]
            role = lower_role(role, member["share_role"]) or "viewer"
        else:
            name = _name(msg.get("name"))
        if not name:
            return "Give them a name."
        if role == "driver" and not self.feature(PREF_DRIVERS):
            return "Turn on Let drivers ask in the Share pane first."
        if role == "commenter" and not self.shares.comments_allowed():
            return "Turn on suggestions from viewers in the Share pane first."
        trusted = msg.get("trusted") is True and role == "driver"
        if trusted and not self.feature(PREF_TRUSTED):
            return "Trusted drivers are off in the Share pane."
        invite = Invite(
            id=secrets.token_hex(4),
            name=name,
            role=role,
            token=secrets.token_urlsafe(24),
            secret=secrets.token_urlsafe(24),
            created=time.time(),
            team=team_id,
            member=member_id,
            trusted=trusted,
        )
        seat.invites[invite.id] = invite
        self.by_token[_hash(invite.token)] = (share.id, invite.id)
        return invite

    def revoke(self, share: Any, invite_id: str) -> bool:
        invite = share.drive.invites.get(invite_id)
        if invite is None or invite.revoked:
            return False
        invite.revoked = True
        self.by_token.pop(_hash(invite.token), None)
        # What they asked and the owner hasn't answered goes with them.
        share.drive.requests = [r for r in share.drive.requests if r["invite"] != invite_id]
        return True

    def forget(self, share: Any) -> None:
        """A share ended: its invites' tokens go."""
        for invite in share.drive.invites.values():
            self.by_token.pop(_hash(invite.token), None)

    def find_token(self, token: str) -> tuple[str, str] | None:
        return self.by_token.get(_hash(token))

    def by_secret(self, share: Any, credential: Any) -> Invite | None:
        """The invite a sealed message names ("<id>.<secret>"), if its secret is right."""
        if not isinstance(credential, str) or "." not in credential:
            return None
        invite_id, secret = credential.split(".", 1)
        if not _INVITE_ID.fullmatch(invite_id) or not _SECRET.fullmatch(secret):
            return None
        invite = share.drive.invites.get(invite_id)
        if invite is None or invite.revoked:
            return None
        return invite if hmac.compare_digest(invite.secret_hash, _hash(secret)) else None

    def team_changed(self, team_id: str, member_id: str) -> None:
        """A member removed (or a whole team gone): their links on every share stop."""
        for share in list(self.shares.shares.values()):
            for invite in list(share.drive.invites.values()):
                if invite.team != team_id or (member_id and invite.member != member_id):
                    continue
                if self.role_of(share, invite) == "":
                    self.revoke(share, invite.id)
        self.shares.publish()

    def opened(self, share: Any, invite: Invite | None) -> None:
        """A personal link was used (its first time: noted, and its member has joined)."""
        if invite is None or invite.used:
            return
        invite.used = time.time()
        if invite.team and invite.member and self.teams is not None:
            self.teams.joined(invite.team, invite.member)

    # ── what someone may do now ──

    def role_of(self, share: Any, invite: Invite | None) -> str:
        """What this link may do now: "" (nothing: revoked, its member gone), else a role.
        The share's own link is a viewer's (a commenter's while suggestions are on for it)."""
        if not share.live():
            return ""
        if invite is None:
            return "commenter" if share.comments_on and self.shares.comments_allowed() else "viewer"
        if invite.revoked:
            return ""
        role = invite.role
        if invite.team or invite.member:
            member = self.teams.member(invite.team, invite.member) if self.teams is not None else None
            if member is None:
                return ""
            role = lower_role(role, member["share_role"]) or "viewer"
        if role == "driver" and not self.feature(PREF_DRIVERS):
            role = "commenter"
        if role == "commenter" and not self.shares.comments_allowed():
            role = "viewer"
        return role

    def may(self, share: Any, invite: Invite | None, kind: str) -> bool:
        need = {"view": "viewer", "comment": "commenter", "message": "driver", "approve": "driver"}.get(kind)
        role = self.role_of(share, invite)
        return bool(need and role) and share_rank(role) >= share_rank(need)

    def trusted(self, share: Any, invite: Invite | None) -> bool:
        return (
            invite is not None
            and invite.trusted
            and self.feature(PREF_TRUSTED)
            and self.role_of(share, invite) == "driver"
        )

    # ── what a driver asks ──

    def ask(self, share: Any, invite: Invite | None, data: dict[str, Any], via: str) -> dict[str, Any] | str:
        """A driver's request: a card for the owner (or, a trusted driver's plain message,
        sent). Refusals: "forbidden" (not theirs to ask), "gone" (the session or the
        question), "empty", "full" (too many waiting), "bad"."""
        kind = data.get("kind")
        if kind not in REQUEST_KINDS:
            return "bad"
        if not self.may(share, invite, kind):
            return "forbidden"
        task = self.hub.tasks.tasks.get(share.task_id)
        if task is None:
            return "gone"
        seat: Seat = share.drive
        title = " ".join((task.title or task.prompt).split())[:60] or "a session"
        if kind == "message":
            text = clean_text(str(data.get("text") or "")).strip()[:TEXT_CHARS]
            if not text:
                return "empty"
            if self.trusted(share, invite) and self.plain(text) and getattr(task, "mode", "") != "auto":
                sent = self.hub.tasks.send(task.id, text)
                self.note(task, f"{invite.name} (a trusted driver, through Share live) sent the next message.")
                self.record(share, invite, "trusted_sent", f"session {task.id}", via)
                self.shares.publish()
                return {"id": "", "status": "sent" if sent else "not_sent"}
            request = self._request(invite, "message", via, text=text)
            caption = "{name} asked to send a message to {title}."
        else:
            approval_id = str(data.get("approval") or "")[:40]
            approval = self.hub.approvals.get(approval_id)
            # Only a question of this share's own session, and one of its own answers.
            if approval is None or approval.get("task_id") != task.id:
                return "gone"
            choice = str(data.get("choice") or "")[:40]
            choices = {c.get("id"): c.get("label") for c in approval.get("choices") or []}
            if choice not in choices:
                return "bad"
            request = self._request(
                invite, "approve", via, approval=approval_id, choice=choice,
                label=self.shares.clean(task, choices.get(choice) or choice, 60),
                question=self.shares.clean(task, approval.get("question"), 300),
            )  # fmt: skip
            caption = "{name} suggested an answer on {title}."
        waiting = [r for r in seat.requests if r["status"] == "waiting"]
        if len(waiting) >= MAX_REQUESTS:
            return "full"
        seat.requests = [*seat.requests, request][-MAX_REQUESTS:]
        self.record(share, invite, f"asked_{kind}", f"session {task.id}", via)
        self.hub.emit("code_share_request", share=share.id, id=share.task_id, request=request)
        self.hub.emit("caption", text=lang.tr(caption, self.hub.language, name=invite.name, title=title))
        self.shares.publish()
        return request

    @staticmethod
    def plain(text: str) -> bool:
        """A message, not a command: never "!" (the shell) or "/" (a command)."""
        return not text.lstrip().startswith(("!", "/"))

    def _request(self, invite: Invite, kind: str, via: str, **extra: Any) -> dict[str, Any]:
        return {
            "id": secrets.token_hex(4),
            "invite": invite.id,
            "name": invite.name,
            "role": invite.role,
            "kind": kind,
            "via": via,
            "at": time.time(),
            "status": "waiting",
            **extra,
        }

    def note(self, task: Any, text: str) -> None:
        log_entry = getattr(self.hub.tasks, "_log", None)
        if callable(log_entry):
            log_entry(task, "note", text)

    # ── the owner's answers ──

    def request_of(self, share: Any, request_id: str) -> dict[str, Any] | None:
        return next((r for r in share.drive.requests if r["id"] == request_id), None)

    def send(self, share: Any, request_id: str) -> str:
        """The owner's Send on a driver's message: sent as the owner's own, if the driver may
        still ask for it. "" when sent, else why not."""
        request = self.request_of(share, request_id)
        if request is None or request["kind"] != "message" or request["status"] != "waiting":
            return "That request is gone."
        invite = share.drive.invites.get(request["invite"])
        if not self.may(share, invite, "message"):
            return lang.tr("{name} can't ask for that any more.", self.hub.language, name=request["name"])
        if not self.plain(request["text"]):
            return "Copy it into the composer to send it yourself: it starts with ! or /."
        task = self.hub.tasks.tasks.get(share.task_id)
        if task is None or not self.hub.tasks.send(task.id, request["text"]):
            return "That request is gone."
        self.note(task, f"You sent {request['name']}'s message (a driver, through Share live).")
        request["status"] = "sent"
        self.record(share, invite, "sent", f"session {task.id}", request["via"])
        return ""

    def settle(self, share: Any, request_id: str, outcome: str) -> str:
        """The window's word on a request the owner took up there: "answered" (an answer
        given through the card's own path, Touch ID and all), "copied" or "dismissed"."""
        request = self.request_of(share, request_id)
        if request is None or request["status"] != "waiting":
            return "That request is gone."
        invite = share.drive.invites.get(request["invite"])
        task_detail = f"session {share.task_id}"
        if outcome == "answered" and request["kind"] == "approve":
            request["status"] = "answered"
            self.record(share, invite, "answered", task_detail, request["via"])
        elif outcome == "copied":
            request["status"] = "copied"
            self.record(share, invite, "sent", f"{task_detail}, copied to the composer", request["via"])
        else:
            request["status"] = "dismissed"
            self.record(share, invite, "dismissed", task_detail, request["via"])
        return ""

    def record(self, share: Any, invite: Invite | None, action: str, detail: str, via: str) -> None:
        """Into the share's log and the companion's audit log: who (by the name the owner
        gave), as what, what kind of thing, which session; never the words."""
        who = invite.name if invite is not None else "A viewer"
        role = invite.role if invite is not None else "viewer"
        entry = {"at": time.time(), "who": who, "role": role, "action": action, "detail": detail,
                 "via": via, "invite": invite.id if invite is not None else ""}  # fmt: skip
        share.drive.log = [*share.drive.log, entry][-LOG_KEPT:]
        companion = getattr(getattr(self.hub, "remote", None), "extension", None)
        if companion is not None and hasattr(companion, "record") and action in AUDIT:
            device = SimpleNamespace(id=f"share:{entry['invite'] or share.id}", name=f"{who} ({role}, Share live)")
            try:
                companion.record(device, AUDIT[action], f"{detail} ({via})")
            except Exception:
                pass

    def public(self, share: Any) -> dict[str, Any]:
        seat: Seat = share.drive
        return {
            "invites": [i.public(self.role_of(share, i)) for i in seat.invites.values() if not i.revoked],
            # (for the owner's window only: an answer's own card, so its Touch ID check sees
            # the step itself; None once the question was answered some other way)
            "requests": [
                {**r, "card": self.hub.approvals.get(r["approval"]) if r["kind"] == "approve" else None}
                for r in seat.requests if r["status"] == "waiting"
            ],
            "log": [dict(e) for e in seat.log[-30:]],
        }
