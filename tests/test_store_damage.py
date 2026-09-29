"""Store files that are damaged, cut short, hand-edited or written by another build: no
store, no Hub() and no start() may fail over one; the damaged bytes are always kept; a torn
file costs at most the last change; and damaged settings never switch the microphone or
private indexing on."""

import json
import os
import random
from datetime import date
from pathlib import Path

import pytest
from conftest import FakeClient
from test_hub import Transcriber

from jarvis import prefs
from jarvis.connectors import Connection, ConnectorManager, MemoryVault
from jarvis.delegate import Delegation, DelegationStore
from jarvis.fileindex import FileIndex
from jarvis.goals import GoalStore
from jarvis.hub import Hub
from jarvis.interrupts import Interrupter
from jarvis.invoices import InvoiceStore
from jarvis.knowledge import KnowledgeBase
from jarvis.memory import MemoryStore
from jarvis.prefs import CAUTIOUS, Prefs, PrefsStore
from jarvis.providers import ProviderStore
from jarvis.remote import Devices
from jarvis.routines import RoutineStore
from jarvis.screenwatch import ScreenWatcher
from jarvis.tasks import RuleStore
from jarvis.transactions import TransactionLog, Transactions


@pytest.fixture(autouse=True)
def _no_real_app_support(tmp_path, monkeypatch):
    """Claude's workspace folder and anything else found through APP_SUPPORT at run time
    goes to the temp folder too, never the owner's Application Support."""
    monkeypatch.setattr(prefs, "APP_SUPPORT", tmp_path / "Application Support")


async def _deny(*_args):
    return "deny"


STORES = {
    "prefs.json": PrefsStore,
    "memory.json": MemoryStore,
    "routines.json": RoutineStore,
    "invoices.json": lambda p: InvoiceStore(p, p.parent / "Invoices"),
    "devices.json": Devices,
    "connections.json": lambda p: ConnectorManager(
        lambda *a, **k: None, _deny, vault=MemoryVault(), store=p
    ),
    "providers.json": lambda p: ProviderStore(p, MemoryVault()),
    "interrupts.json": lambda p: Interrupter(lambda _a: None, state_path=p, enabled=lambda: False),
    "delegations.json": DelegationStore,
    "transactions.json": TransactionLog,
    "permissions.json": RuleStore,
    "goals.json": GoalStore,
}

DEEP = b"[" * 5000 + b"]" * 5000  # parses, but nested far past anything real
KEYS = (
    "connections invoices sources notes delegations transactions providers models goals "
    "constraints priorities told hold mode hands_free address brain_folders"
).split()
BLOBS = {
    "null": b"null",
    "number": b"5",
    "true": b"true",
    "string": b'"x"',
    "list": b"[]",
    "object": b"{}",
    "list-of-numbers": b"[1, 2]",
    "infinity": b'{"a": Infinity, "humor": -Infinity}',
    "not-utf-8": b"\xff\xfe{",
    "a-stray-latin-1-byte": b'{"transactions": [], "note": "caf\xe9"}',
    "nested-100k": b"[" * 100_000 + b"]" * 100_000,
    "nested-a-million": b"[" * 1_000_000 + b"]" * 1_000_000,
    "wrong-shapes": json.dumps({k: 5 for k in KEYS}).encode(),
    "wrong-rows": json.dumps({k: [5, "x", None, [], {}] for k in KEYS}).encode(),
    "deep-values": b"{" + b", ".join(b'"%s": %s' % (k.encode(), DEEP) for k in KEYS) + b"}",
    "deep-rows": b"[" + b", ".join([DEEP, b'{"id": ' + DEEP + b', "text": ' + DEEP + b"}"]) + b"]",
    "a-number-past-floats": b'[{"id": "a", "text": "x", "amount": 1' + b"0" * 400 + b"}]",
    "cut-short": b'{"hands_free": fal',
    "empty": b"",
    "byte-order-mark": b"\xef\xbb\xbf{}",
}


