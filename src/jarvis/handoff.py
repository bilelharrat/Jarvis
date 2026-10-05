"""Hand-off: a Jarvis Code session continued on another machine the owner controls, over SSH.

The machines are hosts in the owner's own ~/.ssh/config, named by their alias. JARVIS runs
the owner's ssh with BatchMode (never a password or host-key prompt nobody can see), so the
owner's own config and agent decide how it gets in; JARVIS keeps no keys, only the alias.

On the remote, everything lives under ~/.jarvis-handoff/<id>/ (made with umask 077):

    repo/          the checkout, on the session's branch
    run.sh         the runner: Claude Code reads inbox.jsonl as it grows, writes out.jsonl
    inbox.jsonl    what JARVIS sends (stream-json: the owner's messages, permission answers)
    out.jsonl      what Claude Code says (stream-json), read back over SSH from any line
    claude.pid     the running CLI;  exit.code  how it ended (absent while it runs)

The runner runs under tmux when the remote has it, else nohup, so a dropped connection
never stops it: JARVIS reattaches by reading out.jsonl again from the line it had reached.
The transcript itself can't move; the remote session starts from a summary of this one.

Everything here is plain text and processes: no model calls, nothing billed by JARVIS.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import shlex
import shutil
import time
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

from .packaged import owner_env

ROOT = ".jarvis-handoff"  # under the remote's home
SSH_OPTIONS = (
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-T",
)  # fmt: skip
ALIAS = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
MODEL = re.compile(r"^[A-Za-z0-9._\[\]-]{1,80}$")
SESSION = re.compile(r"^[A-Za-z0-9-]{1,80}$")
CHECK_SECONDS = 25.0
SETUP_SECONDS = 600.0  # a first fetch of a big repository takes a while
WRITE_SECONDS = 30.0
MACHINES_MAX = 20
# Where Claude Code's installer puts the CLI, for a non-interactive shell whose PATH lacks it.
CLAUDE_PLACES = (
    "$HOME/.local/bin/claude", "$HOME/.claude/local/claude", "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
)  # fmt: skip
# The remote's permission modes: Bypass never goes to another machine.
REMOTE_MODES = {"plan": "plan", "ask": "default", "edits": "acceptEdits"}
MODE_NAMES = {"plan": "Plan", "default": "Manual", "acceptEdits": "Accept edits"}
SUMMARY_MAX = 7000


def ssh_binary() -> str:
    return shutil.which("ssh") or "/usr/bin/ssh"


# ── the owner's SSH config ──


def config_hosts(path: Path, _seen: set[Path] | None = None) -> list[str]:
    """The concrete Host aliases in an ssh config (and the files it Includes), in order;
    patterns (*, ?, !) aren't machines."""
    seen = _seen if _seen is not None else set()
    try:
        path = path.expanduser().resolve()
        if path in seen or not path.is_file():
            return []
        seen.add(path)
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    found: list[str] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        key, _, rest = line.replace("=", " ", 1).partition(" ")
        key = key.lower()
        if key == "host":
            found += [h for h in rest.split() if ALIAS.match(h) and not re.search(r"[*?!]", h)]
        elif key == "include":
            for pattern in rest.split():
                base = Path(pattern).expanduser()
                if not base.is_absolute():
                    base = path.parent / base
                for match in sorted(base.parent.glob(base.name)):
                    found += config_hosts(match, seen)
    return list(dict.fromkeys(found))


# ── running ssh ──


@dataclass
class Done:
    code: int
    out: bytes
    err: str

    @property
    def ok(self) -> bool:
        return self.code == 0

    @property
    def text(self) -> str:
        return self.out.decode("utf-8", "replace")


def remote_command(script: str) -> str:
    """A POSIX sh script as one remote command, whatever the owner's login shell is."""
    return "sh -c " + shlex.quote(script)


def ssh_argv(ssh: str, alias: str, script: str) -> list[str]:
    if not ALIAS.match(alias):
        raise ValueError(f"not a host alias: {alias!r}")
    return [ssh, *SSH_OPTIONS, alias, remote_command(script)]


def _env() -> dict[str, str]:
    return owner_env(os.environ) | {"LC_ALL": "C"}


