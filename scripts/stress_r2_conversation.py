"""Stress JARVIS's own conversation: the hub with a fake Claude (no model, no network), a
muted speaker, and every store in a temp folder. The app's own data folder is a temp
stand-in too, and Claude Code's records are fakes: nothing here reads or writes the owner's
~/Library/Application Support/Jarvis or ~/.claude.

    uv run python scripts/stress_r2_conversation.py              # every part
    uv run python scripts/stress_r2_conversation.py turns long   # some of them

Parts:
- turns: thousands of sequential turns, each its own conversation (300 kept), first back
  to back and then paced as a busy owner would: per-turn latency, event-loop lag, memory,
  conversation.json's size and save time.
- unicode: requests and replies with lone surrogates, Chinese without full stops, RTL and
  bidi controls, emoji ZWJ runs, combining marks, NUL, BOM: nothing logged, every event
  sendable, conversation.json readable.
- long: replies of 64 KB to 4 MB streamed in 20-character deltas, a window reading: the
  loop's CPU time per size (linear is about four times per fourfold size).
- concurrent: the window, the phone and a chat asking at once (10 to 200), with stops,
  queueing on and off: every reply in its own turn, nothing left waiting or locked.
- incognito: going in and out (the window's switch and by voice) among queued requests:
  no incognito session in conversation.json, back to the conversation from before.
- branch: hundreds of rewinds, forks, edits, "try that differently" and spoken rewinds
  against a fake Claude Code that forks its records: no failure logged.
- fuzz: the conversation, projects and personas commands with odd payloads: no traceback.
- quit: the app quitting as a turn ends and in the middle of one: what comes back.
Everything runs off a temp folder it removes at the end.
"""

from __future__ import annotations

import asyncio
import gc
import itertools
import json
import logging
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("JARVIS_LABS", "all")

from claude_agent_sdk import (  # noqa: E402
    AssistantMessage,
    ResultMessage,
    StreamEvent,
    TextBlock,
)

RESULTS: list[tuple[str, bool, str]] = []
FOLDER = Path(tempfile.mkdtemp(prefix="jarvis-stress-conversation-"))


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}", flush=True)
    return ok


# ── the guards: nothing real, ever ──


def guard() -> None:
    """What tests/conftest.py fakes (stress_knowledge.guard), plus: the app's own data
    folder is a temp stand-in (chat projects and pins live there), Claude Code's records are
    none, Whisper never warms up, and no real voice, player or script is started."""
    import stress_knowledge

    stress_knowledge.guard()
    from jarvis import conversation_past, listen, prefs

    prefs.APP_SUPPORT = FOLDER / "app-support"
    prefs.APP_SUPPORT.mkdir(parents=True, exist_ok=True)

    def none_listed(*_a: Any, **_k: Any) -> list[Any]:
        return []

    def none_found(*_a: Any, **_k: Any) -> None:
        return None

    conversation_past._sdk = lambda: (none_listed, none_listed, none_found)
    listen.Transcriber.warm_up = lambda _self: None
    real = subprocess.Popen

    class Refused(real):  # type: ignore[misc, valid-type]
        def __init__(self, args: Any, *rest: Any, **kwargs: Any) -> None:
            first = args if isinstance(args, str) else next(iter(args), "")
            if os.path.basename(str(first)) in ("say", "afplay", "osascript", "shortcuts"):
                raise FileNotFoundError(2, "refused in the stress run", str(first))
            super().__init__(args, *rest, **kwargs)

    subprocess.Popen = Refused  # type: ignore[misc]


class Logged(logging.Handler):
    """Warnings and worse, as they're logged."""

    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def said(self) -> str:
        return "; ".join(sorted({r.getMessage()[:120] for r in self.records}))[:600]


LOGGED = Logged()


