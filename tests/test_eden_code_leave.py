"""The last Eden window leaving a backend Eden Code started (hub.window_left): nothing it
woke goes on. No speech player left running, even across fast join/leave cycles (CH2-1);
nothing queued or noticed is said after it (CH2-2); the assistant's Claude Code lets go and
connects again only when needed, carrying the conversation on (CH2-10)."""

import asyncio
from pathlib import Path

import pytest
from test_eden_code_app import make_hub


class Player:
    """Stands in for LivePlayer: the process runs from the start of start() (the real one
    spawns, then waits for the player's hello)."""

    made: list["Player"] = []

    def __init__(self, path, rate, effect):
        self.effect, self.running, self.closed = effect, False, False
        Player.made.append(self)

    async def start(self):
        self.running = True
        await asyncio.sleep(0.05)

    @property
    def alive(self):
        return self.running and not self.closed

    def close(self):
        self.closed = True

    def stop_now(self):
        pass


@pytest.fixture
def code_hub(settings, quiet_speaker, isolated, monkeypatch):
    monkeypatch.setenv("JARVIS_PROFILE", "code")
    monkeypatch.setattr("jarvis.hub.CLIENT_GRACE_SECONDS", 0)  # (its own test below gives it time)
    Player.made = []
    return make_hub(settings, quiet_speaker, isolated)


async def test_fast_join_and_leave_cycles_leave_no_player_running(code_hub, monkeypatch):
    hub = code_hub
    await hub.start()
    monkeypatch.setattr("jarvis.speech.ensure_player", lambda: Path("/nonexistent/player"))
    hub.speaker.player_factory = Player
    hub.poll = True
    hub._spawn_voice_loops = lambda: [hub._spawn(hub._prepare_player())]
    hub._spawn_eden_loops = lambda: None
    hub._briefing_clock = lambda: asyncio.sleep(0)
    hub._drop_connection = lambda: asyncio.sleep(0)  # (CH2-10's own test)
    hub.window_joined("eden-code")
    for i in range(30):
        hub.window_joined("jarvis")
        await asyncio.sleep(0.001 * (i % 6) * 15)  # left mid-start, after, or before
        hub.window_left("jarvis")
        await asyncio.sleep(0.005)
    await asyncio.sleep(0.2)
    assert Player.made  # players were started
    assert [p for p in Player.made if p.alive] == []
    assert hub.speaker._live is None and hub.profile == "code"


async def test_nothing_is_said_after_the_last_eden_window_leaves(code_hub):
    hub = code_hub

    class Ears:
        error = ""

        def warm_up(self):
            pass

        def cached(self):
            return False  # the first time: the speech model is fetched, and that's said

        def loaded(self):
            return False

    hub.transcriber = Ears()
    await hub.start()
    hub.poll = True
    hub._spawn_voice_loops = lambda: []
    hub._spawn_eden_loops = lambda: None
    hub._briefing_clock = lambda: asyncio.sleep(0)
    said, cleared, closed = [], [], []
    hub.speech.push = said.append
    hub.speech.clear = lambda: cleared.append(True)
    hub.speaker.close_live = lambda: closed.append(True)
    hub.window_joined("jarvis")
    await asyncio.sleep(0)
    notice = hub._ears_task
    assert said and "hearing ready" in said[0]
    hub.window_left("jarvis")
    assert cleared == [True] and closed == [True]  # queued speech dropped, the player gone
    await asyncio.sleep(0)
    assert notice.cancelled()  # it never says "I can hear you now." to no one


async def test_the_assistants_claude_lets_go_and_comes_back_when_needed(code_hub):
    hub = code_hub
    await hub.start()
    assert hub.client is None  # Eden Code alone: never connected
    hub.window_joined("jarvis")
    await hub._connecting
    first = hub.client
    assert first is not None and first.connected
    hub._session_id = "session-1"  # a conversation had begun
    hub.window_left("jarvis")
    for _ in range(5):
        await asyncio.sleep(0)
    assert hub.client is None and not first.connected and hub._connecting is None
    await hub._connection_ready()  # the next request (or Eden window): connected again
    again = hub.client
    assert again is not first and again.connected
    assert again.options.resume == "session-1"  # the same conversation, carried on


async def test_an_eden_window_back_before_it_let_go_keeps_the_connection(code_hub):
    hub = code_hub
    await hub.start()
    hub.window_joined("jarvis")
    await hub._connecting
    first = hub.client
    hub.window_left("jarvis")
    hub.window_joined("jarvis")  # back at once
    for _ in range(5):
        await asyncio.sleep(0)
    assert hub.client is first and first.connected


async def test_a_request_under_way_isnt_cut(code_hub):
    hub = code_hub
    await hub.start()
    hub.window_joined("jarvis")
    await hub._connecting
    first = hub.client
    async with hub._lock:  # a request is being answered
        hub.window_left("jarvis")
        for _ in range(5):
            await asyncio.sleep(0)
        assert hub.client is first and first.connected
    for _ in range(5):
        await asyncio.sleep(0)
    assert hub.client is None and not first.connected


async def test_a_quick_reload_of_the_eden_window_keeps_the_assistants_claude(code_hub, monkeypatch):
    """r3 optimization: an Eden window reloading left and came back within a second, and its
    Claude Code (a ~107 MB `claude`) was stopped and started each time. It stays for a grace
    period now, and goes only when no Eden window came back within it."""
    monkeypatch.setattr("jarvis.hub.CLIENT_GRACE_SECONDS", 0.3)
    hub = code_hub
    await hub.start()
    hub.window_joined("jarvis")
    await hub._connecting
    first = hub.client
    hub.window_left("jarvis")
    await asyncio.sleep(0.05)  # a reload: the window is gone a moment
    assert hub.client is first and first.connected  # (before: already disconnected here)
    hub.window_joined("jarvis")
    await asyncio.sleep(0.45)  # past the grace period: it came back, so nothing goes
    assert hub.client is first and first.connected and hub._connecting is not None
    hub.window_left("jarvis")  # gone for good this time
    await asyncio.sleep(0.45)
    assert hub.client is None and not first.connected
