"""Eden on the web's link (jarvis.eden_link): askeden.com's frames turned into requests to
Eden's server on this Mac and its answers streamed back; the route allowlist, the asking
browser checked against the account's devices, the body cap and checks, Stop, the window,
the backoff and a sign-out. A fake WebSocket stands in for askeden.com and an
httpx.MockTransport for Eden's server: never the network."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest
from account_fakes import TOKEN

from jarvis import eden_link as link_mod
from jarvis.eden_link import (
    ALLOWED,
    LOCAL,
    MAX_BODY,
    MAX_FRAME,
    MAX_STREAMS,
    WINDOW,
    EdenLink,
    frame,
    local_url,
    route_of,
    unframe,
)

BROWSER = "b0b0b0b0b0b0b0b0"
OTHER = "c1c1c1c1c1c1c1c1"
SID = "0123456789abcdef"


class FakeAccount:
    """What EdenLink needs of jarvis.account.Account: the token, the device list."""

    def __init__(self, devices=None):
        self.token = TOKEN
        self.linked = True
        self.devices = devices if devices is not None else [{"id": BROWSER, "kind": "web"}]
        self.asked = []
        self.forgotten = False
        self.kept = None

    async def status(self, fresh=False):
        """GET /account, kept until asked for fresh (as Account.status keeps it a minute)."""
        self.asked.append(fresh)
        if fresh or self.kept is None:
            self.kept = {"id": "acct", "devices": list(self.devices)}
        return self.kept

    async def forget(self):
        self.forgotten = True
        self.linked = False


class FakeWS:
    """askeden.com's end of the web channel: frames it sends go in `incoming`, what the Mac
    sends lands in `sent`."""

    def __init__(self):
        self.incoming = asyncio.Queue()
        self.sent = []
        self.got = asyncio.Event()

    async def send(self, message):
        self.sent.append(message)
        self.got.set()

    def __aiter__(self):
        return self

    async def __anext__(self):
        message = await self.incoming.get()
        if message is None:
            raise StopAsyncIteration
        return message

    def push(self, message):
        self.incoming.put_nowait(json.dumps(message) if isinstance(message, dict) else message)

    def texts(self):
        return [json.loads(m) for m in self.sent if isinstance(m, str)]

    def body(self, sid=SID):
        return b"".join(
            unframe(m)[1] for m in self.sent if isinstance(m, bytes) and unframe(m)[0] == sid
        )

    async def until(self, test, seconds=2.0):
        async def wait():
            while not test():
                self.got.clear()
                await self.got.wait()

        await asyncio.wait_for(wait(), seconds)


class Eden:
    """Eden's server on this Mac: answers what each test says, and remembers what it was asked."""

    def __init__(self, answer=None):
        self.requests = []
        self.answer = answer or (lambda request: httpx.Response(200, json={"ok": True}))

    def __call__(self, request):
        self.requests.append(request)
        return self.answer(request)


def make(eden=None, account=None, **kw):
    eden = eden or Eden()
    account = account or FakeAccount()
    link = EdenLink(
        account, base="wss://askeden.test/api/relay", transport=httpx.MockTransport(eden), **kw
    )
    return link, eden, account


async def started(link):
    ws = FakeWS()
    task = asyncio.get_running_loop().create_task(link.serve(ws))
    return ws, task


def request(ws, method, path, body=None, sid=SID, browser=BROWSER, headers=None, owner=None):
    data = json.dumps(body).encode() if body is not None else b""
    ws.push(
        {
            "t": "req",
            "id": sid,
            "method": method,
            "path": path,
            "headers": headers
            or ({"content-type": "application/json"} if body is not None else {}),
            "from": browser,
            "size": len(data),
            **({"owner": owner} if owner is not None else {}),
        }
    )
    for at in range(0, len(data), MAX_FRAME):
        ws.push(frame(sid, data[at : at + MAX_FRAME]))
    ws.push({"t": "end", "id": sid})


def ended(ws, sid=SID):
    return any(t.get("id") == sid and t.get("t") in ("end", "error") for t in ws.texts())


