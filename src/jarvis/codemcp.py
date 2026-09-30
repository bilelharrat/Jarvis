"""Claude Code's MCP servers as its own files hold them, and its CLI for changing them
(features.code_mcp): the servers a session's folder has in each scope, whether a project's
shared ones (.mcp.json) are approved there, and `claude mcp add-json / remove / login`.

Where Claude Code keeps them:
- user scope: ~/.claude.json, "mcpServers" (every project);
- local scope: ~/.claude.json, "projects" → the folder → "mcpServers" (this folder, the
  owner alone);
- project scope: <folder>/.mcp.json, "mcpServers" (shared with everyone who has the
  project). A folder's shared servers run only once approved there: "enabledMcpjsonServers"
  / "disabledMcpjsonServers" / "enableAllProjectMcpServers" in its settings files, or the
  choices Claude Code kept in ~/.claude.json for the folder.

Everything is read defensively (a file that isn't there or isn't JSON has none), and only
the CLI writes ~/.claude.json: Claude Code rewrites that file itself, all the time. What the
window is shown of a server is its program and arguments or its address, with anything that
looks like a secret masked, never its environment or headers.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shlex
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from . import jsonstore, secret_scan

SCOPES = ("project", "local", "user")
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$")
CLI_TIMEOUT = 60.0  # adding or removing
LOGIN_TIMEOUT = 300.0  # a sign-in in the browser
OUTPUT_KEPT = 2000
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_SECRET_FLAG = re.compile(
    r"^--?[\w-]*(?:token|key|secret|password|passwd|auth)[\w-]*(?:=(.*))?$", re.I
)


def claude_json() -> Path:
    """Claude Code's own state file (CLAUDE_CONFIG_DIR's, else the home folder's)."""
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return Path(base) / ".claude.json" if base else Path.home() / ".claude.json"


def user_settings() -> Path:
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return (Path(base) if base else Path.home() / ".claude") / "settings.json"


def cli_path() -> str | None:
    """The Claude Code CLI sessions run: the SDK's own, else one on the PATH."""
    with contextlib.suppress(Exception):
        import claude_agent_sdk

        bundled = Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude"
        if bundled.is_file():
            return str(bundled)
    return shutil.which("claude")


@dataclass
class Server:
    name: str
    scope: str  # project | local | user
    kind: str  # stdio | http | sse | ws | …
    target: str  # what it runs, or where it is (secrets masked)
    approved: bool | None = None  # a shared (project) one: approved here, refused, not yet

    def public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "scope": self.scope,
            "kind": self.kind,
            "target": self.target,
            "approved": self.approved,
        }


def _read(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _hidden(word: str) -> str:
    return secret_scan.mask(word) if secret_scan.scan_line(word) else word


def shown_command(command: str, args: list[str]) -> str:
    """A server's command line as the window shows it: a value given to a flag named for a
    secret, or anything that looks like one, masked."""
    out: list[str] = []
    hide = False
    for word in [command, *args][:40]:
        word = str(word)
        if hide:
            out.append(secret_scan.mask(word))
            hide = False
            continue
        flag = _SECRET_FLAG.match(word)
        if flag:
            if flag.group(1) is not None:
                out.append(word.split("=", 1)[0] + "=" + secret_scan.mask(flag.group(1)))
            else:
                out.append(word)
                hide = True
            continue
        out.append(_hidden(word))
    return shlex.join(out)[:300]


def shown_url(url: str) -> str:
    """An address as the window shows it: no user name, password or query."""
    try:
        parts = urlsplit(str(url))
    except ValueError:
        return ""
    host = parts.hostname or ""
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme}://{host}{port}{parts.path}"[:300] if host else ""


def describe(name: str, config: Any, scope: str) -> Server | None:
    """A server's entry in a config file, or None when it isn't one."""
    if not isinstance(name, str) or not name or not isinstance(config, dict):
        return None
    kind = str(config.get("type") or ("stdio" if config.get("command") else "http"))[:20]
    if config.get("command"):
        args = config.get("args") if isinstance(config.get("args"), list) else []
        target = shown_command(str(config["command"]), [str(a) for a in args])
    else:
        target = shown_url(str(config.get("url") or ""))
    return Server(name[:64], scope, kind, target)


def _names(value: Any) -> set[str]:
    return {v for v in value if isinstance(v, str)} if isinstance(value, list) else set()


