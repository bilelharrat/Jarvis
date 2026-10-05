import asyncio
import base64
import contextlib
import os
import re
import signal
import subprocess
import sys
import time

import psutil
import pytest

from jarvis import workbench
from jarvis.workbench import MAX_FILE_BYTES, Workbench


@pytest.fixture(autouse=True)
def plain_zsh(monkeypatch, tmp_path_factory):
    """The terminals run a plain zsh, not with the owner's own startup files: those can make
    a shell slow to start and to go (a busy prompt, a history file shared with every other
    shell), and these tests would write into that history."""
    home = tmp_path_factory.mktemp("zdotdir")
    (home / ".zshrc").write_text("")  # (any startup file: no first-run questions)
    monkeypatch.setenv("SHELL", "/bin/zsh")
    monkeypatch.setenv("ZDOTDIR", str(home))


async def until(check, seconds=30.0):
    """Whether check() comes true within `seconds`: a generous deadline, never a fixed
    sleep, since a shell on a busy Mac can take seconds to start."""
    deadline = time.monotonic() + seconds
    while not check():
        if time.monotonic() > deadline:
            return False
        await asyncio.sleep(0.05)
    return True


def _text(events):
    return "".join(
        base64.b64decode(d["data"]).decode(errors="replace") for k, d in events if k == "term_data"
    )


def _running(term):
    """The names of the programs the terminal's shell has running."""
    names = set()
    with contextlib.suppress(psutil.Error):
        for child in psutil.Process(term.proc.pid).children(recursive=True):
            with contextlib.suppress(psutil.Error):
                names.add(child.name())
    return names


async def test_terminal_runs_a_real_shell_in_the_project(tmp_path):
    events = []
    bench = Workbench(lambda kind, **data: events.append((kind, data)))
    try:
        term_id = bench.open_terminal(tmp_path)
        term = bench.terminal(term_id)
        term.resize(100, 30)
        term.write("echo WORKBENCH_OK $((6*7)) && pwd\r")
        await until(
            lambda: "WORKBENCH_OK 42" in _text(events) and str(tmp_path.resolve()) in _text(events)
        )
        assert "WORKBENCH_OK 42" in _text(events)
        assert bench.open_terminal(tmp_path) == term_id  # one terminal per project
    finally:
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


# How long a test waits for a closed terminal's jobs to end: the longest the reaper keeps
# hanging up on a job that was still starting, and then some.
HANGING_UP = workbench.STARTING_SECONDS + 30


def _alive(pid):
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


async def test_the_terminal_is_a_real_one_and_closing_it_hangs_up(tmp_path):
    events = []
    bench = Workbench(lambda kind, **data: events.append((kind, data)))
    term = bench.terminal(bench.open_terminal(tmp_path))
    job = None
    try:
        # Ctrl-C reaches the program running in it: the terminal is the shell's own.
        term.write("sleep 30\r")
        assert await until(lambda: "sleep" in _running(term))
        term.write("\x03")
        assert await until(lambda: "sleep" not in _running(term), 20)  # long before its 30 s
        term.write("echo AFTER_$((20+22))\r")
        assert await until(lambda: "AFTER_42" in _text(events))
        # A long paste arrives whole, however little the terminal takes at a time.
        lines = "".join(f"line {i:04d} " + "x" * 80 + "\n" for i in range(300))
        term.write("cat > pasted.txt\r")
        assert await until(lambda: "cat" in _running(term))
        term.write(lines)
        term.write("\x04")
        pasted = tmp_path / "pasted.txt"
        await until(lambda: pasted.exists() and pasted.read_text().count("\n") >= 300)
        assert pasted.read_text() == lines
        # Closing it hangs up: the jobs started in it end too, and the shell is reaped.
        term.write("sleep 300 & echo JOB=$!\r")
        assert await until(lambda: re.search(r"JOB=(\d+)", _text(events)))
        job = int(re.search(r"JOB=(\d+)", _text(events)).group(1))
        shell = term.proc
        assert bench.close_terminal(term.id) and bench.terminal(term.id) is None
        assert await until(lambda: not _alive(job) and shell.poll() is not None, HANGING_UP)
    finally:
        bench.close()
        if job is not None and _alive(job):  # never left running, even by a failure
            os.kill(job, signal.SIGKILL)


# A Python stand-in for a shell that leads its session, as a terminal's shell does. Its job
# takes the hang-up while it is still the shell's copy (forked, not yet its program), and
# only then becomes its program (sleep), with nothing of the hang-up left: as a job the
# shell was still starting when the terminal closed can, in the shell's own handling of it.
STARTING_A_JOB = """
import os, signal, time
ready, ready_w = os.pipe()
job = os.fork()
if job == 0:
    signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGHUP})
    os.write(ready_w, b"1")
    signal.sigwait({signal.SIGHUP})
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGHUP})
    os.execvp("sleep", ["sleep", "300"])
os.read(ready, 1)
print(job, flush=True)
time.sleep(300)
"""


async def test_a_job_still_starting_when_the_terminal_closes_ends_too():
    shell = subprocess.Popen(
        [sys.executable, "-c", STARTING_A_JOB], stdout=subprocess.PIPE, start_new_session=True
    )
    job = None
    try:
        job = int(shell.stdout.readline())
        workbench._hang_up(shell)
        assert await until(lambda: not _alive(job) and shell.poll() is not None, HANGING_UP)
    finally:
        for pid in (job, shell.pid):
            if pid is not None and _alive(pid):  # never left running, even by a failure
                os.kill(pid, signal.SIGKILL)
        shell.wait(timeout=10)
        shell.stdout.close()


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
