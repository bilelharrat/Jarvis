"""Eden Code's engine radar and engine pinning (features/code_radar, code_engines,
_radar_stats): each turn's reads, edits, blind edits, tests, interruptions and cost in the
radar's log (never a path or a word of the prompt); the owner's undo, revert, rewind and an
isolated copy's landing as outcomes; the statistics that call a shift after an engine or
model update (and don't for noise); one heads-up per shift; the Health pane's line; and
pinning the Claude Code engine (kept copies, Claude Code's own installs, the option hook,
an engine that's too old or gone). No model is called and no real engine is run."""

import asyncio
import json
import os
import random
import time
from pathlib import Path

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, SystemMessage, ToolUseBlock
from code_session_fakes import make_hub

from jarvis.features import _radar_stats as stats
from jarvis.features import code_engines, code_radar
from jarvis.features._router_log import epoch_of, iso
from jarvis.tasks import ClaudeTask


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def notices(hub):
    said = []
    hub.notify = lambda alert, **kw: said.append(alert)
    return said


def session(hub, tmp_path, task_id=7):
    task = ClaudeTask(id=task_id, prompt="", cwd=tmp_path)
    task.model, task.model_ref = "claude-opus-5-5", "opus"
    hub.tasks.tasks[task_id] = task
    return task


def result(reason=None, is_error=False):
    return ResultMessage(
        subtype="success", duration_ms=1500, duration_api_ms=1200, is_error=is_error,
        num_turns=3, session_id="s", total_cost_usd=0.3, result="done",
        usage={"input_tokens": 10, "output_tokens": 5}, terminal_reason=reason,
    )  # fmt: skip


def tools(*calls, parent=None):
    blocks = [ToolUseBlock(id=f"t{i}", name=n, input=a) for i, (n, a) in enumerate(calls)]
    return AssistantMessage(content=blocks, model="claude-opus-5-5", parent_tool_use_id=parent)


async def records(hub):
    await hub.code_radar.log.flush()
    return list(hub.code_radar.log.read())


# ── one turn, measured ──


async def test_a_turn_counts_reads_edits_blind_edits_tests_and_cost(hub, tmp_path):
    task = session(hub, tmp_path)
    radar = hub.code_radar
    (tmp_path / "app.py").write_text("x = 1\n")
    (tmp_path / "old.py").write_text("y = 1\n")
    radar.on_message(
        task, SystemMessage("init", {"claude_code_version": "2.1.300", "model": "claude-opus-5-5"})
    )
    hub.tasks._log(task, "user", "please fix the zebra-unicorn bug in app.py")
    radar.on_message(
        task, tools(("Read", {"file_path": str(tmp_path / "app.py")}), ("Grep", {"pattern": "x"}))
    )
    radar.on_message(
        task,
        tools(
            ("Edit", {"file_path": "app.py"}),  # read first (a relative path, the same file)
            ("Edit", {"file_path": str(tmp_path / "old.py")}),  # never read: blind
            ("Write", {"file_path": str(tmp_path / "new.py")}),  # a new file: a create
            ("Edit", {"file_path": str(tmp_path / "new.py")}),  # its own file: not blind
        ),
    )
    hub.tasks._log(task, "tool", "Running pytest", tool="Bash", tool_id="b1", detail="$ pytest -q")
    hub.tasks.emit("task_log_update", id=7, tool_id="b1", status="done", output="12 passed")
    task.turn_files = {str(tmp_path / "app.py"), str(tmp_path / "old.py"), str(tmp_path / "new.py")}
    hub.tasks._log(task, "turn", "", seconds=2, tokens=100, cost=0.42)
    radar.on_message(task, result())
    [rec] = [r for r in await records(hub) if r["kind"] == "turn"]
    assert rec["engine"] == "2.1.300" and rec["model"] == "claude-opus-5-5"
    assert (rec["reads"], rec["looks"], rec["edits"], rec["blind"], rec["creates"]) == (
        1,
        1,
        4,
        1,
        1,
    )
    assert rec["files"] == 3 and rec["tests"] is True and rec["cost"] == 0.42
    assert rec["interrupted"] is False and rec["error"] is False and rec["pinned"] is False
    assert rec["project"] == code_radar.project_hash(str(tmp_path))
    written = json.dumps(await records(hub))
    assert "zebra" not in written and "app.py" not in written and str(tmp_path) not in written
    assert os.stat(radar.log.path).st_mode & 0o777 == 0o600