def approval(
    folder: Path, state: dict[str, Any], settings: Path
) -> tuple[bool, set[str], set[str]]:
    """Whether a folder's shared servers are all approved, and those approved or refused
    by name: its settings files (local over project over user), then Claude Code's own
    choices for the folder in ~/.claude.json."""
    everything = False
    enabled: set[str] = set()
    disabled: set[str] = set()
    project = (
        state.get("projects", {}).get(str(folder))
        if isinstance(state.get("projects"), dict)
        else None
    )
    sources = [
        _read(settings),
        _read(folder / ".claude" / "settings.json"),
        _read(folder / ".claude" / "settings.local.json"),
        project if isinstance(project, dict) else {},
    ]
    for data in sources:
        if data.get("enableAllProjectMcpServers") is True:
            everything = True
        enabled |= _names(data.get("enabledMcpjsonServers"))
        disabled |= _names(data.get("disabledMcpjsonServers"))
    return everything, enabled, disabled


def configured(folder: Path, state_path: Path, settings: Path) -> list[Server]:
    """The servers a folder's sessions have, from every scope."""
    state = _read(state_path)
    found: list[Server] = []
    shared = _read(folder / ".mcp.json").get("mcpServers")
    everything, enabled, disabled = approval(folder, state, settings)
    for name, config in shared.items() if isinstance(shared, dict) else []:
        server = describe(name, config, "project")
        if server is not None:
            server.approved = (
                False if name in disabled else True if everything or name in enabled else None
            )
            found.append(server)
    projects = state.get("projects")
    mine = projects.get(str(folder)) if isinstance(projects, dict) else None
    local = mine.get("mcpServers") if isinstance(mine, dict) else None
    for name, config in local.items() if isinstance(local, dict) else []:
        if server := describe(name, config, "local"):
            found.append(server)
    user = state.get("mcpServers")
    for name, config in user.items() if isinstance(user, dict) else []:
        if server := describe(name, config, "user"):
            found.append(server)
    return found[:200]


def approve(folder: Path, name: str, yes: bool) -> None:
    """Approve (or refuse) one of a folder's shared servers, in its settings.local.json (the
    owner's alone), keeping everything else there. OSError when the file can't be used."""
    path = folder / ".claude" / "settings.local.json"
    data: dict[str, Any] = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            raise OSError(
                "settings.local.json can't be read, so nothing was written to it."
            ) from exc
        if not isinstance(data, dict):
            raise OSError(
                "settings.local.json isn't a settings object, so nothing was written to it."
            )
    add, drop = "enabledMcpjsonServers", "disabledMcpjsonServers"
    if not yes:
        add, drop = drop, add
    for key in (add, drop):
        if key in data and not isinstance(data[key], list):
            raise OSError("settings.local.json has server lists of a kind this can't change.")
    data[drop] = [n for n in data.get(drop, []) if n != name]
    if not data[drop]:
        del data[drop]
    have = data.setdefault(add, [])
    if name not in have:
        have.append(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    jsonstore.save_json(path, data, mode=0o644, backup=False)


def server_config(kind: str, target: str, transport: str = "http") -> dict[str, Any]:
    """A new server's config from what the owner typed: a command line, or an address.
    ValueError says what's wrong. No environment or headers: a secret never goes through
    here (a server that needs one signs in, or is one of JARVIS's connectors)."""
    target = str(target or "").strip()
    if kind == "url":
        parts = urlsplit(target)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("An address starts with https:// (or http:// for one on this Mac).")
        if parts.username or parts.password:
            raise ValueError("Leave the sign-in out of the address: the server asks for it.")
        return {"type": "sse" if transport == "sse" else "http", "url": target}
    try:
        words = shlex.split(target)
    except ValueError as exc:
        raise ValueError("That command has a quote that isn't closed.") from exc
    if not words:
        raise ValueError("Type the command that starts the server, like npx -y some-mcp-server.")
    return {"type": "stdio", "command": words[0], "args": words[1:]}


async def run_cli(args: list[str], cwd: Path, timeout: float = CLI_TIMEOUT) -> tuple[int, str]:
    """Run the Claude Code CLI (claude <args>) in a folder: its exit code and what it said
    (trimmed). A CLI that isn't there, or doesn't finish in time, is a failure."""
    cli = cli_path()
    if cli is None:
        return 127, "Claude Code's command-line tool isn't installed."
    try:
        proc = await asyncio.create_subprocess_exec(
            cli,
            *args,
            cwd=str(cwd),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except OSError as exc:
        return 126, str(exc)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        return 124, "It took too long."
    finally:
        if proc.returncode is None:  # (timed out, or the hub is closing)
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            with contextlib.suppress(Exception):
                await asyncio.shield(proc.wait())
    text = _ANSI.sub("", (out or b"").decode("utf-8", "replace"))
    return proc.returncode or 0, text.strip()[-OUTPUT_KEPT:]
