"""A command's secrets are used only for that command (key_proxy.Handoffs with handoff_check):
the socket its run waits on can be found by any of the session's processes (its folder and
secret_run's command line are the owner's), so another process that connects first, one with
the right arguments but something loaded into it, or two at once, get nothing run, and the
command the owner let go, run as code_secrets.wrap words it, prints its output scrubbed. And
since round 3 (R2-4) the values never cross the socket at all: the backend runs the command
itself, so even a process that gets past every check (arguments can be rewritten) reads only
scrubbed output. (Before: the values were written into a named pipe, as they are.)"""

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
# A process of the session's that finds the socket and takes the run (saying "go", as
# secret_run does), then reads all that comes back.
RIVAL = (
    "import json, os, socket, sys\n"
    "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n"
    "try:\n"
    "    s.connect(sys.argv[1])\n"
    "except OSError:\n"
    "    sys.exit(0)\n"
    "s.sendall(b'go\\n')\n"
    "while True:\n"
    "    chunk = s.recv(65536)\n"
    "    if not chunk:\n"
    "        break\n"
    "    sys.stdout.buffer.write(chunk)\n"
)

pytestmark = pytest.mark.skipif(
    handoff_check._libproc() is None and not os.path.isdir("/proc/self/fd"),
    reason="no way on this system to see who has a pipe open",
)


OWNER: dict[str, list[tuple[str, int]]] = {}  # socket -> what the owner was shown of its run


def offer(tmp_path, command=COMMAND, expect=True, env=None, cwd=None):
    offers = Handoffs(folder=tmp_path / "handoff", wait=10)
    wanted = (lambda pipe: shlex.split(code_secrets.wrap(command, pipe))) if expect else None
    seen: list[tuple[str, int]] = []
    sock = offers.offer({"SECRET_X": VALUE}, [], expect=wanted,
                        command=code_secrets.shell_argv(command), env=env, cwd=cwd,
                        on_output=lambda text, status: seen.append((text, status)))  # fmt: skip
    OWNER[sock] = seen
    return sock


def owner_saw(sock, seconds=10.0):
    """What the owner's transcript got of the run on this socket ("" for no run)."""
    end = time.monotonic() + seconds
    while time.monotonic() < end and not OWNER[sock]:
        time.sleep(0.02)
    return OWNER[sock][0][0] if OWNER[sock] else ""


def run(argv, env=None, timeout=30):
    return subprocess.run(argv, capture_output=True, timeout=timeout, env=env)


def test_the_command_the_owner_let_go_gets_its_values_scrubbed(tmp_path):
    pipe = offer(tmp_path)
    done = run(shlex.split(code_secrets.wrap(COMMAND, pipe)))
    assert done.returncode == 0, done.stderr
    # S3-2: what it printed is the owner's (scrubbed); Claude's tool output says where it went.
    assert owner_saw(pipe) == "got [$SECRET_X]\n"
    assert b"got [" not in done.stdout and b"went to the owner only" in done.stdout
    assert b"exited with status 0" in done.stdout
    assert VALUE.encode() not in done.stdout + done.stderr


def test_another_process_that_opens_the_pipe_first_gets_nothing(tmp_path):
    pipe = offer(tmp_path)
    # A loop the session left running finds the name (ls of the folder, or ps) and opens it.
    rival = run([sys.executable, "-I", "-c", RIVAL, pipe])
    assert rival.returncode == 0 and rival.stdout == b""
    # The command itself comes too late: the socket is gone, so it doesn't run at all.
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
    assert done.returncode == 0 and owner_saw(pipe) == "got [$SECRET_X]\n", done.stderr


def test_a_path_of_its_own_never_runs_the_command(tmp_path):
    # A PATH with its own `tr` first: the command runs with the session's PATH instead.
    leak = tmp_path / "leak"
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    fake = bin_ / "tr"
    fake.write_text(f'#!/bin/sh\nprintf "%s" "$SECRET_X" > {shlex.quote(str(leak))}\n')
    fake.chmod(0o755)
    command = 'printf x | tr x y; echo " [$SECRET_X]"'
    pipe = offer(tmp_path, command, env=dict(os.environ))
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}"}
    done = run(shlex.split(code_secrets.wrap(command, pipe)), env=env)
    assert not leak.exists()
    assert done.returncode == 0 and owner_saw(pipe) == "y [$SECRET_X]\n", done.stderr


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


# ── round 3, R2-4: the values never cross the socket, whoever takes the run ──


