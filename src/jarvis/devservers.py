"""Dev servers for Jarvis Code projects, as in Claude Code's desktop app.

- Configs: a project's .claude/launch.json (Claude Code desktop's own format) and
  .jarvis/launch.json: {"version": "0.0.1", "configurations": [{"name", "runtimeExecutable",
  "runtimeArgs", "port", "url"?, "cwd"?, "env"?}]}. Read defensively: a damaged file or a
  bad entry is said, never fatal, and a url that isn't on this Mac is left out.
- Suggestions: likely configs read from the project (package.json scripts, Django, FastAPI,
  Flask, Rails, a static site), shown for the owner to save. Nothing suggested ever runs
  until it's saved and started.
- Servers: each in its own process group under runproc's supervisor, so a stop stops what
  it started and nothing outlives the app. They keep running when their pane closes; they
  stop when stopped, when the session that started them ends, or when the app quits.
- The address: the config's url or port, else the one the server prints, else a port its
  processes listen on. Output is kept in a bounded ring for the logs view and the checks.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import logging
import os
import re
import shlex
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from . import runproc

log = logging.getLogger("jarvis")

LAUNCH_FILES = (".claude/launch.json", ".jarvis/launch.json")
SAVE_TO = ".claude/launch.json"  # where a saved suggestion goes (Claude Code desktop reads it too)
MAX_CONFIGS = 30  # per file
MAX_FILE = 256_000  # bytes of launch.json read
LOG_LINES = 2000  # lines of a server's output kept
LOG_EVERY = 0.2  # seconds between batches of new output to the windows
READY_WAIT = 120.0  # seconds a starting server is watched for its address
MAX_SERVERS = 12  # servers running at once, across projects
NAME = re.compile(r"^[^\x00-\x1f\x7f]{1,64}$")
ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,99}$")
# An address a server prints: its own, on this Mac.
_URL_OUT = re.compile(
    r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.localhost)(?::\d{2,5})?(?:/[^\s'\"<>]*)?",
    re.I,
)
_PORT_OUT = re.compile(r"(?i)\b(?:port|listening on|listening at)\s*:?\s*(\d{2,5})\b")
# Lines of a server's output that say something went wrong (and a few that only look so).
ERROR_LINE = re.compile(
    r"(?i)(\berror\b|\berr!|\bexception\b|traceback \(most recent|failed to compile|"
    r"\buncaught\b|\bunhandled\b|\bpanic:|\bfatal\b|✘|\[vite\] internal server error|"
    r"module not found|cannot find module|syntaxerror|typeerror|referenceerror)"
)
NOT_ERROR = re.compile(r"(?i)(\b0 errors?\b|\bno errors?\b|errors?: 0\b|without errors|error_log)")


def is_local_url(url: str) -> bool:
    """An http(s) address on this Mac: localhost, a loopback address, or *.localhost."""
    try:
        parts = urlsplit(url.strip())
        host = (parts.hostname or "").lower()
        _ = parts.port  # a bad port raises
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not host:
        return False
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class LaunchConfig:
    name: str
    command: str  # runtimeExecutable
    args: tuple[str, ...] = ()  # runtimeArgs
    port: int | None = None
    url: str = ""
    cwd: str = ""  # relative to the project
    env: tuple[tuple[str, str], ...] = ()
    source: str = ""  # the file it's in ("" for a suggestion)
    why: str = ""  # a suggestion: what it was read from

    @property
    def argv(self) -> list[str]:
        return [self.command, *self.args]

    @property
    def command_line(self) -> str:
        return shlex.join(self.argv)

    def address(self, port: int | None = None) -> str:
        if self.url:
            return self.url
        port = port or self.port
        return f"http://localhost:{port}/" if port else ""

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "name": self.name,
            "runtimeExecutable": self.command,
            "runtimeArgs": list(self.args),
        }
        if self.port:
            out["port"] = self.port
        if self.url:
            out["url"] = self.url
        if self.cwd:
            out["cwd"] = self.cwd
        if self.env:
            out["env"] = dict(self.env)
        return out

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "command": self.command_line,
            "port": self.port,
            "url": self.address(),
            "cwd": self.cwd,
            "source": self.source,
            "why": self.why,
        }


def _clean_config(raw: Any, project: Path, source: str) -> tuple[LaunchConfig | None, str]:
    """One entry of a launch.json, checked: (the config, or None and why not)."""
    if not isinstance(raw, dict):
        return None, "an entry that isn't an object"
    name = raw.get("name")
    if not isinstance(name, str) or not NAME.match(name.strip()):
        return None, "an entry without a usable name"
    name = name.strip()
    command = raw.get("runtimeExecutable")
    if not isinstance(command, str) or not command.strip() or len(command) > 500:
        return None, f"{name}: no runtimeExecutable"
    if any(c in command for c in "\0\n\r"):
        return None, f"{name}: runtimeExecutable has a line break in it"
    args_raw = raw.get("runtimeArgs", [])
    if args_raw is None:
        args_raw = []
    if not isinstance(args_raw, list) or len(args_raw) > 60:
        return None, f"{name}: runtimeArgs must be a list of words"
    args = []
    for a in args_raw:
        if isinstance(a, bool) or not isinstance(a, (str, int, float)):
            return None, f"{name}: runtimeArgs must be a list of words"
        text = str(a)
        if "\0" in text or len(text) > 2000:
            return None, f"{name}: an argument is too long"
        args.append(text)
    note = ""
    port = raw.get("port")
    if isinstance(port, str) and port.strip().isdigit():
        port = int(port.strip())
    if isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536:
        if port is not None:
            note = f"{name}: port ignored (not a port number)"
        port = None
    url = raw.get("url") or ""
    if not isinstance(url, str) or (url and not is_local_url(url)):
        note = f"{name}: url ignored (only addresses on this Mac are opened)"
        url = ""
    cwd = raw.get("cwd") or ""
    if not isinstance(cwd, str):
        return None, f"{name}: cwd must be a folder in the project"
    if cwd:
        where = (project / cwd).resolve()
        root = project.resolve()
        if not (where == root or root in where.parents) or not where.is_dir():
            return None, f"{name}: cwd must be a folder in the project"
        cwd = str(where.relative_to(root)) if where != root else ""
    env_raw = raw.get("env") or {}
    if not isinstance(env_raw, dict):
        return None, f"{name}: env must be an object"
    env = []
    for key, value in list(env_raw.items())[:50]:
        if not isinstance(key, str) or not ENV_KEY.match(key):
            continue
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            continue
        text = str(value)
        if "\0" not in text and len(text) <= 4000:
            env.append((key, text))
    config = LaunchConfig(
        name=name,
        command=command.strip(),
        args=tuple(args),
        port=port,
        url=url.strip(),
        cwd=cwd,
        env=tuple(env),
        source=source,
    )
    return config, note


def read_launch(project: Path) -> tuple[list[LaunchConfig], list[str]]:
    """The project's configs (.claude/launch.json first, then .jarvis/launch.json; a name
    is the first file's) and what couldn't be used of them, in plain words."""
    configs: list[LaunchConfig] = []
    problems: list[str] = []
    seen: set[str] = set()
    for rel in LAUNCH_FILES:
        path = project / rel
        try:
            if not path.is_file():
                continue
            raw = path.read_bytes()[: MAX_FILE + 1]
        except OSError as exc:
            problems.append(f"{rel} can't be read ({exc.strerror or exc}).")
            continue
        if len(raw) > MAX_FILE:
            problems.append(f"{rel} is too big to be a launch file.")
            continue
        try:
            data = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError as exc:
            problems.append(f"{rel} isn't valid JSON (line {getattr(exc, 'lineno', '?')}).")
            continue
        items = data.get("configurations") if isinstance(data, dict) else None
        if not isinstance(items, list):
            problems.append(f"{rel} has no configurations list.")
            continue
        for item in items[:MAX_CONFIGS]:
            config, note = _clean_config(item, project, rel)
            if note:
                problems.append(f"{rel}: {note}.")
            if config is None or config.name in seen:
                continue
            seen.add(config.name)
            configs.append(config)
    return configs, problems


def save_config(project: Path, config: LaunchConfig) -> Path:
    """Add a config (a suggestion the owner saved) to the project's .claude/launch.json.
    A file that's there but can't be read is never written over. Raises ValueError."""
    path = project / SAVE_TO
    data: dict[str, Any] = {"version": "0.0.1", "configurations": []}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ValueError(f"{SAVE_TO} can't be read, so it wasn't changed.") from exc
        if not isinstance(data, dict) or not isinstance(data.get("configurations"), list):
            raise ValueError(f"{SAVE_TO} isn't a launch file, so it wasn't changed.")
    names = {c.get("name") for c in data["configurations"] if isinstance(c, dict)}
    if config.name in names:
        raise ValueError(f"There's already a config called {config.name}.")
    if len(data["configurations"]) >= MAX_CONFIGS:
        raise ValueError(f"{SAVE_TO} already has {MAX_CONFIGS} configs.")
    data.setdefault("version", "0.0.1")
    data["configurations"].append(config.to_json())
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return path


# ── suggestions ──

_FRAMEWORK_PORTS = (
    ("next", 3000), ("nuxt", 3000), ("astro", 4321), ("vite", 5173), ("svelte-kit", 5173),
    ("react-scripts", 3000), ("ng serve", 4200), ("gatsby", 8000), ("remix", 3000),
    ("webpack serve", 8080), ("webpack-dev-server", 8080), ("parcel", 1234), ("expo", 8081),
    ("eleventy", 8080), ("docusaurus", 3000), ("vue-cli-service serve", 8080),
)  # fmt: skip
_SCRIPT_PORT = re.compile(r"(?:--port[= ]|-p |PORT=)(\d{2,5})\b")
_SUBDIRS = ("web", "frontend", "client", "app", "site", "ui", "www", "docs", "server", "api")


def _package_manager(folder: Path, project: Path) -> str:
    for where in (folder, project):
        if (where / "pnpm-lock.yaml").exists():
            return "pnpm"
        if (where / "yarn.lock").exists():
            return "yarn"
        if (where / "bun.lockb").exists() or (where / "bun.lock").exists():
            return "bun"
    return "npm"


def _read_json(path: Path) -> Any:
    try:
        if path.stat().st_size > MAX_FILE:
            return None
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return None


def _read_text(path: Path, limit: int = 200_000) -> str:
    try:
        with path.open("rb") as f:
            return f.read(limit).decode("utf-8", errors="replace")
    except OSError:
        return ""


def _node_suggestion(folder: Path, project: Path) -> LaunchConfig | None:
    package = _read_json(folder / "package.json")
    scripts = package.get("scripts") if isinstance(package, dict) else None
    if not isinstance(scripts, dict):
        return None
    script = next(
        (s for s in ("dev", "start", "serve", "develop") if isinstance(scripts.get(s), str)), None
    )
    if script is None:
        return None
    text = scripts[script]
    port = None
    if match := _SCRIPT_PORT.search(text):
        port = int(match.group(1))
    else:
        port = next((p for word, p in _FRAMEWORK_PORTS if word in text), None)
    manager = _package_manager(folder, project)
    args = ("run", script) if manager in ("npm", "bun") else (script,)
    rel = "" if folder == project else str(folder.relative_to(project))
    return LaunchConfig(
        name=f"{rel} {script}".strip() if rel else script,
        command=manager,
        args=args,
        port=port,
        cwd=rel,
        why=f"{rel + '/' if rel else ''}package.json: {script} runs {text[:120]}",
    )


def _python_runner(project: Path) -> tuple[str, tuple[str, ...]]:
    """How to run the project's Python: uv's, the project's venv, or python3."""
    if (project / "uv.lock").exists():
        return "uv", ("run",)
    for venv in (".venv", "venv"):
        if (project / venv / "bin" / "python").exists():
            return f"{venv}/bin/python", ()
    return "python3", ()


