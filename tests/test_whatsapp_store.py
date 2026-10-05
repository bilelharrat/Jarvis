"""WhatsApp's store (jarvis.features.whatsapp.Store) at the size a linked account reaches:
hundreds of chats of a hundred messages each. A live message looks only at its own chat; a
history sync's hundreds of hidden (LID) addresses rename the senders in one pass, with the
same result as a pass for each; store.json is the same text, taken on the event loop and
written in a thread, never older over newer and never after the store is forgotten."""

import asyncio
import json
import random
import threading

from jarvis.features import whatsapp
from jarvis.features.whatsapp import PN, Store, WhatsApp


class OneByOne(Store):
    """The store as it was: each new hidden address renamed every kept message's sender at
    once, and each batch looked at every kept message for what was still kept."""

    def add_lids(self, pairs):
        for pair in pairs:
            if not (isinstance(pair, list | tuple) and len(pair) == 2):
                continue
            lid, pn = pair
            if not (isinstance(lid, str) and isinstance(pn, str)):
                continue
            if lid.endswith("@lid") and pn.endswith(PN) and self.lids.get(lid) != pn:
                self.lids[lid] = pn
                self._merge(lid, pn)
                for kept in self.messages.values():
                    for m in kept:
                        if m.get("sender") == lid:
                            m["sender"] = pn

    def _add_lids(self, pairs, renames):
        self.add_lids(pairs)

    def apply_messages(self, messages):
        new = []
        for m in messages:
            if not isinstance(m, dict) or not m.get("id") or not isinstance(m.get("chat"), str):
                continue
            chat_alt, sender_alt = m.get("chat_alt"), m.get("sender_alt")
            if isinstance(chat_alt, str) and m["chat"].endswith("@lid"):
                self.add_lids([[m["chat"], chat_alt]])
            if isinstance(sender_alt, str) and isinstance(m.get("sender"), str):
                self.add_lids([[m["sender"], sender_alt]])
            chat = self.canon(m["chat"])
            sender = self.canon(m.get("sender")) or None
            kept = {
                "id": str(m["id"]),
                "chat": chat,
                "from_me": bool(m.get("from_me")),
                "sender": sender,
                "ts": int(m.get("ts") or 0),
                "text": str(m.get("text") or "")[:4000],
            }
            if m.get("name") and sender and not m.get("from_me"):
                self.contacts.setdefault(sender, {}).setdefault("notify", str(m["name"])[:200])
            if self._keep(chat, kept):
                new.append(kept)
                entry = self.chats.setdefault(chat, {"id": chat})
                entry["ts"] = max(entry.get("ts", 0), kept["ts"])
        self._trim_chats()
        still = {(c, k["id"]) for c, kept_list in self.messages.items() for k in kept_list}
        return [
            {**m, "chat": self.canon(m["chat"]), "sender": self.canon(m["sender"]) or None}
            for m in new
            if (self.canon(m["chat"]), m["id"]) in still
        ]


def _state(store):
    return json.loads(json.dumps([store.chats, store.contacts, store.lids, store.messages]))


def _events(rng, n):
    """Random bridge events: chats, contacts, lids and messages over a few addresses, some
    hidden (with their numbers learned along the way, now and then a second time)."""
    lids = [f"{i}@lid" for i in range(12)]
    numbers = [f"1555000{i:04d}{PN}" for i in range(12)]
    groups = [f"12036300000000000{i}@g.us" for i in range(3)]
    events = []
    for k in range(n):
        kind = rng.choice(["messages", "messages", "lids", "contacts", "chats"])
        if kind == "lids":
            pairs = [[rng.choice(lids), rng.choice(numbers)] for _ in range(rng.randint(1, 6))]
            events.append(("lids", pairs))
        elif kind == "contacts":
            i = rng.randrange(12)
            events.append(("contacts", [{"id": lids[i], "pn": numbers[i], "name": f"C{i}"}]))
        elif kind == "chats":
            events.append(("chats", [{"id": rng.choice(lids + numbers + groups), "ts": k}]))
        else:
            batch = []
            for j in range(rng.randint(1, 8)):
                i = rng.randrange(12)
                chat = rng.choice([lids[i], numbers[i], rng.choice(groups)])
                m = {
                    "id": f"m{k}-{j}" if rng.random() > 0.1 else f"m{rng.randrange(k + 1)}-0",
                    "chat": chat,
                    "sender": rng.choice([lids[i], numbers[i]]),
                    "ts": rng.randrange(1000),
                    "text": f"t{k}",
                    "name": f"N{i}",
                }
                if rng.random() < 0.3:
                    m["sender_alt"] = numbers[i]
                if chat.endswith("@lid") and rng.random() < 0.3:
                    m["chat_alt"] = rng.choice(numbers)
                batch.append(m)
            events.append(("messages", batch))
    return events


