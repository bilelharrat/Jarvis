"""Sync with the owner's iPhone through their Jarvis account (jarvis.account_sync): the key
checked first, memory merged both ways (ids mapped, provenance kept, deletions as
tombstones), a write that crossed another device's merged and tried again, the settings,
and the phone's chats left alone. askeden.com is account_fakes.FakeAskeden (in memory),
memory and prefs live in a temp folder, the Keychain is a MemoryVault."""

import asyncio
import uuid

import pytest
from account_fakes import TOKEN, FakeAskeden, fact, sync_key

from jarvis import account_sync
from jarvis.account import Account
from jarvis.account_sync import KEYCHECK, Sync, wire_id
from jarvis.connectors import MemoryVault
from jarvis.memory import MemoryStore
from jarvis.prefs import PrefsStore

NOW = 1_800_000_000_000


class World:
    def __init__(self, tmp_path, key=None, phone_key=None):
        self.key = key or sync_key()
        self.fake = FakeAskeden(sync_key=phone_key or self.key)
        self.account = Account(MemoryVault(), transport=self.fake.transport)
        self.memory = MemoryStore(tmp_path / "memory.json")
        self.prefs = PrefsStore(tmp_path / "prefs.json").prefs
        self.now = NOW
        self.changed = 0
        self.sync = Sync(
            self.account,
            lambda: self.memory,
            lambda: self.prefs,
            self.prefs.update,
            tmp_path / "account-sync.json",
            now_ms=lambda: self.now,
            on_change=self._changed,
        )

    def _changed(self):
        self.changed += 1

    async def link(self):
        await self.account._keep(TOKEN, self.key)

    def phone_memory(self):
        doc = self.fake.phone_read("memory")
        return {f["id"]: f for f in doc["facts"]} if doc else {}

    def puts(self):
        return [c for c in self.fake.calls if c[0] == "PUT"]


@pytest.fixture
async def world(tmp_path):
    made = World(tmp_path)
    await made.link()
    yield made
    await made.account.aclose()


def keycheck(world):
    world.fake.phone_put("keycheck", KEYCHECK)


# ── the key ──


async def test_without_a_keycheck_it_waits_and_writes_nothing(world):
    world.memory.add("Ann Lee is my co-founder")
    result = await world.sync.sync()
    assert result["state"] == "waiting" and "turn sync on" in result["error"]
    assert world.puts() == []


async def test_a_key_that_doesnt_open_the_keycheck_overwrites_nothing(tmp_path):
    made = World(tmp_path, phone_key=sync_key())  # the phone made a new key since
    await made.link()
    made.fake.phone_put("keycheck", KEYCHECK)
    made.fake.phone_put("memory", {"v": 1, "facts": []})
    made.memory.add("I take my coffee black")
    result = await made.sync.sync()
    assert result["state"] == "wrong_key" and "Nothing was overwritten" in result["error"]
    assert made.puts() == []
    await made.account.aclose()


async def test_without_a_sync_key_nothing_is_asked(tmp_path):
    made = World(tmp_path)
    await made.account._keep(TOKEN, None)
    result = await made.sync.sync()
    assert result["state"] == "no_key" and made.fake.calls == []
    await made.account.aclose()


async def test_not_linked_it_stays_off(tmp_path):
    made = World(tmp_path)
    assert (await made.sync.sync())["state"] == "off"


# ── memory ──


async def test_facts_go_both_ways_with_stable_ids_and_the_phones_categories_kept(world):
    keycheck(world)
    goal = fact("Run a marathon this year", NOW - 5000, category="goals")
    world.fake.phone_put("memory", {"v": 1, "facts": [goal], "extra": "kept"})
    mine = world.memory.add(
        "Ann Lee is my co-founder", category="people", source="said", origin="Ann is my co-founder"
    )
    result = await world.sync.sync()
    assert result["state"] == "ok"
    # the phone's fact is here, as synced
    here = world.memory.get(goal["id"])
    assert here is not None and here.text == "Run a marathon this year"
    assert here.source == "synced" and here.origin == "Synced from your iPhone"
    # the Mac's is there, under a UUID made from its id, and the goal is still a goal
    phone = world.phone_memory()
    assert (
        wire_id(mine.id) in phone and phone[wire_id(mine.id)]["text"] == "Ann Lee is my co-founder"
    )
    assert phone[wire_id(mine.id)]["category"] == "people"
    assert (
        phone[goal["id"]]["category"] == "goals" and phone[goal["id"]]["updated"] == goal["updated"]
    )
    assert world.fake.phone_read("memory")["extra"] == "kept"  # fields it doesn't know
    assert world.changed == 1
    # nothing new: nothing written again
    before = len(world.puts())
    assert (await world.sync.sync())["state"] == "ok"
    assert len(world.puts()) == before