def _python_suggestions(project: Path) -> list[LaunchConfig]:
    out: list[LaunchConfig] = []
    runner, pre = _python_runner(project)
    python = (*pre, "python") if runner == "uv" else ()
    command = runner
    if (project / "manage.py").exists() and "django" in _read_text(project / "manage.py").lower():
        args = (*python, "manage.py", "runserver", "127.0.0.1:8000")
        out.append(LaunchConfig("django", command, args, 8000, why="manage.py: a Django project"))
    deps = " ".join(
        _read_text(project / name).lower()
        for name in ("pyproject.toml", "requirements.txt", "requirements-dev.txt")
    )
    for filename in ("main.py", "app.py", "server.py", "app/main.py", "src/main.py"):
        text = _read_text(project / filename, 100_000)
        module = filename[:-3].replace("/", ".")
        if "FastAPI(" in text and "uvicorn" in deps:
            head = (*pre, "uvicorn") if runner == "uv" else ("-m", "uvicorn")
            args = (*head, f"{module}:app", "--reload", "--host", "127.0.0.1", "--port", "8000")
            out.append(LaunchConfig("api", command, args, 8000, why=f"{filename}: a FastAPI app"))
            break
        if "Flask(" in text and "flask" in deps:
            head = (*pre, "flask") if runner == "uv" else ("-m", "flask")
            args = (*head, "--app", module, "run", "--debug", "--port", "5000")
            out.append(LaunchConfig("flask", command, args, 5000, why=f"{filename}: a Flask app"))
            break
    return out