async def stop(ws, task):
    ws.push(None)
    await asyncio.wait_for(task, 2)


# ── the pieces ──


def test_frames_and_routes():
    assert unframe(frame(SID, b"hi")) == (SID, b"hi")
    assert unframe(b"short") is None
    assert unframe(b"ZZZZZZZZZZZZZZZZdata") is None
    assert ALLOWED == {
        ("GET", "/api/chat/jarvis/status"),
        ("POST", "/api/chat/jarvis"),
        ("GET", "/api/chat/projects"),
        ("POST", "/api/chat/code"),
        ("POST", "/api/chat/code/steer"),
        ("GET", "/api/chat/code/changes"),
        ("POST", "/api/chat/brief"),
        ("POST", "/api/chat/meetings/actions"),
        ("GET", "/api/chat/actions"),
        ("POST", "/api/chat/actions/undo"),
        ("POST", "/api/chat/mac/send"),
        ("POST", "/api/chat/send"),  # private turns, or any from the owner (_check)
        ("GET", "/api/chat/local"),
        ("POST", "/api/route"),  # the owner only
        ("GET", "/api/chat/meta"),  # the owner only
    }
    assert route_of("GET", "/api/chat/code/changes?project=%2FUsers%2Fme%2Fapp") == (
        "GET",
        "/api/chat/code/changes",
    )
    for method, target in [
        ("POST", "/api/chat/keys"),
        ("GET", "/api/chat/keys"),
        ("POST", "/api/chat/projects"),
        ("GET", "/download"),
        ("GET", "/api/route"),
        ("POST", "/api/chat/meta"),
        ("POST", "/api/chat/compare"),
        ("POST", "/api/chat/jarvis/../keys"),
        ("POST", "//evil.example/api/chat/jarvis"),
        ("POST", "http://evil.example/api/chat/jarvis"),
        ("POST", "/api/chat/%6aarvis"),
        ("GET", "/api/chat/projects?x=1"),
        ("GET", "/api/chat/code/changes?project=a&project=b"),
        ("GET", "/api/chat/code/changes?other=1"),
        ("GET", "/api/chat/jarvis/status#x"),
        ("DELETE", "/api/chat/projects"),
    ]:
        assert route_of(method, target) is None, (method, target)


def test_local_url_only_loopback():
    assert local_url({}) == LOCAL
    assert local_url({"JARVIS_EDEN_LOCAL_URL": "http://127.0.0.1:5184/"}) == "http://127.0.0.1:5184"
    assert local_url({"JARVIS_EDEN_LOCAL_URL": "http://localhost:5184"}) == "http://localhost:5184"
    assert local_url({"JARVIS_EDEN_LOCAL_URL": "http://evil.example:5174"}) == LOCAL
    assert local_url({"JARVIS_EDEN_LOCAL_URL": "https://127.0.0.1:5174"}) == LOCAL
    assert local_url({"JARVIS_EDEN_LOCAL_URL": "http://127.0.0.1:5174/download"}) == LOCAL


# ── forwarding ──


async def test_a_request_goes_to_eden_with_its_header_and_the_answer_comes_back():
    link, eden, _ = make(
        eden=Eden(
            lambda r: httpx.Response(
                200, json={"text": "Lyon in May", "is_error": False}, headers={"set-cookie": "x=1"}
            )
        )
    )
    ws, task = await started(link)
    request(ws, "POST", "/api/chat/jarvis", {"tool": "recall", "arguments": {"query": "trip"}})
    await ws.until(lambda: ended(ws))
    asked = eden.requests[0]
    assert asked.method == "POST"
    assert str(asked.url) == f"{LOCAL}/api/chat/jarvis"
    assert asked.headers["x-jarvis-chat"] == "1"
    assert asked.headers["content-type"] == "application/json"
    assert (
        "authorization" not in asked.headers
        and "origin" not in asked.headers
        and "cookie" not in asked.headers
    )
    assert json.loads(asked.content) == {"tool": "recall", "arguments": {"query": "trip"}}
    head = ws.texts()[0]
    assert head == {
        "t": "res",
        "id": SID,
        "status": 200,
        "headers": {"content-type": "application/json"},
    }
    assert json.loads(ws.body()) == {"text": "Lyon in May", "is_error": False}
    assert ws.texts()[-1] == {"t": "end", "id": SID}
    assert link.streams == {} and link.served == 1
    await stop(ws, task)


