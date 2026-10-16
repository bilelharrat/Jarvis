"""Bring over from another coding tool: what the owner has set up in Claude Code, Codex,
Cursor, Windsurf, Copilot, Gemini CLI, Cline, Aider, Zed and the rest, found on this computer
and brought into Eden Code in one guided flow (features/code_import.py is its window side).

How it's laid out:
- One adapter module per tool, in jarvis/import_sources/ (claude_code.py, codex.py, …), each
  with a SOURCE: Source(id, name, detect, scan, read_chat). detect(env) gives the tool's
  files and folders that are there (none: the tool isn't on this computer); scan(env, ctx)
  gives the Items the preview lists; read_chat(entry) reads one past chat back, for the
  read-only history.
- An Item is one thing found: a project folder, an MCP server, a rules file, a saved prompt,
  a model choice, a group of past chats, or a note about what already works or can't move.
  Its status says what Import would do: "new" (brought over when ticked), "already" (it
  already works in Eden Code, nothing to do), "added" (brought over by an earlier import),
  "manual" (a step only the owner can take, and where), "skip" (it can't move, and why) or
  "error" (that file couldn't be read: the rest still loads).
- The Ledger (code-import.json beside prefs.json) keeps what each import added, so the same
  import twice adds nothing twice and Undo takes away exactly that, and nothing the owner had.

Where things land in Eden Code (never in the other tool's own files):
- projects: Settings › Projects' folders (the code_project_folders setting). A Claude Code
  project's past conversations come with it: Eden Code's history is Claude Code's own record
  of each session, so they're listed under the project and resume as the same conversation.
- MCP servers: Eden Code's own list of imported servers (the ledger), added to every Eden Code
  session's servers (features/code_import's option hook). A server's keys (environment values
  that are secrets) only come when the owner ticks it, and then go into the Keychain; the
  server is started through import_mcp_launch.py, which puts them in its environment, so no
  key is in a file, a setting, a command line or the window.
- rules and instructions (.cursorrules, global_rules.md, GEMINI.md, copilot-instructions.md…):
  the ledger keeps where each file is; a session reads it fresh with its first message (for
  every project, or for the file's own project), as the owner's notes. Nothing is copied.
- saved prompts and custom commands: Eden Code's saved prompts (code_snippets: /name).
- a model or a permission mode: Eden Code's own default for new sessions, when it names one
  Eden Code has; keys for other providers are never copied (Settings › Models takes them into
  the Keychain, by the owner's hand).
- past chats in a format that can be read: entries in a read-only history, read back from the
  tool's own file when the owner opens one (never copied, never changed).

Strictly read-only on every tool's files: they are opened for reading only (SQLite databases
with mode=ro and immutable, so not even a lock file is made), never written, moved or deleted.
A secret found in them (an env value, a header, a key in a command line) is never logged, kept
or sent to the window: the window sees its name and a mask (secret_scan.mask).

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import logging
import os
import pkgutil
import re
import sqlite3
import sys
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from . import codemcp, jsonstore, secret_scan

log = logging.getLogger("jarvis")

STORE = "code_import"
jsonstore.register_store(STORE, 1)

STATUSES = ("new", "already", "added", "manual", "skip", "error")
KINDS = ("signin", "project", "chats", "mcp", "rules", "command", "model", "setting", "note")
RULES_CHARS = 8000  # of one rules file, with a session's first message
RULES_TOTAL = 16000  # of all of them together
COMMAND_CHARS = 8000  # a saved prompt's text (code_projects.SNIPPET_TEXT)
READ_MAX = 2_000_000  # bytes of a settings file: more is no settings file
CHATS_PER_SOURCE = 2000  # past chats listed from one tool
CHAT_MESSAGES = 400  # messages shown of one past chat
CHAT_TEXT = 20_000  # characters of one message
MCP_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$")
_SECRET_NAME = re.compile(
    r"(KEY|TOKEN|SECRET|PASSW|PWD|AUTH|CREDENTIAL|COOKIE|SESSION|PRIVATE|\bPAT\b|_PAT$)", re.I
)
_ENV_REF = re.compile(
    r"^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Za-z_][A-Za-z0-9_]*)$|^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$"
)
VAULT_PREFIX = "code-import:"  # Keychain entries: "code-import:<server>" / <VARIABLE>


class ReadError(Exception):
    """A file that's there but can't be read as what it should be (the sentence says which)."""


# ── where things are ──


@dataclass
class Env:
    """The computer as the adapters see it: the home folder (a test's own), the platform, and
    the folders apps keep their data in there."""

    home: Path
    platform: str = sys.platform

    @property
    def is_win(self) -> bool:
        return self.platform == "win32"

    @property
    def is_mac(self) -> bool:
        return self.platform == "darwin"

    def app_data(self) -> Path:
        """Where apps keep their settings: ~/Library/Application Support, %APPDATA%, ~/.config."""
        if self.is_mac:
            return self.home / "Library" / "Application Support"
        if self.is_win:
            raw = os.environ.get("APPDATA")
            if raw and Path(raw).is_absolute() and Path(raw).resolve().is_relative_to(self.home):
                return Path(raw)
            return self.home / "AppData" / "Roaming"
        return self.home / ".config"

    def config(self) -> Path:
        """~/.config, where CLI tools keep theirs on every platform (Zed, OpenCode, Amp); on a
        PC, some use %APPDATA% instead (config_dirs gives both)."""
        return self.home / ".config"

    def config_dirs(self, name: str) -> list[Path]:
        out = [self.config() / name]
        if self.is_win:
            out.append(self.app_data() / name)
        return out

    def local_share(self) -> Path:
        return self.home / ".local" / "share"

    def vscode_user(self, app: str) -> Path:
        """A VS Code-style editor's User folder (app: "Code", "Cursor", "Windsurf", "Kiro")."""
        return self.app_data() / app / "User"

    def claude_dir(self) -> Path:
        """Claude Code's own folder: CLAUDE_CONFIG_DIR when set (as it reads it), else ~/.claude."""
        given = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
        return Path(given).expanduser() if given else self.home / ".claude"

    def claude_json(self) -> Path:
        given = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
        return Path(given).expanduser() / ".claude.json" if given else self.home / ".claude.json"


def is_dir(path: Path) -> bool:
    try:
        return path.is_dir()
    except OSError:
        return False


def is_file(path: Path) -> bool:
    try:
        return path.is_file()
    except OSError:
        return False


def existing(paths: Iterable[Path]) -> list[Path]:
    """The ones that are there (a file or a folder)."""
    return [p for p in paths if is_file(p) or is_dir(p)]


def listing(folder: Path, pattern: str = "*", limit: int = 500) -> list[Path]:
    """A folder's entries matching pattern, sorted; none when it can't be read."""
    try:
        return sorted(folder.glob(pattern))[:limit]
    except OSError:
        return []


# ── reading, never writing ──


def read_bytes(path: Path, limit: int = READ_MAX) -> bytes:
    try:
        with open(path, "rb") as handle:  # (read-only: never "r+", never a lock)
            data = handle.read(limit + 1)
    except OSError as exc:
        raise ReadError(f"Couldn't read {path.name}: {exc.strerror or 'no access'}.") from None
    if len(data) > limit:
        raise ReadError(f"{path.name} is too big to be a settings file.")
    return data


def read_text(path: Path, limit: int = READ_MAX) -> str:
    return read_bytes(path, limit).decode("utf-8", errors="replace")


def strip_jsonc(text: str) -> str:
    """JSON with comments and trailing commas (VS Code's, Zed's) as plain JSON. Strings are
    kept whole: a // in a URL is no comment."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i : j + 1])
            i = j + 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
        else:
            out.append(c)
            i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def read_json(path: Path) -> Any:
    text = read_text(path)
    try:
        return json.loads(text)
    except ValueError:
        pass
    try:
        return json.loads(strip_jsonc(text))
    except ValueError:
        raise ReadError(f"Couldn't read {path.name}: it isn't JSON this importer knows.") from None


def read_toml(path: Path) -> dict[str, Any]:
    import tomllib

    try:
        return tomllib.loads(read_text(path))
    except tomllib.TOMLDecodeError:
        raise ReadError(f"Couldn't read {path.name}: it isn't TOML this importer knows.") from None


def read_yaml(path: Path) -> Any:
    try:
        import yaml
    except ImportError:
        raise ReadError(f"Couldn't read {path.name}: no YAML reader in this build.") from None
    try:
        return yaml.safe_load(read_text(path))
    except yaml.YAMLError:
        raise ReadError(f"Couldn't read {path.name}: it isn't YAML this importer knows.") from None


def read_any(path: Path) -> Any:
    """JSON, JSONC, TOML or YAML, by the file's name."""
    suffix = path.suffix.lower()
    if suffix == ".toml":
        return read_toml(path)
    if suffix in (".yaml", ".yml"):
        return read_yaml(path)
    return read_json(path)


def sqlite_rows(path: Path, query: str, args: tuple = ()) -> list[tuple]:
    """Rows of a query on a SQLite file opened read-only and immutable: nothing is written,
    not even a -wal or -shm file beside it."""
    uri = f"{Path(path).absolute().as_uri()}?mode=ro&immutable=1"
    try:
        con = sqlite3.connect(uri, uri=True, timeout=1)
    except sqlite3.Error:
        raise ReadError(f"Couldn't open {path.name}.") from None
    try:
        return con.execute(query, args).fetchall()
    except sqlite3.Error:
        raise ReadError(
            f"Couldn't read {path.name}: its layout isn't one this importer knows."
        ) from None
    finally:
        con.close()


def front_matter(text: str) -> tuple[dict[str, str], str]:
    """A Markdown file's front matter (simple key: value lines) and the rest."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    meta: dict[str, str] = {}
    for line in text[3:end].splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip().lower()] = v.strip().strip("'\"")
    rest = text[end + 4 :]
    return meta, rest.lstrip("\n")


def file_uri(uri: Any) -> Path | None:
    """A file:// address (VS Code's workspace.json) as a path; None for anything else (a
    remote folder, a .code-workspace file)."""
    if not isinstance(uri, str) or not uri.startswith("file://"):
        return None
    parts = urlsplit(uri)
    raw = unquote(parts.path)
    if re.match(r"^/[A-Za-z]:", raw):  # file:///c%3A/Users/…
        raw = raw[1:]
    return Path(raw) if raw else None


def fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:16]


# ── secrets ──


def secret_name(name: str) -> bool:
    return bool(_SECRET_NAME.search(str(name)))


def looks_secret(value: Any) -> bool:
    return isinstance(value, str) and bool(value) and bool(secret_scan.scan_line(value))


def env_ref(value: Any) -> str | None:
    """The variable a value only names (${GITHUB_TOKEN}, $X, ${env:X}, {env:X}), else None."""
    if not isinstance(value, str):
        return None
    m = _ENV_REF.match(value.strip())
    return next((g for g in m.groups() if g), None) if m else None


def masked(value: Any) -> str:
    return secret_scan.mask(str(value)) if value else ""


# ── what's found ──


@dataclass
class Item:
    """One thing found, as the preview lists it. payload is for the import only: it may hold
    a key, so it never goes to the window or a log (public() leaves it out)."""

    id: str
    kind: str
    title: str
    detail: str = ""
    status: str = "new"
    why: str = ""
    group: str = ""
    checked: bool | None = None  # None: ticked when it's new
    secrets: list[str] = field(default_factory=list)  # names of the keys it has (no values)
    count: int = 0
    payload: dict[str, Any] = field(default_factory=dict)

    def public(self) -> dict[str, Any]:
        out = {
            "id": self.id,
            "kind": self.kind,
            "title": self.title[:200],
            "detail": self.detail[:400],
            "status": self.status,
            "why": self.why[:400],
            "group": self.group or GROUPS.get(self.kind, ""),
            "checked": (self.status == "new") if self.checked is None else bool(self.checked),
            "can_import": self.status == "new",
        }
        if self.secrets:
            out["secrets"] = self.secrets[:20]
        if self.count:
            out["count"] = self.count
        return out


GROUPS = {
    "signin": "Sign-in",
    "project": "Projects",
    "chats": "Past conversations",
    "mcp": "MCP servers",
    "rules": "Rules and instructions",
    "command": "Commands and saved prompts",
    "model": "Models and modes",
    "setting": "Settings",
    "note": "Settings",
}


def error_item(source: str, path: Path, exc: BaseException) -> Item:
    why = str(exc) if isinstance(exc, ReadError) else f"Couldn't read {path.name}."
    return Item(
        id=f"error:{path}",
        kind="note",
        title=f"{path.name}",
        detail=_shown_path(path),
        status="error",
        why=why,
    )


def _shown_path(path: Path) -> str:
    """A path as the window shows it, the home folder as ~."""
    home = str(Path.home())
    text = str(path)
    return "~" + text[len(home) :] if text == home or text.startswith(home + os.sep) else text


@dataclass
class Context:
    """What Eden Code has now, for each Item's status (scan reads it, never changes it)."""

    eden_projects: dict[str, str] = field(default_factory=dict)  # path -> how it's on the list
    folders: list[Path] = field(default_factory=list)  # project folders to look for rules in
    snippets: dict[str, str] = field(default_factory=dict)  # saved prompt name -> text
    ledger: dict[str, Any] = field(default_factory=dict)  # every source's imports
    claude_mcp: set[str] = field(default_factory=set)  # servers Claude Code itself has
    code_model: str = ""
    code_mode: str = "ask"
    known_model: Callable[[str], bool] = lambda _ref: False
    signed_in: bool | None = None  # Claude Code's own login (claude auth status)
    using_key: bool = False  # Eden signs in with an API key (claude_signin)
    folder_ok: Callable[[str], str] = lambda _p: ""  # why a folder can't be a project ("": it can)
    projects_dir: Path | None = None
    roots: list[Path] = field(default_factory=list)
    folders_room: int = 50  # folders Settings › Projects can still take

    def imported(self, kind: str) -> dict[str, str]:
        """{what was imported (a path, a server or prompt name, a chat id): source id}."""
        out: dict[str, str] = {}
        for source, entry in self.ledger.items():
            if not isinstance(entry, dict):
                continue
            value = entry.get(kind)
            if isinstance(value, dict):
                out.update({k: source for k in value})
            elif isinstance(value, list):
                for v in value:
                    key = (
                        v.get("path") or v.get("name") or v.get("id") if isinstance(v, dict) else v
                    )
                    if isinstance(key, str):
                        out[key] = source
        return out

    def on_list(self, path: Path) -> bool:
        """Whether a folder is already one of Eden Code's projects (itself, or in the projects
        folder or one of Settings' roots)."""
        text = str(path)
        if text in self.eden_projects:
            return True
        parents = {self.projects_dir, *self.roots} - {None}
        return path.parent in parents


