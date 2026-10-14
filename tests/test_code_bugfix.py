"""Exterminator Mode (features/code_bugfix.py): the owner's protocol, driven end to end. A temp
repository with planted bugs, a fake Claude Code that answers each step as a real session
would (findings, some made up or misquoted; fixes with their tests; an efficiency pass that
deletes a test), the real suite run by pytest, real git worktrees for the isolated copy and
for the check that each fix's test fails first. Nothing calls a model."""

import asyncio
import contextlib
import json
import os
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    TextBlock,
    UserMessage,
)
from conftest import FakeClient
from test_code_changes import make_repo

from jarvis import codetests
from jarvis.features import code_bugfix
from jarvis.features.code_bugfix import (
    BugRun,
    check_finding,
    command_allowed,
    detect_stack,
    inventory,
    lost,
    owner_only,
    parse_block,
    risky,
    scratch_script,
)
from jarvis.hub import Hub
from jarvis.prefs import MODELS

CALC = """def divide(a, b):
    return a / b


def parse_age(text):
    return int(text)


def mean(xs):
    return sum(xs) / len(xs)
"""
FIXED = """def divide(a, b):
    if b == 0:
        return None
    return a / b


def parse_age(text):
    return int(text) if str(text).strip().isdigit() else None


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0
"""
BUG_TESTS = """from calc import divide, parse_age


def test_divide_zero():
    assert divide(1, 0) is None


def test_parse_age_text():
    assert parse_age("abc") is None
"""
MEAN_TEST = """
from calc import mean


def test_mean_one():
    assert mean([2]) == 2
"""
FILES = {
    "calc.py": CALC,
    "tests/test_calc.py": "from calc import divide\n\n\ndef test_divide():\n    assert divide(6, 3) == 2\n",
    "conftest.py": "",
    "pytest.ini": "[pytest]\n",
    ".gitignore": "__pycache__/\n.pytest_cache/\n",
}


def block(data):
    return f"Here's what I found.\n\n```bugfix\n{json.dumps(data)}\n```"


def finding(file, line, quote, title, severity="high", lane="reliability"):
    return {"lane": lane, "severity": severity, "file": file, "line": line, "title": title,
            "scenario": f"Calling it with a bad value: {title}.", "fix": "Guard it.",
            "kind": "ENG", "quote": quote}  # fmt: skip


class BugClient(FakeClient):
    """A session answering Exterminator Mode's steps. Each step's answer may also try steps
    through the session's guard (seen: what it decided) and edit the copy's files."""

    instances: list = []
    cost_each = 0.1
    hold = None  # a step name whose turn never ends (till released)
    seen: list = []
    prompts: list = []

    def __init__(self, options=None):
        super().__init__(options)
        self.total = 0.0
        BugClient.instances.append(self)

    async def ask(self, tool_name, tool_input):
        got = await self.options.can_use_tool(tool_name, tool_input, None)
        BugClient.seen.append(
            (
                tool_name,
                tool_input.get("command") or tool_input.get("file_path"),
                type(got).__name__,
            )
        )
        return got

    async def answer(self, text):
        cwd = Path(self.options.cwd)
        head = text.split("\n", 1)[0]
        if "SWEEP" in head and "round 1 " in head:
            await self.ask("Write", {"file_path": str(cwd / "x.py"), "content": ""})
            return block({"findings": [
                finding("calc.py", 2, "return a / b", "divide crashes when b is zero"),
                finding("calc.py", 2, "return a / b", "divide crashes on zero b", lane="tests"),  # the same
                finding("nope.py", 10, "x = 1", "made up file"),
                finding("calc.py", 6, "eval(text)", "misquoted line"),
                finding("calc.py", 99, "return", "past the end"),
            ]})  # fmt: skip
        if "BREAK" in head and "round 1 " in head:
            await self.ask("Bash", {"command": "git push origin main"})
            await self.ask("Bash", {"command": "python -m pytest -q"})
            await self.ask("Bash", {"command": "python3 .bugfix/hostile.py"})
            await self.ask("Bash", {"command": "python3 -c 'import os'"})
            await self.ask(
                "Write", {"file_path": str(cwd / ".bugfix" / "hostile.py"), "content": ""}
            )
            await self.ask("Write", {"file_path": str(cwd / "calc.py"), "content": ""})
            (cwd / ".bugfix").mkdir(exist_ok=True)
            (cwd / ".bugfix" / "hostile.py").write_text("print('x')\n")
            return block(
                {
                    "findings": [
                        finding(
                            "calc.py",
                            6,
                            "return int(text)",
                            "parse_age crashes on text",
                            "medium",
                            "break",
                        )
                    ]
                }
            )
        if "FIX" in head and "round 1 " in head and "suite" not in head:
            (cwd / "calc.py").write_text(
                FIXED.replace(
                    "    return sum(xs) / len(xs) if xs else 0.0", "    return sum(xs) / len(xs)"
                )
            )
            (cwd / "tests" / "test_bugs.py").write_text(BUG_TESTS)
            return block({"fixes": [
                {"id": "R1-1", "status": "fixed", "test": "tests/test_bugs.py::test_divide_zero"},
                {"id": "R1-2", "status": "fixed", "test": "tests/test_bugs.py::test_parse_age_text"},
            ]})  # fmt: skip
        if "EFFICIENCY" in head and "round 1 " in head:
            (cwd / "calc.py").write_text(
                (cwd / "calc.py")
                .read_text()
                .replace("\n\n\ndef parse_age", "\n\n\n# (tidied)\ndef parse_age")
            )
            return block(
                {"changes": [{"file": "calc.py", "what": "tidied", "gain": "none really"}]}
            )
        if "BREAK" in head and "round 2 " in head:
            return block(
                {
                    "findings": [
                        finding(
                            "calc.py",
                            13,
                            "return sum(xs) / len(xs)",
                            "mean crashes on an empty list",
                        )
                    ]
                }
            )
        if "FIX" in head and "round 2 " in head:
            (cwd / "calc.py").write_text(
                FIXED.replace("def parse_age", "# (tidied)\ndef parse_age")
            )
            with (cwd / "tests" / "test_bugs.py").open("a") as f:
                f.write(MEAN_TEST)
            return block(
                {
                    "fixes": [
                        {
                            "id": "R2-3",
                            "status": "fixed",
                            "test": "tests/test_bugs.py::test_mean_one",
                        }
                    ]
                }
            )
        if "EFFICIENCY" in head and "round 2 " in head:
            (cwd / "tests" / "test_calc.py").unlink()  # a lost feature: put back
            return block(
                {
                    "changes": [
                        {
                            "file": "tests/test_calc.py",
                            "what": "removed a slow test",
                            "gain": "speed",
                        }
                    ]
                }
            )
        if "SHIP" in head:
            await self.ask("Bash", {"command": "twine upload dist/*"})
            return block({"built": False, "notes": "a library with no build step",
                          "owner_steps": ["Publish it to PyPI, if you mean to."]})  # fmt: skip
        if "SWEEP" in head or "BREAK" in head:
            return block({"findings": []})
        return block({"fixes": [], "changes": []})

    async def query(self, text):
        self.queries.append(text)
        if isinstance(text, str) and text.startswith("[Note from the app:"):
            note, text = text.split("\n\n", 1)  # (the run's rules ride along: REL-3)
            assert code_bugfix.NOTE in note
        BugClient.prompts.append(text)
        n = len(BugClient.prompts)
        head = text.split("\n", 1)[0] if isinstance(text, str) else ""
        if BugClient.hold and BugClient.hold in head:
            return  # this turn doesn't end
        reply = await self.answer(text if isinstance(text, str) else "")
        self.total = round(self.total + self.cost_each, 6)
        for m in (
            UserMessage(content=str(text), uuid=f"u-{n}"),
            AssistantMessage(content=[TextBlock(text=reply)], model="m", uuid=f"a-{n}"),
            ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False, num_turns=1,
                          session_id="bug-session", total_cost_usd=self.total, result=reply),
        ):  # fmt: skip
            self._stream().put_nowait(m)


