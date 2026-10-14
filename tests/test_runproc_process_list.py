"""runproc's looks through the Mac's process list (kill_marked, session_pids) with psutil.

psutil keeps one Process object per pid across every process_iter, and each call with attrs
writes its own p.info over the last: another thread's process_iter(["pid"]) (kill_leftovers,
run off the loop at every command's end) or (["name"]) (mac_tools) left p.info without the
keys this one asked for. kill_marked read p.info["ppid"] and stopped with a KeyError, so an
Exterminator run Stopped mid-suite ended "failed" with the suite's leftovers still running
(seen in the full suite: test_stop_while_the_suite_runs_stops_it_now); session_pids read
p.info["pid"], and kill_leftovers swallowed the KeyError, killing nothing it had found. Each
reads the process itself now, never p.info.
"""

from __future__ import annotations

import os

import psutil

from jarvis import runproc


class Proc:
    """A process as psutil gives it, its info written over by another call's attrs."""

    def __init__(self, pid, env=None, ppid=1, created=0.0, cwd="/", sid=None):
        self.pid = pid
        self.info = {"name": "other call's"}  # (no pid, ppid or create_time)
        self._env, self._ppid, self._created, self._cwd = env or {}, ppid, created, cwd
        self.sid = sid
        self.killed = False

    def environ(self):
        return self._env

    def ppid(self):
        return self._ppid

    def create_time(self):
        return self._created

    def cwd(self):
        return self._cwd

    def kill(self):
        self.killed = True


def test_kill_marked_reads_each_process_not_another_calls_info(monkeypatch, tmp_path):
    marked = Proc(90001, env={"EDEN_MARK": "m1"}, ppid=500)
    orphan = Proc(90002, ppid=1, created=200.0, cwd=str(tmp_path))
    old = Proc(90003, ppid=1, created=50.0, cwd=str(tmp_path))  # (from before the run)
    elsewhere = Proc(90004, ppid=1, created=200.0, cwd="/")
    procs = [marked, orphan, old, elsewhere]
    monkeypatch.setattr(psutil, "process_iter", lambda attrs=None: iter(procs))
    killed = runproc.kill_marked("EDEN_MARK", "m1", tmp_path, since=100.0)
    assert sorted(killed) == [90001, 90002]
    assert marked.killed and orphan.killed and not old.killed and not elsewhere.killed


def test_session_pids_reads_each_process_not_another_calls_info(monkeypatch):
    procs = [Proc(90011, sid=7), Proc(90012, sid=8), Proc(90013, sid=7)]
    monkeypatch.setattr(psutil, "process_iter", lambda attrs=None: iter(procs))
    by_pid = {p.pid: p.sid for p in procs}
    monkeypatch.setattr(os, "getsid", lambda pid: by_pid[pid])
    monkeypatch.setattr(runproc.osplat, "IS_WIN", False)
    assert runproc.session_pids(7) == [90011, 90013]
