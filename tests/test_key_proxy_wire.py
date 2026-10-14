"""The key proxy (key_proxy.py) on the wire and over a long run: a chunked body refused at
the limit rather than read whole, a half-sent request cut off at its deadline, odd bytes or
a %23/%3F in the path answered 400 (never a 500, never a changed path upstream), a run's own
credential headers never sent on, the proxy's address only while it runs and its socket let
go, and no pass made for a model's name, nor kept from a session's last connect. Upstream is
an httpx MockTransport; nothing leaves the Mac. (The break round's reproductions, now
asserting the fixed behaviour, and the coverage gaps: 404 off the API, 413, 502.)"""

import socket
import threading
import time

import httpx
import pytest
import uvicorn
from starlette.testclient import TestClient

from jarvis import key_proxy
from jarvis.hook_listener import guarded_protocol
from jarvis.key_proxy import DIRECT, Grants, build_app

KEY = "sk-ant-api03-REALKEY-" + "x" * 40
BASE = "https://api.anthropic.com"


def setup(answer=None):
    seen = []

    def default(request):
        seen.append(request)
        return httpx.Response(200, stream=httpx.ByteStream(b'{"ok": true}'))

    grants = Grants()
    token = grants.mint(DIRECT, lambda: (BASE, KEY))
    app = build_app(grants, lambda: httpx.AsyncClient(transport=httpx.MockTransport(answer or default)))
    return token, seen, TestClient(app, client=("127.0.0.1", 5000), raise_server_exceptions=False)


@pytest.fixture
def served(monkeypatch):
    """The proxy behind real uvicorn as KeyProxy runs it, with a short deadline."""
    monkeypatch.setattr(key_proxy, "REQUEST_SECONDS", 1.0)
    grants = Grants()
    token = grants.mint(DIRECT, lambda: (BASE, KEY))
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    app = build_app(grants, lambda: httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(200, stream=httpx.ByteStream(b"ok")))))  # fmt: skip
    config = uvicorn.Config(app, log_level="warning", lifespan="off", access_log=False,
                            http=guarded_protocol(lambda: 256, lambda: key_proxy.REQUEST_SECONDS),
                            h11_max_incomplete_event_size=key_proxy.HEADER_BYTES)  # fmt: skip
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.01)
    yield sock.getsockname()[1], token
    server.should_exit = True
    thread.join(5)