def test_batched_renames_keep_what_one_pass_a_pair_kept(monkeypatch):
    monkeypatch.setattr(whatsapp, "KEEP_PER_CHAT", 6)  # messages pushed out mid-batch too
    for seed in range(40):
        rng = random.Random(seed)
        now, before = Store(None), OneByOne(None)
        for kind, data in _events(rng, 60):
            if kind == "messages":
                assert now.apply_messages(json.loads(json.dumps(data))) == before.apply_messages(
                    json.loads(json.dumps(data))
                )
            elif kind == "lids":
                now.add_lids(data)
                before.add_lids(data)
            elif kind == "contacts":
                now.apply_contacts(data)
                before.apply_contacts(data)
            else:
                now.apply_chats(data)
                before.apply_chats(data)
            assert _state(now) == _state(before), seed


class Untouched(list):
    """A chat's messages that a live message elsewhere must not read."""

    def __iter__(self):
        raise AssertionError("a live message read every chat's messages")


def _big_store(chats=600, each=100):
    store = Store(None)
    store.loaded = True
    for c in range(chats):
        jid = f"1555{c:07d}{PN}"
        store.chats[jid] = {"id": jid, "ts": c}
        store.messages[jid] = [
            {"id": f"m{c}-{i}", "chat": jid, "from_me": False, "sender": jid, "ts": i, "text": "hi"}
            for i in range(each)
        ]
    return store


def test_a_live_message_looks_only_at_its_own_chat():
    store = _big_store(chats=50, each=20)
    mine = f"1555{0:07d}{PN}"
    for jid in store.messages:
        if jid != mine:
            store.messages[jid] = Untouched(store.messages[jid])
    new = store.apply_messages(
        [{"id": "live", "chat": mine, "sender": mine, "ts": 99, "text": "new"}]
    )
    assert [m["id"] for m in new] == ["live"]
    assert store.messages[mine][-1]["id"] == "live"


def test_a_history_sync_renames_senders_in_one_pass(monkeypatch):
    store = _big_store(chats=40, each=10)
    group = "120363000000000001@g.us"
    store.messages[group] = [
        {"id": f"g{i}", "chat": group, "from_me": False, "sender": f"{i}@lid", "ts": i, "text": ""}
        for i in range(30)
    ]
    passes = []
    real = Store._rename_senders
    monkeypatch.setattr(Store, "_rename_senders", lambda s, r: passes.append(dict(r)) or real(s, r))
    store.add_lids([[f"{i}@lid", f"1444{i:07d}{PN}"] for i in range(30)])
    assert len(passes) == 1 and len(passes[0]) == 30
    assert [m["sender"] for m in store.messages[group]] == [f"1444{i:07d}{PN}" for i in range(30)]


def test_the_file_is_the_text_json_dump_wrote(tmp_path):
    store = Store(tmp_path / "store.json")
    store.apply_contacts([{"id": f"1{PN}", "name": "Zoë ✓", "notify": "é"}])
    store.apply_messages(
        [{"id": "1", "chat": f"1{PN}", "sender": f"1{PN}", "ts": 5, "text": "日本   ok"}]
    )
    store.save()
    expected = json.dumps(
        {
            "chats": store.chats,
            "contacts": store.contacts,
            "lids": store.lids,
            "messages": store.messages,
        },
        ensure_ascii=False,
    )
    assert (tmp_path / "store.json").read_text() == expected
    again = Store(tmp_path / "store.json")
    again.load()
    assert (again.chats, again.contacts, again.messages) == (
        store.chats,
        store.contacts,
        store.messages,
    )


def test_an_older_text_never_lands_over_a_newer_one(tmp_path):
    store = Store(tmp_path / "store.json")
    store.apply_chats([{"id": f"1{PN}", "ts": 1}])
    older = store.taken()
    store.apply_chats([{"id": f"2{PN}", "ts": 2}])
    store.save()  # the newer one, written first
    store.write(*older)  # the older one's thread, late
    assert set(json.loads((tmp_path / "store.json").read_text())["chats"]) == {
        f"1{PN}",
        f"2{PN}",
    }


def test_a_forgotten_store_is_never_written_back(tmp_path):
    store = Store(tmp_path / "store.json")
    store.apply_chats([{"id": f"1{PN}", "ts": 1}])
    store.save()
    pending = store.taken()
    store.clear()  # unlinked while a write was on its way
    store.write(*pending)
    assert not (tmp_path / "store.json").exists()