@pytest.fixture
def projects(tmp_path):
    folder = tmp_path / "projects"
    folder.mkdir()
    return folder


@pytest.fixture
async def hub(settings, quiet_speaker, isolated, projects):
    BugClient.instances, BugClient.seen, BugClient.prompts = [], [], []
    BugClient.hold, BugClient.cost_each = None, 0.1
    hub = Hub(replace(settings, projects_dir=projects), client_factory=BugClient,
              speaker=quiet_speaker, poll=False, **isolated)  # fmt: skip
    hub.events = []
    real_emit = hub.emit

    def emit(kind, **data):
        hub.events.append((kind, data))
        real_emit(kind, **data)

    hub.emit = emit
    hub.cards, hub.answers, hub.alerts, hub.said = [], [], [], []

    def sink(card):
        hub.cards.append(card)
        if hub.answers:
            hub.resolve(card["id"], hub.answers.pop(0))

    hub.add_approval_sink(sink)
    hub.add_notify_sink(lambda alert: hub.alerts.append(alert))
    hub._say = lambda text: hub.said.append(text)
    desk = hub.code_bugfix
    desk.suites_of = lambda folder: [
        codetests.Suite("pytest", "pytest", (sys.executable, "-m", "pytest"))
    ]
    desk.env = lambda: dict(os.environ)
    yield hub
    for driver in list(desk.drivers.values()):
        driver.cancel()
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


async def until(condition, tries=6000):
    for _ in range(tries):
        if condition():
            return True
        await asyncio.sleep(0.01)
    return False


def pane(hub):
    return [d for k, d in hub.events if k == "code_bugfix"][-1]


# ── the whole protocol, end to end ──


async def test_three_rounds_sweep_break_fix_efficiency_then_ship_receipt_and_land(hub, projects):
    repo = make_repo(projects / "calc", FILES)
    desk = hub.code_bugfix
    hub.answers = ["start", "allow", "allow"]  # (the run, its .bugfix/ script's card, landing)
    said = await desk.request("calc")
    assert said == "Exterminator Mode is on for calc."
    [card] = hub.cards
    assert card["question"] == "Turn on Exterminator Mode for calc?"
    assert "3 rounds of sweep → break → fix" in card["detail"]
    assert "3 read-only audit agents at once" in card["detail"]  # (no UI: no UI auditor)
    assert "Spending ceiling for the whole run: $10.00" in card["detail"]
    assert "Haiku 4.5" in card["detail"] and "Opus 5.5" in card["detail"]
    assert "Tests: pytest." in card["detail"]
    [run] = desk.runs
    assert await until(lambda: run.state != "running"), (run.round, run.step, run.notes)
    assert run.state == "done" and run.why == "finished", run.notes

    # The session: its own isolated copy, the auditors on Haiku, read-only.
    [task] = [t for t in hub.tasks.tasks.values()]
    first = BugClient.instances[0].options
    assert set(first.agents) == {"bugfix-security", "bugfix-reliability", "bugfix-tests"}
    auditor = first.agents["bugfix-security"]
    assert auditor.model == MODELS["haiku"] and auditor.tools == ["Read", "Grep", "Glob"]
    assert first.max_budget_usd <= 10.0 and run.branch.startswith("jarvis/")
    assert "Launch these subagents in parallel" in BugClient.prompts[0]

    # The sweep's findings were checked against the files: one kept, its twin merged,
    # the made-up, misquoted and out-of-range ones dropped with why.
    by_id = {f.id: f for f in run.findings}
    assert by_id["R1-1"].where() == "calc.py:2" and by_id["R1-1"].step == "sweep"
    whys = {d.title: d.why for d in run.dropped}
    assert whys["divide crashes on zero b"] == "the same as R1-1"
    assert whys["made up file"] == "not verified: there's no such file"
    assert whys["misquoted line"] == "not verified: the code it quoted isn't at that line"
    assert whys["past the end"].startswith("not verified: the file has")
    assert by_id["R1-2"].step == "break" and by_id["R2-3"].step == "break"

    # Each fix's test was run against the code from before the fix.
    assert by_id["R1-1"].status == by_id["R1-2"].status == "verified", by_id["R1-1"].proof
    assert "failed on the code from before the fix" in by_id["R1-1"].proof
    assert by_id["R2-3"].status == "unproven"  # its test passes without the fix too
    assert "doesn't catch the bug" in by_id["R2-3"].proof

    # The guard: read-only sweep, scratch-only break, owner-only steps refused.
    seen = {(t, str(w).split("/")[-1] if t == "Write" else w): d for t, w, d in BugClient.seen}
    assert seen[("Write", "x.py")] == "PermissionResultDeny"  # the sweep is read-only
    assert seen[("Bash", "git push origin main")] == "PermissionResultDeny"
    assert seen[("Bash", "python -m pytest -q")] == "PermissionResultAllow"
    assert seen[("Bash", "python3 .bugfix/hostile.py")] == "PermissionResultAllow"  # on a card
    assert any("python3 .bugfix/hostile.py" in c.get("detail", "") for c in hub.cards)
    assert seen[("Bash", "python3 -c 'import os'")] == "PermissionResultDeny"
    assert seen[("Write", "hostile.py")] == "PermissionResultAllow"
    assert seen[("Write", "calc.py")] == "PermissionResultDeny"  # no edits while breaking
    assert seen[("Bash", "twine upload dist/*")] == "PermissionResultDeny"
    assert any("git push" in d for d in run.denied)

    # Efficiency: round 1's pass kept; round 2's deleted a test, so it was put back whole.
    assert run.efficiency["r1"]["kept"] is True
    assert run.efficiency["r2"]["kept"] is False and "tests" in run.efficiency["r2"]["lost"]
    assert "r3" not in run.efficiency  # (none after the last round)

    # Reports per round, in the project once landed; the receipt; the ship notes.
    names = sorted(Path(r).name for r in run.reports)
    assert names == sorted(
        f"{run.date}-r{n}-{s}.md" for n in (1, 2, 3) for s in ("sweep", "break", "fix")
    )
    receipts = [e for e in task.transcript if e.get("receipt", {}).get("bugfix")]
    assert receipts and receipts[-1]["receipt"]["bugfix"]["findings"] == 3
    assert "not in calc until you land it" in run.ship["source"]
    assert run.ship["built"] is False and "Not installed" in run.ship["installed"]
    assert "Publish it to PyPI, if you mean to." in run.owner_steps

    # Landing: a tap-only card with Touch ID, then the fixes are in main.
    land = hub.cards[-1]
    assert land["question"] == "Land Exterminator Mode's fixes in main?"
    assert land["touchid"] is True and land["tap_only"] is True
    assert "Yours to do: Publish it to PyPI" in land["detail"]
    assert await until(lambda: run.landed or run.notes)
    assert run.landed.startswith("Landed"), run.landed
    assert (repo / "calc.py").read_text() == FIXED.replace(
        "def parse_age", "# (tidied)\ndef parse_age"
    )
    assert (repo / "tests" / "test_calc.py").exists() and (repo / "tests" / "test_bugs.py").exists()
    assert not (repo / ".bugfix").exists()
    sweep = (repo / "docs" / "bug-sweep" / f"{run.date}-r1-sweep.md").read_text()
    assert sweep.startswith(f"# calc: bug sweep round 1, sweep, {run.date}")
    assert "| R1-1 | high | OPEN | divide crashes when b is zero |" in sweep  # (as found then)
    assert "## Dropped (4)" in sweep and "`nope.py:10` made up file" in sweep
    fix2 = (repo / "docs" / "bug-sweep" / f"{run.date}-r2-fix.md").read_text()
    assert (
        "## Efficiency pass (zero features lost)" in fix2
        and "Put back as it was: it lost tests" in fix2
    )
    assert "| R2-3 | FIXED?, NOT PROVEN (its test passes without the fix) |" in fix2
    fix1 = (repo / "docs" / "bug-sweep" / f"{run.date}-r1-fix.md").read_text()
    assert "| R1-1 | FIXED, VERIFIED (its test failed first) |" in fix1
    assert [a for a in hub.alerts if a.title == "Exterminator Mode"][0].text.startswith(
        "Exterminator Mode in calc is done: 3 findings"
    )
    assert not [
        a for a in hub.alerts if a.key.startswith(f"code:{task.id}:")
    ]  # (no second heads-up)
    assert pane(hub)["runs"][0]["state"] == "done" and pane(hub)["active"] == {}


