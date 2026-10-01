"""The code interpreter (features/code_interpreter.py): a sandboxed Python that keeps its
variables, writes only its folder, and can't reach the network or the owner's files."""

from __future__ import annotations

import base64
from pathlib import Path

import pytest

from jarvis.features import code_interpreter
from jarvis.features.code_interpreter import Interpreter

SANDBOX = Path("/usr/bin/sandbox-exec").exists()


class Hub:
    def __init__(self):
        self.events = []
        self._session_id = ""
        self._rid = "r1"

    def emit(self, kind, **values):
        self.events.append((kind, values))


@pytest.fixture
async def made(tmp_path, monkeypatch):
    monkeypatch.setattr(code_interpreter, "find_uv", lambda: None)  # never set up in tests
    hub = Hub()
    interpreter = Interpreter(hub, home=tmp_path / "home", root=tmp_path / "Analysis")
    yield hub, interpreter
    worker = interpreter.worker
    interpreter.stop()
    if worker is not None:
        await worker.process.wait()


async def run(interpreter, code):
    content, error = await interpreter.run(code)
    return content[0]["text"], error, content


async def test_it_runs_and_keeps_its_variables(made):
    hub, interpreter = made
    first, err1 = await interpreter.run("x = 6 * 7\nprint(x)")
    second, err2 = await interpreter.run("print(x + 1)")
    assert "42" in first[0]["text"] and not err1
    assert "43" in second[0]["text"] and not err2
    kind, event = hub.events[-1]
    assert kind == "analysis_run" and event["output"].strip() == "43" and event["rid"] == "r1"


async def test_an_error_comes_back_as_one(made):
    _hub, interpreter = made
    text, error, _ = await run(interpreter, "1 / 0")
    assert error and "ZeroDivisionError" in text


async def test_files_it_writes_are_named(made):
    _hub, interpreter = made
    text, error, _ = await run(interpreter, "open('out.csv', 'w').write('a,b\\n1,2\\n')")
    assert not error and "out.csv" in text
    assert (interpreter.worker.folder / "out.csv").read_text().startswith("a,b")


def test_charts_are_shown_and_given_back(made, tmp_path):
    hub, interpreter = made
    worker = code_interpreter.Worker(None, tmp_path, "")
    png = b"\x89PNG\r\n\x1a\nfake"
    (tmp_path / "chart-1.png").write_bytes(png)
    content = interpreter._answer(worker, "plot()", {"output": "", "charts": ["chart-1.png"]})
    assert content[1] == {
        "type": "image",
        "data": base64.b64encode(png).decode(),
        "mimeType": "image/png",
    }
    assert hub.events[-1][1]["charts"][0]["name"] == "chart-1.png"


@pytest.mark.skipif(not SANDBOX, reason="sandbox-exec is macOS's")
async def test_the_sandbox_keeps_it_in_its_folder(made):
    _hub, interpreter = made
    text, _error, _ = await run(
        interpreter,
        "import os, socket\n"
        "for what, act in [\n"
        "    ('net', lambda: socket.create_connection(('1.1.1.1', 80), timeout=3)),\n"
        "]:\n"
        "    try:\n"
        "        act(); print(what, 'ALLOWED')\n"
        "    except Exception as e:\n"
        "        print(what, 'blocked', type(e).__name__)\n",
    )
    assert "net blocked" in text
    real_home = Path.home()
    text, _error, _ = await run(
        interpreter,
        f"try:\n    open({str(real_home / 'jarvis-sandbox-check.txt')!r}, 'w')\n"
        "    print('write ALLOWED')\nexcept Exception as e:\n    print('write blocked')\n"
        f"try:\n    print(len(__import__('os').listdir({str(real_home / 'Documents')!r})))\n"
        "    print('docs ALLOWED')\nexcept Exception:\n    print('docs blocked')\n",
    )
    assert "write blocked" in text and "docs blocked" in text
    assert not (real_home / "jarvis-sandbox-check.txt").exists()


async def test_a_run_that_takes_too_long_is_stopped(made, monkeypatch):
    _hub, interpreter = made
    monkeypatch.setattr(code_interpreter, "RUN_SECONDS", 1.0)
    text, error, _ = await run(interpreter, "while True: pass")
    assert error and "stopped" in text and interpreter.worker is None


async def test_a_new_conversation_gets_a_new_worker(made):
    hub, interpreter = made
    await interpreter.run("y = 1")
    hub._session_id = "11111111-2222-3333-4444-555555555555"
    await interpreter.run("print('same')")  # the new conversation's first answer named it
    first = interpreter.worker
    hub._session_id = "66666666-7777-8888-9999-000000000000"
    content, error = await interpreter.run("print(y)")
    assert first is not interpreter.worker
    await first.process.wait()
    assert error and "NameError" in content[0]["text"]


async def test_only_files_in_home_are_added(made, tmp_path):
    _hub, interpreter = made
    outside = tmp_path / "data.csv"
    outside.write_text("a\n1\n")
    text, error = await interpreter.add_file(str(outside))
    if Path.home().resolve() not in outside.resolve().parents:
        assert error and "home folder" in text
    text, error = await interpreter.add_file("/etc/hosts")
    assert error


async def test_empty_code_isnt_run(made):
    _hub, interpreter = made
    text, error, _ = await run(interpreter, "  ")
    assert error and interpreter.worker is None