async def test_the_save_after_a_change_is_written_off_the_event_loop(tmp_path, monkeypatch):
    monkeypatch.setattr(whatsapp, "SAVE_AFTER", 0.01)
    emitted = []
    wa = WhatsApp(tmp_path / "wa", lambda kind, **data: emitted.append(kind), None)
    wa.store.loaded = True
    wa.state = "connected"
    threads = []
    real = Store.write

    def write(self, text, place):
        threads.append(threading.current_thread())
        real(self, text, place)

    monkeypatch.setattr(Store, "write", write)
    wa._on_event({"type": "chats", "chats": [{"id": f"1{PN}", "ts": 3, "name": "Ben"}]})
    for _ in range(200):
        if wa.store.path.exists():
            break
        await asyncio.sleep(0.01)
    assert threads and threads[0] is not threading.main_thread()
    assert json.loads(wa.store.path.read_text())["chats"][f"1{PN}"]["name"] == "Ben"
    assert emitted == ["whatsapp"]  # the window's unread count, as before
    await wa.shutdown()


def _whole(store):
    """store.json's text as the store wrote it before: one json.dumps of all of it."""
    return json.dumps(
        {
            "chats": store.chats,
            "contacts": store.contacts,
            "lids": store.lids,
            "messages": store.messages,
        },
        ensure_ascii=False,
    )


def test_each_save_is_the_text_one_dump_of_the_whole_store_makes(tmp_path, monkeypatch):
    """A save puts the text together from each chat's messages as an earlier save encoded
    them: after any mix of new messages, hidden addresses renamed, chats merged and chats
    let go, it's the very text a json.dumps of the whole store makes."""
    monkeypatch.setattr(whatsapp, "KEEP_PER_CHAT", 6)
    monkeypatch.setattr(whatsapp, "KEEP_CHATS", 9)  # chats let go mid-run too
    for seed in range(30):
        rng = random.Random(seed)
        store = Store(tmp_path / f"store-{seed}.json")
        for step, (kind, data) in enumerate(_events(rng, 80)):
            if kind == "messages":
                store.apply_messages(data)
            elif kind == "lids":
                store.add_lids(data)
            elif kind == "contacts":
                store.apply_contacts(data)
            else:
                store.apply_chats(data)
            if rng.random() < 0.5:
                assert store.taken()[0] == _whole(store), (seed, step)
        store.save()
        assert store.path.read_text() == _whole(store)
        again = Store(store.path)
        again.load()  # read back: the same, and saved again the same
        assert again.taken()[0] == _whole(again) == store.path.read_text()
        again.apply_messages([{"id": "z", "chat": f"1{PN}", "sender": None, "ts": 1, "text": "é"}])
        assert again.taken()[0] == _whole(again)


def test_a_chat_given_new_messages_wholesale_is_encoded_again():
    store = Store(None)
    store.apply_messages([{"id": "1", "chat": f"1{PN}", "sender": None, "ts": 1, "text": "a"}])
    store.taken()
    store.messages[f"1{PN}"] = [
        {"id": "2", "chat": f"1{PN}", "from_me": True, "sender": None, "ts": 2, "text": "b"}
    ]
    store.messages[f"2{PN}"] = []
    assert store.taken()[0] == _whole(store)
    store.clear()
    empty = '{"chats": {}, "contacts": {}, "lids": {}, "messages": {}}'
    assert store.taken()[0] == _whole(store) == empty


def test_a_save_encodes_only_the_chats_that_changed(monkeypatch):
    """A live message on a full store: its chat's messages are encoded again, the other
    599 chats' are as the last save left them (the whole store took 60-120 ms on the
    event loop, at every save)."""
    store = _big_store(chats=600, each=20)
    store.taken()
    encoded = []
    real = json.dumps

    def dumps(value, *args, **kwargs):
        if isinstance(value, list):
            encoded.append(value)
        return real(value, *args, **kwargs)

    monkeypatch.setattr(whatsapp.json, "dumps", dumps)
    mine = f"1555{7:07d}{PN}"
    store.apply_messages([{"id": "live", "chat": mine, "sender": mine, "ts": 99, "text": "new"}])
    text, _place = store.taken()
    assert [id(v) for v in encoded] == [id(store.messages[mine])]
    monkeypatch.setattr(whatsapp.json, "dumps", real)
    assert text == _whole(store)
    encoded.clear()
    monkeypatch.setattr(whatsapp.json, "dumps", dumps)
    store.add_lids([[f"{7}@lid", mine]])  # nothing sent from it: nothing to encode again
    store.taken()
    assert encoded == []
