"""Eden Code's Claude Code engine: which one its sessions run, a copy kept of each built-in
one it has run, and pinning a session engine to an earlier version (the engine radar's
"Go back" and "Pin this version", web/features/code-radar.js; Eden Code settings).

Where the engine comes from. Eden Code's sessions run the Claude Code CLI that the Agent SDK
(claude_agent_sdk) carries inside its package, _bundled/claude ("Using bundled Claude Code
CLI" in the log), whose version is the SDK's _cli_version. That file is replaced whole when
the SDK is updated (uv sync in the repo, a new Eden Code download), and it never updates
itself (packaged.ENGINE_ONLY: DISABLE_AUTOUPDATER). So a built-in engine can only be gone
back to if a copy of it was kept before the update: Eden can't download an old one.

What this keeps, in claude_engines/ beside prefs.json:
- <version>/claude (claude.exe on Windows) and meta.json: a copy of the built-in engine,
  made the first time Eden sees that version (a loop, a minute after start and every few
  hours) while "Keep a copy of each engine" (code_engine_keep, on) is on. On APFS the copy
  is a clone (cp -c): it takes no room until the files differ, so keeping one is free. On
  another disk it's a full copy (about 240 MB), made only with ample room left. The newest
  KEEP_VERSIONS are kept, and the pinned one always.
- A pin to an engine that isn't one of these (one of Claude Code's own installs) keeps a
  copy of it there too, when it's a real program (Claude Code's own installer prunes its
  old versions, ~/.local/share/claude/versions, which would take a pin with them). An npm
  install's claude is a script beside its packages: it's pinned where it is.

Pinning (code_engine_pin {path, version}, empty: none): every Eden Code session that runs
Claude Code (not another agent over ACP, not Eden Secretary's own conversation) is started
with ClaudeAgentOptions.cli_path set to it (TaskManager.option_hooks), and with
DISABLE_AUTOUPDATER so a pinned copy never replaces itself. The open sessions reconnect
between steps, same conversation. An engine can be pinned only if it says a version at
least the SDK's own minimum (MINIMUM_CLAUDE_CODE_VERSION), and only a file named claude
(claude.exe), one of Claude Code's own versions, or one of the copies kept here: never any
program a message names. A pinned engine that's gone (deleted by hand) is unpinned, with a
heads-up, and the built-in one runs again.

What it can't do (said in the radar pane): bring back a built-in engine Eden never kept;
promise an older engine understands everything a newer SDK asks of it (a session that
won't start on it: unpin); pin Eden Secretary's own conversation or another agent.

Window commands: cw_engines {fresh?} -> cw_engines {current, pin, candidates, keep,
minimum, sdk, limits}; cw_engine_pin {path} and cw_engine_unpin (each says how it went in a
caption, then cw_engines again).

Cost policy (Claude): nothing here calls a model. It runs engines' --version only.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from .. import lang
from ..codeplatform import other_agent
from ..prefs import register_feature_pref
from ..proactive import Alert
from ._radar_stats import version_key
from ._router_log import iso

log = logging.getLogger("jarvis")

PREF_PIN = "code_engine_pin"
PREF_KEEP = "code_engine_keep"
ENGINES_DIR = "claude_engines"
KEEP_VERSIONS = 3
VERSION_TIMEOUT = 15.0
KEEP_EVERY = 6 * 3600.0
KEEP_FIRST = 60.0
COPY_ROOM = 2 * 1024**3  # a full copy (no clone) leaves at least this much free
MAX_CANDIDATES = 16
FALLBACK_MINIMUM = "2.0.0"

_VERSION = re.compile(r"(\d+\.\d+\.\d+)")
_NAME = re.compile(r"^claude(?:\.exe)?$", re.IGNORECASE)
_MAGIC = (
    b"\xcf\xfa\xed\xfe",  # Mach-O 64
    b"\xce\xfa\xed\xfe",  # Mach-O 32
    b"\xca\xfe\xba\xbe",  # Mach-O universal
    b"\xbe\xba\xfe\xca",
    b"\x7fELF",
    b"MZ",  # Windows
)

ZH = {
    "Eden Code's sessions now run Claude Code {version}. Open sessions reconnect between steps.": "Eden Code 的会话现在运行 Claude Code {version}。打开的会话会在步骤之间重新连接。",
    "Eden Code's sessions run the built-in Claude Code again. Open sessions reconnect between steps.": "Eden Code 的会话重新运行内置的 Claude Code。打开的会话会在步骤之间重新连接。",
    "That isn't a Claude Code engine Eden Code can run: choose a file named claude, one of Claude Code's own versions, or a kept copy.": "这不是 Eden Code 能运行的 Claude Code 引擎：请选一个名为 claude 的文件、Claude Code 自己的某个版本，或保留的副本。",
    "That engine didn't say its version, so it isn't pinned.": "这个引擎没有报出版本，所以没有固定。",
    "Claude Code {version} is older than this Eden Code can run ({minimum} at least).": "Claude Code {version} 比这个 Eden Code 能运行的版本旧（至少需要 {minimum}）。",
    "Eden Code's Claude Code engine changed to {version}: this session reconnects between steps.": "Eden Code 的 Claude Code 引擎换成了 {version}：这个会话会在步骤之间重新连接。",
    "The Claude Code engine you pinned ({version}) isn't there any more, so Eden Code runs its built-in one again.": "你固定的 Claude Code 引擎（{version}）不在了，所以 Eden Code 重新运行内置的引擎。",
    "Claude Code engine": "Claude Code 引擎",
    "Eden Code can go back only to an engine it kept a copy of, or one installed on this Mac: it can't download an old one.": "Eden Code 只能退回到它保留了副本的引擎，或这台 Mac 上装着的引擎：它不能下载旧版本。",
    "A copy is kept of each built-in engine Eden Code runs from now on, so the next update can be undone.": "从现在起，Eden Code 运行的每个内置引擎都会保留一份副本，所以下一次更新可以撤回。",
    "An older engine may not understand everything a newer Eden Code asks of it: if a session won't start, unpin.": "旧的引擎可能不理解新版 Eden Code 的所有请求：如果会话启动不了，请取消固定。",
    "A pin covers Eden Code's sessions on Claude Code, not other agents or Eden Secretary's own conversation.": "固定只作用于 Eden Code 在 Claude Code 上的会话，不包括其他代理，也不包括 Eden Secretary 自己的对话。",
}
lang.add_texts(ZH)

LIMITS = (
    "Eden Code can go back only to an engine it kept a copy of, or one installed on this Mac: it can't download an old one.",
    "A copy is kept of each built-in engine Eden Code runs from now on, so the next update can be undone.",
    "An older engine may not understand everything a newer Eden Code asks of it: if a session won't start, unpin.",
    "A pin covers Eden Code's sessions on Claude Code, not other agents or Eden Secretary's own conversation.",
)


def clean_pin(value: Any) -> dict[str, str] | None:
    """{path, version} or {} (no pin)."""
    if value == {}:
        return {}
    if not isinstance(value, dict):
        return None
    path, version = value.get("path"), value.get("version")
    if not isinstance(path, str) or not path or len(path) > 1024 or "\x00" in path:
        return None
    if not isinstance(version, str) or not _VERSION.fullmatch(version):
        return None
    return {"path": path, "version": version}


register_feature_pref(PREF_PIN, {}, clean_pin)
register_feature_pref(PREF_KEEP, True)


# ── the SDK's engine ──


def sdk_version() -> str:
    with contextlib.suppress(Exception):
        import claude_agent_sdk

        return str(getattr(claude_agent_sdk, "__version__", "") or "")
    return ""


def bundled_cli() -> Path | None:
    """The engine inside the SDK's package (what sessions run with no pin)."""
    with contextlib.suppress(Exception):
        import claude_agent_sdk

        folder = Path(claude_agent_sdk.__file__).parent / "_bundled"
        for name in ("claude", "claude.exe"):
            if (folder / name).is_file():
                return folder / name
    return None


