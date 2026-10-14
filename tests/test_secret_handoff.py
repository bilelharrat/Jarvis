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
