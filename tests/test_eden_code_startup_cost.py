"""What Eden Code costs to start and to leave open (the efficiency pass, 2026-10-16).

Measured on a private backend (JARVIS_PROFILE=code): the hub's own Claude Code process
(~215 MB, ~1 s of startup) now waits for the first question; with no window open the hub's
polls hold no timer at all; the idle feature loops look rarely. These caps keep the next
feature from quietly undoing it: raise one only on purpose, with the new number measured."""

import asyncio

from conftest import CALENDAR_TURN, FakeClient
from test_eden_code_app import _nothing, _recording_hub, _trap_personal_readers

from jarvis.hub import Hub, LazyConnect
from jarvis.server import feature_assets

# Eden Code's eager startup: the hub's own polls plus one loop per feature that registers
# one (measured 2026-10-16: 51). A new loop should start when its feature is used or
# switched on, or idle with a long wait; if it can't, raise this knowingly.
MAX_EAGER_TASKS = 55
# The window's feature files at startup (measured: 152 scripts / 2.2 MB, 133 styles / 0.46 MB).
MAX_FEATURE_SCRIPTS = 175
MAX_FEATURE_SCRIPT_BYTES = 2_600_000


async def test_eden_code_alone_starts_a_capped_number_of_background_tasks(
    settings, quiet_speaker, isolated, monkeypatch
):
    monkeypatch.setenv("JARVIS_PROFILE", "code")
    _trap_personal_readers(monkeypatch)
    hub = _recording_hub(settings, quiet_speaker, isolated)
    hub._relay_if_needed = _nothing
    await hub.start()
    assert len(hub.started) <= MAX_EAGER_TASKS, len(hub.started)


def test_the_window_loads_a_capped_set_of_feature_files():
    found = feature_assets()
    from jarvis.server import WEB_DIR

    sizes = sum(
        (WEB_DIR / "features" / url.split("/")[-1].split("?")[0]).stat().st_size
        for url in found["scripts"]
    )
    assert len(found["scripts"]) <= MAX_FEATURE_SCRIPTS, len(found["scripts"])
    assert sizes <= MAX_FEATURE_SCRIPT_BYTES, sizes


def _lazy_hub(settings, speaker, isolated, monkeypatch):
    class Client(FakeClient):
        script = CALENDAR_TURN

    monkeypatch.setenv("JARVIS_PROFILE", "code")
    hub = Hub(
        settings,
        client_factory=Client,
        speaker=speaker,
        poll=False,
        lazy_connect=True,
        **isolated,
    )
    return hub


async def test_eden_code_s_claude_code_process_starts_at_the_first_question(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = _lazy_hub(settings, quiet_speaker, isolated, monkeypatch)
    await hub.start()
    assert isinstance(hub.client, LazyConnect)
    assert not hub.client._client.connected  # (nothing running: no process, no memory)
    await hub.client.disconnect()  # leaving it is free
    await hub.client.set_model("sonnet")  # a change to a process not running: nothing
    await hub.client.interrupt()
    assert not hub.client._client.connected
    await hub.ask("What is on my calendar?")
    assert hub.client._client.connected
    assert hub.client._client.said == ["What is on my calendar?"]
    await hub.client.disconnect()
    assert not hub.client._client.connected


async def test_the_lazy_client_never_starts_the_process_to_answer_a_status_question(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = _lazy_hub(settings, quiet_speaker, isolated, monkeypatch)
    await hub.start()

    async def usage():
        raise AssertionError("asked a process that isn't running")

    hub.client._client.get_context_usage = usage
    try:
        await hub.client.get_context_usage()
    except RuntimeError:
        pass  # the callers already answer "not available" to this
    assert not hub.client._client.connected


async def test_with_no_window_open_the_hub_s_polls_hold_no_timer(
    settings, quiet_speaker, isolated, monkeypatch
):
    """Vitals, system stats, the plan card and the defense panel: nothing to show, so they
    wait for a window instead of waking every 2-30 s."""
    hub = _lazy_hub(settings, quiet_speaker, isolated, monkeypatch)
    sleeps: list[float] = []
    real_sleep = asyncio.sleep

    async def counted(seconds, *a, **k):
        sleeps.append(seconds)
        return await real_sleep(seconds, *a, **k)

    monkeypatch.setattr(asyncio, "sleep", counted)
    tasks = [
        asyncio.create_task(hub._vitals_loop()),
        asyncio.create_task(hub._sysmon_loop()),
        asyncio.create_task(hub._plan_loop()),
    ]
    await real_sleep(0.05)
    assert sleeps == []  # parked on the event, no timers
    queue = hub.subscribe()  # a window opens: they run at once
    await real_sleep(0.05)
    assert 3 in sleeps or 2 in sleeps or 2.0 in sleeps
    hub.unsubscribe(queue)
    sleeps.clear()
    await real_sleep(3.2)  # one more round at most, then parked again
    assert len(sleeps) <= 3
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
