import asyncio
import base64

from jarvis.workbench import Workbench


async def test_terminal_runs_a_real_shell_in_the_project(tmp_path):
    events = []
    bench = Workbench(lambda kind, **data: events.append((kind, data)))
    term_id = bench.open_terminal(tmp_path)
    term = bench.terminal(term_id)
    term.resize(100, 30)
    term.write("echo WORKBENCH_OK $((6*7)) && pwd\r")
    output = ""
    for _ in range(100):
        await asyncio.sleep(0.05)
        output = "".join(
            base64.b64decode(d["data"]).decode(errors="replace")
            for k, d in events
            if k == "term_data"
        )
        if "WORKBENCH_OK 42" in output and str(tmp_path.resolve()) in output:
            break
    assert "WORKBENCH_OK 42" in output
    assert bench.open_terminal(tmp_path) == term_id  # one terminal per project
    bench.close()
    assert bench.terminal(term_id) is None


def test_files_open_read_only_and_never_secrets(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("print('hi')\n")
    (tmp_path / ".env").write_text("API_KEY=secret\n")
    (tmp_path / "blob.bin").write_bytes(b"\x00\x01\x02" * 100)
    read = Workbench.read_file
    assert read(tmp_path, "src/app.py")["text"] == "print('hi')\n"
    assert "error" in read(tmp_path, ".env")
    assert "error" in read(tmp_path, "../../etc/passwd")
    assert read(tmp_path, "blob.bin")["error"] == "That's a binary file."


async def test_keep_awake_switches_caffeinate(tmp_path):
    bench = Workbench(lambda *a, **k: None)
    assert bench.set_awake(True) is True
    assert bench.set_awake(False) is False
