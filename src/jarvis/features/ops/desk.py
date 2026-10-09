"""The ops desk: what Settings › Health & safety, first-run Setup and Backups talk to.

One per hub (features.ops.install makes it). Window commands arrive through
hub.register_command; anything slow (the checkup, a backup, a restore, a diagnostics file)
runs in the background and answers with an event, so the window's socket is never held
up. Blocking work (zips, hashes, SQLite, psutil) goes to a thread.

Where it reads and writes: beside prefs.json (the hub's feature_path) for its own files;
~/Documents/Jarvis/Backups (or the folder the owner picks) and ~/Documents/Jarvis/
Diagnostics for what it makes; ~/Library/Logs/Jarvis for the logs it reads. When the data
folder isn't the app's own (tests, a development server), "home" is a folder beside it, so
nothing here can reach the real Documents or Library.

Cost: no model is ever called here.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import logging
import math
import os
import threading
import time
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from ... import lang, osplat
from ... import prefs as prefs_module
from ...proactive import Alert
from . import audit, backup, diagnostics, doctor, permissions
from .permissions import Runner, run_process

log = logging.getLogger("jarvis")

DAILY_FIRST_DELAY = 10 * 60.0  # seconds after the start before the first daily look
DAILY_EVERY = 60 * 60.0  # then hourly: a Mac asleep at the usual time still gets one
DAILY_GAP = timedelta(hours=20)  # a daily backup newer than this is today's
MIC_SECONDS = 30.0
METER_SECONDS = 8.0  # the intro's live microphone meter, read off hands-free's stream
SETUP_STATES = ("", "pending", "done", "skipped")
VOICE_SAMPLE = "Hello. This is how I sound. If you can hear me clearly, the voice is working."
VOICE_SAMPLE_ZH = "你好，这就是我的声音。如果你能听清楚，说明语音一切正常。"
BACKUP_FAILED = "Today's backup didn't work: {why}"
BACKUP_FAILED_ZH = "今天的备份没有成功：{why}"
lang.ZH_TEXTS.setdefault(VOICE_SAMPLE, VOICE_SAMPLE_ZH)
lang.ZH_TEXTS.setdefault(BACKUP_FAILED, BACKUP_FAILED_ZH)

PROMPT = (
    "\n- Checkup (run_checkup): when the user asks for a checkup, a health check or whether "
    "everything is working (“run a checkup”, “做个体检”, "
    "“检查一下系统”), run it and say the result in a sentence or two; details and "
    "fixes are in Settings › Health & safety."
)
LABELS = {"run_checkup": "Ran a checkup"}

# Where the setup sheet's "fresh install" comes from: prepare() saw no prefs.json at the
# start, before any store read its file (features.prepare_all, from server.serve).
STARTUP: dict[str, Any] = {"folder": None, "fresh": False}


class Ops:
    def __init__(
        self,
        hub: Any,
        *,
        home: Path | None = None,
        logs: Path | None = None,
        run: Runner | None = None,
        clock: Callable[[], datetime] = datetime.now,
    ) -> None:
        self.hub = hub
        self._home = home
        self._logs = logs
        self.run: Runner = run or run_process
        self.clock = clock
        self.probe_extra: dict[str, Any] = {}  # tests: processes, children, whisper_cached…
        self.last_doctor: dict[str, Any] | None = None
        self.last_review: dict[str, Any] | None = None
        self._doctor_task: asyncio.Task | None = None
        self._permissions_task: asyncio.Task | None = None
        self._claude_task: asyncio.Task | None = None
        self._backup_lock: asyncio.Lock | None = None
        self._busy: set[str] = set()
        self._mic_busy = False
        self._meter_task: asyncio.Task | None = None
        self.meter_seconds = METER_SECONDS
        self._backup_failed_told = False
        self._tasks: set[asyncio.Task] = set()

    # ── where things are ──

    @property
    def data(self) -> Path:
        return Path(self.hub.feature_path("prefs.json")).parent

    def is_app_folder(self) -> bool:
        with contextlib.suppress(OSError, RuntimeError):
            return self.data.resolve() == prefs_module.APP_SUPPORT.resolve()
        return False

    @property
    def home(self) -> Path:
        """The owner's home folder; beside a data folder that isn't the app's own (a test's,
        a development server's), a stand-in of its own, never the real one."""
        if self._home is not None:
            return self._home
        data = self.data
        return Path.home() if self.is_app_folder() else data.parent / f"{data.name}-home"

    @property
    def logs(self) -> Path:
        if self._logs is not None:
            return self._logs
        return osplat.logs_dir(self.home)

    def backup_folder(self) -> Path:
        chosen = self.hub.prefs.feature("ops_backup_folder") or ""
        return Path(chosen).expanduser() if chosen else backup.default_folder(self.home)

    def backup_folders(self) -> list[Path]:
        """Where backups are listed from: the chosen folder, and the default one too when
        another is chosen (earlier backups stay listed)."""
        chosen, default = self.backup_folder(), backup.default_folder(self.home)
        return [chosen] if chosen == default else [chosen, default]

    def diagnostics_folder(self) -> Path:
        return diagnostics.default_folder(self.home)

    def label(self, path: Path) -> str:
        """A folder as the window shows it: ~/… inside the home folder."""
        home = str(self.home).rstrip("/")
        text = str(path)
        return "~" + text[len(home) :] if text == home or text.startswith(home + "/") else text

    # ── the window ──

    def spawn(self, coro: Awaitable[Any]) -> asyncio.Task:
        spawn = getattr(self.hub, "_spawn", None)
        if callable(spawn):
            return spawn(coro)
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    def emit(self, kind: str, **data: Any) -> None:
        self.hub.emit(kind, **data)

    def _busy_now(self, what: str, on: bool) -> None:
        (self._busy.add if on else self._busy.discard)(what)
        self.emit("ops_busy", items=sorted(self._busy))

    # ── state and first-run setup ──

    def setup_info(self) -> dict[str, Any]:
        """Setup shows by itself on a fresh install, and once on an install from before
        the intro that has never been through it, until it's finished or skipped; it can
        always be opened from Settings."""
        state = self.hub.prefs.feature("ops_setup_state") or ""
        if state == "" and STARTUP["folder"] is not None and Path(STARTUP["folder"]) == self.data:
            self.hub.set_feature_prefs({"ops_setup_state": "pending"})
            state = "pending"
        return {"state": state, "show": state == "pending"}

    def _backups_info(self) -> dict[str, Any]:
        folder = self.backup_folder()
        items = backup.list_backups(self.backup_folders())
        error = ""
        if not os.path.isdir(folder) and os.path.lexists(folder):
            error = "The backup folder isn't a folder."
        elif self.hub.prefs.feature("ops_backup_folder") and not folder.parent.exists():
            error = "The backup folder isn't available."
        return {
            "folder": str(folder),
            "folder_label": self.label(folder),
            "default_folder": str(backup.default_folder(self.home)),
            "chosen": bool(self.hub.prefs.feature("ops_backup_folder")),
            "daily": bool(self.hub.prefs.feature("ops_backup_daily")),
            "knowledge": bool(self.hub.prefs.feature("ops_backup_knowledge")),
            "items": items[:60],
            "newest": backup.newest(items),
            "pending": backup.pending(self.data),
            "error": error,
        }

    async def backups_info(self) -> dict[str, Any]:
        return await asyncio.to_thread(self._backups_info)

    async def state(self, _msg: dict[str, Any] | None = None) -> None:
        setup = self.setup_info()
        backups_now, restored = await asyncio.gather(
            self.backups_info(), asyncio.to_thread(backup.take_result, self.data)
        )
        self.emit(
            "ops_state",
            setup=setup,
            backups=backups_now,
            restored=restored,
            doctor=self._headline(self.last_doctor),
            security=self._headline(self.last_review),
            busy=sorted(self._busy),
            data_folder=str(self.data),
            app=self.is_app_folder(),
        )

    @staticmethod
    def _headline(result: dict[str, Any] | None) -> dict[str, Any] | None:
        if not result:
            return None
        return {
            "at": result.get("at"),
            "counts": result.get("counts"),
            "worst": result.get("worst"),
        }

    async def setup(self, msg: dict[str, Any]) -> None:
        state = msg.get("state")
        if state in SETUP_STATES and state:
            self.hub.set_feature_prefs({"ops_setup_state": state})
        await self.state()

    async def permissions_check(self, _msg: dict[str, Any] | None = None) -> None:
        """Setup's permission list, live (the window asks again every few seconds while
        that step shows): one check at a time."""
        task = self._permissions_task
        if task is None or task.done():
            self._permissions_task = self.spawn(self._permissions())

    async def _permissions(self) -> None:
        found = await permissions.statuses(self.run)
        self.emit(
            "ops_permissions",
            rows=permissions.rows(found),
            error=found.get("error", ""),
            at=self.clock().isoformat(timespec="seconds"),
        )

    async def claude_check(self, _msg: dict[str, Any] | None = None) -> None:
        """Setup's Claude sign-in (Claude's own `auth status`): one check at a time."""
        task = self._claude_task
        if task is None or task.done():
            self._claude_task = self.spawn(self._claude())

    async def _claude(self) -> None:
        self.emit("ops_claude", **await doctor.claude_check(self.probe()))

    async def open_settings(self, msg: dict[str, Any]) -> None:
        url = permissions.settings_url(str(msg.get("pane", "")))
        if url is not None:
            self.spawn(self._open(url))

    async def _open(self, url: str) -> None:
        try:
            if osplat.IS_WIN:
                osplat.open_target(url)
            else:
                await self.run("open", url, timeout=10)
        except (OSError, TimeoutError) as exc:
            log.warning("couldn't open System Settings (%s)", exc)

    async def voice_test(self, _msg: dict[str, Any] | None = None) -> None:
        muted = bool(getattr(self.hub.speaker, "muted", False))
        if not muted:
            self.hub.say(VOICE_SAMPLE, follow_up=False)
        self.emit("ops_voice", muted=muted)

    async def mic_test(self, _msg: dict[str, Any] | None = None) -> None:
        hub = self.hub
        if self._mic_busy:
            return
        if hub.prefs.hands_free:
            self.emit("ops_mic", state="hands_free")
            return
        if getattr(hub, "meeting", None) is not None or hub.state != "idle":
            self.emit("ops_mic", state="busy")
            return
        self._mic_busy = True
        self.spawn(self._mic())

    async def mic_meter(self, _msg: dict[str, Any] | None = None) -> None:
        """The intro's live microphone meter. While hands-free listens, its own stream's
        levels for a few seconds (nothing is recorded, kept or transcribed), then the
        loudest: {"state": "metered", "peak"}. Otherwise it's the microphone test: one
        utterance, its levels, then what was heard."""
        listener = getattr(self.hub, "_listener", None)
        if listener is None or not getattr(listener, "running", False):
            if self.hub.prefs.hands_free:  # on, but its microphone never opened
                self.emit("ops_mic", state="metered", peak=0.0)
                return
            await self.mic_test()
            return
        task = self._meter_task
        if task is None or task.done():
            self._meter_task = self.spawn(self._meter(listener))

    async def _meter(self, listener: Any) -> None:
        loop = asyncio.get_running_loop()
        original = listener.on_level
        peak = [0.0]
        last = [0.0]

        def tap(rms: float) -> None:  # on the microphone's thread
            if original is not None:
                original(rms)
            value = round(min(float(rms) * 12, 1.0), 3)
            peak[0] = max(peak[0], value)
            now = time.monotonic()
            if now - last[0] < 0.1:
                return
            last[0] = now
            loop.call_soon_threadsafe(lambda: self.emit("ops_mic", state="level", level=value))

        listener.on_level = tap
        self.emit("ops_mic", state="listening")
        try:
            await asyncio.sleep(self.meter_seconds)
        finally:
            if listener.on_level is tap:
                listener.on_level = original
        self.emit("ops_mic", state="metered", peak=round(peak[0], 3))

    async def _mic(self) -> None:
        hub = self.hub
        cancel = threading.Event()
        loop = asyncio.get_running_loop()
        last = [0.0]

        def level(rms: float) -> None:
            now = time.monotonic()
            if now - last[0] < 0.1:
                return
            last[0] = now
            value = round(min(float(rms) * 12, 1.0), 3)
            loop.call_soon_threadsafe(lambda: self.emit("ops_mic", state="level", level=value))

        self.emit("ops_mic", state="listening")
        try:
            recorder = hub.recorder
            if recorder is None:
                from ...listen import pick_input_device, record_utterance

                recorder = functools.partial(
                    record_utterance, device=pick_input_device(hub.prefs.mic), cancel=cancel
                )
            audio = await asyncio.wait_for(
                asyncio.to_thread(recorder, hub.settings.silence_seconds, level), MIC_SECONDS
            )
            if audio is None:
                self.emit("ops_mic", state="silent")
                return
            stt = hub.transcriber
            if stt is None:
                self.emit("ops_mic", state="heard", text="")
                return
            self.emit("ops_mic", state="transcribing")
            text = await asyncio.to_thread(stt.transcribe, audio)
            self.emit("ops_mic", state="heard", text=str(text or "").strip()[:400])
        except TimeoutError:
            cancel.set()
            self.emit("ops_mic", state="error", text="The microphone didn't answer.")
        except Exception as exc:  # no microphone, permission denied, no audio device
            log.warning("mic test: %s", type(exc).__name__)
            self.emit("ops_mic", state="error", text="I couldn't use the microphone.")
        finally:
            self._mic_busy = False

    # ── the checkup ──

    def probe(self) -> doctor.Probe:
        return doctor.Probe(
            data=self.data,
            logs=self.logs,
            home=self.home,
            run=self.run,
            now=self.clock,
            **{"key_signin": self._key_signin, **self.probe_extra},
        )

    async def _key_signin(self) -> dict[str, Any] | None:
        """The API key JARVIS signs in with, checked now (features/signin.py); None when it
        signs in with the Claude account."""
        from .. import signin

        found = signin.signin_for(self.hub)
        return await found.check() if found is not None else None

    def hub_state(self) -> dict[str, Any]:
        """What the hub knows, read on its loop (the checks then run off it)."""
        hub = self.hub
        p = hub.prefs
        stt = getattr(hub, "transcriber", None)
        loaded = False
        with contextlib.suppress(Exception):
            loaded = bool(stt is not None and stt.loaded())
        sessions = 1 if getattr(hub, "client", None) is not None else 0
        with contextlib.suppress(Exception):
            sessions += sum(1 for t in hub.tasks.tasks.values() if t.client is not None)
        conns: list[dict[str, Any]] = []
        with contextlib.suppress(Exception):
            conns = list(hub.connectors.public()["connections"])
        age = math.inf
        with contextlib.suppress(Exception):
            age = float(hub.kb.age_hours())
        sources = any(
            [
                p.brain_notes,
                p.brain_bsh,
                p.brain_folders,
                p.brain_computer,
                p.brain_photos,
                p.brain_mail,
                p.brain_messages,
            ]
        )
        return {
            "whisper_model": lang.whisper_model(hub.language, hub.settings.whisper_model),
            "whisper_loaded": loaded,
            "open_sessions": sessions,
            "connections": conns,
            "companion_on": bool(p.remote_enabled),
            "file_index_on": bool(p.file_index),
            "file_index_db": getattr(hub.files, "path", None),
            "knowledge": hub.kb.summary(),
            "brain_state": dict(getattr(hub, "brain_state", {}) or {}),
            "knowledge_age": age,
            "knowledge_sources": sources,
        }

    def _io_state(self) -> dict[str, Any]:
        status: dict[str, Any] = {}
        with contextlib.suppress(Exception):
            status = self.hub.files.status()
        info = self._backups_info()
        return {
            "file_index": status,
            "backups": {
                "daily": info["daily"],
                "folder": info["folder"],
                "newest": info["newest"],
                "error": info["error"],
            },
        }

    async def doctor(self, _msg: dict[str, Any] | None = None, source: str = "window") -> Any:
        """Run the checkup (once at a time: a second ask waits for the one running)."""
        task = self._doctor_task
        if task is None or task.done():
            task = self._doctor_task = self.spawn(self._run_doctor())
        if source == "window":
            return None
        return await asyncio.shield(task)

    async def _run_doctor(self) -> dict[str, Any]:
        self._busy_now("doctor", True)
        try:
            state = self.hub_state()
            state.update(await asyncio.to_thread(self._io_state))
            result = await doctor.run(self.probe(), state)
            self.last_doctor = result
            self.emit("ops_doctor", **result)
            return result
        finally:
            self._busy_now("doctor", False)

    async def fix(self, msg: dict[str, Any]) -> None:
        fid = str(msg.get("fix", ""))
        if fid not in (
            "tidy_damaged",
            "rebuild_file_index",
            "rebuild_knowledge",
            "restart_connectors",
        ):
            return
        if f"fix:{fid}" in self._busy:
            return
        self._busy_now(f"fix:{fid}", True)
        self.spawn(self._fix(fid))

    async def _fix(self, fid: str) -> None:
        try:
            text = await self._apply_fix(fid)
            self.emit("ops_fixed", fix=fid, ok=True, text=text)
        except backup.BackupError as exc:
            self.emit("ops_fixed", fix=fid, ok=False, text=str(exc))
        except Exception:
            log.exception("ops: the %s fix failed", fid)
            self.emit("ops_fixed", fix=fid, ok=False, text="That didn't work.")
        finally:
            self._busy_now(f"fix:{fid}", False)
        await self.doctor()

    async def _apply_fix(self, fid: str) -> str:
        hub = self.hub
        if fid == "tidy_damaged":
            await self.make_backup("fix")  # first: the fix only moves files, but even so
            moved = await asyncio.to_thread(self._tidy_damaged)
            if moved == 1:
                return "Moved 1 damaged copy to Damaged files."
            return f"Moved {moved} damaged copies to Damaged files."
        if fid == "rebuild_file_index":
            if not hub.prefs.file_index:
                raise backup.BackupError("The file index is off.")
            await asyncio.to_thread(hub.files.clear)
            hub.emit("files_status", **await asyncio.to_thread(hub.files.status))
            self.spawn(self._refresh_files())
            return "The file index is rebuilding in the background."
        if fid == "rebuild_knowledge":
            self.spawn(hub.rebuild_brain())
            return "The second brain is rebuilding in the background."
        # restart_connectors
        again = [
            c["id"]
            for c in hub.connectors.public()["connections"]
            if c.get("status") in ("error", "disconnected")
        ]
        for cid in again:
            await hub.connectors.reconnect(cid)
        return "Reconnecting." if again else "Every account is connected."

    async def _refresh_files(self) -> None:
        with contextlib.suppress(Exception):
            await asyncio.to_thread(self.hub.files.refresh)
        with contextlib.suppress(Exception):
            self.hub.emit("files_status", **await asyncio.to_thread(self.hub.files.status))

    def _tidy_damaged(self) -> int:
        """The damaged copies moved (never deleted) into "Damaged files/<when>/"."""
        copies = doctor.damaged_copies(self.data)
        if not copies:
            return 0
        kept = self.data / "Damaged files"
        place = kept / self.clock().strftime("%Y-%m-%d at %H.%M.%S")
        for folder in (kept, place):  # each made owner-only (parents=True wouldn't)
            folder.mkdir(exist_ok=True, mode=0o700)
            os.chmod(folder, 0o700)
        moved = 0
        for path in copies:
            rel = path.relative_to(self.data)
            target = place / str(rel).replace(os.sep, " - ")
            try:
                os.replace(path, target)
            except OSError as exc:
                log.warning("couldn't move a damaged copy (%s)", exc)
                continue
            moved += 1
        return moved

    # ── the security review ──

    async def security(self, _msg: dict[str, Any] | None = None) -> None:
        self.spawn(self.review())

    async def review(self) -> dict[str, Any]:
        loose = await asyncio.to_thread(audit.loose_entries, self.data)
        result = audit.review(self.hub, self.data, self.clock(), loose=loose)
        self.last_review = result
        self.emit("ops_security", **result)
        return result

    async def tighten(self, msg: dict[str, Any]) -> None:
        aid, item = str(msg.get("action", ""))[:60], str(msg.get("item", ""))[:1000]
        self.spawn(self._tighten(aid, item))

    async def _tighten(self, aid: str, item: str) -> None:
        try:
            text = await audit.tighten(self.hub, self.data, aid, item, self.clock())
            self.emit("ops_tightened", action=aid, item=item, ok=True, text=text)
        except audit.Refused:
            self.emit("ops_tightened", action=aid, item=item, ok=False, text="Nothing to change.")
        except Exception:
            log.exception("ops: tightening %s failed", aid)
            self.emit("ops_tightened", action=aid, item=item, ok=False, text="That didn't work.")
        await self.review()

    # ── backups ──

    def _lock(self) -> asyncio.Lock:
        if self._backup_lock is None:
            self._backup_lock = asyncio.Lock()
        return self._backup_lock

    async def make_backup(self, kind: str) -> dict[str, Any]:
        """One backup, then the old ones of its kind pruned (never a manual one)."""
        folder = self.backup_folder()
        with contextlib.suppress(OSError, RuntimeError):
            inside = folder.resolve()
            data = self.data.resolve()
            if inside == data or data in inside.parents:
                raise backup.BackupError("Choose a folder outside Jarvis's data folder.")
        knowledge = bool(self.hub.prefs.feature("ops_backup_knowledge"))
        async with self._lock():
            made = await asyncio.to_thread(
                backup.create, self.data, folder, kind=kind, knowledge=knowledge, clock=self.clock
            )
            if kind in backup.KEEP:
                await asyncio.to_thread(backup.prune, folder, kind)
        return made

    async def backups(self, _msg: dict[str, Any] | None = None) -> None:
        self.emit("ops_backups", **await self.backups_info())

    async def backup_now(self, _msg: dict[str, Any] | None = None) -> None:
        if "backup" in self._busy:
            return
        self._busy_now("backup", True)
        self.spawn(self._backup_now())

    async def _backup_now(self) -> None:
        try:
            made = await self.make_backup("manual")
            self.emit("ops_backup_done", ok=True, backup=made, text="")
        except backup.BackupError as exc:
            self.emit("ops_backup_done", ok=False, backup=None, text=str(exc))
        except OSError as exc:
            self.emit("ops_backup_done", ok=False, backup=None, text=_why(exc))
        except Exception:
            log.exception("ops: the backup failed")
            self.emit("ops_backup_done", ok=False, backup=None, text="That didn't work.")
        finally:
            self._busy_now("backup", False)
        await self.backups()

    @staticmethod
    def _zip(msg: dict[str, Any]) -> Path | None:
        raw = str(msg.get("path", ""))[:2000]
        if not raw or "\x00" in raw:
            return None
        path = Path(raw).expanduser()
        return path if path.is_absolute() and path.suffix.lower() == ".zip" else None

    async def verify(self, msg: dict[str, Any]) -> None:
        path = self._zip(msg)
        if path is None:
            return
        self.spawn(self._verify(path))

    async def _verify(self, path: Path) -> None:
        self._busy_now("verify", True)
        try:
            checked = await asyncio.to_thread(backup.verify, path)
        finally:
            self._busy_now("verify", False)
        self.emit(
            "ops_verified",
            path=str(path),
            ok=checked["ok"],
            files=checked["files"],
            problem=checked["problem"],
        )

    async def restore_preview(self, msg: dict[str, Any]) -> None:
        path = self._zip(msg)
        if path is None:
            return
        self.spawn(self._preview(path))

    async def _preview(self, path: Path) -> None:
        self._busy_now("preview", True)
        try:
            seen = await asyncio.to_thread(backup.preview, path, self.data)
        except Exception:
            log.exception("ops: the restore preview failed")
            seen = {"ok": False, "problem": "It couldn't be read."}
        finally:
            self._busy_now("preview", False)
        self.emit("ops_restore_preview", path=str(path), **seen)

    async def restore(self, msg: dict[str, Any]) -> None:
        path = self._zip(msg)
        if path is None or "restore" in self._busy:
            return
        self._busy_now("restore", True)
        self.spawn(self._restore(path))

    async def _restore(self, path: Path) -> None:
        """A safety backup of how things are now, then the chosen one staged for the next
        start. Nothing the app has open changes now: the window then offers the restart."""
        try:
            safety = await self.make_backup("safety")
            async with self._lock():
                staged = await asyncio.to_thread(
                    backup.stage, path, self.data, safety=safety["name"], clock=self.clock
                )
            self.emit("ops_restore_staged", ok=True, pending=staged, safety=safety, text="")
        except backup.BackupError as exc:
            self.emit("ops_restore_staged", ok=False, pending=None, safety=None, text=str(exc))
        except OSError as exc:
            self.emit("ops_restore_staged", ok=False, pending=None, safety=None, text=_why(exc))
        except Exception:
            log.exception("ops: the restore failed")
            text = "That didn't work."
            self.emit("ops_restore_staged", ok=False, pending=None, safety=None, text=text)
        finally:
            self._busy_now("restore", False)
        await self.backups()

    async def restore_cancel(self, _msg: dict[str, Any] | None = None) -> None:
        with contextlib.suppress(backup.BackupError, OSError):
            await asyncio.to_thread(backup.cancel_pending, self.data)
        await self.backups()

    async def daily_loop(self) -> None:
        """A daily backup, kept seven deep, while "Back up every day" is on."""
        await asyncio.sleep(DAILY_FIRST_DELAY)
        while True:
            try:
                await self.daily_if_due()
            except Exception:
                log.exception("ops: the daily backup check failed")
            await asyncio.sleep(DAILY_EVERY)

    async def daily_if_due(self) -> dict[str, Any] | None:
        if not self.hub.prefs.feature("ops_backup_daily"):
            return None
        listed = await asyncio.to_thread(backup.list_backups, [self.backup_folder()])
        newest = backup.newest(listed, "daily")
        if newest:
            with contextlib.suppress(ValueError):
                if self.clock() - datetime.fromisoformat(newest["created"]) < DAILY_GAP:
                    return None
        try:
            made = await self.make_backup("daily")
        except backup.NothingToBackUp:
            return None  # a fresh install: nothing of the owner's yet, nothing wrong
        except (backup.BackupError, OSError) as exc:
            why = str(exc) if isinstance(exc, backup.BackupError) else _why(exc)
            log.warning("daily backup failed: %s", why)
            if not self._backup_failed_told:
                self._backup_failed_told = True
                text = lang.tr(BACKUP_FAILED, self.hub.language, why=why)
                self.hub.notify(Alert("ops:backup", "backup", "Backups", text), speak=False)
            return None
        self._backup_failed_told = False
        log.info("daily backup made (%d files)", made["files"])
        return made

    # ── diagnostics ──

    async def make_diagnostics(self, msg: dict[str, Any]) -> None:
        if "diagnostics" in self._busy:
            return
        size = msg.get("megabytes")
        self._busy_now("diagnostics", True)
        self.spawn(self._diagnostics(size if size in diagnostics.SIZES_MB else 2))

    async def _diagnostics(self, megabytes: int) -> None:
        try:
            checkup = await self.doctor(source="diagnostics")
            await self.review()
            cli = next(
                (c.get("meta", "") for c in checkup.get("checks", []) if c["id"] == "claude"), ""
            )
            info = diagnostics.versions(
                {
                    "claude": cli,
                    "language": self.hub.prefs.language,
                    "look": self.hub.prefs.look,
                    "model": self.hub.prefs.model,
                }
            )
            path = await asyncio.to_thread(
                diagnostics.build,
                self.diagnostics_folder(),
                logs=self.logs,
                home=self.home,
                info=info,
                checkup=checkup,
                review=self.last_review,
                megabytes=megabytes,
                clock=self.clock,
            )
            self.emit("ops_diagnostics", ok=True, path=str(path), name=path.name, text="")
        except OSError as exc:
            self.emit("ops_diagnostics", ok=False, path="", name="", text=_why(exc))
        except Exception:
            log.exception("ops: the diagnostics file failed")
            self.emit("ops_diagnostics", ok=False, path="", name="", text="That didn't work.")
        finally:
            self._busy_now("diagnostics", False)

    async def reveal(self, msg: dict[str, Any]) -> None:
        """Show a backup or a diagnostics file in Finder: only those folders' own files."""
        raw = str(msg.get("path", ""))[:2000]
        if not raw or "\x00" in raw:
            return
        path = Path(raw).expanduser()
        places = [*self.backup_folders(), self.diagnostics_folder()]
        if path.parent not in places or not path.is_file() or path.is_symlink():
            return
        with contextlib.suppress(OSError, TimeoutError):
            if osplat.IS_WIN:
                osplat.open_target(str(path), reveal=True)
            else:
                await self.run("open", "-R", str(path), timeout=10)

    # ── by voice ──

    def tools(self) -> list[Any]:
        from claude_agent_sdk import tool

        @tool(
            "run_checkup",
            "Run Jarvis's own checkup: macOS permissions, the Claude sign-in, the speech "
            "model, disk space, errors in the log, the indexes, accounts and backups. Returns "
            "a short summary. Use it when the user asks for a checkup, a health check or "
            "whether everything is working. It only looks: it changes nothing.",
            {"type": "object", "properties": {}},
        )
        async def run_checkup(_args):
            result = await self.doctor(source="voice")
            return {"content": [{"type": "text", "text": doctor.spoken(result)}]}

        return [run_checkup]

    def build_server(self):
        from claude_agent_sdk import create_sdk_mcp_server

        return create_sdk_mcp_server(name="ops", version="1.0.0", tools=self.tools())


def _why(exc: OSError) -> str:
    return f"It couldn't be written ({exc.strerror or type(exc).__name__})."