async def test_the_spending_ceiling_stops_the_run(hub, projects, monkeypatch):
    make_repo(projects / "calc", FILES)
    desk = hub.code_bugfix
    BugClient.cost_each = 0.6
    hub.answers = ["start", "deny"]  # (the run; its .bugfix/ script's card, if it gets that far)
    assert await desk.request("calc", 1) == "Exterminator Mode is on for calc."
    assert "Spending ceiling for the whole run: $1.00" in hub.cards[0]["detail"]
    [run] = desk.runs
    assert await until(lambda: run.state != "running")
    assert run.state == "stopped" and run.why == "spend" and run.round == 1 and run.step == "break"
    assert BugClient.instances[0].options.max_budget_usd <= 1.0
    [alert] = [a for a in hub.alerts if a.title == "Exterminator Mode"]
    assert alert.text == "Exterminator Mode in calc stopped: the spending ceiling was reached."
    assert await desk.request("calc", 500) == "The spending ceiling is between $1 and $50."


async def test_no_card_yes_means_nothing_starts_and_a_plain_folder_says_why(hub, projects):
    desk = hub.code_bugfix
    make_repo(projects / "calc", FILES)
    hub.answers = ["deny"]
    assert await desk.request("calc") == "Not started."
    assert hub.tasks.tasks == {} and desk.runs == []
    (projects / "plain").mkdir()
    assert (
        await desk.request("plain")
        == "plain isn't a git repository, so Exterminator Mode can't have its isolated copy."
    )


async def test_stop_then_resume_after_a_restart_carries_on_from_its_step(
    hub, projects, monkeypatch
):
    monkeypatch.setattr(code_bugfix, "ROUNDS", 1)
    make_repo(projects / "calc", FILES)
    desk = hub.code_bugfix
    BugClient.hold = "BREAK"
    hub.answers = ["start"]
    await desk.request("calc")
    [run] = desk.runs
    assert await until(lambda: run.step == "break" and len(BugClient.prompts) == 2)
    assert [f.id for f in run.findings] == ["R1-1"]
    # The app quits mid-step: the run's kept as running; at the next start it's paused.
    desk.drivers[run.id].cancel()
    handle = hub.tasks.tasks[run.task_id].handle
    hub.tasks.cancel(run.task_id)
    await asyncio.wait([handle], timeout=5)
    desk.save()
    desk._loaded, desk.runs, desk.active, desk.waiting = False, [], {}, {}
    desk.load()
    [again] = desk.runs
    assert (again.state, again.why, again.step) == ("paused", "restart", "break")
    assert [f.id for f in again.findings] == ["R1-1"] and again.folder
    # Resume: the same copy and conversation, from the break step.
    BugClient.hold = None
    hub.answers = ["allow", "deny"]  # (its .bugfix/ script's card; not landing, this time)
    assert await desk.resume(again.id) == "Resumed Exterminator Mode."
    assert await until(lambda: again.state != "running"), again.notes
    assert again.state == "done", again.notes
    newest = BugClient.instances[-1].options
    assert newest.resume == "bug-session" and newest.cwd == again.folder
    heads = [p.split("\n", 1)[0] for p in BugClient.prompts]
    assert heads[2] == "Exterminator Mode · round 1 of 1 · BREAK"  # (not the sweep again)
    assert {f.id for f in again.findings} == {"R1-1", "R1-2"}
    assert (
        not again.landed and hub.cards[-1]["question"] == "Land Exterminator Mode's fixes in main?"
    )
    assert Path(again.folder).is_dir()  # not landed: the copy is kept, to land later


async def test_stop_ends_the_run_where_it_is(hub, projects):
    make_repo(projects / "calc", FILES)
    desk = hub.code_bugfix
    BugClient.hold = "SWEEP"
    hub.answers = ["start"]
    await desk.request("calc")
    [run] = desk.runs
    assert await until(lambda: len(BugClient.prompts) == 1)
    assert await desk.stop(run.id) == "Stopped Exterminator Mode."
    assert await until(lambda: run.state == "stopped")
    assert run.why == "owner" and run.step == "sweep"
    assert await desk.stop(run.id) == "Exterminator Mode isn't running there."
    assert pane(hub)["runs"][0]["state"] == "stopped"


# ── the pieces ──