async def test_a_subagents_reads_count_for_its_own_edits_only(hub, tmp_path):
    task = session(hub, tmp_path)
    radar = hub.code_radar
    (tmp_path / "a.py").write_text("")
    hub.tasks._log(task, "user", "go")
    radar.on_message(task, tools(("Read", {"file_path": str(tmp_path / "a.py")}), parent="agent-1"))
    radar.on_message(task, tools(("Edit", {"file_path": str(tmp_path / "a.py")})))
    radar.on_message(task, result())
    [rec] = [r for r in await records(hub) if r["kind"] == "turn"]
    assert rec["blind"] == 1


async def test_stopping_failing_undo_rewind_and_a_landed_copy(hub, tmp_path):
    task = session(hub, tmp_path)
    radar = hub.code_radar
    hub.tasks.send = lambda *a, **k: None
    # 1: stopped by the owner.
    hub.tasks._log(task, "user", "first")
    await hub._handle({"type": "task_interrupt", "id": 7})
    radar.on_message(task, result(reason="aborted_streaming"))
    # 2: a change, undone.
    hub.tasks._log(task, "user", "second")
    task.turn_files = {str(tmp_path / "x.py")}
    radar.on_message(task, result())
    await hub._handle({"type": "task_undo", "id": 7})
    # 3 and 4: changes; a rewind to before 3 with its files takes both back.
    hub.tasks._log(task, "user", "third")
    third_n = task.transcript[-1]["n"]
    radar._on_meta({"id": 7, "n": third_n, "uuid": "u-3"})
    task.turn_files = {str(tmp_path / "y.py")}
    radar.on_message(task, result())
    hub.tasks._log(task, "user", "fourth")
    radar.on_message(task, result())
    radar.on_command("code_rewind", {"id": 7, "uuid": "u-3", "files": True, "text": ""})
    # 5: a change that lands with its isolated copy; 6: a failure at the provider.
    hub.tasks._log(task, "user", "fifth")
    task.turn_files = {str(tmp_path / "z.py")}
    radar.on_message(task, result())
    hub.emit("code_copy_outcome", outcome="landed", tasks=[7])
    hub.tasks._log(task, "user", "sixth")
    task.turn_files = set()
    radar.on_message(task, result(is_error=True))
    turns = stats.fold(await records(hub), epoch_of)
    assert [t["interrupted"] for t in turns] == [True, False, False, False, False, False]
    assert turns[1]["reverted"] is True and stats.is_landed(turns[1]) is False
    assert turns[2]["rewound"] and turns[2]["rewound_files"] and turns[3]["rewound"]
    assert turns[4]["copy"] == "landed" and stats.is_landed(turns[4])
    assert turns[5]["error"] is True
    # A fork rewinds nothing in this session; a conversation-only rewind keeps the files.
    before = len(await records(hub))
    radar.on_command("code_rewind", {"id": 7, "uuid": "u-3", "fork": True})
    assert len(await records(hub)) == before


async def test_review_time_and_off_means_nothing_is_kept(hub, tmp_path):
    task = session(hub, tmp_path)
    await hub._handle({"type": "cw_review_time", "seconds": 75, "pane": "diff", "id": 7})
    await hub._handle({"type": "cw_review_time", "seconds": 99999, "pane": "pr"})
    await hub._handle({"type": "cw_review_time", "seconds": 30, "pane": "terminal"})  # not a review
    rows = [r for r in await records(hub) if r["kind"] == "review"]
    assert [(r["seconds"], r["pane"]) for r in rows] == [
        (75, "diff"),
        (code_radar.REVIEW_MAX, "pr"),
    ]
    assert rows[0]["project"] == code_radar.project_hash(str(tmp_path))
    hub.set_feature_prefs({code_radar.PREF_ON: False})
    hub.tasks._log(task, "user", "x")
    hub.code_radar.on_message(task, result())
    await hub._handle({"type": "cw_review_time", "seconds": 5, "pane": "diff"})
    assert len(await records(hub)) == 2


# ── the statistics ──


def turn(engine, model="claude-opus-5-5", project="p1", ts=0.0, **over):
    base = {
        "turn": f"k{random.random()}", "ts": ts, "session": "s", "project": project,
        "engine": engine, "model": model, "family": stats.family(model), "pinned": False,
        "reads": 4, "looks": 1, "edits": 1, "blind": 0, "creates": 0, "files": 1,
        "tests": True, "interrupted": False, "error": False, "cost": 0.2, "seconds": 30,
        "rewound": False, "rewound_files": False, "reverted": False, "copy": None,
    }  # fmt: skip
    base.update(over)
    return base