@dataclass
class Source:
    id: str
    name: str
    detect: Callable[[Env], list[Path]]
    scan: Callable[[Env, Context], list[Item]]
    read_chat: Callable[[dict[str, Any]], list[dict[str, str]]] | None = None
    blurb: str = ""


def sources() -> list[Source]:
    """Every adapter in jarvis/import_sources, in the order of their ORDER (Claude Code first);
    a broken one is left out (logged), the rest still load."""
    from . import import_sources

    found: list[tuple[int, str, Source]] = []
    for info in pkgutil.iter_modules(import_sources.__path__):
        if info.name.startswith("_"):
            continue
        try:
            module = importlib.import_module(f"{import_sources.__name__}.{info.name}")
        except Exception:
            log.exception("import source %s didn't load", info.name)
            continue
        source = getattr(module, "SOURCE", None)
        if isinstance(source, Source):
            found.append((int(getattr(module, "ORDER", 50)), source.name.lower(), source))
    return [s for _o, _n, s in sorted(found, key=lambda t: (t[0], t[1]))]


def source_by_id(source_id: str) -> Source | None:
    return next((s for s in sources() if s.id == source_id), None)


def detect(source: Source, env: Env) -> list[Path]:
    try:
        return list(source.detect(env))
    except Exception:
        log.warning("Couldn't look for %s", source.name, exc_info=True)
        return []


