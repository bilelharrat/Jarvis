"""A stand-in for askeden.com's account API (docs/accounts.md), as an httpx.MockTransport:
linking, the account, push and sync, all in memory. Never the network."""

import base64
import json
import os
import uuid
from urllib.parse import parse_qs

import httpx

from jarvis import account as account_mod
from jarvis import account_sync

ACCOUNT_ID = "8d3c1a52-7e44-8a10-9f6e-2b1c0d4e5f60"
DEVICE_ID = "a1b2c3d4e5f60718"
TOKEN = f"jv1.{ACCOUNT_ID}.{DEVICE_ID}." + "A" * 43
PHONE = "0011223344556677"


def account_json(**plan):
    return {
        "id": ACCOUNT_ID,
        "created": 1790000000000,
        "plan": {
            "name": "free",
            "active": False,
            "product_id": None,
            "expires": None,
            "renews": None,
            "environment": None,
            **plan,
        },
        "usage": {
            "period_start": 1790000000000,
            "period_end": None,
            "spent_usd": 0.42,
            "budget_usd": 20,
            "left_usd": 19.58,
            "trial_left_usd": 1.0,
            "voice_today": 1200,
            "voice_daily": 20000,
        },
        "devices": [
            {
                "id": DEVICE_ID,
                "name": "Studio",
                "kind": "mac",
                "created": 1790000000000,
                "last_seen": 1790000001000,
                "app_version": "0.1.6",
                "push": False,
                "relay": True,
                "this": True,
            },
            {
                "id": PHONE,
                "name": "Bilel's iPhone",
                "kind": "iphone",
                "created": 1790000000000,
                "last_seen": 1790000002000,
                "app_version": "1.0",
                "push": True,
                "relay": False,
                "this": False,
            },
        ],
        "sync": {"rev": 0, "items": 0},
    }


