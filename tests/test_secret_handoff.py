"""A command's secrets go only to that command (key_proxy.Handoffs with handoff_check): the
pipe they wait in can be found by any of the session's processes (its folder and secret_run's
command line are the owner's), so another process that opens it first, one with the right
arguments but something loaded into it, or two readers at once, get nothing, and the
command the owner let go, run as code_secrets.wrap words it, gets its values and prints
them scrubbed. (Before: the first reader got the values as they are, never scrubbed.)"""

import os
import shlex
import subprocess
import sys
import time

import pytest

from jarvis import handoff_check
from jarvis.features import code_secrets
from jarvis.key_proxy import Handoffs

VALUE = "hunter2-very-secret-9471"
COMMAND = 'echo "got [$SECRET_X]"'
RIVAL = (
    "import sys\n"
    "with open(sys.argv[1], 'rb') as pipe:\n"
    "    sys.stdout.buffer.write(pipe.read())\n"
)

pytestmark = pytest.mark.skipif(
    handoff_check._libproc() is None and not os.path.isdir("/proc/self/fd"),
    reason="no way on this system to see who has a pipe open",
)


def offer(tmp_path, command=COMMAND):
    offers = Handoffs(folder=tmp_path / "handoff", wait=10)
    return offers.offer({"SECRET_X": VALUE}, [],
                        expect=lambda pipe: shlex.split(code_secrets.wrap(command, pipe)))  # fmt: skip


def run(argv, env=None, timeout=30):
    return subprocess.run(argv, capture_output=True, timeout=timeout, env=env)


def test_the_command_the_owner_let_go_gets_its_values_scrubbed(tmp_path):
    pipe = offer(tmp_path)
    done = run(shlex.split(code_secrets.wrap(COMMAND, pipe)))
    assert done.returncode == 0, done.stderr
    assert done.stdout == b"got [$SECRET_X]\n"
    assert VALUE.encode() not in done.stdout + done.stderr


def test_another_process_that_opens_the_pipe_first_gets_nothing(tmp_path):
    pipe = offer(tmp_path)
    # A loop the session left running finds the name (ls of the folder, or ps) and opens it.
    rival = run([sys.executable, "-I", "-c", RIVAL, pipe])
    assert rival.returncode == 0 and rival.stdout == b""
    # The command itself comes too late: the pipe is gone, so it doesn't run at all.
    late = run(shlex.split(code_secrets.wrap(COMMAND, pipe)))
    assert late.returncode == 2 and VALUE.encode() not in late.stdout + late.stderr
    assert b"couldn't hand this command its secrets" in late.stderr


def test_secret_run_for_another_command_gets_nothing(tmp_path):
    pipe = offer(tmp_path)
    other = run(shlex.split(code_secrets.wrap('echo "$SECRET_X" > /dev/stderr', pipe)))
    assert other.returncode == 2 and VALUE.encode() not in other.stdout + other.stderr


def test_the_right_arguments_with_code_loaded_into_it_get_nothing(tmp_path):
    pipe = offer(tmp_path)
    env = {**os.environ, "DYLD_FALLBACK_LIBRARY_PATH": "/nonexistent",
           "LD_PRELOAD": "/nonexistent/evil.so"}  # fmt: skip
    loaded = run(shlex.split(code_secrets.wrap(COMMAND, pipe)), env=env)
    assert loaded.returncode == 2 and VALUE.encode() not in loaded.stdout + loaded.stderr


def test_two_readers_at_once_get_nothing(tmp_path):
    pipe = offer(tmp_path)
    rival = subprocess.Popen([sys.executable, "-I", "-c", RIVAL, pipe], stdout=subprocess.PIPE)
    time.sleep(0.01)
    real = run(shlex.split(code_secrets.wrap(COMMAND, pipe)))
    out, _ = rival.communicate(timeout=30)
    assert VALUE.encode() not in out + real.stdout + real.stderr
    assert out == b""