def scan(source: Source, env: Env, ctx: Context) -> list[Item]:
    """The adapter's Items, each id once; an adapter that fails says so in one Item."""
    try:
        items = list(source.scan(env, ctx))
    except Exception:
        log.warning("Couldn't read %s's settings", source.name, exc_info=True)
        return [Item(id="error:scan", kind="note", title=f"{source.name}'s settings",
                     status="error", why=f"Couldn't read {source.name}'s settings.")]  # fmt: skip
    seen: set[str] = set()
    out: list[Item] = []
    for item in items:
        if item.id in seen:
            continue
        seen.add(item.id)
        out.append(item)
    return out


# ── items the adapters share ──


def project_items(source: str, paths: Iterable[tuple[Path, int]], ctx: Context) -> list[Item]:
    """A tool's project folders (path, how many past chats it has there) as Items: one that's
    gone, or too broad, or already on Eden's list, says so."""
    imported = ctx.imported("projects")
    items: list[Item] = []
    names = {Path(p).name for p in ctx.eden_projects}
    seen: set[str] = set()
    for path, chats in paths:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        item = Item(id=f"project:{key}", kind="project", title=path.name or key,
                    detail=_shown_path(path), count=chats, payload={"path": key})  # fmt: skip
        if chats:
            item.detail += f" · {chats} past conversation{'s' if chats != 1 else ''}"
        if not is_dir(path):
            item.status, item.why = "skip", "That folder isn't there any more."
        elif ".claude/worktrees/" in key.replace("\\", "/") or "/.git/" in key.replace("\\", "/"):
            item.status, item.why = (
                "skip",
                "A working copy of another project: its project comes instead.",
            )
        elif ctx.on_list(path):
            if key in imported:
                item.status, item.why = "added", "Brought over before."
            else:
                item.status, item.why = "already", "Already one of Eden Code's projects."
        elif problem := ctx.folder_ok(key):
            item.status, item.why = "skip", problem
        elif path.name in names:
            item.status = "skip"
            item.why = f"Eden Code already has a project called “{path.name}”: rename one folder to have both."
        else:
            names.add(path.name)
        items.append(item)
    return items


