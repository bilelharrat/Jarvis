"""Eden Code's teams (roadmap 47, basic): who the owner works with, and how far each may go
in a shared session. Part of Share live (Labs), installed with it (code_share.install).

A team is a name and its members. The owner of this Mac is its owner; each member is a
teammate, by the name the owner gives them, with
- a team role: "admin" or "member" (the owner is "owner", always, and alone);
- the most they may do in a share of the owner's (their share role): "viewer" (watch),
  "commenter" (watch and suggest) or "driver" (also ask for messages and answers to the
  session's questions: docs/eden-code-shared-sessions.md, phase 4). Only an admin can be a
  driver: making someone a driver is a role change of its own, never a slip of a menu.

"Invite" adds a member as invited; the first time they open a personal link made for them
from the Share pane (Invite the team) they count as joined. A member removed, or moved down
a role, loses it at once in every live share: their links stop working (removed), and what
they may do is looked at again on each thing they send (code_share_drive.Drive.role_of),
never only when the link was made.

Kept on this Mac (code-teams.json beside prefs.json, readable by the owner alone), with the
Eden account the Mac was linked to when the team was made, if any (account): teammates aren't
askeden.com accounts here. Joining a team to an askeden.com team space (accounts.md, "Team
spaces") is for later; nothing here goes to askeden.com.

Window commands: code_team_state {}, code_team_create {name}, code_team_rename {team, name},
code_team_delete {team}, code_team_invite {team, name, role?, share_role?, contact?},
code_team_member {team, member, role?, share_role?, name?, contact?}, code_team_remove
{team, member}. Event: code_teams {teams, error?}.

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import logging
import secrets
import time
from collections.abc import Callable
from typing import Any

from .. import jsonstore, lang
from ..textclean import clean_text

log = logging.getLogger("jarvis")

FILE = "code-teams.json"
TEAM_ROLES = ("admin", "member")  # a member's; the owner's is "owner"
SHARE_ROLES = ("viewer", "commenter", "driver")  # least first
MAX_TEAMS = 10
MAX_MEMBERS = 50
NAME_CHARS = 40
TEAM_CHARS = 60
CONTACT_CHARS = 80

ZH = {
    "Give the team a name.": "请给团队起个名字。",
    "There are already {n} teams.": "已经有 {n} 个团队了。",
    "That team is gone.": "这个团队已经不在了。",
    "Give them a name.": "请给对方起个名字。",
    "The team has {n} members already.": "这个团队已经有 {n} 名成员了。",
    "Someone on the team already has that name.": "团队里已经有人叫这个名字了。",
    "Only an admin can be a driver.": "只有管理员才能当驾驶员。",
    "That member is gone.": "这名成员已经不在了。",
}
lang.add_texts(ZH)


def _name(value: Any, limit: int) -> str:
    return " ".join(clean_text(str(value or "")).split())[:limit]


def share_rank(role: str) -> int:
    return SHARE_ROLES.index(role) if role in SHARE_ROLES else -1


def lower_role(a: str, b: str) -> str:
    """The lesser of two share roles ("" when either isn't one)."""
    if share_rank(a) < 0 or share_rank(b) < 0:
        return ""
    return a if share_rank(a) <= share_rank(b) else b


def _member(row: Any) -> dict[str, Any] | None:
    if not isinstance(row, dict) or not isinstance(row.get("id"), str):
        return None
    role = row.get("role") if row.get("role") in TEAM_ROLES else "member"
    share = row.get("share_role") if row.get("share_role") in SHARE_ROLES else "viewer"
    if share == "driver" and role != "admin":
        share = "commenter"  # (a hand edit can't make a member a driver)
    name = _name(row.get("name"), NAME_CHARS)
    if not name:
        return None
    return {
        "id": row["id"][:16],
        "name": name,
        "role": role,
        "share_role": share,
        "contact": _name(row.get("contact"), CONTACT_CHARS),
        "added": float(row.get("added") or 0),
        "joined": float(row.get("joined") or 0),
    }


def _team(row: Any) -> dict[str, Any] | None:
    if not isinstance(row, dict) or not isinstance(row.get("id"), str):
        return None
    name = _name(row.get("name"), TEAM_CHARS)
    if not name:
        return None
    members = [m for m in (_member(r) for r in row.get("members") or []) if m][:MAX_MEMBERS]
    return {
        "id": row["id"][:16],
        "name": name,
        "account": str(row.get("account") or "")[:40],
        "created": float(row.get("created") or 0),
        "members": members,
    }


class Teams:
    """The owner's teams, on this Mac."""

    def __init__(self, hub: Any, clock: Callable[[], float] = time.time) -> None:
        self.hub = hub
        self.clock = clock
        self.path = hub.feature_path(FILE)
        self._teams: list[dict[str, Any]] | None = None
        # Told (team id, member id) whenever a member is removed or their roles change, and
        # (team id, "") when a team goes: Share live looks at their links again.
        self.on_change: list[Callable[[str, str], Any]] = []

    def tr(self, text: str) -> str:
        return lang.translate(text, self.hub.language)

    @property
    def teams(self) -> list[dict[str, Any]]:
        if self._teams is None:
            try:
                rows = jsonstore.load_json(self.path, dict) or {}
            except jsonstore.Unreadable:
                rows = {}
            self._teams = [t for t in (_team(r) for r in rows.get("teams") or []) if t][:MAX_TEAMS]
        return self._teams

    def save(self) -> None:
        try:
            jsonstore.save_json(self.path, {"version": 1, "teams": self.teams})
        except OSError:
            log.warning("teams: couldn't save %s", self.path.name)

    def team(self, team_id: Any) -> dict[str, Any] | None:
        return next((t for t in self.teams if t["id"] == team_id), None)

    def member(self, team_id: Any, member_id: Any) -> dict[str, Any] | None:
        team = self.team(team_id)
        if team is None:
            return None
        return next((m for m in team["members"] if m["id"] == member_id), None)

    def public(self) -> list[dict[str, Any]]:
        return [{**t, "members": [dict(m) for m in t["members"]]} for t in self.teams]

    def _told(self, team_id: str, member_id: str) -> None:
        for hook in list(self.on_change):
            try:
                hook(team_id, member_id)
            except Exception:
                log.exception("teams: a listener failed")

    # ── changes (each "" when done, else why not) ──

    def create(self, name: Any) -> str:
        name = _name(name, TEAM_CHARS)
        if not name:
            return "Give the team a name."
        if len(self.teams) >= MAX_TEAMS:
            return f"There are already {len(self.teams)} teams."
        account = getattr(self.hub, "account", None)
        self.teams.append({
            "id": secrets.token_hex(4),
            "name": name,
            "account": str(getattr(account, "account_id", "") or "") if account is not None else "",
            "created": self.clock(),
            "members": [],
        })  # fmt: skip
        self.save()
        return ""

    def rename(self, team_id: Any, name: Any) -> str:
        team = self.team(team_id)
        if team is None:
            return "That team is gone."
        name = _name(name, TEAM_CHARS)
        if not name:
            return "Give the team a name."
        team["name"] = name
        self.save()
        return ""

    def delete(self, team_id: Any) -> str:
        team = self.team(team_id)
        if team is None:
            return "That team is gone."
        self.teams.remove(team)
        self.save()
        self._told(team["id"], "")
        return ""

    def invite(self, team_id: Any, name: Any, role: Any = "member", share_role: Any = "viewer",
               contact: Any = "") -> str:  # fmt: skip
        team = self.team(team_id)
        if team is None:
            return "That team is gone."
        name = _name(name, NAME_CHARS)
        if not name:
            return "Give them a name."
        if len(team["members"]) >= MAX_MEMBERS:
            return f"The team has {len(team['members'])} members already."
        if any(m["name"].casefold() == name.casefold() for m in team["members"]):
            return "Someone on the team already has that name."
        role = role if role in TEAM_ROLES else "member"
        share_role = share_role if share_role in SHARE_ROLES else "viewer"
        if share_role == "driver" and role != "admin":
            return "Only an admin can be a driver."
        team["members"].append({
            "id": secrets.token_hex(4),
            "name": name,
            "role": role,
            "share_role": share_role,
            "contact": _name(contact, CONTACT_CHARS),
            "added": self.clock(),
            "joined": 0.0,
        })  # fmt: skip
        self.save()
        return ""

    def change(self, team_id: Any, member_id: Any, msg: dict[str, Any]) -> str:
        member = self.member(team_id, member_id)
        if member is None:
            return "That member is gone."
        role = msg.get("role", member["role"])
        share_role = msg.get("share_role", member["share_role"])
        role = role if role in TEAM_ROLES else member["role"]
        share_role = share_role if share_role in SHARE_ROLES else member["share_role"]
        if role != "admin" and share_role == "driver":
            if "share_role" in msg:
                return "Only an admin can be a driver."
            share_role = "commenter"  # (moved down from admin: no longer a driver)
        if "name" in msg:
            name = _name(msg.get("name"), NAME_CHARS)
            if not name:
                return "Give them a name."
            team = self.team(team_id)
            if any(m is not member and m["name"].casefold() == name.casefold() for m in team["members"]):
                return "Someone on the team already has that name."
            member["name"] = name
        if "contact" in msg:
            member["contact"] = _name(msg.get("contact"), CONTACT_CHARS)
        member["role"], member["share_role"] = role, share_role
        self.save()
        self._told(str(team_id), str(member_id))
        return ""

    def remove(self, team_id: Any, member_id: Any) -> str:
        team = self.team(team_id)
        member = self.member(team_id, member_id)
        if team is None or member is None:
            return "That member is gone."
        team["members"].remove(member)
        self.save()
        self._told(team["id"], member["id"])
        return ""

    def joined(self, team_id: str, member_id: str) -> None:
        """A member's personal link was opened: they've joined (once)."""
        member = self.member(team_id, member_id)
        if member is not None and not member["joined"]:
            member["joined"] = self.clock()
            self.save()
            self.publish()

    # ── the window ──

    def publish(self, error: str = "") -> None:
        extra = {"error": self.tr(error)} if error else {}
        self.hub.emit("code_teams", teams=self.public(), **extra)

    def command(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        team, member = msg.get("team"), msg.get("member")
        said = ""
        if kind == "code_team_create":
            said = self.create(msg.get("name"))
        elif kind == "code_team_rename":
            said = self.rename(team, msg.get("name"))
        elif kind == "code_team_delete":
            said = self.delete(team)
        elif kind == "code_team_invite":
            said = self.invite(team, msg.get("name"), msg.get("role", "member"),
                               msg.get("share_role", "viewer"), msg.get("contact", ""))  # fmt: skip
        elif kind == "code_team_member":
            said = self.change(team, member, {k: msg[k] for k in ("role", "share_role", "name", "contact") if k in msg})
        elif kind == "code_team_remove":
            said = self.remove(team, member)
        self.publish(said)


COMMANDS = (
    "code_team_state",
    "code_team_create",
    "code_team_rename",
    "code_team_delete",
    "code_team_invite",
    "code_team_member",
    "code_team_remove",
)


def attach(hub: Any) -> Teams:
    """Teams on the hub, with their window commands (Share live's install calls this)."""
    teams = Teams(hub)
    hub.code_teams = teams
    for kind in COMMANDS:
        hub.register_command(kind, teams.command)
    return teams
