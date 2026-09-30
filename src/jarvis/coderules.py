"""Jarvis Code's permission rules: allow, ask or deny a session's tool call by web domain,
MCP server or tool, file path or command, per project, in Claude Code's own rule syntax (so
they import from and export to a project's .claude settings). Deny beats ask, ask beats
allow, as in Claude Code; a deny or an ask holds in every permission mode, Bypass included.

The rules, as Claude Code writes them:
  WebFetch(domain:example.com)  pages on example.com or any of its subdomains
  mcp__github                   every tool of the github MCP server (mcp__github__* too)
  mcp__github__create_issue     one tool of it
  Read(src/**)                  reading (Read, Grep, Glob, LS, NotebookRead) there
  Edit(//etc/hosts)             editing (Edit, MultiEdit, Write, NotebookEdit) there
  Bash(git push:*)              commands starting "git push" (Bash(npm test): just that)
  WebFetch, Bash, WebSearch…    every call of that tool (Read and Edit: of their family)

Paths, as in Claude Code: "//x" is the absolute path /x, "~/x" is in the home folder, "/x"
and "x/y" are the project's, and a name with no "/" in it ("*.pem", ".env") is that name
in any folder. "*" stays within a folder, "**" goes into folders below; a path with no
wildcard stands for itself and everything in it.

A rule matches strictly when it would let something through and generously when it would
stop something, so an allow never lets more by than it says and a deny or an ask catches
what it names:
- a command: an allow needs a plain command (tasks.command_key: never one chained, piped,
  redirected, substituted or run through a shell or sudo) whose words start with the
  rule's; a deny or an ask looks into every part of a command (split at ; && || | & and
  line ends, inside $(…) and `…`, bash -c "…" and eval) for the rule's program, as the
  part's first word or anywhere after a program that runs another (sudo -u root …, env,
  xargs, timeout, find … -exec: their options may take values), followed by the rule's
  other words, in order;
- a path: the one a call names, symlinks followed (a search's folder, as Claude Code
  takes it: the rule covers the search when it covers what's in that folder);
- a web page: its host, lower case.
"""

from __future__ import annotations

import functools
import json
import logging
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from . import jsonstore

log = logging.getLogger("jarvis")

BEHAVIORS = ("deny", "ask", "allow")  # the order they're weighed in
READ_FAMILY = {"Read", "Grep", "Glob", "LS", "NotebookRead"}
EDIT_FAMILY = {"Edit", "MultiEdit", "Write", "NotebookEdit"}
SEARCHES = {"Grep", "Glob", "LS"}  # tools whose path is a folder they look through
RULES_PER_PROJECT = 300
RULE_CHARS = 500
PROJECTS_KEPT = 500
# Programs that run the rest of their words as a command (a deny looks past them).
_WRAPPERS = {
    "sudo", "doas", "env", "nohup", "time", "command", "builtin", "exec", "nice", "xargs",
    "stdbuf", "caffeinate", "watch", "timeout", "gtimeout",
}  # fmt: skip
_SHELLS = {"bash", "sh", "zsh", "fish", "dash", "ksh"}
_SUBSTITUTED = re.compile(r"\$\(([^()]*)\)|`([^`]*)`")
_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_TOOL = re.compile(r"^(?:mcp__[\w.\-]+(?:__[\w.\-*]+)?|[A-Z][A-Za-z0-9]{1,40})$")
_DOMAIN = re.compile(
    r"^(?:\*\.)?[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)*$"
)


class RuleError(ValueError):
    """Why a rule can't be used, in words for the owner."""


@dataclass(frozen=True)
class Rule:
    tool: str  # "Bash", "WebFetch", "Read", "mcp__github", "mcp__github__create_issue"…
    content: str | None = None  # what's in the brackets, None for the whole tool

    @property
    def text(self) -> str:
        return self.tool if self.content is None else f"{self.tool}({self.content})"


