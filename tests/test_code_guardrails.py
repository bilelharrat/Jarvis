"""The rules-to-guardrails compiler (jarvis.guardrails, features.code_guardrails): the owner's
lessons and a project's CLAUDE.md and AGENTS.md rules that a machine can check become deny
and ask permission rules, test-runner checks and checks of what an edit adds; they hold in a
PreToolUse hook (Bypass too) and the session's own prompt, edits are checked after, each one
has its switch, a rule that stays prose can get a suggestion the owner confirms, and the
turn's receipt says which fired."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace as NS

import pytest
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext
from code_session_fakes import Stream, end_all, events_of, make_hub, until

from jarvis import code_ai, guardrails
from jarvis.features import code_receipts as cr
from jarvis.guardrails import (
    MANIFESTS,
    compile_rule,
    flagged,
    from_json,
    from_proposal,
    has_words,
    rules_in,
)

CTX = ToolPermissionContext()


# ── the compiler ──


@pytest.mark.parametrize(
    "rule, deny, ask, tests, checks",
    [
        ("Use pnpm instead of npm here", ["Bash(npm)"], [], "", []),
        ("no, use pnpm not npm", ["Bash(npm)"], [], "", []),
        ("Use pnpm, not npm", ["Bash(npm)"], [], "", []),
        ("Never use npm; always use yarn", ["Bash(npm)"], [], "", []),
        ("Always use pnpm", ["Bash(npm)", "Bash(yarn)", "Bash(bun)"], [], "", []),
        ("Never edit generated/", ["Edit(generated)", "Edit(__generated__)", "Edit(*.generated.*)"], [], "", []),
        ("Don't touch migrations", ["Edit(migrations)"], [], "", []),
        ("**Never** modify `src/gen/*.ts` or `api/schema.json`", ["Edit(src/gen/*.ts)", "Edit(api/schema.json)"], [], "", []),
        ("Never edit files in vendor/ or dist/ (they're built)", ["Edit(vendor)", "Edit(dist)"], [], "", []),
        ("Never read .env", ["Read(.env)", "Read(.env.*)"], [], "", []),
        ("Never force push", ["Bash(git push --force)", "Bash(git push -f)", "Bash(git push --force-with-lease)"], [], "", []),
        ("Don't push to main", ["Bash(git push main)", "Bash(git push HEAD:main)"], [], "", []),
        ("Never push without asking", [], ["Bash(git push)"], "", []),
        ("Never `git stash`: the stack is shared", ["Bash(git stash)"], [], "", []),
        ("Don't use sudo", ["Bash(sudo)"], [], "", []),
        ("Don't use npm run dev directly", ["Bash(npm run dev)"], [], "", []),  # (just that)
        ("Avoid using curl, use the http client", ["Bash(curl)"], [], "", []),
        ("Don't use docker compose up -d without asking", [], ["Bash(docker compose up -d)"], "", []),
        ("Never run `git reset --hard`", ["Bash(git reset --hard)"], [], "", []),
        ("Run tests with pnpm vitest, not jest", [], [], "pnpm vitest", []),
        ("Always run the tests with `pytest -q`", [], [], "pytest -q", []),
        ("Use make test to run the tests", [], [], "make test", []),
        ("Never leave `console.log` in the code", [], [], "", ["console.log"]),
        ("No `debugger` statements", [], [], "", ["debugger"]),
    ],
)  # fmt: skip
def test_rules_a_machine_can_check_compile(rule, deny, ask, tests, checks):
    guard = compile_rule(rule)
    assert guard is not None, rule
    assert list(guard.deny) == deny and list(guard.ask)[: len(ask)] == ask
    assert guard.tests == tests and list(guard.checks) == checks
    assert guard.id == guardrails.rule_id(rule.replace("**", ""))


def test_asking_first_and_dependencies_and_deploys():
    deps = compile_rule("Ask before adding a dependency")
    assert not deps.deny and "Bash(npm install)" in deps.ask and "Bash(pip install)" in deps.ask
    assert set(MANIFESTS) <= set(deps.ask)  # and edits of the files they're listed in
    never = compile_rule("Never add new dependencies")  # the commands are denied, the files ask
    assert "Bash(cargo add)" in never.deny and "Edit(package.json)" in never.ask
    assert "Bash(wrangler deploy)" in compile_rule("Don't deploy without asking me first").ask
    assert "Bash(alembic upgrade)" in compile_rule("Never run migrations").deny
    existing = compile_rule("Don't edit existing migrations")
    assert existing.deny == ("Edit(migrations)",) and existing.existing
    assert compile_rule("Prefer uv over pip").deny[:2] == ("Bash(pip)", "Bash(python -m pip)")
    assert compile_rule("Use pnpm, not npm").hint == "Use pnpm instead of npm."


@pytest.mark.parametrize(
    "rule",
    [
        "Never mock the database in these tests",
        "Always run the linter before you say it's done",
        "Prefer small functions",
        "Use tabs, not spaces",
        "Don't commit secrets",
        "Don't change the public API without asking",
        "Do NOT change the composer (`.jc-composer`, `.jc-dock` and children) — the owner wants it",
        "Don't use python 2",
        "",
        "never " + "x " * 200,
    ],
)
def test_rules_a_machine_cant_check_stay_prose(rule):
    assert compile_rule(rule) is None


def test_a_check_looks_only_at_the_language_its_rule_names():
    guard = compile_rule("Never use `any` in TypeScript")
    assert guard.checks == ("any",) and ".ts" in guard.files
    edit = {"file_path": "/p/a.ts", "old_string": "x", "new_string": "let a: any = 1"}
    assert flagged(guard, "Edit", edit) == ["any"]
    assert flagged(guard, "Edit", {**edit, "file_path": "/p/notes.md"}) == []


def test_instruction_files_are_read_for_rules():
    text = """# Project