def test_families_and_versions():
    assert stats.family("claude-opus-4-7") == stats.family("claude-opus-5-5") == "claude-opus"
    assert stats.family("claude-sonnet-4-5-20250929") == "claude-sonnet"
    assert stats.family("claude-opus-5-5[1m]") == "claude-opus"
    assert stats.version_key("2.1.294 (Claude Code)") == (2, 1, 294)
    assert stats.version_key("x") == (0, 0, 0)


def test_the_tests_themselves():
    assert stats.two_proportions(5, 100, 5, 100) == 1.0
    assert stats.two_proportions(5, 100, 40, 100) < 1e-6
    rng = random.Random(1)
    same = [rng.random() for _ in range(60)], [rng.random() for _ in range(60)]
    assert stats.mann_whitney(*same) > 0.05
    assert stats.mann_whitney([1.0] * 40, [5.0] * 40) < 1e-6
    assert stats.holm({"a": 0.01, "b": 0.04, "c": 0.5}) == {"a": 0.03, "b": 0.08, "c": 0.5}


def test_a_real_shift_is_called_and_noise_isnt():
    rng = random.Random(7)
    before = [turn("2.1.277", ts=i, reads=rng.choice([4, 5, 6]), blind=0) for i in range(60)]
    after = [
        turn("2.1.294", ts=100 + i, reads=rng.choice([1, 2]), blind=1 if i % 3 else 0,
             interrupted=i % 4 == 0)
        for i in range(60)
    ]  # fmt: skip
    [change] = stats.changes(before + after)
    assert change["change"] == "engine" and change["status"] == "shift"
    rows = {r["metric"]: r for r in change["rows"]}
    assert rows["read_ratio"]["significant"] and rows["read_ratio"]["worse"]
    assert rows["blind_edits"]["significant"] and rows["blind_edits"]["after"] > 0.6
    assert rows["interrupts"]["significant"] and rows["interrupts"]["worse"]
    assert not rows["cost"]["significant"]
    # The same engine numbers both sides: steady. Too few after the update: collecting.
    calm = [turn("2.1.294", ts=100 + i, reads=rng.choice([4, 5, 6])) for i in range(60)]
    assert stats.changes(before + calm)[0]["status"] == "steady"
    few = stats.changes(before + after[:10])[0]
    assert few["status"] == "collecting" and few["after"]["turns"] == 10
    # Better after an update is a shift, but not for the worse: no "shift" status.
    better = [turn("2.1.294", ts=100 + i, reads=9, tests=True) for i in range(60)]
    worse_before = [turn("2.1.277", ts=i, reads=1, tests=i % 2 == 0) for i in range(60)]
    assert stats.changes(worse_before + better)[0]["status"] == "steady"


def test_a_model_update_and_another_model_are_told_apart():
    a = [turn("2.1.294", "claude-opus-4-7", ts=i) for i in range(30)]
    b = [turn("2.1.294", "claude-opus-5-5", ts=50 + i) for i in range(30)]
    c = [turn("2.1.294", "claude-sonnet-5-5", ts=80 + i) for i in range(30)]
    found = stats.changes(a + b + c)
    assert [(x["family"], x["change"]) for x in found] == [("claude-opus", "model")]
    rows = stats.breakdown(a + b + c)
    assert {r["model"] for r in rows} == {"claude-opus-4-7", "claude-opus-5-5", "claude-sonnet-5-5"}
    assert all(r["turns"] == 30 for r in rows)


def test_cost_per_landed_change_and_what_landed():
    turns = [
        turn("e", cost=1.0),
        turn("e", cost=1.0, reverted=True),
        turn("e", cost=1.0, rewound=True, rewound_files=True),
        turn("e", cost=1.0, copy="discarded"),
        turn("e", cost=1.0, files=0),
    ]
    value, landed = stats.value("cost", turns)
    assert landed == 1 and value == 5.0
    assert stats.share_counts("reverts", turns) == (1, 4)


# ── the verdict, the heads-up and the panes ──


def write_turns(radar, engine, n, start, **over):
    for i in range(n):
        rec = {
            "v": 1, "kind": "turn", "ts": iso(start + i * 60), "turn": f"{engine}-{i}", "session": "s",
            "project": "p1", "engine": engine, "sdk": "0.2", "model": "claude-opus-5-5",
            "pinned": False, "reads": 5, "looks": 1, "edits": 1, "blind": 0, "creates": 0,
            "files": 1, "tests": True, "interrupted": False, "error": False, "cost": 0.2,
            "seconds": 20,
        }  # fmt: skip
        rec.update({k: (v(i) if callable(v) else v) for k, v in over.items()})
        radar.log.append(rec)