async def run(
    ssh: str, alias: str, script: str, stdin: bytes | Path | None = None, timeout: float = 60.0
) -> Done:
    """A script on the remote; its output, exit code and stderr. Never raises: a missing
    ssh, a timeout or a dropped connection come back as a failure (255: ssh's own)."""
    source: Any = asyncio.subprocess.DEVNULL
    handle = None
    if isinstance(stdin, Path):
        handle = stdin.open("rb")
        source = handle
    elif stdin is not None:
        source = asyncio.subprocess.PIPE
    try:
        proc = await asyncio.create_subprocess_exec(
            *ssh_argv(ssh, alias, script),
            stdin=source,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_env(),
        )
    except OSError as exc:
        if handle is not None:
            handle.close()
        return Done(127, b"", str(exc))
    try:
        out, err = await asyncio.wait_for(
            proc.communicate(stdin if isinstance(stdin, bytes) else None), timeout
        )
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        with contextlib.suppress(Exception):
            await proc.wait()
        return Done(124, b"", f"no answer from {alias} in {timeout:.0f} s")
    finally:
        if handle is not None:
            handle.close()
    return Done(proc.returncode or 0, out, err.decode("utf-8", "replace").strip()[-800:])


def ssh_problem(alias: str, done: Done) -> str:
    """Why ssh couldn't get in, in the owner's words."""
    err = done.err
    if done.code == 127:
        return "ssh isn't available on this Mac."
    if done.code == 124:
        return f"{alias} didn't answer in time."
    if "Could not resolve hostname" in err or "Name or service not known" in err:
        return f"{alias} can't be found: check its HostName in your SSH config."
    if "Permission denied" in err:
        return f"{alias} refused the key: add it to your SSH agent (ssh-add) and try again."
    if "Host key verification failed" in err:
        return f"{alias}'s host key isn't known yet: connect to it once from Terminal to accept it."
    if "timed out" in err or "Connection refused" in err or "No route to host" in err:
        return f"{alias} isn't reachable right now."
    return f"Couldn't reach {alias}: {err[-200:] or 'ssh failed'}"


# ── checking a machine ──

PROBE = (
    "printf 'jarvis-probe\\n'; "
    "if command -v git >/dev/null 2>&1; then printf 'git: %s\\n' \"$(git --version)\"; fi; "
    "c=$(command -v claude 2>/dev/null); "
    # Each place quoted: a home with a space in it would otherwise split into two words.
    f"for p in {' '.join(f'"{place}"' for place in CLAUDE_PLACES)}; do "
    'if [ -z "$c" ] && [ -x "$p" ]; then c="$p"; fi; done; '
    'if [ -n "$c" ]; then printf \'claude: %s\\n\' "$c"; '
    'printf \'claude-version: %s\\n\' "$("$c" --version 2>/dev/null | head -n 1)"; '
    'if "$c" --help 2>/dev/null | grep -q -- --permission-prompt-tool; then '
    "printf 'claude-permissions: yes\\n'; fi; fi; "
    "if command -v tmux >/dev/null 2>&1; then printf 'tmux: yes\\n'; fi"
)


@dataclass
class Machine:
    alias: str
    added: float = 0.0
    checked: float = 0.0
    ok: bool = False
    problem: str = ""
    git: str = ""
    claude: str = ""  # the CLI's path there
    claude_version: str = ""
    permissions: bool = False  # its CLI can ask JARVIS (--permission-prompt-tool stdio)
    tmux: bool = False

    def public(self) -> dict[str, Any]:
        return asdict(self)


def parse_probe(out: str) -> dict[str, Any]:
    found: dict[str, Any] = {"git": "", "claude": "", "claude_version": "", "permissions": False}
    found["tmux"] = False
    for line in out.splitlines():
        key, _, value = line.partition(": ")
        value = value.strip()
        if key == "git":
            found["git"] = value[:80]
        elif key == "claude":
            found["claude"] = value[:300]
        elif key == "claude-version":
            found["claude_version"] = value[:80]
        elif key == "claude-permissions":
            found["permissions"] = value == "yes"
        elif key == "tmux":
            found["tmux"] = value == "yes"
    return found


async def check(ssh: str, machine: Machine) -> Machine:
    """ssh -o BatchMode=yes <alias> true, then whether git and Claude Code are there."""
    alias = machine.alias
    machine.checked = time.time()
    machine.ok = False
    reach = await run(ssh, alias, "true", timeout=CHECK_SECONDS)
    if not reach.ok:
        machine.problem = ssh_problem(alias, reach)
        return machine
    probe = await run(ssh, alias, PROBE, timeout=CHECK_SECONDS)
    if not probe.ok or "jarvis-probe" not in probe.text:
        machine.problem = ssh_problem(alias, probe)
        return machine
    for key, value in parse_probe(probe.text).items():
        setattr(machine, key, value)
    if not machine.git:
        machine.problem = f"git isn't installed on {alias}."
    elif not machine.claude:
        machine.problem = (
            f"Jarvis Code needs the Claude Code CLI on {alias}: install it there and sign in."
        )
    else:
        machine.problem, machine.ok = "", True
    return machine