def test_a_chunked_body_is_refused_at_the_limit_not_read_whole(served, monkeypatch):
    monkeypatch.setattr(key_proxy, "MAX_BODY", 4 << 20)
    port, token = served
    s = socket.create_connection(("127.0.0.1", port), timeout=30)
    s.sendall(b"POST /v1/messages HTTP/1.1\r\nHost: x\r\nx-api-key: " + token.encode()
              + b"\r\ntransfer-encoding: chunked\r\n\r\n")  # fmt: skip
    chunk = b"a" * (1 << 20)
    sent, got = 0, b""
    try:
        for _ in range(50):
            s.sendall(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
            sent += 1
        s.sendall(b"0\r\n\r\n")
    except OSError:
        pass
    try:
        got = s.recv(200)
    except OSError:
        pass
    s.close()
    assert got.startswith(b"HTTP/1.1 413") or sent < 50


def test_a_half_sent_request_is_cut_off(served):
    port, _token = served
    socks = []
    for _ in range(10):
        s = socket.create_connection(("127.0.0.1", port))
        s.sendall(b"POST /v1/messages HTTP/1.1\r\nHost: x\r\n")
        socks.append(s)
    time.sleep(2.0)
    still = 0
    for s in socks:
        s.setblocking(False)
        try:
            still += s.recv(1) != b""
        except BlockingIOError:
            still += 1
        except OSError:
            pass
        s.close()
    assert still == 0


def asgi_post(app, raw_path: bytes, token: str) -> tuple[int, bytes]:
    """One POST straight into the app, with the raw path as a client could send it (a test
    client refuses to send some of these itself)."""
    import asyncio
    from urllib.parse import unquote_to_bytes

    scope = {"type": "http", "http_version": "1.1", "method": "POST", "scheme": "http",
             "path": unquote_to_bytes(raw_path).decode("utf-8", "replace"), "raw_path": raw_path,
             "query_string": b"", "root_path": "", "client": ("127.0.0.1", 5000),
             "server": ("127.0.0.1", 80),
             "headers": [(b"host", b"x"), (b"x-api-key", token.encode()), (b"content-length", b"2")]}  # fmt: skip
    got = {"status": 0, "body": b""}
    sent = [False]

    async def receive():
        if sent[0]:
            await asyncio.sleep(3600)
        sent[0] = True
        return {"type": "http.request", "body": b"{}", "more_body": False}

    async def send(message):
        if message["type"] == "http.response.start":
            got["status"] = message["status"]
        elif message["type"] == "http.response.body":
            got["body"] += message.get("body", b"")

    asyncio.run(app(scope, receive, send))
    return got["status"], got["body"]


@pytest.mark.parametrize("path", [b"/v1/%00", b"/v1/%0a", b"/v1/x%7f", b"/v1/" + b"a" * 70000,
                                  b"/v1/x%23frag", b"/v1/x%3Fq=1"], ids=lambda p: p[:12].decode())  # fmt: skip
def test_odd_bytes_or_a_hidden_query_in_the_path_are_a_400(path):
    token, seen, client = setup()
    status, body = asgi_post(client.app, path, token)
    assert status == 400 and KEY.encode() not in body
    assert seen == []


def test_a_length_that_isnt_a_number_is_a_400():
    token, seen, client = setup()
    answer = client.post("/v1/messages", content=b"{}", headers={"x-api-key": token, "content-length": "abc"})
    assert answer.status_code in (400, 413) and seen == []


def test_a_runs_own_credential_headers_are_never_sent_on():
    token, seen, client = setup()
    client.post("/v1/messages", content=b"{}", headers={
        "authorization": f"Bearer {token}", "x-goog-api-key": token, "api-key": token,
        "x-forwarded-host": "evil.com", "forwarded": "host=evil.com", "proxy-authorization": token,
    })  # fmt: skip
    [sent] = seen
    assert token not in str(dict(sent.headers))
    assert sent.headers["authorization"] == f"Bearer {KEY}"
    assert not {"x-goog-api-key", "api-key", "x-forwarded-host", "forwarded"} & set(sent.headers)


def test_off_the_api_too_big_and_unreachable(monkeypatch):
    token, seen, client = setup()
    assert client.post("/v2/x", content=b"{}", headers={"x-api-key": token}).status_code == 404
    monkeypatch.setattr(key_proxy, "MAX_BODY", 10)
    big = client.post("/v1/messages", content=b"x" * 11, headers={"x-api-key": token})
    assert big.status_code == 413 and big.json()["error"]["type"] == "request_too_large"
    monkeypatch.setattr(key_proxy, "MAX_BODY", 64 << 20)

    def down(_request):
        raise httpx.ConnectError("no route")

    token, _seen, client = setup(down)
    gone = client.post("/v1/messages", content=b"{}", headers={"x-api-key": token})
    assert gone.status_code == 502 and "api.anthropic.com" in gone.text and KEY not in gone.text


def test_the_address_is_only_there_while_the_proxy_runs_and_a_dead_ones_socket_goes():
    proxy = key_proxy.KeyProxy(Grants())
    try:
        first = proxy.ensure()
        old_sock = proxy._sock
        proxy._server.should_exit = True  # (its thread ends on its own: a crash, say)
        proxy._thread.join(5)
        assert proxy.address == ""
        second = proxy.ensure()
        assert second and second != first or proxy._sock is not old_sock
        assert old_sock.fileno() == -1  # (let go)
        answer = httpx.post(f"{second}/v1/messages", content=b"{}", timeout=10, trust_env=False)
        assert answer.status_code == 401
    finally:
        proxy.close()


def test_a_pass_is_made_only_for_a_run_and_a_reconnect_revokes_the_last(tmp_path):
    from jarvis.connectors import MemoryVault
    from jarvis.providers import ProviderStore

    store = ProviderStore(tmp_path / "providers.json", MemoryVault())
    pid = store.add_provider("openrouter", "", "sk-or-v1-" + "0123456789abcdef" * 4, None)["id"]
    ref = store.add_model(pid, "some-model")["ref"]
    before = len(key_proxy.GRANTS._grants)
    named = store.session_config(ref, grant=False)
    assert named["model"] and named["settings"] is None
    assert len(key_proxy.GRANTS._grants) == before
    passes: dict = {}
    first = store.session_config(ref)["settings"]
    key_proxy.replace_pass(passes, 1, first)
    old = key_proxy.pass_in(first)
    assert key_proxy.GRANTS.alive(old)
    second = store.session_config(ref)["settings"]
    key_proxy.replace_pass(passes, 1, second)
    assert not key_proxy.GRANTS.alive(old) and key_proxy.GRANTS.alive(key_proxy.pass_in(second))
    assert passes == {1: key_proxy.pass_in(second)}
    key_proxy.replace_pass(passes, 1, None)  # (a built-in model now: nothing kept)
    assert passes == {}


def test_pass_in_finds_only_a_pass():
    token = Grants().mint(DIRECT, lambda: None)
    assert key_proxy.pass_in(f'{{"apiKeyHelper": "printf %s {token}"}}') == token
    assert key_proxy.pass_in(None) == "" and key_proxy.pass_in("eden-run-short") == ""
