"""Reads outside a session's project ask first (owner decision 2026-10-10, "Ask for outside
reads"; bug sweep r3).

A read-only command (cat, head, grep, rg, find, ls, stat, file, git show…) or a Read, Glob or
Grep step runs without a card only while everything it reads is inside the session's own
folders: its project (an isolated copy's project too) and the folders the owner added
(/add-dir). Anything past them shows a card, in every mode but Bypass. Unattended runs,
with nobody to ask, refuse it.

Some places hold keys and passwords, and are asked about every time (Bypass with its Touch
ID proof aside), whatever a rule or "don't ask again" says: ~/.ssh, ~/.aws, ~/.config/gcloud,
~/.netrc, ~/.pgpass, ~/.docker/config.json and the like, the Keychains (and `security`
reading them), browser profiles, a .env file outside the project, and `ps` showing other
programs' environments (ps eww, ps -E).

Paths are compared as the Mac sees them: ~ and ~user expanded, relative to the project,
.. and links followed (resolve), /System/Volumes/Data (the firmlink) dropped, and case
ignored (APFS). A glob that could climb out (.*, a leading / or ~) counts as outside.

Cost policy (Claude): this never calls a model.
"""

from __future__ import annotations

import contextlib
import functools
import re
import shlex
from collections.abc import Iterable
from pathlib import Path
from typing import Any

OUTSIDE, SECRET = "outside", "secret"

# Under the home folder: places that hold keys, tokens and passwords.
SECRET_HOME = (
    ".ssh", ".aws", ".config/gcloud", ".netrc", "_netrc", ".pgpass", ".docker/config.json",
    ".gnupg", ".git-credentials", ".kube/config", ".azure", ".config/gh/hosts.yml",
    ".npmrc", ".pypirc", "Library/Keychains", "Library/Cookies", "Library/Safari",
    "Library/Application Support/Google/Chrome", "Library/Application Support/Chromium",
    "Library/Application Support/BraveSoftware", "Library/Application Support/Firefox",
    "Library/Application Support/Microsoft Edge", "Library/Application Support/Arc",
    "Library/Application Support/com.operasoftware.Opera", "Library/Application Support/Vivaldi",
    "Library/Containers/com.apple.Safari",
)  # fmt: skip
SECRET_ABSOLUTE = ("/Library/Keychains", "/private/etc/master.passwd", "/etc/master.passwd")
# Programs that print and read no file (a word given to them is only text).
NO_FILES = frozenset(
    {
        "echo", "which", "type", "date", "pwd", "whoami", "uname", "sw_vers", "id", "uptime",
        "true", "hostname", "basename", "dirname", "tr", "df", "npm", "node", "python",
        "python3", "pip", "pip3", "ruby", "go", "cargo", "rustc", "swift", "java", "uv", "bun",
        "deno",
    }
)  # fmt: skip
# Programs whose first word that isn't an option is a pattern or a filter, not a file
# (unless it's given with -e / -f).
PATTERN_FIRST = frozenset({"grep", "egrep", "fgrep", "rg", "ag", "jq"})
_PATTERN_OPTS = ("-e", "--regexp", "-f", "--file", "--from-file")
_RECURSIVE = frozenset({"rg", "ag"})  # (grep only with -r/-R/--recursive)
_GLOB = re.compile(r"[*?\[]")
_FIRMLINK = "/system/volumes/data/"
_SECURITY_READS = re.compile(
    r"\bsecurity\s+(?:\S+\s+)*?(dump-keychain|find-(?:generic|internet)-password|export)\b"
)
_PS_ENV = re.compile(r"(^|\|)\s*ps\b([^|]*)")


def _norm(path: Path | str) -> str:
    """A path as compared: firmlink dropped, case ignored."""
    text = str(path).replace("\\", "/").casefold().rstrip("/") or "/"
    if text.startswith(_FIRMLINK):
        text = text[len(_FIRMLINK) - 1 :]
    return text


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def resolve(raw: str, cwd: Path) -> Path | None:
    """Where a word naming a file leads (~ expanded, relative to cwd, links and .. followed)."""
    try:
        path = Path(raw).expanduser()
        return (path if path.is_absolute() else cwd / path).resolve()
    except (OSError, RuntimeError, ValueError):
        return None