def make_hub(name: str, client: Any) -> Any:
    """A hub on a temp folder of its own, as tests make theirs (conftest's isolated)."""
    from dataclasses import replace

    import stress_knowledge

    from jarvis.answering import CallLog
    from jarvis.config import Settings
    from jarvis.connectors import ConnectorManager, MemoryVault
    from jarvis.delegate import DelegationStore
    from jarvis.documents import DocumentStore
    from jarvis.fileindex import FileIndex
    from jarvis.goals import GoalStore
    from jarvis.hearing import Hearing
    from jarvis.hub import Hub
    from jarvis.interrupts import Interrupter
    from jarvis.invoices import InvoiceStore
    from jarvis.knowledge import KnowledgeBase
    from jarvis.memory import MemoryStore
    from jarvis.prefs import PrefsStore
    from jarvis.providers import ProviderStore
    from jarvis.remote import Devices
    from jarvis.routines import RoutineStore
    from jarvis.screenwatch import ScreenWatcher
    from jarvis.suggestions import Suggester
    from jarvis.transactions import Transactions
    from jarvis.video import VideoDesk

    folder = FOLDER / name
    folder.mkdir(parents=True, exist_ok=True)

    async def never_asked(*_a: Any) -> str:
        return "deny"

    async def no_picture() -> str:
        return ""

    async def no_page() -> dict[str, Any]:
        return {"error": "no browser here"}

    class Ears:
        def warm_up(self) -> None:
            pass

        def transcribe(self, _audio: Any, **_kwargs: Any) -> str:
            return ""

    store = PrefsStore(folder / "prefs.json")
    store.prefs.hands_free = False
    return Hub(
        replace(Settings(), bsh_dir=None, projects_dir=folder),
        client_factory=client,
        speaker=stress_knowledge.silent_speaker(),
        transcriber=Ears(),
        poll=False,
        prefs_store=store,
        kb=KnowledgeBase(folder / "brain" / "index.json"),
        memory=MemoryStore(folder / "memory.json"),
        routines=RoutineStore(folder / "routines.json"),
        devices=Devices(folder / "devices.json"),
        invoice_store=InvoiceStore(folder / "invoices.json", folder / "Invoices"),
        screen_watch=ScreenWatcher(capture=no_picture),
        connectors=ConnectorManager(
            lambda *a, **k: None, never_asked, vault=MemoryVault(), store=folder / "c.json"
        ),
        providers=ProviderStore(folder / "providers.json", MemoryVault()),
        goal_store=GoalStore(folder / "goals.json"),
        delegation_store=DelegationStore(folder / "delegations.json"),
        file_index=FileIndex(folder / "files.db", [], home=folder),
        transaction_desk=Transactions(
            no_page, never_asked, lambda: store.prefs, log_path=folder / "transactions.json"
        ),
        interrupter=Interrupter(
            lambda _a: None, state_path=folder / "interrupts.json", enabled=lambda: False
        ),
        hearing_store=Hearing(folder / "hearing.json"),
        document_store=DocumentStore(
            folder / "documents.json", folder=folder / "Documents", opener=lambda _p: None
        ),
        suggester=Suggester(lambda _s: None, folder / "suggestions.json"),
        video_desk=VideoDesk(roots=[folder], notes_dir=folder / "Videos"),
        call_log=CallLog(folder / "answering.json"),
    )


def fake_records(hub: Any, records: dict[str, list[Any]] | None = None) -> None:
    """Claude Code's records of the conversations: fakes (records, or none)."""
    convo = hub.conversation
    convo.get_info = lambda sid, directory=None: SimpleNamespace(
        session_id=sid, first_prompt="hi", last_modified=1_790_000_000_000
    )
    convo.get_messages = lambda sid, directory=None: list((records or {}).get(sid, []))
    convo.list_sessions = lambda directory=None, limit=None, include_worktrees=False: [
        SimpleNamespace(session_id=s, first_prompt="x", last_modified=i, custom_title=None)
        for i, s in enumerate(records or {})
    ]


class Ticker:
    """Event-loop lag: how far past its time a 10 ms sleep woke, at worst."""

    def __init__(self) -> None:
        self.worst = 0.0
        self.over = 0
        self._task: asyncio.Task | None = None

    async def _run(self) -> None:
        while True:
            began = time.perf_counter()
            await asyncio.sleep(0.01)
            lag = time.perf_counter() - began - 0.01
            self.worst = max(self.worst, lag)
            self.over += lag > 0.1

    def __enter__(self) -> Ticker:
        self._task = asyncio.create_task(self._run())
        return self

    def __exit__(self, *_exc: Any) -> None:
        if self._task is not None:
            self._task.cancel()