@pytest.mark.parametrize("name", STORES)
@pytest.mark.parametrize("blob", BLOBS.values(), ids=BLOBS.keys())
def test_no_store_file_can_stop_the_app(tmp_path, name, blob):
    (tmp_path / name).write_bytes(blob)
    STORES[name](tmp_path / name)


@pytest.mark.parametrize("name", [n for n in STORES if n != "transactions.json"])
def test_a_damaged_file_is_kept_never_destroyed(tmp_path, name):
    path = tmp_path / name
    path.write_bytes(b'{"cut short by a crash": ')
    STORES[name](path)
    [kept] = [p for p in tmp_path.iterdir() if p.name.startswith(f"{name}.bad-")]
    assert kept.read_bytes() == b'{"cut short by a crash": ' and not path.exists()


def test_a_damaged_purchase_log_is_kept_and_stops_purchases(tmp_path):
    """The log keeps its own rule: unreadable means no purchases (never a reset day's
    total), and the damaged file is kept, never over an earlier damaged copy."""
    path = tmp_path / "transactions.json"
    for n, blob in enumerate(
        [
            b'{"transactions": [{"time": "2026-09-29T10:00:00", "kind": "purchase", '
            b'"amount": 1' + b"0" * 400 + b', "currency": "USD"}]}',  # too big for a float
            b'{"transactions": [], "merchant": "caf\xe9"}',  # a byte that isn't UTF-8
            b"[" * 100_000,
        ]
    ):
        path.write_bytes(blob)
        log = TransactionLog(path)
        assert log.damaged
        with pytest.raises(ValueError, match="can't be read"):
            log.spent_today("USD")
        log.record("purchase", "Shop", 5, "USD", "https://shop.example.com/checkout")
        kept = sorted(tmp_path.glob("transactions.damaged*.json"))
        assert len(kept) == n + 1 and blob in {k.read_bytes() for k in kept}
    assert TransactionLog(path).spent_today("USD") == 5


def _hub_stores(tmp_path, blob):
    """Every store Hub takes, each on a file holding the same damage."""
    for name in STORES:
        (tmp_path / name).write_bytes(blob)
    prefs = PrefsStore(tmp_path / "prefs.json")

    async def no_picture():
        return ""

    async def no_page():
        return {"error": "no browser in tests"}

    return {
        "prefs_store": prefs,
        "kb": KnowledgeBase(tmp_path / "brain" / "index.json"),
        "memory": MemoryStore(tmp_path / "memory.json"),
        "routines": RoutineStore(tmp_path / "routines.json"),
        "devices": Devices(tmp_path / "devices.json"),
        "invoice_store": InvoiceStore(tmp_path / "invoices.json", tmp_path / "Invoices"),
        "screen_watch": ScreenWatcher(capture=no_picture),
        "connectors": ConnectorManager(
            lambda *a, **k: None, _deny, vault=MemoryVault(), store=tmp_path / "connections.json"
        ),
        "providers": ProviderStore(tmp_path / "providers.json", MemoryVault()),
        "goal_store": GoalStore(tmp_path / "goals.json"),
        "delegation_store": DelegationStore(tmp_path / "delegations.json"),
        "file_index": FileIndex(tmp_path / "files.db", [], home=tmp_path),
        "transaction_desk": Transactions(
            no_page, _deny, lambda: prefs.prefs, log_path=tmp_path / "transactions.json"
        ),
        "interrupter": Interrupter(
            lambda _a: None, state_path=tmp_path / "interrupts.json", enabled=lambda: False
        ),
    }


@pytest.mark.parametrize(
    "blob", [BLOBS[k] for k in ("null", "list", "wrong-shapes", "wrong-rows", "deep-values")]
)
async def test_the_app_starts_whatever_its_files_hold(tmp_path, settings, quiet_speaker, blob):
    stores = _hub_stores(tmp_path, blob)
    stores["prefs_store"].prefs.hands_free = False  # never the real microphone in tests
    hub = Hub(
        settings,
        client_factory=FakeClient,
        speaker=quiet_speaker,
        transcriber=Transcriber(),
        poll=False,
        **stores,
    )
    await hub.start()
    hello = hub.snapshot()  # what a window gets when it connects
    assert hello["type"] == "hello"
    json.dumps(hello, default=str)
    await hub.close()