def test_a_finding_is_kept_only_when_the_file_says_so(tmp_path):
    (tmp_path / "a.py").write_text("x = 1\ny = open(path).read()\nz = 3\nw = 4\nv = 5\n")
    ok = {
        "file": "./a.py",
        "line": 2,
        "severity": "high",
        "title": "t",
        "scenario": "a missing path crashes it",
        "quote": "open(path).read()",
    }
    item, why = check_finding(tmp_path, ok)
    assert why == "" and item["file"] == "a.py" and item["line"] == 2
    assert check_finding(tmp_path, {**ok, "line": 4})[0] is not None  # (within QUOTE_SLACK)
    assert (
        check_finding(tmp_path, {**ok, "file": "../a.py"})[1] == "the file is outside the project"
    )
    assert check_finding(tmp_path, {**ok, "severity": "urgent"})[1].startswith("no severity")
    assert check_finding(tmp_path, {**ok, "scenario": "bad"})[1] == "no concrete failure scenario"
    assert (
        check_finding(tmp_path, {**ok, "quote": ""})[1]
        == "not verified: it quoted no code from that line"
    )
    assert check_finding(tmp_path, {**ok, "line": 0})[1].startswith(
        "not verified: the file has 5 lines"
    )


def test_parse_block_reads_the_last_bugfix_block():
    assert parse_block('x\n```bugfix\n{"a": 1}\n```\nmore\n```bugfix\n{"b": 2}\n```') == {"b": 2}
    assert parse_block("no block") is None and parse_block("```bugfix\nnot json\n```") is None


def test_the_stack_its_commands_and_what_is_the_owners(tmp_path):
    (tmp_path / "package.json").write_text(json.dumps({
        "name": "app", "version": "1.0.0", "scripts": {"build": "vite build", "dev": "vite"},
        "dependencies": {"react": "19"}}))  # fmt: skip
    (tmp_path / "wrangler.toml").write_text("")
    (tmp_path / ".env.example").write_text("KEY=\n")
    stack = detect_stack(tmp_path)
    assert stack["kinds"] == ["node", "web"] and stack["ui"] and stack["dev"]
    assert stack["build"] == ["npm run build"]
    assert any("npm publish" in s for s in stack["owner"]) and any(
        "wrangler" in s for s in stack["owner"]
    )
    assert command_allowed(stack, "npm test") and command_allowed(stack, "npm run build")
    assert not command_allowed(stack, "node .bugfix/flood.mjs")  # (its own script: a card)
    assert scratch_script(stack, "node .bugfix/flood.mjs")
    assert not scratch_script(stack, "node .bugfix/../x.js")
    for no in (
        "node x.js",
        "npm test | tail",
        "node .bugfix/../x.js",
        "npm install left-pad",
        "bash",
    ):
        assert not command_allowed(stack, no), no
    for mine in ("git push", "git -C . push origin", "npm publish", "xcrun notarytool submit x", "wrangler deploy",
                 "codesign -s me x.app", "fastlane beta", "node scripts/sync-eden.mjs"):  # fmt: skip
        assert owner_only(mine), mine
    assert risky("rm -rf build") and risky("curl https://x") and not risky("npm test")
    assert detect_stack(tmp_path / "nothing")["kinds"] == ["other"]


def test_the_inventory_lists_routes_and_commands_and_what_was_lost(tmp_path):
    (tmp_path / "app.py").write_text(
        '@app.get("/users")\ndef u(): ...\nhub.register_command("x_go", f)\n'
    )
    (tmp_path / "srv.js").write_text("router.post('/login', h)\nipcMain.handle('win:open', f)\n")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "dep.js").write_text("app.get('/hidden', h)\n")
    (tmp_path / "package.json").write_text(json.dumps({"scripts": {"test": "x"}}))
    found = inventory(tmp_path)
    assert found["routes"] == ["app.py /users", "srv.js /login"]
    assert found["commands"] == ["npm run test", "win:open", "x_go"]
    before = {"tests": ["a", "b"], **found}
    after = {"tests": ["a"], "routes": ["app.py /users"], "commands": found["commands"]}
    assert lost(before, after) == {"tests": ["b"], "routes": ["srv.js /login"]}
    assert lost(before, before) == {}


async def test_models_go_by_the_router_cheapest_that_does_the_job(hub, monkeypatch):
    desk = hub.code_bugfix
    assert desk.models("calc")[:2] == ("haiku", "opus")
    events = hub.code_router_events
    monkeypatch.setattr(events, "budget_state", lambda: {"fraction": 0.9})
    sweep, fix, why = desk.models("calc")
    assert (sweep, fix) == ("haiku", "sonnet") and "90% used" in why
    hub.prefs.features[code_bugfix.PREF_MODELS] = {"sweep": "sonnet", "fix": "opus"}
    assert desk.models("calc")[:2] == ("sonnet", "opus")


async def test_voice_turns_it_on_and_off(hub, monkeypatch):
    desk = hub.code_bugfix
    asked = []

    async def request(project, spend_cap=None, *, speak=False):
        asked.append((project, speak))
        return "ok"

    async def stop(run_id="", project=""):
        asked.append(("stop", project))
        return "stopped"

    monkeypatch.setattr(desk, "request", request)
    monkeypatch.setattr(desk, "stop", stop)
    assert await desk.instant("Eden, bug fix mode on alpha") == "ok"
    assert await desk.instant("bug-fix mode for the project Ask Eden.") == "ok"
    assert await desk.instant("bug fix mode off") == "stopped"
    assert await desk.instant("stop bug fix mode in alpha") == "stopped"
    assert await desk.instant("alpha 打开修bug模式") == "ok"
    assert await desk.instant("Eden, exterminator mode on beta") == "ok"
    assert await desk.instant("exterminator mode off") == "stopped"
    assert await desk.instant("turn off exterminator mode in beta") == "stopped"
    assert await desk.instant("给 beta 打开灭虫模式") == "ok"
    assert await desk.instant("关闭灭虫模式") == "stopped"
    assert await desk.instant("what's the weather") is None
    assert asked == [
        ("alpha", True),
        ("Ask Eden", True),
        ("stop", ""),
        ("stop", "alpha"),
        ("alpha", True),
        ("beta", True),
        ("stop", ""),
        ("stop", "beta"),
        ("beta", True),
        ("stop", ""),
    ]


async def test_a_run_that_cant_have_its_copy_never_starts_in_the_shared_folder(hub, projects):
    from jarvis.tasks import ClaudeTask

    desk = hub.code_bugfix
    task = ClaudeTask(id=9, prompt="x", cwd=projects)
    desk.active[9] = BugRun("r1", "calc")

    async def inner(_task):
        return None

    with pytest.raises(RuntimeError, match="needs an isolated copy"):
        await desk.prepare(inner)(task)
    task.workspace = {"slug": "s"}
    await desk.prepare(inner)(task)
    assert "this is Exterminator Mode" in desk.turn_note(None)(task)
    del desk.active[9]
    assert desk.turn_note(lambda t: "x")(task) == "x"


