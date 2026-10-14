# ruff: noqa: F811  (the fixtures hub and projects come from test_code_triggers)
"""The Linear/Slack listener (hook_listener.py) against sockets that never finish a request:
silent ones and one sending a byte at a time are cut off at the request's deadline, and
the real delivery gets in meanwhile (it used to get a 503 once 32 sat open). And the two
ways it can fail to listen, each said, never swapped for another port. On an ephemeral port
only, never 8766."""

import asyncio
import socket
import time

from test_code_triggers import configure, free_port, hub, projects, settle, ticket  # noqa: F401
from trigger_fakes import linear_body

from jarvis import hook_listener
from jarvis.features import code_triggers


async def post(port, path, body, headers, timeout=5.0):
    r, w = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), timeout)
    head = f"POST {path} HTTP/1.1\r\nHost: tunnel.example\r\nContent-Length: {len(body)}\r\nConnection: close\r\n"
    head += "".join(f"{k}: {v}\r\n" for k, v in headers.items()) + "\r\n"
    w.write(head.encode() + body)
    await w.drain()
    data = await asyncio.wait_for(r.read(), timeout)
    w.close()
    return data.split(b"\r\n", 1)[0].decode()


async def started(hub):
    t = hub.code_triggers
    configure(hub, "linear")
    await t.sync()
    assert t.listener.running and t.listener.port != code_triggers.PORT
    return t.listener.port


def closed(s):
    s.setblocking(False)
    try:
        return s.recv(1) == b""
    except BlockingIOError:
        return False
    except OSError:
        return True


async def test_silent_connections_dont_starve_the_listener_and_are_cut_off(hub, monkeypatch):
    monkeypatch.setattr(hook_listener, "REQUEST_SECONDS", 1.0)
    port = await started(hub)
    idle = [socket.create_connection(("127.0.0.1", port)) for _ in range(40)]
    await asyncio.sleep(0.3)
    body, headers = linear_body(**ticket())
    assert "200" in await post(port, "/hooks/eden-linear?token=hooktok-linear", body, headers)
    await settle()
    assert len(hub.started) == 1
    await asyncio.sleep(1.5)  # past the deadline: the silent ones are gone
    try:
        assert all(closed(s) for s in idle)
    finally:
        for s in idle:
            s.close()


async def test_a_request_sent_a_byte_at_a_time_is_cut_off(hub, monkeypatch):
    monkeypatch.setattr(hook_listener, "REQUEST_SECONDS", 1.0)
    port = await started(hub)
    r, w = await asyncio.open_connection("127.0.0.1", port)
    t0 = time.monotonic()
    cut = False
    for ch in b"POST /hooks/eden-linear?token=x HTTP/1.1\r\nHost: a\r\nX-A: " + b"a" * 40:
        try:
            w.write(bytes([ch]))
            await w.drain()
            if await asyncio.wait_for(r.read(1), 0.2) == b"":
                cut = True
                break
        except TimeoutError:
            pass
        except ConnectionError:
            cut = True
            break
    w.close()
    assert cut and time.monotonic() - t0 < 5


async def test_connections_past_the_cap_are_closed_at_once(hub, monkeypatch):
    monkeypatch.setattr(hook_listener, "CONNECTIONS", 3)
    port = await started(hub)
    socks = [socket.create_connection(("127.0.0.1", port)) for _ in range(5)]
    await asyncio.sleep(0.3)
    try:
        assert [closed(s) for s in socks] == [False, False, False, True, True]
    finally:
        for s in socks:
            s.close()


async def test_a_port_another_app_bound_exactly_is_said_as_taken(hub, monkeypatch):
    """Past the probe (it can miss a listener that doesn't answer in time): the bind
    itself fails, its socket is let go, and the owner is told the port is taken."""
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    port = blocker.getsockname()[1]
    monkeypatch.setattr(hook_listener, "_taken", lambda _port: False)
    try:
        lis = hook_listener.HookListener(("eden-linear",), hub.inbound_hook)
        assert await lis.start(port) is False
        assert "taken by another app" in lis.error and not lis.running and lis.port == 0
    finally:
        blocker.close()


async def test_a_server_that_never_starts_is_said_and_its_socket_closed(hub, monkeypatch):
    from jarvis import mcp_endpoint

    class Dud:
        started = False
        should_exit = False

        async def serve(self, sockets):
            return None

    monkeypatch.setattr(mcp_endpoint, "quiet_server", lambda _config: Dud())
    lis = hook_listener.HookListener(("eden-linear",), hub.inbound_hook)
    port = free_port()
    assert await lis.start(port) is False
    assert lis.error == f"Eden couldn't listen on port {port}." and not lis.running
    with socket.socket() as s:  # (its socket was let go: the port is free again)
        s.bind(("127.0.0.1", port))


async def test_close_now_stops_listening_at_once(hub):
    port = await started(hub)
    lis = hub.code_triggers.listener
    lis.close_now()
    assert lis.port == 0
    await asyncio.sleep(0.3)
    with socket.socket() as s:
        assert s.connect_ex(("127.0.0.1", port)) != 0
    hook_listener.HookListener(("x",), hub.inbound_hook).close_now()  # (never started: nothing)
