"""What a process is, and who started it: the check a run with the owner's secrets makes
before it goes ahead (key_proxy.Handoffs), and who has a named pipe open.

A command's run waits on a socket for that command's secret_run.py (see key_proxy). Its name
is random, but not hidden from the session: the folder it's in belongs to the owner, as does
every command a session runs, so `ls` lists it, and secret_run's own command line (in `ps`)
names it. So before the backend runs the command for whoever connected, it looks at that
process (the socket's peer) and goes ahead only when it is the very command the owner let
go: JARVIS's own Python, in isolated mode, running secret_run.py with this socket and
exactly the command on the owner's card, its executable the Python it names, nothing in its
environment that loads code into it (DYLD_*, LD_*), and started from this backend (its
parents lead here, where every session's Claude Code runs: a process started some other
way, or one left over after its parent went, isn't a session's command). Anything else, and
the socket is closed with nothing run: the command says it couldn't have its secrets, and
the log says why. The values never cross the socket in any case (the backend runs the
command, and sends back only its scrubbed output), so this check is what keeps another
process from taking the run, not what keeps the values in.

A process can rewrite the arguments KERN_PROCARGS2 shows, so the arguments alone are no proof
it's secret_run: the parent check is what a process started outside the sessions can't fake.

On macOS: libproc (each process's open files, by the pipe's device and inode) and
sysctl(KERN_PROCARGS2) (a process's arguments and environment), for the owner's own
processes, which is all a pipe in the owner's folder can be opened by. On Linux: /proc.
Elsewhere, or when the system won't say: no one is known, so nothing is written.

Standard library only; nothing here reads or writes a value.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import os
import struct
import sys
from functools import lru_cache

# libproc's numbers (sys/proc_info.h)
_PROC_PIDLISTFDS = 1
_PROC_PIDFDVNODEINFO = 1
_PROX_FDTYPE_VNODE = 1
_FDINFO = struct.Struct("iI")  # proc_fdinfo: fd, type
_VNODE_FDINFO_SIZE = 176  # vnode_fdinfo: proc_fileinfo (24) + vnode_info (152)
_VST_DEV, _VST_INO = 24, 32  # where vinfo_stat's dev (u32) and ino (u64) sit in it
_CTL_KERN, _KERN_PROCARGS2, _KERN_ARGMAX = 1, 49, 8
_LOADERS = ("DYLD_", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT")
_PROC_PIDTBSDINFO, _BSDINFO_SIZE, _BSD_PPID = 3, 136, 16  # proc_bsdinfo, and its pbi_ppid
_PARENTS_MAX = 64  # parents walked at most, looking for this backend


@lru_cache(maxsize=1)
def _libproc():
    if sys.platform != "darwin":
        return None
    try:
        lib = ctypes.CDLL(ctypes.util.find_library("proc") or "/usr/lib/libproc.dylib",
                          use_errno=True)  # fmt: skip
    except OSError:
        return None
    lib.proc_listallpids.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p,
                                 ctypes.c_int]  # fmt: skip
    lib.proc_pidfdinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_void_p,
                                   ctypes.c_int]  # fmt: skip
    lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
    return lib


def holders(fd: int) -> list[int] | None:
    """The processes (other than this one) that have the pipe open that fd is an end of;
    None when the system won't say."""
    try:
        info = os.fstat(fd)
    except OSError:
        return None
    lib = _libproc()
    if lib is not None:
        return _holders_darwin(lib, info.st_dev, info.st_ino)
    if os.path.isdir("/proc/self/fd"):
        return _holders_proc(info.st_dev, info.st_ino)
    return None


def _holders_darwin(lib, dev: int, ino: int) -> list[int] | None:
    count = lib.proc_listallpids(None, 0)
    if count <= 0:
        return None
    pids = (ctypes.c_int * (count + 256))()
    count = lib.proc_listallpids(pids, ctypes.sizeof(pids))
    if count <= 0:
        return None
    me, found = os.getpid(), []
    vnode = ctypes.create_string_buffer(_VNODE_FDINFO_SIZE)
    for pid in pids[:count]:
        if pid <= 0 or pid == me:
            continue
        size = lib.proc_pidinfo(pid, _PROC_PIDLISTFDS, 0, None, 0)
        if size <= 0:
            continue  # (another user's, or gone: it can't have the owner's pipe open)
        fds = ctypes.create_string_buffer(size + 32 * _FDINFO.size)
        size = lib.proc_pidinfo(pid, _PROC_PIDLISTFDS, 0, fds, len(fds))
        for at in range(0, max(0, size) - _FDINFO.size + 1, _FDINFO.size):
            number, kind = _FDINFO.unpack_from(fds.raw, at)
            if kind != _PROX_FDTYPE_VNODE:
                continue
            got = lib.proc_pidfdinfo(pid, number, _PROC_PIDFDVNODEINFO, vnode, _VNODE_FDINFO_SIZE)
            if got != _VNODE_FDINFO_SIZE:
                continue
            (vdev,) = struct.unpack_from("I", vnode.raw, _VST_DEV)
            (vino,) = struct.unpack_from("Q", vnode.raw, _VST_INO)
            if vdev == (dev & 0xFFFFFFFF) and vino == ino:
                found.append(pid)
                break
    return found