async def test_a_risky_step_goes_to_the_owners_card(hub, projects):
    from jarvis.tasks import ClaudeTask

    desk = hub.code_bugfix
    task = ClaudeTask(id=7, prompt="x", cwd=projects, mode="edits", allow_edits=True)
    run = BugRun("r1", "calc", step="fix", stack={"kinds": ["python"]})
    desk.active[7] = run
    asked = []

    async def inner(name, data, ctx):
        asked.append(data.get("command"))
        return PermissionResultAllow()

    guard = desk.guard(task, inner)
    assert isinstance(await guard("Bash", {"command": "rm -rf build"}, None), PermissionResultAllow)
    assert asked == ["rm -rf build"]  # the session's own card asked
    assert isinstance(await guard("Bash", {"command": "git push"}, None), PermissionResultDeny)
    assert isinstance(await guard("AskUserQuestion", {}, None), PermissionResultDeny)
    assert isinstance(
        await guard("Agent", {"subagent_type": "bugfix-security"}, None), PermissionResultAllow
    )
    del desk.active[7]
    await guard("Bash", {"command": "git push"}, None)  # the run's over: the session's own policy
    assert asked[-1] == "git push"


# ── an efficiency pass that ends before its check (round 1's D2) ──


async def _mid_efficiency(hub, projects, monkeypatch):
    """A two-round run held in round 1's efficiency pass, whose session has already made
    edits Eden hasn't checked: one that breaks calc.py, one that deletes a test."""
    monkeypatch.setattr(code_bugfix, "ROUNDS", 2)
    repo = make_repo(projects / "calc", FILES)
    desk = hub.code_bugfix
    BugClient.hold = "EFFICIENCY"
    hub.answers = ["start", "allow"]  # (the run, its .bugfix/ script's card)
    await desk.request("calc")
    [run] = desk.runs
    assert await until(
        lambda: (
            run.step == "efficiency"
            and any("EFFICIENCY" in p.split("\n", 1)[0] for p in BugClient.prompts)
        )
    ), (run.step, run.notes)
    copy = Path(run.folder)
    checked = (copy / "calc.py").read_text()
    (copy / "calc.py").write_text("def divide(a, b):\n    return 0\n")
    (copy / "tests" / "test_calc.py").unlink()
    return repo, desk, run, copy, checked


async def _quit_and_reload(hub, desk, run):
    desk.drivers[run.id].cancel()
    handle = hub.tasks.tasks[run.task_id].handle
    hub.tasks.cancel(run.task_id)
    await asyncio.wait([handle], timeout=5)
    desk.save()
    desk._loaded, desk.runs, desk.active, desk.waiting = False, [], {}, {}
    desk.load()
    [again] = desk.runs
    assert (again.state, again.step) == ("paused", "efficiency")
    return again


async def test_an_efficiency_pass_stopped_before_its_check_is_put_back_and_never_lands(
    hub, projects, monkeypatch
):
    repo, desk, run, copy, checked = await _mid_efficiency(hub, projects, monkeypatch)
    assert await desk.stop(run.id) == "Stopped Exterminator Mode."
    await asyncio.wait([desk.drivers[run.id]], timeout=10)
    assert run.state == "stopped"
    assert (copy / "calc.py").read_text() == checked
    assert (copy / "tests" / "test_calc.py").exists()
    verdict = run.efficiency["r1"]
    assert verdict["kept"] is False and verdict["restored"] is True
    assert "before Eden could check it" in verdict["why"]
    cards = len(hub.cards)
    assert await desk.land(run.id) == "Only a run that finished can land: resume it first."
    assert len(hub.cards) == cards and not run.landed  # (no card: its fixes weren't all checked)
    assert (repo / "calc.py").read_text() == CALC


async def test_a_run_paused_or_stopping_mid_way_never_lands_and_never_resumes_twice(
    hub, projects, monkeypatch
):
    repo, desk, run, copy, checked = await _mid_efficiency(hub, projects, monkeypatch)
    again = await _quit_and_reload(hub, desk, run)
    hub.answers = ["allow"]
    assert await desk.land(again.id) == "Only a run that finished can land: resume it first."
    assert not again.landed and (repo / "tests" / "test_calc.py").exists()
    again.state = "stopping"  # (Stop pressed, its driver not done yet)
    assert await desk.resume(again.id) == "That run can't be resumed."
    again.state = "paused"
    pending = asyncio.get_running_loop().create_future()
    desk.drivers[again.id] = pending  # (an old driver still going)
    assert await desk.resume(again.id) == "That run can't be resumed."
    pending.cancel()


async def test_a_resumed_efficiency_pass_is_checked_against_the_point_it_started_from(
    hub, projects, monkeypatch
):
    repo, desk, run, copy, checked = await _mid_efficiency(hub, projects, monkeypatch)
    again = await _quit_and_reload(hub, desk, run)
    BugClient.hold = None
    hub.answers = ["deny"]
    assert await desk.resume(again.id) == "Resumed Exterminator Mode."
    assert await until(lambda: again.state != "running"), again.notes
    verdict = again.efficiency["r1"]
    assert verdict["kept"] is False and "tests" in verdict["lost"], verdict
    assert verdict["restored"] is True
    assert (copy / "tests" / "test_calc.py").exists()  # back from before the pass, not after


async def test_what_a_step_spent_before_the_app_quit_counts_after_a_resume(
    hub, projects, monkeypatch
):
    """Round 1's D4: the step's spend so far is counted when the app quits mid-step, so a
    resumed run's ceiling is what's left, not a fresh one."""
    monkeypatch.setattr(code_bugfix, "ROUNDS", 1)
    make_repo(projects / "calc", FILES)
    desk = hub.code_bugfix
    BugClient.hold = "BREAK"
    hub.answers = ["start"]
    await desk.request("calc", 2)
    [run] = desk.runs
    assert await until(lambda: run.step == "break" and len(BugClient.prompts) == 2)
    task = hub.tasks.tasks[run.task_id]
    task.cost_usd = round((task.cost_usd or 0) + 1.5, 6)  # the break step's work so far
    desk.drivers[run.id].cancel()
    await asyncio.wait([desk.drivers[run.id]], timeout=5)
    handle = task.handle
    hub.tasks.cancel(run.task_id)
    await asyncio.wait([handle], timeout=5)
    desk._loaded, desk.runs, desk.active, desk.waiting = False, [], {}, {}
    desk.load()
    [again] = desk.runs
    assert again.spent == pytest.approx(1.6)  # the sweep's 0.1 and the break's 1.5
    BugClient.hold = None
    hub.answers = ["allow", "deny"]  # (its .bugfix/ script's card; not landing)
    assert await desk.resume(again.id) == "Resumed Exterminator Mode."
    assert await until(lambda: again.state != "running"), again.notes
    assert BugClient.instances[-1].options.max_budget_usd <= 0.4 + 1e-9


def test_a_session_s_spend_is_counted_once_however_many_turns_it_had(hub):
    from jarvis.tasks import ClaudeTask

    desk = hub.code_bugfix
    run = BugRun("r1", "calc", spend_cap=10.0)
    task = ClaudeTask(id=5, prompt="", cwd=Path("."))
    task.cost_usd = 1.0
    desk.account(run, task)
    task.cost_usd = 3.0
    desk.account(run, task)
    assert run.spent == pytest.approx(3.0)
    options = type(
        "O", (), {"max_budget_usd": None, "agents": None, "can_use_tool": None, "sandbox": None}
    )()
    desk.extend(run, task, options)
    assert options.max_budget_usd == pytest.approx(7.0)  # not 10 - 3 - 3