def parse(text: str) -> Rule:
    """A rule as Claude Code writes it; RuleError says what's wrong with one that isn't."""
    raw = str(text or "").strip()
    if not raw:
        raise RuleError("A rule can't be empty.")
    if len(raw) > RULE_CHARS:
        raise RuleError("That rule is too long.")
    match = re.fullmatch(r"([^()\s]+)(?:\((.*)\))?", raw, re.S)
    if not match:
        raise RuleError(
            f"“{raw}” isn't a rule: write it as Tool or Tool(what), like WebFetch(domain:example.com)."
        )
    tool, content = match.group(1), match.group(2)
    if not _TOOL.match(tool):
        raise RuleError(f"“{tool}” isn't a tool name.")
    if tool.startswith("mcp__"):
        if content is not None:
            raise RuleError("An MCP rule names a server or a tool, with nothing in brackets.")
        if tool.endswith("__*"):
            tool = tool[:-3]  # mcp__github__* is every tool of github: mcp__github
        return Rule(tool)
    if content is None:
        return Rule(tool)
    content = content.strip()
    if not content or content == "*":
        return Rule(tool)  # Bash(*), Read(*): the whole tool
    if tool == "WebFetch":
        if not content.startswith("domain:"):
            raise RuleError("A WebFetch rule names a domain: WebFetch(domain:example.com).")
        domain = content[len("domain:") :].strip().lower().rstrip(".")
        if not _DOMAIN.match(domain):
            raise RuleError(f"“{domain}” isn't a domain.")
        return Rule(tool, f"domain:{domain}")
    if tool == "Bash":
        if "\n" in content:
            raise RuleError("A command rule is one line.")
        return Rule(tool, content)
    if tool in READ_FAMILY or tool in EDIT_FAMILY:
        if "\x00" in content:
            raise RuleError("That isn't a path.")
        return Rule(tool, content)
    raise RuleError(f"{tool} rules name the whole tool: write just {tool}.")


@functools.lru_cache(maxsize=4096)
def valid(text: str) -> Rule | None:
    """The rule, or None when it isn't one (parsed once per text)."""
    try:
        return parse(text)
    except RuleError:
        return None


# ── matching ──


def _family(tool: str) -> set[str]:
    if tool == "Read":
        return READ_FAMILY
    if tool in ("Edit", "Write"):
        return EDIT_FAMILY
    return {tool}


def _glob_regex(pattern: str) -> re.Pattern[str]:
    """A path pattern ("*" in a folder, "**" across folders, "?" one character) as a regex
    over absolute paths; a pattern without a wildcard stands for itself and what's in it."""
    out, i = [], 0
    wild = any(c in pattern for c in "*?[")
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    body = "".join(out)
    return re.compile(body + ("" if wild else "(?:/.*)?"), re.S)


@functools.lru_cache(maxsize=1024)
def _pattern(content: str, cwd: str, home: str) -> re.Pattern[str]:
    """A path rule's pattern as a regex over absolute paths (its fixed folder resolved:
    /etc is /private/etc on a Mac, as the paths it's matched against are)."""
    text = content.strip()
    if "/" not in text.rstrip("/"):  # a name, in any folder
        name = _glob_regex(text.rstrip("/")).pattern.removesuffix("(?:/.*)?")
        return re.compile(r"(?:.*/)?" + name + r"(?:/.*)?", re.S)
    if text.startswith("//"):
        full = "/" + text.lstrip("/")
    elif text.startswith("~/"):
        full = home + "/" + text[2:]
    elif text.startswith("/"):
        full = cwd + text
    else:
        full = cwd + "/" + text.removeprefix("./")
    full = re.sub(r"/+", "/", full).rstrip("/") or "/"
    wild = any(c in full for c in "*?[")
    head = re.split(r"[*?\[]", full, maxsplit=1)[0].rsplit("/", 1)[0] if wild else full
    try:
        real = str(Path(head or "/").resolve())
    except (OSError, RuntimeError):
        real = head
    return _glob_regex(real.rstrip("/") + full[len(head) :] if head else full)


def _real(raw: str, cwd: Path) -> str:
    path = Path(raw).expanduser() if raw else cwd
    path = path if path.is_absolute() else cwd / path
    try:
        return str(path.resolve())
    except (OSError, RuntimeError):
        return str(path)


