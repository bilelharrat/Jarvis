"""When memory is full, a fact added in Settings makes room by letting go of the oldest,
and the owner is told which, never silently."""

from jarvis.hub import Hub
from jarvis.memory import MAX_FACTS


def drain(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


async def test_a_fact_added_to_a_full_memory_says_which_made_room(
    settings, quiet_speaker, isolated
):
    hub = Hub(settings, speaker=quiet_speaker, transcriber=object(), poll=False, **isolated)
    for i in range(MAX_FACTS):
        hub.memory.add(f"Fact number {i} is about topic {i * 7919}")
    oldest = hub.memory.facts[0].text
    q = hub.subscribe()
    await hub.handle({"type": "memory_add", "text": "My sister's name is Ada"})
    toasts = [e for e in drain(q) if e["type"] == "toast"]
    assert len(toasts) == 1 and oldest in toasts[0]["text"]
    assert len(hub.memory.facts) == MAX_FACTS and hub.memory.facts[-1].text.endswith("Ada")


async def test_a_fact_added_with_room_to_spare_says_nothing_more(settings, quiet_speaker, isolated):
    hub = Hub(settings, speaker=quiet_speaker, transcriber=object(), poll=False, **isolated)
    q = hub.subscribe()
    await hub.handle({"type": "memory_add", "text": "My sister's name is Ada"})
    assert not [e for e in drain(q) if e["type"] == "toast"]
