"""What Eden Cloud keeps: runs and their events in one SQLite file, and each run's files
(the source bundle it came with, the result bundle and diff it made) in a folder of its own.

Never kept: a user's Anthropic key (it lives in the service's memory from submission until its
container starts, then only in that container), the runner's token (only its SHA-256), or
anything of a run once keep_hours have passed since it ended (its row, events and files go).
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
import threading
import time
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any

TERMINAL = ("done", "failed", "cancelled", "timed_out", "over_budget")
STATES = ("uploading", "queued", "starting", "running", *TERMINAL)


@dataclass
class Run:
    id: str
    account: str
    state: str = "uploading"
    created: float = 0.0
    started: float = 0.0  # when its container was started
    ended: float = 0.0
    title: str = ""
    brief: str = ""
    model: str = ""
    budget_usd: float = 0.0
    max_minutes: int = 0
    deadline: float = 0.0  # when it's stopped, whatever it's doing
    source_kind: str = "bundle"  # bundle | git
    source_url: str = ""
    branch: str = ""
    base: str = ""
    cost_usd: float = 0.0  # what its Claude Code reported
    error: str = ""
    exit_code: int | None = None
    events: int = 0
    events_bytes: int = 0
    result_bytes: int = 0
    has_diff: bool = False
    handle: str = ""  # the backend's name for its container or machine
    runner_hash: str = ""

    @property
    def terminal(self) -> bool:
        return self.state in TERMINAL

    def public(self) -> dict[str, Any]:
        out = asdict(self)
        for private in ("runner_hash", "handle", "account", "brief"):
            out.pop(private, None)
        out["brief_chars"] = len(self.brief)
        out["has_result"] = self.result_bytes > 0
        return out


_COLUMNS = [f.name for f in fields(Run)]


class Store:
    def __init__(self, folder: Path) -> None:
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        (self.folder / "runs").mkdir(exist_ok=True)
        self._lock = threading.Lock()
        self.db = sqlite3.connect(self.folder / "eden-cloud.sqlite3", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        cols = ", ".join(f"{c} {'TEXT PRIMARY KEY' if c == 'id' else ''}" for c in _COLUMNS)
        self.db.execute(f"CREATE TABLE IF NOT EXISTS runs ({cols})")
        self.db.execute("CREATE INDEX IF NOT EXISTS runs_account ON runs (account, created)")
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS events (run TEXT, seq INTEGER, line TEXT, "
            "PRIMARY KEY (run, seq))"
        )
        self.db.commit()

    # ── runs ──

    def put(self, run: Run) -> None:
        row = asdict(run)
        row["has_diff"] = int(run.has_diff)
        marks = ", ".join("?" for _ in _COLUMNS)
        with self._lock:
            self.db.execute(
                f"INSERT OR REPLACE INTO runs ({', '.join(_COLUMNS)}) VALUES ({marks})",
                [row[c] for c in _COLUMNS],
            )
            self.db.commit()

    def _run(self, row: tuple) -> Run:
        data = dict(zip(_COLUMNS, row, strict=True))
        data["has_diff"] = bool(data["has_diff"])
        return Run(**data)

    def get(self, run_id: str) -> Run | None:
        with self._lock:
            row = self.db.execute(
                f"SELECT {', '.join(_COLUMNS)} FROM runs WHERE id = ?", (run_id,)
            ).fetchone()
        return self._run(row) if row else None

    def of_account(self, account: str, limit: int = 50) -> list[Run]:
        with self._lock:
            rows = self.db.execute(
                f"SELECT {', '.join(_COLUMNS)} FROM runs WHERE account = ? "
                "ORDER BY created DESC LIMIT ?",
                (account, limit),
            ).fetchall()
        return [self._run(r) for r in rows]

    def in_states(self, states: tuple[str, ...]) -> list[Run]:
        marks = ", ".join("?" for _ in states)
        with self._lock:
            rows = self.db.execute(
                f"SELECT {', '.join(_COLUMNS)} FROM runs WHERE state IN ({marks}) ORDER BY created",
                states,
            ).fetchall()
        return [self._run(r) for r in rows]

    def since(self, account: str, since: float) -> list[Run]:
        with self._lock:
            rows = self.db.execute(
                f"SELECT {', '.join(_COLUMNS)} FROM runs WHERE account = ? AND "
                "(created >= ? OR ended = 0 OR ended >= ?)",
                (account, since, since),
            ).fetchall()
        return [self._run(r) for r in rows]

    def delete(self, run_id: str) -> None:
        with self._lock:
            self.db.execute("DELETE FROM runs WHERE id = ?", (run_id,))
            self.db.execute("DELETE FROM events WHERE run = ?", (run_id,))
            self.db.commit()
        shutil.rmtree(self.dir(run_id), ignore_errors=True)

    # ── events ──

    def add_events(self, run: Run, lines: list[str]) -> int:
        """The runner's lines, numbered on from the last (each one's seq)."""
        with self._lock:
            for line in lines:
                run.events += 1
                run.events_bytes += len(line)
                self.db.execute(
                    "INSERT INTO events (run, seq, line) VALUES (?, ?, ?)",
                    (run.id, run.events, line),
                )
            self.db.execute(
                "UPDATE runs SET events = ?, events_bytes = ? WHERE id = ?",
                (run.events, run.events_bytes, run.id),
            )
            self.db.commit()
        return run.events

    def events_after(self, run_id: str, after: int, limit: int = 500) -> list[tuple[int, str]]:
        with self._lock:
            return self.db.execute(
                "SELECT seq, line FROM events WHERE run = ? AND seq > ? ORDER BY seq LIMIT ?",
                (run_id, after, limit),
            ).fetchall()

    # ── files ──

    def dir(self, run_id: str) -> Path:
        return self.folder / "runs" / run_id

    def file(self, run_id: str, name: str) -> Path:
        folder = self.dir(run_id)
        folder.mkdir(parents=True, exist_ok=True)
        folder.chmod(0o700)
        return folder / name

    def write_file(self, run_id: str, name: str, data: bytes) -> Path:
        path = self.file(run_id, name)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(data)
        tmp.chmod(0o600)
        tmp.replace(path)
        return path

    def drop_file(self, run_id: str, name: str) -> None:
        (self.dir(run_id) / name).unlink(missing_ok=True)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def now() -> float:
    return time.time()


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
