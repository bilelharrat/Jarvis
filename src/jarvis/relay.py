"""The encrypted relay: the owner's iPhone reaches this Mac from anywhere, through their
Jarvis account (docs/accounts.md, "Encrypted relay"), with no shared Wi-Fi and no Tailscale.

While the Mac is linked, the relay is on in Settings (it is unless the owner turned it off)
and the phone companion is running, the Mac holds one WebSocket to askeden.com
(wss://askeden.com/api/relay/listen): its control line. When a phone wants in, askeden.com
says {"type": "open", "stream": id} on it, and the Mac opens a second WebSocket for that
stream (relay/accept?stream=id) and a TCP connection to its own companion server on
127.0.0.1, and copies bytes both ways until either side closes, then closes both.

What travels is the companion's own TLS, end to end from the phone (pinned to this Mac's
certificate) to the companion server: askeden.com sees only ciphertext, and the companion
still asks every request for its paired phone's token, exactly as on the Wi-Fi.

The control line is kept alive by WebSocket pings (the library's own); it reconnects after
1, 2, 4 … 60 seconds whenever it drops. A 401 means the Mac was signed out of the account:
the account forgets it and the relay stops. Nothing here is logged with a token.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote

log = logging.getLogger("jarvis")

WS_BASE = "wss://askeden.com/api/relay"
MAX_FRAME = 64 * 1024  # bytes in one WebSocket frame, each way (askeden.com's limit)
MAX_STREAMS = 16  # streams at once (askeden.com's limit per account)
BACKOFF_MOST = 60.0
STEADY_SECONDS = 30.0  # a control line up this long starts the backoff over
OPEN_SECONDS = 15.0  # to open a WebSocket
LOCAL_SECONDS = 5.0  # to reach the companion server on this Mac
_STREAM = re.compile(r"[A-Za-z0-9_.:-]{1,128}")

Connect = Callable[..., Any]  # websockets.asyncio.client.connect, or a test's own


def _connect() -> Connect:
    from websockets.asyncio.client import connect

    return connect


class Relay:
    """One control line to askeden.com and the streams it opens. port: the companion
    server's port now (None while it's off). base, connect, sleep: tests point it at a
    local fake relay."""

    def __init__(
        self,
        account: Any,
        port: Callable[[], int | None],
        *,
        base: str | None = None,
        host: str = "127.0.0.1",
        connect: Connect | None = None,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.account = account
        self.port = port
        self._base = base.rstrip("/") if base else None  # tests; else the account's server
        self.host = host
        self.connect = connect or _connect()
        self.sleep = sleep
        self.clock = clock
        self.state = "off"  # off | connecting | listening | waiting (to reconnect)
        self.streams: set[asyncio.Task] = set()
        self.opened = 0  # streams opened since it started, for Settings and tests

    @property
    def base(self) -> str:
        """The server's relays: the account's (askeden.com or its preview), unless a test says."""
        return self._base or getattr(self.account, "ws_base", WS_BASE)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.account.token}"}

    async def run(self) -> None:
        """The control line, until cancelled or signed out."""
        from websockets.exceptions import InvalidStatus, WebSocketException

        delay = 1.0
        try:
            while self.account.linked:
                began = self.clock()
                self.state = "connecting"
                try:
                    async with self.connect(
                        f"{self.base}/listen",
                        additional_headers=self._headers(),
                        compression=None,
                        open_timeout=OPEN_SECONDS,
                        max_size=MAX_FRAME,
                    ) as ws:
                        self.state = "listening"
                        log.info("relay: listening for the iPhone through the account")
                        async for message in ws:
                            if isinstance(message, str):
                                await self._heard(ws, message)
                    log.info("relay: the control line closed")
                except InvalidStatus as exc:
                    status = exc.response.status_code
                    if status == 401:
                        log.info("relay: signed out of the account; stopping")
                        await self.account.forget()
                        return
                    log.info("relay: askeden.com said %s", status)
                except (OSError, TimeoutError, WebSocketException) as exc:
                    log.info("relay: the control line dropped (%s)", type(exc).__name__)
                except Exception:  # anything else: said once, and tried again all the same
                    log.exception("relay: the control line failed")
                self.state = "waiting"
                if self.clock() - began >= STEADY_SECONDS:
                    delay = 1.0
                await self.sleep(delay)
                delay = min(BACKOFF_MOST, delay * 2)
        finally:
            self.state = "off"
            await self.close_streams()

    async def _heard(self, ws: Any, text: str) -> None:
        try:
            message = json.loads(text)
        except ValueError:
            return
        if not isinstance(message, dict):
            return
        kind = message.get("type")
        if kind == "ping":
            with contextlib.suppress(Exception):
                await ws.send(json.dumps({"type": "pong"}))
        elif kind == "open":
            stream = message.get("stream")
            if not isinstance(stream, str) or not _STREAM.fullmatch(stream):
                return
            self.streams = {t for t in self.streams if not t.done()}
            if len(self.streams) >= MAX_STREAMS:
                log.info("relay: too many streams at once; one turned away")
                return
            task = asyncio.get_running_loop().create_task(self._stream(stream))
            self.streams.add(task)
        # anything else (a type this build doesn't know) is left alone

    async def _stream(self, stream: str) -> None:
        """One phone connection: its relay WebSocket joined to the companion server."""
        from websockets.exceptions import WebSocketException

        port = self.port()
        if not port:
            return
        self.opened += 1
        try:
            async with self.connect(
                f"{self.base}/accept?stream={quote(stream, safe='')}",
                additional_headers=self._headers(),
                compression=None,
                open_timeout=OPEN_SECONDS,
                max_size=MAX_FRAME,
            ) as ws:
                try:
                    reader, writer = await asyncio.wait_for(
                        asyncio.open_connection(self.host, port), LOCAL_SECONDS
                    )
                except (OSError, TimeoutError):
                    log.info("relay: the companion server didn't answer a stream")
                    return
                try:
                    await pipe(ws, reader, writer)
                finally:
                    writer.close()
                    with contextlib.suppress(Exception):
                        await writer.wait_closed()
        except (OSError, TimeoutError, WebSocketException) as exc:
            log.info("relay: a stream couldn't open (%s)", type(exc).__name__)

    async def close_streams(self) -> None:
        streams, self.streams = list(self.streams), set()
        for task in streams:
            task.cancel()
        if streams:
            await asyncio.gather(*streams, return_exceptions=True)


async def pipe(ws: Any, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Bytes both ways until either side closes: the TCP connection's in binary frames of at
    most MAX_FRAME, and the WebSocket's binary frames onto the TCP connection (a text frame
    isn't the stream's: dropped)."""

    async def up() -> None:
        with contextlib.suppress(Exception):
            while chunk := await reader.read(MAX_FRAME):
                await ws.send(chunk)

    async def down() -> None:
        with contextlib.suppress(Exception):
            async for message in ws:
                if isinstance(message, bytes | bytearray):
                    writer.write(message)
                    await writer.drain()
            # the phone's side closed: so does the companion's (after what came is sent)
            with contextlib.suppress(Exception):
                await writer.drain()

    loop = asyncio.get_running_loop()
    tasks = [loop.create_task(up()), loop.create_task(down())]
    try:
        _done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        pending = set(tasks)
        raise
    finally:
        for task in pending:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        with contextlib.suppress(Exception):
            await ws.close()


class Keeper:
    """Starts and stops the relay as things change: it runs while wanted() is True (linked,
    the relay switch on, the companion server running). poke() looks again at once; it also
    looks every few seconds by itself."""

    def __init__(self, relay: Relay, wanted: Callable[[], bool], every: float = 3.0) -> None:
        self.relay = relay
        self.wanted = wanted
        self.every = every
        self._task: asyncio.Task | None = None
        self._poked = asyncio.Event()

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def poke(self) -> None:
        self._poked.set()

    async def loop(self) -> None:
        try:
            while True:
                await self.check()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._poked.wait(), self.every)
                self._poked.clear()
        finally:
            await self.stop()

    async def check(self) -> None:
        try:
            want = bool(self.wanted())
        except Exception:
            want = False
        done = self._task
        if done is not None and done.done():
            self._task = None
            if not done.cancelled() and done.exception() is not None:
                log.warning("relay: stopped (%r)", done.exception())
        if want and not self.running:
            self._task = asyncio.get_running_loop().create_task(self.relay.run())
        elif not want and self.running:
            await self.stop()

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(BaseException):
                await task
            log.info("relay: stopped")