Some words about the project that aren't a rule at all.

- Use pnpm, not npm.
- **Never** edit `generated/`. It's rebuilt by `pnpm gen`.
* Ask before adding a dependency

```sh
never run this: npm install
```
<!-- never edit this comment -->
| never | a table |
"""
    found = rules_in(text)
    assert found == [
        "Use pnpm, not npm.",
        "Never edit `generated/`.",
        "Ask before adding a dependency",
    ]


def test_a_command_s_words_and_an_edit_s_added_text():
    assert has_words("cd web && pnpm vitest run", "pnpm vitest")
    assert has_words("sudo -u ci pnpm vitest", "pnpm vitest")
    assert not has_words("npx vitest", "pnpm vitest")
    assert has_words("python -m pytest -q tests", "pytest -q")  # (options don't count)
    guard = compile_rule("Never leave `console.log` in")
    keeps = {"old_string": "console.log(a)", "new_string": "console.log(b)"}
    assert flagged(guard, "Edit", keeps) == []  # (it was there already)
    assert flagged(guard, "Write", {"content": "console.log(1)"}) == ["console.log"]
    multi = {"edits": [{"old_string": "", "new_string": "x; console.log(y)"}]}
    assert flagged(guard, "MultiEdit", multi) == ["console.log"]
    assert flagged(guard, "Edit", {"new_string": "myconsole.logger()"}) == []  # (a word's part)
    assert flagged(guard, "Bash", {"command": "echo console.log"}) == []


def test_a_model_s_suggestion_keeps_only_what_can_be_checked():
    reply = (
        "Sure: "
        + json.dumps(
            {
                "deny": ["Bash(rm -rf:*)", "Bash", "Edit", "nonsense(", "TodoWrite(x)"],
                "ask": ["Bash(rm -rf:*)", "Edit(db/schema.sql)"],
                "tests": "pytest; rm -rf /",
                "checks": ["TODO", "x" * 200],
                "hint": "Keep the schema as it is.",
            }
        )
        + " hope that helps"
    )
    guard = from_proposal("Never  mock the database", reply)
    assert guard.deny == ("Bash(rm -rf:*)",)  # never a whole tool, nor what isn't a rule
    assert guard.ask == ("Edit(db/schema.sql)",) and guard.tests == ""
    assert guard.checks == ("TODO",) and guard.source == "suggested"
    assert guard.id == guardrails.rule_id("Never mock the database")
    assert from_json(guard.to_json()) == guard
    assert from_proposal("x", "{}") is None and from_proposal("x", "not json") is None
    assert from_proposal("x", '{"deny": ["Bash"]}') is None


# ── a session ──


def _project(tmp_path):
    project = tmp_path / "proj"
    project.mkdir(exist_ok=True)
    (project / "CLAUDE.md").write_text(
        "# Rules\n- Use pnpm, not npm.\n- Never edit generated/\n- Prefer small functions.\n"
    )
    (project / "AGENTS.md").write_text(
        "- Run tests with pnpm vitest\n- Never leave `console.log` in the code\n"
        "- Use pnpm, not npm.\n"  # (the same rule twice: one guardrail)
    )
    return project


async def _session(settings, quiet_speaker, isolated, tmp_path, mode="default"):
    _project(tmp_path)
    Stream.instances = []
    hub = make_hub(settings, quiet_speaker, isolated)
    task = hub.tasks.start("", "proj", mode=mode)
    return hub, task


def _hook(options, event, name):
    """The guardrails' own hook among the session's (other features add theirs)."""
    return next(m for m in options.hooks[event] if m.hooks[0].__name__ == name).hooks[0]


async def test_a_session_s_steps_meet_the_guardrails_in_bypass_too(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, task = await _session(settings, quiet_speaker, isolated, tmp_path, mode="auto")
    hub.code_lessons.learn(task, ("Ask before adding a dependency", False))
    task2 = hub.tasks.start("one", "proj")
    assert await until(lambda: Stream.instances)
    options = Stream.instances[-1].options
    pre = _hook(options, "PreToolUse", "guard_step")
    post = _hook(options, "PostToolUse", "check_edit")
    assert any(m.matcher == "*" and m.hooks[0] is pre for m in options.hooks["PreToolUse"])

    async def step(tool, data, hook=pre):
        return await hook({"tool_name": tool, "tool_input": data}, "t1", {})

    blocked = await step("Bash", {"command": "cd web && npm install left-pad"})
    out = blocked["hookSpecificOutput"]
    assert out["permissionDecision"] == "deny"
    assert "“Use pnpm, not npm.”" in out["permissionDecisionReason"]
    assert "Use pnpm instead of npm." in out["permissionDecisionReason"]
    assert await step("Bash", {"command": "pnpm install"}) == {}
    asked = await step("Bash", {"command": "pnpm add zod"})
    assert asked["hookSpecificOutput"]["permissionDecision"] == "ask"
    gen = await step(
        "Edit", {"file_path": str(task.cwd / "src/generated/api.ts"), "new_string": "x"}
    )
    assert gen["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert await step("Edit", {"file_path": str(task.cwd / "src/app.ts"), "new_string": "x"}) == {}
    tests = await step("Bash", {"command": "npx jest"})
    assert "pnpm vitest" in tests["hookSpecificOutput"]["permissionDecisionReason"]
    assert await step("Bash", {"command": "pnpm vitest run"}) == {}
    edit = {
        "file_path": str(task.cwd / "src/app.ts"),
        "old_string": "",
        "new_string": "console.log(1)",
    }
    flag = await step("Edit", edit, post)
    assert flag["decision"] == "block" and "console.log" in flag["reason"]
    # The same step twice is one entry, counted; the transcript says it once per guardrail.
    await step("Bash", {"command": "cd web && npm install left-pad"})
    fired = hub.code_guardrails.fired[task2.id]
    assert [(e["action"], e["count"]) for e in fired] == [
        ("blocked", 2), ("asked", 1), ("blocked", 1), ("blocked", 1), ("flagged", 1)
    ]  # fmt: skip
    lines = [e["text"] for e in task2.transcript if e["text"].startswith("Guardrail")]
    assert lines[0] == "Guardrail held: Use pnpm, not npm. (cd web && npm install left-pad)"
    assert len(lines) == 4
    # The turn ends: its receipt has them.
    hub.code_guardrails.task_event("task_finished", {"id": task2.id, "task_kind": "code"})
    part = hub.code_guardrails.receipt_part(task2.id)
    assert part[0] == {
        "rule": "Use pnpm, not npm.", "source": "CLAUDE.md", "action": "blocked",
        "what": "cd web && npm install left-pad", "count": 2,
    }  # fmt: skip
    assert task2.id not in hub.code_guardrails.fired
    receipt = await hub.code_receipts.write(task2, {"files": ["src/app.ts"], "status": "done"}, 0)
    assert receipt["guardrails"] == part
    assert "guardrails 4 blocked, 1 asked, 1 flagged" in task2.transcript[-1]["text"]
    await end_all(hub)


async def test_the_session_s_own_prompt_weighs_them_and_a_switch_turns_one_off(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, task = await _session(settings, quiet_speaker, isolated, tmp_path, mode="edits")
    hub.code_lessons.learn(task, ("Ask before adding a dependency", False))
    policy = hub.tasks.policy_for(task)
    out = await policy("Bash", {"command": "npm test"}, CTX)
    assert (
        isinstance(out, PermissionResultDeny) and "guardrail: “Use pnpm, not npm.”" in out.message
    )
    # An edit Edits mode would let by unasked comes to a card: the lesson asks first.
    asking = asyncio.ensure_future(
        policy("Edit", {"file_path": str(task.cwd / "package.json"), "new_string": "x"}, CTX)
    )
    assert await until(lambda: hub.approvals)
    [card] = hub.approvals.values()
    hub.resolve(card["id"], "allow")
    assert isinstance(await asking, PermissionResultAllow)
    seen = events_of(hub)
    await hub._handle({"type": "gr_state", "id": task.id})
    state = [e for e in seen() if e["type"] == "gr_state"][-1]
    rules = {g["rule"]: g for g in state["guardrails"]}
    assert list(rules) == [
        "Ask before adding a dependency", "Use pnpm, not npm.", "Never edit generated/",
        "Run tests with pnpm vitest", "Never leave `console.log` in the code",
    ]  # fmt: skip
    assert rules["Use pnpm, not npm."]["source"] == "CLAUDE.md" and state["on"] is True
    assert rules["Use pnpm, not npm."]["enforced"] == ["deny Bash(npm)"]
    assert [p["rule"] for p in state["prose"]] == ["Prefer small functions."]
    pnpm = rules["Use pnpm, not npm."]["id"]
    await hub._handle({"type": "gr_toggle", "id": task.id, "rule": pnpm, "on": False})
    state = [e for e in seen() if e["type"] == "gr_state"][-1]
    assert {g["id"]: g["on"] for g in state["guardrails"]}[pnpm] is False
    saved = json.loads(Path(hub.feature_path("code_guardrails.json")).read_text())
    assert saved["off"] == {str(task.cwd): [pnpm]}
    assert hub.tasks.rule_check(task, "Bash", {"command": "npm run build"}) is None
    # (npm's own test run is still a test run the wrong way)
    assert hub.tasks.rule_check(task, "Bash", {"command": "npm test"}) == (
        "deny", "tests only with pnpm vitest (guardrail: “Run tests with pnpm vitest”)"
    )  # fmt: skip
    # The whole feature off: nothing holds.
    await hub._handle({"type": "feature_prefs", "changes": {"code_guardrails": False}})
    assert not hub.prefs.feature("code_guardrails")
    assert (
        hub.code_guardrails.judge(task, "Edit", {"file_path": str(task.cwd / "generated/a")})
        is None
    )
    assert hub.tasks.rule_check(task, "Bash", {"command": "npm test"}) is None
    await end_all(hub)


async def test_a_prose_rule_gets_a_suggestion_the_owner_confirms(
    settings, quiet_speaker, isolated, tmp_path
):
    hub, task = await _session(settings, quiet_speaker, isolated, tmp_path)
    desk = hub.code_guardrails
    asked = []

    async def fake_ai(prompt, **kw):
        asked.append((prompt, kw))
        return '{"checks": ["eval("], "hint": "Split it into smaller ones."}'

    desk.ai = fake_ai
    seen = events_of(hub)
    last = lambda: [e for e in seen() if e["type"] == "gr_state"][-1]  # noqa: E731
    await hub._handle({"type": "gr_state", "id": task.id})
    rid = last()["prose"][0]["id"]
    await hub._handle({"type": "gr_suggest", "id": task.id, "rule": rid})
    assert await until(lambda: last().get("suggested") == rid)
    assert asked[0][1]["kind"] == "guardrail" and "<<<Prefer small functions.>>>" in asked[0][0]
    assert "data" in asked[0][0]  # (the rule's words are data, not instructions)
    proposal = last()["proposals"][rid]
    assert proposal["checks"] == ["eval("] and proposal["source"] == "suggested"
    write = {"file_path": str(task.cwd / "a.js"), "content": "eval(x)"}
    assert not any(flagged(g, "Write", write) for g in desk.active(task))  # not yet
    await hub._handle({"type": "gr_confirm", "id": task.id, "rule": rid})
    state = last()
    small = next(g for g in state["guardrails"] if g["rule"] == "Prefer small functions.")
    assert small["source"] == "suggested" and small["on"] is True
    assert state["prose"] == [] and state["proposals"] == {}
    mine = lambda: next(g for g in desk.active(task) if g.source == "suggested")  # noqa: E731
    assert flagged(mine(), "Write", write) == ["eval("]
    # Kept: read back from its file; Forget takes it away again.
    desk._book = None
    assert mine().rule == "Prefer small functions."
    await hub._handle({"type": "gr_forget", "id": task.id, "rule": rid})
    assert [p["id"] for p in last()["prose"]] == [rid]
    # A rule no check fits, today's cap, a rule that isn't there.
    desk.ai = lambda prompt, **kw: asyncio.sleep(0, result="{}")
    await hub._handle({"type": "gr_suggest", "id": task.id, "rule": rid})
    assert await until(
        lambda: last().get("note") == "No check fits that rule, so it stays as words."
    )
    budget = code_ai.budget_for(hub)
    budget.counts["guardrail"] = budget.caps["guardrail"]
    await hub._handle({"type": "gr_suggest", "id": task.id, "rule": rid})
    assert await until(lambda: "used up" in last().get("error", ""))
    await hub._handle({"type": "gr_suggest", "id": task.id, "rule": "nope"})
    assert await until(lambda: last().get("error") == "That rule isn't in this project any more.")
    await end_all(hub)


def test_a_damaged_switches_file_keeps_what_it_can(tmp_path):
    from jarvis import jsonstore
    from jarvis.features.code_guardrails import STORE, GuardBook

    path = tmp_path / "code_guardrails.json"
    good = from_proposal("Never mock the db", '{"deny": ["Bash(rm -rf:*)"]}').to_json()
    jsonstore.save_store(
        path,
        STORE,
        {
            "off": {"/p": ["abc", 3], "/q": "nope"},
            "confirmed": {"/p": {good["id"]: good, "wrongid": good, "x": {"rule": 1}}},
        },
    )
    book = GuardBook(path)
    assert book.off == {"/p": {"abc"}}
    assert [g.rule for g in book.suggested("/p")] == ["Never mock the db"]
    assert not book.is_on("/p", "abc") and book.is_on("/q", "abc")


def test_the_receipt_says_which_fired():
    r = {
        "file_count": 1, "tests": None, "check": None, "risk": "low", "why": "small change",
        "guardrails": [{"action": "blocked", "count": 2}, {"action": "flagged", "count": 1}],
    }  # fmt: skip
    assert " · guardrails 2 blocked, 1 flagged · risk low" in cr.receipt_text(r)
    del r["guardrails"]
    assert "guardrails" not in cr.receipt_text(r)


def test_a_session_with_another_agent_records_where_eden_decides(tmp_path):
    from jarvis.features.code_guardrails import GuardDesk

    logged = []
    hub = NS(
        prefs=NS(feature=lambda key: True),
        feature_path=lambda name: tmp_path / name,
        tasks=NS(tasks={}, _log=lambda *a, **k: logged.append(a), _changed_soon=lambda: None),
    )
    _project(tmp_path)
    task = NS(id=7, kind="code", cwd=tmp_path / "proj", workspace={}, model_ref="acp:codex")
    desk = GuardDesk(hub)
    found = desk.check(task, "Bash", {"command": "npm ci"})
    assert found[0] == "deny" and found[1].startswith("Bash(npm) (guardrail:")
    assert desk.fired[7][0]["action"] == "blocked" and logged
    task.model_ref = "sonnet"  # a Claude Code session: its hook records, not this
    desk.check(task, "Bash", {"command": "npm ci"})
    assert desk.fired[7][0]["count"] == 1