def rss_mb() -> float:
    out = subprocess.run(["ps", "-o", "rss=", "-p", str(os.getpid())], capture_output=True)
    return int(out.stdout or 0) / 1024


def result(sid: str, total: float = 0.01, error: bool = False) -> ResultMessage:
    return ResultMessage(
        subtype="error_during_execution" if error else "success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=error,
        num_turns=1,
        session_id=sid,
        total_cost_usd=total,
        result="",
    )


def stream(text: str, sid: str, chunk: int = 20) -> list[Any]:
    events: list[Any] = [
        StreamEvent(
            uuid="u",
            session_id=sid,
            event={"type": "content_block_start", "content_block": {"type": "text"}},
        )
    ]
    for i in range(0, len(text), chunk):
        events.append(
            StreamEvent(
                uuid="u",
                session_id=sid,
                event={
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": text[i : i + chunk]},
                },
            )
        )
    events.append(StreamEvent(uuid="u", session_id=sid, event={"type": "content_block_stop"}))
    events.append(AssistantMessage(content=[TextBlock(text=text)], model="m"))
    return events


def fake_claude() -> type:
    from conftest import FakeClient

    class Claude(FakeClient):
        """Answers each request in a few streamed sentences; keeps no queries."""

        session = ""  # "" for a new conversation each turn
        turns = itertools.count(1)
        reply = "Here's what I found. " * 4

        async def query(self, text: str) -> None:
            self.asked = text

        async def receive_response(self) -> Any:
            n = next(type(self).turns)
            sid = type(self).session or f"0f3c2d1e-aaaa-bbbb-cccc-{n:012d}"
            for i, message in enumerate(stream(type(self).reply, sid)):
                yield message
                if i % 64 == 63:  # Claude Code's messages come in over time
                    await asyncio.sleep(0)
            yield result(sid, 0.001 * n)

    return Claude


# ── the parts ──


async def turns() -> None:
    for pace, count in ((0.0, 3000), (0.025, 1500)):
        LOGGED.records.clear()
        Claude = fake_claude()
        hub = make_hub(f"turns-{pace}", Claude)
        await hub.start()
        latencies: list[float] = []
        before = rss_mb()
        with Ticker() as tick:
            for i in range(count):
                began = time.perf_counter()
                await hub.ask(f"question {i} about the {i % 50}th thing, please")
                latencies.append(time.perf_counter() - began)
                if pace:
                    await asyncio.sleep(pace)
            await hub.conversation.flush()
        gc.collect()
        state = hub.conversation.state
        size = state.path.stat().st_size
        began = time.perf_counter()
        state.save()
        save = time.perf_counter() - began
        first, last = sum(latencies[:100]) / 100, sum(latencies[-100:]) / 100
        latencies.sort()
        detail = (
            f"{count} turns {'back to back' if not pace else f'{pace * 1000:.0f} ms apart'}: "
            f"p50 {latencies[count // 2] * 1000:.1f} ms, p99 "
            f"{latencies[int(count * 0.99)] * 1000:.1f} ms, worst lag {tick.worst * 1000:.0f} ms, "
            f"RSS {before:.0f} -> {rss_mb():.0f} MB, conversation.json {size / 1e3:.0f} KB "
            f"({len(state.sessions)} kept) saved in {save * 1000:.1f} ms; the first hundred "
            f"{first * 1000:.1f} ms, the last {last * 1000:.1f} ms each"
        )
        check(
            f"turns ({'paced' if pace else 'back to back'})",
            len(state.sessions) <= 301  # KEEP, and the current one
            and tick.over == 0
            and last < 3 * first + 0.002
            and not LOGGED.records,
            detail,
        )
        await hub.close()


ODD = {
    "lone surrogates": "hi \ud800 there \udfff",
    "Chinese without full stops": "我查了一下你的日程今天下午有三个会议" * 200,
    "RTL and bidi controls": "שלום \u202eevil\u202c مرحبا",
    "emoji ZWJ runs": "\U0001f468\u200d\U0001f469\u200d\U0001f467\u200d\U0001f466" * 300,
    "combining marks": "e" + "́" * 5000,
    "NUL": "a\x00b\x00c",
    "BOM": "\ufeffhello",
    "tag characters": "hi\U000e0041\U000e0042",
    "newlines": "\n" * 3000 + "hi",
}


