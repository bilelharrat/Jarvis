"""Stress what JARVIS knows, remembers and does on its own: the second brain, memory,
automation and the proactive parts. Nothing here reaches the network, a real model, the
real calendar, Mail, Messages, Reminders or Photos, or the owner's own data folder: every
store lives in a temp folder, and the helpers that could reach the Mac are replaced the
way tests/conftest.py replaces them.

    uv run python scripts/stress_knowledge.py            # every part
    uv run python scripts/stress_knowledge.py damaged    # one of them

Parts:
- damaged: every store of these features written once by its own code, then truncated,
  emptied, binary, nested past reason, of the other top-level type, hand-edited with
  wrong-typed rows and fields, times given a zone, numbers made enormous; a hub is made
  on each and its loops' looks, states and tools are run. Nothing may raise, and nothing
  may be logged as a failure the loop carries on from (it would fail every look).
- time: midnight, both DST changes (America/Los_Angeles) and a Mac asleep for hours: a
  countdown counts real time, routines run once per time on the wall, a monthly routine
  on the 31st keeps to February, and what was due while asleep is said once.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import sys
import tempfile
import time
import traceback
from collections.abc import Callable
from dataclasses import replace
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}", flush=True)
    return ok


# ── the guards: nothing real, ever ──


def guard() -> None:
    """What tests/conftest.py fakes, faked here for the whole run."""
    from jarvis import (
        calendar_kit,
        code_ai,
        jsonstore,
        maps,
        phone,
        reminders_desk,
        system_voice,
        utility_model,
    )

    async def refuse(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("the stress run reached a real model")

    async def nothing(*_a: Any, **_k: Any) -> Any:
        return None

    async def no_calendar(*_a: Any, **_k: Any) -> dict[str, Any]:
        return {"error": "no calendar in the stress run"}

    async def not_here(*_a: Any, **_k: Any) -> dict[str, Any]:
        return {"error": "not reachable in the stress run"}

    code_ai.complete = refuse
    utility_model.run_turn = refuse
    system_voice.carry_out = nothing
    calendar_kit.fetch = no_calendar
    reminders_desk._run = not_here
    maps.run_helper = not_here
    jsonstore._sync = os.fsync  # the drive-cache flush only slows a temp folder down
    from jarvis import features

    features.modules()  # their settings registered before any prefs.json is read, as in the app

    class Memory:
        def __init__(self) -> None:
            self.items: dict[tuple[str, str], str] = {}

        def get_password(self, service: str, user: str) -> str | None:
            return self.items.get((service, user))

        def set_password(self, service: str, user: str, secret: str) -> None:
            self.items[(service, user)] = secret

        def delete_password(self, service: str, user: str) -> None:
            self.items.pop((service, user), None)

    real = phone.Keychain.__init__

    def init(self: Any, backend: Any = None) -> None:
        real(self, backend if backend is not None else Memory())

    phone.Keychain.__init__ = init  # type: ignore[method-assign]


def silent_speaker() -> Any:
    from jarvis.speech import Speaker

    speaker = Speaker.__new__(Speaker)
    speaker.voice, speaker.rate, speaker.muted, speaker._procs = "", 190, True, set()
    speaker.effect, speaker.cloud, speaker.cloud_error, speaker._playing = False, None, "", False
    speaker._player = None
    speaker.player_path, speaker._live, speaker._live_lock = None, None, None
    return speaker


def make_hub(folder: Path) -> Any:
    """A hub on its own temp folder, as tests make theirs (conftest's isolated stores)."""
    from conftest import FakeClient

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

    async def never_asked(*_a: Any) -> str:
        return "deny"

    async def no_picture() -> str:
        return ""

    async def no_page() -> dict[str, Any]:
        return {"error": "no browser here"}

    store = PrefsStore(folder / "prefs.json")
    store.prefs.hands_free = False
    hub = Hub(
        replace(Settings(), bsh_dir=None, projects_dir=folder),
        client_factory=FakeClient,
        speaker=silent_speaker(),
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
    automation = parts(hub)["automation"]
    automation.timers.play = lambda _sound: None  # never a real sound
    automation.files_dir = folder / "Automations"
    return hub


def parts(hub: Any) -> dict[str, Any]:
    from jarvis.features import automation, brain, proactive
    from jarvis.features import memory as memory_feature

    desk = memory_feature.desk_for(hub)
    return {
        "automation": automation._FEATURES[hub],
        "memory": desk,
        "proactive": proactive.feature_of(hub),
        "brain": brain,
    }


class FakeAI:
    """The memory desk's model calls: counted, answered with nothing."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def __call__(self, prompt: str, *, kind: str, system: str) -> str:
        self.calls.append(kind)
        return "{}"


def drain(q: asyncio.Queue) -> list[dict[str, Any]]:
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


# ── damaged stores ──

NOW = datetime(2026, 9, 30, 10, 0)


async def seed(folder: Path) -> dict[str, bytes]:
    """Every store of these features written once by its own code, as the app writes it:
    the good copies the damage is done to."""
    from jarvis import jobs, memory_ai, timers

    hub = make_hub(folder)
    p = parts(hub)
    auto, desk = p["automation"], p["memory"]
    desk.ai = FakeAI()
    hub.memory.add("My dog is called Biscuit", source="said", origin="the owner said so")
    hub.routines.add("Brief", "brief me", "daily", "07:00")
    hub.routines.add("Tidy", "tidy up", "interval", "", spec={"every": 30, "start": "09:00"})
    hub.routines.add(
        "Mail rule",
        "tell me",
        "event",
        "",
        spec={"trigger": {"type": "mail", "from": "ann@example.com"}},
    )
    auto.timers.add(timers.new_timer(600, "pasta", NOW))
    auto.timers.add(timers.new_alarm("06:30", "wake", NOW))
    auto.timers.add(timers.new_reminder("stretch", NOW, every_minutes=20, until="18:00"))
    routine = hub.routines.items[0]
    run = jobs.Run(NOW.isoformat(timespec="seconds"), "schedule", output="done")
    auto.history.add(routine.id, run)
    auto.engine._allowed(hub.routines.items[2], NOW)
    auto.engine.save()
    await auto.webhooks.add("build", note="tell me if it failed")
    auto.webhooks._note(auto.webhooks.hooks[0], "accepted", 12)
    auto.heartbeat.state["day"] = NOW.date().isoformat()
    auto.heartbeat.state["count"] = 3
    auto.heartbeat.state["told"] = [[NOW.isoformat(timespec="seconds"), "The build broke."]]
    auto.heartbeat._note(NOW, "said", "The build broke.")
    auto.scripts.state["allowed"]["heads-up/say.sh"] = "0" * 64
    auto.scripts.state["runs"].append({"at": NOW.isoformat(), "script": "say.sh", "ok": True})
    auto.scripts._save()
    desk.about.set(about="I live in Oakland.")
    desk.inbox.offer(
        [
            {
                "text": "Prefers tea",
                "category": "preferences",
                "confidence": "medium",
                "quote": "I like tea",
            }
        ],
        [],
        batch="talk:2026-09-30T09:00",
    )
    desk.daylog.request("what's the weather")
    desk.daylog.write(desk.daylog.payload())
    intent = desk.intents.add("an email from Ann arrives", "remind me the deck", people=["Ann"])
    desk.intents.fired(intent, NOW - timedelta(hours=1))
    desk.promises.add("Send Ann the deck", to="Ann", due="2026-10-02", today=NOW.date())
    budget = memory_ai.Budget(folder / "memory_ai_usage.json")
    budget.take("dream")
    journal_store = desk.journal
    journal_store.write(NOW.date().isoformat(), "# A day\n\nIt rained.\n", False)
    journal_store.dreamt = [NOW.date().isoformat()]
    journal_store.save()
    pro = p["proactive"]
    pro.weather._said_keys()["nws:alert-1"] = NOW.isoformat(timespec="minutes")
    pro.weather._save(NOW)
    pro.clashes._seen_keys()["invite:abc"] = NOW.isoformat(timespec="minutes")
    pro.clashes._save(NOW)
    hub.suggester.note_request("what's the weather")
    hub.kb.build({"notes": [_note(i) for i in range(20)]})
    hub.kb.save()
    hub.set_feature_prefs(
        {
            "quiet_weekend": "23:00-09:00",
            "heartbeat_on": True,
            "heartbeat_hours": "08:00-20:00",
            "heartbeat_checklist": "the Acme contract",
            "memory_journal_time": "21:30",
            "memory_commitments": True,
            "wrapup_on": True,
            "briefing_topics": ["AI"],
        }
    )
    files = {}
    for path in sorted(folder.rglob("*")):
        if path.is_file() and not path.name.endswith(".bak") and ".bad-" not in path.name:
            files[str(path.relative_to(folder))] = path.read_bytes()
    return files


# The stores this sweep owns, and one hand-edit of each that keeps the file's shape but
# puts a wrong type where each field goes (the rows a person with a text editor makes).
DOMAIN_STORES = (
    "memory.json",
    "routines.json",
    "timers.json",
    "automation_runs.json",
    "automation_triggers.json",
    "webhooks.json",
    "heartbeat.json",
    "hooks.json",
    "about_me.json",
    "memory_suggestions.json",
    "journal_log.json",
    "journal_state.json",
    "intents.json",
    "commitments.json",
    "memory_ai_usage.json",
    "suggestions.json",
    "weather_watch.json",
    "clashes.json",
    "brain/index.json",
    "prefs.json",
)
ODD = [None, 7, -1, 1e308, True, "", "x" * 5000, [], {}, [1, "a", None], {"a": [1, {"b": 2}]}]


def wrong_rows(data: Any, pick: int, depth: int = 0) -> Any:
    """The same shape with each value swapped for a wrong one (pick chooses which); lists
    inside keep their length (a pair stays a pair), the file's own list gets a row more."""
    if isinstance(data, dict):
        return {k: wrong_rows(v, pick + i, depth + 1) for i, (k, v) in enumerate(data.items())}
    if isinstance(data, list):
        if not data:
            return [ODD[pick % len(ODD)], ODD[(pick + 3) % len(ODD)]]
        rows = [wrong_rows(v, pick + i, depth + 1) for i, v in enumerate(data)]
        return rows + [ODD[pick % len(ODD)]] if depth == 0 else rows
    return ODD[pick % len(ODD)]


def wrong_top(data: Any, pick: int) -> Any:
    """Only the fields one level down swapped (the file's own type kept)."""
    if isinstance(data, dict):
        return {k: ODD[(pick + i) % len(ODD)] for i, k in enumerate(data)}
    if isinstance(data, list):
        return [ODD[(pick + i) % len(ODD)] for i in range(max(3, len(data)))]
    return data


OTHER = [7, "x", None, [1, "a"], {"a": 1}, 1e308, True, -3]


def _other(value: Any, pick: int) -> Any:
    """A value of another type than this one."""
    for choice in OTHER[pick % len(OTHER) :] + OTHER:
        if type(choice) is not type(value):
            return choice
    return None


def cells(data: Any, pick: int) -> Any:
    """Each row's fields (a dict inside the file's list, or inside one of its fields) given
    a value of another type: a list where a number goes, a number where a list goes."""

    def row(value: Any, n: int) -> Any:
        if isinstance(value, dict):
            return {k: _other(v, n + i) for i, (k, v) in enumerate(value.items())}
        return value

    if isinstance(data, list):
        return [row(v, pick + i) for i, v in enumerate(data)]
    if isinstance(data, dict):
        out = {}
        for i, (k, v) in enumerate(data.items()):
            if isinstance(v, list):
                out[k] = [row(r, pick + i + j) for j, r in enumerate(v)]
            elif isinstance(v, dict):
                out[k] = {kk: row(vv, pick + i + j) for j, (kk, vv) in enumerate(v.items())}
            else:
                out[k] = v
        return out
    return data


_STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$")


def reshaped(data: Any, how: str) -> Any:
    """Every time given a zone ("zoned": another build's, or a hand edit's), or every number
    made enormous ("huge")."""
    if isinstance(data, dict):
        return {k: reshaped(v, how) for k, v in data.items()}
    if isinstance(data, list):
        return [reshaped(v, how) for v in data]
    if how == "zoned" and isinstance(data, str) and _STAMP.match(data):
        return data + "Z"
    if how == "huge" and isinstance(data, int) and not isinstance(data, bool):
        return 10**14
    if how == "huge" and isinstance(data, float):
        return 1e308
    if how == "huge" and isinstance(data, str) and data.isdigit():
        return "1e999"
    return data


def damages(good: bytes) -> dict[str, bytes]:
    try:
        data = json.loads(good)
    except ValueError:
        data = None
    out = {
        "truncated": good[: max(1, len(good) // 2)],
        "empty": b"",
        "binary": bytes(range(256)) * 4,
        "nested": b"[" * 100_000 + b"]" * 100_000,
        "wrong-type": b'"just a string"' if isinstance(data, dict | list) else b"[]",
        "other-container": b"{}" if isinstance(data, list) else b"[]",
    }
    if isinstance(data, dict) and isinstance(data.get("features"), dict):  # prefs.json
        for pick in (0, 1, 4, 7):
            features = wrong_top(data["features"], pick)
            out[f"features-{pick}"] = json.dumps({**data, "features": features}).encode()
    elif data is not None:
        for pick in (0, 1, 4, 7):
            out[f"rows-{pick}"] = json.dumps(wrong_rows(data, pick)).encode()
            out[f"fields-{pick}"] = json.dumps(wrong_top(data, pick)).encode()
            out[f"cells-{pick}"] = json.dumps(cells(data, pick)).encode()
    if data is not None:
        for how in ("zoned", "huge"):
            out[how] = json.dumps(reshaped(data, how)).encode()
    return out


async def exercise(hub: Any, now: datetime) -> list[str]:
    """What startup and the loops' first looks do with the stores, and every window state:
    each step on its own, so one failure doesn't hide the next. What raised, by step."""
    from jarvis.features import brain as brain_feature

    p = parts(hub)
    auto, desk, pro = p["automation"], p["memory"], p["proactive"]
    desk.ai = FakeAI()
    failed: list[str] = []
    swallowed = Swallowed()

    async def step(name: str, fn: Callable[[], Any]) -> None:
        swallowed.records.clear()
        try:
            result = fn()
            if asyncio.iscoroutine(result):
                await asyncio.wait_for(result, 30)
        except Exception as exc:
            failed.append(f"{name}: {type(exc).__name__}: {str(exc)[:160]}")
            if os.environ.get("STRESS_TRACE"):
                traceback.print_exc()
        # A failure the loop logs and carries on from still fails every look: counted too.
        failed.extend(f"{name}: logged {line}" for line in swallowed.records)

    await step("kb.load", hub.kb.load)
    await step("kb.search", lambda: hub.kb.search("biscuit rain", 6))
    await step("kb.galaxy", hub.kb.galaxy)
    await step("brain.state", lambda: brain_feature.SemanticControl(hub).payload())
    await step("memory.prompt", hub.memory.prompt_block)
    await step("memory.sweep", lambda: hub.memory.sweep(now.date()))
    await step("routines.public", hub.routines.public)
    await step("routines.take_due", lambda: hub.routines.take_due(now))
    await step("automation.state", auto.state)
    await step("timers.fire_due", lambda: auto.timers.fire_due(now + timedelta(days=2)))
    await step("timers.describe", auto.timers.describe)
    await step("triggers.tick", lambda: auto.engine.tick(now))
    await step("heartbeat.public", auto.heartbeat.public)
    await step("heartbeat.prompt", lambda: auto.heartbeat.prompt(_state(), now))
    await step("heartbeat.blocked", lambda: auto.heartbeat.blocked(now))
    await step("webhooks.public", auto.webhooks.public)
    await step("scripts.public", auto.scripts.public)
    await step("history.last", lambda: [auto.history.last(r.id) for r in hub.routines.items])
    await step("memory.state", desk.state)
    await step("memory.prompt_note", desk.prompt)
    await step("memory.briefing", desk.briefing_note)
    await step("memory.tick", lambda: desk.tick(now))
    await step("memory.tick.night", lambda: desk.tick(now.replace(hour=22)))
    await step("memory.tick.morning", lambda: desk.tick(now + timedelta(days=1, hours=-1)))
    arrival = {"kind": "mail", "who": "Ann", "text": "the deck", "key": "mail:1"}
    await step("memory.arrival", lambda: desk.arrival(arrival))
    await step("memory.promises.eve", lambda: desk.remind_promises(now.replace(hour=18, minute=30)))
    await step(
        "memory.promises.eve2",
        lambda: desk.remind_promises((now + timedelta(days=1)).replace(hour=18, minute=30)),
    )
    await step("memory.promises.due", lambda: desk.remind_promises(now + timedelta(days=2)))
    mail = SimpleNamespace(
        source="mail", handle="ann@example.com", contact="Ann", name="Ann", text="Deck",
        preview="", group=None,
    )  # fmt: skip
    await step("triggers.mail", lambda: auto.engine.on_messages([mail]))
    await step("triggers.tick.mail", lambda: auto.engine.tick(now + timedelta(minutes=1)))
    await step("proactive.state", pro.state)
    await step("briefing.request", hub.briefing_request)
    await step("weather.load", pro.weather._said_keys)
    await step("clashes.load", pro.clashes._seen_keys)
    await step("suggester.tick", hub.suggester.tick)
    await step("quiet.now", hub.quiet_now)
    swallowed.close()
    return failed


class Swallowed(logging.Handler):
    """Exceptions the app logs and carries on from (a loop's look that failed)."""

    def __init__(self) -> None:
        super().__init__(logging.ERROR)
        self.records: list[str] = []
        logger = logging.getLogger("jarvis")
        self._was = (logger.level, logger.propagate)
        logger.setLevel(logging.ERROR)  # heard here, and not printed
        logger.propagate = False
        logger.addHandler(self)

    def emit(self, record: logging.LogRecord) -> None:
        if record.exc_info and record.exc_info[1] is not None:
            exc = record.exc_info[1]
            self.records.append(f"{record.getMessage()[:60]} ({type(exc).__name__}: {exc!s:.80})")

    def close(self) -> None:
        logger = logging.getLogger("jarvis")
        logger.removeHandler(self)
        logger.level, logger.propagate = self._was
        super().close()


def _note(i: int, words: str = "") -> Any:
    from jarvis.knowledge import Note

    day = (NOW - timedelta(days=i % 400)).isoformat(timespec="seconds")
    text = words or f"Note {i} about the garden, the rain in Oakland and a dog called Biscuit."
    return Note(f"n{i}", "notes", f"Note {i}", text, f"ref{i}", modified=day)


def _state() -> dict[str, Any]:
    return {"checklist": "", "events": [], "waiting": [], "sessions": [], "cards": [], "timers": []}


async def damaged() -> None:
    root = Path(tempfile.mkdtemp(prefix="stress-knowledge-"))
    try:
        good = await seed(root / "seed")
        missing = [s for s in DOMAIN_STORES if s not in good]
        check("every store was written by its own code", not missing, f"missing {missing}")
        base_failures = await exercise(make_hub(_copy(good, root / "base")), NOW)
        check("the good copies load cleanly", not base_failures, "; ".join(base_failures))
        runs, crashed = 0, []
        started = time.monotonic()
        for store in DOMAIN_STORES:
            if store not in good:
                continue
            for how, content in damages(good[store]).items():
                runs += 1
                folder = _copy(good, root / f"d{runs}", {store: content})
                try:
                    hub = make_hub(folder)
                except Exception as exc:
                    crashed.append(f"{store} {how}: the hub didn't start ({exc!r})")
                    continue
                for failure in await exercise(hub, NOW):
                    crashed.append(f"{store} {how}: {failure}")
                shutil.rmtree(folder, ignore_errors=True)
        took = time.monotonic() - started
        check(
            f"{runs} damaged stores: startup and every loop's look never raise",
            not crashed,
            f"{took:.1f}s",
        )
        for line in crashed:
            print("      " + line)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _copy(files: dict[str, bytes], folder: Path, changes: dict[str, bytes] | None = None) -> Path:
    for rel, content in {**files, **(changes or {})}.items():
        path = folder / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return folder


# ── time: midnight, DST both ways, a Mac asleep for hours ──

FALL_BACK = datetime(2026, 11, 1)  # 2:00 PDT becomes 1:00 PST (America/Los_Angeles)
SPRING_FORWARD = datetime(2026, 3, 8)  # 2:00 PST becomes 3:00 PDT


class Wall:
    """This Mac's wall clock as the app reads it (datetime.now(): naive, local), driven by a
    real instant, so the hour that repeats and the hour that's skipped happen as they do."""

    def __init__(self, start: datetime) -> None:
        self.epoch = start.timestamp()

    def __call__(self) -> datetime:
        return datetime.fromtimestamp(self.epoch)

    def step(self, seconds: float) -> datetime:
        self.epoch += seconds
        return self()


def countdown(start: datetime, seconds: int, *, step: float = 30.0) -> float:
    """A timer set at start (the wall clock's first pass of that time): how many real
    seconds pass before it goes off (the timers' own clock, looked at every step)."""
    from jarvis import timers

    folder = Path(tempfile.mkdtemp(prefix="stress-timers-"))
    wall = Wall(start)
    rang: list[float] = []
    clock = timers.Timers(
        folder / "timers.json", lambda _alert, _busy: rang.append(wall.epoch), now=wall
    )
    clock.play = lambda _sound: None
    begun = wall.epoch
    clock.add(timers.new_timer(seconds, "tea", wall()))
    for _ in range(int(4 * 3600 / step)):
        clock.fire_due(wall.step(step))
        if rang:
            break
    shutil.rmtree(folder, ignore_errors=True)
    return (rang[0] - begun) if rang else float("inf")


def routine_runs(kind: str, start: datetime, hours: float, **fields: Any) -> list[datetime]:
    """A routine's runs as the routine clock (every 30 s) would start them."""
    from jarvis.routines import RoutineStore

    folder = Path(tempfile.mkdtemp(prefix="stress-routines-"))
    store = RoutineStore(folder / "routines.json")
    wall = Wall(start)
    routine = store.add(
        "Check",
        "check the build",
        kind,
        fields.pop("time", "00:00"),
        spec=fields.pop("spec", None),
        **fields,
    )
    routine.last_run = ""
    ran = []
    for _ in range(int(hours * 3600 / 30)):
        now = wall.step(30)
        if store.take_due(now):
            ran.append(now)
    shutil.rmtree(folder, ignore_errors=True)
    return ran


async def time_part() -> None:
    os.environ["TZ"] = "America/Los_Angeles"
    time.tzset()
    # Timers count real time: a 30-minute timer is 30 minutes, whatever the wall clock does.
    for name, start in (
        ("an ordinary night", datetime(2026, 10, 20, 1, 50)),
        ("midnight", datetime(2026, 10, 20, 23, 50)),
        ("the night the clocks go back", FALL_BACK.replace(hour=1, minute=50)),
        ("the night the clocks go forward", SPRING_FORWARD.replace(hour=1, minute=50)),
    ):
        took = countdown(start, 1800)
        check(
            f"a 30-minute timer set at 1:50/23:50 on {name} rings after 30 minutes",
            abs(took - 1800) <= 30,
            f"rang after {took / 60:.1f} real minutes",
        )
    # Routines run on the wall clock: once a day at 1:30, even when 1:30 comes twice.
    for name, start in (
        ("the night the clocks go back", FALL_BACK),
        ("the night the clocks go forward", SPRING_FORWARD),
    ):
        ran = routine_runs("daily", start, 6, time="01:30")
        check(f"a 1:30 daily routine runs once on {name}", len(ran) == 1, f"{len(ran)} runs")
        ran = routine_runs("daily", start, 6, time="02:30")
        check(
            f"a 2:30 daily routine runs once on {name}",
            len(ran) == 1,
            f"{len(ran)} runs at {[f'{r:%H:%M}' for r in ran]}",
        )
        ran = routine_runs("interval", start - timedelta(hours=1), 8, spec={"every": 30})
        gaps = [(b.timestamp() - a.timestamp()) / 60 for a, b in zip(ran, ran[1:], strict=False)]
        check(
            f"an every-30-minutes routine never runs twice at once on {name}",
            bool(gaps) and min(gaps) >= 29,
            f"{len(ran)} runs in 8 real hours, gaps {min(gaps or [0]):.0f}-{max(gaps or [0]):.0f} min",
        )
    ran = routine_runs("monthly", datetime(2026, 2, 27), 72, time="09:00", spec={"day": 31})
    check(
        "a monthly routine on the 31st runs on the last day of February",
        [r.date() for r in ran] == [date(2026, 2, 28)],
        f"{[str(r) for r in ran]}",
    )
    # A Mac asleep for five hours: what was due while it slept.
    from jarvis import timers

    folder = Path(tempfile.mkdtemp(prefix="stress-sleep-"))
    wall = Wall(datetime(2026, 10, 20, 6, 0))
    said: list[Any] = []
    clock = timers.Timers(
        folder / "timers.json", lambda alert, busy: said.append((alert, busy)), now=wall
    )
    clock.play = lambda _sound: None
    clock.add(timers.new_alarm("06:30", "wake", wall()))
    clock.add(timers.new_timer(600, "pasta", wall()))
    clock.add(timers.new_reminder("stretch", wall(), every_minutes=20))
    wall.step(5 * 3600)  # asleep
    clock.fire_due(wall())
    kinds = sorted((a.kind, getattr(a, "breakthrough", False)) for a, _busy in said)
    check(
        "a Mac asleep five hours: missed ones are said once, never rung, a reminder moves on",
        kinds == [("alarm", False), ("timer", False)]
        and all(t.kind == "reminder" and t.due_at > wall() for t in clock.store.items),
        f"said {kinds}, left {[(t.kind, f'{t.due_at:%H:%M}') for t in clock.store.items]}",
    )
    shutil.rmtree(folder, ignore_errors=True)
    del os.environ["TZ"]
    time.tzset()


# ── the run ──

PARTS: dict[str, Callable[[], Any]] = {
    "damaged": damaged,
    "time": time_part,
}


async def main(names: list[str]) -> int:
    guard()
    logging.basicConfig(level=logging.CRITICAL)  # damaged files are logged, by design
    for name in names or list(PARTS):
        print(f"== {name}", flush=True)
        await PARTS[name]()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
