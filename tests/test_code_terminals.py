"""Eden Code's terminals and "!" commands (code_terminals, features/code_terminal): several
real shells per project that outlive the pane, their recent output kept for a window that
comes back and for @terminal; "!" commands streamed from a pseudo-terminal with Cancel and
no time limit."""

import asyncio
import base64

import pytest
from code_session_fakes import make_hub

from jarvis import code_terminals
from jarvis.code_terminals import BangRun, Shell, Shells, last_lines, plain_text, shown_part
from jarvis.tasks import ClaudeTask


@pytest.fixture(autouse=True)
def zsh(monkeypatch):
    monkeypatch.setenv("SHELL", "/bin/zsh")


async def until(check, seconds=30.0):
    for _ in range(int(seconds / 0.05)):
        if check():
            return True
        await asyncio.sleep(0.05)
    return False


def test_terminal_output_as_the_lines_a_person_saw():
    assert plain_text("\x1b[1;32mok\x1b[0m done\r\n") == "ok done\n"
    assert plain_text("10%\r50%\r100%\nnext") == "100%\nnext"  # a progress bar, settled
    assert plain_text("\x1b]0;my title\x07prompt$ ") == "prompt$ "
    assert plain_text("lx\bs -la\x07") == "ls -la"
    assert last_lines("a\nb\nc\n\n", lines=2) == "b\nc"  # (blank lines at the end don't count)
    assert last_lines("\n".join(str(i) for i in range(500))).split("\n")[0] == "300"
    assert len(last_lines("x" * 50_000)) == code_terminals.TEXT_MAX
    # An escape code cut between two reads waits for the rest.
    assert shown_part("red \x1b[3") == ("red ", "\x1b[3")
    assert shown_part("\x1b[31mred\x1b[0m") == ("red", "")
    assert shown_part("a\x1b]0;half a titl") == ("a", "\x1b]0;half a titl")


def test_what_a_terminal_keeps_is_its_latest_output_from_a_line_start(monkeypatch):
    monkeypatch.setattr(code_terminals, "SCROLLBACK", 100)
    shell = Shell("t1", None, "zsh 1", None)
    for i in range(40):
        shell.keep(f"line {i:02d}\n".encode())
    kept = bytes(shell.scrollback)
    assert len(kept) <= 100 and kept.startswith(b"line ") and kept.endswith(b"line 39\n")


async def test_terminals_run_real_shells_keep_their_output_and_close(tmp_path):
    events = []

    class Bench:
        terminals: dict = {}

    bench = Bench()
    shells = Shells(lambda kind, **data: events.append((kind, data)), bench)
    one = shells.open(tmp_path)
    two = shells.open(tmp_path)
    assert (one.title, two.title) == ("zsh 1", "zsh 2")
    assert [s.id for s in shells.of(tmp_path)] == [one.id, two.id]
    assert set(bench.terminals) == {f"cw:{one.id}", f"cw:{two.id}"}  # the app's quit closes them
    one.term.write("echo SHELL_ONE_$((40+2))\r")
    two.term.write("echo SHELL_TWO_$((40+3))\r")

    def heard(term, text):
        return any(
            k == "cw_term_data"
            and d["term"] == term
            and text in base64.b64decode(d["data"]).decode()
            for k, d in events
        )

    assert await until(lambda: heard(one.id, "SHELL_ONE_42") and heard(two.id, "SHELL_TWO_43"))
    # What each printed is kept, for a window that comes back and for @terminal.
    assert b"SHELL_ONE_42" in one.scrollback and b"SHELL_ONE_42" not in two.scrollback
    assert "SHELL_ONE_42" in one.text() and "\x1b" not in one.text()
    assert shells.close(one.id) and shells.get(one.id) is None
    assert set(bench.terminals) == {f"cw:{two.id}"}
    shells.close_all()
    assert not shells.items and not bench.terminals


async def test_the_number_of_terminals_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(code_terminals, "SHELLS_MAX", 2)
    shells = Shells(lambda *a, **k: None)
    shells.open(tmp_path)
    shells.open(tmp_path)
    with pytest.raises(ValueError, match="most terminals"):
        shells.open(tmp_path)
    shells.close_all()


# ── "!" commands ──


async def test_a_bang_command_streams_and_ends_with_its_code(tmp_path):
    events = []
    run = BangRun(
        "b1",
        "printf 'one\\n'; sleep 0.3; printf 'two\\n'; exit 3",
        tmp_path,
        lambda k, **d: events.append((k, d)),
    )
    run.start()
    code = await asyncio.wait_for(run.done, 60)
    assert code == 3
    streamed = "".join(d["text"] for k, d in events if k == "cw_bang_data")
    assert "one" in streamed and "two" in streamed and "\x1b" not in streamed
    assert run.output(1000).splitlines()[-2:] == ["one", "two"]
    assert not run.cancelled


async def test_a_bang_command_has_no_time_limit_but_can_be_cancelled(tmp_path, monkeypatch):
    monkeypatch.setattr(code_terminals, "CANCEL_STEPS", (0.5, 0.5))
    run = BangRun("b2", "echo started; sleep 60; echo never", tmp_path, lambda *a, **k: None)
    run.start()
    assert await until(lambda: b"started" in run.kept)
    await asyncio.sleep(0.3)
    assert not run.done.done()  # still going: nothing stops it but Cancel
    await run.cancel()
    code = await asyncio.wait_for(run.done, 30)
    assert run.cancelled and code == 130
    assert "never" not in run.output(1000)


