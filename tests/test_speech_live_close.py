"""The live voice player started by Speaker.live() is never left running unreferenced
(CH2-1): a cancel while it starts (an Eden window that left at once, the prepare step's
timeout) closes it, and close_live() closes one that was starting when it came."""

import asyncio
from pathlib import Path

import pytest

from jarvis.speech import Speaker


class SlowPlayer:
    """Stands in for LivePlayer: its start takes a while, as the real one waits for the
    player's hello."""

    made: list["SlowPlayer"] = []

    def __init__(self, path, rate, effect):
        self.effect, self.closed, self.started = effect, False, False
        SlowPlayer.made.append(self)

    async def start(self):
        await asyncio.sleep(0.2)
        self.started = True

    @property
    def alive(self):
        return self.started and not self.closed

    def close(self):
        self.closed = True


@pytest.fixture
def speaker(quiet_speaker):
    SlowPlayer.made = []
    quiet_speaker.player_path = Path("/nonexistent/jarvis-player")
    quiet_speaker.player_factory = SlowPlayer
    return quiet_speaker


async def test_a_cancel_while_the_player_starts_closes_it(speaker):
    task = asyncio.ensure_future(speaker.live())
    await asyncio.sleep(0.05)  # inside start()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    [made] = SlowPlayer.made
    assert made.closed and speaker._live is None


async def test_a_timeout_while_it_starts_closes_it(speaker):
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(speaker.live(), 0.05)
    assert all(p.closed for p in SlowPlayer.made) and speaker._live is None


async def test_close_live_while_it_starts_closes_the_new_one(speaker):
    task = asyncio.ensure_future(speaker.live())
    await asyncio.sleep(0.05)
    speaker.close_live()
    assert await task is None
    [made] = SlowPlayer.made
    assert made.closed and speaker._live is None
    again = await speaker.live()  # the next one starts as usual
    assert again is not None and again.alive and speaker._live is again


async def test_close_live_closes_the_running_one(speaker):
    live = await speaker.live()
    speaker.close_live()
    assert live.closed and speaker._live is None


def test_close_live_on_a_speaker_made_without_init():
    bare = Speaker.__new__(Speaker)
    bare._live = None
    bare.close_live()  # nothing to close, no error
