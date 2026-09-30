"""Script hooks: the owner's own scripts, run when something happens. An executable file in
<the data folder>/hooks/<event>/ runs on that event:

    heads-up          every heads-up shown (a meeting soon, rain, an urgent text, …)
    routine-finished  a routine's run ended (ok, failed or skipped)
    session-done      a Jarvis Code session finished its work or failed
    arrive, leave     arriving at or leaving a place a routine or the phone watches
    wake, unlock      the Mac woke up, or was unlocked
    timer             a timer, alarm or reminder went off
    webhook           a webhook call was accepted

The first time a script would run, JARVIS asks with a card (said aloud too) and remembers
the script's SHA-256; a script that changes asks again. One the owner said no to isn't asked
about again until it changes. Settings lists them all, with Allow and Don't.

A script runs as the owner, with what happened as JSON on its standard input (never in its
arguments, and never through a shell: nothing is interpolated), a small environment, in its
own folder, for at most TIMEOUT seconds; its exit status and the start of its output are
kept with the last runs. It must be a regular file inside the hooks folder (a link out of
it doesn't count), owned by the owner, writable by no one else, and executable.

Claude cost: none. Nothing here calls a model.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import signal
import stat
from collections import deque
from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from . import jsonstore

log = logging.getLogger("jarvis")

EVENTS = (
    "heads-up",
    "routine-finished",
    "session-done",
    "arrive",
    "leave",
    "wake",
    "unlock",
    "timer",
    "webhook",
)
TIMEOUT = 30.0
OUTPUT_KEPT = 4000  # characters of a run's output kept
OUTPUT_READ = 64 * 1024  # bytes read from a script; the rest is drained and dropped
RUNS_KEPT = 30
AT_ONCE = 4
PER_HOUR = 60  # one script's runs in an hour, at most (a storm of heads-ups)
MAX_SCRIPTS = 50
PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
README = """Script hooks for Jarvis.

