"""The temp folders a killed backend left (tmp_sweep, REL3-12): a secret run's socket folder
(eden-handoff-*, eden-h-*) and a container relay's (edc-*) were removed only by a clean quit,
so every crash left one for good. At startup the certainly dead ones go: old, holding only
old sockets, a relay's refusing connections; a live one (a backend beside this one) never
does, and a handoff socket is never connected to (that would take the run)."""

import os
import socket
import tempfile
import time
from pathlib import Path

from jarvis import key_proxy, tmp_sweep

OLD = time.time() - tmp_sweep.STALE_SECONDS - 60


def short_root():
    # (a socket's path must be short: tmp_path is too long on a Mac)
    return Path(tempfile.mkdtemp(prefix="sw", dir="/tmp"))


def leftover(root, name, listen=False, age=OLD, extra=None):
    folder = root / name
    folder.mkdir(mode=0o700)
    path = folder / "r.sock"
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(str(path))
    if listen:
        s.listen(1)
    else:
        s.close()
    if extra:
        (folder / extra).write_text("x")
    for p in (path, folder):
        os.utime(p, (age, age))
    return folder, s


def test_only_the_certainly_dead_leftover_folders_go():
    root = short_root()
    try:
        dead_handoff, _ = leftover(root, "eden-handoff-a")
        dead_short, _ = leftover(root, "eden-h-b")
        dead_relay, _ = leftover(root, "edc-c")
        live_relay, server = leftover(root, "edc-d", listen=True)
        fresh, _ = leftover(root, "eden-handoff-e", age=time.time())
        other_file, _ = leftover(root, "edc-f", extra="notes.txt")
        unrelated, _ = leftover(root, "someone-else")
        gone = tmp_sweep.sweep([root])
        assert sorted(gone) == sorted([dead_handoff, dead_short, dead_relay])
        for kept in (live_relay, fresh, other_file, unrelated):
            assert kept.is_dir(), kept
        server.close()
    finally:
        for p in sorted(root.rglob("*"), reverse=True):
            p.unlink() if not p.is_dir() else p.rmdir()
        root.rmdir()


def test_a_handoffs_folders_go_at_quit_once_empty():
    root = short_root()
    try:
        offers = key_proxy.Handoffs(folder=root / "eden-handoff-x")
        folder = offers.folder()
        offers.close()
        assert not folder.exists()
        offers.folder()  # (made again should it be needed after all)
        (folder / "busy").write_text("x")
        offers.close()
        assert folder.is_dir()  # (something in it: left)
    finally:
        for p in sorted(root.rglob("*"), reverse=True):
            p.unlink() if not p.is_dir() else p.rmdir()
        root.rmdir()