# ── a hand-off ──


@dataclass
class Handoff:
    id: str  # its folder on the remote (the isolated copy's slug)
    alias: str
    slug: str  # the isolated copy
    project: str
    branch: str
    base: str  # the commit handed off: what came back is what's past it
    session_id: str = ""  # the local Claude Code session (found again after a restart)
    task_id: int = 0  # the session's number in this launch
    title: str = ""
    how: str = "bundle"  # push | bundle
    keeper: str = "nohup"  # tmux | nohup
    mode: str = "default"  # the remote's permission mode
    asks: bool = False  # its permission requests come back as cards
    state: str = "starting"  # starting | working | idle | ended | stopped | failed
    seen: int = 0  # lines of out.jsonl read
    cost: float = 0.0  # what the remote's Claude Code reported, all its runs
    run_cost: float = 0.0  # ... of the run going now (its running total)
    turns: int = 0
    started: float = 0.0
    remote_session: str = ""
    remote_cwd: str = ""
    model: str = ""
    note: str = ""  # the latest problem, for the list
    pending: list[dict[str, Any]] = field(default_factory=list)  # permission requests unanswered

    @property
    def folder(self) -> str:
        return f'"$HOME/{ROOT}/{self.id}"'

    @property
    def live(self) -> bool:
        return self.state in ("starting", "working", "idle")

    def public(self) -> dict[str, Any]:
        return {
            k: getattr(self, k)
            for k in (
                "id", "alias", "slug", "project", "branch", "task_id", "title", "how", "keeper",
                "mode", "asks", "state", "cost", "turns", "started", "note", "model",
            )
        } | {"mode_label": MODE_NAMES.get(self.mode, self.mode), "waiting": len(self.pending)}  # fmt: skip


def from_raw(kind: type, raw: Any) -> Any:
    if not isinstance(raw, dict):
        return None
    names = {f.name for f in fields(kind)}
    try:
        return kind(**{k: v for k, v in raw.items() if k in names})
    except TypeError:
        return None


def remote_mode(mode: str, asks: bool) -> tuple[str, str]:
    """The remote's permission mode for a session's, and what to tell the owner about it
    ("" when nothing changes). Never Bypass; without a way to ask, never Manual either."""
    if not asks:
        return "acceptEdits", (
            "Claude Code there can't ask you from this Mac, so it runs in Accept edits: edits "
            "in its checkout go ahead, anything else that needs permission is refused."
        )
    if mode in REMOTE_MODES:
        return REMOTE_MODES[mode], ""
    if mode == "auto":
        return (
            "default",
            "Bypass permissions never goes to another machine: there it runs in Manual, and each step asks you here.",
        )
    return (
        "default",
        "Auto mode stays on this Mac: there it runs in Manual, and each step asks you here.",
    )


def runner(claude: str, mode: str, asks: bool, model: str = "", resume: str = "") -> str:
    """run.sh: Claude Code fed from inbox.jsonl as it grows, its output appended to
    out.jsonl, its exit code left in exit.code."""
    args = [
        "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
        "--permission-mode", mode,
    ]  # fmt: skip
    if asks:
        args += ["--permission-prompt-tool", "stdio"]
    if model and MODEL.match(model):
        args += ["--model", model]
    if resume and SESSION.match(resume):
        args += ["--resume", resume]
    command = " ".join(shlex.quote(a) for a in [claude, *args])
    return f"""#!/bin/sh
# JARVIS hand-off: Claude Code reads inbox.jsonl as it grows and writes out.jsonl.
D="$(cd "$(dirname "$0")" && pwd)"
cd "$D/repo" || {{ echo 1 > "$D/exit.code"; exit 1; }}
rm -f "$D/in.fifo" "$D/exit.code"
mkfifo "$D/in.fifo" || {{ echo 1 > "$D/exit.code"; exit 1; }}
tail -n +1 -f "$D/inbox.jsonl" > "$D/in.fifo" &
T=$!
{command} < "$D/in.fifo" >> "$D/out.jsonl" 2>> "$D/err.log" &
C=$!
echo "$C" > "$D/claude.pid"
wait "$C"
S=$?
kill "$T" 2>/dev/null
# Stopped and slow to quit, a run may end after a newer one has started in this folder:
# its exit code (and the pipe) are then the newer run's to leave, or that one reads as over.
if [ "$(cat "$D/claude.pid" 2>/dev/null)" = "$C" ]; then
  rm -f "$D/in.fifo"
  echo "$S" > "$D/exit.code"
fi
"""


