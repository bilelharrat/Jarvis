"""Share live's links that work outside the Mac's network, through askeden.com
(docs/eden-code-shared-sessions.md, phase 3). Part of Share live (Labs), behind its own
switch (code_share_internet, off): askeden.com's side has to be deployed first (owner step).

With the switch on and this Mac linked to an Eden account, a new share gets a second link
beside the one on the network: https://askeden.com/live/<id>#k=<key> (a personal link adds
&i=<invite id>.<secret>: code_share_drive.py). The id and the key are made here
(share_seal.py); the key, and an invite's secret, are in the fragment only, so askeden.com
never has them and relays ciphertext only.

- Registering: POST /api/live {share, expires, max_viewers, up} with this Mac's own account
  token (only a Mac's: askeden.com checks); DELETE /api/live/<id> revokes. askeden.com keeps
  each share in a Durable Object of its own (LiveRoom) that deletes itself when it ends; a
  share can't outlive a day there either.
- Pushing: the Mac pushes rather than being polled, over the relay's control line (relay.py,
  no new connection): at most every PUSH_SECONDS, only when something changed, the same view
  the network's link serves (every redaction done first, code_share.py), sealed for the share
  (down, seq counting up) and cut into parts that fit a frame:
      Mac → askeden.com  {"type": "share_push", "share", "seq", "kind": "full"|"delta",
                          "part", "parts", "blob"}
  A full snapshot first and whenever askeden.com asks for one (share_resync: the room's
  history got too long, or the line came back); a delta (new entries, entries that changed,
  the changes when their key changed, the status) after.
- Hearing: askeden.com → Mac {"type": "share_viewers", "share", "count"} (how many watch),
  {"type": "share_up", "share", "id", "blob"} (a viewer's sealed message: a suggestion, or
  a driver's request, up, its own id as the seq), {"type": "share_resync", "share"} and
  {"type": "share_ended", "share"} (the room ended it: expired).
  A message that doesn't open with the key for exactly its id, one heard before (its id
  kept), one more than ten minutes off the clock, or one naming an invite whose secret is
  wrong is dropped. What one that opens may do is code_share_drive's to decide, the same
  checks as on the network.

What askeden.com still sees: that a share exists, when, how big its frames are, whether a
push is a full one, how many watch and from where. It could, being the site, serve a page
that reads the key: the limit of any web page's end-to-end encryption, said in the Share pane.

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from .. import prefs, share_seal
from ..account import AccountError

log = logging.getLogger("jarvis")

PREF_INTERNET = "code_share_internet"
prefs.register_feature_pref(PREF_INTERNET, False)

PUSH_SECONDS = 2.0
SEEN_KEPT = 1000  # a share's viewers' message ids kept, against replays
CLOCK_SKEW_MS = 10 * 60 * 1000
FULL_ENTRIES = 200
UP_KINDS = ("hello", "comment", "message", "approve")


@dataclass
class LiveLink:
    """One share's internet side."""

    share_id: str
    key: bytes
    state: str = "registering"  # registering | live | failed | ended
    error: str = ""
    viewers: int = 0
    seq: int = 0
    want_full: bool = True
    sent_n: int = 0
    sent_u: int = 0
    changes_key: str = ""
    status_key: str = ""
    seen: OrderedDict[str, float] = field(default_factory=OrderedDict)
    pusher: asyncio.Task | None = None
    dropped: int = 0  # messages that didn't open or were refused (for the tests, and the pane)