def test_a_process_that_gets_past_every_check_still_never_reads_a_value(tmp_path):
    # The race round 2 left: a process the session starts with the exact approved
    # arguments (they can be rewritten) passes the checks. Stood in for here by a run with
    # no check at all: the first process to connect is let in, and it reads everything
    # that comes back. Before, that was the values themselves, as JSON; now it's the
    # command's output with $SECRET_X in the value's place.
    sock = offer(tmp_path, expect=False)
    rival = run([sys.executable, "-I", "-c", RIVAL, sock])
    assert rival.returncode == 0
    assert VALUE.encode() not in rival.stdout
    # (and since S3-2 not even the scrubbed output: that went to the owner)
    assert b"got [" not in rival.stdout and owner_saw(sock) == "got [$SECRET_X]\n"


def test_the_environment_a_rival_sends_never_runs_code_of_its_own(tmp_path):
    # Whoever connects says what environment the command runs with: a BASH_ENV, a PATH of
    # its own, exported functions, are taken out before the backend runs it.
    leak = tmp_path / "leak"
    evil = tmp_path / "evil.sh"
    evil.write_text(f'printf "%s" "$SECRET_X" >> {shlex.quote(str(leak))}\n')
    env = {**os.environ, "BASH_ENV": str(evil), "ENV": str(evil),
           "BASH_FUNC_echo%%": f"() {{ . {shlex.quote(str(evil))}; }}"}  # fmt: skip
    sock = offer(tmp_path, expect=False, env=dict(os.environ))
    rival = run([sys.executable, "-I", "-c", RIVAL, sock], env=env)
    assert not leak.exists() or VALUE not in leak.read_text()
    assert VALUE.encode() not in rival.stdout


def test_the_command_stops_when_its_secret_run_goes(tmp_path):
    # Claude Code's own time limit (or a stop) ends secret_run: the command the backend
    # started for it goes too, not left running on with the values.
    marker = tmp_path / "still-running"
    command = f'sleep 0.6; touch {shlex.quote(str(marker))}; echo "[$SECRET_X]"'
    sock = offer(tmp_path, command)
    proc = subprocess.Popen(shlex.split(code_secrets.wrap(command, sock)),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)  # fmt: skip
    time.sleep(0.3)
    proc.kill()
    proc.wait(timeout=10)
    time.sleep(1.5)
    assert not marker.exists()


# ── round 3, S3-1: where it runs and its environment are the session's, never the caller's ──

RIVAL_SAYS = (  # a rival that says (as secret_run did until S3-1) where and with what to run
    "import json, os, socket, sys\n"
    "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n"
    "s.connect(sys.argv[1])\n"
    "env = dict(os.environ, NODE_OPTIONS='--require /tmp/evil.js', GIT_SSH_COMMAND='evil',\n"
    "           HOME='/tmp/rival-home')\n"
    "s.sendall(json.dumps({'cwd': '/', 'env': env}).encode() + b'\\n')\n"
    "while s.recv(65536):\n"
    "    pass\n"
)


def test_the_command_runs_in_the_sessions_folder_with_the_sessions_env(tmp_path):
    here, elsewhere = tmp_path / "project", tmp_path / "elsewhere"
    here.mkdir()
    elsewhere.mkdir()
    line = 'pwd; echo "[$SECRET_X] [${NODE_OPTIONS-}] [$OWN]"'
    session = {"PATH": os.environ["PATH"], "OWN": "the-sessions"}
    sock = offer(tmp_path, line, env=session, cwd=str(here))
    # secret_run itself is started somewhere else, with a NODE_OPTIONS of the session's own.
    caller = {**os.environ, "NODE_OPTIONS": "--require /tmp/evil.js", "OWN": "the-callers"}
    done = subprocess.run(shlex.split(code_secrets.wrap(line, sock)), capture_output=True,
                          timeout=30, cwd=elsewhere, env=caller)  # fmt: skip
    assert done.returncode == 0, done.stderr
    lines = owner_saw(sock).splitlines()
    assert lines[0] == str(here.resolve())
    assert lines[1] == "[$SECRET_X] [] [the-sessions]"


def test_a_rival_that_says_where_and_with_what_gets_the_sessions_own(tmp_path):
    # With no check (any first process), one that sends a folder and an environment of its
    # own, as secret_run did, gets no run at all: all secret_run says now is "go".
    line = 'pwd; echo "[${NODE_OPTIONS-}] [${GIT_SSH_COMMAND-}] [$HOME]"'
    sock = offer(tmp_path, line, expect=False, env={"PATH": os.environ["PATH"], "HOME": "/h"},
                 cwd=str(tmp_path))  # fmt: skip
    run([sys.executable, "-I", "-c", RIVAL_SAYS, sock])
    assert owner_saw(sock, seconds=1.0) == ""
    # And secret_run's own request is that one word.
    from jarvis import secret_run

    assert secret_run.request() == b"go\n"