# ── damaged settings ──


def test_damaged_settings_never_switch_the_microphone_or_private_indexing_on(tmp_path):
    """1,000 random cuts, garbage writes and wrong-typed values of a settings file whose
    owner turned all of it off: none of it ever comes back on."""
    rng = random.Random(1)
    path = tmp_path / "prefs.json"
    store = PrefsStore(path)
    store.prefs.update({**{k: False for k in CAUTIOUS}, "humor": 20})
    store.save()  # one save: no last good copy yet, so every damage falls back to CAUTIOUS
    good = path.read_bytes()
    wrong = [b"null", b"[]"] + [
        json.dumps(dict.fromkeys(CAUTIOUS, value)).encode() for value in ("false", "yes", 1, None)
    ]
    for i in range(1000):
        kind = i % 3
        if kind == 0:
            blob = good[: rng.randrange(len(good))]
        elif kind == 1:
            blob = rng.randbytes(rng.randrange(1, 200))
        else:
            blob = rng.choice(wrong)
        path.write_bytes(blob)
        prefs = PrefsStore(path).prefs
        assert not any(getattr(prefs, k) for k in CAUTIOUS), (i, blob[:60])
        for spare in tmp_path.glob("prefs.json.bad-*"):
            spare.unlink()


def test_a_damaged_settings_file_comes_back_from_its_last_good_copy(tmp_path):
    path = tmp_path / "prefs.json"
    store = PrefsStore(path)
    store.prefs.update({"hands_free": False, "brain_mail": False, "persona": "tars", "humor": 20})
    store.save()
    store.prefs.update({"humor": 25})
    store.save()
    torn = path.read_bytes()[:50]
    path.write_bytes(torn)
    again = PrefsStore(path)
    p = again.prefs
    assert (p.hands_free, p.brain_mail, p.persona, p.humor) == (False, False, "tars", 20)
    assert "last good copy" in again.notice
    [kept] = tmp_path.glob("prefs.json.bad-*")
    assert kept.read_bytes() == torn


def test_a_settings_file_that_cant_be_read_is_never_saved_over(tmp_path):
    path = tmp_path / "prefs.json"
    path.write_text(json.dumps({"hands_free": True, "humor": 5}))
    os.chmod(path, 0)
    try:
        store = PrefsStore(path)
        assert store.prefs == Prefs(**CAUTIOUS) and "can't be read" in store.notice
        with pytest.raises(OSError, match="can't be read"):
            store.save()
    finally:
        os.chmod(path, 0o600)
    assert json.loads(path.read_text()) == {"hands_free": True, "humor": 5}


@pytest.mark.parametrize(
    "text",
    [
        '{"model": [], "hands_free": false}',
        '{"persona": {}, "hands_free": false}',
        '{"humor": Infinity, "hands_free": false}',
        '{"code_sentences": -Infinity, "hands_free": false}',
        '{"research_url": "http://[zz", "hands_free": false}',
        '{"brain_folders": ["~nosuchuser_zz/x", "/a\\u0000b", 5, [1]], "hands_free": false}',
        '{"watchlist": {"a": 1}, "pay_limit_day": [], "hands_free": false}',
        '{"address": ' + "[" * 5000 + "]" * 5000 + ', "hands_free": false}',
        '{"last_briefing": ["2026-09-29"], "hands_free": false}',
    ],
)
def test_one_bad_setting_is_left_out_and_the_rest_read(tmp_path, text):
    path = tmp_path / "prefs.json"
    path.write_text(text)
    store = PrefsStore(path)
    assert store.prefs.hands_free is False and not store.notice
    store.save()  # and it saves cleanly
    assert json.loads(path.read_text())["hands_free"] is False