async def unicode() -> None:
    from jarvis.server import event_text

    for name, odd in ODD.items():
        for where in ("request", "reply"):
            LOGGED.records.clear()
            Claude = fake_claude()
            Claude.reply = odd if where == "reply" else "Okay."
            Claude.session = "0f3c2d1e-aaaa-bbbb-cccc-0000000000u1"
            hub = make_hub(f"unicode-{len(RESULTS)}", Claude)
            await hub.start()
            window = hub.subscribe()
            await hub.ask(odd if where == "request" else "say it")
            await hub.conversation.flush()
            unsendable = 0
            while not window.empty():
                try:
                    event_text(window.get_nowait()).encode("utf-8")
                except Exception:
                    unsendable += 1
            json.loads(hub.conversation.state.path.read_text())
            check(
                f"unicode: {name} in the {where}",
                not unsendable and not LOGGED.records and hub.state == "idle",
                LOGGED.said() or (f"{unsendable} events can't be sent" if unsendable else ""),
            )
            await hub.close()


async def long() -> None:
    from jarvis.server import event_text

    took: dict[int, float] = {}
    for size in (64_000, 256_000, 1_024_000, 4_096_000):
        Claude = fake_claude()
        Claude.reply = ("The fox jumps over the dog, then naps in the sun. " * 90_000)[:size]
        hub = make_hub(f"long-{size}", Claude)
        await hub.start()
        window = hub.subscribe()
        sent = 0

        async def read(window: Any = window) -> None:
            nonlocal sent
            while (event := await window.get()) is not None:
                sent += len(event_text(event))

        reader = asyncio.create_task(read())
        began = time.thread_time()
        reply = await hub.ask("tell me everything")
        took[size] = time.thread_time() - began
        await asyncio.sleep(0.1)  # the window reads what's left
        reader.cancel()
        print(
            f"      {size / 1e3:.0f} KB: {took[size]:.2f} s of the loop's CPU, "
            f"{sent / 1e6:.1f} MB to the window",
            flush=True,
        )
        if reply.strip() != Claude.reply.strip():
            check(f"long: a {size / 1e3:.0f} KB reply arrives whole", False)
        await hub.close()
    ratio = took[4_096_000] / max(took[1_024_000], 1e-6)
    check(
        "long: a reply four times as long costs about four times the loop's time",
        ratio < 8,
        f"1 MB {took[1_024_000]:.2f} s, 4 MB {took[4_096_000]:.2f} s ({ratio:.1f}x)",
    )