def test_mac_ids_map_to_the_same_uuid_every_time_and_uuids_stay_themselves():
    made = wire_id("a1b2c3d4")
    assert made == wire_id("a1b2c3d4") and uuid.UUID(made).version == 5
    own = str(uuid.uuid4())
    assert wire_id(own) == own
    assert wire_id(own.upper()) != own.upper()  # only the canonical form is taken as is


async def test_newer_words_from_the_phone_keep_the_macs_provenance(world):
    keycheck(world)
    mine = world.memory.add(
        "I take my coffee black", category="preferences", source="said", origin="black, no sugar"
    )
    await world.sync.sync()
    ident = wire_id(mine.id)
    doc = world.fake.phone_read("memory")
    for f in doc["facts"]:
        if f["id"] == ident:
            f["text"], f["updated"] = "I take my coffee with oat milk", NOW + 60_000
    world.fake.phone_put("memory", doc)
    await world.sync.sync()
    now = world.memory.get(mine.id)
    assert now.text == "I take my coffee with oat milk"
    assert (now.source, now.origin, now.category) == ("said", "black, no sugar", "preferences")


async def test_a_fact_forgotten_here_goes_as_a_tombstone_and_one_removed_there_goes_here(world):
    keycheck(world)
    keep = world.memory.add("Ann Lee is my co-founder")
    drop = world.memory.add("I'm in Tokyo until Friday")
    await world.sync.sync()
    world.memory.forget(drop.id)
    await world.sync.sync()
    phone = world.phone_memory()
    assert phone[wire_id(drop.id)]["deleted"] is True and phone[wire_id(drop.id)]["updated"] == NOW
    assert phone[wire_id(keep.id)]["deleted"] is False
    # now the phone removes the other one
    doc = world.fake.phone_read("memory")
    for f in doc["facts"]:
        if f["id"] == wire_id(keep.id):
            f["deleted"], f["text"], f["updated"] = True, "", NOW + 10_000
    world.fake.phone_put("memory", doc)
    await world.sync.sync()
    assert world.memory.get(keep.id) is None
    # a tombstone older than 90 days is let go
    world.now = NOW + 91 * 24 * 3600 * 1000
    world.memory.add("Something new")
    await world.sync.sync()
    assert wire_id(drop.id) not in world.phone_memory()


async def test_a_newer_edit_here_beats_an_older_delete_there(world):
    keycheck(world)
    mine = world.memory.add("Ann Lee is my co-founder")
    tomb = {
        "id": wire_id(mine.id),
        "text": "",
        "category": "other",
        "updated": 1000,
        "deleted": True,
    }
    world.fake.phone_put("memory", {"v": 1, "facts": [tomb]})
    await world.sync.sync()
    assert world.memory.get(mine.id) is not None
    assert world.phone_memory()[wire_id(mine.id)]["deleted"] is False


async def test_a_write_that_crossed_another_devices_is_merged_and_tried_again(world):
    keycheck(world)
    world.memory.add("Ann Lee is my co-founder")
    theirs = fact("Prefers window seats", NOW - 1000, category="preferences")
    world.fake.phone_put("memory", {"v": 1, "facts": []})
    await world.sync.sync()
    # the phone writes after the Mac last looked: the Mac's next write is refused once
    world.memory.add("My dentist is Dr Ruiz")
    world.fake.phone_put(
        "memory", {"v": 1, "facts": [*world.fake.phone_read("memory")["facts"], theirs]}
    )
    world.fake.conflicts = 1
    assert (await world.sync.sync())["state"] == "ok"
    texts = {f["text"] for f in world.phone_memory().values()}
    assert texts == {"Ann Lee is my co-founder", "My dentist is Dr Ruiz", "Prefers window seats"}
    assert world.memory.get(theirs["id"]) is not None


