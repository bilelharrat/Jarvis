"""Opens JARVIS when a paired phone asks for it and JARVIS isn't running.

While the phone companion is on, a LaunchAgent has launchd keep a listener on WAKE_PORT.
Nothing runs until a connection comes: launchd then starts `python -m jarvis.companion_wake`
with the connection as its stdin (inetd style). It speaks TLS with the companion's own
certificate, so the phone's pin holds; takes one `POST /wake` carrying a paired device's
token; opens the app in the background (`open -g`, which only brings it up if it isn't
already); answers 202 and exits. Anything else gets 401 or 404 and nothing opens.

Only the app sets JARVIS_APP_BUNDLE for its backend, so tests and a backend run by hand never
install or remove the agent.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import logging
import os
import plistlib
import secrets
import socket
import ssl
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

log = logging.getLogger("jarvis")

LABEL = "com.bshventures.jarvis.wake"
WAKE_PORT = 8764  # beside the companion's 8765
APP_ENV = "JARVIS_APP_BUNDLE"  # the app's own .app, set by main.js for the backend
CERT_FILE = "companion-tls.pem"  # companion_tls.FILE_NAME
DEVICES_FILE = "devices.json"  # remote.Devices
MAX_REQUEST = 8 * 1024
SECONDS = 10

Run = Callable[..., Any]


def plist_path(home: Path | None = None) -> Path:
    return (home or Path.home()) / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def agent(app: str, folder: Path, python: str, port: int = WAKE_PORT) -> dict[str, Any]:
    """The LaunchAgent: launchd listens on port and starts one answer per connection."""
    return {
        "Label": LABEL,
        "ProgramArguments": [
            python,
            "-m",
            "jarvis.companion_wake",
            "--open",
            app,
            "--folder",
            str(folder),
        ],  # fmt: skip
        "inetdCompatibility": {"Wait": False},
        "Sockets": {"Listeners": {"SockServiceName": str(port), "SockType": "stream"}},
        "WorkingDirectory": str(folder),
        "EnvironmentVariables": {"PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"},
        "ProcessType": "Background",
    }


def _domain() -> str:
    return f"gui/{os.getuid()}"


def install(
    app: str | None = None,
    folder: Path | None = None,
    python: str = sys.executable,
    home: Path | None = None,
    run: Run = subprocess.run,
) -> bool:
    """Has launchd listen for the phone, for this app. True when the agent is in place.
    app: the .app to open (default: what the app told its backend; none, nothing done)."""
    app = app if app is not None else os.environ.get(APP_ENV, "")
    if not app or not app.endswith(".app") or not Path(app).is_dir():
        return False
    if folder is None:
        from .prefs import APP_SUPPORT

        folder = APP_SUPPORT
    path = plist_path(home)
    wanted = plistlib.dumps(agent(app, folder, python))
    try:
        current = path.read_bytes()
    except OSError:
        current = b""
    loaded = (
        run(["/bin/launchctl", "print", f"{_domain()}/{LABEL}"], capture_output=True).returncode
        == 0
    )
    if current == wanted and loaded:
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(wanted)
    if loaded:
        run(["/bin/launchctl", "bootout", f"{_domain()}/{LABEL}"], capture_output=True)
    done = run(["/bin/launchctl", "bootstrap", _domain(), str(path)], capture_output=True)
    if done.returncode != 0:
        log.warning("companion: couldn't start the wake listener: %s", done.stderr)
        return False
    log.info("companion: the phone can open JARVIS (port %d)", WAKE_PORT)
    return True


def uninstall(home: Path | None = None, run: Run = subprocess.run, *, force: bool = False) -> None:
    """Stops listening for the phone (the companion was turned off). Only from the app's own
    backend, unless forced."""
    if not force and not os.environ.get(APP_ENV):
        return
    path = plist_path(home)
    if not path.exists():
        return
    run(["/bin/launchctl", "bootout", f"{_domain()}/{LABEL}"], capture_output=True)
    with contextlib.suppress(FileNotFoundError):
        path.unlink()


# ── one answer (launchd starts this per connection) ──


def paired(token: str, folder: Path) -> bool:
    """Whether the token is a paired device's (by its hash, as the companion keeps them)."""
    if not token or len(token) > 200:
        return False
    try:
        rows = json.loads((folder / DEVICES_FILE).read_text())
    except (OSError, ValueError):
        return False
    digest = hashlib.sha256(token.encode()).hexdigest()
    hashes = (
        [row.get("token_hash") for row in rows if isinstance(row, dict)]
        if isinstance(rows, list)
        else []
    )
    return any(isinstance(h, str) and h and secrets.compare_digest(h, digest) for h in hashes)


def answer(request: bytes, folder: Path) -> tuple[int, dict[str, Any]]:
    """(status, body) for one request; 202 means: open the app."""
    head = request.split(b"\r\n\r\n", 1)[0].decode("latin-1")
    lines = head.split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3 or parts[0] != "POST" or parts[1].split("?")[0] != "/wake":
        return 404, {"error": "Not here."}
    token = ""
    for line in lines[1:]:
        name, _, value = line.partition(":")
        if name.strip().lower() == "authorization":
            value = value.strip()
            token = value[7:] if value.lower().startswith("bearer ") else ""
    if not paired(token, folder):
        return 401, {"error": "Pair this device first."}
    return 202, {"ok": True, "opening": True}


def _read(conn: Any) -> bytes:
    raw = b""
    while b"\r\n\r\n" not in raw and len(raw) < MAX_REQUEST:
        chunk = conn.recv(2048)
        if not chunk:
            break
        raw += chunk
    return raw


_REASONS = {202: "Accepted", 401: "Unauthorized", 404: "Not Found"}


def respond(conn: Any, status: int, body: dict[str, Any]) -> None:
    data = json.dumps(body).encode()
    conn.sendall(
        f"HTTP/1.1 {status} {_REASONS[status]}\r\nContent-Type: application/json\r\n"
        f"Content-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode()
        + data
    )


def serve(conn: Any, app: str, folder: Path, opener: Run | None = None) -> int:
    """Reads one request, answers it, and opens the app when it was a paired phone's."""
    status, body = answer(_read(conn), folder)
    if status == 202:
        (opener or subprocess.run)(
            ["/usr/bin/open", "-g", app], capture_output=True, timeout=SECONDS
        )
    respond(conn, status, body)
    return status


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="jarvis.companion_wake")
    parser.add_argument("--open", required=True)
    parser.add_argument("--folder", required=True)
    args = parser.parse_args(argv)
    folder = Path(args.folder)
    cert = folder / CERT_FILE
    if not cert.is_file():
        return 0  # the companion never made its certificate: nothing a phone could trust
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(cert))
    context.set_alpn_protocols(["http/1.1"])
    sock = socket.socket(fileno=sys.stdin.fileno())  # the connection launchd accepted
    sock.settimeout(SECONDS)
    try:
        with context.wrap_socket(sock, server_side=True) as conn:
            serve(conn, args.open, folder)
    except (OSError, ssl.SSLError):
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
