"""The hub under the stress sweep's bursts: many heads-ups at once, the window's own prose
commands with ultracode on."""

import asyncio

from test_hub import make_hub
from test_tasks import StreamClient

from jarvis import hub as hub_mod
from jarvis.proactive import Alert


async def test_a_burst_of_heads_ups_is_said_once_with_a_count(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    monkeypatch.setattr(hub_mod, "in_quiet_hours", lambda *_a: False)
    said = []

    async def announce(text):
        said.append(text)
        await asyncio.sleep(0.05)  # saying it takes a moment

    hub._announce = announce
    for i in range(50):  # fifty long turns finishing together
        hub.notify(Alert(f"code:{i}", "task", "Jarvis Code", f"Jarvis Code finished in proj{i}."))
    await asyncio.sleep(0.3)
    # One announcement for the burst: the first two in full, then how many more.
    assert said == [
        "Jarvis Code finished in proj0.\nJarvis Code finished in proj1.\n"
        "48 more heads-ups are on screen."
    ]
    hub.notify(Alert("code:x", "task", "Jarvis Code", "Jarvis Code finished in later."))
    await asyncio.sleep(0.1)
    assert said[-1] == "Jarvis Code finished in later."  # a later one is said as usual


async def test_the_windows_own_wording_never_gets_the_ultracode_keyword(
    settings, quiet_speaker, isolated, tmp_path
):
    (tmp_path / "proj").mkdir()

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.tasks.client_factory = StreamClient  # it answers each message
    task = hub.tasks.start("", "proj", ultracode=True)
    for _ in range(100):
        await asyncio.sleep(0.005)
        if task.status == "waiting":
            break
    review = "Review the uncommitted changes in this project for bugs."
    await hub.handle({"type": "task_send", "id": task.id, "text": review, "plain": True})
    await hub.handle({"type": "task_send", "id": task.id, "text": "tidy the parser"})
    for _ in range(100):
        await asyncio.sleep(0.005)
        if len(task.client.queries) == 2 and not task.busy:
            break
    assert task.client.queries == [review, "tidy the parser\n\nultracode"]
    task.handle.cancel()
