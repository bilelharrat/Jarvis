"""Interruptions that learn from the owner's reactions, with synthetic Messages and Mail
databases in a temp folder (test_interrupts' Env): never real texts, email or Contacts."""

import json
from datetime import timedelta

import pytest
from test_interrupts import ANN, BOB, CY, NOW, STRANGER, Env

from jarvis import interrupt_learning as il
from jarvis.interrupt_learning import ReactionLearner, masked, person_key
from jarvis.interrupts import build_tools


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)


def learner(tmp_path, clock=None):
    return ReactionLearner(tmp_path / "learn.json", now=clock or (lambda: NOW))


def react(learn, handle, outcome, n=1, who="Bob Chen", words=()):
    told = None
    for _ in range(n):
        told = learn.learn(person_key("message", handle), who, outcome, words) or told
    return told


# ── the learner alone ──


def test_person_key_is_one_way_and_format_blind():
    assert person_key("message", "+1 (415) 555-0101") == person_key("message", "4155550101")
    assert "4155550101" not in person_key("message", "4155550101")
    assert person_key("mail", "Ann@Zainar.com") == person_key("mail", "mailto:ann@zainar.com")
    assert masked("ann@zainar.com") == "a…@zainar.com"
    assert masked("+14155550199") == "the number ending 0199"


def test_five_dismissals_mute_a_sender_and_say_why(tmp_path):
    learn = learner(tmp_path)
    assert react(learn, BOB, "dismissed", 4) is None
    told = react(learn, BOB, "dismissed")
    assert told.startswith("I've stopped interrupting you for Bob Chen because you dismissed")
    assert "last 5 messages" in told
    standing = learn.standing("message", BOB, [], vip=False, known=True)
    assert standing.muted and "muted" in standing.reasons[0]
    assert react(learn, BOB, "dismissed") is None  # said once, not every time
    assert "Bob Chen" in learn.explain()


def test_mixed_reasons_are_worded_as_they_were(tmp_path):
    learn = learner(tmp_path)
    react(learn, BOB, "ignored", 3)
    told = react(learn, BOB, "dismissed", 2)
    assert "dismissed or didn't open" in told
    learn2 = learner(tmp_path / "b")
    assert "didn't open" in react(learn2, CY, "ignored", 5, who="Cy Park")


def test_a_vip_is_never_muted_or_lowered(tmp_path):
    learn = learner(tmp_path)
    react(learn, ANN, "dismissed", 6, who="Ann Lee", words=["asap"])
    standing = learn.standing("message", ANN, [], vip=True, known=True)
    assert not standing.muted and standing.delta == 0


def test_quick_answers_let_a_contact_through(tmp_path):
    learn = learner(tmp_path)
    react(learn, BOB, "replied", 2)
    told = react(learn, BOB, "opened")
    assert "reach you right away" in told and "3 of their last 4" in told
    standing = learn.standing("message", BOB, [], vip=False, known=True)
    assert standing.boosted and standing.delta == il.BOOST
    # a stranger answered quickly is never promoted past the usual checks
    react(learn, STRANGER, "replied", 4, who="the number ending 0199")
    assert not learn.standing("message", STRANGER, [], vip=False, known=False).boosted


def test_mostly_dismissed_lowers_a_point(tmp_path):
    learn = learner(tmp_path)
    for outcome in ("replied", "dismissed", "dismissed", "read", "ignored"):
        react(learn, BOB, outcome)
    standing = learn.standing("message", BOB, [], vip=False, known=True)
    assert (standing.delta, standing.muted) == (-1, False)
    assert "usually dismiss" in learn.explain()


def test_words_learn_too(tmp_path):
    learn = learner(tmp_path)
    for i in range(6):
        learn.learn(person_key("message", f"+1415555{i:04d}"), f"P{i}", "dismissed", ["asap"])
        learn.learn(person_key("message", f"+1415556{i:04d}"), f"Q{i}", "replied", ["call me"])
    standing = learn.standing("message", CY, ["asap", "call me"], vip=False, known=True)
    assert standing.delta == 0  # one up, one down
    assert any("asap" in r for r in standing.reasons)
    assert learn.standing("message", CY, ["asap"], vip=True, known=True).delta == 0
    assert "“call me”: you always answer" in learn.explain()


def test_reset_undoes_it(tmp_path):
    learn = learner(tmp_path)
    react(learn, BOB, "dismissed", 5)
    assert "forgotten what I learned about Bob Chen" in learn.reset("bob")
    assert not learn.standing("message", BOB, [], vip=False, known=True).muted
    assert learn.reset("nobody") == "I hadn't learned anything about nobody."
    react(learn, BOB, "dismissed", 5)
    assert "everything" in learn.reset()
    assert learn.explain() == il.WORDS["en"]["nothing"]