async def concurrent() -> None:
    from conftest import FakeClient

    class Claude(FakeClient):
        async def query(self, text: str) -> None:
            self.asked = text
            self.interrupted = False

        async def interrupt(self) -> None:
            self.interrupted = True

        async def receive_response(self) -> Any:
            word = self.asked.rsplit("\n\n", 1)[-1]
            text = f"Answer to <{word}>. " * 30
            sid = "0f3c2d1e-aaaa-bbbb-cccc-0000000000c1"
            for message in stream(text, sid, 16)[:-1]:
                if self.interrupted:
                    break
                yield message
                await asyncio.sleep(0.0005)
            if not self.interrupted:
                yield AssistantMessage(content=[TextBlock(text=text)], model="m")
            yield result(sid, error=self.interrupted)

    for n, queue, stops in ((10, True, 0), (30, True, 5), (30, False, 5), (200, True, 20)):
        LOGGED.records.clear()
        hub = make_hub(f"concurrent-{n}-{queue}", Claude)
        hub.prefs.queue_requests = queue
        await hub.start()
        window = hub.subscribe()
        events: list[dict[str, Any]] = []
        answers: dict[str, Any] = {}

        async def read(window: Any = window, events: list = events) -> None:
            while (event := await window.get()) is not None:
                events.append(event)

        async def from_window(i: int, hub: Any = hub) -> None:
            await hub.handle({"type": "ask", "text": f"w{i}"})

        async def from_phone(i: int, hub: Any = hub, answers: dict = answers) -> None:
            answers[f"p{i}"] = (await hub.remote_ask(f"p{i}", timeout=60))["reply"]

        async def from_chat(i: int, hub: Any = hub, answers: dict = answers) -> None:
            answers[f"c{i}"] = await hub.ask(
                f"c{i}", silent=True, note="this came from a chat", origin={"channel": "t"}
            )

        async def stopper(hub: Any = hub, stops: int = stops) -> None:
            for _ in range(stops):
                await asyncio.sleep(random.random() * 0.05)
                await hub.handle({"type": "stop"})

        reader = asyncio.create_task(read())
        random.seed(n)
        jobs = [random.choice([from_window, from_phone, from_chat])(i) for i in range(n)]
        with Ticker() as tick:
            await asyncio.gather(*jobs, stopper())
            for _ in range(3000):
                if not hub._lock.locked() and not hub.waiting:
                    break
                await asyncio.sleep(0.01)
        reader.cancel()
        turns: dict[str, str] = {}
        strays = 0
        for event in events:
            if event["type"] == "turn" and event.get("rid"):
                turns[event["rid"]] = event["user"]
            elif event["type"] == "reply" and event.get("text"):
                asker = turns.get(event.get("rid"), "")
                strays += bool(asker) and f"<{asker}>" not in event["text"]
        wrong = [k for k, reply in answers.items() if reply and f"<{k}>" not in reply]
        check(
            f"concurrent: {n} requests, queueing {'on' if queue else 'off'}, {stops} stops",
            not strays
            and not wrong
            and hub.state == "idle"
            and not hub.waiting
            and not hub._lock.locked()
            and not LOGGED.records,
            f"worst lag {tick.worst * 1000:.0f} ms, {strays} replies in another's turn, "
            f"{len(wrong)} wrong answers {LOGGED.said()}",
        )
        await hub.close()


async def incognito() -> None:
    from conftest import FakeClient

    main = "0f3c2d1e-aaaa-bbbb-cccc-0000000000aa"
    count = itertools.count(1)

    class Claude(FakeClient):
        async def query(self, text: str) -> None:
            self.asked = text

        async def receive_response(self) -> Any:
            secret = "no-session-persistence" in (self.options.extra_args or {})
            sid = f"incognito-{next(count)}" if secret else main
            await asyncio.sleep(0.001)
            yield AssistantMessage(content=[TextBlock(text="Okay.")], model="m")
            yield result(sid)

    for n in (20, 200):
        LOGGED.records.clear()
        hub = make_hub(f"incognito-{n}", Claude)
        fake_records(hub)
        await hub.start()
        await hub.ask("first, a normal request")
        random.seed(n)
        jobs = []
        for i in range(n):
            roll = random.random()
            if roll < 0.3:
                jobs.append(hub.handle({"type": "conversation_incognito", "on": roll < 0.15}))
            elif roll < 0.5:
                jobs.append(hub.ask(random.choice(["go incognito", "leave incognito"])))
            else:
                jobs.append(hub.ask(f"request {i}"))
        await asyncio.gather(*jobs)
        for _ in range(500):
            await asyncio.sleep(0.01)
            if not hub._lock.locked() and not hub.conversation._tasks:
                break
        await hub.ask("leave incognito")
        await hub.conversation.flush()
        kept = json.loads(hub.conversation.state.path.read_text())
        leaked = [s for s in kept["sessions"] if s.startswith("incognito")]
        check(
            f"incognito: {n} switches and requests at once",
            not leaked
            and kept["current"] == main
            and hub._session_id == main
            and not LOGGED.records,
            f"{len(leaked)} incognito sessions kept, current {kept['current'][-4:]} "
            f"{LOGGED.said()}",
        )
        await hub.close()