def _paths(tool: str, tool_input: dict[str, Any], cwd: Path) -> list[str]:
    keys = ("file_path", "path", "notebook_path")
    raw = [str(tool_input[k]) for k in keys if tool_input.get(k)]
    pattern = str(tool_input.get("pattern") or "") if tool == "Glob" else ""
    if pattern.startswith(("/", "~")) or ".." in pattern.split("/"):
        raw.append(re.split(r"[*?\[{]", pattern, maxsplit=1)[0] or "/")  # its fixed start
    if not raw and tool in SEARCHES:
        raw = [""]  # a search with no path looks through the project
    return [_real(r, cwd) for r in raw]


def _path_rule(
    rule: Rule, behavior: str, tool: str, tool_input: dict[str, Any], cwd: Path, home: Path
) -> bool:
    paths = _paths(tool, tool_input, cwd)
    if not paths:
        return behavior != "allow"  # nothing to go by: a deny or an ask holds, an allow doesn't
    regex = _pattern(rule.content or "", str(cwd.resolve()), str(home))

    def hit(path: str) -> bool:
        if regex.fullmatch(path):
            return True
        # A search reads what's in its folder: the rule covers it when it covers that.
        return tool in SEARCHES and bool(regex.fullmatch(path.rstrip("/") + "/x"))

    return all(map(hit, paths)) if behavior == "allow" else any(map(hit, paths))


