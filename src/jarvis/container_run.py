"""Runs one of a session's Bash steps in its copy's container, without docker's socket in
the session's reach (features/code_setup.py puts this in front of every Bash step of a
session whose copy has a container).

    python -I container_run.py <relay socket> -- <command>

docker's own socket is all of docker to whatever reaches it (`docker run -v $HOME:/h …`
reads the whole Mac), so it's never let through a session's sandbox. Instead the backend
listens on a socket of its own for each container (Relay, below, in a folder only the owner
can open), and that one can do exactly one thing: run a command with /bin/sh -c in that one
container, in the copy's folder, and hand back what it prints and its exit status. This
program is the session's end of it: it sends the command it was given (as one argument,
never read by a shell on the Mac), writes what comes back to its own stdout and stderr, and
exits with the command's status. Killed (the Bash step's timeout, the owner's Stop), its
connection closes and the backend stops the docker exec it was waiting on.

The protocol, both ways over the one connection: the request is a single JSON line,
{"command": "<text>"}; the answer is frames of a type byte (b"o" stdout, b"e" stderr, b"x"
the exit status as ASCII digits, the last frame) and a 4-byte big-endian length, then that
many bytes.

Run with JARVIS's own Python in isolated mode (-I: no PYTHON* variables, no project folder on
the import path). It imports only the standard library, as Relay does.
"""

from __future__ import annotations

import contextlib
import errno
import json
import os
import selectors
import socket
import struct
import subprocess
import sys
import tempfile
import threading
from collections.abc import Callable
from pathlib import Path

CHUNK = 65536
REQUEST_MAX = 1 << 20  # bytes of one command at most (a Bash step's is far less)
CONNECTIONS_MAX = 16  # steps of one session running in its container at once, at most
GONE = 125  # the exit status when the backend's end went away before the command ended


def _frame(kind: bytes, data: bytes) -> bytes:
    return kind + struct.pack(">I", len(data)) + data


def _read_exact(sock: socket.socket, size: int) -> bytes:
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise ConnectionError("the relay closed")
        data += chunk
    return data


# ── the session's end ──


def parse(argv: list[str]) -> tuple[str, str]:
    """(the relay's socket, the command) from this program's arguments."""
    if len(argv) != 3 or argv[1] != "--" or not argv[0] or not argv[2]:
        raise ValueError("usage: container_run.py SOCKET -- COMMAND")
    return argv[0], argv[2]


def run(argv: list[str]) -> int:
    out, err = sys.stdout.buffer, sys.stderr.buffer
    try:
        path, command = parse(argv)
    except ValueError as exc:
        err.write(f"Eden couldn't run the command in the container: {exc}\n".encode())
        return 2
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(path)
    except OSError as exc:
        err.write(
            f"Eden couldn't reach this copy's container ({exc.strerror or exc}): the command "
            "didn't run.\n".encode()
        )
        return GONE
    with sock:
        sock.sendall(json.dumps({"command": command}).encode() + b"\n")
        try:
            while True:
                kind = _read_exact(sock, 1)
                (size,) = struct.unpack(">I", _read_exact(sock, 4))
                data = _read_exact(sock, size)
                if kind == b"x":
                    try:
                        return int(data.decode() or GONE)
                    except ValueError:
                        return GONE
                sink = out if kind == b"o" else err
                sink.write(data)
                sink.flush()
        except (ConnectionError, OSError):
            err.write(b"Eden lost the container's connection before the command ended.\n")
            return GONE


# ── the backend's end ──