async def test_secrets_from_the_phone_are_never_kept_here(world):
    keycheck(world)
    secret = fact("My bank password is hunter2", NOW)
    world.fake.phone_put("memory", {"v": 1, "facts": [secret]})
    await world.sync.sync()
    assert world.memory.get(secret["id"]) is None
    assert world.phone_memory()[secret["id"]]["text"] == "My bank password is hunter2"  # theirs


async def test_an_agents_own_facts_stay_on_the_mac(world):
    keycheck(world)
    world.memory.agent = "work"
    own = world.memory.add("The Q3 board deck is due Friday")
    world.memory.agent = ""
    await world.sync.sync()
    assert wire_id(own.id) not in world.phone_memory()


# ── settings ──


async def test_the_phones_newer_settings_come_here_and_unknown_fields_stay(world):
    keycheck(world)
    world.fake.phone_put(
        "settings",
        {
            "v": 1,
            "updated": NOW,
            "owner_name": "Bilel",
            "address_as": "boss",
            "language": "zh-Hans",
            "voice": "x",
        },
    )
    await world.sync.sync()
    assert (world.prefs.owner_name, world.prefs.address, world.prefs.language) == (
        "Bilel",
        "boss",
        "zh",
    )
    world.now += 60_000
    world.prefs.update({"address": "chief"})
    await world.sync.sync()
    doc = world.fake.phone_read("settings")
    assert doc["address_as"] == "chief" and doc["voice"] == "x" and doc["updated"] == world.now
    assert doc["owner_name"] == "Bilel" and doc["language"] == "zh"


async def test_the_macs_settings_go_up_when_the_phone_has_none(world):
    keycheck(world)
    world.prefs.update({"owner_name": "Bilel"})
    await world.sync.sync()
    doc = world.fake.phone_read("settings")
    assert doc["owner_name"] == "Bilel" and doc["v"] == 1 and doc["language"] == "en"


async def test_the_first_sync_keeps_a_name_only_the_mac_had(world):
    keycheck(world)
    world.prefs.update({"owner_name": "Bilel"})
    world.fake.phone_put("settings", {"v": 1, "updated": NOW - 10, "language": "en"})
    await world.sync.sync()
    assert world.fake.phone_read("settings")["owner_name"] == "Bilel"


# ── the phone's chats ──


async def test_the_phones_chats_are_never_read_or_deleted(world):
    keycheck(world)
    world.fake.phone_put("chat:" + str(uuid.uuid4()), {"v": 1, "messages": []})
    chat = next(k for k in world.fake.items if k.startswith("chat:"))
    before = dict(world.fake.items[chat])
    world.memory.add("Ann Lee is my co-founder")
    await world.sync.sync()
    assert world.fake.items[chat] == before
    assert not [c for c in world.fake.calls if c[1].startswith("/sync/chat:")]
    assert all(c[0] != "DELETE" for c in world.fake.calls)


# ── when ──


async def test_a_change_is_synced_a_few_seconds_later_by_the_loop(world, monkeypatch):
    keycheck(world)
    monkeypatch.setattr(account_sync, "LOOK_SECONDS", 0.01)
    monkeypatch.setattr(account_sync, "SETTLE_SECONDS", 0.01)
    task = asyncio.create_task(world.sync.loop())
    try:
        for _ in range(200):
            if world.sync.state == "ok":
                break
            await asyncio.sleep(0.01)
        assert world.sync.state == "ok"  # at start
        added = world.memory.add("Ann Lee is my co-founder")
        for _ in range(200):
            if wire_id(added.id) in world.phone_memory():
                break
            await asyncio.sleep(0.01)
        assert wire_id(added.id) in world.phone_memory()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_a_new_account_starts_sync_over(world, tmp_path):
    keycheck(world)
    world.memory.add("Ann Lee is my co-founder")
    await world.sync.sync()
    assert world.sync._file()["since"] > 0
    world.sync._file()["account"] = "someone-else"
    await world.sync.sync()
    assert world.sync._file()["account"] == world.account.account_id