async def test_a_query_reaches_eden_as_it_was():
    link, eden, _ = make()
    ws, task = await started(link)
    request(ws, "GET", "/api/chat/code/changes?project=%2FUsers%2Fme%2Fapp")
    await ws.until(lambda: ended(ws))
    assert eden.requests[0].url.path == "/api/chat/code/changes"
    assert eden.requests[0].url.params["project"] == "/Users/me/app"
    await stop(ws, task)


async def test_refused_routes_never_reach_eden():
    link, eden, _ = make()
    ws, task = await started(link)
    for i, (method, path) in enumerate(
        [("POST", "/api/chat/keys"), ("GET", "/download"), ("POST", "/api/chat/projects")]
    ):
        sid = f"{i:016x}"
        request(
            ws,
            method,
            path,
            {"provider": "openai", "key": "sk-x"} if method == "POST" else None,
            sid=sid,
        )
        await ws.until(lambda sid=sid: ended(ws, sid))
        refused = [t for t in ws.texts() if t["id"] == sid]
        assert refused == [
            {
                "t": "error",
                "id": sid,
                "status": 403,
                "error": "Eden on the web can’t ask your Mac for that.",
                "code": "not_allowed",
            }
        ]
    assert eden.requests == []
    await stop(ws, task)


async def test_only_this_accounts_browsers_may_ask():
    account = FakeAccount(devices=[{"id": BROWSER, "kind": "web"}, {"id": OTHER, "kind": "iphone"}])
    now = [100.0]
    link, eden, _ = make(account=account, clock=lambda: now[0])
    ws, task = await started(link)
    request(
        ws, "GET", "/api/chat/projects", browser=OTHER, sid="1" * 16
    )  # an iPhone's id: not a browser
    await ws.until(lambda: ended(ws, "1" * 16))
    assert ws.texts()[-1]["status"] == 403 and ws.texts()[-1]["code"] == "forbidden"
    assert account.asked == [False, True], "an unknown one: the list is asked again, once"
    request(ws, "GET", "/api/chat/projects", browser=OTHER, sid="2" * 16)
    await ws.until(lambda: ended(ws, "2" * 16))
    assert account.asked == [False, True, False], "not again for that one within FRESH_SECONDS"
    # A browser that signed in a moment ago: the list is asked again for it (once FRESH_GAP passed).
    account.devices.append({"id": "d" * 16, "kind": "web"})
    now[0] += 3
    request(ws, "GET", "/api/chat/projects", browser="d" * 16, sid="3" * 16)
    await ws.until(lambda: ended(ws, "3" * 16))
    assert [t for t in ws.texts() if t["id"] == "3" * 16][0]["t"] == "res"
    assert account.asked == [False, True, False, False, True]
    request(ws, "GET", "/api/chat/projects", browser="nonsense", sid="4" * 16)
    await ws.until(lambda: ended(ws, "4" * 16))
    assert ws.texts()[-1]["code"] == "forbidden"
    assert len(eden.requests) == 1
    await stop(ws, task)


