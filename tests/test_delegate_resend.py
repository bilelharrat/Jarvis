"""A message handed to Messages or Mail whose outcome never reached the disk (the disk
filled up just then, or the app stopped) is never sent a second time on its own: the
conversation waits for the owner, and its next message goes on a Send card."""

import contextlib

from test_delegate import OPENING, World, engine_for, move, start

from jarvis import jsonstore
from jarvis.delegate import Delegation, DelegationStore


def fill_the_disk_after_sending(engine):
    """Every save fails from the moment the message has gone out."""
    store, real_save, real_send = engine.store, engine.store.save, engine.send
    full = {"now": False}

    def save():
        if full["now"]:
            raise OSError(28, "No space left on device")
        real_save()

    async def send(channel, handle, text, approve):
        sent = await real_send(channel, handle, text, approve)
        full["now"] = True
        return sent

    store.save, engine.send = save, send
    return full


async def test_an_opening_sent_but_not_recorded_is_never_sent_again(tmp_path):
    world = World([move(OPENING)])
    engine = engine_for(tmp_path, world, granted=True)  # on its own: no card per message
    fill_the_disk_after_sending(engine)
    with contextlib.suppress(OSError):
        await start(engine)
    assert len(world.delivered) == 1 and "went out" in world.told[-1]
    again = engine_for(tmp_path, world, granted=True)  # the app restarts
    await again.step()
    await again.step()
    assert len(world.delivered) == 1  # it used to send the opening a second time here
    [d] = again.store.items
    assert (d.status, d.held, d.autonomy, d.sending) == (
        "waiting_owner",
        OPENING,
        "approve_each",
        "",
    )
    assert OPENING in d.need_owner and "may have gone out" in world.told[-1]
    # "Go on": whatever it writes next is shown on a Send card first, so a repeat of a
    # message that did arrive can be caught there.
    world.drafts = [move(OPENING)]
    await again.resume(d.id, "Go on")
    assert world.silent == [OPENING] and world.cards == [OPENING]


async def test_a_send_that_cant_be_recorded_pauses_the_conversation(tmp_path):
    world = World([move(OPENING), move("Tuesday at 1 works for me.")])
    engine = engine_for(tmp_path, world, granted=True)
    fill_the_disk_after_sending(engine)
    with contextlib.suppress(OSError):
        await start(engine)
    [d] = engine.store.items
    assert d.status == "waiting_owner" and d.transcript[-1]["text"] == OPENING
    world.they_say("Sure, when?")
    await engine.step()  # nothing can be saved: nothing more goes out either
    assert len(world.delivered) == 1


async def test_hundreds_of_unrecorded_sends_and_restarts_send_nothing_twice(tmp_path, monkeypatch):
    monkeypatch.setattr(jsonstore, "_sync", lambda _fd: None)  # the disk isn't measured here
    monkeypatch.setattr(jsonstore, "_sync_folder", lambda _folder: None)
    for i in range(300):
        folder = tmp_path / str(i)
        folder.mkdir()
        world = World([move(OPENING)])
        engine = engine_for(folder, world, granted=True)
        fill_the_disk_after_sending(engine)
        with contextlib.suppress(OSError):
            await start(engine)
        await engine_for(folder, world, granted=True).step()
        assert len(world.delivered) == 1, i


def test_half_a_surrogate_pair_never_stops_conversations_being_saved(tmp_path):
    """A model's lone surrogate in a name or a message used to make every later save of
    every conversation fail."""
    store = DelegationStore(tmp_path / "delegations.json")
    store.add(
        Delegation(
            "abc123",
            "Sam \ud83d",
            "+14155550142",
            "imessage",
            "Lunch \udc00",
            transcript=[{"from": "them", "text": "hi \ud800", "at": ""}],
        )
    )
    store.save()
    [back] = DelegationStore(tmp_path / "delegations.json").items
    assert (back.contact, back.goal, back.transcript[0]["text"]) == (
        "Sam \ud83d",
        "Lunch \udc00",
        "hi \ud800",
    )