async def test_a_flood_of_output_reaches_the_window_bounded_and_the_newest(tmp_path, monkeypatch):
    monkeypatch.setattr(code_terminals, "KEEP", 4096)
    events = []
    run = BangRun(
        "b3", "yes | head -n 200000; echo END_OF_IT", tmp_path, lambda k, **d: events.append((k, d))
    )
    run.start()
    assert await asyncio.wait_for(run.done, 120) == 0
    chunks = [d for k, d in events if k == "cw_bang_data"]
    assert all(len(c["text"]) <= code_terminals.STREAM_CHUNK for c in chunks)
    assert "END_OF_IT" in chunks[-1]["text"]
    assert len(run.kept) <= 4096 and run.output(100).endswith("END_OF_IT")
    sent = sum(len(c["text"]) for c in chunks) + sum(c["skipped"] for c in chunks)
    assert sent >= 400_000  # (every "y\n": sent, or said to be skipped)


# ── through the hub ──


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def record(hub):
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    hub.code_terminal.shells.emit = hub.emit
    return seen


async def settle(seen, kind, n=1, seconds=60.0):
    assert await until(lambda: sum(k == kind for k, _ in seen) >= n, seconds), seen
    return [d for k, d in seen if k == kind]


async def test_the_composer_s_bang_streams_then_ends_as_the_core_s_did(hub, tmp_path):
    (tmp_path / "proj").mkdir()
    task = ClaudeTask(id=7, prompt="", cwd=tmp_path / "proj")
    hub.tasks.tasks[7] = task
    seen = record(hub)
    await hub.handle(
        {"type": "task_bash", "id": 7, "command": "echo HELLO_$((2*21)); pwd", "ref": "b1"}
    )
    (done,) = await settle(seen, "task_bash")
    assert ("cw_bang_start", {"ref": "b1"}) in seen
    assert done["ref"] == "b1" and done["code"] == 0 and not done["cancelled"]
    assert "HELLO_42" in done["output"] and str((tmp_path / "proj").resolve()) in done["output"]
    # Cancel ends one that runs on.
    await hub.handle(
        {"type": "task_bash", "id": 7, "command": "echo waiting; sleep 120", "ref": "b2"}
    )
    assert await until(lambda: any(k == "cw_bang_data" and d["ref"] == "b2" for k, d in seen))
    await hub.handle({"type": "cw_bang_cancel", "ref": "b2"})
    stopped = (await settle(seen, "task_bash", 2))[-1]
    assert (
        stopped["ref"] == "b2"
        and stopped["cancelled"]
        and stopped["output"].endswith("(cancelled)")
    )
    # No folder: said at once.
    await hub.handle({"type": "task_bash", "id": 99, "command": "ls", "ref": "b3"})
    nowhere = (await settle(seen, "task_bash", 3))[-1]
    assert nowhere == {"ref": "b3", "command": "ls", "output": "No project folder.", "code": -1}


async def test_terminals_through_the_window_asking_before_closing_a_busy_one(hub, tmp_path):
    (tmp_path / "proj").mkdir()
    seen = record(hub)
    await hub.handle({"type": "cw_term_new", "directory": "proj", "ref": "n1"})
    (new,) = await settle(seen, "cw_term_new")
    assert new["ref"] == "n1" and new["alive"] and new["folder"] == "proj"
    term = new["term"]
    (listed,) = await settle(seen, "cw_terms")
    assert [i["term"] for i in listed["items"]] == [term]
    await hub.handle({"type": "cw_term_resize", "term": term, "cols": 90, "rows": 20})
    await hub.handle({"type": "cw_term_input", "term": term, "data": "echo REPLAY_ME; sleep 60\r"})
    shell = hub.code_terminal.shells.get(term)
    assert await until(lambda: b"REPLAY_ME" in shell.scrollback)
    # A window coming back gets what it printed.
    await hub.handle({"type": "cw_term_attach", "term": term})
    (replay,) = await settle(seen, "cw_term_replay")
    assert b"REPLAY_ME" in base64.b64decode(replay["data"]) and replay["alive"]
    # Something runs in it: closing asks first; forced, it goes.
    assert await until(lambda: "sleep" in shell.busy())  # (once the shell has started it)
    await hub.handle({"type": "cw_term_close", "term": term})
    (busy,) = await settle(seen, "cw_term_busy")
    assert busy["term"] == term and "sleep" in busy["what"]
    assert hub.code_terminal.shells.get(term) is not None
    await hub.handle({"type": "cw_term_close", "term": term, "force": True})
    assert await until(lambda: hub.code_terminal.shells.get(term) is None)
    last = (await settle(seen, "cw_terms", 2))[-1]
    assert last["items"] == []


def test_the_terminal_that_printed_last_is_the_one_mentioned(tmp_path):
    shells = Shells(lambda *a, **k: None)
    one, two = Shell("t1", tmp_path, "zsh 1", None), Shell("t2", tmp_path, "zsh 2", None)
    elsewhere = Shell("t3", tmp_path / "other", "zsh 1", None)
    shells.items = {"t1": one, "t2": two, "t3": elsewhere}
    assert shells.latest(tmp_path) is two  # (none printed yet: the newest)
    one.keep(b"$ make\n")
    assert shells.latest(tmp_path) is one
    elsewhere.keep(b"later, elsewhere\n")
    assert shells.latest(tmp_path) is one and shells.latest(tmp_path / "none") is None