def suggest(project: Path, existing: list[LaunchConfig] | None = None) -> list[LaunchConfig]:
    """Likely dev server configs for a project, never ones it already has (by name or
    command). Only read from its files: nothing runs."""
    out: list[LaunchConfig] = []
    folders = [project] + [
        project / d for d in _SUBDIRS if (project / d / "package.json").is_file()
    ]
    for folder in folders:
        found = _node_suggestion(folder, project)
        if found is not None:
            out.append(found)
    out += _python_suggestions(project)
    gemfile = _read_text(project / "Gemfile").lower()
    if "rails" in gemfile and (project / "bin" / "rails").exists():
        out.append(
            LaunchConfig(
                "rails",
                "bin/rails",
                ("server", "-b", "127.0.0.1"),
                3000,
                why="Gemfile: a Rails app",
            )
        )
    if not out and (project / "index.html").is_file():
        out.append(
            LaunchConfig(
                "static",
                "python3",
                ("-m", "http.server", "8000", "--bind", "127.0.0.1"),
                8000,
                why="index.html: a static site, served from this folder",
            )
        )
    taken = {c.name for c in existing or []} | {c.command_line for c in existing or []}
    unique: list[LaunchConfig] = []
    for c in out:
        if c.name not in taken and c.command_line not in taken:
            taken |= {c.name, c.command_line}
            unique.append(c)
    return unique[:8]


