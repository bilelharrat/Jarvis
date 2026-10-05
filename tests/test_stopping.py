"""Quitting: the backend is gone, its data lock with it, inside the app's five-second wait.

Measured: the app's Quit once took 21 s to let go of the backend ("stopping didn't finish
in time: ending now"). Two things held it: the app only hides its window while it waits,
so the window's socket stayed open and the server didn't start stopping until the app gave
up and closed it; then close() waited on Jarvis Code's process to exit, which the Claude
SDK allows up to ~20 s. Here a real server (an ephemeral port on 127.0.0.1, never 8765)
keeps a window's socket open while Jarvis Code's disconnect hangs, and is stopped the way a
quit stops it."""

import asyncio
import contextlib
import logging
import subprocess
import sys
import textwrap
import time

import psutil
import uvicorn
import websockets
from conftest import CALENDAR_TURN, FakeClient

from jarvis import hub as hub_module
from jarvis.hub import Hub
from jarvis.server import SERVE_OPTIONS, create_app

APP_WAIT = 5.0  # app/features/shell.js: wait.quit


class SlowToLeave(FakeClient):
    """A Jarvis Code session whose process takes its time to exit."""

    script = CALENDAR_TURN

    async def disconnect(self):
        await asyncio.sleep(30)


async def test_a_quit_lets_go_within_the_apps_wait(settings, quiet_speaker, isolated, caplog):
    hub = Hub(settings, client_factory=SlowToLeave, speaker=quiet_speaker, transcriber=object(), poll=False, **isolated)  # fmt: skip
    config = uvicorn.Config(create_app(hub, "s3cret"), host="127.0.0.1", port=0, **SERVE_OPTIONS)
    server = uvicorn.Server(config)
    serving = asyncio.create_task(server.serve())
    for _ in range(200):
        if server.started:
            break
        await asyncio.sleep(0.02)
    port = server.servers[0].sockets[0].getsockname()[1]
    hub.client = SlowToLeave()  # a session is open
    url = f"ws://127.0.0.1:{port}/ws?token=s3cret"
    async with websockets.connect(url, origin=f"http://127.0.0.1:{port}") as window:
        await asyncio.wait_for(window.recv(), 5)  # its hello: the window is there
        with caplog.at_level(logging.INFO, logger="jarvis"):
            began = time.monotonic()
            server.should_exit = True  # what SIGTERM does
            await asyncio.wait_for(serving, 20)
            took = time.monotonic() - began
    print(f"\nstopping with a window open and Jarvis Code slow to leave: {took:.2f}s")
    assert took < APP_WAIT - 0.5
    assert any("Jarvis Code's session took over" in r.getMessage() for r in caplog.records)


async def test_close_never_waits_past_its_budget(settings, quiet_speaker, isolated, caplog):
    hub = Hub(settings, client_factory=SlowToLeave, speaker=quiet_speaker, transcriber=object(), poll=False, **isolated)  # fmt: skip
    await hub.start()
    hub.client = SlowToLeave()

    async def hung():
        await asyncio.sleep(30)

    hub.remote.stop = hung  # the phone link hangs too
    began = time.monotonic()
    with caplog.at_level(logging.INFO, logger="jarvis"):
        await hub.close()
    took = time.monotonic() - began
    assert took < hub_module.CLOSE_BUDGET + 0.5
    named = [r.getMessage() for r in caplog.records if "going on without it" in r.getMessage()]
    assert any("the phone link" in m for m in named) and any("Jarvis Code" in m for m in named)


def test_nothing_it_started_outlives_a_stop(tmp_path):
    # In a process of its own (ending children here would end pytest's): it starts a
    # process that ignores the polite ask, stops, and says what it had started and how
    # long the stop took. The stubborn one says when it ignores the ask: asked before
    # that, it simply ended, and the wait and the kill after it went untried.
    script = tmp_path / "stopper.py"
    script.write_text(
        textwrap.dedent(
            """
            import subprocess, sys, time
            from jarvis.server import end_children
            stubborn = subprocess.Popen(
                [sys.executable, "-c",
                 "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                 "print(flush=True); time.sleep(60)"],
                stdout=subprocess.PIPE,
            )
            stubborn.stdout.readline()  # it ignores the polite ask from here on
            quick = subprocess.Popen(["sleep", "60"])
            began = time.monotonic()
            ended = end_children(grace=0.5)
            print(stubborn.pid, quick.pid, ended, time.monotonic() - began, flush=True)
            """
        )
    )
    stopper = subprocess.Popen([sys.executable, str(script)], stdout=subprocess.PIPE, text=True)
    try:
        out, _ = stopper.communicate(timeout=300)  # importing the server: a minute when busy
    except subprocess.TimeoutExpired:
        # Nothing of the test's own outlives it either.
        for proc in [*psutil.Process(stopper.pid).children(recursive=True), stopper]:
            with contextlib.suppress(psutil.Error, ProcessLookupError):
                proc.kill()
        stopper.communicate()
        raise
    stubborn, quick, ended, took = out.split()
    assert int(ended) == 2
    assert float(took) >= 0.45  # the grace waited out: the stubborn one had to be killed
    for pid in (int(stubborn), int(quick)):
        assert not psutil.pid_exists(pid) or psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