def test_what_a_process_is_comes_from_the_system():
    exe, argv, env = handoff_check.process(os.getpid())
    assert os.path.samefile(exe, os.path.realpath(sys.executable))
    assert argv and any("PATH=" in item for item in env)
    assert handoff_check.process(2**22 + 12345) is None  # (no such process)


# ── R2-4: what the command's shell would run of its own, and who started the reader ──


def offer_with_path(tmp_path, command, path):
    offers = Handoffs(folder=tmp_path / "handoff", wait=10)
    return offers.offer({"SECRET_X": VALUE}, [], run_path=path,
                        expect=lambda pipe: shlex.split(code_secrets.wrap(command, pipe)))  # fmt: skip


def test_startup_files_and_exported_functions_never_see_the_values(tmp_path):
    # The exact command, started with a BASH_ENV, a ZDOTDIR with a .zshenv, and an exported
    # bash function in place of echo: each would run with the values in its environment.
    leak = tmp_path / "leak"
    evil = tmp_path / "evil.sh"
    evil.write_text(f'printf "%s" "$SECRET_X" >> {shlex.quote(str(leak))}\n')
    dot = tmp_path / "dot"
    dot.mkdir()
    (dot / ".zshenv").write_text(evil.read_text())
    env = {**os.environ, "BASH_ENV": str(evil), "ENV": str(evil), "ZDOTDIR": str(dot),
           "BASH_FUNC_echo%%": f"() {{ . {shlex.quote(str(evil))}; }}"}  # fmt: skip
    pipe = offer(tmp_path)
    done = run(shlex.split(code_secrets.wrap(COMMAND, pipe)), env=env)
    assert not leak.exists() or VALUE not in leak.read_text()
    assert done.returncode == 0 and done.stdout == b"got [$SECRET_X]\n", done.stderr


def test_a_path_of_its_own_never_runs_the_command(tmp_path):
    # A PATH with its own `tr` first: the command runs with the session's PATH instead.
    leak = tmp_path / "leak"
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    fake = bin_ / "tr"
    fake.write_text(f'#!/bin/sh\nprintf "%s" "$SECRET_X" > {shlex.quote(str(leak))}\n')
    fake.chmod(0o755)
    command = 'printf x | tr x y; echo " [$SECRET_X]"'
    pipe = offer_with_path(tmp_path, command, os.environ["PATH"])
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}"}
    done = run(shlex.split(code_secrets.wrap(command, pipe)), env=env)
    assert not leak.exists()
    assert done.returncode == 0 and done.stdout == b"y [$SECRET_X]\n", done.stderr


def test_a_reader_left_over_after_its_parent_went_gets_nothing(tmp_path):
    # The exact command, started so that its parents don't lead to the backend (a double
    # fork: what a process outside the sessions, or one left behind, looks like).
    pipe = offer(tmp_path)
    out = tmp_path / "out"
    argv = shlex.split(code_secrets.wrap(COMMAND, pipe))
    launcher = (
        "import os, sys, time\n"
        "if os.fork():\n"
        "    os._exit(0)\n"
        "os.setsid()\n"
        "time.sleep(0.3)\n"
        "fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)\n"
        "os.dup2(fd, 1)\n"
        "os.dup2(fd, 2)\n"
        "os.execv(sys.argv[2], sys.argv[2:])\n"
    )
    run([sys.executable, "-I", "-c", launcher, str(out), *argv])
    for _ in range(300):
        if out.exists() and out.read_bytes().endswith(b"\n"):
            break
        time.sleep(0.05)
    got = out.read_bytes()
    assert VALUE.encode() not in got and b"got [" not in got
    assert b"couldn't hand this command its secrets" in got


def test_the_parent_of_a_process_comes_from_the_system():
    assert handoff_check.parent(os.getpid()) == os.getppid()
    assert handoff_check.started_by(os.getpid(), os.getppid())
    assert not handoff_check.started_by(os.getppid(), os.getpid())
