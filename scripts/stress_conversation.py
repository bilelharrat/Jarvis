"""Stress test full conversations against real Claude (your Claude Code sign-in).

Runs the real hub with a silent speaker and temporary prefs, so nothing you've set up is
touched and nothing is spoken:

    uv run python scripts/stress_conversation.py
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jarvis.config import load_settings  # noqa: E402
from jarvis.connectors import ConnectorManager, MemoryVault  # noqa: E402
from jarvis.hub import Hub  # noqa: E402
from jarvis.knowledge import KnowledgeBase  # noqa: E402
from jarvis.prefs import PrefsStore  # noqa: E402
from jarvis.speech import Speaker  # noqa: E402


class Listener:
    running = True

    def __init__(self, *_):
        pass

    def start(self):
        pass

    def stop(self):
        self.running = False


async def main() -> None:
    tmp = Path(tempfile.mkdtemp())
    settings = replace(load_settings(), bsh_dir=None)
    store = PrefsStore(tmp / "prefs.json")
    store.prefs.hands_free = True
    speaker = Speaker(settings.voice, settings.speech_rate, muted=True)

    async def deny(*_):
        return "deny"

    hub = Hub(
        settings,
        speaker=speaker,
        transcriber=object(),
        poll=False,
        prefs_store=store,
        kb=KnowledgeBase(tmp / "index.json"),
        connectors=ConnectorManager(
            lambda *a, **k: None, deny, vault=MemoryVault(), store=tmp / "c.json"
        ),
        listener_factory=Listener,
    )
    await hub.start()
    errors: list[str] = []
    hub.subscribe()  # keep a subscriber so events flow as in the app
    q = hub.subscribe()
    results: list[tuple[str, bool, str]] = []

    def drain_errors():
        while not q.empty():
            ev = q.get_nowait()
            if ev["type"] == "error":
                errors.append(ev["text"])

    async def ask(text: str) -> tuple[str, float]:
        t0 = time.monotonic()
        await hub.ask(text)
        drain_errors()
        return hub.turn.get("reply", ""), time.monotonic() - t0

    def says(reply: str, digits: str, spelled: str) -> bool:
        low = reply.lower()
        return digits in low or spelled in low

    def check(name: str, ok: bool, detail: str) -> None:
        results.append((name, ok, detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")

    reply, t = await ask("My favorite color is teal and my dog is called Biscuit. Just say noted.")
    check("sets a fact", bool(reply), f"{t:.1f}s · {reply[:60]!r}")
    reply, t = await ask("What's my dog's name and my favorite color?")
    check(
        "remembers across turns",
        "biscuit" in reply.lower() and "teal" in reply.lower(),
        f"{t:.1f}s · {reply[:80]!r}",
    )

    # Rapid fire: five requests at once must all be answered, one after another.
    t0 = time.monotonic()
    replies: list[str] = []

    async def one(n: int) -> None:
        await hub.ask(f"Reply with only the number {n * 11}.")
        replies.append(hub.turn.get("reply", ""))

    await asyncio.gather(*(one(n) for n in range(1, 6)))
    drain_errors()
    got = sorted(r.strip().rstrip(".") for r in replies)
    check(
        "five requests at once",
        got == sorted(str(n * 11) for n in range(1, 6)),
        f"{time.monotonic() - t0:.1f}s · {got}",
    )

    # Interrupt a long answer, then carry on.
    long_task = asyncio.create_task(
        hub.ask("Tell me a long, detailed story about a lighthouse keeper.")
    )
    await asyncio.sleep(2.5)
    await hub.stop()
    await long_task
    reply, t = await ask("What's 17 plus 25?")
    check(
        "recovers after an interrupt", says(reply, "42", "forty-two"), f"{t:.1f}s · {reply[:60]!r}"
    )

    # Hands-free: wake word, then a follow-up without it.
    await hub.on_heard("Jarvis, what's 6 times 7?")
    await asyncio.sleep(0.1)
    while hub._lock.locked():
        await asyncio.sleep(0.1)
    first = hub.turn.get("reply", "")
    armed = hub.state == "listening"
    await hub.on_heard("and divided by two?")
    await asyncio.sleep(0.1)
    while hub._lock.locked():
        await asyncio.sleep(0.1)
    follow = hub.turn.get("reply", "")
    check(
        "wake word then follow-up without it",
        says(first, "42", "forty-two") and armed and says(follow, "21", "twenty-one"),
        f"{first[:40]!r} → {follow[:40]!r}",
    )

    # Reloading tools (what connecting an account does) keeps the conversation.
    await hub._reload_tools()
    reply, t = await ask("Remind me: what's my dog called?")
    check(
        "conversation survives a tool reload",
        "biscuit" in reply.lower(),
        f"{t:.1f}s · {reply[:60]!r}",
    )

    # A burst of ten quick turns in a row.
    t0 = time.monotonic()
    ok = 0
    for n in range(10):
        reply, _ = await ask(
            f"Reply with only the word {['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'][n]}."
        )
        ok += bool(reply.strip())
    check("ten turns back to back", ok == 10, f"{ok}/10 answered in {time.monotonic() - t0:.1f}s")

    reply, t = await ask("Across this whole conversation, what's my favorite color?")
    check(
        "long conversation still remembers", "teal" in reply.lower(), f"{t:.1f}s · {reply[:60]!r}"
    )

    check("no errors surfaced", not errors, "; ".join(errors)[:200] or "none")
    await hub.close()
    passed = sum(ok for _, ok, _ in results)
    print(f"\n{passed}/{len(results)} checks passed")


if __name__ == "__main__":
    asyncio.run(main())