def bundled_version() -> str:
    """The built-in engine's version, as the SDK says it (no need to run it)."""
    with contextlib.suppress(Exception):
        from claude_agent_sdk import _cli_version

        found = _VERSION.search(str(getattr(_cli_version, "__cli_version__", "") or ""))
        if found:
            return found.group(1)
    return ""


def sdk_minimum() -> str:
    """The oldest engine this SDK runs (its MINIMUM_CLAUDE_CODE_VERSION)."""
    with contextlib.suppress(Exception):
        from claude_agent_sdk._internal.transport import subprocess_cli

        found = _VERSION.search(str(getattr(subprocess_cli, "MINIMUM_CLAUDE_CODE_VERSION", "")))
        if found:
            return found.group(1)
    return FALLBACK_MINIMUM


def version_of_output(text: str) -> str:
    """ "2.1.294 (Claude Code)" -> "2.1.294"; "" when it says no version."""
    first = str(text or "").strip().splitlines()[:1]
    found = _VERSION.search(first[0]) if first else None
    return found.group(1) if found else ""


def is_program(path: Path) -> bool:
    """A compiled program (Mach-O, ELF, a Windows .exe), not a script: a copy of it runs
    on its own."""
    try:
        with path.open("rb") as handle:
            head = handle.read(4)
    except OSError:
        return False
    return any(head.startswith(m) for m in _MAGIC)