def output_address(line: str) -> tuple[str, int | None]:
    """A local address (or just a port) a server printed: ("url", port)."""
    if match := _URL_OUT.search(line):
        url = match.group(0).rstrip(".,;)")
        url = re.sub(r"//0\.0\.0\.0|//\[::\]", "//localhost", url)
        with contextlib.suppress(ValueError):
            return url, urlsplit(url).port
        return url, None
    if match := _PORT_OUT.search(line):
        port = int(match.group(1))
        if 0 < port < 65536:
            return "", port
    return "", None


def is_error_line(line: str) -> bool:
    return bool(ERROR_LINE.search(line)) and not NOT_ERROR.search(line)


# ── running ──


@dataclass
class DevServer:
    project: Path
    config: LaunchConfig
    started_by: int | None = None  # the session that started it (it stops when that ends)
    status: str = "starting"  # starting | ready | running | exited | stopped | failed
    port: int | None = None
    url: str = ""
    message: str = ""
    exit_code: int | None = None
    started_at: float = field(default_factory=time.time)
    ring: runproc.LogRing = field(default_factory=lambda: runproc.LogRing(LOG_LINES))
    proc: runproc.Proc | None = None
    printed_url: str = ""
    printed_port: int | None = None
    last_output: float = 0.0  # monotonic, the latest line
    stop_note: str = ""  # why it was stopped, said once it has

    @property
    def key(self) -> str:
        return server_key(self.project, self.config.name)

    @property
    def alive(self) -> bool:
        """Started and not yet taken in as ended (its status says how it ended)."""
        return self.proc is not None and not self.proc.finished

    def address(self) -> str:
        return (
            self.config.url
            or self.printed_url
            or self.config.address(self.port or self.printed_port)
        )

    def public(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "project": str(self.project),
            "name": self.config.name,
            "command": self.config.command_line,
            "status": self.status,
            "port": self.port,
            "url": self.address() if self.status in ("starting", "ready", "running") else "",
            "message": self.message,
            "started_by": self.started_by,
            "started_at": self.started_at,
            "lines": self.ring.seq,
        }

    def errors_since(self, seq: int, limit: int = 20) -> list[str]:
        """Lines of its output after seq that say something went wrong."""
        found = [text for n, text in self.ring.since(seq, 0) if is_error_line(text)]
        return found[-limit:]


