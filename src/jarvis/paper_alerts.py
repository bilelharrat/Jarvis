"""Paper alerts: the owner follows topics, authors, or the citations of a paper, and hears when
new work appears. OpenAlex is asked at most once a day (the feature's loop wakes hourly and checks
only when a day has passed); what it finds is kept as "news" for a week's "what's new" and told
through a heads-up.

When something is first followed, what the index already has is taken as seen, so the first
alert is about papers that are new since then, never a flood of old ones.

Claude cost policy: no model call; the loop and the tools only ask OpenAlex (free, no key).
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from collections.abc import Callable
from datetime import date, timedelta
from pathlib import Path
from typing import Any

from .scholar import OPENALEX, Scholar, short_id

KINDS = ("topic", "author", "citations")
CHECK_EVERY = 24 * 3600  # at most one check a day
WINDOW_DAYS = 60  # papers published this recently are looked at
PER_FOLLOW = 25  # the newest papers looked at for each follow
MAX_SEEN = 600
MAX_NEWS = 300
KEEP_NEWS_DAYS = 60
MAX_FOLLOWS = 40
TYPES = "type:article|preprint|review|book-chapter|book|dissertation"


def compact(work: dict[str, Any]) -> dict[str, Any]:
    """The parts of an OpenAlex work that describe() reads, kept small."""
    source = ((work.get("primary_location") or {}).get("source") or {}).get("display_name")
    oa = work.get("open_access") or {}
    return {
        "id": work.get("id"),
        "display_name": work.get("display_name"),
        "publication_year": work.get("publication_year"),
        "publication_date": work.get("publication_date"),
        "doi": work.get("doi"),
        "type": work.get("type"),
        "cited_by_count": work.get("cited_by_count"),
        "is_retracted": bool(work.get("is_retracted")),
        "authorships": [
            {"author": {"display_name": (a.get("author") or {}).get("display_name")}}
            for a in (work.get("authorships") or [])[:20]
        ],
        "primary_location": {"source": {"display_name": source}} if source else {},
        "open_access": {"is_oa": bool(oa.get("is_oa")), "oa_url": oa.get("oa_url")},
    }


def short_title(title: str, words: int = 8) -> str:
    parts = str(title or "a paper").split()
    return " ".join(parts[:words]) + ("…" if len(parts) > words else "")


class PaperAlerts:
    def __init__(self, path: Path, scholar: Scholar, *, clock: Callable[[], float] = time.time) -> None:
        self.path = Path(path)
        self.scholar = scholar
        self.clock = clock
        # The brain's tools and the loop both change the file: one at a time.
        self._lock = threading.RLock()

    # ── the file ──

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            data = {}
        if not isinstance(data, dict):
            data = {}
        data["follows"] = [f for f in data.get("follows") or [] if isinstance(f, dict) and f.get("kind") in KINDS]
        data["news"] = [n for n in data.get("news") or [] if isinstance(n, dict) and isinstance(n.get("work"), dict)]
        data["last_check"] = float(data.get("last_check") or 0)
        return data

    def _save(self, data: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False))
        tmp.replace(self.path)

    def follows(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._load()["follows"]

    def due(self) -> bool:
        with self._lock:
            data = self._load()
        return bool(data["follows"]) and self.clock() - data["last_check"] >= CHECK_EVERY

    # ── following ──

    async def follow(self, kind: str, what: str) -> tuple[dict[str, Any] | None, str]:
        """Follow a topic (words), an author (a name or an OpenAlex A… id) or a paper's citations
        (a DOI, W… id or title). The entry and a sentence for the owner (None when it couldn't)."""
        kind = kind if kind in KINDS else "topic"
        what = str(what or "").strip()[:300]
        if not what:
            return None, "Say what to follow: a topic, an author, or a paper."
        if len(self.follows()) >= MAX_FOLLOWS:
            return None, f"You already follow {MAX_FOLLOWS} things: unfollow one first."
        entry: dict[str, Any] = {"id": uuid.uuid4().hex[:8], "kind": kind, "added": date.today().isoformat()}
        if kind == "topic":
            entry.update(query=what, label=what)
        elif kind == "author":
            author = await self._author(what)
            if not author:
                return None, f"I couldn't find an author called {what} in the index."
            inst = ((author.get("last_known_institutions") or [{}]) or [{}])[0].get("display_name")
            entry.update(
                author=short_id(author),
                label=str(author.get("display_name") or what),
                detail=(f" at {inst}" if inst else "") + f", {int(author.get('works_count') or 0)} works",
            )
        else:
            work = await self.scholar.work(what)
            if not work:
                return None, "I couldn't find that paper."
            entry.update(work=short_id(work), label=str(work.get("display_name") or what))
        with self._lock:
            data = self._load()
            for old in data["follows"]:
                if old["kind"] == kind and all(old.get(k) == entry.get(k) for k in ("query", "author", "work")):
                    return old, f"You already follow {self.said(old)}."
        # What the index has now counts as seen: only what comes after is news.
        seen = [short_id(w) for w in await self._recent(entry)]
        entry["seen"] = seen
        with self._lock:
            data = self._load()
            data["follows"].append(entry)
            self._save(data)
        return entry, (
            f"Following {self.said(entry)}{entry.get('detail', '')}. I'll check for new papers once a "
            "day and tell you when there are some."
        )

    def unfollow(self, words: str) -> dict[str, Any] | None:
        key = str(words or "").strip().lower()
        if not key:
            return None
        with self._lock:
            data = self._load()
            for i, f in enumerate(data["follows"]):
                label = str(f.get("label") or "").lower()
                if key in (f["id"], f.get("author", "").lower(), f.get("work", "").lower()) or key in label or (label and label in key):
                    gone = data["follows"].pop(i)
                    data["news"] = [n for n in data["news"] if n.get("follow") != gone["id"]]
                    self._save(data)
                    return gone
        return None

    @staticmethod
    def said(follow: dict[str, Any]) -> str:
        label = str(follow.get("label") or "")
        if follow["kind"] == "author":
            return f"the author {label}"
        if follow["kind"] == "citations":
            return f"papers citing {short_title(label)}"
        return f"the topic {label}"

    # ── checking ──

    async def _author(self, name: str) -> dict[str, Any] | None:
        name = name.strip()
        if re.fullmatch(r"(https://openalex\.org/)?A\d+", name, re.I):
            r = await self.scholar.client().get(f"{OPENALEX}/authors/{name.rsplit('/', 1)[-1].upper()}")
            return r.json() if r.status_code == 200 else None
        r = await self.scholar.client().get(f"{OPENALEX}/authors", params={"search": name, "per-page": "1"})
        r.raise_for_status()
        found = r.json().get("results") or []
        return found[0] if found else None

    async def _recent(self, follow: dict[str, Any]) -> list[dict[str, Any]]:
        """The newest papers for one follow, published in the last WINDOW_DAYS days."""
        since = (date.fromtimestamp(self.clock()) - timedelta(days=WINDOW_DAYS)).isoformat()
        filters = [TYPES, f"from_publication_date:{since}"]
        if follow["kind"] == "topic":
            filters.append(f"title_and_abstract.search:{str(follow.get('query') or '').replace(',', ' ')}")
        elif follow["kind"] == "author":
            filters.append(f"authorships.author.id:{follow['author']}")
        else:
            filters.append(f"cites:{follow['work']}")
        params = {"filter": ",".join(filters), "sort": "publication_date:desc", "per-page": str(PER_FOLLOW)}
        r = await self.scholar.client().get(f"{OPENALEX}/works", params=params)
        r.raise_for_status()
        return list(r.json().get("results") or [])

    async def check(self) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        """Ask the index about every follow; the new papers (follow, work), kept as news. A follow
        whose check fails is tried again next time; the others count."""
        found: list[tuple[str, dict[str, Any]]] = []
        for follow in self.follows():
            try:
                works = await self._recent(follow)
            except Exception:
                continue
            seen = set(follow.get("seen") or [])
            for w in works:
                if short_id(w) and short_id(w) not in seen:
                    found.append((follow["id"], w))
        today = date.fromtimestamp(self.clock()).isoformat()
        new: list[tuple[dict[str, Any], dict[str, Any]]] = []
        with self._lock:
            data = self._load()
            by_id = {f["id"]: f for f in data["follows"]}
            for follow_id, w in found:
                follow = by_id.get(follow_id)
                if follow is None:  # unfollowed while the check ran
                    continue
                wid = short_id(w)
                if wid in follow.setdefault("seen", []):
                    continue
                follow["seen"] = (follow["seen"] + [wid])[-MAX_SEEN:]
                data["news"].append({"found": today, "follow": follow_id, "work": compact(w)})
                new.append((follow, w))
            cutoff = (date.fromtimestamp(self.clock()) - timedelta(days=KEEP_NEWS_DAYS)).isoformat()
            data["news"] = [n for n in data["news"] if str(n.get("found") or "") >= cutoff][-MAX_NEWS:]
            data["last_check"] = self.clock()
            self._save(data)
        return new

    def news(self, days: int = 7) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        """What was found in the last `days` days, (follow, work), newest finds first."""
        cutoff = (date.fromtimestamp(self.clock()) - timedelta(days=max(1, int(days)))).isoformat()
        with self._lock:
            data = self._load()
        by_id = {f["id"]: f for f in data["follows"]}
        out = [(by_id[n["follow"]], n["work"]) for n in data["news"] if n.get("follow") in by_id and str(n.get("found") or "") > cutoff]
        return list(reversed(out))

    @classmethod
    def heads_up(cls, new: list[tuple[dict[str, Any], dict[str, Any]]]) -> str:
        """One sentence for the heads-up: how many, and for what."""
        counts: dict[str, int] = {}
        follows: dict[str, dict[str, Any]] = {}
        for follow, _w in new:
            counts[follow["id"]] = counts.get(follow["id"], 0) + 1
            follows[follow["id"]] = follow
        parts = []
        for fid, n in sorted(counts.items(), key=lambda kv: -kv[1]):
            f = follows[fid]
            what = {"author": f"by {f.get('label')}", "citations": f"citing {short_title(str(f.get('label')), 6)}"}.get(
                f["kind"], f"on {f.get('label')}"
            )
            parts.append(f"{n} {what}")
        total = len(new)
        listed = ", ".join(parts[:4]) + (", and more" if len(parts) > 4 else "")
        return f"{total} new paper{'s' if total != 1 else ''} for what you follow: {listed}. Ask me what's new in research to hear them."