async def test_a_shift_after_an_update_gets_one_heads_up_and_shows_in_health(hub):
    said = notices(hub)
    radar = hub.code_radar
    now = time.time() - 86400
    write_turns(radar, "2.1.277", 60, now)
    write_turns(radar, "2.1.294", 60, now + 7200, reads=1, blind=lambda i: i % 2)
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    await hub._handle({"type": "cw_radar", "fresh": True})
    assert await _until(lambda: any(k == "cw_radar" for k, _ in seen))
    got = next(d for k, d in seen if k == "cw_radar")
    shifts = [c for c in got["changes"] if c["status"] == "shift"]
    assert shifts and shifts[0]["after"]["engine"] == "2.1.294"
    assert len(said) == 1 and "2.1.294" in said[0].text and "2.1.277" in said[0].text
    assert "reads per edit" in said[0].text
    # Looked at again: nothing new to say.
    await radar.analysis(fresh=True)
    assert len(said) == 1
    health = radar.health(await radar.analysis())
    assert health["status"] == "shift" and health["shifts"] >= 1
    # Dismissed: the Health pane's line calms down.
    for change in shifts:
        await radar.cmd_dismiss({"key": change["key"]})
    assert radar.health(await radar.analysis())["status"] != "shift"
    saved = json.loads(hub.feature_path(code_radar.STATE_FILE).read_text())
    assert shifts[0]["key"] in saved["dismissed"]


async def test_no_heads_up_with_alerts_off(hub):
    said = notices(hub)
    hub.set_feature_prefs({code_radar.PREF_ALERTS: False})
    radar = hub.code_radar
    now = time.time() - 86400
    write_turns(radar, "2.1.277", 60, now)
    write_turns(radar, "2.1.294", 60, now + 7200, reads=1, blind=lambda i: i % 2)
    await radar.analysis(fresh=True)
    assert said == []


async def test_the_health_pane_carries_the_radar_and_the_pin(hub, tmp_path):
    from jarvis.features.ops import desk_for

    async def run(*args, timeout=20.0, env=None):
        if args[1:] == ("--version",):
            return 0, "2.1.3 (Claude Code)\n", ""
        return 0, json.dumps({"loggedIn": True, "authMethod": "claude.ai"}) + "\n", ""

    desk = desk_for(hub)
    desk.run = run
    desk.probe_extra = {"claude_cli": lambda: "/x/_bundled/claude", "login_command": lambda c: ""}
    engine = tmp_path / "claude"
    engine.write_text("#!/bin/sh\necho 2.1.277\n")
    engine.chmod(0o755)
    hub.set_feature_prefs({code_engines.PREF_PIN: {"path": str(engine), "version": "2.1.277"}})
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    await hub._handle({"type": "cw_health"})
    assert await _until(lambda: any(k == "cw_health" for k, _ in seen))
    got = next(d for k, d in seen if k == "cw_health")
    assert got["pin"] == {"path": str(engine), "version": "2.1.277"}
    assert got["engine"]["path"] == str(engine) and got["engine"]["bundled"] is False
    assert got["radar"]["status"] == "empty"


async def _until(check, seconds=5.0):
    for _ in range(int(seconds / 0.01)):
        if check():
            return True
        await asyncio.sleep(0.01)
    return False


# ── the engine: kept copies and pinning ──


def fake_engine(path: Path, version: str, program: bool = True) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    head = b"\xcf\xfa\xed\xfe" if program else b"#!/bin/sh\n"
    path.write_bytes(head + f"\nversion {version}\n".encode())
    path.chmod(0o755)
    return path


def runner(engines):
    """--version answered from the fake engine's own file, never run."""
    asked = []

    async def run(path, timeout=15.0):
        asked.append(path)
        text = Path(path).read_bytes().decode("latin-1")
        found = code_engines._VERSION.search(text)
        return (0, f"{found.group(1)} (Claude Code)\n", "") if found else (1, "", "nope")

    engines.run = run
    return asked


