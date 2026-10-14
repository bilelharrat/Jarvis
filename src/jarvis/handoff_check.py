"""Who has a named pipe open, and what they are: the check a secret's handoff makes before it
writes (key_proxy.Handoffs).

A command's secrets wait in a named pipe for that command's secret_run.py (see key_proxy).
Its name is random, but not hidden from the session: the folder it's in belongs to the owner,
as does every command a session runs, so `ls` lists it, and secret_run's own command line
(in `ps`) names it. Any of the session's commands could open it first, a loop left running in
the background for instance, and read the values as they are: never scrubbed, since only
secret_run scrubs. So before a single byte is written, the backend looks at who has the pipe
open (after its name is gone, so no one else can open it) and writes only when that is one
process, and that process is the very command the owner let go: JARVIS's own Python, in
isolated mode, running secret_run.py with this pipe and exactly the command on the owner's
card, its executable the Python it names, and nothing in its environment that loads code into
it (DYLD_*, LD_*). Anything else, and the pipe is closed unwritten: the reader gets nothing,
the command says it couldn't have its secrets, and the log says why.

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


def is_expected(pid: int, expected: list[str]) -> str:
    """Nothing ("") when this process is the command the owner let go (expected: its exact arguments,
    the first being the Python to run); else why it isn't, for the log (no values)."""
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
    return ""