def test_chinese_explanations(tmp_path):
    learn = learner(tmp_path)
    for _ in range(5):
        told = learn.learn(person_key("message", BOB), "Bob Chen", "dismissed", (), "zh")
    assert told.startswith("我不再因为Bob Chen的消息打扰你了")


def test_saved_without_addresses_or_words(tmp_path):
    learn = learner(tmp_path)
    react(learn, BOB, "dismissed", 5, words=["asap"])
    saved = (tmp_path / "learn.json").read_text()
    assert "4155550101" not in saved and "+1" not in saved
    again = learner(tmp_path)
    assert again.standing("message", BOB, [], vip=False, known=True).muted
    data = json.loads(saved)
    assert len(data["senders"]) == 1


def test_off_learns_nothing(tmp_path):
    learn = ReactionLearner(tmp_path / "l.json", enabled=lambda: False, now=lambda: NOW)
    learn.announced("message:1", "message", 1, BOB, "Bob Chen")
    assert learn.due() == []
    assert learn.standing("message", BOB, [], vip=False, known=True).delta == 0


def test_history_and_senders_are_capped(tmp_path):
    learn = learner(tmp_path)
    react(learn, BOB, "read", il.HISTORY + 5)
    assert len(learn.senders[person_key("message", BOB)]["log"]) == il.HISTORY
    for i in range(il.MAX_SENDERS + 10):
        learn.learn(f"k{i}", f"P{i}", "read")
    assert len(learn.senders) == il.MAX_SENDERS
    for i in range(il.MAX_PENDING + 10):
        learn.announced(f"message:{i}", "message", i, BOB, "Bob")
    assert len(learn.pending) == il.MAX_PENDING


def test_outcomes(tmp_path):
    clock = [NOW]
    learn = ReactionLearner(tmp_path / "l.json", now=lambda: clock[0])
    learn.announced("message:1", "message", 1, BOB, "Bob Chen")
    item = learn.pending["message:1"]
    assert learn.outcome(item, None, False) is None  # too soon to say
    assert learn.outcome(item, NOW + timedelta(minutes=3), False) == "replied"
    assert learn.outcome(item, None, True) == "opened"
    learn.card("interrupt:message:1", "dismissed")
    assert learn.outcome(item, None, False) is None
    clock[0] = NOW + timedelta(minutes=il.QUICK_MINUTES + 1)
    assert learn.outcome(item, None, True) == "dismissed"  # read later: still dismissed
    item.dismissed = False
    assert learn.outcome(item, None, False) is None
    clock[0] = NOW + timedelta(hours=il.IGNORE_HOURS)
    assert learn.outcome(item, None, False) == "ignored"
    assert learn.outcome(item, None, True) == "read"
    assert learn.outcome(item, None, None) == "drop"  # can't tell: nothing learned
    learn.card("message:1", "opened")
    assert learn.outcome(item, None, None) == "opened"


# ── wired into the Interrupter ──


async def test_dismissed_sender_stops_interrupting(env):
    told = []
    env.mode = "all"
    watch = await env.started(on_learned=told.append)
    for i in range(il.MUTE_AFTER):
        env.chat.send(BOB, f"lunch plan number {i}", at=env.clock.at)
        [alert] = await watch.poll()
        watch.card_reaction(alert.key, "dismissed")
        env.clock.advance(minutes=il.QUICK_MINUTES + 1)
        await watch.follow_up()
    assert told and "Bob Chen" in told[0] and "dismissed" in told[0]
    env.chat.send(BOB, "another lunch idea", at=env.clock.at)
    assert await watch.poll() == []  # muted: it waits instead
    assert [i.name for i in watch.waiting] == ["Bob Chen"]
    tools = {t.name: t.handler for t in build_tools(watch, _yes)}
    out = await tools["interruption_learning"]({"who": "Bob"})
    assert "stopped interrupting you for Bob Chen" in out["content"][0]["text"]
    assert "no longer interrupt" in await watch.describe()
    await tools["reset_interruption_learning"]({"who": "Bob"})
    env.chat.send(BOB, "one more lunch idea", at=env.clock.at)
    assert len(await watch.poll()) == 1  # reversible


async def test_vip_gets_through_however_often_dismissed(env):
    env.mode = "all"
    watch = await env.started()
    for i in range(il.MUTE_AFTER + 1):
        env.chat.send(ANN, f"note {i}", at=env.clock.at)
        [alert] = await watch.poll()
        watch.card_reaction(alert.key, "dismissed")
        env.clock.advance(minutes=il.QUICK_MINUTES + 1)
        await watch.follow_up()
    env.chat.send(ANN, "yet another note", at=env.clock.at)
    assert len(await watch.poll()) == 1