def _host(url: str) -> str:
    try:
        return (urlparse(str(url).strip()).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def _domain_rule(rule: Rule, tool_input: dict[str, Any]) -> bool:
    domain = (rule.content or "")[len("domain:") :].removeprefix("*.")
    host = _host(tool_input.get("url", ""))
    return bool(host) and (host == domain or host.endswith("." + domain))


def _rule_words(content: str) -> tuple[list[str], bool]:
    """A command rule's words, and whether it's a prefix ("git push:*", "npm run *")."""
    text = content.strip()
    prefix = False
    for tail in (":*", " *", "*"):
        if text.endswith(tail):
            text, prefix = text[: -len(tail)].rstrip(), True
            break
    try:
        words = shlex.split(text)
    except ValueError:
        words = text.split()
    return words, prefix


def _words(text: str) -> list[str]:
    try:
        return shlex.split(text)
    except ValueError:
        return text.replace('"', " ").replace("'", " ").split()


def _segments(command: str) -> list[str]:
    """A command line split where the shell splits it into commands (; & | && || and line
    ends, plus the ( ) that open and close a subshell), never inside quotes; a backslash
    before a line end continues the line. Splitting on the grouping parens means a command
    the owner denied can't hide from the rule inside a subshell, ( (git push) ), a process
    substitution, cat <(git push), or a shell construct like if git push; then …."""
    out: list[str] = []
    part: list[str] = []
    quote = ""
    text = command.replace("\\\n", "")
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "\\" and quote != "'" and i + 1 < n:
            part.append(text[i : i + 2])  # (an escaped character is never a split)
            i += 2
            continue
        if quote:
            quote = "" if c == quote else quote
        elif c in "'\"":
            quote = c
        elif c in ";&|\n()":
            out.append("".join(part))
            part = []
            i += 1
            continue
        part.append(c)
        i += 1
    out.append("".join(part))
    return [p for p in out if p.strip()]


# Shell words that stand in front of a command without being one (control flow, negation,
# a pipeline's timing keyword): a deny rule looks past them to the command they introduce.
_RESERVED = {
    "if", "then", "elif", "else", "fi", "while", "until", "for", "select", "do", "done",
    "case", "esac", "function", "!", "{", "}", "in", "time", "coproc",
}  # fmt: skip


def _program(word: str) -> str:
    return word.rsplit("/", 1)[-1]


def starts(words: list[str]) -> list[int]:
    """Where in a simple command's words a command may start: its first word, and after a
    program that runs another (sudo, env, xargs, timeout…) each later word that isn't an
    option (its options may take values: sudo -u root, nice -n 5), or find's -exec."""
    found = [0]
    program = _program(words[0])
    if program in _WRAPPERS:
        found += [
            i
            for i in range(1, len(words))
            if not words[i].startswith("-") and not _ASSIGNMENT.match(words[i])
        ]
    elif program == "find":
        found += [
            i + 1
            for i, word in enumerate(words[:-1])
            if word in ("-exec", "-execdir", "-ok", "-okdir")
        ]
    return found


def command_parts(command: str, depth: int = 0) -> list[list[str]]:
    """Every simple command in a command line, as words (leading VAR=value assignments
    left out): the parts it's chained, piped and backgrounded into, what $(…) and `…` run,
    and what a shell runs (bash -c "…", eval …) wherever it starts in a part (starts). A
    wrapper's command (sudo -u root git push) stays in its wrapper's words."""
    if depth > 4:
        return []
    parts: list[list[str]] = []
    for inner in _SUBSTITUTED.finditer(command):
        parts += command_parts(inner.group(1) or inner.group(2) or "", depth + 1)
    for segment in _segments(_SUBSTITUTED.sub(" ", command)):
        words = _words(segment.strip().lstrip("({").rstrip(")}").strip())
        while words and (_ASSIGNMENT.match(words[0]) or words[0] in _RESERVED):
            words = words[1:]  # leading VAR=value, and if/for/while/! and the like
        if not words:
            continue
        parts.append(words)
        read: set[int] = set()  # (each command string once, however it's reached)
        for at in starts(words):
            program = _program(words[at])
            if program == "eval" and at + 1 < len(words) and at + 1 not in read:
                read.add(at + 1)
                parts += command_parts(" ".join(words[at + 1 :]), depth + 1)
            elif program in _SHELLS and "-c" in words[at + 1 :]:
                string = words.index("-c", at + 1) + 1
                if string < len(words) and string not in read:
                    read.add(string)
                    parts += command_parts(words[string], depth + 1)
    return parts


def _command_rule(rule: Rule, behavior: str, command: str, cwd: Path) -> bool:
    if rule.content is None:
        return True
    want, prefix = _rule_words(rule.content)
    if not want:
        return True
    if behavior == "allow":
        from .tasks import command_key  # (tasks imports this module's users, never this)

        if command_key(command, cwd) is None:
            return False  # chained, piped, wrapped or pointed elsewhere: never by a rule
        words = _words(re.sub(r"^\s*cd\s+\S+\s*&&\s*", "", command))
        while words and _ASSIGNMENT.match(words[0]):
            words = words[1:]
        return words[: len(want)] == want if prefix else words == want
    program, need = _program(want[0]), want[1:]
    for words in command_parts(command):
        # The earliest place the rule's program starts a command: the words after it hold
        # those after any later one, so it's the one to look in.
        at = next((i for i in starts(words) if _program(words[i]) == program), None)
        if at is None:
            continue
        rest = iter(words[at + 1 :])
        if all(any(w == n for w in rest) for n in need):  # its other words, in order
            return True
    return False


def matches(
    rule: Rule, behavior: str, tool: str, tool_input: dict[str, Any], cwd: Path, home: Path
) -> bool:
    """Whether a rule covers a call (strictly for an allow, generously otherwise)."""
    if rule.tool.startswith("mcp__"):
        return tool == rule.tool or tool.startswith(rule.tool + "__")
    if tool not in _family(rule.tool):
        return False
    if rule.content is None:
        return True
    if rule.tool == "WebFetch":
        return _domain_rule(rule, tool_input)
    if rule.tool == "Bash":
        return _command_rule(rule, behavior, str(tool_input.get("command") or ""), cwd)
    return _path_rule(rule, behavior, tool, tool_input, cwd, home)


def decide(
    rules: dict[str, list[str]],
    tool: str,
    tool_input: dict[str, Any],
    cwd: Path,
    home: Path | None = None,
) -> tuple[str, str] | None:
    """(behavior, rule) for the first rule that covers a call, deny first, then ask, then
    allow; None when none does. A rule that can't be read covers nothing."""
    home = home or Path.home()
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    for behavior in BEHAVIORS:
        for text in rules.get(behavior, ()):
            rule = valid(text)
            if rule is not None and matches(rule, behavior, tool, tool_input, cwd, home):
                return behavior, rule.text
    return None


# ── Claude Code's own settings files ──

CLAUDE_FILES = {"project": "settings.json", "local": "settings.local.json"}


def read_claude(project: Path) -> dict[str, dict[str, list[str]]]:
    """The permission rules in a project's .claude settings files, by file ("settings.json",
    "settings.local.json"): {behavior: [rule text]}; a file that isn't there or can't be
    read has none."""
    out: dict[str, dict[str, list[str]]] = {}
    for name in CLAUDE_FILES.values():
        path = project / ".claude" / name
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            continue
        permissions = data.get("permissions") if isinstance(data, dict) else None
        if not isinstance(permissions, dict):
            continue
        found = {
            b: [str(r) for r in permissions.get(b) or [] if isinstance(r, str) and r.strip()][
                :RULES_PER_PROJECT
            ]
            for b in BEHAVIORS
            if isinstance(permissions.get(b), list)
        }
        if any(found.values()):
            out[name] = found
    return out


def write_claude(project: Path, target: str, rules: dict[str, list[str]]) -> int:
    """Add rules to one of a project's .claude settings files (target "local": its
    settings.local.json, "project": its settings.json), keeping everything already there;
    how many were new. A file that isn't JSON is left alone (OSError says so)."""
    name = CLAUDE_FILES.get(target)
    if name is None:
        raise ValueError("That isn't a settings file.")
    path = project / ".claude" / name
    data: dict[str, Any] = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            raise OSError(f"{name} can't be read, so nothing was written to it.") from exc
        if not isinstance(data, dict):
            raise OSError(f"{name} isn't a settings object, so nothing was written to it.")
    permissions = data.get("permissions")
    if permissions is None:
        permissions = data["permissions"] = {}
    if not isinstance(permissions, dict):
        raise OSError(
            f"{name} has permissions of a kind this can't add to, so nothing was written."
        )
    added = 0
    for behavior in BEHAVIORS:
        new = [r for r in rules.get(behavior, []) if valid(r) is not None]
        if not new:
            continue
        have = permissions.get(behavior)
        have = have if isinstance(have, list) else []
        for rule in new:
            if rule not in have:
                have.append(rule)
                added += 1
        permissions[behavior] = have
    if added:
        path.parent.mkdir(parents=True, exist_ok=True)
        jsonstore.save_json(path, data, mode=0o644, backup=False)
    return added


# ── JARVIS's own rules, per project ──


class RuleBook:
    """The owner's rules per project folder, in code_rules.json (path None: in memory).
    Read defensively: a rule that can't be read is left out, and the rest still hold."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self.projects: dict[str, dict[str, list[str]]] = {}
        self.unreadable = ""
        if path is None:
            return
        try:
            data = jsonstore.load_json(path, dict) or {}
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            log.warning("Jarvis Code rules: %s can't be read (%s)", path.name, exc)
            return
        projects = data.get("projects")
        for project, rules in list(projects.items() if isinstance(projects, dict) else [])[
            :PROJECTS_KEPT
        ]:
            if not isinstance(project, str) or not isinstance(rules, dict):
                continue
            kept = {
                b: list(
                    dict.fromkeys(r for r in rules.get(b) or [] if isinstance(r, str) and valid(r))
                )[:RULES_PER_PROJECT]
                for b in BEHAVIORS
                if isinstance(rules.get(b), list)
            }
            self.projects[project] = {b: kept.get(b, []) for b in BEHAVIORS}

    def rules(self, project: str) -> dict[str, list[str]]:
        found = self.projects.get(project) or {}
        return {b: list(found.get(b, [])) for b in BEHAVIORS}

    def add(self, project: str, behavior: str, text: str) -> str:
        """Add a rule (RuleError when it isn't one): its text as kept."""
        if behavior not in BEHAVIORS:
            raise RuleError("A rule allows, asks or denies.")
        rule = parse(text).text
        rules = self.projects.setdefault(project, {b: [] for b in BEHAVIORS})
        for other in BEHAVIORS:
            if other != behavior and rule in rules[other]:
                rules[other].remove(rule)  # one behavior per rule: the latest said
        if rule not in rules[behavior]:
            if len(rules[behavior]) >= RULES_PER_PROJECT:
                raise RuleError("That's as many rules of that kind as a project can have.")
            rules[behavior].append(rule)
        self.save()
        return rule

    def remove(self, project: str, behavior: str, text: str) -> bool:
        rules = self.projects.get(project)
        if not rules or text not in rules.get(behavior, []):
            return False
        rules[behavior].remove(text)
        if not any(rules.values()):
            del self.projects[project]
        self.save()
        return True

    def save(self) -> None:
        if self.path is None:
            return
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, {"projects": self.projects})