def normalize_mcp(config: Any) -> tuple[dict[str, Any] | None, dict[str, str], str]:
    """(the server as Claude Code's config has it, {variable: secret value} kept apart, why
    it can't come as it is ("": it can)). Every tool's shapes: command + args + env (most),
    command as a list (OpenCode), command.path (Zed), url / serverUrl / httpUrl (+ headers),
    transport.{type, command} (Continue's JSON)."""
    if not isinstance(config, dict):
        return None, {}, "Its settings aren't in a shape this importer knows."
    if isinstance(config.get("transport"), dict):
        config = {**config, **config["transport"]}
    command = config.get("command")
    args = config.get("args") or []
    if isinstance(command, dict):  # Zed: {"command": {"path", "args", "env"}}
        args = command.get("args") or args
        config = {**config, "env": command.get("env") or config.get("env")}
        command = command.get("path")
    if isinstance(command, list):  # OpenCode: one list
        command, args = (command[0] if command else None), [*command[1:], *args]
    env_raw = config.get("env") or config.get("environment") or {}
    url = config.get("url") or config.get("serverUrl") or config.get("httpUrl")
    if not isinstance(args, list) or not all(isinstance(a, (str, int, float)) for a in args):
        return None, {}, "Its arguments aren't in a shape this importer knows."
    if not isinstance(env_raw, dict):
        env_raw = {}
    plain: dict[str, str] = {}
    secret: dict[str, str] = {}
    problems: list[str] = []
    for name, value in list(env_raw.items())[:60]:
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,99}", name):
            continue
        value = "" if value is None else str(value)
        ref = env_ref(value)
        if ref:
            plain[name] = f"${{{ref}}}"  # (Claude Code fills ${VAR} in from the environment)
        elif value.startswith("${input:"):
            problems.append(f"{name} is asked for in VS Code each time")
        elif secret_name(name) or looks_secret(value):
            if value:
                secret[name] = value
        else:
            plain[name] = value
    if isinstance(command, str) and command.strip():
        words = [str(a) for a in args][:200]
        if any(looks_secret(w) for w in words):
            return (
                None,
                {},
                "Its command line holds a key: add it in the MCP servers pane yourself, with the key as a secret.",
            )
        spec: dict[str, Any] = {"type": "stdio", "command": command.strip(), "args": words}
        if plain:
            spec["env"] = plain
        return spec, secret, "; ".join(problems)
    if isinstance(url, str) and url.strip():
        parts = urlsplit(url.strip())
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return None, {}, "Its address isn't a web address."
        if parts.username or parts.password or (parts.query and looks_secret(parts.query)):
            return None, {}, "Its address holds a key: add it in the MCP servers pane yourself."
        kind = str(config.get("type") or config.get("transport") or "").lower()
        kind = "sse" if "sse" in kind else "http"
        if config.get("httpUrl"):
            kind = "http"
        spec = {"type": kind, "url": url.strip()}
        headers = config.get("headers") or config.get("http_headers") or {}
        if isinstance(headers, dict) and headers:
            kept: dict[str, str] = {}
            for name, value in headers.items():
                value = str(value)
                ref = env_ref(value.removeprefix("Bearer ").strip())
                if ref:
                    kept[str(name)] = value.replace(
                        value.removeprefix("Bearer ").strip(), f"${{{ref}}}"
                    )
                elif secret_name(name) or looks_secret(value):
                    return (
                        None,
                        {},
                        "It signs in with a key in a header: add it in the MCP servers pane yourself.",
                    )
                else:
                    kept[str(name)] = value
            if kept:
                spec["headers"] = kept
        token_var = config.get("bearer_token_env_var")  # Codex
        if isinstance(token_var, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", token_var):
            spec.setdefault("headers", {})["Authorization"] = f"Bearer ${{{token_var}}}"
        return spec, {}, "; ".join(problems)
    return None, {}, "It has neither a command nor an address."


def shown_spec(spec: dict[str, Any]) -> str:
    if spec.get("type") == "stdio":
        return codemcp.shown_command(spec["command"], spec.get("args") or [])
    return codemcp.shown_url(spec.get("url", ""))


def mcp_items(
    source: str, servers: Any, where: str, ctx: Context, *, scope_note: str = ""
) -> list[Item]:
    """A tool's MCP servers ({name: config}, or a list of {name, …}) as Items, keys masked."""
    if isinstance(servers, list):
        servers = {str(s.get("name")): s for s in servers if isinstance(s, dict) and s.get("name")}
    if not isinstance(servers, dict):
        return []
    imported = ctx.imported("mcp")
    items: list[Item] = []
    for name, config in list(servers.items())[:100]:
        name = str(name)
        item = Item(id=f"mcp:{name}", kind="mcp", title=name, detail=where)
        spec, secret, problem = normalize_mcp(config)
        if not MCP_NAME.match(name):
            item.status, item.why = "skip", "Its name has characters an MCP server's name can't."
        elif spec is None:
            item.status, item.why = "manual", problem
        else:
            item.detail = f"{shown_spec(spec)} · {where}"
            item.secrets = sorted(secret)
            item.payload = {"name": name, "spec": spec, "secret_env": secret}
            disabled = isinstance(config, dict) and (
                config.get("disabled") is True or config.get("enabled") is False
            )
            if imported.get(name) == source:
                item.status, item.why = "added", "Brought over before."
            elif name in imported:
                item.status, item.why = (
                    "skip",
                    f"A server called {name} came from another tool already.",
                )
            elif name in ctx.claude_mcp:
                item.status, item.why = (
                    "already",
                    f"Claude Code has a server called {name}: it already loads in Eden Code.",
                )
            else:
                if secret:
                    keys = ", ".join(sorted(secret))
                    item.why = (f"Its key{'s' if len(secret) > 1 else ''} ({keys}) {'go' if len(secret) > 1 else 'goes'} into the Keychain "
                                "when you tick it, never into a file.")  # fmt: skip
                    item.checked = False  # a key moves only when the owner says so
                if problem:
                    item.why = (item.why + " " if item.why else "") + problem + "."
                if disabled:
                    item.checked = False
                    item.why = (item.why + " " if item.why else "") + "It's off there."
        if scope_note and not item.why:
            item.why = scope_note
        items.append(item)
    return items


def rules_item(source: str, path: Path, scope: str, ctx: Context, *, project: Path | None = None,
               label: str = "") -> Item | None:  # fmt: skip
    """A rules or instructions file as an Item (None when it's empty or not there)."""
    try:
        if not is_file(path) or path.stat().st_size == 0:
            return None
    except OSError:
        return None
    key = str(path)
    where = "every project" if scope == "user" else (project.name if project else "its project")
    item = Item(id=f"rules:{key}", kind="rules", title=label or path.name,
                detail=f"{_shown_path(path)} · for {where}",
                payload={"path": key, "scope": scope, "project": str(project or ""), "label": label or path.name})  # fmt: skip
    if key in ctx.imported("rules"):
        item.status, item.why = (
            "added",
            "Brought over before: sessions read it with their first message.",
        )
    else:
        item.why = (
            "Sessions read it with their first message. Nothing is copied: edit it where it is."
        )
    return item


def project_rules(source: str, ctx: Context, names: Iterable[str], label: str) -> list[Item]:
    """Rules files a tool keeps inside projects (names relative to the project, globs too),
    in every project folder Eden knows or this import brings."""
    items: list[Item] = []
    for folder in ctx.folders[:200]:
        for name in names:
            matches = (
                listing(folder, name, 30) if any(c in name for c in "*?[") else [folder / name]
            )
            for path in matches:
                found = rules_item(source, path, "project", ctx, project=folder,
                                   label=f"{label}: {folder.name}/{path.relative_to(folder)}")  # fmt: skip
                if found:
                    items.append(found)
    return items


SNIPPET_NAME = re.compile(r"[^a-z0-9-]+")


def snippet_name(raw: str) -> str:
    name = SNIPPET_NAME.sub("-", raw.strip().lower()).strip("-")[:40]
    return name if name and name[0].isalnum() else ""


def command_item(source: str, name: str, text: str, where: str, ctx: Context) -> Item | None:
    name = snippet_name(name)
    text = text.strip()
    if not name or not text:
        return None
    item = Item(id=f"command:{name}", kind="command", title=f"/{name}", detail=where,
                payload={"name": name, "text": text[:COMMAND_CHARS]})  # fmt: skip
    have = ctx.snippets.get(name)
    if name in ctx.imported("commands") and have is not None:
        item.status, item.why = "added", "Brought over before."
    elif have is not None:
        if have.strip() == text[:COMMAND_CHARS].strip():
            item.status, item.why = "already", "Eden Code has this saved prompt already."
        else:
            item.status, item.why = "skip", f"Eden Code has another saved prompt called /{name}."
    else:
        item.why = f"A saved prompt: type /{name} in Eden Code."
    if len(text) > COMMAND_CHARS and item.status == "new":
        item.why += f" (its first {COMMAND_CHARS:,} characters)"
    return item


def commands_in(source: str, folder: Path, pattern: str, where: str, ctx: Context, *,
                strip: str = "", toml_key: str = "") -> list[Item]:  # fmt: skip
    """Saved prompts from a folder of files (Markdown, or TOML with the prompt in toml_key)."""
    items: list[Item] = []
    if not is_dir(folder):
        return items
    for path in listing(folder, pattern, 200):
        if not is_file(path):
            continue
        rel = path.relative_to(folder).as_posix()
        name = rel.removesuffix(strip) if strip else rel.rsplit(".", 1)[0]
        try:
            if toml_key:
                text = str(read_toml(path).get(toml_key) or "")
            else:
                _meta, text = front_matter(read_text(path, 200_000))
        except ReadError as exc:
            items.append(error_item(source, path, exc))
            continue
        found = command_item(source, name.replace("/", "-"), text, where, ctx)
        if found:
            items.append(found)
    return items


def model_item(source: str, tool: str, model: Any, ctx: Context, *, where: str = "") -> Item | None:
    """A tool's default model: Eden Code's own default for new sessions when Eden has it, else
    a note of where to add it."""
    if not isinstance(model, str) or not model.strip():
        return None
    model = model.strip()[:120]
    ref = _eden_model(model, ctx)
    item = Item(id=f"model:{model}", kind="model", title=f"Default model: {model}",
                detail=where or f"{tool}'s default", payload={"pref": "code_model", "value": ref or ""})  # fmt: skip
    if not ref:
        item.status = "manual"
        item.why = ("Add it in Settings › Models if you want it in Eden Code; its key goes into the "
                    "Keychain there, by your hand. Eden never copies keys.")  # fmt: skip
    elif ctx.code_model == ref:
        item.status, item.why = "already", "Eden Code's new sessions use it already."
    else:
        item.why = "New Eden Code sessions start on it (you can still pick another per session)."
        item.checked = not ctx.code_model  # never over a model the owner picked in Eden
    return item


def _eden_model(model: str, ctx: Context) -> str:
    from .prefs import MODELS

    bare = model.lower().split("[", 1)[0].removeprefix("anthropic/").removeprefix("claude-code/")
    for key, mid in MODELS.items():
        if bare in (key, mid) or bare.startswith(mid):
            return key if ctx.known_model(key) else ""
    for key in MODELS:
        if bare == f"claude-{key}" or bare.startswith(f"claude-{key}-"):
            return key if ctx.known_model(key) else ""
    return model if ctx.known_model(model) else ""


def key_note(source: str, tool: str, what: str, where: Path) -> Item:
    """A key found in a tool's settings: never copied; the owner adds it themselves."""
    return Item(id=f"key:{what}:{where}", kind="model", title=f"{what} key", detail=_shown_path(where),
                status="manual",
                why=(f"{tool} keeps an API key for {what} in its settings. Eden never copies keys: add it in "
                     "Settings › Models, where it goes into the Keychain."))  # fmt: skip


def chats_item(source: str, tool: str, chats: list[dict[str, Any]], ctx: Context, *,
               resumable: bool = False, note: str = "") -> Item | None:  # fmt: skip
    """A tool's past chats as one Item: listed in Eden Code's read-only history on import."""
    if not chats:
        return None
    chats = sorted(chats, key=lambda c: c.get("when", 0), reverse=True)[:CHATS_PER_SOURCE]
    imported = ctx.imported("chats")
    new = [c for c in chats if c["id"] not in imported]
    n = len(chats)
    item = Item(id=f"chats:{source}", kind="chats", title=f"{n} past chat{'s' if n != 1 else ''} from {tool}",
                count=n, payload={"chats": new})  # fmt: skip
    projects = sorted({c.get("project_name") or "" for c in chats} - {""})
    if projects:
        item.detail = ", ".join(projects[:6]) + (
            f" and {len(projects) - 6} more" if len(projects) > 6 else ""
        )
    if not new:
        item.status, item.why = "added", "Listed in Eden Code's history from other tools already."
    else:
        item.why = note or ("Listed in Eden Code's history from other tools, to read (not to continue: "
                            f"{tool} keeps them in its own format). Nothing is copied.")  # fmt: skip
        if len(new) < n:
            item.why += f" {len(new)} new since the last import."
    return item


def chat_entry(
    cid: str, title: str, when: float, path: Path, project: str = "", **extra: Any
) -> dict[str, Any]:
    title = " ".join(str(title or "").split())[:120] or "Untitled chat"
    return {"id": cid[:200], "title": title, "when": float(when or 0), "path": str(path),
            "project": project, "project_name": Path(project).name if project else "", **extra}  # fmt: skip


def mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def text_of_content(content: Any) -> str:
    """A message's words, from a string or a list of blocks ({type: text|input_text|output_text, text})."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "\n".join(parts)
    if isinstance(content, dict) and isinstance(content.get("text"), str):
        return content["text"]
    return ""


def message(role: str, text: str) -> dict[str, str] | None:
    text = str(text or "").strip()
    if not text:
        return None
    return {"role": "user" if role in ("user", "human") else "assistant", "text": text[:CHAT_TEXT]}


def jsonl(path: Path, limit: int = 50_000_000) -> Iterable[dict[str, Any]]:
    """Each line of a JSONL file that is a JSON object (a damaged line is passed over)."""
    try:
        with open(path, "rb") as handle:
            read = 0
            for line in handle:
                read += len(line)
                if read > limit:
                    return
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                if isinstance(value, dict):
                    yield value
    except OSError:
        return


def vscode_workspaces(user: Path) -> list[Path]:
    """The folders a VS Code-style editor opened (workspaceStorage/*/workspace.json), newest first."""
    found: list[tuple[float, Path]] = []
    for meta in listing(user / "workspaceStorage", "*/workspace.json", 2000):
        try:
            path = file_uri(read_json(meta).get("folder"))
        except (ReadError, AttributeError):
            continue
        if path is not None:
            found.append((mtime(meta), path))
    found.sort(key=lambda t: -t[0])
    out: list[Path] = []
    for _t, p in found:
        if p not in out:
            out.append(p)
    return out


# ── what each import added ──


class Ledger:
    """code-import.json: per source, what its import added ({at, projects, mcp, rules,
    commands, prefs, chats}). The imported MCP servers' configs are kept here (no key: those
    are in the Keychain, by name)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.data: dict[str, Any] = {}
        try:
            loaded = jsonstore.load_store(path, STORE, dict)
        except Exception:
            log.warning("Couldn't read the import ledger", exc_info=True)
            loaded = None
        sources = loaded.get("sources") if isinstance(loaded, dict) else None
        self.data = sources if isinstance(sources, dict) else {}

    def save(self) -> None:
        jsonstore.save_store(self.path, STORE, {"sources": self.data})

    def entry(self, source: str) -> dict[str, Any]:
        entry = self.data.setdefault(source, {})
        for key, empty in (("projects", []), ("mcp", {}), ("rules", []), ("commands", []),
                           ("prefs", {}), ("chats", [])):  # fmt: skip
            if not isinstance(entry.get(key), type(empty)):
                entry[key] = type(empty)()
        return entry

    def servers(self) -> dict[str, dict[str, Any]]:
        """Every imported MCP server: name -> {spec, keys, source}."""
        out: dict[str, dict[str, Any]] = {}
        for source, entry in self.data.items():
            for name, kept in (entry.get("mcp") or {}).items() if isinstance(entry, dict) else ():
                if isinstance(kept, dict) and isinstance(kept.get("spec"), dict):
                    out[name] = {**kept, "source": source}
        return out

    def rules(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for source, entry in self.data.items():
            for rule in (entry.get("rules") or []) if isinstance(entry, dict) else ():
                if isinstance(rule, dict) and isinstance(rule.get("path"), str):
                    out.append({**rule, "source": source})
        return out

    def chats(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for source, entry in self.data.items():
            for chat in (entry.get("chats") or []) if isinstance(entry, dict) else ():
                if isinstance(chat, dict) and isinstance(chat.get("id"), str):
                    out.append({**chat, "source": source})
        out.sort(key=lambda c: c.get("when", 0), reverse=True)
        return out

    def summary(self, source: str) -> dict[str, Any]:
        entry = self.data.get(source)
        if not isinstance(entry, dict):
            return {}
        return {
            "at": entry.get("at", 0),
            "projects": len(entry.get("projects") or []),
            "mcp": len(entry.get("mcp") or {}),
            "rules": len(entry.get("rules") or []),
            "commands": len(entry.get("commands") or []),
            "prefs": len(entry.get("prefs") or {}),
            "chats": len(entry.get("chats") or []),
        }


def launch_spec(
    name: str, kept: dict[str, Any], ledger_path: Path, python: str | None = None
) -> dict[str, Any]:
    """An imported server as a session's MCP config: as it was, or, with keys in the Keychain,
    started through import_mcp_launch.py (which adds them to its environment)."""
    spec = dict(kept["spec"])
    keys = [k for k in kept.get("keys") or [] if isinstance(k, str)]
    if keys and spec.get("type") == "stdio":
        from . import import_mcp_launch

        spec = {
            "type": "stdio",
            "command": python or sys.executable,
            "args": ["-I", str(Path(import_mcp_launch.__file__).resolve()), str(ledger_path), name],
            **({"env": spec["env"]} if spec.get("env") else {}),
        }
    return spec


def now() -> float:
    return time.time()


def already(
    item_id: str, kind: str, title: str, why: str, detail: str = "", count: int = 0
) -> Item:
    """Something that already works in Eden Code, as the preview lists it."""
    return Item(
        id=item_id, kind=kind, title=title, detail=detail, status="already", why=why, count=count
    )


def note(
    item_id: str, kind: str, title: str, why: str, *, status: str = "skip", detail: str = ""
) -> Item:
    """Something that can't move (skip) or needs the owner's hand (manual), and why."""
    return Item(id=item_id, kind=kind, title=title, detail=detail, status=status, why=why)


def with_folders(ctx: Context, own: Iterable[Path]) -> Context:
    """ctx with a tool's own project folders added to those its rules are looked for in."""
    folders = list(ctx.folders)
    for path in own:
        if path not in folders and is_dir(path):
            folders.append(path)
    ctx.folders = folders[:300]
    return ctx


def agents_md_items(source: str, ctx: Context) -> list[Item]:
    """A project's AGENTS.md (Codex, OpenCode, Amp…): Eden Code reads it already when the
    project has no CLAUDE.md (features/code_agents_md); with one, it's brought over as rules."""
    items: list[Item] = []
    for folder in ctx.folders[:200]:
        path = folder / "AGENTS.md"
        if not is_file(path):
            continue
        if not is_file(folder / "CLAUDE.md"):
            items.append(already(f"rules:{path}", "rules", f"AGENTS.md: {folder.name}",
                                 "Eden Code reads a project's AGENTS.md when it has no CLAUDE.md.",
                                 detail=_shown_path(path)))  # fmt: skip
        elif found := rules_item(
            source, path, "project", ctx, project=folder, label=f"AGENTS.md: {folder.name}"
        ):
            items.append(found)
    return items


def files_rules(source: str, folder: Path, pattern: str, label: str, ctx: Context) -> list[Item]:
    """A folder of the owner's own rules files (for every project)."""
    items: list[Item] = []
    for path in listing(folder, pattern, 100):
        found = rules_item(source, path, "user", ctx, label=f"{label}: {path.name}")
        if found:
            items.append(found)
    return items


def mcp_file(source: str, path: Path, key: str | tuple[str, ...], where: str, ctx: Context,
             project: Path | None = None) -> list[Item]:  # fmt: skip
    """The MCP servers of one settings file (under key, or the first of keys that's there; a
    dotted key goes in: "mcp.servers"), or an error Item."""
    if not is_file(path):
        return []
    try:
        data = read_any(path)
    except ReadError as exc:
        return [error_item(source, path, exc)]
    servers = None
    for k in (key,) if isinstance(key, str) else key:
        value: Any = (
            data.get(k) if isinstance(data, dict) else None
        )  # ("amp.mcpServers" is one key)
        if value is None:
            value = data
            for part in k.split("."):
                value = value.get(part) if isinstance(value, dict) else None
        if value:
            servers = value
            break
    items = mcp_items(source, servers, where, ctx)
    if project is not None:
        for item in items:
            if item.payload:
                item.payload["project"] = str(project)
                item.detail += f" · for {project.name} only"
    return items


def recent_projects_xml(path: Path, home: Path) -> list[Path]:
    """JetBrains' recentProjects.xml: the projects it opened."""
    try:
        text = read_text(path)
    except ReadError:
        return []
    out: list[Path] = []
    for raw in re.findall(r'<entry key="([^"]+)"', text)[:200]:
        raw = raw.replace("$USER_HOME$", str(home))
        if raw.startswith(("/", "~")) or re.match(r"^[A-Za-z]:[\\/]", raw):
            out.append(Path(raw).expanduser())
    return out