async def test_with_every_feature_installed_a_run_whose_copy_fails_never_touches_the_project(
    hub, projects, monkeypatch
):
    """Every feature installed (code_isolation after code_bugfix): when the isolated copy
    can't be made, the run refuses to start its steps, and the owner's checkout is as it was
    (no edits, no snapshot staged in its index, nothing put back over it)."""
    import subprocess

    repo = make_repo(projects / "calc", FILES)
    (repo / "notes.txt").write_text("the owner's own, not committed\n")

    async def no_copy(task):
        return None  # (code_isolation leaves the session in the folder, with a note)

    monkeypatch.setattr(hub.code_desk, "isolate", no_copy)
    desk = hub.code_bugfix
    hub.answers = ["start"]
    await desk.request("calc")
    [run] = desk.runs
    assert await until(lambda: run.state != "running"), (run.step, run.notes)
    assert run.state == "stopped" and not run.slug
    assert not [p for p in BugClient.prompts if "SWEEP" not in p.split("\n", 1)[0]]
    assert (repo / "calc.py").read_text() == CALC
    assert (repo / "notes.txt").exists()
    staged = subprocess.run(["git", "diff", "--cached", "--name-only"], cwd=repo,
                            capture_output=True, text=True).stdout  # fmt: skip
    assert staged == ""


async def test_a_run_quit_in_its_ship_step_resumes_at_ship_not_the_last_round(
    hub, projects, monkeypatch
):
    """Round 1's D5."""
    monkeypatch.setattr(code_bugfix, "ROUNDS", 1)
    make_repo(projects / "calc", FILES)
    desk = hub.code_bugfix
    BugClient.hold = "SHIP"
    hub.answers = ["start", "allow"]  # (the run, its .bugfix/ script's card)
    await desk.request("calc")
    [run] = desk.runs
    assert await until(lambda: run.step == "ship" and "SHIP" in BugClient.prompts[-1][:40])
    desk.drivers[run.id].cancel()
    handle = hub.tasks.tasks[run.task_id].handle
    hub.tasks.cancel(run.task_id)
    await asyncio.wait([handle], timeout=5)
    desk.save()
    desk._loaded, desk.runs, desk.active, desk.waiting = False, [], {}, {}
    desk.load()
    [again] = desk.runs
    assert (again.state, again.step) == ("paused", "ship")
    asked = len(BugClient.prompts)
    BugClient.hold = None
    hub.answers = ["deny"]
    assert await desk.resume(again.id) == "Resumed Exterminator Mode."
    assert await until(lambda: again.state != "running"), again.notes
    heads = [p.split("\n", 1)[0] for p in BugClient.prompts[asked:]]
    assert heads and set(heads) == {"Exterminator Mode · SHIP"}, heads  # (no round again)
    assert again.state == "done"


async def test_a_run_quit_in_its_first_sweep_knows_its_copy_and_can_resume(
    hub, projects, monkeypatch
):
    """Round 1's D6: the copy is the run's as soon as it's made, not after the first turn."""
    monkeypatch.setattr(code_bugfix, "ROUNDS", 1)
    make_repo(projects / "calc", FILES)
    desk = hub.code_bugfix
    BugClient.hold = "SWEEP"
    hub.answers = ["start"]
    await desk.request("calc")
    [run] = desk.runs
    assert await until(lambda: len(BugClient.prompts) == 1)
    desk.drivers[run.id].cancel()
    handle = hub.tasks.tasks[run.task_id].handle
    hub.tasks.cancel(run.task_id)
    await asyncio.wait([handle], timeout=5)
    desk._loaded, desk.runs, desk.active, desk.waiting = False, [], {}, {}
    desk.load()  # (what was saved when the copy was made: no other save since)
    [again] = desk.runs
    assert again.slug and again.folder and Path(again.folder).is_dir()
    BugClient.hold = None
    hub.answers = ["deny"]
    assert await desk.resume(again.id) == "Resumed Exterminator Mode."
    assert await until(lambda: again.state != "running"), again.notes
    assert again.state == "done", again.notes


async def test_two_starts_on_one_project_at_once_start_one_run(hub, projects):
    """Round 1's D7: the second start, asked while the first's card is up, is refused."""
    make_repo(projects / "calc", FILES)
    desk = hub.code_bugfix
    BugClient.hold = "SWEEP"
    hub.answers = ["start", "start"]
    said = await asyncio.gather(desk.request("calc"), desk.request("calc"))
    assert sorted(said) == [
        "Exterminator Mode is already on for calc.",
        "Exterminator Mode is on for calc.",
    ]
    assert len(desk.runs) == 1 and len(hub.cards) == 1


async def test_stop_while_the_suite_runs_stops_it_now(hub, projects, monkeypatch):
    """Round 1's D9: Stop during the break step's suite run (up to 30 minutes) ends it."""
    monkeypatch.setattr(code_bugfix, "ROUNDS", 1)
    make_repo(projects / "calc", FILES)
    desk = hub.code_bugfix
    slow = codetests.Suite("slow", "slow", (sys.executable, "-c", "import time; time.sleep(60)"))
    desk.suites_of = lambda folder: [slow]
    hub.answers = ["start"]
    await desk.request("calc")
    [run] = desk.runs
    assert await until(lambda: run.id in desk.suite_runs), (run.step, run.notes)
    assert await desk.stop(run.id) == "Stopped Exterminator Mode."
    assert await until(lambda: run.state == "stopped", tries=500), run.step
    assert run.why == "owner" and run.step == "break"
    assert len(BugClient.prompts) == 1  # (the break step's turn never came)


async def test_stop_during_a_hung_suite_kills_it_and_resume_waits_for_the_stop(
    hub, projects, tmp_path
):
    """Round 1's break: the project's own suite hangs in the break step; Stop ends it (the
    run is stopped, its pytest gone) and the run resumes once, with one driver."""
    import signal

    pidfile = tmp_path / "suite.pid"
    files = {**FILES, "tests/test_hang.py": (
        "import os, time\n\n\ndef test_hang():\n"
        f"    open({str(pidfile)!r}, 'a').write(str(os.getpid()) + '\\n')\n"
        "    time.sleep(10000)\n"
    )}  # fmt: skip
    make_repo(projects / "calc", files)
    desk = hub.code_bugfix
    hub.answers = ["start"]
    await desk.request("calc")
    [run] = desk.runs
    pids = []
    try:
        assert await until(lambda: pidfile.exists() and pidfile.read_text().strip())
        pids = [int(p) for p in pidfile.read_text().split()]
        await hub._handle({"type": "code_bugfix_stop", "run": run.id})
        assert await until(lambda: run.state == "stopped", tries=800), run.state
        assert await until(lambda: not _alive(pids[0]), tries=800)
        old = desk.drivers[run.id]
        assert old.done()
        BugClient.hold = "SWEEP"
        assert await desk.resume(run.id) == "Resumed Exterminator Mode."
        assert await desk.resume(run.id) == "That run can't be resumed."  # (one driver only)
        await desk.stop(run.id)
    finally:
        for p in pids:
            with contextlib.suppress(OSError):
                os.kill(p, signal.SIGKILL)


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@pytest.mark.parametrize(
    "text",
    [
        '{"findings": [{"file": "calc.py", "line": Infinity, "title": "t", "severity": "high", '
        '"scenario": "a long enough scenario", "quote": "x"}]}',
        '{"findings": [{"file": "calc.py", "line": 1e400, "title": "t", "severity": "high", '
        '"scenario": "a long enough scenario", "quote": "x"}]}',
        '{"findings": 5}',
        '{"findings": true}',
        '{"findings": {"a": 1}}',
    ],
)
def test_a_hostile_bugfix_block_is_dropped_not_a_crash(hub, tmp_path, text):
    """Round 1's break: Infinity, 1e400 and non-lists in the model's block."""
    (tmp_path / "calc.py").write_text("x = 1\n")
    run = BugRun(id="r", project="p")
    hub.code_bugfix.take_findings(run, tmp_path, "sweep", f"```bugfix\n{text}\n```")
    assert run.findings == []
    for key in ("fixes", "changes", "owner_steps"):
        assert code_bugfix.listed(parse_block(f'```bugfix\n{{"{key}": 7}}\n```'), key) == []