async def branch() -> None:
    from conftest import FakeClient, strip_note

    from jarvis import conversation_past as past

    records: dict[str, list[Any]] = {}
    ids = itertools.count(1)

    class Claude(FakeClient):
        """Keeps each session's record and forks it as Claude Code does."""

        def __init__(self, options: Any = None) -> None:
            super().__init__(options)
            self.sid = options.resume if options.resume and not options.fork_session else ""
            self.base: list[Any] = []
            if options.resume and options.fork_session:
                self.base = list(records.get(options.resume, []))
                uids = [m.uuid for m in self.base]
                if options.resume_session_at in uids:
                    self.base = self.base[: uids.index(options.resume_session_at) + 1]

        async def query(self, text: str) -> None:
            if not self.sid:
                self.sid = f"0f3c2d1e-aaaa-bbbb-cccc-{next(ids):012d}"
                records[self.sid] = list(self.base)
            said = strip_note(text)
            records[self.sid] += [
                SimpleNamespace(type="user", uuid=f"u{next(ids)}", message={"content": text}),
                SimpleNamespace(
                    type="assistant", uuid=f"a{next(ids)}", message={"content": f"On {said}"}
                ),
            ]

        async def receive_response(self) -> Any:
            yield AssistantMessage(content=[TextBlock(text="Answer.")], model="m")
            yield result(self.sid)

    LOGGED.records.clear()
    hub = make_hub("branch", Claude)
    fake_records(hub, records)
    convo = hub.conversation
    await hub.start()

    async def allow() -> None:
        while True:
            for card in list(hub.approvals):
                hub.resolve(card, "allow")
            await asyncio.sleep(0.001)

    answering = asyncio.create_task(allow())
    random.seed(3)
    count = 400
    with Ticker() as tick:
        for i in range(count):
            await hub.ask(f"request number {i} about topic{i % 7}")
            sid = hub._session_id
            asked = [
                e for e in past.entries(sid, get_messages=convo.get_messages) or [] if e.get("uuid")
            ]
            if not asked:
                continue
            pick, roll = random.choice(asked), random.random()
            if roll < 0.2:
                await hub.handle(
                    {"type": "conversation_rewind", "session_id": sid, "uuid": pick["uuid"]}
                )
            elif roll < 0.35:
                await hub.handle(
                    {
                        "type": "conversation_edit",
                        "session_id": sid,
                        "uuid": pick["uuid"],
                        "text": f"edited {i}",
                    }
                )
            elif roll < 0.45:
                uid = random.choice(["", pick["uuid"]])
                await hub.handle(
                    {"type": "conversation_fork", "session_id": sid, "uuid": uid, "live": True}
                )
            elif roll < 0.55:
                await hub.ask("try that differently")
            elif roll < 0.6:
                await hub.ask(f"go back to before I asked about topic{random.randrange(7)}")
            elif roll < 0.65:
                await hub.ask("branch from here")
            for _ in range(200):
                await asyncio.sleep(0.002)
                if not hub._lock.locked() and not convo._tasks:
                    break
    answering.cancel()
    related = sum(1 for e in convo.state.sessions.values() if e.get("parent"))
    check(
        f"branch: {count} requests with rewinds, forks, edits and tries again",
        not LOGGED.records and tick.over == 0,
        f"{len(records)} sessions, {related} with where they came from, worst lag "
        f"{tick.worst * 1000:.0f} ms {LOGGED.said()}",
    )
    await hub.close()


ODD_VALUES = [None, 0, -1, 1e308, float("nan"), True, "", " ", "x" * 5000, "\ud800", "../x", [], {}]
COMMANDS = {
    "conversation_state": [],
    "conversation_list": ["q", "seq"],
    "conversation_open": ["session_id", "live"],
    "conversation_resume": ["session_id"],
    "conversation_context": [],
    "conversation_compact": [],
    "conversation_thinking": ["level"],
    "conversation_incognito": ["on"],
    "conversation_rewind": ["session_id", "uuid"],
    "conversation_edit": ["session_id", "uuid", "text"],
    "conversation_fork": ["session_id", "uuid", "live"],
    "conversation_rename": ["session_id", "title"],
    "conversation_pin": ["session_id", "pinned"],
    "conversation_delete": ["session_id"],
    "conversation_marks": [],
    "chat_projects": [],
    "chat_project_save": ["id", "name", "instructions"],
    "chat_project_delete": ["id"],
    "chat_project_use": ["id"],
    "chat_project_file": ["id", "name", "text", "pdf"],
    "chat_project_unfile": ["id", "name"],
    "chat_project_assign": ["session_id", "id"],
    "personas_list": [],
    "persona_save": ["persona"],
    "persona_delete": ["id"],
    "feature_prefs": ["changes"],
    "heard_edit": ["original", "edited"],
    "unqueue": ["id"],
}