async def test_body_checks_jarvis_tools_bypass_and_size():
    link, eden, _ = make()
    ws, task = await started(link)
    request(ws, "POST", "/api/chat/jarvis", {"tool": "shell", "arguments": {}}, sid="1" * 16)
    request(
        ws,
        "POST",
        "/api/chat/code",
        {"prompt": "go", "mode": "bypassPermissions", "project": "/x"},
        sid="2" * 16,
    )
    ws.push(
        {
            "t": "req",
            "id": "3" * 16,
            "method": "POST",
            "path": "/api/chat/jarvis",
            "headers": {},
            "from": BROWSER,
            "size": 4,
        }
    )
    ws.push(frame("3" * 16, b"[1]x"))
    ws.push({"t": "end", "id": "3" * 16})
    big = b"x" * (MAX_BODY + 1)
    ws.push(
        {
            "t": "req",
            "id": "4" * 16,
            "method": "POST",
            "path": "/api/chat/code",
            "headers": {},
            "from": BROWSER,
            "size": 10,
        }
    )
    for at in range(0, len(big), MAX_FRAME):
        ws.push(frame("4" * 16, big[at : at + MAX_FRAME]))
    ws.push({"t": "end", "id": "4" * 16})
    ws.push(
        {
            "t": "req",
            "id": "5" * 16,
            "method": "POST",
            "path": "/api/chat/code",
            "headers": {},
            "from": BROWSER,
            "size": MAX_BODY + 1,
        }
    )
    for sid in ("1" * 16, "2" * 16, "3" * 16, "4" * 16, "5" * 16):
        await ws.until(lambda sid=sid: ended(ws, sid))
    codes = {t["id"]: (t["status"], t["code"]) for t in ws.texts() if t["t"] == "error"}
    assert codes["1" * 16] == (403, "not_allowed")
    assert codes["2" * 16] == (403, "not_allowed")
    assert codes["3" * 16] == (400, "bad_request")
    assert codes["4" * 16] == (413, "too_big")
    assert codes["5" * 16] == (413, "too_big"), (
        "a declared size past the cap: refused before the body"
    )
    assert eden.requests == []
    await stop(ws, task)


async def test_memory_tools_and_the_brief_reach_eden_and_nothing_more():
    """Memory in Eden (listing; changes, which Jarvis still shows the owner on a card) and the
    brief's reads pass; a brief kind that isn't one of its reads doesn't."""
    link, eden, _ = make()
    ws, task = await started(link)
    asks = [
        ("/api/chat/jarvis", {"tool": "memory_list", "arguments": {"limit": 200}}),
        (
            "/api/chat/jarvis",
            {
                "tool": "memory_toggle",
                "arguments": {"id": "abc12345", "on": False, "confirm": True},
            },
        ),
        ("/api/chat/jarvis", {"tool": "commitments", "arguments": {}}),
        ("/api/chat/brief", {"kind": "brief", "day": "2026-10-06", "tzOffset": -60}),
        (
            "/api/chat/brief",
            {"kind": "prep", "event": {"title": "1:1", "start": "2026-10-06T13:00"}},
        ),
    ]
    for i, (path, body) in enumerate(asks):
        request(ws, "POST", path, body, sid=f"{i + 1:x}" * 16)
    request(ws, "POST", "/api/chat/brief", {"kind": "send"}, sid="9" * 16)
    for i in range(len(asks)):
        await ws.until(lambda i=i: ended(ws, f"{i + 1:x}" * 16))
    await ws.until(lambda: ended(ws, "9" * 16))
    assert [(r.url.path, json.loads(r.content)) for r in eden.requests] == asks
    codes = {t["id"]: (t["status"], t["code"]) for t in ws.texts() if t["t"] == "error"}
    assert codes == {"9" * 16: (400, "bad_request")}
    await stop(ws, task)


