"""Zotero sync for the scholar library, through the Zotero Web API (v3): the owner's Zotero items
brought into the library JARVIS keeps (so they can be cited, listed and put in a bibliography by
voice), and papers saved with JARVIS added to their Zotero library.

The owner's API key (made at zotero.org/settings/keys) and their user id are kept in the system's
secret store (Windows Credential Manager, the macOS Keychain) through keyring, never in a file, a
log or a card; the key is checked against Zotero before it is kept, which also gives the user id.

Claude cost policy: no model call; these are tools of the ordinary conversation.
"""

from __future__ import annotations

import contextlib
import re
import secrets
import time
from typing import Any

API = "https://api.zotero.org"
SERVICE = "Jarvis Zotero"
PAGE = 100
MAX_ITEMS = 5000
SKIP_TYPES = {"attachment", "note", "annotation"}


class ZoteroError(RuntimeError):
    """Something to tell the owner, in words (never the key)."""


class Vault:
    """The key and user id, in the system's secret store (keyring)."""

    def get(self, key: str) -> str | None:
        import keyring

        return keyring.get_password(SERVICE, key)

    def set(self, key: str, value: str) -> None:
        import keyring

        keyring.set_password(SERVICE, key, value)

    def delete(self, key: str) -> None:
        import keyring
        from keyring.errors import PasswordDeleteError

        with contextlib.suppress(PasswordDeleteError):
            keyring.delete_password(SERVICE, key)


class MemoryVault(Vault):
    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    def get(self, key: str) -> str | None:
        return self.data.get(key)

    def set(self, key: str, value: str) -> None:
        self.data[key] = value

    def delete(self, key: str) -> None:
        self.data.pop(key, None)


def _year(date: str) -> int | None:
    m = re.search(r"\b(1[5-9]\d{2}|20\d{2})\b", str(date or ""))
    return int(m.group(1)) if m else None


def _names(creators: list[dict[str, Any]]) -> str:
    names = []
    for c in creators or []:
        if c.get("creatorType") not in (None, "author", "editor", "contributor", "presenter", "programmer"):
            continue
        name = c.get("name") or " ".join(p for p in (c.get("firstName"), c.get("lastName")) if p)
        if name:
            names.append(str(name).strip())
    if not names:
        return "unknown authors"
    return ", ".join(names[:-1]) + (" and " if len(names) > 1 else "") + names[-1]


def _doi(data: dict[str, Any]) -> str:
    """The item's DOI: its own field, or a "DOI: …" line in Extra (where Zotero keeps one for
    item types without the field)."""
    from .scholar import clean_doi

    m = re.search(r"(?im)^\s*DOI:\s*(\S+)", str(data.get("extra") or ""))
    return clean_doi(data.get("DOI")) or (clean_doi(m.group(1)) if m else "")


def entry_from_item(item: dict[str, Any]) -> dict[str, Any] | None:
    """A Zotero item as a library entry (None for notes and attachments)."""
    data = item.get("data") or {}
    if data.get("itemType") in SKIP_TYPES or not data.get("title"):
        return None
    return {
        "id": f"zotero:{item.get('key') or data.get('key')}",
        "doi": _doi(data).lower() or "",
        "title": str(data["title"]).strip(),
        "authors": _names(data.get("creators") or []),
        "year": _year(data.get("date")),
        "venue": str(data.get("publicationTitle") or data.get("bookTitle") or data.get("proceedingsTitle") or data.get("publisher") or "").strip(),
        "note": "",
        "saved": time.strftime("%Y-%m-%d"),
        "zotero": str(item.get("key") or data.get("key") or ""),
    }


def item_from_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """A library entry as a new Zotero item (a journal article: what the library mostly holds)."""
    authors = str(entry.get("authors") or "")
    authors = re.sub(r" and \d+ others$", "", authors)
    creators = []
    if authors and authors != "unknown authors":
        for name in re.split(r",\s*| and ", authors):
            name = name.strip()
            if not name:
                continue
            first, _, last = name.rpartition(" ")
            creators.append({"creatorType": "author", "firstName": first, "lastName": last} if first else {"creatorType": "author", "name": last})
    doi = str(entry.get("doi") or "")
    return {
        "itemType": "journalArticle",
        "title": str(entry.get("title") or "Untitled"),
        "creators": creators,
        "date": str(entry.get("year") or ""),
        "publicationTitle": str(entry.get("venue") or ""),
        "DOI": doi,
        "url": f"https://doi.org/{doi}" if doi else "",
        "abstractNote": "",
        "extra": f"Added by J.A.R.V.I.S.{(' Note: ' + entry['note']) if entry.get('note') else ''}",
        "tags": [],
        "collections": [],
        "relations": {},
    }