class Live:
    """The internet links of one hub's shares (shares: code_share.Shares)."""

    def __init__(self, shares: Any) -> None:
        self.shares = shares
        self.hub = shares.hub
        self.by_id: dict[str, Any] = {}  # live share id -> the Share

    # ── whether it can be ──

    @property
    def account(self) -> Any:
        return getattr(self.hub, "account", None)

    @property
    def relay(self) -> Any:
        desk = getattr(self.hub, "account_desk", None)
        return getattr(desk, "relay", None)

    def wanted(self) -> bool:
        account = self.account
        return (
            self.hub.prefs.feature(PREF_INTERNET) is True
            and account is not None
            and bool(account.linked)
            and self.relay is not None
        )

    def attach(self) -> None:
        """Hear askeden.com's messages on the relay's control line."""
        relay = self.relay
        if relay is None:
            return
        relay.handlers.update({
            "share_viewers": self.heard_viewers,
            "share_up": self.heard_up,
            "share_resync": self.heard_resync,
            "share_ended": self.heard_ended,
        })  # fmt: skip
        relay.on_listening.append(self.relistened)

    # ── the owner's side ──

    def url(self, share: Any, invite: Any = None) -> str:
        link = share.live_link
        if link is None or link.state in ("failed", "ended"):
            return ""
        base = self.account.web_base if self.account is not None else "https://askeden.com"
        url = f"{base}/live/{link.share_id}#k={share_seal.b64url(link.key)}"
        if invite is not None:
            url += f"&i={invite.id}.{invite.secret}"
        return url

    def begin(self, share: Any) -> None:
        """A new share: its internet side, registered and pushed in the background."""
        if not self.wanted():
            return
        share.live_link = LiveLink(share_id=share_seal.new_share_id(), key=share_seal.new_key())
        self.by_id[share.live_link.share_id] = share
        share.live_link.pusher = self.hub._spawn(self._run(share))

    async def _run(self, share: Any) -> None:
        link: LiveLink = share.live_link
        try:
            await self.account.call(
                "POST",
                "/live",
                body={
                    "share": link.share_id,
                    "expires": int(share.expires),
                    "max_viewers": self.shares.max_viewers,
                    "up": True,
                },
            )
        except AccountError as exc:
            link.state, link.error = "failed", exc.message
            self.by_id.pop(link.share_id, None)
            self.shares.publish()
            return
        link.state = "live"
        self.shares.publish()
        try:
            while share.live() and link.state == "live":
                relay = self.relay
                if relay is not None and relay.listening:
                    with contextlib.suppress(Exception):
                        await self.push(share)
                await asyncio.sleep(PUSH_SECONDS)
        finally:
            if link.state == "live" and not share.live():
                await self.end(share)

    async def end(self, share: Any) -> None:
        """Revoke on askeden.com (the room closes its viewers' sockets and deletes itself)."""
        link: LiveLink | None = share.live_link
        if link is None or link.state == "ended":
            return
        was = link.state
        link.state = "ended"
        self.by_id.pop(link.share_id, None)
        if link.pusher is not None and not link.pusher.done() and link.pusher is not asyncio.current_task():
            link.pusher.cancel()
        if was in ("live", "registering"):
            with contextlib.suppress(AccountError, Exception):
                await self.account.call("DELETE", f"/live/{link.share_id}", ok=(200, 204, 404, 410))

    def revoke_soon(self, share: Any) -> None:
        if share.live_link is not None and share.live_link.state != "ended":
            self.hub._spawn(self.end(share))

    def public(self, share: Any) -> dict[str, Any]:
        link = share.live_link
        if link is None:
            return {}
        return {"state": link.state, "error": link.error, "viewers": link.viewers,
                "url": self.url(share)}  # fmt: skip

    # ── pushing ──

    async def snapshot(self, share: Any, task: Any, full: bool) -> dict[str, Any] | None:
        """What changed since the last push (None: nothing), or everything (full)."""
        link: LiveLink = share.live_link
        status = {**self.shares.status(task), "approvals": self.shares.approvals_for(task)}
        extra = {
            "expires": share.expires,
            "comments": share.comments_on and self.shares.comments_allowed(),
            "roles": {i.id: self.shares.drive.role_of(share, i) for i in share.drive.invites.values()},
        }
        status_key = json.dumps([status, extra], sort_keys=True, default=str)
        key, found = await self.shares.changes(share, task)
        if full:
            numbers = [int(e.get("n") or 0) for e in list(task.transcript)]
            since = numbers[-FULL_ENTRIES - 1] if len(numbers) > FULL_ENTRIES else 0
            items, _more, updated = await self.shares.entries_for(share, task, since, 1 << 62)
            updated = max([updated, *(int(e.get("updated") or 0) for e in task.transcript)], default=0)
        else:
            items, _more, updated = await self.shares.entries_for(share, task, link.sent_n, link.sent_u)
            if not items and key == link.changes_key and status_key == link.status_key:
                return None
        link.sent_n = max([link.sent_n, *(int(i.get("n") or 0) for i in items)])
        link.sent_u = max(link.sent_u, updated)
        changes = found if (full or key != link.changes_key) else None
        link.changes_key, link.status_key = key, status_key
        return {"kind": "full" if full else "delta", **status, **extra, "entries": items,
                "changes_key": key, "changes": changes}  # fmt: skip

    def fit(self, payload: dict[str, Any]) -> bytes:
        """The payload as bytes, made smaller until its sealed parts fit one push: the
        changes' lines first, then the oldest entries."""
        limit = share_seal.PART_CHARS * share_seal.MAX_PARTS * 3 // 4 - 1024
        data = json.dumps(payload, separators=(",", ":")).encode()
        if len(data) > limit and payload.get("changes"):
            changes = payload["changes"]
            payload["changes"] = {**changes, "too_big": True,
                                  "files": [{**f, "hunks": []} for f in changes.get("files", [])]}  # fmt: skip
            data = json.dumps(payload, separators=(",", ":")).encode()
        while len(data) > limit and payload.get("entries"):
            payload["entries"] = payload["entries"][len(payload["entries"]) // 2 or 1 :]
            data = json.dumps(payload, separators=(",", ":")).encode()
        return data

    async def push(self, share: Any) -> bool:
        link: LiveLink = share.live_link
        task = self.hub.tasks.tasks.get(share.task_id)
        if task is None or link is None or link.state != "live":
            return False
        full = link.want_full
        payload = await self.snapshot(share, task, full)
        if payload is None:
            return False
        link.seq += 1
        blob = share_seal.seal(link.key, link.share_id, "down", link.seq, self.fit(payload))
        parts = share_seal.split(blob)
        for at, piece in enumerate(parts):
            ok = await self.relay.send({
                "type": "share_push", "share": link.share_id, "seq": link.seq,
                "kind": payload["kind"], "part": at, "parts": len(parts), "blob": piece,
            })  # fmt: skip
            if not ok:
                link.want_full = True  # (the line dropped mid-push: start over when it's back)
                return False
        if full:
            link.want_full = False
        return True

    # ── hearing askeden.com ──

    def _link(self, message: dict[str, Any]) -> tuple[Any, LiveLink] | None:
        share = self.by_id.get(str(message.get("share") or ""))
        if share is None or share.live_link is None or not share.live():
            return None
        return share, share.live_link

    def heard_viewers(self, message: dict[str, Any]) -> None:
        found = self._link(message)
        count = message.get("count")
        if found is None or type(count) is not int or count < 0:
            return
        found[1].viewers = min(count, 10_000)
        self.shares.publish()

    def heard_resync(self, message: dict[str, Any]) -> None:
        found = self._link(message)
        if found is not None:
            found[1].want_full = True

    def heard_ended(self, message: dict[str, Any]) -> None:
        found = self._link(message)
        if found is not None:
            share, link = found
            link.state = "ended"
            self.by_id.pop(link.share_id, None)
            self.shares.publish()

    def relistened(self) -> None:
        """The control line is up again: every share starts over with a full snapshot."""
        for share in self.by_id.values():
            if share.live_link is not None:
                share.live_link.want_full = True

    def opened(self, share: Any, message: dict[str, Any]) -> dict[str, Any] | None:
        """A viewer's sealed message, opened and checked (None: dropped)."""
        link: LiveLink = share.live_link
        message_id = message.get("id")
        if not share_seal.valid_message_id(message_id) or message_id in link.seen:
            return None
        blob = message.get("blob")
        if not isinstance(blob, str) or len(blob) > share_seal.MAX_UP_CHARS:
            return None
        plain = share_seal.open_sealed(link.key, link.share_id, "up", message_id, blob)
        if plain is None:
            return None
        try:
            data = json.loads(plain)
        except ValueError:
            return None
        if not isinstance(data, dict) or data.get("kind") not in UP_KINDS:
            return None
        at = data.get("at")
        if type(at) is not int or abs(at - time.time() * 1000) > CLOCK_SKEW_MS:
            return None
        link.seen[message_id] = time.monotonic()
        while len(link.seen) > SEEN_KEPT:
            link.seen.popitem(last=False)
        return data

    def heard_up(self, message: dict[str, Any]) -> None:
        found = self._link(message)
        if found is None:
            return
        share, link = found
        data = self.opened(share, message)
        if data is None:
            link.dropped += 1
            return
        drive = self.shares.drive
        credential = data.get("invite") or ""
        invite = drive.by_secret(share, credential) if credential else None
        if credential and invite is None:
            link.dropped += 1  # (a wrong or revoked secret is no one's: never a viewer's either)
            return
        kind = data["kind"]
        who = f"relay:{invite.id if invite is not None else 'link'}"
        if self.shares.limiter.wait(f"{share.id}:{who}", "comment" if kind == "comment" else "act"):
            link.dropped += 1
            return
        if kind == "hello":
            drive.opened(share, invite)
            return
        if kind == "comment":
            if not drive.may(share, invite, "comment"):
                link.dropped += 1
                return
            name = invite.name if invite is not None else data.get("name")
            self.shares.comment(share, who, name, data.get("text"), allowed=True)
            return
        if isinstance(drive.ask(share, invite, data, "internet"), str):
            link.dropped += 1
