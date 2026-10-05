"""Stress round 2, the ways in from outside the window: strangers writing to the chat bots,
the iPhone companion's API under odd values and requests at once, the wake listener a slow
peer holds, Jarvis for other apps (the MCP bridge and endpoint) fed malformed JSON-RPC and
odd numbers, and the Gemini relay with its upstream failing. Fake transports only: no
network, no model, never the real calendar. scripts/stress_r2_reach.py is the heavier run.

Each test names the behavior that should hold; each failed when it was written."""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta

import httpx
import pytest
from channels_fakes import make_hub as make_channels_hub
from test_channels_slack import APP, BOT, WebAPI, dm
from test_channels_telegram import TOKEN, BotAPI, private
from test_companion_api import fake_the_mac, session
from test_hub import make_hub

from jarvis import remote
from jarvis.channels.store import Owner
from jarvis.mcp_bridge import Bridge

# ── strangers writing to the chat bots ──


@pytest.fixture
def telegram(settings, quiet_speaker, isolated):
    hub = make_channels_hub(settings, quiet_speaker, isolated)
    router = hub.chat_channels
    bot = router.adapters["telegram"]
    api = BotAPI()
    bot.transport = httpx.MockTransport(api)
    router.vault.set("channel-telegram", "token", TOKEN)
    bot.connected()
    hub.set_feature_prefs({"channels_telegram_on": True})
    router.state.owners["telegram"] = Owner("42", "42", "Ann")
    return hub, router, bot, api


@pytest.fixture
def slack(settings, quiet_speaker, isolated):
    hub = make_channels_hub(settings, quiet_speaker, isolated)
    router = hub.chat_channels
    adapter = router.adapters["slack"]
    api = WebAPI()
    adapter.transport = httpx.MockTransport(api)
    router.vault.set("channel-slack", "app_token", APP)
    router.vault.set("channel-slack", "bot_token", BOT)
    adapter.connected()
    router.state.bots["slack"] = {"id": "UJARVIS", "name": "@jarvis"}
    hub.set_feature_prefs({"channels_slack_on": True})
    router.state.owners["slack"] = Owner("UANN", "D1", "UANN", team="T1")
    return hub, router, adapter, api


async def test_a_strangers_long_pairing_message_never_stalls_the_app(telegram):
    """Anyone can write to the owner's bot. "pair" and a few thousand line breaks (inside
    Telegram's 4,096 characters) cost the pairing pattern quadratic backtracking on the
    event loop: half a second a message, before any rate limit, and seconds for Slack's
    40,000-character messages."""
    _hub, router, bot, api = telegram
    text = "pair" + "\n" * 4090 + "x"
    started = time.perf_counter()
    await bot.handle_updates([{"update_id": 1, "message": private(text, user=99)}])
    took = time.perf_counter() - started
    assert [b["chat_id"] for b in api.sent()] == ["99"]  # refused, once, as before
    assert took < 0.1, f"one stranger's message held the event loop {took:.2f}s"


async def test_a_slack_message_full_of_unclosed_marks_never_stalls_the_app(slack):
    """Slack's text is unescaped before anyone is checked to be the owner: "<@" over and
    over (never closed) makes the link and mention patterns scan to the end from every
    one of them, seconds of event loop for one message from anyone in the workspace."""
    _hub, _router, adapter, _api = slack
    payload = dm("<@" * 10_000, user="UBOB", channel="D2", event_id="Ev9")["payload"]
    started = time.perf_counter()
    msg = adapter._event(payload)
    took = time.perf_counter() - started
    assert msg is not None and msg.sender == "UBOB"
    assert took < 0.1, f"one message's text took {took:.2f}s to read"


# ── the iPhone companion's API ──