Put an executable script (chmod +x, with a #! line) in the folder named after the event it
should run on: heads-up, routine-finished, session-done, arrive, leave, wake, unlock, timer,
webhook. It gets what happened as JSON on standard input, for example:

    {"event": "arrive", "at": "2026-09-29T18:02:11", "place": "home", "source": "phone"}

The first time a script would run, Jarvis asks you; it asks again whenever the script
changes. It runs for at most 30 seconds, as you, in its own folder.
"""

Ask = Callable[[str, str], Awaitable[bool | None]]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


class Script:
    """One script as found: where, for which event, and why it can't run (if it can't)."""

    def __init__(self, folder: Path, path: Path, event: str) -> None:
        self.path = path
        self.event = event
        self.rel = f"{event}/{path.name}"
        self.problem = ""
        self.digest = ""
        try:
            real = path.resolve(strict=True)
            if folder.resolve() not in real.parents:
                self.problem = "it points outside the hooks folder"
                return
            info = real.stat()
        except (OSError, RuntimeError):
            self.problem = "it can't be read"
            return
        if not stat.S_ISREG(info.st_mode):
            self.problem = "it isn't a file"
        elif info.st_uid != os.getuid():
            self.problem = "it isn't yours"
        elif info.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            self.problem = "others can change it (chmod go-w)"
        elif not info.st_mode & stat.S_IXUSR:
            self.problem = "it isn't executable (chmod +x)"
        else:
            try:
                self.digest = sha256(real)
            except OSError:
                self.problem = "it can't be read"


class ScriptHooks:
    """The hooks folder, what the owner allowed, and the runs.

    ask(question, detail): the owner's yes (True), no (False), or None when nobody answered.
    run(path, payload, cwd, env): runs one script (tests pass a fake; the real one is
    run_script). now(): the clock. mono(): a monotonic clock."""

    def __init__(
        self,
        folder: Path,
        state_path: Path,
        ask: Ask,
        *,
        run: Callable[..., Awaitable[tuple[str, str]]] | None = None,
        now: Callable[[], datetime] = datetime.now,
        mono: Callable[[], float] | None = None,
        on_change: Callable[[], Any] = lambda: None,
    ) -> None:
        import time

        self.folder = folder
        self.path = state_path
        self.ask = ask
        self.run = run or run_script
        self.now = now
        self.mono = mono or time.monotonic
        self.on_change = on_change
        self._state: dict[str, Any] | None = None
        self._busy: set[str] = set()  # scripts running now
        self._asking: set[str] = set()  # "rel:digest" with a card up
        self._recent: dict[str, deque[float]] = {}
        self._slots: asyncio.Semaphore | None = None

    # ── what it remembers ──

    @property
    def state(self) -> dict[str, Any]:
        if self._state is None:
            try:
                data = jsonstore.load_json(self.path, dict) or {}
            except jsonstore.Unreadable:
                data = {}

            def digests(key: str) -> dict[str, str]:
                raw = data.get(key) if isinstance(data.get(key), dict) else {}
                return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, str)}

            # A run history of the wrong type (a hand edit) is left out, and each run keeps
            # its words as words: Settings shows them.
            listed = data.get("runs") if isinstance(data.get("runs"), list) else []
            runs = [
                {**r, **{k: str(r.get(k) or "") for k in ("at", "path", "status", "output")}}
                for r in listed
                if isinstance(r, dict)
            ][-RUNS_KEPT:]
            self._state = {"allowed": digests("allowed"), "denied": digests("denied"), "runs": runs}
        return self._state

    def _save(self) -> None:
        try:
            jsonstore.save_json(self.path, self.state)
        except OSError as exc:
            log.info("hooks: couldn't save (%s)", exc)

    def _changed(self) -> None:
        try:
            self.on_change()
        except Exception:
            log.exception("hooks: on_change failed")

    # ── the folder ──

    def scripts(self, event: str | None = None) -> list[Script]:
        found: list[Script] = []
        for name in (event,) if event else EVENTS:
            place = self.folder / name
            try:
                entries = sorted(place.iterdir())
            except OSError:
                continue
            for path in entries:
                if path.name.startswith(".") or path.name.lower().startswith("readme"):
                    continue
                found.append(Script(self.folder, path, name))
                if len(found) >= MAX_SCRIPTS:
                    return found
        return found

    def ensure_folder(self) -> Path:
        """The hooks folder with a folder per event and a README (Settings' Open the folder)."""
        for name in EVENTS:
            (self.folder / name).mkdir(parents=True, exist_ok=True)
        readme = self.folder / "README.txt"
        if not readme.exists():
            readme.write_text(README, encoding="utf-8")
        return self.folder

    def status(self, script: Script) -> str:
        if script.problem:
            return "problem"
        if self.state["allowed"].get(script.rel) == script.digest:
            return "allowed"
        if self.state["denied"].get(script.rel) == script.digest:
            return "denied"
        if script.rel in self.state["allowed"]:
            return "changed"
        return "new"

    def public(self) -> dict[str, Any]:
        scripts = self.scripts()
        return {
            "folder": str(self.folder),
            "scripts": [
                {
                    "path": s.rel,
                    "event": s.event,
                    "state": self.status(s),
                    "problem": s.problem,
                }
                for s in scripts
            ],
            "runs": list(reversed(self.state["runs"]))[:10],
        }

    # ── the owner's say, from Settings ──

    def decide(self, rel: str, allow: bool) -> bool:
        """Allow (or don't) a script as it is now; False when there's no such script."""
        script = next((s for s in self.scripts() if s.rel == rel and not s.problem), None)
        if script is None:
            return False
        self._remember(script, allow)
        return True

    def _remember(self, script: Script, allow: bool) -> None:
        keep, drop = ("allowed", "denied") if allow else ("denied", "allowed")
        self.state[keep][script.rel] = script.digest
        self.state[drop].pop(script.rel, None)
        self._save()
        self._changed()

    # ── an event ──

    async def fire(self, event: str, data: dict[str, Any]) -> list[str]:
        """Run every script for this event that may run; which ones ran."""
        if event not in EVENTS:
            return []
        scripts = await asyncio.to_thread(self.scripts, event)
        if not scripts:
            return []
        payload = json.dumps(
            {"event": event, "at": self.now().isoformat(timespec="seconds"), **data},
            ensure_ascii=False,
            default=str,
        ).encode()
        ran = await asyncio.gather(*(self._one(s, payload) for s in scripts))
        return [s.rel for s, did in zip(scripts, ran, strict=True) if did]

    async def _one(self, script: Script, payload: bytes) -> bool:
        if script.problem:
            return False
        state = self.status(script)
        if state == "denied":
            return False
        if state in ("new", "changed"):
            key = f"{script.rel}:{script.digest}"
            if key in self._asking:
                return False  # its card is up already
            self._asking.add(key)
            try:
                answer = await self.ask(
                    f"Run your script “{script.path.name}” when “{script.event}” happens?",
                    f"{script.path}\nSHA-256 {script.digest[:16]}…\n\nIt runs as you, with what "
                    "happened as JSON on its input, for at most 30 seconds."
                    + ("\nIt changed since you allowed it." if state == "changed" else ""),
                )
            finally:
                self._asking.discard(key)
            if answer is None:
                return False  # nobody answered: asked again next time
            self._remember(script, answer)
            if not answer:
                return False
        if script.rel in self._busy:
            return False
        stamp = self.mono()
        recent = self._recent.setdefault(script.rel, deque())
        while recent and stamp - recent[0] >= 3600:
            recent.popleft()
        if len(recent) >= PER_HOUR:
            return False
        recent.append(stamp)
        if self._slots is None:
            self._slots = asyncio.Semaphore(AT_ONCE)
        self._busy.add(script.rel)
        started = self.mono()
        try:
            async with self._slots:
                # The yes was for the script as it was hashed (its card could wait minutes):
                # what's there now runs only if it's still that script.
                now = await asyncio.to_thread(Script, self.folder, script.path, script.event)
                if now.problem or now.digest != script.digest:
                    log.info("hooks: %s changed before it ran; it asks again", script.rel)
                    return False
                env = {
                    "PATH": PATH,
                    "HOME": str(Path.home()),
                    "LANG": "en_US.UTF-8",
                    "JARVIS_EVENT": script.event,
                }
                status, output = await self.run(script.path, payload, script.path.parent, env)
        except Exception as exc:
            status, output = "failed to start", type(exc).__name__
        finally:
            self._busy.discard(script.rel)
        self.state["runs"] = [
            *self.state["runs"],
            {
                "at": self.now().isoformat(timespec="seconds"),
                "path": script.rel,
                "status": status,
                "output": output[:OUTPUT_KEPT],
                "seconds": round(self.mono() - started, 1),
            },
        ][-RUNS_KEPT:]
        self._save()
        self._changed()
        return True


async def run_script(
    path: Path, payload: bytes, cwd: Path, env: dict[str, str], timeout: float = TIMEOUT
) -> tuple[str, str]:
    """Run one script: the payload on its standard input, its own process group (so a
    timeout ends everything it started), at most `timeout` seconds. (status, output)."""
    proc = await asyncio.create_subprocess_exec(
        str(path),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(cwd),
        env=env,
        start_new_session=True,
    )

    async def talk() -> bytes:
        assert proc.stdin is not None and proc.stdout is not None
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            proc.stdin.write(payload)
            await proc.stdin.drain()
        with contextlib.suppress(OSError):
            proc.stdin.close()
        kept = bytearray()
        while chunk := await proc.stdout.read(65536):
            if len(kept) < OUTPUT_READ:
                kept += chunk[: OUTPUT_READ - len(kept)]
        await proc.wait()
        return bytes(kept)

    try:
        out = await asyncio.wait_for(talk(), timeout)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), 5)
        return "timed out", ""
    text = out.decode("utf-8", errors="replace").strip()
    return ("ok" if proc.returncode == 0 else f"exit {proc.returncode}"), text