def setup_script(rec: Handoff, source: str, url: str = "") -> str:
    """The remote checkout on the session's branch, from the project's remote (url) or the
    bundle sent over SSH. Refuses a checkout with uncommitted work from last time."""
    d = rec.folder
    origin = (
        f"git remote get-url origin >/dev/null 2>&1 || git remote add origin {shlex.quote(url)}; "
        if url
        else ""
    )
    return (
        "umask 077; export GIT_TERMINAL_PROMPT=0; "
        "export GIT_SSH_COMMAND='ssh -o BatchMode=yes'; "
        f'D={d}; mkdir -p "$D" && cd "$D" || exit 3; '
        "if [ ! -d repo/.git ]; then git init -q repo || exit 3; fi; cd repo || exit 3; "
        'if [ -n "$(git status --porcelain 2>/dev/null)" ]; then echo DIRTY >&2; exit 7; fi; '
        f"git fetch -q {source} {shlex.quote('refs/heads/' + rec.branch)} || exit 8; "
        f"git checkout -q -B {shlex.quote(rec.branch)} FETCH_HEAD || exit 9; "
        f"{origin}"
        'rm -f "$D/handoff.bundle"; git rev-parse HEAD'
    )


def start_script(rec: Handoff, run_sh: str) -> str:
    """run.sh written, a fresh inbox with the first lines in it (from stdin: inbox_bytes),
    and the runner started under tmux (or nohup). Says which."""
    d = rec.folder
    session = shlex.quote(f"jarvis-{rec.id}")
    return (
        f'umask 077; D={d}; cd "$D" || exit 3; '
        f"printf '%s' {shlex.quote(run_sh)} > run.sh; "
        "cat > inbox.jsonl; touch out.jsonl; "
        "rm -f exit.code claude.pid; "
        "if command -v tmux >/dev/null 2>&1; then "
        f"tmux kill-session -t {session} >/dev/null 2>&1; "
        f'tmux new-session -d -s {session} sh "$D/run.sh" && echo tmux; '
        'else nohup sh "$D/run.sh" >/dev/null 2>&1 </dev/null & echo nohup; fi'
    )


def inbox_bytes(lines: list[str]) -> bytes:
    return "".join(line + "\n" for line in lines).encode("utf-8")


def follow_script(rec: Handoff) -> str:
    """out.jsonl from the line after the last one read, as it grows (whole lines only); a
    'JARVIS-BEAT' line every 10 s, so a reader that's gone ends it at once; and, once the run
    has ended (exit.code), 'JARVIS-EXIT <code>' and the end. No process of its own outlives
    the connection."""
    return (
        f'D={rec.folder}; cd "$D" || exit 3; touch out.jsonl; K={rec.seen + 1}; i=0; '
        "while :; do "
        "if [ -f exit.code ]; then E=1; else E=0; fi; "
        "N=$(wc -l < out.jsonl | tr -d ' '); "
        'if [ "$N" -ge "$K" ]; then sed -n "${K},${N}p" out.jsonl || exit 0; K=$((N + 1)); fi; '
        'if [ "$E" = 1 ]; then printf \'JARVIS-EXIT %s\\n\' "$(cat exit.code)"; exit 0; fi; '
        "i=$((i + 1)); if [ \"$i\" -ge 10 ]; then i=0; printf 'JARVIS-BEAT\\n' || exit 0; fi; "
        "sleep 1; done"
    )


def status_script(rec: Handoff) -> str:
    return (
        f'D={rec.folder}; cd "$D" 2>/dev/null || {{ echo missing; exit 0; }}; '
        'if [ -f exit.code ]; then echo "ended $(cat exit.code)"; '
        'elif [ -f claude.pid ] && kill -0 "$(cat claude.pid)" 2>/dev/null; then echo running; '
        "else echo gone; fi"
    )


def write_script(rec: Handoff) -> str:
    return f'D={rec.folder}; cd "$D" || exit 3; cat >> inbox.jsonl'


def stop_script(rec: Handoff) -> str:
    return (
        f'D={rec.folder}; cd "$D" 2>/dev/null || exit 0; '
        'if [ -f claude.pid ] && [ ! -f exit.code ]; then kill "$(cat claude.pid)" 2>/dev/null; '
        "for i in 1 2 3 4 5; do [ -f exit.code ] && break; sleep 1; done; fi; "
        f"tmux kill-session -t {shlex.quote('jarvis-' + rec.id)} >/dev/null 2>&1; true"
    )