def _copy(src: Path, dst: Path) -> str:
    """src to dst: a clone where the disk can (APFS), else a whole copy with room to spare.
    "clone" | "copy"; raises OSError when neither can be done."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".{dst.name}.part")
    with contextlib.suppress(FileNotFoundError):
        tmp.unlink()
    how = ""
    if sys.platform == "darwin":
        done = subprocess.run(  # noqa: S603 - fixed program, our own paths
            ["/bin/cp", "-c", str(src), str(tmp)], capture_output=True, timeout=120, check=False
        )
        if done.returncode == 0:
            how = "clone"
    if not how:
        free = shutil.disk_usage(dst.parent).free
        if free - src.stat().st_size < COPY_ROOM:
            raise OSError("not enough free space for a copy of the engine")
        shutil.copy2(src, tmp)
        how = "copy"
    os.chmod(tmp, 0o755)
    os.replace(tmp, dst)
    return how


Runner = Callable[..., Awaitable[tuple[int, str, str]]]


async def run_version(path: str, timeout: float = VERSION_TIMEOUT) -> tuple[int, str, str]:
    """An engine's --version (its auto-updater kept off)."""
    env = {**os.environ, "DISABLE_AUTOUPDATER": "1"}
    proc = await asyncio.create_subprocess_exec(
        path,
        "--version",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
        env=env,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        raise
    return proc.returncode or 0, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


class Engines:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.run: Runner = run_version  # (tests replace it)
        self.home = Path.home()
        self._versions: dict[tuple[str, int, int], str] = {}  # (path, mtime, size) -> version
        self._gone_said = False

    # ── where things are ──

    def folder(self) -> Path:
        return self.hub.feature_path(ENGINES_DIR)

    def tr(self, text: str, **kw: Any) -> str:
        return (
            lang.tr(text, self.hub.language, **kw)
            if kw
            else lang.translate(text, self.hub.language)
        )

    def pin(self) -> dict[str, str]:
        found = clean_pin(self.hub.prefs.feature(PREF_PIN))
        return found or {}

    def keeping(self) -> bool:
        return self.hub.prefs.feature(PREF_KEEP) is not False

    def pinned_path(self) -> str:
        """The pinned engine's path, "" with no pin. A pin whose file is gone is let go
        (with a heads-up, once), and the built-in engine runs."""
        pin = self.pin()
        path = pin.get("path", "")
        if not path:
            return ""
        if Path(path).is_file() and os.access(path, os.X_OK):
            return path
        self._lost(pin)
        return ""

    def _lost(self, pin: dict[str, str]) -> None:
        with contextlib.suppress(Exception):
            self.hub.set_feature_prefs({PREF_PIN: {}})
        if self._gone_said:
            return
        self._gone_said = True
        text = self.tr(
            "The Claude Code engine you pinned ({version}) isn't there any more, so Eden Code runs its built-in one again.",
            version=pin.get("version", "?"),
        )
        with contextlib.suppress(Exception):
            self.hub.notify(
                Alert(
                    f"code-engine-gone:{pin.get('version')}",
                    "radar",
                    self.tr("Claude Code engine"),
                    text,
                ),
                speak_if_busy=False,
            )

    def current(self) -> dict[str, Any]:
        """The engine new connections run: {version, path, pinned, bundled}."""
        pinned = self.pinned_path()
        if pinned:
            return {
                "version": self.pin().get("version", ""),
                "path": pinned,
                "pinned": True,
                "bundled": False,
            }
        cli = bundled_cli()
        return {
            "version": bundled_version(),
            "path": str(cli or ""),
            "pinned": False,
            "bundled": cli is not None,
        }

    # ── the kept copies ──

    def kept(self) -> list[dict[str, Any]]:
        """The copies kept here, newest version first."""
        out = []
        folder = self.folder()
        if not folder.is_dir():
            return out
        for sub in folder.iterdir():
            if not sub.is_dir() or not _VERSION.fullmatch(sub.name):
                continue
            exe = next((sub / n for n in ("claude", "claude.exe") if (sub / n).is_file()), None)
            if exe is None:
                continue
            meta: dict[str, Any] = {}
            with contextlib.suppress(OSError, ValueError):
                loaded = json.loads((sub / "meta.json").read_text("utf-8"))
                meta = loaded if isinstance(loaded, dict) else {}
            out.append(
                {
                    "version": sub.name,
                    "path": str(exe),
                    "kept_at": str(meta.get("kept_at") or ""),
                    "how": str(meta.get("how") or ""),
                    "from": str(meta.get("from") or ""),
                }
            )
        out.sort(key=lambda r: version_key(r["version"]), reverse=True)
        return out

    def keep(self, src: Path, version: str, origin: str) -> Path:
        """(In a thread.) A copy of src kept as claude_engines/<version>/; the copy's path
        (an existing copy of that version is kept as it is)."""
        sub = self.folder() / version
        name = "claude.exe" if src.name.lower().endswith(".exe") else "claude"
        dst = sub / name
        if dst.is_file():
            return dst
        how = _copy(src, dst)
        meta = {
            "version": version,
            "kept_at": iso(),
            "how": how,
            "from": origin,
            "sdk": sdk_version(),
        }
        (sub / "meta.json").write_text(json.dumps(meta), "utf-8")
        log.info("Eden Code kept a copy of Claude Code %s (%s)", version, how)
        self.prune()
        return dst

    def keep_current(self) -> str:
        """(In a thread.) The built-in engine kept, if it's new here: its version, or ""."""
        if not self.keeping():
            return ""
        cli, version = bundled_cli(), bundled_version()
        if cli is None or not version:
            return ""
        try:
            self.keep(cli, version, "built-in")
        except (OSError, subprocess.SubprocessError) as exc:
            log.warning("Eden Code couldn't keep a copy of Claude Code %s: %s", version, exc)
            return ""
        return version

    def prune(self) -> None:
        """The newest KEEP_VERSIONS copies stay, and the pinned one."""
        pinned = self.pin().get("path", "")
        for row in self.kept()[KEEP_VERSIONS:]:
            if pinned and Path(pinned).parent == Path(row["path"]).parent:
                continue
            with contextlib.suppress(OSError):
                shutil.rmtree(Path(row["path"]).parent)

    async def keeping_loop(self) -> None:
        await asyncio.sleep(KEEP_FIRST)
        while True:
            with contextlib.suppress(Exception):
                await asyncio.to_thread(self.keep_current)
            await asyncio.sleep(KEEP_EVERY)

    # ── what can be pinned ──

    def allowed(self, path: Path) -> bool:
        """An engine a pin may name: a file called claude (claude.exe), one of Claude
        Code's own versions (…/claude/versions/<version>), or a copy kept here."""
        if _NAME.match(path.name):
            return True
        parent = path.parent
        if (
            parent.name == "versions"
            and parent.parent.name == "claude"
            and _VERSION.fullmatch(path.name)
        ):
            return True
        with contextlib.suppress(OSError, ValueError):
            path.resolve().relative_to(self.folder().resolve())
            return True
        return False

    async def version_at(self, path: str) -> str:
        """An engine's version, from its --version (kept while the file stays the same)."""
        try:
            st = os.stat(path)
        except OSError:
            return ""
        key = (path, st.st_mtime_ns, st.st_size)
        if key in self._versions:
            return self._versions[key]
        version = ""
        with contextlib.suppress(OSError, TimeoutError, ValueError):
            code, out, _err = await self.run(path, timeout=VERSION_TIMEOUT)
            if code == 0:
                version = version_of_output(out)
        self._versions[key] = version
        return version

    def _installed(self) -> list[tuple[str, str, str]]:
        """(path, version or "", source) for Claude Code installs on this Mac."""
        found: list[tuple[str, str, str]] = []
        versions = self.home / ".local" / "share" / "claude" / "versions"
        with contextlib.suppress(OSError):
            for item in sorted(versions.iterdir(), key=lambda p: version_key(p.name), reverse=True):
                if item.is_file() and _VERSION.fullmatch(item.name):
                    found.append((str(item), item.name, "installed"))
        on_path = shutil.which("claude")
        places = [on_path] if on_path else []
        places += [
            str(self.home / ".local/bin/claude"),
            str(self.home / ".claude/local/claude"),
            str(self.home / ".npm-global/bin/claude"),
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
        ]
        for place in places:
            if place and Path(place).is_file():
                found.append((place, "", "installed"))
        return found

    async def candidates(self) -> list[dict[str, Any]]:
        """Every engine that could run Eden Code's sessions, one row per real file: the
        built-in one, the kept copies, and Claude Code's own installs."""
        current = self.current()
        minimum = version_key(sdk_minimum())
        rows: list[dict[str, Any]] = []
        seen: set[str] = set()

        def real(path: str) -> str:
            try:
                return os.path.realpath(path)
            except OSError:
                return path

        cli = bundled_cli()
        listed: list[tuple[str, str, str]] = []
        if cli is not None:
            listed.append((str(cli), bundled_version(), "built-in"))
        listed += [(r["path"], r["version"], "kept") for r in self.kept()]
        listed += self._installed()
        for path, version, source in listed:
            key = real(path)
            if key in seen or len(rows) >= MAX_CANDIDATES:
                continue
            seen.add(key)
            version = version or await self.version_at(path)
            rows.append(
                {
                    "path": path,
                    "version": version,
                    "source": source,
                    "current": real(current["path"]) == key if current["path"] else False,
                    "usable": bool(version) and version_key(version) >= minimum,
                }
            )
        return rows

    # ── pinning ──

    async def pin_to(self, given: str) -> tuple[bool, str]:
        """Pin Eden Code's sessions to the engine at given: (pinned, what to say)."""
        raw = str(given or "").strip()
        path = Path(raw).expanduser() if raw else None
        if path is None or not path.is_absolute() or not self.allowed(path):
            return False, self.tr(
                "That isn't a Claude Code engine Eden Code can run: choose a file named claude, one of Claude Code's own versions, or a kept copy."
            )
        if not path.is_file() or not os.access(path, os.X_OK):
            return False, self.tr(
                "That isn't a Claude Code engine Eden Code can run: choose a file named claude, one of Claude Code's own versions, or a kept copy."
            )
        version = await self.version_at(str(path))
        if not version:
            return False, self.tr("That engine didn't say its version, so it isn't pinned.")
        minimum = sdk_minimum()
        if version_key(version) < version_key(minimum):
            return False, self.tr(
                "Claude Code {version} is older than this Eden Code can run ({minimum} at least).",
                version=version,
                minimum=minimum,
            )
        target = path
        inside = False
        with contextlib.suppress(OSError, ValueError):
            path.resolve().relative_to(self.folder().resolve())
            inside = True
        real = path.resolve()
        if not inside and is_program(real):
            try:
                target = await asyncio.to_thread(self.keep, real, version, "pinned")
            except (OSError, subprocess.SubprocessError) as exc:
                log.warning("Eden Code pinned Claude Code %s where it is: %s", version, exc)
                target = path
        self.hub.set_feature_prefs({PREF_PIN: {"path": str(target), "version": version}})
        self._gone_said = False
        self._reconnect(version)
        return True, self.tr(
            "Eden Code's sessions now run Claude Code {version}. Open sessions reconnect between steps.",
            version=version,
        )

    def unpin(self) -> str:
        self.hub.set_feature_prefs({PREF_PIN: {}})
        self._reconnect(bundled_version() or "?")
        return self.tr(
            "Eden Code's sessions run the built-in Claude Code again. Open sessions reconnect between steps."
        )

    def _reconnect(self, version: str) -> None:
        health = getattr(self.hub, "code_health", None)
        if health is not None:  # (its engine check, kept a minute, is of the old engine)
            health._engine = None
        note = self.tr(
            "Eden Code's Claude Code engine changed to {version}: this session reconnects between steps.",
            version=version,
        )
        for task in list(self.hub.tasks.tasks.values()):
            if task.kind == "code" and not other_agent(task) and task.client is not None:
                with contextlib.suppress(Exception):
                    self.hub.tasks.reopen(task.id, note)

    # ── the window ──

    async def state(self) -> dict[str, Any]:
        pin = self.pin()
        return {
            "current": self.current(),
            "pin": pin or None,
            "candidates": await self.candidates(),
            "keep": self.keeping(),
            "minimum": sdk_minimum(),
            "sdk": sdk_version(),
            "limits": [self.tr(x) for x in LIMITS],
        }

    async def cmd_engines(self, msg: dict[str, Any]) -> None:
        if msg.get("fresh") is True:
            self._versions.clear()
        self.hub.emit("cw_engines", **await self.state())

    async def cmd_pin(self, msg: dict[str, Any]) -> None:
        _ok, said = await self.pin_to(str(msg.get("path") or ""))
        self.hub.emit("caption", text=said)
        self.hub.emit("cw_engines", **await self.state())

    async def cmd_unpin(self, _msg: dict[str, Any]) -> None:
        self.hub.emit("caption", text=self.unpin())
        self.hub.emit("cw_engines", **await self.state())


class EngineOptions:
    """TaskManager.option_hooks: a pinned engine for Eden Code's Claude Code sessions."""

    def __init__(self, engines: Engines) -> None:
        self.engines = engines

    def apply(self, task: Any, options: Any) -> None:
        if task.kind != "code" or other_agent(task):
            return
        path = self.engines.pinned_path()
        if not path:
            return
        options.cli_path = path
        options.env = {**(options.env or {}), "DISABLE_AUTOUPDATER": "1"}

    def key(self, task: Any) -> Any:
        if task.kind != "code" or other_agent(task):
            return ""
        return self.engines.pin().get("path", "")


def install(hub: Any) -> None:
    engines = Engines(hub)
    hub.code_engines = engines
    hub.tasks.option_hooks.append(EngineOptions(engines))
    hub.register_command("cw_engines", lambda msg: hub._spawn(engines.cmd_engines(msg)))
    hub.register_command("cw_engine_pin", lambda msg: hub._spawn(engines.cmd_pin(msg)))
    hub.register_command("cw_engine_unpin", lambda msg: hub._spawn(engines.cmd_unpin(msg)))
    hub.register_loop("code_engines_keep", engines.keeping_loop)
