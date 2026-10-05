"""Stress the ways in from outside the window, heavier than the tests (opt-in, not part of
pytest's run; nothing here reaches the network, a model or the owner's data):

    uv run python scripts/stress_r2_reach.py            # every stage
    uv run python scripts/stress_r2_reach.py companion  # or channels, mcp, relay, bridge

It runs its stages under pytest with the test suite's own fixtures (tests/conftest.py: temp
stores, no Keychain, a fake Claude) and one of its own (no AppleScript, no EventKit: the
calendar tool once reached the real Calendar), each in temp folders removed at the end, and
prints what it measured:

- companion: the real HTTPS server on 127.0.0.1 (a free port) with a paired phone polling
  /api/state 2 to 64 at once, with the budgets as shipped and raised; wrong tokens, bodies
  past every cap, a body that trickles, and pairing guesses from a thousand addresses.
- channels: the router through a fake chat app: strangers (with a pairing code up and
  without), the owner flooding one chat, and long or odd messages from each, timed.
- mcp: the endpoint on a Unix socket, 2 to 64 clients at once, malformed calls, and new
  sessions while the owner is asked about each.
- relay: a fake askeden.com opening 100 streams at once, then 20 MB through one and back.
- bridge: JSON-RPC lines of growing size and ids of every JSON type.

Each stage watches the event loop's lag (a ticker measuring its own delays), open file
descriptors, threads, asyncio tasks and the process's memory.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx
import psutil
import pytest

ROOT = Path(__file__).resolve().parents[1]


# ── measuring ──


class Lag:
    """The event loop's worst and typical lag while a stage runs: a ticker that sleeps
    EVERY and notes how late it woke."""

    EVERY = 0.005

    def __init__(self) -> None:
        self.late: list[float] = []
        self._task: asyncio.Task | None = None

    async def _tick(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            at = loop.time()
            await asyncio.sleep(self.EVERY)
            self.late.append(max(0.0, loop.time() - at - self.EVERY))

    def __enter__(self) -> Lag:
        self._task = asyncio.get_running_loop().create_task(self._tick())
        return self

    def __exit__(self, *_exc: object) -> None:
        if self._task is not None:
            self._task.cancel()

    def said(self) -> str:
        if not self.late:
            return "lag n/a"
        worst = max(self.late)
        p95 = sorted(self.late)[int(len(self.late) * 0.95) - 1] if len(self.late) > 20 else worst
        return f"lag worst {worst * 1000:.0f} ms, p95 {p95 * 1000:.1f} ms"


def vitals() -> dict[str, float]:
    me = psutil.Process()
    try:
        tasks = len(asyncio.all_tasks())
    except RuntimeError:
        tasks = 0
    return {
        "rss_mb": me.memory_info().rss / 1e6,
        "fds": me.num_fds(),
        "threads": threading.active_count(),
        "tasks": tasks,
    }


def show(name: str, before: dict[str, float], extra: str = "") -> None:
    after = vitals()
    print(
        f"  {name:<46} rss {after['rss_mb']:.0f} MB ({after['rss_mb'] - before['rss_mb']:+.0f}),"
        f" fds {after['fds']:.0f} ({after['fds'] - before['fds']:+.0f}),"
        f" threads {after['threads']:.0f}, tasks {after['tasks']:.0f}  {extra}"
    )


def spread(times: list[float]) -> str:
    if not times:
        return "-"
    times = sorted(times)
    p95 = times[max(0, int(len(times) * 0.95) - 1)]
    return (
        f"p50 {statistics.median(times) * 1000:.0f} ms, p95 {p95 * 1000:.0f} ms, "
        f"max {times[-1] * 1000:.0f} ms"
    )


# ── nothing real on the Mac, in any stage ──


@pytest.fixture(autouse=True)
def _no_real_mac(monkeypatch):
    """No AppleScript, no EventKit: the calendar tool and anything else that would reach the
    Mac's own apps gets an empty calendar or a refusal instead."""
    from jarvis import calendar_kit, mac_tools

    async def no_script(*_a, **_k):
        raise mac_tools.ToolFailure("no AppleScript in the stress run")

    async def no_events(*_a, **_k):
        return []

    async def no_calendar(*_a, **_k):
        return {"error": "no calendar in the stress run"}

    monkeypatch.setattr(mac_tools, "run_applescript", no_script)
    monkeypatch.setattr(mac_tools, "fetch_events", no_events)
    monkeypatch.setattr(calendar_kit, "fetch", no_calendar)


