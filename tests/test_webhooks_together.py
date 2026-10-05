"""Webhook calls that arrive together (jarvis.webhooks): a hook's hourly limit, the lockout
after wrong tokens, a deleted hook and a new token all hold while a call's body is still on
its way or its token is still being read from the Keychain. Temp folders and a MemoryVault
only."""

from __future__ import annotations

import asyncio
import threading

from starlette.requests import ClientDisconnect

from jarvis import webhooks as wh
from jarvis.connectors import MemoryVault


class Arriving:
    """A POST whose body comes only once `go` is set (a streamed upload, Expect:
    100-continue, a slow link: what Starlette's request.stream() is to handle() then).
    `hang_up` makes the sender go away instead."""

    def __init__(self, token: str, go: asyncio.Event, body: bytes = b"build 7 failed") -> None:
        self.headers = {"host": "127.0.0.1:8123", "x-jarvis-token": token}
        self.query_params: dict[str, str] = {}
        self.go, self.body, self.hang_up = go, body, False

    async def stream(self):
        await self.go.wait()
        if self.hang_up:
            raise ClientDisconnect()
        for i in range(0, len(self.body), 1000):
            yield self.body[i : i + 1000]


async def door(tmp_path, per_hour: int = 3):
    handed: list[str] = []
    clock = [1000.0]
    hooks = wh.Webhooks(
        tmp_path / "webhooks.json",
        MemoryVault(),
        lambda _h, text: handed.append(text),
        mono=lambda: clock[0],
    )
    await hooks.add("ci")
    hooks.update("ci", per_hour=per_hour)
    return hooks, handed, clock


async def started(*calls):
    """The calls as tasks, each run up to where it waits for its body."""
    tasks = [asyncio.ensure_future(call) for call in calls]
    for _ in range(5):
        await asyncio.sleep(0)
    return tasks


async def test_calls_whose_bodies_arrive_late_never_pass_the_hourly_limit(tmp_path):
    hooks, handed, _clock = await door(tmp_path, per_hour=3)
    token = await hooks.token("ci")
    go = asyncio.Event()
    tasks = await started(*(hooks.handle("ci", Arriving(token, go)) for _ in range(50)))
    go.set()
    statuses = [status for status, _body in await asyncio.gather(*tasks)]
    assert statuses.count(202) == 3 and statuses.count(429) == 47
    assert len(handed) == 3


async def test_a_call_that_doesnt_get_in_gives_its_place_back(tmp_path):
    """Too big (counted as it comes) or a sender that hangs up: neither uses one of the
    hour's calls, so the next ones still get in."""
    hooks, handed, _clock = await door(tmp_path, per_hour=2)
    token = await hooks.token("ci")
    go = asyncio.Event()
    big = Arriving(token, go, b"x" * (wh.MAX_BYTES + 1))
    gone = Arriving(token, go)
    gone.hang_up = True
    tasks = await started(hooks.handle("ci", big), hooks.handle("ci", gone))
    go.set()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    assert results[0][0] == 413 and isinstance(results[1], ClientDisconnect)
    ready = asyncio.Event()
    ready.set()
    for _ in range(2):
        assert (await hooks.handle("ci", Arriving(token, ready)))[0] == 202
    assert (await hooks.handle("ci", Arriving(token, ready)))[0] == 429
    assert len(handed) == 2


async def test_the_hour_still_moves_on_after_calls_that_arrived_together(tmp_path):
    hooks, handed, clock = await door(tmp_path, per_hour=2)
    token = await hooks.token("ci")
    go = asyncio.Event()
    tasks = await started(*(hooks.handle("ci", Arriving(token, go)) for _ in range(5)))
    go.set()
    assert [s for s, _b in await asyncio.gather(*tasks)].count(202) == 2
    clock[0] += 3600
    assert (await hooks.handle("ci", Arriving(token, go)))[0] == 202
    assert len(handed) == 3


async def test_a_hook_deleted_or_given_a_new_token_while_a_body_arrives_refuses_it(tmp_path):
    hooks, handed, _clock = await door(tmp_path, per_hour=10)
    old = await hooks.token("ci")
    go = asyncio.Event()
    [late] = await started(hooks.handle("ci", Arriving(old, go)))
    new = await hooks.regenerate("ci")
    go.set()
    assert await late == (401, {"error": "unauthorized"})
    go = asyncio.Event()
    [late] = await started(hooks.handle("ci", Arriving(new, go)))
    assert await hooks.remove("ci")
    go.set()
    assert await late == (401, {"error": "unauthorized"})
    assert handed == []


async def test_guesses_that_arrive_together_cant_slip_under_the_lockout(tmp_path, monkeypatch):
    """Every guess, and then the right token, is waiting on the Keychain when the lockout
    starts: the right one is refused like any call during the lockout."""
    hooks, handed, _clock = await door(tmp_path, per_hour=100)
    right = await hooks.token("ci")
    opened = asyncio.Event()

    async def keychain(name):  # the Keychain read, answered in the order it was asked
        await opened.wait()
        return hooks.vault.get(wh.VAULT_PREFIX + name, "token")

    monkeypatch.setattr(hooks, "token", keychain)
    go = asyncio.Event()
    go.set()
    guesses = await started(
        *(hooks.handle("ci", Arriving("guess", go)) for _ in range(wh.WRONG_MAX))
    )
    [last] = await started(hooks.handle("ci", Arriving(right, go)))
    opened.set()
    assert [status for status, _b in await asyncio.gather(*guesses)] == [401] * wh.WRONG_MAX
    assert (await last)[0] == 429
    assert handed == []


class HeldVault(MemoryVault):
    """A Keychain whose reads wait, once `hold` is given, until it's set."""

    def __init__(self) -> None:
        super().__init__()
        self.hold: threading.Event | None = None
        self.reading = threading.Event()

    def get(self, conn_id: str, key: str) -> str | None:
        value = super().get(conn_id, key)
        hold = self.hold
        if hold is not None:
            self.reading.set()
            hold.wait(10)
        return value


async def test_a_new_token_made_while_the_old_one_is_read_stays(tmp_path):
    """The Keychain read that was under way when a new token was made can't bring the old
    token back."""
    vault = HeldVault()
    hooks = wh.Webhooks(tmp_path / "webhooks.json", vault, lambda *_: None)
    await hooks.add("ci")
    old = await hooks.token("ci")
    hooks._tokens.clear()  # as after a restart: the next call reads the Keychain
    vault.hold = threading.Event()
    pending = asyncio.ensure_future(hooks.token("ci"))
    assert await asyncio.to_thread(vault.reading.wait, 10)
    new = await hooks.regenerate("ci")
    vault.hold.set()
    vault.hold = None
    assert await pending == new != old
    ready = asyncio.Event()
    ready.set()
    assert (await hooks.handle("ci", Arriving(old, ready)))[0] == 401
    assert (await hooks.handle("ci", Arriving(new, ready)))[0] == 202