class FakeAskeden:
    """What askeden.com answers. Tests set what the next poll says (polls), the sync key
    the phone seals (sync_key), and look at what was asked (calls)."""

    def __init__(self, sync_key=None):
        self.calls = []
        self.tokens = {TOKEN}
        self.links = {}
        self.polls = []  # what the next polls answer: "waiting", "approve", "deny", "expire"
        self.sync_key = sync_key
        self.pushes = []
        self.push_answers = []
        self.items = {}  # key -> {rev, data, deleted, updated}
        self.rev = 0
        self.conflicts = 0  # PUTs to answer 409 (another device wrote first)
        self.plan = {}
        # What else waits with a code for this account to approve: code -> {name, kind},
        # or "expired"; answered in waiting_answers (code -> "approved" | "denied").
        self.waiting = {}
        self.waiting_answers = {}
        self.transport = httpx.MockTransport(self.handle)

    # what the phone does

    def phone_put(self, key, value, sync_key=None):
        data = account_sync.seal_item(sync_key or self.sync_key, key, value)
        self.rev += 1
        self.items[key] = {"rev": self.rev, "data": data, "deleted": False, "updated": 1}

    def phone_read(self, key, sync_key=None):
        item = self.items.get(key)
        if not item or item["deleted"]:
            return None
        return account_sync.open_item(sync_key or self.sync_key, key, item["data"])

    # the API

    def _authed(self, request):
        auth = request.headers.get("authorization", "")
        return auth.startswith("Bearer ") and auth[7:] in self.tokens

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api")
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, body))
        if path == "/link/start" and request.method == "POST":
            code = "K7QM-4ZTR"
            self.links[code] = {"poll": "poll-secret", "public_key": body["public_key"]}
            return httpx.Response(
                200, json={"code": code, "poll": "poll-secret", "expires_in": 600}
            )
        if path == "/link/poll":
            link = self.links.get(body["code"])
            if link is None or body["poll"] != link["poll"]:
                return httpx.Response(404, json={"error": "No such code.", "code": "not_found"})
            step = self.polls.pop(0) if self.polls else "waiting"
            if step == "waiting":
                return httpx.Response(202, json={"status": "waiting"})
            if step in ("deny", "expire"):
                code = "denied" if step == "deny" else "expired"
                return httpx.Response(410, json={"error": "Gone.", "code": code})
            sealed = sender = None
            if self.sync_key is not None:
                mac = base64.b64decode(link["public_key"])
                sealed, sender = account_mod.seal(mac, self.sync_key)
            del self.links[body["code"]]
            return httpx.Response(
                200,
                json={
                    "token": TOKEN,
                    "account_id": ACCOUNT_ID,
                    "device_id": DEVICE_ID,
                    "sealed_key": sealed,
                    "sender_key": sender,
                },
            )
        if not self._authed(request):
            return httpx.Response(401, json={"error": "Signed out.", "code": "signed_out"})
        if path.startswith("/link/") and path.count("/") in (2, 3):
            return self._waiting(request.method, path.split("/")[2:], body)
        if path == "/account" and request.method == "GET":
            return httpx.Response(200, json=account_json(**self.plan))
        if path == "/devices/me" and request.method == "DELETE":
            self.tokens.discard(TOKEN)
            return httpx.Response(204)
        if path == "/push":
            self.pushes.append(body)
            answer = (
                self.push_answers.pop(0) if self.push_answers else {"status": 200, "apns_id": "x"}
            )
            if isinstance(answer, int):
                return httpx.Response(answer, json={"error": "No.", "code": "not_set_up"})
            return httpx.Response(200, json=answer)
        if path == "/sync" and request.method == "GET":
            since = int(parse_qs(request.url.query.decode()).get("since", ["0"])[0])
            items = sorted(
                (
                    {
                        "key": k,
                        "rev": v["rev"],
                        "data": None if v["deleted"] else v["data"],
                        "deleted": v["deleted"],
                        "updated": v["updated"],
                    }
                    for k, v in self.items.items()
                    if v["rev"] > since
                ),
                key=lambda i: i["rev"],
            )
            return httpx.Response(200, json={"rev": self.rev, "items": items, "more": False})
        if path.startswith("/sync/") and request.method == "PUT":
            key = path.removeprefix("/sync/")
            have = self.items.get(key)
            if self.conflicts:
                self.conflicts -= 1
                return self._conflict(key)
            if (have["rev"] if have else 0) != body["base_rev"]:
                return self._conflict(key)
            self.rev += 1
            self.items[key] = {
                "rev": self.rev,
                "data": body["data"],
                "deleted": False,
                "updated": 2,
            }
            return httpx.Response(200, json={"rev": self.rev})
        if path.startswith("/sync/") and request.method == "DELETE":
            key = path.removeprefix("/sync/")
            self.rev += 1
            self.items[key] = {"rev": self.rev, "data": None, "deleted": True, "updated": 3}
            return httpx.Response(200, json={"rev": self.rev})
        return httpx.Response(404, json={"error": "Not here.", "code": "not_found"})

    def _waiting(self, method, parts, body):
        code = parts[0]
        link = self.waiting.get(code)
        if link is None:
            return httpx.Response(404, json={"error": "No such code.", "code": "not_found"})
        if link == "expired":
            return httpx.Response(410, json={"error": "Expired.", "code": "expired"})
        if method == "GET" and len(parts) == 1:
            return httpx.Response(200, json={**link, "public_key": None, "expires_in": 300})
        if method == "POST" and len(parts) == 2 and parts[1] in ("approve", "deny"):
            if parts[1] == "approve" and link["kind"] != "web":  # as the server: never a Mac
                return httpx.Response(
                    403, json={"error": "Approve a Mac from your iPhone.", "code": "forbidden"}
                )
            del self.waiting[code]
            self.waiting_answers[code] = ("approved" if parts[1] == "approve" else "denied", body)
            if parts[1] == "deny":
                return httpx.Response(204)
            return httpx.Response(200, json={"device_id": "b0b0b0b0b0b0b0b0", "name": link["name"]})
        return httpx.Response(404, json={"error": "Not here.", "code": "not_found"})

    def _conflict(self, key):
        have = self.items.get(key) or {"rev": 0, "data": None}
        return httpx.Response(
            409,
            json={
                "error": "Someone else wrote it.",
                "code": "conflict",
                "item": {"key": key, "rev": have["rev"], "data": have["data"]},
            },
        )


def sync_key():
    return os.urandom(32)


def fact(text, updated, *, category="other", deleted=False, ident=None):
    return {
        "id": ident or str(uuid.uuid4()),
        "text": text,
        "category": category,
        "updated": updated,
        "deleted": deleted,
    }
