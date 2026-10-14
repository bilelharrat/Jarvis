"""Round 2 of the Touch ID gate (scratchpad break-r2/gate, findings A2): no way from the
window, the phone, the chats, the Permissions pane or "don't ask again" to what Bypass
permissions can do without a Touch ID proof.

- R2-2: a /bypass typed in the composer (code_command) and on the phone.
- R2-3 (G1/G2): Best of N and multi-repo sessions started in Bypass; one proof for all of one
  command's sessions. Both come through TaskManager.start, the one gate every start goes
  through (tasks.bypass_gate), as task_mode's switch comes through set_mode.
- G3: an allow rule for every command ("Bash"), edits anywhere (Write(//**)), a deny rule
  taken away, allow rules exported to a .claude file: each needs a proof of kind "rules"; and
  no allow rule lets a risky step by unasked.
- G4: "Yes, don't ask again" on a harmless card never lets the risky form of the same program
  by (and a risky card offers no "don't ask again").
- R2-7: a card only the Mac answers never goes to a chat or the Jarvis number.
- R2-8: the risky-command table (the window's and the backend's, one shared fixture).
- R2-11: a to-do card or a spec can't be set to start in Bypass while Touch ID guards it.
- R2-16: the backend's asks to its app go on a pipe of their own (fd 3), never into the log.
- Every window command whose handler carries a permission mode or an allow rule is listed
  here with how it's gated (test_every_window_command_with_a_mode_or_an_allow_is_gated).
"""

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from claude_agent_sdk import PermissionResultAllow
from code_session_fakes import end_all, make_hub, until
from test_code_bestof import hub as bestof_hub  # noqa: F401
from test_code_bestof import projects  # noqa: F401
from test_code_bestof import until as until_long
from test_code_changes import make_repo
from test_code_touchid_proof import KEY, fresh, phone

from jarvis import proof_pipe, sms
from jarvis.features import code_touchid
from jarvis.tasks import ClaudeTask

ROOT = Path(__file__).parent.parent
TOKEN = "ab" * 24
NODE = "/usr/local/bin/node"
TABLE = json.loads((Path(__file__).parent / "fixtures/risky_commands.json").read_text())


def gate_on(hub):
    """Touch ID on, as the app's backend has it: a launch token and the app's proof key."""
    hub.launch_token = TOKEN
    hub.proof_pipe = proof_pipe.Pipe(KEY, "7a" * 16)
    assert hub.code_touchid.needed()


def prove(hub, kind, nonce):
    hub.code_touchid.on_proof({"kind": kind, "proof": fresh(kind, nonce)})


def errors(seen):
    return [e["text"] for e in seen() if e["type"] == "error"]


def events(hub):
    seen = []
    queue = hub.subscribe()

    def drain():
        while not queue.empty():
            seen.append(queue.get_nowait())
        return seen

    return drain


# ── R2-2: a /bypass typed in the composer ──