async def fuzz() -> None:
    LOGGED.records.clear()
    Claude = fake_claude()
    Claude.session = "0f3c2d1e-aaaa-bbbb-cccc-0000000000f1"
    hub = make_hub("fuzz", Claude)
    fake_records(hub, {Claude.session: []})
    # Claude Code's own rename and delete: fakes, never the real records.
    hub.conversation_manage.sdk = (lambda *_a: None, lambda *_a: None)
    await hub.start()
    await hub.ask("hello")

    async def answer() -> None:
        while True:
            for card in list(hub.approvals):
                hub.resolve(card, random.choice(["allow", "deny", "undo"]))
            await asyncio.sleep(0.002)

    answering = asyncio.create_task(answer())
    random.seed(7)
    for _ in range(1500):
        kind = random.choice(list(COMMANDS))
        msg: dict[str, Any] = {"type": kind}
        for key in COMMANDS[kind]:
            if random.random() < 0.8:
                msg[key] = random.choice(ODD_VALUES + [Claude.session])
        await hub.handle(msg)
    for _ in range(300):
        await asyncio.sleep(0.01)
        if not hub._lock.locked() and not hub.conversation._tasks:
            break
    answering.cancel()
    check("fuzz: 1,500 odd commands log no failure", not LOGGED.records, LOGGED.said())
    await hub.close()


async def quit_part() -> None:
    from conftest import FakeClient

    from jarvis.conversation_state import ConversationState

    sid = "0f3c2d1e-aaaa-bbbb-cccc-0000000000q1"

    class Claude(FakeClient):
        held: asyncio.Event | None = None

        async def query(self, text: str) -> None:
            self.asked = text

        async def receive_response(self) -> Any:
            events = stream("Your inbox has three new emails.", sid, 8)
            yield events[0]
            yield events[1]
            if type(self).held is not None:
                await type(self).held.wait()
            for message in events[2:]:
                yield message
            yield result(sid)

    hub = make_hub("quit-after", Claude)
    fake_records(hub)
    await hub.start()
    hub._note_read("private", "Read your inbox")
    await hub.ask("What's in my inbox?")
    await hub.close()
    kept = ConversationState(FOLDER / "quit-after" / "conversation.json")
    check(
        "quit: the turn that just ended is carried on after a restart",
        kept.current == sid and kept.reads_of(sid)["private"],
        f"current {kept.current!r}",
    )

    hub = make_hub("quit-mid", Claude)
    fake_records(hub)
    await hub.start()
    await hub.ask("Good morning")
    await hub.conversation.flush()
    Claude.held = asyncio.Event()
    hub._spawn(hub.ask("What's in my inbox?"))
    for _ in range(500):
        if hub.turn.get("reply"):
            break
        await asyncio.sleep(0.01)
    hub.note_tool_result("mcp__mac__read_mail")
    await hub.close()
    Claude.held = None
    again = make_hub("quit-mid", Claude)
    fake_records(again)
    await again.start()
    check(
        "quit: what a turn read before a quit mid-turn still counts after the restart",
        again._session_id == sid and again._gate_reads()["private"],
        f"carried on {again._session_id[-4:]!r}, private {again._gate_reads()['private']}",
    )
    await again.close()


# ── the run ──

PARTS: dict[str, Callable[[], Any]] = {
    "turns": turns,
    "unicode": unicode,
    "long": long,
    "concurrent": concurrent,
    "incognito": incognito,
    "branch": branch,
    "fuzz": fuzz,
    "quit": quit_part,
}


async def main(names: list[str]) -> int:
    guard()
    logging.basicConfig(level=logging.CRITICAL)
    logging.getLogger().addHandler(LOGGED)
    for name in names or list(PARTS):
        print(f"== {name}", flush=True)
        await PARTS[name]()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        code = asyncio.run(main(sys.argv[1:]))
    finally:  # after the loop: a feature's last save, as its task ends, lands before this
        shutil.rmtree(FOLDER, ignore_errors=True)
    sys.exit(code)
