"""A hub nothing holds any more is freed, whatever its features keep of it.

The test suite makes thousands of hubs in one process: a module-level map that holds each
one (a WeakKeyDictionary whose value holds its hub keeps both forever) grows the process
by every hub's stores, desks and caches until the run ends.
"""

import asyncio
import gc
import sys
import weakref

import conftest
import pytest
from conftest import FakeClient

from jarvis.hub import Hub


def _dropped_hub(settings, folder, started):
    """A weak reference to a hub made (and, if started, started and closed) as tests make
    them, with stores and a speaker of its own, so no fixture of this test holds it."""
    stores = conftest.isolated.__wrapped__(folder)
    speaker = conftest.quiet_speaker.__wrapped__()

    async def run():
        hub = Hub(settings, client_factory=FakeClient, speaker=speaker, poll=False, **stores)
        if started:
            await hub.start()
            await hub.close()
        return weakref.ref(hub)

    return asyncio.run(run())


def _holders(hub):
    """The module-level maps, lists and sets of jarvis that hold this hub, or hold
    something that holds it directly."""
    found = []
    for name, module in list(sys.modules.items()):
        if not name.startswith("jarvis"):
            continue
        for key, value in list(vars(module).items()):
            if isinstance(value, (dict, weakref.WeakKeyDictionary)):
                items = list(value.items())
            elif isinstance(value, (list, set, weakref.WeakSet)):
                items = [(None, v) for v in value]
            else:
                continue
            for k, v in items:
                if k is hub or v is hub or getattr(v, "hub", None) is hub:
                    found.append(f"{name}.{key}")
                    break
    return found


@pytest.mark.parametrize("started", [False, True], ids=["made", "started and closed"])
def test_a_hub_nothing_holds_is_freed(settings, tmp_path, started):
    refs = [_dropped_hub(settings, tmp_path / str(i), started) for i in range(3)]
    gc.collect()
    alive = [ref() for ref in refs if ref() is not None]
    holders = sorted({h for hub in alive for h in _holders(hub)})
    del alive
    assert not holders, f"module-level maps keep dropped hubs alive: {holders}"
    assert all(ref() is None for ref in refs)


def test_a_hub_started_in_a_test_never_loads_whisper(
    settings, quiet_speaker, isolated, monkeypatch
):
    """A hub started without a transcriber of its own warms up Whisper: in a test that was
    a real model per hub, loaded in a thread of its own (the process grew by gigabytes over
    a few dozen hubs), after a check with Hugging Face over the network."""
    import faster_whisper

    made = []
    monkeypatch.setattr(faster_whisper, "WhisperModel", lambda *a, **k: made.append(a))

    async def run():
        hub = Hub(
            settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated
        )
        await hub.start()
        await asyncio.sleep(0.3)  # the warm-up's thread, if one started, has asked by now
        await hub.close()

    asyncio.run(run())
    assert made == []
