"""Touch ID for Eden Code's riskiest moments: a session switched into Bypass permissions,
new sessions set to start in it, and a risky step allowed from its card ask for the owner's
fingerprint (the window asks: web/features/code-touchid.js, through the app's own
app/features/touchid.js), or the app's own confirmation where there's no Touch ID.

Its setting: code_touchid (on by default), in Eden Code settings › General. check_proof
checks the proof the app's main process signs once macOS's sheet said
yes (app/features/touchid.js makeProof, audit S30):
"v2.<kind>.<subject>.<expires ms>.<nonce>.<mac>", the mac an HMAC-SHA256 of
"eden-touchid|v2|<kind>|<subject>|<expires>|<nonce>" under the proof key: one
the app that started this backend gave it on its own pipe (proof_pipe.py), never the launch
token, which the page has (its URL), so a script in the window can't sign a yes of its own
(round 1, A1). A proof holds until it expires (two minutes at most), only once, and only for
its subject (round 3, R2-12): a risky step's yes names its card (the approval id), Bypass
names its session (the task id, or "new" for one not started yet), and the kinds with no one
thing to name (bypass-default, touchid-off, rules) name none; a yes for one card can't be
spent on another that came up meanwhile. A window of the other app on this backend
(backend-share.js) has no key: it asks here (code_touchid_ask {kind, lang, subject}), this
backend asks its own app over the pipe, that app shows
its sheet and the proof comes back the same way, armed at once (code_touchid_answer
{proof_kind, ok} tells the window). A backend run by hand has no key, and no proof holds.

The backend's gate (Gate, audit S30), while code_touchid is on and the backend was started
with a launch token (server.create_app: hub.launch_token): from the window, a session into
Bypass permissions (task_mode, task_new with mode "auto"), new sessions set to start in it
(code_defaults' or set_prefs' code_mode "auto", a project's own default mode "auto" in
feature_prefs' code_project_defaults), a risky step allowed from its card (approve; risky()
is the window's own test, web/features/code-touchid.js, word for word, and any card the
backend marks touchid) and turning this very setting off (feature_prefs code_touchid false:
kind "touchid-off", round 1 A3) each need a proof of their kind. A new session (task_new, and
an ACP agent's acp_start: code_acp.py asks here) in Bypass needs one unless its project's
default (or everyone's) is Bypass already, which needed one to be set. The window sends the
proof just before (code_touchid_proof {kind, proof}: the app's
fingerprint sheet, or on a Mac without Touch ID the app's own confirmation, its native
dialog; a page outside the app can't make one). Without one the switch is refused and said
so (an "error" event; a risky step's card comes back). Answers from the phone (its own gate,
S11) and by voice (the owner's voice and a tap) don't come through here as the window's.

Round 2: one gate every way into Bypass goes through, not one per window command. Every
session that starts in Bypass or is switched into it comes through TaskManager.start or
set_mode, and both ask Gate.bypass_gate (TaskManager.bypass_gate): task_mode and task_new, a
/bypass typed in the composer (code_command, R2-2), Best of N's variants and a multi-repo
session (R2-3: one proof for one command's sessions), an ACP agent, and any feature that starts
sessions later. From the phone only its mode menu and new-session sheet go through (their Face
ID, S11); its typed /bypass is refused. What carries on a Bypass already proved says so
(tasks.bypass_vouched): /clear's fresh session, voice's tap-only card, a resumed past one. A
rule is never Bypass for a kind of step either (G3/G4): no "don't ask again" or allow rule
lets a risky step by unasked (TaskManager.risky_step: it asks on its card, Touch ID there),
its card offers no "don't ask again", and from the Permissions pane an allow rule that's Bypass
for a kind of step (broad_rule), a deny rule taken away and allow rules exported into a
project's .claude settings each need a proof of kind "rules" (code_rules.py asks here). A card
only the Mac's window answers (mac_only: tap-only, marked touchid, a risky step's) never goes
to a chat or the Jarvis number with its buttons (R2-7).

Window commands: code_touchid_proof {kind, proof}: armed for the next command of its kind
(kinds: bypass, bypass-default, approve, touchid-off, rules), and good only if that command
is for the proof's subject; code_touchid_ask {kind, lang, subject}: the app that started
this backend asks the owner (above).

Cost policy (Claude): this feature never calls a model.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import re
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

from .. import lang, prefs

log = logging.getLogger("jarvis")

PREF = "code_touchid"
DEFAULTS = "code_project_defaults"  # (code_sessions.py's: a project's own session defaults)
prefs.register_feature_pref(PREF, True)

PROOF_SECONDS = 120  # as touchid.js's PROOF_MS
SUBJECT = re.compile(r"^[A-Za-z0-9_-]{0,40}$")
_PROOF = re.compile(
    r"^v2\.([a-z-]{1,32})\.([A-Za-z0-9_-]{0,40})\.(\d{13})\.([0-9a-f]{32})\.([0-9a-f]{64})$"
)
PROOF_MAX = 300  # characters of a proof, at most (kind, subject, expiry, nonce and mac)
NEW = "new"  # the subject of a Bypass proof for a session not started yet
_used: OrderedDict[str, float] = OrderedDict()  # nonce -> its expiry, so each proof works once
_lock = threading.Lock()


def check_proof(
    token: str, proof: str, kind: str, subject: str = "", now: float | None = None
) -> bool:
    """Whether proof is the main process's, for kind and subject (the one card or session
    the yes was for: round 3, R2-12), unexpired and never used before. Uses it."""
    m = _PROOF.match(str(proof or ""))
    subject = str(subject or "")
    if not token or not m or m.group(1) != kind or not SUBJECT.match(subject):
        return False
    if not hmac.compare_digest(m.group(2), subject):
        return False
    expires_ms = int(m.group(3))
    nonce = m.group(4)
    at = time.time() if now is None else now
    if not at * 1000 < expires_ms <= (at + PROOF_SECONDS + 5) * 1000:
        return False
    signed = f"eden-touchid|v2|{kind}|{subject}|{expires_ms}|{nonce}".encode()
    want = hmac.new(str(token).encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, m.group(5)):
        return False
    with _lock:
        for old, until in list(_used.items()):  # (oldest first: expired ones are forgotten)
            if until * 1000 > at * 1000:
                break
            del _used[old]
        if nonce in _used:
            return False
        _used[nonce] = expires_ms / 1000
        while len(_used) > 1000:
            _used.popitem(last=False)
    return True


# ── the backend's gate (S30) ──

KINDS = ("bypass", "bypass-default", "approve", "touchid-off", "rules")
# A project's default set to Bypass just after everyone's was, with its proof (the composer's
# choice moves into the project's own defaults: code-sessions.js movedDefaults): one yes.
DEFAULT_GRACE_S = 30.0
ALLOWING = frozenset({"allow", "always", "allow_edits"})
BYPASS_BY_VOICE = "code_bypass_by_voice"  # voicecode.BYPASS_BY_VOICE: its card's tap
# The phone's own commands whose Face ID the iPhone app asks before sending (OwnerCheck.swift:
# its mode menu, its new session sheet); anything else from the phone into Bypass is refused.
PHONE_ASKS = frozenset({"task_mode", "task_new"})
EDITS = ("Edit", "MultiEdit", "Write", "NotebookEdit")
# The window's RISKY (web/features/code-touchid.js), word for word: the window asks for the
# fingerprint for exactly the steps the backend then wants a proof for.
_B = r"(^|[\s;&|(`])"
# A program named with its folder or in quotes is the same program: "/bin/rm", "rm",
# ~/bin/sudo (round 2, R2-8). Its options may come in any order: -R last, --no-preserve-root
# before -rf.
_P = r"""["']?(?:[\w.~/-]*/)?"""
_Q = r"""["']?"""
_OPTS = r"\s+([^;&|\n]*\s)?"
RISKY = [
    re.compile(_B + _P + r"(sudo|doas)" + _Q + r"\s"),
    re.compile(_B + _P + r"rm" + _Q + _OPTS + r"(-\w*[rRf]\w*|--recursive|--force)"),
    re.compile(
        r"\bgit\b[^;&|\n]*\s(push|reset\s+--hard|clean\s+-\w*f\w*|branch\s+-D|filter-branch"
        r"|filter-repo)\b"
    ),
    re.compile(r"\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?\w*sh\b"),
    re.compile(_B + _P + r"(chmod|chown)" + _Q + _OPTS + r"(-\w*R\w*|--recursive)"),
    re.compile(
        _B + _P + r"(dd\s[^|\n]*\bof=|mkfs\b|diskutil\s+(erase\w*|partition\w*|reformat|zero\w*))"
    ),
    re.compile(
        _B + _P + r"(launchctl|csrutil|spctl|systemsetup|networksetup|defaults\s+(write|delete))\b"
    ),
    re.compile(
        _B + _P + r"((npm|yarn|pnpm)\s+publish|twine\s+upload|cargo\s+publish|gem\s+push"
        r"|docker\s+push|pod\s+trunk\s+push)\b"
    ),
    re.compile(
        _B + _P + r"(kubectl\s+(delete|apply|drain)|terraform\s+(apply|destroy)"
        r"|helm\s+(install|upgrade|uninstall|delete))\b"
    ),
    re.compile(r"\b(drop\s+(table|database|schema)|truncate\s+table)\b", re.I),
    re.compile(_B + _P + r"(killall|pkill|shutdown|reboot|halt)\b"),
    re.compile(_B + _P + r"find\s[^;&|\n]*\s-delete\b"),
    # An interpreter's one-liner that deletes: python -c "shutil.rmtree('/')", node -e
    # "fs.rmSync(…)", perl -e 'unlink …', ruby -e 'FileUtils.rm_rf …'.
    re.compile(
        _B
        + _P
        + r"(python[\d.]*|perl|ruby|node|deno|bun|php|osascript)"
        + _Q
        + r"\s([^\n]*\s)?(-\w*[ceEr]\w*|--eval)\s[^\n]*"
        r"(rmtree|removedirs|\bremove\s*\(|unlink|rmdir|\brm_r|rmSync|rimraf|\brm\s+-\w*[rRf])"
    ),
]


# Round 3 (S3-6): a shell reads `\rm`, `r\m`, `r''m` and `rm${IFS}-rf` as rm -rf. The table
# is matched against the command as the shell would read those too (an escaping backslash gone,
# quotes inside a word gone, $IFS a space), as well as against it as written; and a program the
# shell only knows when it runs (a variable's, $'…', $(…): x=rm; $x -rf ~) is risky by itself.
# The window's riskyCommand does the same, word for word.
_ESCAPED = re.compile(r"\\(.)")
_IFS = re.compile(r"\$\{IFS\}|\$IFS\b")
_INNER_QUOTES = re.compile(r"""(?<=[\w/.~-])["']+""")
_VAR_PROGRAM = re.compile(r"""(^|[;&|(`\n])\s*(\w+=\S*\s+)*["']?\$[\w{('"]""")


def as_shell_reads(command: Any) -> str:
    """The command with what only hides a program's name from the table taken out."""
    text = _ESCAPED.sub(r"\1", str(command or ""))
    return _INNER_QUOTES.sub("", _IFS.sub(" ", text))


def risky_command(command: Any) -> bool:
    text = str(command or "")
    if _VAR_PROGRAM.search(text):
        return True
    read = as_shell_reads(text)
    return any(p.search(text) or p.search(read) for p in RISKY)


_UP = re.compile(r"""(^|[\s/'"=])\.\.(/|$|[\s'"])""")


def names_folder(
    text: Any, folders: list[str], home: str = "", own: list[str] | None = None
) -> bool:
    """Whether a command (or a path) names one of these folders, however it's written: with
    ~ or $HOME for the home folder, quotes or backslashes in it (as_shell_reads), any case
    (the Mac's disk ignores it). What's inside own (the session's own folders: its copy can
    be in the app's data folder, worktrees/) doesn't count, but from inside one of those
    folders a step up (..) does."""
    read = as_shell_reads(text)
    if home:
        read = re.sub(r"\$\{HOME\}|\$HOME\b|(?<![\w/])~(?=/|$|\s)", home, read)
    read = re.sub(r"/+", "/", read).casefold()
    folders = [re.sub(r"/+", "/", f).rstrip("/").casefold() for f in folders if f]
    mine = [re.sub(r"/+", "/", f).rstrip("/").casefold() for f in own or [] if f]
    inside = [m for m in mine if any(m == f or m.startswith(f + "/") for f in folders)]
    for m in sorted(inside, key=len, reverse=True):
        read = re.sub(re.escape(m) + r"(?=/|$|[\s'\";&|)])", " ", read)
    if inside and _UP.search(read):
        return True
    return any(f in read for f in folders)


def risky(approval: Any, choice: str) -> bool:
    """Whether allowing this approval is a risky step (only an Eden Code session's, and
    only a yes), as the window's risky() says."""
    a = approval if isinstance(approval, dict) else {}
    if a.get("tool") == BYPASS_BY_VOICE:
        return choice in ALLOWING
    if a.get("touchid") is True:  # a card the backend marks itself (Exterminator Mode's landing)
        return choice in ALLOWING
    if not a.get("task_id") or choice not in ALLOWING:
        return False
    if a.get("tool") == "Bash":
        return risky_command(re.sub(r"^\$\s*", "", str(a.get("detail") or "")))
    if a.get("tool") in EDITS:
        return "outside the project" in str(a.get("question") or "")
    return False


def mac_only(card: Any) -> bool:
    """A card only the Mac's own window may answer (round 2, R2-7): one only a tap answers
    (Bypass asked for by voice), one the backend marks for Touch ID, or a risky step's. The
    chats and the Jarvis number never get its buttons; they say to answer it on the Mac."""
    a = card if isinstance(card, dict) else {}
    return bool(a.get("tap_only")) or a.get("touchid") is True or risky(a, "allow")


# Programs that run whatever they're given: an allow rule for one is an allow for anything.
RUNS_ANYTHING = frozenset(
    {
        "bash", "sh", "zsh", "fish", "dash", "ksh", "sudo", "doas", "env", "eval", "exec",
        "command", "builtin", "xargs", "nohup", "time", "timeout", "gtimeout", "nice", "watch",
        "caffeinate", "stdbuf", "python", "perl", "ruby", "node", "deno", "bun", "php",
        "osascript", "ssh", "npx", "bunx", "uvx", "pipx",
        # Round 3 (S3-9): what runs a file or a script the session can write, or anything in a
        # container or on GitHub's machines: a Makefile, a jar, uv run, docker run, gh's own.
        "make", "gmake", "docker", "podman", "gh", "uv", "java",
    }
)  # fmt: skip
# Programs that run anything with one of their subcommands (npm run's script is the session's
# to write): an allow rule for the program alone, or for that subcommand, is broad (S3-9).
RUNS_WITH = {
    "npm": frozenset({"run", "run-script", "exec", "x"}),
    "yarn": frozenset({"run", "exec", "dlx", "node"}),
    "pnpm": frozenset({"run", "exec", "dlx"}),
    "cargo": frozenset({"run"}),
    "go": frozenset({"run"}),
}
_RULE = re.compile(r"^\s*([^()\s]+)\s*(?:\(([\s\S]*)\))?\s*$")


def broad_rule(text: Any) -> bool:
    """An allow rule that's Bypass for a whole kind of step (round 2, G3): every command
    (Bash, Bash(*)), a program that runs anything (Bash(python:*), Bash(sudo:*)) or a risky
    one (Bash(git push:*)), and edits anywhere (Edit, Write(//**), Edit(~/…), Edit(*.py): a
    name with no folder is that name in every folder, outside the project too). Adding one
    from the window needs Touch ID's proof (kind "rules"), as removing a deny rule does. The
    window's broadRule (web/features/code-touchid.js) is the same, word for word."""
    m = _RULE.match(str(text or ""))
    if not m:
        return False
    tool, content = m.group(1), (m.group(2) or "").strip()
    content = "" if content == "*" else content
    if tool == "Bash":
        prefix = re.sub(r":?\*$", "", content).strip()
        if not prefix:
            return True
        words = prefix.split()
        first = words[0].strip("\"'").rsplit("/", 1)[-1]
        plain = re.sub(r"[\d.]+$", "", first)
        runs = RUNS_WITH.get(first)
        second = words[1].strip("\"'") if len(words) > 1 else ""
        if runs is not None and (not second or second in runs):
            return True
        return first in RUNS_ANYTHING or plain in RUNS_ANYTHING or risky_command(prefix)
    if tool in EDITS:
        if not content:
            return True
        return (
            "/" not in content.rstrip("/")
            or content.startswith(("//", "~"))
            or ".." in content.split("/")
        )
    return False


NEEDS = {
    "bypass": "Bypass permissions needs your fingerprint (or the Eden app’s own confirmation) "
    "first, so it stayed as it was.",
    "bypass-default": "Starting new sessions in Bypass permissions needs your fingerprint (or "
    "the Eden app’s own confirmation) first, so it stayed as it was.",
    "approve": "That step needs your fingerprint (or the Eden app’s own confirmation) first; "
    "it’s still waiting for your answer.",
    "touchid-off": "Turning off Touch ID for Bypass and risky steps needs your fingerprint (or "
    "the Eden app’s own confirmation) first, so it stayed on.",
    "rules": "A rule that lets every command, a program that runs anything, a risky command or "
    "edits anywhere go unasked, taking a deny rule away, or writing allow rules into a project's "
    ".claude settings, needs your fingerprint (or the Eden app’s own confirmation) first, so "
    "the rules stayed as they were.",
    "phone": "Bypass permissions from the phone goes through its mode menu, where Face ID "
    "confirms it, so it stayed as it was.",
}

lang.add_texts(
    {
        NEEDS["bypass"]: "绕过权限需要先验证你的指纹（或 Eden 应用自己的确认），所以保持不变。",
        NEEDS["bypass-default"]: (
            "让新会话以绕过权限开始需要先验证你的指纹（或 Eden 应用自己的确认），所以保持不变。"
        ),
        NEEDS["approve"]: "这一步需要先验证你的指纹（或 Eden 应用自己的确认）；它仍在等你回答。",
        NEEDS["touchid-off"]: (
            "关闭“绕过权限和有风险步骤需要触控 ID”需要先验证你的指纹（或 Eden 应用自己的确认），"
            "所以它仍然开着。"
        ),
        NEEDS["rules"]: (
            "让所有命令、能运行任何东西的程序、有风险的命令或任何位置的修改不再询问、删除一条禁止"
            "规则，或者把允许规则写进项目的 .claude 设置，都需要先验证你的指纹（或 Eden 应用自己的"
            "确认），所以规则保持不变。"
        ),
        NEEDS["phone"]: "在手机上开启绕过权限要通过它的模式菜单（由面容 ID 确认），所以保持不变。",
    }
)


class Gate:
    """The window's switches into Bypass and its risky approvals, each with its proof."""

    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.armed: dict[str, str] = {}  # kind -> the proof the window sent for it, unused
        self.default_proven = -DEFAULT_GRACE_S  # when new sessions were last set to Bypass, proved
        self.loop: Any = None  # the hub's loop, for the pipe's answers (code_touchid_ask)

    def key(self) -> str:
        """The proof key the app gave on its own pipe (proof_pipe.py); "" without one."""
        pipe = getattr(self.hub, "proof_pipe", None)
        return str(getattr(pipe, "key", "") or "")

    def on(self) -> bool:
        return bool(getattr(self.hub, "launch_token", "")) and (
            self.hub.prefs.feature(PREF) is not False
        )

    @staticmethod
    def from_window() -> bool:
        """Not a phone's request (companion_code runs those through hub.handle too)."""
        from ..companion_code import _ASKER

        return _ASKER.get() is None

    def needed(self) -> bool:
        return self.on() and self.from_window()

    def take(self, kind: str, subject: str = "") -> bool:
        """The armed proof for kind, checked for this subject (and used up either way: a
        proof for another card or session is no proof for this one)."""
        return check_proof(self.key(), self.armed.pop(kind, ""), kind, subject)

    def refuse(self, kind: str) -> None:
        log.warning("Touch ID: %s without its proof (or from where it can't be had); refused", kind)
        self.hub.emit("error", text=lang.tr(NEEDS[kind], self.hub.language))

    # ── the window's commands ──

    def on_proof(self, msg: dict[str, Any]) -> None:
        kind, proof = msg.get("kind"), msg.get("proof")
        if kind in KINDS and isinstance(proof, str) and len(proof) < PROOF_MAX:
            self.armed[kind] = proof

    # ── the one gate every way into Bypass goes through (TaskManager.bypass_gate) ──

    def bypass_gate(self, folder: Any, session_id: str, task: Any) -> bool:
        """Whether a session may start in Bypass permissions (task None) or be switched into
        it (round 2, R2-2/R2-3). TaskManager.start and set_mode ask this for every caller, so
        a typed /bypass, Best of N, multi-repo, an ACP agent or the next feature to start a
        session can't skip it. From the window: a proof of kind "bypass", or (a new session)
        its project's default, or everyone's, already Bypass (each needed one to be set).
        From the phone: its own mode menu and new-session sheet only, where its Face ID asks
        (S11, companion_code); a slash command typed there is refused. Voice's Bypass and a
        session carrying on its own Bypass are vouched for (tasks.bypass_vouched)."""
        if not self.on():
            return True
        if not self.from_window():
            from ..companion_code import _COMMAND

            if _COMMAND.get() in PHONE_ASKS:
                return True  # (the phone's own gate, S11)
            self.refuse("phone")
            return False
        if task is None:
            msg = {"directory": str(folder), "session_id": str(session_id or "")}
            if self.default_mode(msg) == "auto":
                return True  # (it would start in Bypass without the mode named: proved when set)
        if self.take("bypass", NEW if task is None else str(getattr(task, "id", ""))):
            return True
        self.refuse("bypass")
        return False

    def risky_step(self, task: Any, tool: str, tool_input: dict[str, Any]) -> bool:
        """TaskManager.risky_step: the steps a rule never lets by unasked (G3/G4), the same
        ones risky() asks the fingerprint for on their card: a risky command, an edit outside
        the project (or of the files it never edits unasked), and anything that names the
        app's own data folder (app_data_step)."""
        if self.app_data_step(task, tool, tool_input):
            return True
        if tool == "Bash":
            return risky_command(tool_input.get("command"))
        if tool in EDITS:
            return not self.hub.tasks._free_edit(task, tool_input)
        return False

    def data_folders(self) -> list[str]:
        """The app's own data folders: where prefs.json and code_sessions/remembered.json
        are (the hub's), and the app's Application Support folder."""
        from .. import prefs as prefs_module

        here = str(Path(self.hub.feature_path("prefs.json")).parent.resolve())
        return sorted({here, str(prefs_module.APP_SUPPORT)})

    def app_data_step(self, task: Any, tool: str, tool_input: dict[str, Any]) -> bool:
        """A command or an edit that names the app's data folder (S3-7): prefs.json holds
        everyone's mode and each project's defaults (Bypass among them), remembered.json how
        each session resumes, so a session writing there on a plain card's yes could set its
        own next start to Bypass. It asks on a card marked for Touch ID (TaskManager's
        touchid_step), and no rule lets it by unasked."""
        if tool == "Bash":
            text = str(tool_input.get("command") or "")
        elif tool in EDITS:
            text = str(tool_input.get("file_path") or tool_input.get("notebook_path") or "")
        else:
            return False
        own = [str(getattr(task, "cwd", "") or "")] + [
            str(d) for d in getattr(task, "add_dirs", [])
        ]
        own = [str(Path(o).resolve()) for o in own if o] + [o for o in own if o]
        return bool(text) and names_folder(text, self.data_folders(), str(Path.home()), own)

    def rule_change(
        self, behavior: str, rule: str, have: dict[str, list[str]], removing: bool
    ) -> bool:
        """A permission rule added or taken away from the window (code_rules.py's cr_add and
        cr_remove, G3): one that loosens a lot (broad_rule's allow, or a deny taken away,
        also by turning it into an ask or an allow) needs a proof of kind "rules"; any other
        goes as it came. Refused, the gate says why and nothing changes."""
        if not self.needed():
            return True
        from .. import coderules

        parsed = coderules.valid(rule)
        text = parsed.text if parsed is not None else str(rule or "")
        denied = text in (have.get("deny") or [])
        if removing:
            loosens = behavior == "deny" and denied
        else:
            loosens = (behavior == "allow" and broad_rule(text)) or (behavior != "deny" and denied)
        if not loosens or self.take("rules"):
            return True
        self.refuse("rules")
        return False

    def export_ok(self, allows: list[str]) -> bool:
        """cr_export from the window: allow rules written into a project's .claude settings
        are Claude Code's own (it lets those steps by without asking here at all, risky or
        not), so any need a proof of kind "rules" first."""
        if not allows or not self.needed() or self.take("rules"):
            return True
        self.refuse("rules")
        return False

    def default_mode(self, msg: dict[str, Any]) -> str:
        """The mode a new session in msg's folder starts in when msg names none: its
        project's own default, else everyone's (each needed a proof to be set to Bypass)."""
        try:
            own = self.hub.tasks.defaults_for(
                str(msg.get("directory") or ""), str(msg.get("session_id") or "")
            )
        except Exception:
            own = {}
        return str(own.get("mode") or self.hub.prefs.code_mode or "ask")

    def proven_default(self) -> bool:
        """A proof that new sessions may start in Bypass (the composer with no session open
        asks as it does for a session's: either kind does)."""
        if self.take("bypass-default") or self.take("bypass", NEW):
            self.default_proven = time.monotonic()
            return True
        return False

    def guard_mode(self, changes: dict[str, Any]) -> None:
        """code_mode "auto" in a settings change, kept only with its proof."""
        if changes.get("code_mode") == "auto" and self.needed():
            if self.hub.prefs.code_mode != "auto" and not self.proven_default():
                self.refuse("bypass-default")
                changes.pop("code_mode")  # the rest of the change goes as it came

    def on_defaults(self, msg: dict[str, Any]) -> bool:
        self.guard_mode(msg)
        return False

    def on_set_prefs(self, msg: dict[str, Any]) -> bool:
        """Settings' own set_prefs: code_mode "auto" there is new sessions in Bypass too (A4)."""
        changes = msg.get("changes")
        if isinstance(changes, dict):
            self.guard_mode(changes)
        return False

    def on_features(self, msg: dict[str, Any]) -> bool:
        """feature_prefs: this setting off (A3), and a project's default mode set to Bypass
        (A4), each only with its proof; the rest of the change goes as it came."""
        changes = msg.get("changes")
        if not isinstance(changes, dict) or not self.needed():
            return False
        if changes.get(PREF) is False and self.hub.prefs.feature(PREF) is not False:
            if not self.take("touchid-off"):
                self.refuse("touchid-off")
                changes.pop(PREF)
        wanted = changes.get(DEFAULTS)
        if not isinstance(wanted, dict):
            return False
        before = self.hub.prefs.feature(DEFAULTS)
        before = before if isinstance(before, dict) else {}
        was = {p: own.get("mode") for p, own in before.items() if isinstance(own, dict)}
        newly = [
            path
            for path, own in wanted.items()
            if isinstance(own, dict) and own.get("mode") == "auto" and was.get(path) != "auto"
        ]
        recent = time.monotonic() - self.default_proven < DEFAULT_GRACE_S
        if newly and not recent and not self.proven_default():
            self.refuse("bypass-default")
            kept = dict(wanted)
            for path in newly:
                own = {k: v for k, v in kept[path].items() if k != "mode"}
                if was.get(path):
                    own["mode"] = was[path]  # as it was
                kept[path] = own
            changes[DEFAULTS] = kept
        return False

    # ── the other app's window: asked through the app that started this backend ──

    def on_ask(self, msg: dict[str, Any]) -> None:
        kind = msg.get("kind")
        subject = str(msg.get("subject") or "")
        pipe = getattr(self.hub, "proof_pipe", None)
        if kind not in KINDS or not SUBJECT.match(subject):
            return
        words = "zh" if msg.get("lang") == "zh" else "en"
        if pipe is None or not pipe.ask(kind, words, subject):
            self.hub.emit("code_touchid_answer", proof_kind=kind, ok=False, unavailable=True)
            return
        try:
            self.loop = asyncio.get_running_loop()
        except RuntimeError:
            self.loop = None
        pipe.listen(self.heard)

    def heard(self, line: str) -> None:
        """A line on the app's pipe (on the pipe's own thread): its answer to an ask."""
        from .. import proof_pipe

        found = proof_pipe.parse_answer(line)
        if found is None or found[0] not in KINDS:
            return
        if self.loop is None:
            self.answer(*found)
        else:
            self.loop.call_soon_threadsafe(self.answer, *found)

    def answer(self, kind: str, proof: str) -> None:
        ok = 0 < len(proof) < PROOF_MAX
        if ok:
            self.armed[kind] = proof  # (checked as the window's are, when it's used)
        self.hub.emit("code_touchid_answer", proof_kind=kind, ok=ok)

    def on_approve(self, msg: dict[str, Any]) -> bool | None:
        approval = self.hub.approvals.get(str(msg.get("id")))
        if approval is None or not risky(approval, str(msg.get("choice"))) or not self.needed():
            return False
        if self.take("approve", str(msg.get("id"))):
            return False
        self.refuse("approve")
        self.hub.emit("approval", **approval)  # (the window took its card down: it comes back)
        return None


def install(hub: Any) -> None:
    gate = Gate(hub)
    hub.code_touchid = gate
    hub.register_command("code_touchid_proof", gate.on_proof)
    hub.register_command("code_touchid_ask", gate.on_ask)
    hub.register_command("set_prefs", gate.on_set_prefs)
    hub.register_command("feature_prefs", gate.on_features)
    hub.tasks.bypass_gate = gate.bypass_gate  # (task_mode, task_new and every other start)
    hub.tasks.risky_step = gate.risky_step
    hub.tasks.touchid_step = gate.app_data_step  # (its card is Touch ID's: S3-7)
    hub.register_command("code_defaults", gate.on_defaults)
    hub.register_command("approve", gate.on_approve)