# ── the companion over HTTPS ──


@pytest.fixture
def companion_hub(settings, quiet_speaker, isolated, monkeypatch, tmp_path):
    from test_companion_api import fake_the_mac
    from test_hub import make_hub

    from jarvis import companion_wake

    monkeypatch.setattr(companion_wake, "install", lambda *a, **k: False)  # no LaunchAgent
    monkeypatch.delenv("JARVIS_APP_BUNDLE", raising=False)
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    fake_the_mac(hub, monkeypatch, tmp_path)
    hub.remote.host, hub.remote.port, hub.remote.advertiser = "127.0.0.1", 0, None
    hub.remote.extension.inbox_folder = tmp_path / "Inbox"
    return hub


async def _flood(port: int, token: str, at_once: int, total: int) -> tuple[dict, list[float]]:
    codes: dict[str, int] = {}
    times: list[float] = []
    limits = httpx.Limits(max_connections=at_once, max_keepalive_connections=at_once)
    async with httpx.AsyncClient(
        base_url=f"https://127.0.0.1:{port}", verify=False, limits=limits, timeout=30
    ) as client:
        gate = asyncio.Semaphore(at_once)

        async def one() -> None:
            async with gate:
                started = time.perf_counter()
                try:
                    reply = await client.get(
                        "/api/state", headers={"Authorization": f"Bearer {token}"}
                    )
                    key = str(reply.status_code)
                except httpx.HTTPError as exc:
                    key = type(exc).__name__
                times.append(time.perf_counter() - started)
                codes[key] = codes.get(key, 0) + 1

        await asyncio.gather(*(one() for _ in range(total)))
    return codes, times


@pytest.mark.companion
async def test_companion(companion_hub, monkeypatch):
    from jarvis import remote

    hub = companion_hub
    server = hub.remote
    assert await server.start(), server.error
    token = server.devices.pair(server.devices.start_pairing(), "iPhone")
    port = server.port
    print(f"\ncompanion on 127.0.0.1:{port} (https)")
    try:
        for raised in (False, True):
            if raised:  # the server's own capacity, past the per-phone budget
                monkeypatch.setitem(remote.RATES, "read", (10**6, 10**6))
            for at_once in (2, 8, 16, 64):
                before = vitals()
                with Lag() as lag:
                    codes, times = await _flood(port, token, at_once, at_once * 25)
                label = f"/api/state x{at_once * 25}, {at_once} at once" + (
                    " (budget raised)" if raised else ""
                )
                show(label, before, f"{codes} {spread(times)}; {lag.said()}")
        # Wrong tokens: each answered 401, none slower than the rest.
        before = vitals()
        async with httpx.AsyncClient(
            base_url=f"https://127.0.0.1:{port}", verify=False, timeout=30
        ) as client:
            times, codes = [], {}
            with Lag() as lag:
                for i in range(500):
                    started = time.perf_counter()
                    reply = await client.get(
                        "/api/state", headers={"Authorization": f"Bearer wrong-{i}-" + "x" * 150}
                    )
                    times.append(time.perf_counter() - started)
                    codes[reply.status_code] = codes.get(reply.status_code, 0) + 1
            show("500 wrong tokens", before, f"{codes} {spread(times)}; {lag.said()}")
            # Bodies past every cap, with and without a token.
            for path, size, auth in (
                ("/api/ask", 1_000_000, True),
                ("/api/share", 40_000_000, True),
                ("/api/share", 40_000_000, False),
                ("/api/code/send", 70_000_000, True),
            ):
                headers = {"Authorization": f"Bearer {token}"} if auth else {}
                body = b'{"text": "' + b"x" * size + b'"}'
                before = vitals()
                started = time.perf_counter()
                try:
                    reply = await client.post(path, content=body, headers=headers)
                    said = str(reply.status_code)
                except httpx.HTTPError as exc:
                    said = type(exc).__name__
                took = time.perf_counter() - started
                show(f"POST {path} {size / 1e6:.0f} MB auth={auth}", before, f"{said} {took:.2f}s")
        # A body that trickles: dropped at the request's deadline (shortened here).
        monkeypatch.setattr(remote, "REQUEST_SECONDS", 1.0)
        reader, writer = await asyncio.open_connection(
            "127.0.0.1", port, ssl=__import__("ssl")._create_unverified_context()
        )
        writer.write(
            b"POST /api/ask HTTP/1.1\r\nHost: mac\r\nContent-Type: application/json\r\n"
            + f"Authorization: Bearer {token}\r\nContent-Length: 5000\r\n\r\n".encode()
            + b'{"text": "'
        )
        await writer.drain()
        started = time.perf_counter()
        got = await asyncio.wait_for(reader.read(), 30)
        print(f"  trickled body: closed after {time.perf_counter() - started:.1f}s ({got[:12]!r})")
        writer.close()
    finally:
        await server.stop()
    # Pairing guesses from a thousand addresses (straight to the app: loopback is one).
    app = remote.create_remote_app(hub, server.devices, extension=server.extension)
    code = server.devices.start_pairing()
    wrong = f"{(int(code) + 1) % 1_000_000:06d}"
    before = vitals()
    refused = {}
    for i in range(1000):
        transport = httpx.ASGITransport(
            app=app, client=(f"10.{i // 65536}.{i // 256 % 256}.{i % 256}", 1)
        )
        async with httpx.AsyncClient(transport=transport, base_url="http://mac") as client:
            reply = await client.post("/api/pair", json={"code": wrong, "device_name": "x"})
            refused[reply.status_code] = refused.get(reply.status_code, 0) + 1
    spent = server.devices.code is None
    show(
        "1000 wrong pairing codes from 1000 addresses",
        before,
        f"{refused}; code spent: {spent}; addresses kept: {len(server.devices.failures)}",
    )