class Zotero:
    def __init__(self, client: Any, vault: Vault | None = None) -> None:
        self.client = client  # an httpx.AsyncClient (the scholar's)
        self.vault = vault or Vault()

    def credentials(self) -> tuple[str, str]:
        try:
            return self.vault.get("api_key") or "", self.vault.get("user_id") or ""
        except Exception:  # no secret store reachable
            return "", ""

    def connected(self) -> bool:
        key, user = self.credentials()
        return bool(key and user)

    def _headers(self, key: str) -> dict[str, str]:
        return {"Zotero-API-Key": key, "Zotero-API-Version": "3"}

    async def probe(self, api_key: str, user_id: str = "") -> dict[str, Any]:
        """Ask Zotero whose key this is, without keeping it: {key, user_id, name, write}."""
        api_key = str(api_key or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9]{16,64}", api_key):
            raise ZoteroError("That doesn't look like a Zotero API key: it is 24 letters and digits, from zotero.org/settings/keys.")
        r = await self.client.get(f"{API}/keys/current", headers=self._headers(api_key))
        if r.status_code in (403, 404):
            raise ZoteroError("Zotero didn't accept that key.")
        r.raise_for_status()
        info = r.json()
        found = str(info.get("userID") or "")
        user_id = str(user_id or "").strip()
        if user_id and found and user_id != found:
            raise ZoteroError("That key belongs to another Zotero user id than the one given.")
        user_id = user_id or found
        if not user_id.isdigit():
            raise ZoteroError("Zotero didn't say whose key that is. Give me your user id too, from zotero.org/settings/keys.")
        access = (info.get("access") or {}).get("user") or {}
        return {"key": api_key, "user_id": user_id, "name": str(info.get("username") or ""), "write": bool(access.get("write"))}

    def keep(self, account: dict[str, Any]) -> str:
        """Keep a probed key in the secret store; a sentence for the owner."""
        self.vault.set("api_key", account["key"])
        self.vault.set("user_id", account["user_id"])
        name = account.get("name") or ""
        return f"Connected to Zotero{(' as ' + name) if name else ''}." + (
            "" if account.get("write") else " The key can only read: to add papers to Zotero, make one that can write."
        )

    def forget(self) -> None:
        self.vault.delete("api_key")
        self.vault.delete("user_id")

    def _need(self) -> tuple[str, str]:
        key, user = self.credentials()
        if not (key and user):
            raise ZoteroError("Zotero isn't connected: give me your Zotero API key first.")
        return key, user

    async def items(self) -> list[dict[str, Any]]:
        """Every top-level item in the owner's Zotero library (up to MAX_ITEMS)."""
        key, user = self._need()
        out: list[dict[str, Any]] = []
        start = 0
        while start < MAX_ITEMS:
            r = await self.client.get(
                f"{API}/users/{user}/items/top",
                params={"format": "json", "limit": str(PAGE), "start": str(start)},
                headers=self._headers(key),
            )
            if r.status_code == 403:
                raise ZoteroError("Zotero refused the key: it may have been revoked.")
            r.raise_for_status()
            page = r.json()
            if not isinstance(page, list) or not page:
                break
            out.extend(i for i in page if isinstance(i, dict))
            total = int(r.headers.get("Total-Results") or 0)
            start += len(page)
            if len(page) < PAGE or (total and start >= total):
                break
        return out

    async def add(self, entries: list[dict[str, Any]]) -> dict[int, str]:
        """Add library entries to Zotero; {the entry's place in the list: its new Zotero key}."""
        key, user = self._need()
        added: dict[int, str] = {}
        for chunk_start in range(0, len(entries), 50):  # Zotero takes 50 items a request
            chunk = entries[chunk_start : chunk_start + 50]
            r = await self.client.post(
                f"{API}/users/{user}/items",
                json=[item_from_entry(e) for e in chunk],
                headers={**self._headers(key), "Zotero-Write-Token": secrets.token_hex(16)},
            )
            if r.status_code == 403:
                raise ZoteroError("Zotero won't let this key add items: make a key that can write.")
            r.raise_for_status()
            answer = r.json() or {}
            for place, value in (answer.get("success") or {}).items():
                added[chunk_start + int(place)] = str(value)
            for place, value in (answer.get("successful") or {}).items():
                added.setdefault(chunk_start + int(place), str((value or {}).get("key") or ""))
        return added