async def test_meetings_browser_tasks_and_undo_reach_eden_and_only_jarvis_undo():
    """H5–H7 from the web: meetings and their action items, browser tasks (started on the
    owner's card in Jarvis), the Activity timeline and Undo of what Jarvis did (its card
    again); an undo of one of Eden's own Google changes stays on the Mac."""
    link, eden, _ = make()
    ws, task = await started(link)
    asks = [
        ("POST", "/api/chat/jarvis", {"tool": "meetings_list", "arguments": {}}),
        (
            "POST",
            "/api/chat/jarvis",
            {"tool": "meeting_read", "arguments": {"id": "2026-10-06 1000 Standup"}},
        ),
        (
            "POST",
            "/api/chat/jarvis",
            {"tool": "commitment_add", "arguments": {"text": "Send the deck", "confirm": True}},
        ),
        (
            "POST",
            "/api/chat/jarvis",
            {"tool": "browser_task", "arguments": {"goal": "Find a table for two"}},
        ),
        (
            "POST",
            "/api/chat/jarvis",
            {"tool": "browser_task_status", "arguments": {"id": "bt-0123456789"}},
        ),
        (
            "POST",
            "/api/chat/jarvis",
            {"tool": "browser_task_stop", "arguments": {"id": "bt-0123456789"}},
        ),
        ("POST", "/api/chat/meetings/actions", {"id": "2026-10-06 1000 Standup"}),
        ("GET", "/api/chat/actions", None),
        ("POST", "/api/chat/actions/undo", {"id": "ea-0123456789ab", "confirm": True}),
    ]
    for i, (method, path, body) in enumerate(asks):
        request(ws, method, path, body, sid=f"{i + 1:x}" * 16)
    request(
        ws,
        "POST",
        "/api/chat/actions/undo",
        {"id": "g-0123456789ab", "confirm": True},
        sid="e" * 16,
    )
    for i in range(len(asks)):
        await ws.until(lambda i=i: ended(ws, f"{i + 1:x}" * 16))
    await ws.until(lambda: ended(ws, "e" * 16))
    sent = [
        (r.method, r.url.path, json.loads(r.content) if r.content else None) for r in eden.requests
    ]
    assert sent == asks
    codes = {t["id"]: (t["status"], t["code"]) for t in ws.texts() if t["t"] == "error"}
    assert codes == {"e" * 16: (403, "not_allowed")}
    await stop(ws, task)


async def test_use_my_mac_reads_and_mac_turns_reach_eden_and_no_write_does():
    """G2/H4/H11 from the web: file search and reads, the screen (Jarvis's card on every look),
    project knowledge, and a chat turn that reads the Mac (mac/send); a tool that would write a
    file doesn't exist, so it's turned away here."""
    link, eden, _ = make()
    ws, task = await started(link)
    asks = [
        ("/api/chat/jarvis", {"tool": "files_search", "arguments": {"query": "lease"}}),
        ("/api/chat/jarvis", {"tool": "file_read", "arguments": {"path": "~/a.md", "page": 2}}),
        ("/api/chat/jarvis", {"tool": "file_summarize", "arguments": {"path": "~/a.md"}}),
        ("/api/chat/jarvis", {"tool": "screen_context", "arguments": {"picture": False}}),
        ("/api/chat/jarvis", {"tool": "knowledge_add_folder", "arguments": {"path": "~/T"}}),
        ("/api/chat/jarvis", {"tool": "knowledge_list", "arguments": {}}),
        ("/api/chat/jarvis", {"tool": "knowledge_search", "arguments": {"query": "rye"}}),
        (
            "/api/chat/mac/send",
            {"messages": [{"role": "user", "content": "Find my lease"}], "mac": {"files": True}},
        ),
    ]
    for i, (path, body) in enumerate(asks):
        request(ws, "POST", path, body, sid=f"{i + 1:x}" * 16)
    request(ws, "POST", "/api/chat/jarvis", {"tool": "file_write", "arguments": {}}, sid="e" * 16)
    for i in range(len(asks)):
        await ws.until(lambda i=i: ended(ws, f"{i + 1:x}" * 16))
    await ws.until(lambda: ended(ws, "e" * 16))
    assert [(r.url.path, json.loads(r.content)) for r in eden.requests] == asks
    codes = {t["id"]: (t["status"], t["code"]) for t in ws.texts() if t["t"] == "error"}
    assert codes == {"e" * 16: (403, "not_allowed")}
    await stop(ws, task)