def test_a_brain_folder_it_cant_look_at_is_kept_and_startup_goes_on(tmp_path, monkeypatch):
    """macOS privacy protection can deny a saved folder later: Path.is_dir() then raises
    (EACCES/EPERM) instead of saying no."""
    monkeypatch.setenv("HOME", str(tmp_path))
    folder = tmp_path / "Documents" / "Clients"
    folder.mkdir(parents=True)
    want = str(folder.resolve())
    path = tmp_path / "prefs.json"
    path.write_text(json.dumps({"brain_folders": [str(folder)]}))
    os.chmod(folder.parent, 0)
    try:
        prefs = PrefsStore(path).prefs
    finally:
        os.chmod(folder.parent, 0o755)
    assert prefs.brain_folders == [want]


def test_a_hundred_megabytes_of_junk_opens_as_cautious_settings(tmp_path):
    path = tmp_path / "prefs.json"
    path.write_bytes(b"\x00" * 100_000_000)
    assert PrefsStore(path).prefs == Prefs(**CAUTIOUS)


# ── a torn file costs at most the last change ──


def _connection(i):
    return Connection(f"c{i}", f"Service {i}", "http", url=f"https://s{i}.example.com/mcp")


class Kinds:
    """For each store: make it, make one change (numbered), and count what it holds."""

    memory = (
        MemoryStore,
        lambda s, i: s.add(f"Fact {i} about topic{i} zq{i}"),
        lambda s: len(s.facts),
    )
    routines = (
        RoutineStore,
        lambda s, i: s.add(f"Routine {i}", f"Brief me {i}", "daily", "15:00"),
        lambda s: len(s.items),
    )
    invoices = (
        lambda p: InvoiceStore(p, p.parent / "Invoices"),
        lambda s, i: s.create(
            "Acme", [{"description": "Work", "unit_price": i + 1}], today=date(2026, 9, 29)
        ),
        lambda s: len(s.invoices),
    )
    devices = (
        Devices,
        lambda s, i: s.pair(s.start_pairing(), f"Phone {i}"),
        lambda s: len(s.items),
    )
    connections = (
        lambda p: ConnectorManager(lambda *a, **k: None, _deny, vault=MemoryVault(), store=p),
        lambda s, i: (s.connections.__setitem__(f"c{i}", _connection(i)), s._save()),
        lambda s: len(s.connections),
    )
    delegations = (
        DelegationStore,
        lambda s, i: (
            s.add(Delegation(f"d{i}", "Sam", f"+1415555{i:04d}", "imessage", "Lunch")),
            s.save(),
        ),
        lambda s: len(s.items),
    )
    rules = (RuleStore, lambda s, i: s.add(Path(f"/project{i}"), "ls"), lambda s: len(s.rules))
    goals = (GoalStore, lambda s, i: s.set_goal(f"Run a race number {i}"), lambda s: len(s.goals))
    interrupts = (
        lambda p: Interrupter(lambda _a: None, state_path=p, enabled=lambda: False),
        lambda s, i: (s._tell(f"message:{i}"), s._save()),
        lambda s: len(s._told),
    )
    prefs = (
        PrefsStore,
        lambda s, i: (s.prefs.update({"humor": 10 + i}), s.save()),
        lambda s: {11: 1, 12: 2}.get(s.prefs.humor, 0),
    )


@pytest.mark.parametrize("kind", [k for k in vars(Kinds) if not k.startswith("_")])
def test_a_torn_file_costs_at_most_the_last_change(tmp_path, kind):
    """1,000 random cuts and garbage writes of a store saved twice: the first change is
    always there, and every damaged file is kept byte for byte."""
    make, change, count = getattr(Kinds, kind)
    path = tmp_path / "store.json"
    store = make(path)
    change(store, 1)
    change(store, 2)
    assert count(make(path)) == 2
    whole = path.read_bytes()
    rng = random.Random(kind)
    for i in range(1000):
        if i % 2:
            blob = whole[: rng.randrange(len(whole))]
        else:
            blob = rng.randbytes(rng.randrange(1, 64))
        path.write_bytes(blob)
        held = count(make(path))
        kept = list(tmp_path.glob("store.json.bad-*"))
        assert held >= 1, (i, blob[:40])  # at most the last change is lost
        if held == 1 and blob.strip():
            assert [k.read_bytes() for k in kept] == [blob]
        for spare in kept:
            spare.unlink()
