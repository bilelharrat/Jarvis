"""Waiting in the conversation feature's tests: for a condition, polled, never a fixed number
of rounds, so a loaded machine only makes a test slower, never wrong. Every wait has an
end: a test that would wait forever fails instead."""

import asyncio

WAIT = 60.0  # seconds: far past anything a loaded machine needs, short of a hung run


async def until(check, timeout: float = WAIT) -> None:
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not check():
        if loop.time() > end:
            raise AssertionError("waited too long")
        await asyncio.sleep(0.005)


async def settle(hub, timeout: float = WAIT) -> None:
    """Everything the conversation feature started in the background is done."""
    await asyncio.sleep(0)
    try:
        await asyncio.wait_for(hub.conversation.flush(), timeout)
    except TimeoutError:
        raise AssertionError("the conversation feature's background work never finished") from None


async def answer_card(hub, choice: str) -> dict:
    """The one card up, answered."""
    await until(lambda: hub.approvals)
    (approval,) = hub.approvals.values()
    hub.resolve(approval["id"], choice)
    return approval