async def test_only_private_turns_and_the_local_models_reach_eden():
    """Privacy mode from the web (G9): a private turn goes to Eden's send, where only a local
    model answers it; askeden.com answers every other turn itself, so the Mac refuses them."""
    link, eden, _ = make()
    ws, task = await started(link)
    turn = {"messages": [{"role": "user", "content": "My lab results"}], "privacy": True}
    request(ws, "POST", "/api/chat/send", turn, sid="1" * 16)
    request(ws, "GET", "/api/chat/local", sid="2" * 16)
    for sid, body in (("a" * 16, {**turn, "privacy": False}), ("b" * 16, {"messages": []})):
        request(ws, "POST", "/api/chat/send", body, sid=sid)
    request(ws, "POST", "/api/chat/send", {**turn, "privacy": "yes"}, sid="c" * 16)
    request(ws, "GET", "/api/chat/local?fresh=1", sid="d" * 16)
    for sid in ("1", "2", "a", "b", "c", "d"):
        await ws.until(lambda sid=sid: ended(ws, sid * 16))
    assert [(r.method, r.url.path) for r in eden.requests] == [
        ("POST", "/api/chat/send"),
        ("GET", "/api/chat/local"),
    ]
    assert json.loads(eden.requests[0].content) == turn
    codes = {t["id"][0]: (t["status"], t["code"]) for t in ws.texts() if t["t"] == "error"}
    assert codes == {**{k: (403, "owner_only") for k in "abc"}, "d": (403, "not_allowed")}
    await stop(ws, task)


async def test_the_owner_chats_through_this_mac_and_no_one_else():
    """Chat through the Mac (site/src/eden/via-mac.js): any turn, the routing preview and the
    model list, only when the relay marks the request as the account owner's; else refused
    before Eden is asked, and only for this account's own browsers either way."""
    link, eden, _ = make()
    ws, task = await started(link)
    turn = {"messages": [{"role": "user", "content": "Plan my week"}]}
    request(ws, "POST", "/api/chat/send", turn, sid="1" * 16, owner=True)
    request(ws, "POST", "/api/route", {"prompt": "Plan"}, sid="2" * 16, owner=True)
    request(ws, "GET", "/api/chat/meta", sid="3" * 16, owner=True)
    # Not marked (or marked anything but true): refused.
    request(ws, "POST", "/api/chat/send", turn, sid="a" * 16)
    request(ws, "POST", "/api/route", {"prompt": "Plan"}, sid="b" * 16, owner=False)
    request(ws, "GET", "/api/chat/meta", sid="c" * 16, owner="yes")
    # Marked, but not one of this account's browsers: refused.
    request(ws, "POST", "/api/chat/send", turn, sid="d" * 16, owner=True, browser="f" * 16)
    for sid in "123abcd":
        await ws.until(lambda sid=sid: ended(ws, sid * 16))
    assert [(r.method, r.url.path) for r in eden.requests] == [
        ("POST", "/api/chat/send"),
        ("POST", "/api/route"),
        ("GET", "/api/chat/meta"),
    ]
    assert json.loads(eden.requests[0].content) == turn
    assert all(r.headers.get("x-jarvis-chat") == "1" for r in eden.requests)
    codes = {t["id"][0]: (t["status"], t["code"]) for t in ws.texts() if t["t"] == "error"}
    assert codes == {
        "a": (403, "owner_only"),
        "b": (403, "owner_only"),
        "c": (403, "owner_only"),
        "d": (403, "forbidden"),
    }
    await stop(ws, task)


async def test_bypass_only_when_allowed_and_plain_modes_pass():
    link, eden, _ = make(bypass=lambda: True)
    ws, task = await started(link)
    request(
        ws, "POST", "/api/chat/code", {"prompt": "go", "mode": "bypassPermissions", "project": "/x"}
    )
    await ws.until(lambda: ended(ws))
    assert ws.texts()[0]["t"] == "res" and len(eden.requests) == 1
    await stop(ws, task)


# ── streaming, Stop, the window ──


class Drip(httpx.AsyncByteStream):
    """A server-sent-event answer that goes on until told (or cancelled)."""

    def __init__(self):
        self.chunks = asyncio.Queue()
        self.closed = asyncio.Event()

    async def __aiter__(self):
        try:
            while (chunk := await self.chunks.get()) is not None:
                yield chunk
        finally:
            self.closed.set()

    async def aclose(self):
        self.closed.set()