BACK_NOTHING, BACK_BRANCH = 5, 6


def back_script(rec: Handoff, message: str) -> str:
    """What it did there, committed (with the remote's own identity, else Jarvis Code's) and
    bundled to stdout: the branch past the commit handed off. Exit 5: nothing new; 6: it
    isn't on the branch any more."""
    branch = shlex.quote(rec.branch)
    msg = shlex.quote(message)
    return (
        f'D={rec.folder}; cd "$D/repo" || exit 3; '
        f'if [ "$(git symbolic-ref -q --short HEAD)" != {branch} ]; then exit {BACK_BRANCH}; fi; '
        'if [ -n "$(git status --porcelain)" ]; then git add -A >&2 || exit 4; '
        f"if git config user.email >/dev/null 2>&1; then git commit -q -m {msg} >&2 || exit 4; "
        "else git -c user.name='Jarvis Code' -c user.email=jarvis-code@localhost "
        f"commit -q -m {msg} >&2 || exit 4; fi; fi; "
        f'if [ "$(git rev-parse HEAD)" = {shlex.quote(rec.base)} ]; then exit {BACK_NOTHING}; fi; '
        f"git bundle create - {shlex.quote('refs/heads/' + rec.branch)} ^{shlex.quote(rec.base)}"
    )


# ── what goes there and what comes back ──


def user_line(text: str) -> str:
    return json.dumps(
        {
            "type": "user",
            "message": {"role": "user", "content": text},
            "parent_tool_use_id": None,
            "session_id": "default",
        },
        ensure_ascii=False,
    )


def init_line() -> str:
    return json.dumps(
        {
            "type": "control_request",
            "request_id": "jarvis_init",
            "request": {"subtype": "initialize", "hooks": None},
        }
    )


def interrupt_line(n: int) -> str:
    return json.dumps(
        {
            "type": "control_request",
            "request_id": f"jarvis_interrupt_{n}",
            "request": {"subtype": "interrupt"},
        }
    )


def answer_line(request_id: str, allow: bool, tool_input: dict[str, Any], message: str = "") -> str:
    response: dict[str, Any] = (
        {"behavior": "allow", "updatedInput": tool_input}
        if allow
        else {"behavior": "deny", "message": message or "The owner said no."}
    )
    return json.dumps(
        {
            "type": "control_response",
            "response": {"subtype": "success", "request_id": request_id, "response": response},
        },
        ensure_ascii=False,
    )


def summary(task: Any, commits: list[str], host: str, instructions: str = "") -> str:
    """The first message on the remote: what the session was about and where it got to
    (its transcript can't move), made from the session itself without a model call."""
    lines = [
        "You're continuing a Jarvis Code session that started on the owner's Mac; it was "
        f"handed off to this machine ({host}). The conversation itself couldn't come along, "
        "so here is a summary of it.",
        "",
        f"Session: {task.title or task.prompt[:120] or 'untitled'}",
    ]
    if task.prompt:
        lines += ["", "What it was asked first:", task.prompt[:1500]]
    said: list[str] = []
    for entry in task.transcript[-60:]:
        role, text = entry.get("role"), str(entry.get("text") or "").strip()
        if role in ("user", "assistant") and text:
            who = "Owner" if role == "user" else "You"
            said.append(f"{who}: {text[:600]}")
    if said:
        lines += ["", "The latest of the conversation:", *said[-12:]]
    if task.todos:
        lines += ["", "Its to-do list:"]
        lines += [
            f"- [{t.get('status', 'pending')}] {t.get('content', '')}" for t in task.todos[:20]
        ]
    if task.files_changed:
        lines += ["", "Files it changed: " + ", ".join(sorted(task.files_changed)[:30])]
    if commits:
        lines += ["", "Commits on this branch so far:", *commits[:15]]
    lines += [
        "",
        "The work so far is committed on this checkout's branch. Carry on from here, in this "
        "checkout. Don't push; the owner brings the branch back to the Mac.",
        "",
        instructions.strip()
        or "Carry on with what's left. If it was finished, say so briefly and wait.",
    ]
    text = "\n".join(lines)
    return text if len(text) <= SUMMARY_MAX else text[: SUMMARY_MAX - 1] + "…"


def tool_output(content: Any) -> str:
    if isinstance(content, list):
        content = "\n".join(str(c.get("text", "")) for c in content if isinstance(c, dict))
    return str(content or "")[:2000]


def parse_line(raw: str) -> dict[str, Any] | None:
    raw = raw.strip()
    if not raw.startswith("{"):
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None