async def test_quick_replies_let_plain_texts_through(env):
    told = []
    watch = await env.started(on_learned=told.append)
    for i in range(il.BOOST_OF[0]):
        rowid = env.chat.send(BOB, f"quick question {i}", at=env.clock.at)
        assert await watch.poll() == []  # urgent only: a plain text waits
        env.chat.send(BOB, "sure, on it", at=env.clock.at + timedelta(minutes=2), from_me=1)
        env.clock.advance(minutes=3)
        await watch.follow_up()
        assert rowid
    assert told and "Bob Chen's messages will reach you right away" in told[0]
    env.chat.send(BOB, "are you free at 4?", at=env.clock.at)
    [alert] = await watch.poll()
    assert "Bob Chen" in alert.text


async def test_ignored_after_hours(env):
    env.mode = "all"
    watch = await env.started()
    env.chat.send(CY, "fyi the deck is up")
    [alert] = await watch.poll()
    env.clock.advance(hours=il.IGNORE_HOURS)
    await watch.follow_up()
    record = watch.learner.senders[person_key("message", CY)]
    assert [o for o, _ in record["log"]] == ["ignored"]


async def test_read_quickly_on_the_phone_counts_as_opened(env):
    env.mode = "all"
    watch = await env.started()
    rowid = env.chat.send(CY, "fyi the deck is up")
    [alert] = await watch.poll()
    watch.card_reaction(alert.key, "dismissed")  # dismissed here, read on the phone
    env.chat.mark_read(rowid)
    env.clock.advance(minutes=2)
    await watch.follow_up()
    record = watch.learner.senders[person_key("message", CY)]
    assert [o for o, _ in record["log"]] == ["opened"]


async def _yes(_action, _question):
    return True


# ── what a look writes ──


async def test_a_look_that_settles_many_reactions_writes_the_file_once(env, monkeypatch):
    """After the Mac slept, every interruption of the night settles in one look: the file
    is written once (it was once per reaction, each flushed to the disk, the event loop
    waiting on every write), and holds just what it held when each was saved."""
    env.mode = "all"
    watch = await env.started()
    handles = [f"+1415555{k:04d}" for k in range(40)]
    for k, handle in enumerate(handles):
        rowid = env.chat.send(handle, f"hello {k}", at=env.clock.at)
        watch.learner.announced(f"message:{rowid}", "message", rowid, handle, f"Someone {k}")
    env.clock.advance(hours=il.IGNORE_HOURS + 1)
    saves = []
    real = il.jsonstore.save_json
    monkeypatch.setattr(
        il.jsonstore, "save_json", lambda path, *a, **k: (saves.append(path), real(path, *a, **k))
    )
    assert await watch.follow_up() == []
    assert saves == [watch.learner.path]  # before: 40
    # The same reactions learned one at a time, each saved: the same file.
    one_by_one = ReactionLearner(env.tmp / "one.json", now=env.clock)
    for k, handle in enumerate(handles):
        one_by_one.learn(person_key("message", handle), f"Someone {k}", "ignored")
    assert json.loads(watch.learner.path.read_text()) == json.loads(one_by_one.path.read_text())
    assert len(saves) == 1 + len(handles)  # the reference's own saves: once each


async def test_a_standing_that_changed_is_on_disk_before_the_owner_hears_it(env):
    on_disk = []

    def told(sentence):
        saved = json.loads((env.tmp / "interrupt_learning.json").read_text())
        on_disk.append([r["state"] for r in saved["senders"].values()])

    env.mode = "all"
    watch = await env.started(on_learned=told)
    for i in range(il.MUTE_AFTER):
        env.chat.send(BOB, f"lunch plan number {i}", at=env.clock.at)
        [alert] = await watch.poll()
        watch.card_reaction(alert.key, "dismissed")
        env.clock.advance(minutes=il.QUICK_MINUTES + 1)
        await watch.follow_up()
    assert on_disk == [["muted"]]


def test_held_saves_once_at_the_end_even_when_something_fails(tmp_path):
    learn = learner(tmp_path)
    with pytest.raises(RuntimeError), learn.held():
        react(learn, BOB, "dismissed", n=3)
        assert not learn.path.exists()  # not yet
        raise RuntimeError("a reaction that couldn't be read")
    saved = json.loads(learn.path.read_text())
    assert [o for o, _ in saved["senders"][person_key("message", BOB)]["log"]] == ["dismissed"] * 3
    react(learn, BOB, "replied")  # outside held(): saved at once, as always
    saved = json.loads(learn.path.read_text())
    assert saved["senders"][person_key("message", BOB)]["log"][-1][0] == "replied"