async def test_events_stream_as_they_come_and_stop_reaches_eden():
    drip = Drip()
    link, _, _ = make(
        eden=Eden(
            lambda r: httpx.Response(
                200, headers={"content-type": "text/event-stream"}, stream=drip
            )
        )
    )
    ws, task = await started(link)
    request(ws, "POST", "/api/chat/code", {"prompt": "fix it", "project": "/x"})
    await ws.until(lambda: any(t["t"] == "res" for t in ws.texts()))
    assert ws.texts()[0]["headers"] == {"content-type": "text/event-stream"}
    drip.chunks.put_nowait(b'event: text\ndata: {"text":"Look"}\n\n')
    await ws.until(lambda: ws.body() == b'event: text\ndata: {"text":"Look"}\n\n')
    drip.chunks.put_nowait(b'event: text\ndata: {"text":"ing"}\n\n')
    await ws.until(lambda: ws.body().endswith(b'"ing"}\n\n'))
    assert not ended(ws), "still going"
    ws.push({"t": "cancel", "id": SID, "why": "stopped"})
    await asyncio.wait_for(drip.closed.wait(), 2)
    await asyncio.sleep(0)
    assert link.streams == {}
    assert not ended(ws), "a stopped stream says nothing more"
    await stop(ws, task)


async def test_the_window_holds_the_mac_back_until_acks():
    big = b"y" * (WINDOW + 3 * MAX_FRAME)
    link, _, _ = make(
        eden=Eden(
            lambda r: httpx.Response(
                200, headers={"content-type": "text/event-stream"}, content=big
            )
        )
    )
    ws, task = await started(link)
    request(ws, "POST", "/api/chat/code", {"prompt": "go"})
    await ws.until(lambda: len(ws.body()) >= WINDOW)
    await asyncio.sleep(0.05)
    assert len(ws.body()) == WINDOW, "no more than the window before an ack"
    assert all(len(m) <= MAX_FRAME + 16 for m in ws.sent if isinstance(m, bytes))
    ws.push({"t": "ack", "id": SID, "n": WINDOW})
    await ws.until(lambda: ended(ws))
    assert ws.body() == big
    await stop(ws, task)


async def test_eden_not_running_and_many_at_once():
    def answer(r):
        if r.url.path == "/api/chat/jarvis/status":
            raise httpx.ConnectError("refused", request=r)
        return httpx.Response(200, json={"n": json.loads(r.content)["text"]})

    link, eden, _ = make(eden=Eden(answer))
    ws, task = await started(link)
    request(ws, "GET", "/api/chat/jarvis/status", sid="f" * 16)
    for i in range(MAX_STREAMS - 1):
        request(
            ws,
            "POST",
            "/api/chat/code/steer",
            {"turnId": "a" * 24, "text": f"n{i}"},
            sid=f"{i:016x}",
        )
    await ws.until(
        lambda: all(ended(ws, f"{i:016x}") for i in range(MAX_STREAMS - 1)) and ended(ws, "f" * 16)
    )
    off = [t for t in ws.texts() if t["id"] == "f" * 16][0]
    assert off["t"] == "error" and off["status"] == 502 and off["code"] == "eden_off"
    assert sorted(json.loads(ws.body(f"{i:016x}"))["n"] for i in range(MAX_STREAMS - 1)) == sorted(
        f"n{i}" for i in range(MAX_STREAMS - 1)
    )
    await stop(ws, task)


async def test_too_many_at_once_is_turned_away():
    drip = Drip()
    link, _, _ = make(eden=Eden(lambda r: httpx.Response(200, stream=drip)))
    ws, task = await started(link)
    for i in range(MAX_STREAMS):
        request(ws, "GET", "/api/chat/projects", sid=f"{i:016x}")
    await ws.until(lambda: sum(t["t"] == "res" for t in ws.texts()) == MAX_STREAMS)
    request(ws, "GET", "/api/chat/projects", sid="e" * 16)
    await ws.until(lambda: ended(ws, "e" * 16))
    assert ws.texts()[-1]["code"] == "slow_down"
    await stop(ws, task)  # the line closing ends them all
    assert link.streams == {}
    await asyncio.wait_for(drip.closed.wait(), 2)