def server_key(project: Path, name: str) -> str:
    return f"{project}::{name}"


EnvProvider = Callable[[], dict[str, str]]
Emit = Callable[..., None]


class DevServers:
    """Every dev server the owner or a session started, across projects."""

    def __init__(self, emit: Emit, env: EnvProvider | None = None) -> None:
        self.emit = emit
        self.env = env or runproc.shell_env
        self.servers: dict[str, DevServer] = {}
        self._pending: dict[str, list[tuple[int, str]]] = {}  # output not yet sent
        self._watched: dict[str, float] = {}  # key -> until when a window's logs view shows it
        self._flush: asyncio.TimerHandle | None = None
        self._watchers: set[asyncio.Task] = set()
        self._closing = False

    # ── what's there ──

    def configs(self, project: Path) -> dict[str, Any]:
        configs, problems = read_launch(project)
        return {
            "configs": [c.public() for c in configs],
            "suggestions": [c.public() for c in suggest(project, configs)],
            "problems": problems,
        }

    def config(self, project: Path, name: str) -> LaunchConfig | None:
        configs, _ = read_launch(project)
        return next((c for c in configs if c.name == name), None)

    def for_project(self, project: Path) -> list[DevServer]:
        root = str(project)
        return [s for s in self.servers.values() if str(s.project) == root]

    def running(self, project: Path) -> list[DevServer]:
        return [s for s in self.for_project(project) if s.alive]

    def public(self, project: Path | None = None) -> list[dict[str, Any]]:
        servers = self.servers.values() if project is None else self.for_project(project)
        return [s.public() for s in servers]

    def logs(self, key: str, since: int = 0, limit: int = 500) -> list[tuple[int, str]]:
        server = self.servers.get(key)
        return server.ring.since(since, limit) if server is not None else []

    def watch(self, key: str, seconds: float = 60.0) -> None:
        """A logs view shows this server: its new output goes to the windows as it comes,
        for `seconds` (the view asks again while it stays open)."""
        now = time.monotonic()
        self._watched = {k: until for k, until in self._watched.items() if until > now}
        if key and len(self._watched) < 50:
            self._watched[key] = now + seconds

    # ── starting and stopping ──

    async def start(self, project: Path, name: str, started_by: int | None = None) -> DevServer:
        """Start a configured server (or return it, already running). Raises ValueError
        with a reason to show."""
        config = self.config(project, name)
        if config is None:
            raise ValueError(f"No dev server called {name} in {project.name}'s launch.json.")
        key = server_key(project, name)
        current = self.servers.get(key)
        if current is not None and (current.alive or current.status == "starting"):
            return current  # running, or on its way (a second click while it starts)
        if sum(1 for s in self.servers.values() if s.alive) >= MAX_SERVERS:
            raise ValueError(f"{MAX_SERVERS} dev servers are running already; stop one first.")
        server = DevServer(project, config, started_by=started_by)
        server.port = config.port
        self.servers[key] = server  # before the first wait: a second start finds it
        env = {
            **(await asyncio.to_thread(self.env)),
            "BROWSER": "none",
            "NO_COLOR": "1",
            **dict(config.env),
        }
        cwd = (project / config.cwd) if config.cwd else project
        exe = runproc.which(config.command, env, cwd)
        if exe is None:
            server.status = "failed"
            server.message = f"{config.command} isn't installed, or isn't on your PATH."
            self._changed()
            raise ValueError(server.message)
        server.ring.add([f"$ {config.command_line}"])
        proc = runproc.Proc(
            [exe, *config.args],
            cwd,
            env,
            on_lines=lambda lines: self._output(server, lines),
            on_exit=lambda code: self._ended(server, code),
        )
        server.proc = proc
        try:
            await proc.start()
        except OSError as exc:
            server.proc = None
            server.status, server.message = "failed", f"It didn't start: {exc.strerror or exc}"
            self._changed()
            raise ValueError(server.message) from exc
        self._changed()
        watcher = asyncio.create_task(self._watch(server))
        self._watchers.add(watcher)
        watcher.add_done_callback(self._watchers.discard)
        return server

    async def stop(self, key: str, note: str = "") -> bool:
        server = self.servers.get(key)
        if server is None or server.proc is None or not server.alive:
            return False
        server.message, server.stop_note = "Stopping…", note
        self._changed()
        await server.proc.stop()
        return True

    async def restart(self, key: str) -> DevServer:
        server = self.servers.get(key)
        if server is None:
            raise ValueError("That dev server isn't known.")
        await self.stop(key)
        return await self.start(server.project, server.config.name, server.started_by)

    async def session_ended(self, task_id: int) -> None:
        """A session ended: the servers it started stop with it."""
        for server in list(self.servers.values()):
            if server.started_by == task_id and server.alive:
                await self.stop(server.key, "Stopped with the session that started it.")

    def forget(self, key: str) -> bool:
        """Take a server that isn't running off the list (its logs go with it)."""
        server = self.servers.get(key)
        if server is None or server.alive:
            return False
        del self.servers[key]
        self._changed()
        return True

    async def close(self) -> None:
        self._closing = True
        await asyncio.gather(
            *(s.proc.stop(grace=3.0) for s in self.servers.values() if s.proc and s.alive),
            return_exceptions=True,
        )
        for task in list(self._watchers):
            task.cancel()

    def shutdown(self) -> None:
        """At exit, without the event loop: every group SIGTERM, then SIGKILL."""
        self._closing = True
        runproc.kill_all_now([s.proc for s in self.servers.values() if s.proc is not None])

    # ── while it runs ──

    def _output(self, server: DevServer, lines: list[str]) -> None:
        added = server.ring.add(lines)
        server.last_output = time.monotonic()
        for _, text in added:
            if server.printed_url and server.printed_port:
                break
            url, port = output_address(text)
            if url and not server.printed_url and is_local_url(url):
                server.printed_url = url
            if port and not server.printed_port:
                server.printed_port = port
        if self._watched.get(server.key, 0.0) < time.monotonic():
            return  # no one is looking: the ring keeps it for when they do
        self._pending.setdefault(server.key, []).extend(added)
        if self._flush is None:
            with contextlib.suppress(RuntimeError):
                self._flush = asyncio.get_running_loop().call_later(LOG_EVERY, self._send_logs)

    def _send_logs(self) -> None:
        self._flush = None
        pending, self._pending = self._pending, {}
        for key, lines in pending.items():
            self.emit("devserver_log", key=key, lines=[[n, t] for n, t in lines[-400:]])

    def _ended(self, server: DevServer, code: int | None) -> None:
        server.exit_code = code
        stopped = server.proc is not None and server.proc.stopping
        server.status = "stopped" if stopped else "exited"
        server.message = server.stop_note if stopped else f"It {runproc.describe_exit(code)}."
        server.ring.add([f"[the process {runproc.describe_exit(code)}]"])
        if not self._closing:
            self._changed()

    async def _watch(self, server: DevServer) -> None:
        """Find where it answers: the config's port, the address it prints, or a port its
        processes listen on; ready once that answers."""
        deadline = time.monotonic() + READY_WAIT
        looked = 0.0
        while server.alive and time.monotonic() < deadline:
            port = server.config.port or server.printed_port
            if port is None and time.monotonic() - looked > 2.0 and server.proc is not None:
                looked = time.monotonic()
                pid = server.proc.pid
                if pid is not None:
                    ports = await asyncio.to_thread(runproc.listening_ports, pid)
                    if ports:
                        port = min(ports)
            if port is not None:
                server.port = port
                if await runproc.port_open(port):
                    server.status = "ready"
                    server.message = ""
                    self._changed()
                    return
            await asyncio.sleep(0.5)
        if server.alive:
            server.status = "running"
            if server.port is None:
                server.message = "Running; it hasn't said its address."
            self._changed()

    def _changed(self) -> None:
        self.emit("devservers", items=self.public())

    async def settled(self, server: DevServer, quiet: float = 0.6, most: float = 6.0) -> None:
        """Wait for a server to go quiet after a change (a rebuild's output), at most `most`."""
        end = time.monotonic() + most
        await asyncio.sleep(min(quiet, most))
        while time.monotonic() < end and time.monotonic() - server.last_output < quiet:
            await asyncio.sleep(0.1)