@pytest.fixture
async def phone(settings, quiet_speaker, isolated, monkeypatch, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    fake_the_mac(hub, monkeypatch, tmp_path)
    companion = hub.remote.extension
    app = remote.create_remote_app(hub, hub.remote.devices, extension=companion)
    token = hub.remote.devices.pair(hub.remote.devices.start_pairing(), "iPhone")
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(
        transport=transport,
        base_url="https://mac",
        headers={"Authorization": f"Bearer {token}"},
    ) as client:
        yield hub, client


async def test_each_phone_action_gets_its_own_answer_never_another_ones(phone, tmp_path):
    """Two actions at once (two phones, or the app's own retries): each waits for the
    hub's captions, and the first caption anyone emits answers both."""
    hub, client = phone
    session(hub, 1, tmp_path / "alpha")
    session(hub, 2, tmp_path / "beta")
    done = {1: asyncio.Event(), 2: asyncio.Event()}

    async def undo(task_id):
        await done[task_id].wait()
        return f"Undid session {task_id}'s last turn."

    hub.tasks.undo = undo
    first = asyncio.create_task(client.post("/api/code/action", json={"id": 1, "action": "undo"}))
    second = asyncio.create_task(client.post("/api/code/action", json={"id": 2, "action": "undo"}))
    await asyncio.sleep(0.2)  # both are waiting on their session
    done[2].set()
    await asyncio.sleep(0.2)
    done[1].set()
    one, two = await first, await second
    assert two.json()["said"] == "Undid session 2's last turn."
    assert one.json()["said"] == "Undid session 1's last turn."


async def test_two_new_sessions_from_the_phone_each_answer_their_own_id(
    phone, tmp_path, monkeypatch
):
    """/api/code/new answers with the newest session that appeared while it waited (three
    seconds, for an error that never comes on success): two started together both answer
    the second one's id, and the phone opens the wrong session for the first."""
    hub, client = phone
    ids = iter([7, 8])

    def start(prompt, directory, **_kw):
        return session(hub, next(ids), tmp_path / directory)

    monkeypatch.setattr(hub.tasks, "start", start)
    first = asyncio.create_task(
        client.post("/api/code/new", json={"prompt": "fix login", "directory": "alpha"})
    )
    second = asyncio.create_task(
        client.post("/api/code/new", json={"prompt": "add tests", "directory": "beta"})
    )
    one, two = await first, await second
    assert sorted([one.json().get("id"), two.json().get("id")]) == [7, 8]


async def test_a_calendar_with_mixed_or_far_out_times_is_refused_never_a_500(phone):
    """The phone's calendar is checked event by event; a start with a time zone and an
    end without (or a time at the edge of the calendar) raised from the comparison and the
    phone got a 500 with a traceback in the log."""
    _hub, client = phone
    assert (await client.post("/api/sensors", json={"calendar": True})).status_code == 200
    now = datetime.now().replace(microsecond=0)
    later = now + timedelta(hours=1)
    for start, end in (
        (now.isoformat() + "Z", later.isoformat()),
        ("0001-01-01T00:00:00+05:00", "0001-01-01T01:00:00+05:00"),
        ("9999-12-31T22:00:00-05:00", "9999-12-31T23:00:00-05:00"),
    ):
        reply = await client.post(
            "/api/calendar", json={"events": [{"title": "Lunch", "start": start, "end": end}]}
        )
        assert reply.status_code in (200, 400), (start, end, reply.status_code)


async def test_a_music_action_that_isnt_a_word_is_refused_never_a_500(phone):
    _hub, client = phone
    for action in ([], {}, ["play"]):
        reply = await client.post("/api/music", json={"action": action})
        assert reply.status_code == 400, (action, reply.status_code)


async def test_half_an_emoji_kept_on_the_mac_never_breaks_the_phones_answers(phone, tmp_path):
    """Half of a surrogate pair (a title cut in the middle of an emoji by the window, a
    client's malformed escape) is fine in the window's events (server.event_text replaces
    it) and in the stores (written escaped), but the companion's JSONResponse can't encode
    it: one in the last messages, a session's title or a project's name and /api/state,
    /api/code/sessions or /api/projects answered 500 for as long as it was kept (a
    project's name, saved escaped, comes back after every restart)."""
    hub, client = phone
    hub.history.append({"role": "user", "text": "Plan the trip \ud83c", "at": "2026-10-05T10:00"})
    session(hub, 3, tmp_path / "alpha", title="Fix the \ud83d bug")
    hub.chat_projects.save({"name": "Trip \ud83c"})  # as the window's command saves one
    for path in ("/api/state", "/api/code/sessions", "/api/projects"):
        reply = await client.get(path)
        assert reply.status_code == 200, (path, reply.status_code)


# ── Jarvis for other apps: the MCP bridge ──


async def _serve(bridge, lines, limit=2**16):
    reader = asyncio.StreamReader(limit=limit)
    for line in lines:
        reader.feed_data(line)
    reader.feed_eof()
    written = []

    async def write(message):
        written.append(message)

    await asyncio.wait_for(bridge.serve(reader, write), 5)
    return written


@pytest.fixture
def bridge(tmp_path):
    folder = tmp_path / "mcp"
    folder.mkdir()
    (folder / "token").write_text("t")
    release = asyncio.Event()

    async def answer(request):
        await release.wait()
        return httpx.Response(200, json={"text": "- a fact", "is_error": False})

    made = Bridge(folder, transport=httpx.MockTransport(answer))
    made.release = release
    return made


@pytest.mark.parametrize(
    "odd",
    [
        b'{"jsonrpc":"2.0","id":[1],"method":"tools/call","params":{"name":"recall"}}\n',
        b'{"jsonrpc":"2.0","id":{"a":1},"method":"tools/call","params":{"name":"recall"}}\n',
    ],
)
async def test_a_call_with_an_id_that_isnt_a_string_or_number_never_kills_the_bridge(bridge, odd):
    """JSON-RPC ids are strings or numbers, but nothing checks: a tools/call with a list
    or an object for its id raised TypeError out of serve() and the bridge process died."""
    bridge.release.set()
    ping = b'{"jsonrpc":"2.0","id":2,"method":"ping"}\n'
    written = await _serve(bridge, [odd, ping])
    assert any(m.get("id") == 2 and m.get("result") == {} for m in written)


async def test_a_ping_with_an_object_id_during_a_call_never_kills_the_bridge(bridge):
    """With a call in flight, answering a ping whose id is an object raised TypeError (the
    id can't be looked up among the calls) and the bridge died."""
    call = b'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall"}}\n'
    odd = b'{"jsonrpc":"2.0","id":{},"method":"ping"}\n'
    ping = b'{"jsonrpc":"2.0","id":3,"method":"ping"}\n'
    asyncio.get_running_loop().call_later(0.2, bridge.release.set)
    written = await _serve(bridge, [call, odd, ping])
    assert any(m.get("id") == 3 for m in written) and any(m.get("id") == 1 for m in written)


async def test_a_line_past_the_readers_limit_never_kills_the_bridge(bridge):
    """A message longer than the reader takes at once (4 MB on stdin) made readline raise
    ValueError out of serve(), and the bridge died; the client should get a parse error and
    the next message its answer."""
    bridge.release.set()
    long = b'{"jsonrpc":"2.0","id":1,"method":"ping","x":"' + b"a" * 4096 + b'"}\n'
    ping = b'{"jsonrpc":"2.0","id":2,"method":"ping"}\n'
    written = await _serve(bridge, [long, ping], limit=1024)
    assert any(m.get("id") == 2 and m.get("result") == {} for m in written)


# ── the Gemini relay, its upstream failing ──


async def _gemini(answer, stream=True):
    from test_gemini_proxy import KEY

    from jarvis.gemini_proxy import GeminiRelay

    relay = GeminiRelay(httpx.AsyncClient(transport=httpx.MockTransport(answer)))
    body = {
        "model": "gemini-flash-latest",
        "stream": stream,
        "messages": [{"role": "user", "content": "hi"}],
    }
    return await relay.messages(KEY, body)


def _kinds(text):
    from test_gemini_proxy import events_of

    return events_of(text)


async def test_a_gemini_stream_that_breaks_off_ends_in_an_error_never_a_finished_answer():
    """Google's stream dropping part-way (a reset, the read timeout) ended the message as
    a normal end_turn: Claude Code took the cut-off words as the whole answer. The OpenAI
    relay ends such a stream in Anthropic's error event; this one should too."""

    class Broken(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"candidates": [{"content": {"parts": [{"text": "Half"}]}}]}\r\n\r\n'
            raise httpx.ReadError("connection reset")

    def answer(request):
        return httpx.Response(200, stream=Broken(), headers={"content-type": "text/event-stream"})

    status, _body, events = await _gemini(answer)
    got = _kinds("".join([piece async for piece in events]))
    assert status == 200
    assert got[-1][0] == "error", [kind for kind, _ in got]


async def test_an_error_inside_a_gemini_stream_is_said_never_dropped():
    """An error Google sends as a chunk of the stream (overloaded part-way) was skipped, and
    the turn ended as a quiet, empty answer taken as done."""
    chunks = [
        {"candidates": [{"content": {"parts": [{"text": "The first"}]}}]},
        {"error": {"code": 503, "message": "The model is overloaded.", "status": "UNAVAILABLE"}},
    ]
    body = "".join(f"data: {json.dumps(c)}\r\n\r\n" for c in chunks).encode()

    def answer(request):
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    _status, _body, events = await _gemini(answer)
    got = _kinds("".join([piece async for piece in events]))
    assert got[-1][0] == "error" and "overloaded" in json.dumps(got[-1][1])


async def test_a_whole_gemini_reply_that_isnt_json_is_an_error_never_a_500():
    """A whole (non-streamed) reply that isn't JSON (a captive portal's page, a proxy's)
    raised out of the relay: a 500 and a traceback in the log instead of an answer."""

    def page(request):
        return httpx.Response(200, text="<!doctype html><title>Wi-Fi sign-in</title>")

    status, body, events = await _gemini(page, stream=False)
    assert events is None and status >= 400 and body["type"] == "error"


# ── odd numbers and wasted work ──


async def test_odd_calendar_numbers_from_another_app_are_refused_in_words(
    settings, quiet_speaker, isolated, monkeypatch, tmp_path, caplog
):
    """JSON's Infinity for a day count passed the endpoint's checks: int() raised
    OverflowError past its ValueError guard, a warning went to the log and the app heard
    "That didn't work (OverflowError)" instead of what's wrong with its call."""
    from conftest import FakeClient

    from jarvis import mac_tools
    from jarvis.hub import Hub
    from jarvis.mcp_endpoint import Endpoint

    async def no_events(*_args, **_kwargs):
        return []

    monkeypatch.setattr(mac_tools, "fetch_events", no_events)  # never the real calendar
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    endpoint = Endpoint(hub, tmp_path / "mcp")
    for arguments in ({"days": float("inf")}, {"start_offset_days": float("-inf")}):
        caplog.clear()
        text, error = await endpoint.call("calendar", arguments, "Claude Code")
        assert error and "whole numbers" in text, text
        assert not [r for r in caplog.records if r.levelname in ("WARNING", "ERROR")]


def test_the_phones_diff_reads_only_the_new_files_it_shows(tmp_path, monkeypatch):
    """The phone's Changes view shows DIFF_FILES files, but every one of up to 200 new
    files was read whole first (256 KB each): 75 MB and half a second per look for a
    project with a few hundred untracked files, five times what it shows."""
    import subprocess
    from pathlib import Path

    from jarvis import companion_api

    repo = tmp_path / "project"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    for i in range(120):
        (repo / f"new{i:03d}.txt").write_text(f"line {i}\n")
    reads: list[str] = []
    real = Path.read_bytes

    def counted(self):
        reads.append(self.name)
        return real(self)

    monkeypatch.setattr(Path, "read_bytes", counted)
    files = companion_api.collect_diff(repo)
    assert len(files) == companion_api.DIFF_FILES
    assert len(reads) <= companion_api.DIFF_FILES, f"read {len(reads)} files to show {len(files)}"


# ── the wake listener (launchd starts one per connection) ──


def test_a_wake_connection_that_trickles_is_dropped_within_its_seconds(tmp_path, monkeypatch):
    """Port 8764 is open to the whole network while the companion is on, and launchd starts
    a whole Python for each connection. Its socket's timeout is per read, with no deadline
    for the request: a peer sending a byte every nine seconds holds one for 8,192 reads
    (about twenty hours), so a few hundred slow connections from the Wi-Fi fill the owner's
    process table and memory. The request should be in within SECONDS, all told."""
    from jarvis import companion_wake

    now = [1_000.0]
    for name in ("monotonic", "time", "perf_counter"):  # whichever clock a deadline reads
        monkeypatch.setattr(time, name, lambda: now[0])

    class Trickle:
        """A peer that sends a byte a (pretend) second and never finishes its request."""

        def __init__(self):
            self.reads, self.sent = 0, b""

        def settimeout(self, _seconds):
            pass

        def recv(self, _size):
            self.reads += 1
            now[0] += 1.0
            return b"x"

        def sendall(self, data):
            self.sent += data

    peer = Trickle()
    companion_wake.serve(peer, "/Applications/None.app", tmp_path, opener=lambda *a, **k: None)
    assert peer.reads <= companion_wake.SECONDS + 2, f"{peer.reads} reads, {now[0] - 1000:.0f}s"