# ── the line ──


async def test_backoff_and_sign_out(monkeypatch):
    from websockets.exceptions import InvalidStatus

    statuses = [503, 404, 401]
    slept = []
    opened = []

    def connect(url, **kw):
        opened.append((url, kw["additional_headers"]["Authorization"]))
        status = statuses.pop(0)
        raise InvalidStatus(SimpleNamespace(status_code=status, headers={}, body=b""))

    async def sleep(seconds):
        slept.append(seconds)

    account = FakeAccount()
    link = EdenLink(account, base="wss://askeden.test/api/relay", connect=connect, sleep=sleep)
    await asyncio.wait_for(link.run(), 2)
    assert opened[0] == ("wss://askeden.test/api/relay/web", f"Bearer {TOKEN}")
    assert slept == [1.0, link_mod.BACKOFF_MISSING], (
        "503: soon; 404 (no web relay there yet): rarely"
    )
    assert account.forgotten and link.state == "off"


async def test_settings_hears_the_line_change_and_why_it_failed():
    from websockets.exceptions import InvalidStatus

    outcomes = [OSError("down"), 503, 404, "open", 401]
    seen = []
    account = FakeAccount()

    class Line:
        async def __aenter__(self):
            ws = FakeWS()
            ws.push(None)  # askeden.com closes it at once
            return ws

        async def __aexit__(self, *exc):
            return False

    def connect(url, **kw):
        what = outcomes.pop(0)
        if isinstance(what, Exception):
            raise what
        if what == "open":
            return Line()
        raise InvalidStatus(SimpleNamespace(status_code=what, headers={}, body=b""))

    async def sleep(_seconds):
        seen.append(("slept", link.error))

    link = EdenLink(account, base="wss://askeden.test/api/relay", connect=connect, sleep=sleep)
    link.on_change.append(lambda: seen.append((link.state, link.error)))
    await asyncio.wait_for(link.run(), 2)
    waits = [error for state, error in seen if state == "waiting"]
    assert waits == [
        "Couldn’t reach askeden.com.",
        "askeden.com answered 503.",
        "askeden.com doesn’t take this Mac’s link yet.",
        "askeden.com closed the line.",
    ]
    assert ("open", "") in seen, "an open line clears the last error"
    assert seen[-1] == ("off", "This Mac was signed out of the account.")
    assert link.public() == {"state": "off", "error": "This Mac was signed out of the account."}
    assert TOKEN not in json.dumps(seen)


async def test_the_line_serves_while_open_and_reconnects():
    sockets = []

    class Line:
        def __init__(self):
            self.ws = FakeWS()
            sockets.append(self.ws)

        async def __aenter__(self):
            return self.ws

        async def __aexit__(self, *exc):
            return False

    slept = []
    account = FakeAccount()

    async def sleep(seconds):
        slept.append(seconds)
        if len(slept) == 2:
            account.linked = False

    eden = Eden()
    link = EdenLink(
        account,
        base="wss://askeden.test/api/relay",
        transport=httpx.MockTransport(eden),
        connect=lambda url, **kw: Line(),
        sleep=sleep,
    )
    task = asyncio.get_running_loop().create_task(link.run())
    await asyncio.sleep(0)
    ws = sockets[0]
    request(ws, "GET", "/api/chat/jarvis/status")
    await ws.until(lambda: ended(ws))
    assert link.state == "open"
    ws.push(None)  # askeden.com closed it
    await asyncio.sleep(0.01)
    sockets[-1].push(None)
    await asyncio.wait_for(task, 2)
    assert len(sockets) == 2 and slept == [1.0, 2.0]
    assert link.state == "off"


@pytest.fixture(autouse=True)
def _no_env(monkeypatch):
    monkeypatch.delenv("JARVIS_EDEN_LOCAL_URL", raising=False)