class Relay:
    """One container's relay: a unix socket in a private folder, and a thread per
    connection that runs the command it's sent with argv_for(command) (docker exec in this
    container, the copy's folder) and streams it back. Nothing a connection sends picks the
    container, the folder or the program: only the text /bin/sh -c runs in there."""

    def __init__(
        self, argv_for: Callable[[str], list[str]], env: Callable[[], dict[str, str]]
    ) -> None:
        self.argv_for = argv_for
        self.env = env
        self.path = ""
        self._dir = ""
        self._server: socket.socket | None = None
        self._slots = threading.BoundedSemaphore(CONNECTIONS_MAX)
        self._procs: set[subprocess.Popen] = set()
        self._lock = threading.Lock()
        self._closed = False

    def start(self) -> str:
        """The socket's path, listening (made the first time). Raises OSError once closed:
        a closed relay never listens again (REL3-11: its old path came back, with no one
        accepting on it, so a session's every command waited for an answer forever)."""
        if self._closed:
            raise OSError(errno.EBADF, "this container's relay is closed")
        if self._server is not None:
            return self.path
        self._dir = tempfile.mkdtemp(prefix="edc-")  # (0700: only the owner can open it)
        self.path = str(Path(self._dir) / "r.sock")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(self.path)
        os.chmod(self.path, 0o600)
        server.listen(CONNECTIONS_MAX)
        self._server = server
        threading.Thread(target=self._accept, name="container-relay", daemon=True).start()
        return self.path

    def close(self) -> None:
        """No more connections, and every command still running through it stopped."""
        self._closed = True
        server, self._server = self._server, None
        if server is not None:
            with contextlib.suppress(OSError):
                server.shutdown(socket.SHUT_RDWR)
            with contextlib.suppress(OSError):
                server.close()
        with self._lock:
            procs = list(self._procs)
        for proc in procs:
            with contextlib.suppress(OSError):
                proc.kill()
        with contextlib.suppress(OSError):
            os.unlink(self.path)
        with contextlib.suppress(OSError):
            os.rmdir(self._dir)

    def _accept(self) -> None:
        server = self._server
        while server is not None and not self._closed:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            if not self._slots.acquire(blocking=False):
                with contextlib.suppress(OSError):
                    conn.sendall(_frame(b"e", b"Too many commands in this container at once.\n"))
                    conn.sendall(_frame(b"x", str(GONE).encode()))
                conn.close()
                continue
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _request(self, conn: socket.socket) -> str | None:
        data = b""
        while b"\n" not in data:
            chunk = conn.recv(CHUNK)
            if not chunk:
                return None
            data += chunk
            if len(data) > REQUEST_MAX:
                return None
        try:
            asked = json.loads(data.split(b"\n", 1)[0])
        except ValueError:
            return None
        command = asked.get("command") if isinstance(asked, dict) else None
        return command if isinstance(command, str) and command else None

    def _serve(self, conn: socket.socket) -> None:
        try:
            with conn:
                command = self._request(conn)
                if command is None:
                    conn.sendall(_frame(b"x", b"2"))
                    return
                conn.sendall(_frame(b"x", str(self._stream(conn, command)).encode()))
        except OSError:
            pass  # (the session's end went away: _stream has stopped the command)
        finally:
            self._slots.release()

    def _stream(self, conn: socket.socket, command: str) -> int:
        try:
            proc = subprocess.Popen(
                self.argv_for(command),
                env=self.env(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except OSError as exc:
            conn.sendall(_frame(b"e", f"docker couldn't start: {exc.strerror or exc}\n".encode()))
            return 127
        except ValueError:  # (a NUL byte in the command: Popen refuses it before running)
            conn.sendall(_frame(b"e", b"That command can't be run: it has a NUL byte in it.\n"))
            return 2
        with self._lock:
            self._procs.add(proc)
        assert proc.stdout is not None and proc.stderr is not None
        sel = selectors.DefaultSelector()
        sel.register(proc.stdout, selectors.EVENT_READ, b"o")
        sel.register(proc.stderr, selectors.EVENT_READ, b"e")
        sel.register(conn, selectors.EVENT_READ, None)  # (readable once it's closed)
        open_pipes = 2
        try:
            while open_pipes:
                for key, _ in sel.select():
                    if key.data is None:
                        if conn.recv(CHUNK):
                            continue  # (nothing more is asked of it: ignored)
                        raise OSError("the session's end went away")  # (stops the command)
                    chunk = os.read(key.fd, CHUNK)
                    if not chunk:
                        sel.unregister(key.fileobj)
                        open_pipes -= 1
                        continue
                    conn.sendall(_frame(key.data, chunk))
            code = proc.wait()
            # Killed by a signal: the shell's way, 128 + its number (137 for KILL), as
            # key_proxy's runs say it; -9 sent as is came out as 247 (REL3-14).
            return 128 - code if code < 0 else code
        except OSError:
            with contextlib.suppress(OSError):
                proc.kill()
            proc.wait()
            raise
        finally:
            sel.close()
            with self._lock:
                self._procs.discard(proc)
            for pipe in (proc.stdout, proc.stderr):
                with contextlib.suppress(OSError):
                    pipe.close()


def line(socket_path: str, command: str, python: str | None = None) -> str:
    """A Bash step as it runs: through this program, to the container's relay."""
    import shlex

    return shlex.join(
        [python or sys.executable, "-I", str(Path(__file__).resolve()), socket_path, "--", command]
    )


def inner(command: str, sockets: object = (), python: str | None = None) -> str | None:
    """The command a line made by line() runs in the container, or None when it isn't one
    (exactly this program, run by this Python in isolated mode, with one of these relay
    sockets): what a feature that judges commands (Exterminator Mode's allow list) looks at,
    since the session's hook has put this line in the command's place by then."""
    import shlex

    try:
        argv = shlex.split(str(command or ""))
    except ValueError:
        return None
    if len(argv) != 6 or argv[1] != "-I" or argv[4] != "--" or not argv[5]:
        return None
    if argv[0] != (python or sys.executable) or argv[2] != str(Path(__file__).resolve()):
        return None
    if argv[3] not in {str(path) for path in sockets or ()}:  # type: ignore[union-attr]
        return None
    return argv[5]


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
