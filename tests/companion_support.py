"""For the companion's tests: talking to the companion server over TLS as the iPhone app
does, trusting its certificate only by the fingerprint it pinned (never a CA, never the
network: every server here listens on 127.0.0.1, on a port the system picks)."""

from __future__ import annotations

import asyncio
import hashlib
import ssl


class WrongCertificate(AssertionError):
    pass


def pinned_context() -> ssl.SSLContext:
    """A client context that checks nothing itself: the fingerprint is checked after the
    handshake, the way the app pins it."""
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


async def open_pinned(port: int, fingerprint: str, host: str = "127.0.0.1"):
    """A TLS connection to the server, refused unless it presents this very certificate."""
    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(host, port, ssl=pinned_context(), server_hostname="localhost"),
        5,
    )
    der = writer.get_extra_info("ssl_object").getpeercert(binary_form=True)
    if hashlib.sha256(der).hexdigest() != fingerprint:
        writer.close()
        raise WrongCertificate("the server presented another certificate")
    return reader, writer


async def exchange(port: int, fingerprint: str, raw: bytes, timeout: float = 5) -> bytes:
    """Send one raw HTTP request over pinned TLS; the whole reply (ask for Connection:
    close, or it waits for the timeout)."""
    reader, writer = await open_pinned(port, fingerprint)
    try:
        writer.write(raw)
        await writer.drain()
        return await asyncio.wait_for(reader.read(), timeout)
    finally:
        writer.close()


def get(path: str, token: str = "") -> bytes:
    auth = f"Authorization: Bearer {token}\r\n" if token else ""
    return f"GET {path} HTTP/1.1\r\nHost: mac\r\n{auth}Connection: close\r\n\r\n".encode()


def post(path: str, body: bytes, token: str = "") -> bytes:
    auth = f"Authorization: Bearer {token}\r\n" if token else ""
    return (
        f"POST {path} HTTP/1.1\r\nHost: mac\r\n{auth}Content-Type: application/json\r\n"
        f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
    ).encode() + body