async def test_a_typed_bypass_from_the_window_needs_the_proof(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    gate_on(hub)
    seen = events(hub)
    task = ClaudeTask(id=7, prompt="", cwd=tmp_path, mode="ask")
    hub.tasks.tasks[7] = task
    await hub.handle({"type": "code_command", "id": 7, "text": "/bypass"})  # (in the background)
    assert await until(lambda: any("fingerprint" in t for t in errors(seen)))
    assert task.mode == "ask", "a typed /bypass switched on Bypass without Touch ID"
    prove(hub, "bypass", "21" * 16)
    await hub.handle({"type": "code_command", "id": 7, "text": "/bypass"})
    assert await until(lambda: task.mode == "auto")


async def test_a_bypass_typed_on_the_phone_is_refused(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated)
    gate_on(hub)
    seen = events(hub)
    task = ClaudeTask(id=7, prompt="", cwd=tmp_path, mode="ask")
    hub.tasks.tasks[7] = task
    await phone(hub, {"type": "code_command", "id": 7, "text": "/bypass"})
    assert await until(lambda: any("Face ID" in t for t in errors(seen)))
    assert task.mode == "ask"
    await phone(hub, {"type": "task_mode", "id": 7, "mode": "auto"})  # its mode menu: Face ID
    assert task.mode == "auto"


# ── R2-3: Best of N and multi-repo ──


async def test_bestof_in_bypass_needs_one_proof_for_all(bestof_hub, projects):  # noqa: F811
    hub = bestof_hub
    gate_on(hub)
    make_repo(projects / "proj", {"a.py": "x = 1\n"})
    msg = {
        "type": "code_bestof", "directory": "proj", "prompt": "do it", "mode": "auto",
        "variants": [{"model": "sonnet"}, {"model": "opus"}],
    }  # fmt: skip
    await hub.handle(dict(msg))
    assert await until_long(lambda: len(hub.tasks.tasks) >= 2, 30)
    modes = [t.mode for t in hub.tasks.tasks.values()]
    assert "auto" not in modes, "Best of N started sessions in Bypass with no Touch ID proof"
    prove(hub, "bypass", "22" * 16)
    three = [{"model": "sonnet"}, {"model": "opus"}, {"model": "haiku"}]
    await hub.handle(dict(msg, variants=three))

    def variants():
        return [t for t in hub.tasks.tasks.values() if t.title.startswith("Best of 3")]

    assert await until_long(lambda: len(variants()) == 3, 30)
    assert [t.mode for t in variants()] == ["auto"] * 3, (
        "one proof is for all of one command's sessions"
    )


async def test_multirepo_in_bypass_needs_the_proof(settings, quiet_speaker, isolated, tmp_path):
    folder = tmp_path / "projects"
    folder.mkdir()
    make_repo(folder / "api", {"a.py": "a = 1\n"})
    make_repo(folder / "web", {"b.py": "b = 1\n"})
    hub = make_hub(replace(settings, projects_dir=folder), quiet_speaker, isolated)
    gate_on(hub)
    msg = {"projects": ["api", "web"], "prompt": "x", "mode": "auto"}
    await hub.code_multi.start(dict(msg))
    assert hub.tasks.tasks and all(t.mode != "auto" for t in hub.tasks.tasks.values()), (
        "a multi-repo session started in Bypass with no Touch ID proof"
    )
    prove(hub, "bypass", "23" * 16)
    await hub.code_multi.start(dict(msg, prompt="y"))
    assert [t.mode for t in hub.tasks.tasks.values()][-1] == "auto"
    await end_all(hub)


# ── G3 / G4: rules ──


def gated_task(hub, tmp_path, mode="ask"):
    gate_on(hub)
    cards = []
    hub.add_approval_sink(lambda card: cards.append(card))
    task = ClaudeTask(id=7, prompt="", cwd=tmp_path, mode=mode)
    hub.tasks.tasks[7] = task
    return task, cards


async def ask(hub, task, tool, tool_input, cards, wait=0.3):
    """The session's permission check for one step: its answer, or "card" when a card went
    up (and nobody answered it in `wait` s)."""
    can = hub.tasks.policy_for(task)
    n = len(cards)
    job = asyncio.ensure_future(can(tool, tool_input, None))
    await asyncio.sleep(wait)
    if job.done():
        return job.result()
    assert len(cards) > n
    job.cancel()
    return "card"


def bash(command):
    return ("Bash", {"command": command})


async def test_an_allow_rule_for_every_command_needs_the_proof(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    task, cards = gated_task(hub, tmp_path)
    seen = events(hub)
    assert await ask(hub, task, *bash("rm -rf /tmp/r2-nothing-here"), cards) == "card"
    await hub.handle({"type": "cr_add", "id": 7, "behavior": "allow", "rule": "Bash"})
    assert hub.code_rules.rules_of(task)["allow"] == [], "cr_add {allow, Bash} without Touch ID"
    assert any("fingerprint" in t for t in errors(seen))
    after = await ask(hub, task, *bash("rm -rf /tmp/r2-nothing-here"), cards)
    assert not isinstance(after, PermissionResultAllow), "rm -rf ran with no card"
    # With the proof the rule is added, and even then a risky command asks on its card.
    prove(hub, "rules", "31" * 16)
    await hub.handle({"type": "cr_add", "id": 7, "behavior": "allow", "rule": "Bash"})
    assert hub.code_rules.rules_of(task)["allow"] == ["Bash"]
    assert isinstance(await ask(hub, task, *bash("make build"), cards), PermissionResultAllow)
    assert await ask(hub, task, *bash("rm -rf /tmp/r2-nothing-here"), cards) == "card"
    assert await ask(hub, task, *bash("git push --force origin main"), cards) == "card"
    # A narrow allow rule needs nothing.
    await hub.handle({"type": "cr_add", "id": 7, "behavior": "allow", "rule": "Bash(npm test)"})
    assert "Bash(npm test)" in hub.code_rules.rules_of(task)["allow"]


async def test_an_allow_rule_for_edits_anywhere_needs_the_proof_and_never_skips_the_card(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    task, cards = gated_task(hub, tmp_path)
    await hub.handle({"type": "cr_add", "id": 7, "behavior": "allow", "rule": "Write(//**)"})
    assert hub.code_rules.rules_of(task)["allow"] == []
    hub.code_rules.book.add(hub.code_rules.project(task), "allow", "Write(//**)")  # (as if proved)
    outside = ("Write", {"file_path": "/tmp/r2-elsewhere/x.txt", "content": "x"})
    assert await ask(hub, task, *outside, cards) == "card", "an edit outside ran unasked"
    inside = ("Write", {"file_path": str(tmp_path / "x.txt"), "content": "x"})
    assert isinstance(await ask(hub, task, *inside, cards), PermissionResultAllow)


async def test_taking_a_deny_rule_away_needs_the_proof(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    task, _cards = gated_task(hub, tmp_path)
    project = hub.code_rules.project(task)
    hub.code_rules.book.add(project, "deny", "Bash(curl:*)")
    await hub.handle({"type": "cr_remove", "id": 7, "behavior": "deny", "rule": "Bash(curl:*)"})
    await hub.handle({"type": "cr_add", "id": 7, "behavior": "ask", "rule": "Bash(curl:*)"})
    assert hub.code_rules.rules_of(task)["deny"] == ["Bash(curl:*)"], "a deny went unproved"
    prove(hub, "rules", "32" * 16)
    await hub.handle({"type": "cr_remove", "id": 7, "behavior": "deny", "rule": "Bash(curl:*)"})
    assert hub.code_rules.rules_of(task)["deny"] == []
    # An ask or a deny added only asks more: never held up.
    await hub.handle({"type": "cr_add", "id": 7, "behavior": "deny", "rule": "Bash(scp:*)"})
    assert hub.code_rules.rules_of(task)["deny"] == ["Bash(scp:*)"]


async def test_exporting_allow_rules_needs_the_proof(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    task, _cards = gated_task(hub, tmp_path)
    hub.tasks.rules.add(task.cwd, "npm test")  # a "don't ask again": Bash(npm test:*) there
    local = tmp_path / ".claude" / "settings.local.json"
    await hub.handle({"type": "cr_export", "id": 7, "target": "local"})
    assert not local.exists(), "allow rules went into Claude Code's own settings unproved"
    prove(hub, "rules", "33" * 16)
    await hub.handle({"type": "cr_export", "id": 7, "target": "local"})
    assert json.loads(local.read_text())["permissions"]["allow"] == ["Bash(npm test:*)"]


async def test_importing_a_broad_allow_rule_asks_on_a_card_marked_for_touch_id(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    task, cards = gated_task(hub, tmp_path)
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "settings.json").write_text(
        json.dumps({"permissions": {"allow": ["Bash"]}})
    )
    importing = asyncio.create_task(hub.handle({"type": "cr_import", "id": 7}))
    assert await until(lambda: cards)
    card = cards[-1]
    assert card["touchid"] is True and code_touchid.mac_only(card)
    await hub.handle({"type": "approve", "id": card["id"], "choice": "allow"})  # no proof
    assert card["id"] in hub.approvals, "its yes needs the fingerprint"
    hub.resolve(card["id"], "strict")
    await importing
    assert hub.code_rules.rules_of(task)["allow"] == []


@pytest.mark.parametrize(
    "benign,risky",
    [
        ("rm notes.txt", "rm -rf ~/Projects/other"),
        ("git reset HEAD a.py", "git reset --hard HEAD~5"),
        ("git branch -m old new", "git branch -D main"),
        ("chmod 644 a.py", "chmod -R 777 ~"),
        ("defaults read com.apple.dock", "defaults write com.apple.dock x -int 1"),
        ("helm list", "helm uninstall prod"),
    ],
)
async def test_always_on_a_harmless_card_never_lets_the_risky_form_through(
    settings, quiet_speaker, isolated, tmp_path, benign, risky
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    task, cards = gated_task(hub, tmp_path)
    can = hub.tasks.policy_for(task)
    job = asyncio.ensure_future(can(*bash(benign), None))
    assert await until(lambda: cards)
    await hub.handle({"type": "approve", "id": cards[-1]["id"], "choice": "always"})  # no proof
    assert isinstance(await asyncio.wait_for(job, 2), PermissionResultAllow)
    assert hub.tasks.rules.for_project(task.cwd), "the harmless step's rule was kept"
    assert await ask(hub, task, *bash(risky), cards) == "card", (
        f"{risky!r} ran with no card and no Touch ID (rule from {benign!r})"
    )
    choices = [c["id"] for c in cards[-1]["choices"]]
    assert "always" not in choices, "a risky step's card offers no 'don't ask again'"


# ── R2-7: the chats and the Jarvis number ──


async def test_a_card_only_the_mac_answers_never_goes_to_a_chat(
    settings, quiet_speaker, isolated, monkeypatch
):
    from channels_fakes import attach, settle
    from channels_fakes import make_hub as chat_hub

    from jarvis.channels import router as routermod

    monkeypatch.setattr(routermod, "FORWARD_AFTER", 0.05)
    hub = chat_hub(settings, quiet_speaker, isolated)
    await hub.start()
    router, chat = attach(hub)
    asks = [
        ("Turn on Bypass permissions for alpha?", {"tool": "code_bypass_by_voice", "tap_only": True}),
        ("Land Exterminator Mode's fixes in main?", {"touchid": True, "tap_only": True}),
        ("Eden Code in alpha wants to run a command", {"task_id": 3, "tool": "Bash"}),
    ]  # fmt: skip
    jobs = [
        asyncio.create_task(
            hub.request_approval(q, "$ rm -rf ~" if "command" in q else "", None, context=c)
        )
        for q, c in asks
    ]
    plain = asyncio.create_task(hub.request_approval("Open the page?", "https://x.y"))
    await asyncio.sleep(0.25)
    assert [c["question"] for _w, c in chat.cards] == ["Open the page?"]
    for card in list(hub.approvals.values()):
        hub.resolve(card["id"], "deny")
    await asyncio.gather(*jobs, plain)
    await settle(router)
    for card in ({"choices": [{"id": "allow"}, {"id": "deny"}], **c} for _q, c in asks):
        assert not sms.eligible(card), "the Jarvis number would take its yes"
    assert sms.eligible({"choices": [{"id": "allow"}, {"id": "deny"}]})


# ── R2-8: the risky commands, the window's and the backend's ──


def test_the_backend_finds_the_shared_tables_risky_commands_risky():
    assert [c for c in TABLE["risky"] if not code_touchid.risky_command(c)] == []
    assert [c for c in TABLE["fine"] if code_touchid.risky_command(c)] == []
    assert [r for r in TABLE["broad_rules"] if not code_touchid.broad_rule(r)] == []
    assert [r for r in TABLE["narrow_rules"] if code_touchid.broad_rule(r)] == []


@pytest.mark.skipif(not shutil.which(NODE), reason="needs Node")
def test_the_window_agrees_with_the_backend_on_the_shared_table():
    script = ROOT / "src/jarvis/web/features/code-touchid.js"
    commands = TABLE["risky"] + TABLE["fine"]
    rules = TABLE["broad_rules"] + TABLE["narrow_rules"]
    js = (
        f"const ct = require({json.dumps(str(script))});"
        f"console.log(JSON.stringify([{json.dumps(commands)}.map(ct.riskyCommand),"
        f"{json.dumps(rules)}.map(ct.broadRule)]))"
    )
    out = subprocess.run([NODE, "-e", js], capture_output=True, text=True, timeout=30, check=True)
    risky, broad = json.loads(out.stdout)
    assert risky == [code_touchid.risky_command(c) for c in commands]
    assert broad == [code_touchid.broad_rule(r) for r in rules]


# ── R2-11: a to-do card or a spec set to Bypass ──


async def test_a_card_or_a_spec_cant_be_set_to_start_in_bypass(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    gate_on(hub)
    (tmp_path / "proj").mkdir()
    todo = hub.code_todo
    card = {"folder": str(tmp_path / "proj"), "prompt": "x", "title": "x"}
    assert "Bypass" in todo._settings({"mode": "auto"}, card)
    assert "Bypass" not in todo._settings({"mode": "edits"}, card) and card["mode"] == "edits"
    old = dict(card, mode="auto")  # (one set before: it starts as new sessions do)
    assert "mode" not in todo.message(old)
    # A spec's steps start sessions long after: Accept edits, and it says so.
    seen = events(hub)
    started = []

    async def new_session(msg):
        started.append(msg["mode"])
        return ClaudeTask(id=99, prompt="", cwd=tmp_path / "proj")

    hub.code_spec.new_session = new_session
    hub.code_spec.save = lambda: None
    assert (
        await hub.code_spec.start({"directory": "proj", "prompt": "a cache", "mode": "auto"}) == ""
    )
    assert started == ["edits"] and hub.code_spec.specs[-1].mode == "edits"
    assert any(e["type"] == "caption" and "Bypass" in e["text"] for e in seen())


# ── every window command that can carry a mode or an allow rule ──

# The words that mark a handler as carrying one: a permission mode, an allow, a rule's behavior.
_CARRIES = re.compile(r"""["'](mode|code_mode)["']|\bmode=|["']allow["']|["']behavior["']""")

# How each such command is gated. ("test", name): that test here or in test_code_touchid_proof
# sends it without a proof (and with one). ("start", why): its sessions start or switch only
# through tasks.start / set_mode, whose gate test_every_start_goes_through_the_one_gate checks.
# ("none", why): what it carries isn't Bypass or an allow rule.
GATED = {
    "task_mode": ("test", "test_bypass_from_the_window_needs_the_proof_of_a_yes"),
    "task_new": ("test", "test_new_sessions_in_bypass_need_it_too"),
    "code_command": ("test", "test_a_typed_bypass_from_the_window_needs_the_proof"),
    "acp_start": ("test", "test_an_acp_agent_in_bypass_needs_the_proof_too"),
    "code_bestof": ("test", "test_bestof_in_bypass_needs_one_proof_for_all"),
    "code_multi_start": ("test", "test_multirepo_in_bypass_needs_the_proof"),
    "code_defaults": ("test", "test_new_sessions_in_bypass_need_it_too"),
    "set_prefs": ("test", "test_settings_cant_set_new_sessions_to_bypass_without_the_proof"),
    "feature_prefs": ("test", "test_turning_touch_id_off_from_the_window_needs_the_proof"),
    "approve": ("test", "test_a_risky_step_allowed_from_the_window_needs_the_proof"),
    "cr_add": ("test", "test_an_allow_rule_for_every_command_needs_the_proof"),
    "cr_remove": ("test", "test_taking_a_deny_rule_away_needs_the_proof"),
    "cr_export": ("test", "test_exporting_allow_rules_needs_the_proof"),
    "cr_import": ("test", "test_importing_a_broad_allow_rule_asks_on_a_card_marked_for_touch_id"),
    "todo_add": ("test", "test_a_card_or_a_spec_cant_be_set_to_start_in_bypass"),
    "todo_edit": ("test", "test_a_card_or_a_spec_cant_be_set_to_start_in_bypass"),
    "todo_start": ("start", "a card's session is the hub's task_new (and a card can't be Bypass)"),
    "todo_from_issue": ("none", "an issue's card never starts past Accept edits (OUTSIDE_MODES)"),
    "code_spec_start": ("start", "Accept edits while Touch ID guards Bypass; then task_new"),
    "code_spec_state": ("none", "reads a spec's state"),
    "code_run_start": ("none", "unattended runs are Accept edits or Auto only (its MODES)"),
    "code_run_stop": ("none", "stops a run"),
    "code_bugfix_resume": ("none", "Exterminator Mode's sessions are Accept edits in a copy"),
    "code_bugfix_land": ("none", "its card is marked touchid and tap_only: approve's gate"),
    "code_bestof_state": ("none", "reads Best of N's groups"),
    "code_multi_open": ("start", "resumes the session (no mode named: Manual)"),
    "code_multi_prs": ("none", "opens pull requests"),
    "code_handoff": ("none", "never Bypass on another machine (handoff.remote_mode)"),
    "code_prr_fix": ("none", "a review's fix session starts in Accept edits"),
    "voicecode_start": ("start", "a session in the composer's default mode"),
    "voicecode_enter": ("none", "focuses a session as it is"),
    "automation_scripts": ("none", "a script's allow/deny on this Mac, not Eden Code's"),
    "signin_forget": ("none", "the sign-in mode (key or account)"),
    "signin_key": ("none", "the sign-in mode (key or account)"),
    "signin_state": ("none", "the sign-in mode (key or account)"),
}
for _name in ("compact", "context", "incognito", "list", "open", "resume", "thinking"):
    GATED[f"conversation_{_name}"] = ("none", "Eden Secretary's conversation, not Eden Code")


def _defs(text):
    """Each function in a module's text: name -> its bodies."""
    found = {}
    heads = [
        (m.start(), m.group(2), len(m.group(1)))
        for m in re.finditer(r"^( *)(?:async )?def (\w+)\(", text, re.M)
    ]
    for i, (at, name, indent) in enumerate(heads):
        end = next((a for a, _n, ind in heads[i + 1 :] if ind <= indent), len(text))
        found.setdefault(name, []).append(text[at:end])
    return found


def _reach(text, names, depth=3):
    """The bodies of these functions and of what they call in the same module, `depth` deep."""
    defs, seen, todo, out = _defs(text), set(), [(n, 0) for n in names], []
    while todo:
        name, k = todo.pop()
        if name in seen or name not in defs:
            continue
        seen.add(name)
        for body in defs[name]:
            out.append(body)
            if k < depth:
                todo += [(n, k + 1) for n in re.findall(r"(?:^|[^\w])(\w+)\(", body)]
    return "\n".join(out)


def carrying_commands():
    """Every window command whose handler (or what it calls in its own module) carries a mode
    or an allow: the features' register_command handlers and the hub's own branches."""
    found = set()
    for path in sorted((ROOT / "src/jarvis").rglob("*.py")):
        text = path.read_text()
        for m in re.finditer(r'register_command\(\s*"([a-z_]+)",\s*(lambda[^\n]*|[\w.]+)', text):
            handler = m.group(2)
            names = re.findall(r"(\w+)\(", handler) + [handler.split(".")[-1]]
            if _CARRIES.search(handler + _reach(text, names)):
                found.add(m.group(1))
    hub = (ROOT / "src/jarvis/hub.py").read_text()
    branch = re.compile(
        r'\n        (?:el)?if kind == "([a-z_]+)":(.*?)'
        r"(?=\n        elif kind ==|\n        else:|\n    (?:async )?def )",
        re.S,
    )
    for m in branch.finditer(hub):
        if _CARRIES.search(m.group(2) + _reach(hub, re.findall(r"self\.(\w+)\(", m.group(2)), 1)):
            found.add(m.group(1))
    return found


def test_every_window_command_with_a_mode_or_an_allow_is_gated():
    found = carrying_commands()
    assert {"task_mode", "task_new", "code_bestof", "code_multi_start", "cr_add"} <= found
    unlisted = sorted(found - set(GATED))
    assert not unlisted, (
        f"window commands that carry a permission mode or an allow rule with no gate listed "
        f"here: {unlisted}. Send each without a Touch ID proof in a test, and add it to GATED."
    )
    here = {n for n in globals() if n.startswith("test_")}
    import test_code_touchid_proof

    there = {n for n in dir(test_code_touchid_proof) if n.startswith("test_")}
    missing = [(k, v[1]) for k, v in GATED.items() if v[0] == "test" and v[1] not in here | there]
    assert not missing, missing


def test_every_start_goes_through_the_one_gate():
    """Nothing but TaskManager.start and set_mode puts a session into Bypass: no module
    assigns a mode "auto" itself or makes an Eden Code session with a mode from a message,
    and what's vouched for (tasks.bypass_vouched) is only the few that carry one on."""
    allowed_vouch = {"tasks.py", "voicecode.py", "hub.py", "code_bestof.py"}
    for path in sorted((ROOT / "src/jarvis").rglob("*.py")):
        text = path.read_text()
        assert not re.search(r"""\.mode\s*=\s*["']auto["']""", text), path.name
        if "bypass_vouched()" in text:
            assert path.name in allowed_vouch, f"{path.name} vouches for Bypass itself"
    tasks = (ROOT / "src/jarvis/tasks.py").read_text()
    start = _defs(tasks)["start"][0]
    set_mode = _defs(tasks)["set_mode"][0]
    assert "self.may_bypass(" in start and "self.may_bypass(" in set_mode


async def test_the_gate_is_asked_for_every_start_and_switch(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.tasks._session = lambda task: asyncio.sleep(0)
    asked = []
    hub.tasks.bypass_gate = lambda folder, sid, task: asked.append(task) or False
    (tmp_path / "proj").mkdir()
    fresh_one = hub.tasks.start("", "proj", mode="auto")
    assert fresh_one.mode == "ask" and asked == [None]
    assert not hub.tasks.set_mode(fresh_one.id, "auto") and fresh_one.mode == "ask"
    assert asked == [None, fresh_one]
    from jarvis.tasks import bypass_vouched

    with bypass_vouched():
        assert hub.tasks.set_mode(fresh_one.id, "auto")
    assert len(asked) == 2
    like = hub.tasks.start_like(fresh_one.id)  # /clear: carries its Bypass on
    assert like.mode == "auto" and len(asked) == 2


# ── R2-16: the asks on a pipe of their own (fd 3), never in the log ──


def test_the_asks_go_on_fd_3_and_nothing_the_backend_starts_inherits_it(tmp_path):
    """proof_pipe.take in a real process started as the Mac's app starts it (JARVIS_PROOF_PIPE
    3, fd 3 a pipe): an ask goes on fd 3, its stdout (the log) never has the tag, and a process
    it starts finds no fd 3."""
    script = tmp_path / "backend.py"
    script.write_text(
        "import json, os, subprocess, sys\n"
        "os.dup2(int(os.environ.pop('ASKS')), 3)\n"  # (as the app's spawn puts it)
        "from jarvis import proof_pipe\n"
        "pipe = proof_pipe.take()\n"
        "ok = pipe.ask('bypass', 'en')\n"
        "child = subprocess.run([sys.executable, '-c', 'import os\\n"
        'try:\\n os.fstat(3); print("open")\\nexcept OSError: print("closed")\'],'
        " capture_output=True, text=True, close_fds=False)\n"
        "print(json.dumps({'ok': ok, 'child': child.stdout.strip()}), flush=True)\n"
    )
    key, tag = "c3" * 32, "d4" * 16
    read, write = os.pipe()
    env = {**os.environ, "JARVIS_PROOF_PIPE": "3", "ASKS": str(write)}
    proc = subprocess.Popen(
        [sys.executable, str(script)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        env=env,
        pass_fds=(write,),
    )
    os.close(write)
    try:
        proc.stdin.write(f"{key} {tag}\n".encode())
        proc.stdin.flush()
        out = proc.stdout.readline()
        assert json.loads(out) == {"ok": True, "child": "closed"}
        assert tag.encode() not in out
        assert os.read(read, 200) == f"{tag} ask bypass en\n".encode()
    finally:
        proc.kill()
        proc.wait(10)
        os.close(read)