def _holders_proc(dev: int, ino: int) -> list[int] | None:
    me, found = os.getpid(), []
    try:
        entries = os.listdir("/proc")
    except OSError:
        return None
    for name in entries:
        if not name.isdigit() or int(name) == me:
            continue
        try:
            fds = os.listdir(f"/proc/{name}/fd")
        except OSError:
            continue
        for fd in fds:
            try:
                info = os.stat(f"/proc/{name}/fd/{fd}")
            except OSError:
                continue
            if info.st_dev == dev and info.st_ino == ino:
                found.append(int(name))
                break
    return found


def process(pid: int) -> tuple[str, list[str], list[str]] | None:
    """(its executable, its arguments, its environment as NAME=value) for one of the
    owner's processes; None when the system won't say."""
    lib = _libproc()
    if lib is not None:
        return _process_darwin(lib, pid)
    try:
        exe = os.readlink(f"/proc/{pid}/exe")
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            argv = f.read().split(b"\0")[:-1]
        with open(f"/proc/{pid}/environ", "rb") as f:
            env = f.read().split(b"\0")[:-1]
    except OSError:
        return None
    text = [x.decode("utf-8", "surrogateescape") for x in argv]
    return exe, text, [x.decode("utf-8", "surrogateescape") for x in env]


def _process_darwin(lib, pid: int) -> tuple[str, list[str], list[str]] | None:
    path = ctypes.create_string_buffer(4096)
    if lib.proc_pidpath(pid, path, len(path)) <= 0:
        return None
    libc = ctypes.CDLL(None, use_errno=True)
    libc.sysctl.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p,
                            ctypes.c_void_p, ctypes.c_size_t]  # fmt: skip
    argmax = ctypes.c_int(0)
    size = ctypes.c_size_t(ctypes.sizeof(argmax))
    mib = (ctypes.c_int * 2)(_CTL_KERN, _KERN_ARGMAX)
    if libc.sysctl(mib, 2, ctypes.byref(argmax), ctypes.byref(size), None, 0) != 0:
        return None
    raw = ctypes.create_string_buffer(argmax.value)
    size = ctypes.c_size_t(argmax.value)
    mib = (ctypes.c_int * 3)(_CTL_KERN, _KERN_PROCARGS2, pid)
    if libc.sysctl(mib, 3, raw, ctypes.byref(size), None, 0) != 0:
        return None
    data = raw.raw[: size.value]
    if len(data) < 4:
        return None
    (argc,) = struct.unpack_from("i", data, 0)
    # After argc: the executable's path, NULs to align, argc arguments, then the environment.
    rest = data[4:]
    end = rest.find(b"\0")
    if end < 0:
        return None
    at = end
    while at < len(rest) and rest[at] == 0:
        at += 1
    strings = rest[at:].split(b"\0")
    if len(strings) < argc:
        return None
    argv = [s.decode("utf-8", "surrogateescape") for s in strings[:argc]]
    env = []
    for s in strings[argc:]:
        if not s:
            break
        env.append(s.decode("utf-8", "surrogateescape"))
    return path.value.decode("utf-8", "surrogateescape"), argv, env


def parent(pid: int) -> int | None:
    """A process's parent; None when the system won't say (or it's gone)."""
    lib = _libproc()
    if lib is not None:
        info = ctypes.create_string_buffer(_BSDINFO_SIZE)
        if lib.proc_pidinfo(pid, _PROC_PIDTBSDINFO, 0, info, _BSDINFO_SIZE) != _BSDINFO_SIZE:
            return None
        return struct.unpack_from("I", info.raw, _BSD_PPID)[0]
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            stat = f.read()
        return int(stat[stat.rindex(b")") + 2 :].split()[1])  # (the name may hold spaces)
    except (OSError, ValueError, IndexError):
        return None


def started_by(pid: int, root: int) -> bool:
    """Whether root is one of this process's parents (its parent's parent, and so on)."""
    for _ in range(_PARENTS_MAX):
        up = parent(pid)
        if up is None or up <= 1 or up == pid:  # (launchd/init: it left its parent behind)
            return False
        if up == root:
            return True
        pid = up
    return False


def is_expected(pid: int, expected: list[str], root: int | None = None) -> str:
    """Nothing ("") when this process is the command the owner let go (expected: its exact arguments,
    the first being the Python to run; root, when given, one of its parents: the backend its
    session runs under); else why it isn't, for the log (no values)."""
    found = process(pid)
    if found is None:
        return "the system wouldn't say what it is"
    exe, argv, env = found
    if argv != expected:
        return "it isn't the command the owner let go"
    try:
        same = os.path.samefile(exe, os.path.realpath(expected[0]))
    except OSError:
        same = False
    if not same:
        return "its program isn't JARVIS's Python"
    if any(item.startswith(_LOADERS) for item in env):
        return "its environment loads other code into it"
    if root is not None and not started_by(pid, root):
        return "it wasn't started by one of this app's sessions"
    return ""