async def test_a_ceiling_of_true_is_refused(hub, projects):
    make_repo(projects / "calc", FILES)
    hub.answers = ["deny"] * 5  # (were one taken, its card says no rather than waiting)
    for cap in (True, False, 10**400, float("nan"), float("inf")):
        assert (
            await hub.code_bugfix.request("calc", cap)
            == "The spending ceiling is between $1 and $50."
        )


async def test_a_fix_s_test_outside_its_copy_is_never_run(hub, tmp_path):
    from jarvis.features.code_bugfix import Finding

    folder = tmp_path / "copy"
    folder.mkdir()
    (tmp_path / "elsewhere.py").write_text("x = 1\n")
    ran = []

    async def run_one(*args, **kwargs):
        ran.append(args)

    hub.code_bugfix.run_one = run_one
    suite = codetests.Suite("pytest", "pytest", (sys.executable, "-m", "pytest"))
    for spec in ("../elsewhere.py", str(tmp_path / "elsewhere.py")):
        f = Finding("R1-1", 1, "sweep", "x", "high", "a.py", 1, "t", "s", test=spec)
        await hub.code_bugfix.prove_one(f, folder, tmp_path, [suite])
        assert f.status == "unproven" and "isn't in the project" in f.proof
    assert ran == []


def test_an_unreadable_runs_file_is_never_saved_over(tmp_path):
    from types import SimpleNamespace

    kept = tmp_path / "code_bugfix.json"
    kept.write_text(json.dumps({"runs": [], "mark": "KEEP-ME"}))
    os.chmod(kept, 0)
    try:
        desk = code_bugfix.BugFix(
            SimpleNamespace(feature_path=lambda name: tmp_path / name, emit=lambda *a, **k: None)
        )
        desk.save()
        desk.save()
    finally:
        for f in tmp_path.iterdir():
            os.chmod(f, 0o600)
    assert "KEEP-ME" in kept.read_text()


async def test_bug_fix_mode_runs_no_code_of_its_own_choosing_unasked(hub, projects):
    """B6: a runner on a .bugfix/ script, a stack command with an option that runs another
    program, and the dev server's start all went ahead with no card, outside any sandbox."""
    from jarvis.tasks import ClaudeTask

    desk = hub.code_bugfix
    task = ClaudeTask(id=8, prompt="x", cwd=projects, mode="edits", allow_edits=True)
    run = BugRun("r1", "calc", step="break", stack={"kinds": ["python", "node", "go", "rust"]})
    desk.active[8] = run
    for card in (
        "python .bugfix/p.py",
        "node .bugfix/flood.mjs",
    ):
        assert desk.refusal(run, task, "Bash", {"command": card}) == "card", card
    for no in (
        "node --test --import ./.bugfix/x.mjs",
        "node --test --import=./.bugfix/x.mjs",
        "node --test --require ./x.js",
        "go test -exec /bin/sh ./...",
        "go test -toolexec=/bin/sh ./...",
        "npm test --script-shell=/bin/sh",
        "cargo test --config target.x.runner='sh'",
        "pytest -p evil_plugin",
        "uv run pytest -pevil",
        "python .bugfix/p.py -e x",
    ):
        assert desk.refusal(run, task, "Bash", {"command": no}) not in (None, "card"), no
    for fine in ("pytest -q", "go test -p 4 ./...", "cargo test -p core", "node --test"):
        assert desk.refusal(run, task, "Bash", {"command": fine}) is None, fine
    assert desk.refusal(run, task, "mcp__jarvis_dev__dev_server_start", {"name": "web"}) == "card"
    assert desk.refusal(run, task, "mcp__jarvis_dev__dev_server_logs", {"name": "web"}) is None

    class Options:
        max_budget_usd = None
        agents = None
        sandbox = {"enabled": True, "network": {"allowUnixSockets": ["/tmp/d.sock"],
                                                "allowedDomains": ["pypi.org"]}}  # fmt: skip

        @staticmethod
        async def can_use_tool(*_):
            return PermissionResultAllow()

    options = Options()
    desk.extend(run, task, options)
    assert options.sandbox["enabled"] and options.sandbox["allowUnsandboxedCommands"] is False
    assert options.sandbox["network"]["allowedDomains"] == []  # no network
    assert options.sandbox["network"]["allowUnixSockets"] == ["/tmp/d.sock"]
    del desk.active[8]


@pytest.mark.parametrize(
    "command",
    [
        "pytest --basetemp=/Users/someone/Documents",  # pytest empties its basetemp first
        "uv run pytest --basetemp=/tmp/anything",
        "ruff check --fix /Users/someone/other-project",
        "npm test --prefix /Users/someone/other-project",
        "npm test --prefix ../other-project",
        "go test -exec /bin/rm ./...",
        "python3 -m compileall -f /",
        "node --test --import=/tmp/evil.mjs",
        "xcodebuild test -project /elsewhere/App.xcodeproj",
        "pytest ~/elsewhere",
    ],
)
def test_a_stack_command_naming_a_path_outside_the_copy_is_refused(command):
    """B6 (round-1 break): the allow-list matched only the leading words, so these ran with
    no card in the break step."""
    stack = {"kinds": ["python", "node", "go", "xcode"]}
    assert not command_allowed(stack, command) and not scratch_script(stack, command)


async def test_the_sweep_runs_no_command_at_all(hub, projects):
    """B6: "ruff check --fix" (a stack command) went ahead even in the read-only sweep."""
    from jarvis.tasks import ClaudeTask

    desk = hub.code_bugfix
    task = ClaudeTask(id=10, prompt="x", cwd=projects, mode="edits", allow_edits=True)
    run = BugRun("r1", "calc", step="sweep", stack={"kinds": ["python"]})
    for command in ("ruff check --fix .", "pytest -q", "ls"):
        assert desk.refusal(run, task, "Bash", {"command": command}) not in (None, "card")
    run.step = "break"
    assert desk.refusal(run, task, "Bash", {"command": "pytest -q"}) is None