# ── the chat channels ──


@pytest.mark.channels
async def test_channels(settings, quiet_speaker, isolated):
    from channels_fakes import attach, make_hub, said, settle

    from jarvis.channels import base

    hub = make_hub(settings, quiet_speaker, isolated)
    router, chat = attach(hub)
    print()
    for code_up in (False, True):
        for strangers in (1_000, 20_000):
            if code_up:
                router.codes["telegram"].start()
            before = vitals()
            started = time.perf_counter()
            with Lag() as lag:
                for i in range(strangers):
                    text = f"/pair {i % 1_000_000:06d}" if i % 2 else f"open the door {i}"
                    await router.receive(said(text, chat=f"c{i}", sender=f"s{code_up}{i}"))
                    if i % 200 == 0:
                        await asyncio.sleep(0)
            show(
                f"{strangers} strangers, a code up: {code_up}",
                before,
                f"{time.perf_counter() - started:.2f}s, replies {len(chat.sent)}, "
                f"kept: refused {len(router.refused)}, pair replies {len(router.pair_replies)}; "
                f"{lag.said()}",
            )
    await hub.start()
    before = vitals()
    with Lag() as lag:
        for i in range(2_000):
            await router.receive(said(f"what's on tomorrow {i}?"))
        await settle(router, rounds=3000)
    show("the owner: 2,000 messages in one chat", before, f"replies {len(chat.sent)}; {lag.said()}")
    # One message of each kind and size, from a stranger, timed (the pairing pattern runs
    # on a stranger's text before anything else is decided).
    for size in (1_000, 4_096, 8_000, 16_000):
        for name, text in (
            ("pair + line breaks", "pair" + "\n" * size + "x"),
            ("pair + spaces", "pair" + " " * size + "x"),
            ("plain words", "word " * (size // 5)),
            ("Chinese", "中" * size),
        ):
            started = time.perf_counter()
            base.pair_code(text)
            took = time.perf_counter() - started
            if took > 0.01:
                print(f"  pair_code: {name}, {size} chars: {took:.3f}s")
    from jarvis.channels.slack import unescape

    for size in (4_000, 10_000, 20_000, 40_000):
        for name, text in (
            ("<@ unclosed", "<@" * (size // 2)),
            ("<http: unclosed", "<http:a" * (size // 7)),
            ("mentions", "<@U123|ann> " * (size // 12)),
        ):
            started = time.perf_counter()
            unescape(text)
            took = time.perf_counter() - started
            if took > 0.01:
                print(f"  slack unescape: {name}, {size} chars: {took:.3f}s")


# ── Jarvis for other apps: the endpoint on a Unix socket ──


@pytest.mark.mcp
async def test_mcp(settings, quiet_speaker, isolated):
    from conftest import FakeClient

    from jarvis import mcp_endpoint
    from jarvis.hub import Hub
    from jarvis.mcp_endpoint import Endpoint

    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub.set_feature_prefs({"mcp_ask": False})
    hub.memory.add("Ann Lee is the owner's co-founder.")
    folder = Path(tempfile.mkdtemp(prefix="r2mcp", dir="/tmp"))  # a socket's path is short
    endpoint = Endpoint(hub, folder / "mcp")
    await endpoint.start()
    print()
    try:
        assert endpoint.running, endpoint.error
        sock = str(endpoint.socket_path)

        def client() -> httpx.AsyncClient:
            return httpx.AsyncClient(
                transport=httpx.AsyncHTTPTransport(uds=sock), base_url="http://jarvis", timeout=30
            )

        headers = {
            "Authorization": f"Bearer {endpoint.token}",
            "X-Jarvis-Session": "s" * 16,
            "X-Jarvis-Client": "claude-code",
        }
        for at_once in (2, 16, 64):
            endpoint._calls.clear()
            codes: dict[int, int] = {}
            times: list[float] = []
            before = vitals()
            with Lag() as lag:

                async def caller(codes=codes, times=times) -> None:
                    async with client() as c:
                        for _ in range(5):
                            started = time.perf_counter()
                            reply = await c.post(
                                "/call", json={"tool": "recall", "arguments": {}}, headers=headers
                            )
                            times.append(time.perf_counter() - started)
                            codes[reply.status_code] = codes.get(reply.status_code, 0) + 1

                await asyncio.gather(*(caller() for _ in range(at_once)))
            show(f"{at_once} clients x 5 calls", before, f"{codes} {spread(times)}; {lag.said()}")
        endpoint._calls.clear()
        before = vitals()
        odd: dict[int, int] = {}
        async with client() as c:
            for body in (
                b"not json",
                b"[1,2,3]",
                b'"a string"',
                b'{"tool": ["recall"]}',
                b'{"tool": "recall", "arguments": [1]}',
                json.dumps({"tool": "calendar", "arguments": {"days": 1e308}}).encode(),
                b'{"tool": "calendar", "arguments": {"days": Infinity}}',
                b"{" * 50_000,
                b'{"tool": "recall", "x": "' + b"y" * (mcp_endpoint.MAX_BODY + 10) + b'"}',
            ):
                reply = await c.post(
                    "/call", content=body, headers={**headers, "Content-Type": "application/json"}
                )
                odd[reply.status_code] = odd.get(reply.status_code, 0) + 1
        show("malformed calls", before, f"{odd}")
        # New sessions while the owner is asked about each one.
        hub.set_feature_prefs({"mcp_ask": True})
        endpoint._calls.clear()
        async with client() as c:
            asks = [
                asyncio.create_task(
                    c.post(
                        "/call",
                        json={"tool": "recall"},
                        headers={**headers, "X-Jarvis-Session": f"session{i:08d}"},
                    )
                )
                for i in range(30)
            ]
            await asyncio.sleep(1.0)
            print(f"  30 new sessions of one app: {len(hub.approvals)} cards up at once")
            for card in list(hub.approvals.values()):
                hub.resolve(card["id"], "deny")
            await asyncio.gather(*asks, return_exceptions=True)
    finally:
        await endpoint.stop()
        shutil.rmtree(folder, ignore_errors=True)


# ── the encrypted relay (a fake askeden.com and a fake companion on 127.0.0.1) ──


@pytest.mark.relay
async def test_relay():
    from test_relay import Echo, FakeRelay, account, until
    from websockets.asyncio.server import serve

    from jarvis.relay import MAX_STREAMS, Relay

    fake = FakeRelay()
    server = await serve(fake.handler, "127.0.0.1", 0)
    fake.base = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
    echo = Echo()
    companion = await asyncio.start_server(echo.handle, "127.0.0.1", 0)
    echo.port = companion.sockets[0].getsockname()[1]
    relay = Relay(account(), lambda: echo.port, base=fake.base)
    task = asyncio.create_task(relay.run())
    print()
    try:
        await asyncio.wait_for(fake.listening.wait(), 5)
        before = vitals()
        with Lag() as lag:
            for i in range(100):
                await fake.listen.send(json.dumps({"type": "open", "stream": f"s{i}"}))
            await asyncio.sleep(1.0)
        phones = []
        while not fake.accepted.empty():
            phones.append(fake.accepted.get_nowait())
        show(
            "100 streams opened at once",
            before,
            f"accepted {len(phones)} (cap {MAX_STREAMS}), companion connections "
            f"{echo.connections}; {lag.said()}",
        )
        for phone in phones:
            await phone.close()
        await until(lambda: not [t for t in relay.streams if not t.done()], 10)
        await fake.listen.send(json.dumps({"type": "open", "stream": "again"}))
        phone = await asyncio.wait_for(fake.accepted.get(), 5)
        payload = os.urandom(50_000)  # askeden.com's frames are 64 KB at most
        before = vitals()
        started = time.perf_counter()
        with Lag() as lag:

            async def read_back(total: int) -> None:
                got = 0
                while got < total:
                    got += len(await asyncio.wait_for(phone.recv(), 10))

            reading = asyncio.create_task(read_back(400 * len(payload)))
            for _ in range(400):
                await phone.send(payload)
            await reading
        took = time.perf_counter() - started
        show(
            "20 MB through one stream and back",
            before,
            f"{took:.2f}s ({40 / took:.0f} MB/s both ways); {lag.said()}",
        )
        await phone.close()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        companion.close()
        server.close()


# ── the MCP bridge ──


@pytest.mark.bridge
async def test_bridge(tmp_path):
    from jarvis.mcp_bridge import Bridge

    folder = tmp_path / "mcp"
    folder.mkdir()
    (folder / "token").write_text("t")

    def answer(_request):
        return httpx.Response(200, json={"text": "ok", "is_error": False})

    print()
    for size in (1_000, 1_000_000, 4_000_000, 8_000_000):
        bridge = Bridge(folder, transport=httpx.MockTransport(answer))
        reader = asyncio.StreamReader(limit=4 * 1024 * 1024)
        reader.feed_data(b'{"jsonrpc":"2.0","id":1,"method":"ping","x":"' + b"a" * size + b'"}\n')
        reader.feed_data(b'{"jsonrpc":"2.0","id":2,"method":"ping"}\n')
        reader.feed_eof()
        out: list = []

        async def write(message, out=out):
            out.append(message)

        try:
            await asyncio.wait_for(bridge.serve(reader, write), 10)
            print(f"  a {size}-byte line: answered {[m.get('id') for m in out]}")
        except Exception as exc:
            print(f"  a {size}-byte line: the bridge died ({type(exc).__name__})")
    for ident in (1, "a", None, 1.5, True, [1], {"a": 1}):
        bridge = Bridge(folder, transport=httpx.MockTransport(answer))
        reader = asyncio.StreamReader()
        call = {"jsonrpc": "2.0", "id": ident, "method": "tools/call", "params": {"name": "recall"}}
        reader.feed_data(json.dumps(call).encode() + b"\n")
        reader.feed_data(b'{"jsonrpc":"2.0","id":99,"method":"ping"}\n')
        reader.feed_eof()
        out = []

        async def write(message, out=out):
            out.append(message)

        try:
            await asyncio.wait_for(bridge.serve(reader, write), 10)
            print(f"  tools/call id {ident!r}: answered {[m.get('id') for m in out]}")
        except Exception as exc:
            print(f"  tools/call id {ident!r}: the bridge died ({type(exc).__name__})")


def main() -> int:
    stages = sys.argv[1:] or ["companion", "channels", "mcp", "relay", "bridge"]
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT / "tests"))
    return pytest.main(
        [
            __file__,
            "-p",
            "conftest",
            "-p",
            "no:cacheprovider",
            "-o",
            "asyncio_mode=auto",
            "-W",
            "ignore::pytest.PytestUnknownMarkWarning",
            "-s",
            "-q",
            "--rootdir",
            str(ROOT),
            "-m",
            " or ".join(stages),
        ]
    )


if __name__ == "__main__":
    raise SystemExit(main())