async def test_pinning_keeps_a_copy_reconnects_and_sets_the_sessions_engine(hub, tmp_path):
    engines = hub.code_engines
    runner(engines)
    engines.home = tmp_path / "home"
    installed = fake_engine(engines.home / ".local/share/claude/versions/2.1.277", "2.1.277")
    task = session(hub, tmp_path)
    task.client = object()
    reopened = []
    hub.tasks.reopen = lambda task_id, note="": reopened.append((task_id, note)) or True
    ok, said = await engines.pin_to(str(installed))
    assert ok and "2.1.277" in said
    pin = engines.pin()
    kept = Path(pin["path"])
    assert pin["version"] == "2.1.277" and kept.is_file() and kept.parent.name == "2.1.277"
    assert hub.feature_path(code_engines.ENGINES_DIR) in kept.parents  # a copy, safe from pruning
    assert reopened and reopened[0][0] == 7 and "2.1.277" in reopened[0][1]
    # The session's connection: the pinned engine, which never updates itself.
    options = hub.tasks.options_for(task)
    assert options.cli_path == str(kept) and options.env["DISABLE_AUTOUPDATER"] == "1"
    # Another agent over ACP is left alone.
    other = session(hub, tmp_path, task_id=8)
    other.model_ref = "acp:codex"
    hook = next(h for h in hub.tasks.option_hooks if isinstance(h, code_engines.EngineOptions))
    assert hook.key(other) == "" and hook.key(task) == str(kept)
    # Unpinned: the built-in engine again.
    engines.unpin()
    assert engines.pin() == {} and hub.tasks.options_for(task).cli_path is None


async def test_what_can_and_cant_be_pinned(hub, tmp_path):
    engines = hub.code_engines
    runner(engines)
    other = fake_engine(tmp_path / "bin" / "python3", "2.1.300")
    ok, said = await engines.pin_to(str(other))
    assert not ok and "named claude" in said
    ok, _ = await engines.pin_to("claude")  # not an absolute path
    assert not ok
    old = fake_engine(tmp_path / "old" / "claude", "1.0.99")
    ok, said = await engines.pin_to(str(old))
    assert not ok and "older" in said
    silent = tmp_path / "quiet" / "claude"
    silent.parent.mkdir()
    silent.write_text("#!/bin/sh\n")
    silent.chmod(0o755)
    ok, said = await engines.pin_to(str(silent))
    assert not ok and "version" in said
    # An npm install's claude (a script): pinned where it is, no copy.
    script = fake_engine(tmp_path / "npm" / "claude", "2.1.280", program=False)
    ok, _ = await engines.pin_to(str(script))
    assert ok and engines.pin()["path"] == str(script)


async def test_a_pinned_engine_thats_gone_is_let_go_with_a_heads_up(hub, tmp_path):
    said = notices(hub)
    engines = hub.code_engines
    gone = tmp_path / "claude"
    hub.set_feature_prefs({code_engines.PREF_PIN: {"path": str(gone), "version": "2.1.277"}})
    assert engines.pinned_path() == "" and engines.pin() == {}
    assert len(said) == 1 and "2.1.277" in said[0].text
    assert engines.current()["pinned"] is False


async def test_the_built_in_engine_is_kept_and_old_copies_pruned(hub, tmp_path, monkeypatch):
    engines = hub.code_engines
    runner(engines)
    engines.home = tmp_path / "home"
    folder = tmp_path / "sdk"
    for version in ("2.1.270", "2.1.280", "2.1.290", "2.1.300"):
        cli = fake_engine(folder / version / "claude", version)
        monkeypatch.setattr(code_engines, "bundled_cli", lambda cli=cli: cli)
        monkeypatch.setattr(code_engines, "bundled_version", lambda v=version: v)
        assert await asyncio.to_thread(engines.keep_current) == version
        if version == "2.1.270":  # pinned to the oldest: it stays whatever happens
            hub.set_feature_prefs(
                {code_engines.PREF_PIN: {"path": engines.kept()[0]["path"], "version": version}}
            )
    assert [r["version"] for r in engines.kept()] == ["2.1.300", "2.1.290", "2.1.280", "2.1.270"]
    hub.set_feature_prefs({code_engines.PREF_PIN: {}})
    engines.prune()
    assert [r["version"] for r in engines.kept()] == ["2.1.300", "2.1.290", "2.1.280"]
    meta = json.loads((Path(engines.kept()[0]["path"]).parent / "meta.json").read_text())
    assert meta["from"] == "built-in" and meta["how"] in ("clone", "copy")
    # Off: nothing more is kept.
    hub.set_feature_prefs({code_engines.PREF_KEEP: False})
    assert await asyncio.to_thread(engines.keep_current) == ""
    # The window's list: the built-in one, the kept copies, Claude Code's own installs.
    fake_engine(engines.home / ".local/share/claude/versions/2.1.276", "2.1.276")
    state = await engines.state()
    sources = [(c["source"], c["version"]) for c in state["candidates"]]
    assert sources[0] == ("built-in", "2.1.300") and ("installed", "2.1.276") in sources
    assert ("kept", "2.1.290") in sources and state["current"]["version"] == "2.1.300"
    assert state["candidates"][0]["current"] is True and all(
        c["usable"] for c in state["candidates"]
    )
    assert state["minimum"] and len(state["limits"]) == 4