@pytest.mark.parametrize(
    "rule,command,why",
    [
        ("Bash(git push:*)", "git push origin main", "owner's to do"),
        ("Bash(rm:*)", "rm -rf src", "card"),
        ("Bash(security:*)", "security find-generic-password -s x -w", "owner's to do"),
        ("Bash(npm publish:*)", "npm publish", "owner's to do"),
    ],
)
async def test_an_allow_rule_never_beats_the_runs_owner_only_and_risky_lists(
    hub, projects, rule, command, why
):
    """G5: refusal() asked the owner's rules (and the mode) first, so an allow rule such as
    Bash(git push:*) let git push, rm -rf, security … or npm publish go ahead unasked in
    Exterminator Mode. Its owner-only list refuses them, and a risky one gets a card (Yes
    or No only) even when a rule or the mode would let it by."""
    from jarvis.tasks import ClaudeTask

    desk = hub.code_bugfix
    task = ClaudeTask(id=9, prompt="", cwd=projects, mode="ask")
    hub.tasks.tasks[9] = task
    run = BugRun("r", "p", folder=str(projects), step="fix", stack={"kinds": ["python", "node"]})
    desk.active[9] = run
    await hub.handle({"type": "cr_add", "id": 9, "behavior": "allow", "rule": rule})
    assert hub.tasks._goes_ahead(task, "Bash", {"command": command}) is not None  # (the rule)
    said = desk.refusal(run, task, "Bash", {"command": command})
    assert said is not None and why in said, said
    if said != "card":
        del desk.active[9]
        return
    asked = []

    async def approve(question, detail, choices, context=None):
        asked.append([c for c, _ in choices])
        return "deny"

    async def inner(*_):
        return PermissionResultAllow()  # (what the session's own policy would say: the rule)

    hub.tasks.approve = approve
    out = await desk.guard(task, inner)("Bash", {"command": command}, None)
    assert isinstance(out, PermissionResultDeny) and asked == [["allow", "deny"]]
    del desk.active[9]


async def test_a_run_gets_no_web_no_owner_settings_and_no_mcp_but_its_dev_servers(hub, projects):
    """R2-10: an Exterminator run kept WebSearch (one of tasks.FREE_TOOLS, so it went
    ahead), the owner's user settings (hooks, permissions, MCP servers) and every MCP
    server the session had. Now: the project's settings only, jarvis_dev alone, no web."""
    from claude_agent_sdk import ClaudeAgentOptions

    from jarvis.tasks import ClaudeTask

    desk = hub.code_bugfix
    task = ClaudeTask(id=10, prompt="", cwd=projects, mode="ask")
    run = BugRun("r", "p", folder=str(projects), step="fix", stack={"kinds": ["python"]})
    desk.active[10] = run

    async def inner(*_):
        return PermissionResultAllow()

    options = ClaudeAgentOptions(
        setting_sources=["user", "project", "local"],
        mcp_servers={"jarvis_dev": {"type": "sdk"}, "jarvis_browser": {}, "owners_slack": {}},
        allowed_tools=[
            "TodoWrite",
            "mcp__jarvis_browser__read",
            "mcp__jarvis_dev__dev_server_list",
        ],
        disallowed_tools=["mcp__off"],
        can_use_tool=inner,
    )
    desk.extend(run, task, options)
    assert options.setting_sources == ["project", "local"]
    assert list(options.mcp_servers) == ["jarvis_dev"] and options.strict_mcp_config
    assert options.allowed_tools == ["TodoWrite", "mcp__jarvis_dev__dev_server_list"]
    assert {"WebSearch", "WebFetch", "mcp__off"} <= set(options.disallowed_tools)
    for tool in ("WebSearch", "WebFetch", "mcp__owners_slack__post", "mcp__jarvis_browser__click"):
        why = desk.refusal(run, task, tool, {"query": "x"})
        assert why not in (None, "card"), (tool, why)
    assert desk.refusal(run, task, "mcp__jarvis_dev__dev_server_logs", {"name": "web"}) is None
    del desk.active[10]


async def test_a_resumed_runs_earlier_spend_is_not_counted_twice(hub, projects, monkeypatch):
    """REL-5: a resumed run's session took its first cost report (Claude Code's running
    total for the conversation, the spend before the resume included) as its own: $3 then
    a $0.40 turn counted $6.40, and the run stopped early at its ceiling."""
    from jarvis.tasks import ClaudeTask

    desk = hub.code_bugfix
    run = BugRun("r1", "calc", spend_cap=5.0, session_id="sess-1")
    first = ClaudeTask(id=1, prompt="", cwd=projects)
    hub.tasks._count_cost(first, 3.0)
    desk.account(run, first)  # (the app quit: accounted)
    assert run.spent == 3.0
    resumed = ClaudeTask(id=2, prompt="", cwd=projects, cost_unknown=True)
    monkeypatch.setattr(hub.tasks, "start", lambda *a, **k: resumed)
    monkeypatch.setattr(desk, "save", lambda: None)
    assert desk.open_session(run, str(projects), "", resume="sess-1") is resumed
    hub.tasks._count_cost(resumed, 3.4)  # its first report: the conversation's total
    desk.account(run, resumed)
    assert run.spent == 3.4
    hub.tasks._count_cost(resumed, 3.5)
    desk.account(run, resumed)
    assert run.spent == 3.5
    desk.active.pop(2, None)


async def test_a_run_saved_while_stopping_can_resume_after_a_restart(hub, projects):
    """REL-12: only "running" was put right on load; a run saved while "stopping" (another
    run's save) stayed so for good: never resumed, never landed."""
    desk = hub.code_bugfix
    desk.load()
    run = BugRun("r1", "calc", spend_cap=5.0, folder=str(projects), slug="s1", state="stopping")
    desk.runs.append(run)
    desk.save()
    desk._loaded, desk.runs = False, []
    desk.load()
    [again] = desk.runs
    assert (again.state, again.why) == ("paused", "restart")


async def test_the_receipt_s_git_runs_off_the_event_loop(hub, projects, monkeypatch):
    """REL-19: receipt() ran changed_since (git add -A and a diff in the copy) on the event
    loop, holding up every window and session while git worked."""
    import threading

    from jarvis.tasks import ClaudeTask

    desk = hub.code_bugfix
    where = []

    def changed_since(folder, base):
        where.append(threading.current_thread() is threading.main_thread())
        return ["calc.py"]

    monkeypatch.setattr(code_bugfix, "changed_since", changed_since)
    monkeypatch.setattr(desk, "copy_folder", lambda run, task: projects)
    task = ClaudeTask(id=12, prompt="", cwd=projects)
    run = BugRun("r1", "calc", base="abc", started=0.0)
    await desk.receipt(run, task)
    assert where == [False]
    assert any(e.get("receipt", {}).get("bugfix") for e in task.transcript)
    assert not hasattr(desk, "running_in")  # (unused: gone)