def secret_roots() -> list[str]:
    """The secret places as compared (worked out once per home folder)."""
    return list(_secret_roots(str(Path.home())))


@functools.lru_cache(maxsize=4)
def _secret_roots(home_text: str) -> tuple[str, ...]:
    home = Path(home_text)
    out = []
    for rel in SECRET_HOME:
        out.append(_norm(home / rel))
        with contextlib.suppress(OSError, RuntimeError):
            out.append(_norm((home / rel).resolve()))
    out += [_norm(p) for p in SECRET_ABSOLUTE]
    return tuple(dict.fromkeys(out))


def roots_of(folders: Iterable[Path | str]) -> list[str]:
    """The session's own folders as compared (each spelled as given and resolved)."""
    out = []
    for folder in folders:
        if not folder:
            continue
        out.append(_norm(Path(folder).expanduser()))
        with contextlib.suppress(OSError, RuntimeError):
            out.append(_norm(Path(folder).expanduser().resolve()))
    return list(dict.fromkeys(out))


def _fixed_start(word: str) -> str:
    """A glob's part before its first wildcard, cut back to a whole folder name."""
    head = _GLOB.split(word, maxsplit=1)[0]
    return head[: head.rfind("/") + 1] if "/" in head else ""


def _glob_climbs(word: str) -> bool:
    """A glob that could match .. or start outside the project (.*, [.]x, /…, ~…)."""
    if word.startswith(("/", "~")):
        return True
    return any(p[:1] in (".", "[") and _GLOB.search(p) for p in word.split("/"))


def where(raw: str, cwd: Path, roots: list[str], recursive: bool = False) -> str | None:
    """SECRET, OUTSIDE or None (inside the session's folders) for one word naming a file."""
    if not raw or raw == "-":
        return None
    globbed = bool(_GLOB.search(raw))
    target = resolve(_fixed_start(raw) or "." if globbed else raw, cwd)
    if target is None:
        return OUTSIDE
    text = _norm(target)
    secrets = secret_roots()
    if any(_under(text, s) for s in secrets):
        return SECRET
    if (globbed or recursive) and any(_under(s, text) for s in secrets):
        return SECRET  # a search or a glob over a folder that holds one
    inside = any(_under(text, r) for r in roots)
    name = target.name.casefold()
    if not inside and name.startswith(".env"):
        return SECRET  # a .env file outside the project
    if not inside or (globbed and _glob_climbs(raw)):
        return OUTSIDE
    return None


def _worst(found: Iterable[str | None]) -> str | None:
    found = set(found)
    return SECRET if SECRET in found else OUTSIDE if OUTSIDE in found else None


def ps_shows_environment(args: list[str]) -> bool:
    """ps with another program's environment: BSD-style "e" (ps eww, ps auxe) or -E."""
    for arg in args:
        if arg.startswith("-"):
            if not arg.startswith("--") and "E" in arg[1:]:
                return True
        elif arg.isalpha() and "e" in arg:
            return True
    return False


def _segment_words(command: str) -> list[list[str]]:
    out = []
    for segment in command.split("|"):
        try:
            words = shlex.split(segment)
        except ValueError:
            return []
        if words:
            out.append(words)
    return out


