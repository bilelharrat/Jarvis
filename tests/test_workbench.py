import asyncio
import base64
import re

import psutil

from jarvis import workbench
from jarvis.workbench import MAX_FILE_BYTES, Workbench


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


def _alive(pid):
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


async def _output(events, done, seconds=15):
    text = ""
    for _ in range(int(seconds / 0.05)):
        await asyncio.sleep(0.05)
        text = "".join(
            base64.b64decode(d["data"]).decode(errors="replace")
            for k, d in events
            if k == "term_data"
        )
        if done(text):
            break
    return text


async def test_the_terminal_is_a_real_one_and_closing_it_hangs_up(tmp_path):
    events = []
    bench = Workbench(lambda kind, **data: events.append((kind, data)))
    term = bench.terminal(bench.open_terminal(tmp_path))
    # Ctrl-C reaches the program running in it: the terminal is the shell's own.
    term.write("sleep 30\r")
    await asyncio.sleep(1.0)
    term.write("\x03")
    term.write("echo AFTER_$((20+22))\r")
    assert "AFTER_42" in await _output(events, lambda t: "AFTER_42" in t)
    # A long paste arrives whole, however little the terminal takes at a time.
    lines = "".join(f"line {i:04d} " + "x" * 80 + "\n" for i in range(300))
    term.write("cat > pasted.txt\r")
    await asyncio.sleep(0.5)
    term.write(lines)
    term.write("\x04")
    pasted = tmp_path / "pasted.txt"
    for _ in range(200):
        await asyncio.sleep(0.05)
        if pasted.exists() and pasted.read_text().count("\n") >= 300:
            break
    assert pasted.read_text() == lines
    # Closing it hangs up: the jobs started in it end too, and the shell is reaped.
    term.write("sleep 300 & echo JOB=$!\r")
    out = await _output(events, lambda t: re.search(r"JOB=(\d+)", t))
    job = int(re.search(r"JOB=(\d+)", out).group(1))
    shell = term.proc
    assert bench.close_terminal(term.id) and bench.terminal(term.id) is None
    for _ in range(100):
        await asyncio.sleep(0.05)
        if not _alive(job) and shell.poll() is not None:
            break
    assert not _alive(job) and shell.poll() is not None


def test_file_reads_are_capped_and_never_credentials(tmp_path):
    (tmp_path / "big.log").write_bytes(b"a" * 1_000_000)
    big = Workbench.read_file(tmp_path, "big.log")
    assert big["truncated"] and len(big["text"]) == MAX_FILE_BYTES
    for secret in (".env.local", ".env.production", "server.pem", "tls.key", "id_rsa",
                   "credentials.json", ".npmrc", ".git-credentials"):  # fmt: skip
        (tmp_path / secret).write_text("secret")
        assert "error" in Workbench.read_file(tmp_path, secret), secret
    (tmp_path / ".env.example").write_text("API_KEY=")
    assert Workbench.read_file(tmp_path, ".env.example")["text"] == "API_KEY="
    (tmp_path / "notes.txt").symlink_to(tmp_path / ".env.local")  # a harmless name for a secret
    assert "error" in Workbench.read_file(tmp_path, "notes.txt")


def test_keep_awake_never_outlives_the_app(monkeypatch):
    import os

    started = []

    class Proc:
        def __init__(self, args):
            started.append(args)

        def poll(self):
            return None

    monkeypatch.setattr(workbench.subprocess, "Popen", Proc)
    assert Workbench(lambda *a, **k: None).set_awake(True)
    assert started == [["caffeinate", "-dimsu", "-w", str(os.getpid())]]
