"""Sync: this Mac's memory and a few settings, kept the same as the owner's iPhone's through
their Jarvis account (docs/accounts.md, "Sync").

Everything is sealed here before it leaves (ChaCha20-Poly1305 with the account's sync key,
a random 12-byte nonce, the item's key as associated data): askeden.com keeps only
ciphertext and can't read a word of it. The sync key came from the iPhone when this Mac was
linked (account.py); without it nothing is synced.

What's synced:
- keycheck: written by the iPhone that made the key. It must open with this Mac's key
  before anything else is read or written; when it doesn't, Settings says the key is wrong
  and nothing is overwritten.
- memory: the facts every agent shares (an agent's own stay on the Mac), as the contract's
  facts. A Mac fact's id isn't a UUID: its wire id is a UUID made from it (uuid5), the same
  every time. Merged by id, the newer one winning; a fact removed here is sent as a
  tombstone (kept 90 days) so the phone removes it too. A fact of the Mac's own keeps its
  provenance when the phone's newer words come in; one from the phone is "synced".
- settings: the owner's name, how JARVIS addresses them and the language; the newer side
  wins the whole item, and fields this Mac doesn't know are kept as they came.
- chat:<id> items are the iPhone's conversations: never read here, never deleted.

When: at start, a few seconds after memory or those settings change, and every 5 minutes.
A write that crossed another device's (409) is merged with theirs and tried again. What it
remembers between runs (revisions, the facts it last sent, tombstones) is in a small file
beside prefs.json, with nothing secret in it.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import time
import uuid
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from . import jsonstore
from .account import AccountError, SignedOut, b64decode, b64encode

log = logging.getLogger("jarvis")

KEYCHECK = {"v": 1, "check": "jarvis-sync-v1"}
SYNCED = ("keycheck", "memory", "settings")  # the items this Mac reads and writes
TOMBSTONE_MS = 90 * 24 * 3600 * 1000
EVERY_SECONDS = 5 * 60
LOOK_SECONDS = 5.0  # how often a change is looked for
SETTLE_SECONDS = 3.0  # a change waits this long for the next before it's synced
TRIES = 3  # writes that crossed another device's, merged and tried again
PAGES = 50  # pages of GET /sync in one pass (200 items each)
# Wire ids of the Mac's own facts: uuid5 in this namespace of the Mac's id.
FACT_NAMESPACE = uuid.UUID("6a1f6c1e-5b7d-4f43-9c1e-8f1d0a7c2b55")
WIRE_CATEGORIES = (
    "people",
    "preferences",
    "work",
    "health",
    "places",
    "other",
    "goals",
    "corrections",
)
SYNCED_ORIGIN = "Synced from your iPhone"
STATES = {
    # what Settings says for each state of sync
    "off": "",
    "no_key": "No sync key yet. Turn on sync on your iPhone, then link this Mac again.",
    "waiting": "Waiting for your iPhone to turn sync on.",
    "wrong_key": "This Mac's sync key doesn't open what your iPhone synced. Unlink, then link again to get the new key. Nothing was overwritten.",
    "ok": "",
    "error": "",
}


class WrongKey(ValueError):
    """An item that doesn't open with this Mac's key."""


# ── sealing ──


def seal_item(key: bytes, item_key: str, value: Any) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

    plain = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    nonce = os.urandom(12)
    return b64encode(nonce + ChaCha20Poly1305(key).encrypt(nonce, plain, item_key.encode()))


def open_item(key: bytes, item_key: str, data: Any) -> Any:
    """An item's JSON; WrongKey when it doesn't open (or isn't JSON once open)."""
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

    try:
        raw = b64decode(data)
        if len(raw) < 12 + 16:
            raise ValueError("too short")
        plain = ChaCha20Poly1305(key).decrypt(raw[:12], raw[12:], item_key.encode())
        return json.loads(plain)
    except (InvalidTag, ValueError) as exc:
        raise WrongKey(f"{item_key} doesn't open") from exc


# ── facts on the wire ──


def wire_id(mac_id: str) -> str:
    """A fact's id as the phone knows it: its own when it's a UUID already (it came from
    the phone), else a UUID made from the Mac's id (the same every time)."""
    try:
        parsed = uuid.UUID(mac_id)
    except (ValueError, AttributeError, TypeError):
        return str(uuid.uuid5(FACT_NAMESPACE, str(mac_id)))
    return str(parsed) if str(parsed) == mac_id.lower() else str(uuid.uuid5(FACT_NAMESPACE, mac_id))


def _ms(stamp: str) -> int:
    """A fact's time (ISO, local) in ms since 1970; 0 when it isn't one."""
    try:
        return int(datetime.fromisoformat(stamp).timestamp() * 1000)
    except (TypeError, ValueError, OverflowError, OSError):
        return 0


def _stamp(ms: int) -> str:
    try:
        return datetime.fromtimestamp(ms / 1000).isoformat(timespec="seconds")
    except (ValueError, OverflowError, OSError):
        return datetime.now().isoformat(timespec="seconds")


def clean_wire_fact(raw: Any) -> dict[str, Any] | None:
    """One fact from the phone, checked: None when it can't be one."""
    if not isinstance(raw, dict):
        return None
    ident, updated = raw.get("id"), raw.get("updated")
    try:
        ident = str(uuid.UUID(str(ident)))
    except ValueError:
        return None
    if not isinstance(updated, int | float) or isinstance(updated, bool) or updated < 0:
        return None
    deleted = raw.get("deleted") is True
    text = raw.get("text")
    if not deleted and (not isinstance(text, str) or not text.strip()):
        return None
    category = raw.get("category")
    return {
        "id": ident,
        "text": text[:2000] if isinstance(text, str) else "",
        "category": category if category in WIRE_CATEGORIES else "other",
        "updated": int(updated),
        "deleted": deleted,
    }


def _rank(fact: dict[str, Any]) -> tuple:
    """Which of two versions of a fact wins: the newer; at the same time a delete, then the
    words (so every device picks the same one)."""
    return (fact["updated"], fact["deleted"], fact["text"], fact["category"])


def merge_facts(*sides: list[dict[str, Any]], now_ms: int) -> dict[str, dict[str, Any]]:
    """Union by id, the larger rank winning; tombstones older than 90 days dropped."""
    out: dict[str, dict[str, Any]] = {}
    for side in sides:
        for fact in side:
            have = out.get(fact["id"])
            if have is None or _rank(fact) > _rank(have):
                out[fact["id"]] = fact
    return {
        k: v for k, v in out.items() if not (v["deleted"] and now_ms - v["updated"] > TOMBSTONE_MS)
    }


def _canon(facts: Any) -> list[tuple]:
    return sorted(
        (f["id"], f["text"] if not f["deleted"] else "", f["category"], f["updated"], f["deleted"])
        for f in facts
    )


def _language(value: Any) -> str | None:
    """The phone's language as the Mac keeps it ("en" or "zh"), or None."""
    if not isinstance(value, str):
        return None
    value = value.strip().lower()
    if value.startswith("zh"):
        return "zh"
    if value.startswith("en"):
        return "en"
    return None


class Sync:
    """One account's sync for this Mac. memory: the MemoryStore; prefs: gives the Prefs;
    set_prefs: changes them (as the window does); path: the sync's own file."""

    def __init__(
        self,
        account: Any,
        memory: Callable[[], Any],
        prefs: Callable[[], Any],
        set_prefs: Callable[[dict[str, Any]], Any],
        path: Path,
        *,
        now_ms: Callable[[], int] = lambda: int(time.time() * 1000),
        on_change: Callable[[], Any] | None = None,
    ) -> None:
        self.account = account
        self.memory = memory
        self.prefs = prefs
        self.set_prefs = set_prefs
        self.path = path
        self.now_ms = now_ms
        self.on_change = on_change  # heard after it changed memory or settings here
        self.state = "off"
        self.error = ""
        self.at = ""  # when it last synced
        self._data: dict[str, Any] | None = None
        self._lock = asyncio.Lock()
        self._poked = asyncio.Event()
        self._seen = ""  # the fingerprint of what was last synced

    # ── its file ──

    def _file(self) -> dict[str, Any]:
        if self._data is None:
            try:
                data = jsonstore.load_json(self.path, dict) or {}
            except jsonstore.Unreadable:
                data = {}
            self._data = {
                "account": data.get("account") if isinstance(data.get("account"), str) else "",
                "since": data.get("since") if isinstance(data.get("since"), int) else 0,
                "items": {
                    k: v
                    for k, v in (data.get("items") or {}).items()
                    if k in SYNCED and isinstance(v, dict) and isinstance(v.get("rev"), int)
                }
                if isinstance(data.get("items"), dict)
                else {},
                "facts": data.get("facts") if isinstance(data.get("facts"), dict) else {},
                "tombstones": data.get("tombstones")
                if isinstance(data.get("tombstones"), dict)
                else {},
                "settings": data.get("settings") if isinstance(data.get("settings"), dict) else {},
            }
        return self._data

    async def _save(self) -> None:
        data = json.loads(json.dumps(self._file()))
        try:
            await asyncio.to_thread(jsonstore.save_json, self.path, data, backup=False)
        except OSError as exc:
            log.warning("sync: couldn't save its state (%s)", exc.strerror or exc)

    def reset(self) -> None:
        """Forget what was synced (a new account, or unlinked)."""
        self._data = {
            "account": "",
            "since": 0,
            "items": {},
            "facts": {},
            "tombstones": {},
            "settings": {},
        }
        self._seen = ""
        with contextlib.suppress(OSError):
            self.path.unlink()

    # ── what's here ──

    def _settings_now(self) -> dict[str, Any]:
        prefs = self.prefs()
        return {
            "owner_name": prefs.owner_name,
            "address_as": prefs.address,
            "language": prefs.language,
        }

    def local_facts(self) -> list[dict[str, Any]]:
        """The Mac's shared facts on the wire, with their times as last synced when they
        haven't changed since (the phone's ms, not the Mac's seconds)."""
        kept = self._file()["facts"]
        out = []
        for fact in self.memory().facts:
            if fact.agent:
                continue
            ident = wire_id(fact.id)
            record = kept.get(ident) if isinstance(kept.get(ident), dict) else {}
            same = record.get("at") == fact.at
            category = fact.category
            if same and record.get("category") in WIRE_CATEGORIES:
                category = record["category"]  # as synced (a goal or a correction stays one)
            updated = record.get("updated") if same else None
            if not isinstance(updated, int):
                updated = _ms(fact.at)
            out.append(
                {
                    "id": ident,
                    "text": fact.text,
                    "category": category,
                    "updated": updated,
                    "deleted": False,
                    "local": fact.id,
                }
            )
        return out

    def fingerprint(self) -> str:
        """What's synced from here, in one digest: when it changes, it's time to sync."""
        facts = sorted((f.id, f.text, f.category, f.at) for f in self.memory().facts if not f.agent)
        raw = json.dumps([facts, self._settings_now()], ensure_ascii=False)
        return hashlib.sha256(raw.encode()).hexdigest()

    # ── one pass ──

    def public(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "error": self.error or STATES.get(self.state, ""),
            "at": self.at,
        }

    def _set(self, state: str, error: str = "") -> dict[str, Any]:
        self.state, self.error = state, error
        return self.public()

    async def sync(self) -> dict[str, Any]:
        async with self._lock:
            # Seen, whatever comes of it: a pass that can't finish is tried again at the
            # next change or in 5 minutes, never every few seconds.
            with contextlib.suppress(Exception):
                self._seen = self.fingerprint()
            try:
                return await self._pass()
            except SignedOut:
                return self._set("off")
            except AccountError as exc:
                log.info("sync: didn't finish (%s)", exc.status or exc.code)
                return self._set("error", exc.message)
            except Exception:  # never the loop's end: said, and tried again later
                log.exception("sync: failed")
                return self._set("error", "Sync didn't finish; it tries again in a few minutes.")

    async def _pass(self) -> dict[str, Any]:
        account = self.account
        await account.load()
        if not account.linked:
            return self._set("off")
        key = account.sync_key
        if key is None:
            return self._set("no_key")
        data = self._file()
        if data["account"] != account.account_id:  # another account (or the first time)
            self.reset()
            data = self._file()
            data["account"] = account.account_id
        await self._pull()
        items = data["items"]
        check = items.get("keycheck")
        if not check or check.get("deleted") or not check.get("data"):
            await self._save()
            return self._set("waiting")
        try:
            opened = open_item(key, "keycheck", check["data"])
        except WrongKey:
            await self._save()
            return self._set("wrong_key")
        if not isinstance(opened, dict) or opened.get("check") != KEYCHECK["check"]:
            await self._save()
            return self._set("wrong_key")
        changed = await self._memory(key)
        changed = await self._settings(key) or changed
        self.at = datetime.now().isoformat(timespec="seconds")
        self._seen = self.fingerprint()  # what this pass put in place counts as seen
        await self._save()
        if changed and self.on_change is not None:
            with contextlib.suppress(Exception):
                self.on_change()
        return self._set("ok")

    async def _pull(self) -> None:
        """What changed on the server since last time (chat items passed over)."""
        data = self._file()
        since = data["since"]
        for _ in range(PAGES):
            page = await self.account.call("GET", "/sync", params={"since": since})
            if not isinstance(page, dict):
                raise AccountError(200, "bad_answer", "askeden.com's answer couldn't be read.")
            rev = page.get("rev") if isinstance(page.get("rev"), int) else since
            if rev < data["since"]:
                # Everything was deleted there ("Start sync over"): start from nothing too.
                data["since"], data["items"], since = 0, {}, 0
                if rev == 0:
                    break
                continue
            last = since
            for item in page.get("items") or []:
                if not isinstance(item, dict) or not isinstance(item.get("key"), str):
                    continue
                item_rev = item.get("rev") if isinstance(item.get("rev"), int) else 0
                last = max(last, item_rev)
                if item["key"] in SYNCED:
                    data["items"][item["key"]] = {
                        "rev": item_rev,
                        "data": item.get("data") if isinstance(item.get("data"), str) else None,
                        "deleted": item.get("deleted") is True,
                    }
            if page.get("more") is True and last > since:
                since = last
                continue
            data["since"] = max(rev, last)
            break

    def _remote(self, key: bytes, name: str) -> tuple[Any, int]:
        """An item as the server has it (opened), and its revision; (None, rev) for none."""
        item = self._file()["items"].get(name)
        if not item or item.get("deleted") or not item.get("data"):
            return None, int(item.get("rev", 0)) if item else 0
        return open_item(key, name, item["data"]), int(item["rev"])

    async def _put(self, name: str, value: Any, base: int, key: bytes) -> bool:
        """Write an item; False when another device wrote it first (the server's copy is
        kept, to merge with)."""
        sealed = seal_item(key, name, value)
        response = await self.account.send(
            "PUT", f"/sync/{name}", body={"data": sealed, "base_rev": base}
        )
        if response.status_code == 409:
            try:
                theirs = response.json().get("item") or {}
            except (ValueError, AttributeError):
                theirs = {}
            if isinstance(theirs.get("rev"), int):
                self._file()["items"][name] = {
                    "rev": theirs["rev"],
                    "data": theirs.get("data") if isinstance(theirs.get("data"), str) else None,
                    "deleted": not isinstance(theirs.get("data"), str),
                }
            return False
        if response.status_code != 200:
            raise AccountError(
                response.status_code,
                "sync",
                f"askeden.com didn't take the {name} ({response.status_code}).",
            )
        try:
            rev = int(response.json()["rev"])
        except (ValueError, KeyError, TypeError):
            raise AccountError(
                200, "bad_answer", "askeden.com's answer couldn't be read."
            ) from None
        self._file()["items"][name] = {"rev": rev, "data": sealed, "deleted": False}
        return True

    # ── memory ──

    async def _memory(self, key: bytes) -> bool:
        """Merge the facts both ways; True when the Mac's memory changed."""
        changed = False
        for _ in range(TRIES):
            try:
                remote_doc, base = self._remote(key, "memory")
            except WrongKey:
                log.warning("sync: the memory item doesn't open; left as it is")
                return changed
            remote = []
            for raw in (
                (remote_doc or {}).get("facts") or [] if isinstance(remote_doc, dict) else []
            ):
                fact = clean_wire_fact(raw)
                if fact is not None:
                    remote.append(fact)
            local = self.local_facts()
            data = self._file()
            now = self.now_ms()
            present = {f["id"] for f in local}
            # Facts synced before and gone from here since: removed here, so a tombstone.
            for ident in list(data["facts"]):
                if ident not in present and ident not in data["tombstones"]:
                    data["tombstones"][ident] = now
                    del data["facts"][ident]
            tombs = [
                {"id": i, "text": "", "category": "other", "updated": int(t), "deleted": True}
                for i, t in data["tombstones"].items()
                if isinstance(t, int)
            ]
            merged = merge_facts(remote, local, tombs, now_ms=now)
            changed = self._apply(merged, {f["id"]: f for f in local}) or changed
            doc = {
                **(remote_doc if isinstance(remote_doc, dict) else {}),
                "v": 1,
                "facts": [
                    {k: f[k] for k in ("id", "text", "category", "updated", "deleted")}
                    for f in merged.values()
                ],
            }
            if remote_doc is not None and _canon(remote) == _canon(doc["facts"]):
                return changed
            if await self._put("memory", doc, base, key):
                return changed
        log.info("sync: memory kept crossing another device's; trying again later")
        return changed

    def _apply(self, merged: dict[str, dict[str, Any]], local: dict[str, dict[str, Any]]) -> bool:
        """The merged facts, put in the Mac's memory where they won over its own."""
        data = self._file()
        put, gone = [], []
        for ident, fact in merged.items():
            mine = local.get(ident)
            if fact["deleted"]:
                data["tombstones"][ident] = fact["updated"]
                data["facts"].pop(ident, None)
                if mine is not None and fact is not mine:
                    gone.append(mine["local"])
                continue
            data["tombstones"].pop(ident, None)
            if fact is mine:
                data["facts"][ident] = {
                    "updated": fact["updated"],
                    "at": self._at_of(mine["local"]),
                    "category": fact["category"],
                }
                continue
            if mine is not None and (mine["text"], mine["category"]) == (
                fact["text"],
                fact["category"],
            ):
                at = self._at_of(mine["local"])  # the same words: only the time moves on
                data["facts"][ident] = {
                    "updated": fact["updated"],
                    "at": at,
                    "category": fact["category"],
                }
                continue
            put.append(
                {
                    "id": mine["local"] if mine is not None else ident,
                    "text": fact["text"],
                    "category": fact["category"],
                    "at": _stamp(fact["updated"]),
                    "origin": SYNCED_ORIGIN,
                    "wire": ident,
                    "updated": fact["updated"],
                }
            )
        for ident in [i for i in data["tombstones"] if i not in merged]:
            del data["tombstones"][ident]  # older than 90 days
        if not (put or gone):
            return False
        try:
            placed, removed = self.memory().apply_synced(put, gone)
        except ValueError as exc:
            log.warning("sync: memory couldn't be saved (%s)", exc)
            return False
        placed_ids = set(placed)
        for change in put:
            if change["id"] in placed_ids:
                data["facts"][change["wire"]] = {
                    "updated": change["updated"],
                    "at": change["at"],
                    "category": change["category"],
                }
        return bool(placed or removed)

    def _at_of(self, mac_id: str) -> str:
        fact = self.memory().get(mac_id)
        return fact.at if fact is not None else ""

    # ── settings ──

    async def _settings(self, key: bytes) -> bool:
        """The owner's name, form of address and language: the newer side wins. True when
        the Mac's changed."""
        data = self._file()
        for _ in range(TRIES):
            try:
                remote, base = self._remote(key, "settings")
            except WrongKey:
                log.warning("sync: the settings item doesn't open; left as it is")
                return False
            remote = remote if isinstance(remote, dict) else None
            record = data["settings"]
            values = self._settings_now()
            first = not record
            if first or record.get("values") != values:
                local_updated = self.now_ms()
            else:
                local_updated = int(record.get("updated") or 0)
            remote_updated = remote.get("updated") if remote else None
            remote_updated = remote_updated if isinstance(remote_updated, int) else 0
            changed = False
            if remote is not None and (first or remote_updated >= local_updated):
                changed = self._take_settings(remote)
                values = self._settings_now()
                # Set here and not there (the first time): sent, the rest is theirs.
                extra = (
                    {k: v for k, v in values.items() if v and not remote.get(k)} if first else {}
                )
                data["settings"] = {"values": values, "updated": remote_updated}
                if not extra:
                    return changed
                doc = {**remote, **extra, "v": 1, "updated": self.now_ms()}
            else:
                if remote is None and not any(values.values()):
                    data["settings"] = {"values": values, "updated": local_updated}
                    return False
                doc = {**(remote or {}), **values, "v": 1, "updated": local_updated}
            if await self._put("settings", doc, base, key):
                data["settings"] = {"values": self._settings_now(), "updated": doc["updated"]}
                return changed
        return False

    def _take_settings(self, remote: dict[str, Any]) -> bool:
        changes: dict[str, Any] = {}
        if isinstance(remote.get("owner_name"), str):
            changes["owner_name"] = remote["owner_name"]
        if isinstance(remote.get("address_as"), str):
            changes["address"] = remote["address_as"]
        language = _language(remote.get("language"))
        if language:
            changes["language"] = language
        if not changes:
            return False
        try:
            return bool(self.set_prefs(changes))
        except Exception:
            log.exception("sync: the settings couldn't be applied")
            return False

    # ── when ──

    def poke(self) -> None:
        """Something changed: sync a few seconds from now."""
        self._poked.set()

    async def loop(self) -> None:
        """At start, after a change (settled), and every 5 minutes, while linked."""
        last = -EVERY_SECONDS
        loop = asyncio.get_running_loop()
        while True:
            due = loop.time() - last >= EVERY_SECONDS
            try:
                moved = self.account.linked and self.fingerprint() != self._seen
            except Exception:
                moved = False
            if self.account.linked and (due or moved or self._poked.is_set()):
                if not due:
                    await asyncio.sleep(SETTLE_SECONDS)
                self._poked.clear()
                await self.sync()
                last = loop.time()
            elif not self.account.linked:
                # Nothing to sync, so the change is heard and let go: a poke left set would
                # end every wait below at once, and the loop would spin and starve the app.
                self._poked.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._poked.wait(), LOOK_SECONDS)