def _file_words(program: str, args: list[str]) -> list[str]:
    """The words of a read-only command that may name a file it reads."""
    if program in NO_FILES or program == "ps":
        return []
    if program == "git":  # refs and options aside: a path, an absolute or a climbing one
        return [a for a in args[1:] if not a.startswith("-") and (a[:1] in "/~" or ".." in a)]
    words: list[str] = []
    if program == "find":  # its starting folders, before the expression
        for arg in args:
            if arg.startswith(("-", "(", "!")):
                break
            words.append(arg)
        return words or ["."]
    skip_pattern = program in PATTERN_FIRST and not any(
        a.split("=", 1)[0] in _PATTERN_OPTS or (a[:2] in ("-e", "-f") and not a.startswith("--"))
        for a in args
    )
    take_next, operands, last_opt = False, False, ""
    for arg in args:
        if take_next:  # -f FILE (grep, rg, jq): a file; -e PATTERN: text
            take_next = False
            if last_opt in ("-f", "--file", "--from-file"):
                words.append(arg)
            continue
        if arg == "--" and not operands:
            operands = True
            continue
        if arg.startswith("-") and arg != "-" and not operands:
            last_opt = arg
            if "=" in arg:
                words.append(arg.split("=", 1)[1])  # --file=x, --ignore-file=x
            elif program in PATTERN_FIRST and arg in _PATTERN_OPTS:
                take_next = True
            elif len(arg) > 2 and not arg.startswith("--") and ("/" in arg or "~" in arg):
                words.append(arg[2:])  # -f/path
            continue
        if skip_pattern:
            skip_pattern = False
            continue
        words.append(arg)
    if not words and program in ("ls", "du", "tree", "rg", "ag", "stat"):
        return ["."]
    return words


def command_reach(command: str, cwd: Path, roots: list[str]) -> str | None:
    """SECRET, OUTSIDE or None for a read-only shell command (tasks.is_read_only): what the
    files it names reach, and ps showing environments."""
    found: list[str | None] = []
    for words in _segment_words(command):
        program, args = words[0], words[1:]
        if program == "ps" and ps_shows_environment(args):
            return SECRET
        recursive = program in _RECURSIVE or (
            program in ("grep", "egrep", "fgrep")
            and any(
                a in ("-r", "-R", "--recursive", "--dereference-recursive")
                or (a.startswith("-") and not a.startswith("--") and set(a[1:]) & {"r", "R"})
                for a in args
            )
        )
        found += [where(w, cwd, roots, recursive) for w in _file_words(program, args)]
    return _worst(found)


def tool_reach(paths: list[str], cwd: Path, roots: list[str], search: bool) -> str | None:
    """SECRET, OUTSIDE or None for a Read, Glob or Grep step's paths."""
    return _worst(where(p or ".", cwd, roots, search) for p in paths)


def secret_command(command: str, cwd: Path) -> bool:
    """Whether any shell command (read-only or not) names a secret place, reads the
    Keychain, or shows other programs' environments: asked every time."""
    if _SECURITY_READS.search(command):
        return True
    text = command.replace("\\ ", " ").casefold()
    home = Path.home().as_posix().casefold()
    for rel in SECRET_HOME:  # (named inside a string too: open("~/.ssh/id_rsa"))
        rel = rel.casefold()
        if any(f"{start}/{rel}" in text for start in ("~", "$home", "${home}", home)):
            return True
    for match in _PS_ENV.finditer(command):
        with contextlib.suppress(ValueError):
            if ps_shows_environment(shlex.split(match.group(2))):
                return True
    try:
        words = shlex.split(command)
    except ValueError:
        words = command.split()
    secrets = secret_roots()
    for word in words[:200]:
        for part in [word, *word.split("=", 1)[1:]]:
            if not part or part.startswith("-") or len(part) > 1024:
                continue
            raw = part.replace("$HOME", "~").replace("${HOME}", "~")
            if "$" in raw:
                continue
            target = resolve(_fixed_start(raw) or "." if _GLOB.search(raw) else raw, cwd)
            if target is None:
                continue
            text = _norm(target)
            if any(_under(text, s) for s in secrets):
                return True
    return False


def step_reach(tool_name: str, tool_input: dict[str, Any], paths: list[str], cwd: Path,
               roots: list[str], read_tools: set[str]) -> str | None:  # fmt: skip
    """SECRET for a step that names a secret place (any tool that reads, or a command),
    else None. (Outside-but-not-secret is the caller's: command_reach / tool_reach.)"""
    if tool_name == "Bash":
        command = str(tool_input.get("command") or "")
        if command and (
            secret_command(command, cwd) or command_reach(command, cwd, roots) == SECRET
        ):
            return SECRET
        return None
    if tool_name in read_tools:
        found = tool_reach(paths, cwd, roots, tool_name in ("Grep", "Glob"))
        return SECRET if found == SECRET else None
    return None
