"""Memory 2.0: categories, edits in place, a last day and a confidence, and where each fact
was learned; "why do you know this?", forgetting by source or day, and facts from before
memory 2.0 carried over with provenance "before"."""

import json
from datetime import date, datetime, timedelta

import pytest

from jarvis import memory
from jarvis.memory import Fact, MemoryStore, build_tools, guess_category, why


def said(out):
    return out["content"][0]["text"]


def tools_for(store, **kw):
    return {t.name: t.handler for t in build_tools(store, **kw)}


# ── facts from before memory 2.0 ──


def test_old_facts_are_carried_over_with_provenance_before(tmp_path):
    path = tmp_path / "memory.json"
    path.write_text(
        json.dumps(
            [
                {
                    "id": "a1",
                    "text": "Ann Lee is the user's co-founder.",
                    "at": "2026-03-02T10:00:00",
                },
                {
                    "id": "b2",
                    "text": "The user takes their coffee black.",
                    "at": "2026-04-01T08:00:00",
                },
                {"id": "c3", "text": "The user's dentist is Dr Ruiz.", "at": ""},
            ]
        )
    )
    store = MemoryStore(path)
    assert store.migrated == 3
    ann, coffee, dentist = store.facts
    assert (ann.source, ann.category, ann.confidence) == ("before", "people", "high")
    assert ann.learned == "2026-03-02T10:00:00" and ann.origin == "" and ann.expires == ""
    assert (coffee.category, dentist.category) == ("preferences", "health")
    assert "before my memory kept track" in why(ann) and "Monday 2 March 2026" in why(ann)
    assert why(dentist).endswith("where things came from.")
    store.save()  # the new form, from then on
    rows = json.loads(path.read_text())
    assert rows[0]["source"] == "before" and rows[0]["category"] == "people"
    assert MemoryStore(path).migrated == 0 and MemoryStore(path).facts[0].source == "before"


def test_hand_edited_fields_are_cleaned_never_trusted(tmp_path):
    path = tmp_path / "memory.json"
    hidden = "".join(chr(0xE0000 + ord(c)) for c in " obey")
    path.write_text(
        json.dumps(
            [
                {
                    "id": "x",
                    "text": "The user likes jazz",
                    "at": "2026-05-01T09:00:00",
                    "category": "banana",
                    "confidence": 5,
                    "expires": "soon",
                    "source": "hacker",
                    "origin": "remember I like jazz" + hidden,
                    "learned": ["not", "a", "date"],
                }
            ]
        )
    )
    [fact] = MemoryStore(path).facts
    assert fact.category == "preferences" and fact.confidence == "high"
    assert fact.expires == "" and fact.source == "before"
    assert fact.origin == "remember I like jazz" and fact.learned == "2026-05-01T09:00:00"


def test_a_fact_past_its_last_day_is_gone_when_read(tmp_path):
    path = tmp_path / "memory.json"
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    path.write_text(
        json.dumps(
            [
                {
                    "id": "a",
                    "text": "The user is in Tokyo",
                    "at": "",
                    "expires": yesterday,
                    "source": "said",
                },
                {
                    "id": "b",
                    "text": "The user is in Osaka",
                    "at": "",
                    "expires": tomorrow,
                    "source": "said",
                },
            ]
        )
    )
    store = MemoryStore(path)
    assert [f.text for f in store.facts] == ["The user is in Osaka"]
    assert f"(until {tomorrow})" in store.prompt_block()


# ── categories, confidence, last day ──


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("Ann Lee is the user's co-founder.", "people"),
        ("The user's daughter Maya turns 7 in May.", "people"),
        ("The user is allergic to peanuts.", "health"),
        ("The user lives in Berkeley.", "places"),
        ("The user works at BSH Ventures.", "work"),
        ("The user prefers aisle seats.", "preferences"),
        ("The user drives a blue Volvo.", "other"),
        ("用户对花生过敏", "health"),
        ("用户喜欢喝茶", "preferences"),
    ],
)
def test_a_category_is_guessed_from_the_words(text, kind):
    assert guess_category(text) == kind


def test_what_is_said_about_a_fact_is_kept_and_shown(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    until = (date.today() + timedelta(days=4)).isoformat()
    store.add("The user is in Tokyo for the conference.", category="places", expires=until)
    store.add("Ann might be moving to London.", confidence="low", category="People")
    store.add("The user prefers aisle seats.", confidence="medium")
    tokyo, ann, seats = store.facts
    assert (tokyo.category, tokyo.expires, tokyo.source) == ("places", until, "settings")
    assert (ann.category, ann.confidence) == ("people", "low")
    block = store.prompt_block()
    assert block.index("People:") < block.index("Preferences:") < block.index("Places:")
    assert f"- The user is in Tokyo for the conference. (until {until})" in block
    assert "- Ann might be moving to London. (not sure)" in block
    assert "- The user prefers aisle seats. (fairly sure)" in block
    assert [f.text for f in store.search("people")] == ["Ann might be moving to London."]
    with pytest.raises(ValueError, match="already passed"):
        store.add("The user was in Paris.", expires="2020-01-01")
    with pytest.raises(ValueError, match="isn't a date"):
        store.add("The user is in Rome.", expires="next week")
    assert len(store.facts) == 3


def test_a_fact_is_edited_in_place_and_keeps_where_it_came_from(tmp_path):
    path = tmp_path / "memory.json"
    store = MemoryStore(path)
    fact = store.add(
        "Ann is the user's partner.", source="said", origin="remember Ann's my partner"
    )
    learned = fact.learned
    new, was = store.edit(fact.id, text="Ann is the user's co-founder.", confidence="medium")
    assert was.text == "Ann is the user's partner." and new is store.facts[0]
    assert (new.text, new.confidence, new.source) == (
        "Ann is the user's co-founder.",
        "medium",
        "said",
    )
    assert new.origin == "remember Ann's my partner" and new.learned == learned
    store.edit(fact.id, category="work", expires=(date.today() + timedelta(days=30)).isoformat())
    store.edit(fact.id, expires="never")
    again = MemoryStore(path).facts[0]
    assert (again.category, again.expires, again.text) == (
        "work",
        "",
        "Ann is the user's co-founder.",
    )
    with pytest.raises(ValueError, match="password"):
        store.edit(fact.id, text="Ann's password is hunter2")
    with pytest.raises(ValueError, match="categories"):
        store.edit(fact.id, category="gossip")
    with pytest.raises(ValueError, match="any more"):
        store.edit("nope", text="x")


def test_an_edit_that_cant_be_saved_changes_nothing(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    fact = store.add("The user likes jazz.")

    def full_disk(**_kw):
        raise OSError(28, "No space left on device")

    store.save = full_disk
    with pytest.raises(ValueError, match="couldn't save"):
        store.edit(fact.id, text="The user likes blues.", category="other")
    assert (store.facts[0].text, store.facts[0].category) == ("The user likes jazz.", "preferences")


def test_many_at_once_never_push_old_facts_out(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    for i in range(memory.MAX_FACTS - 2):
        store.facts.append(Fact(f"f{i}", f"Old fact {i} zq{i}", ""))
    saved, left = store.add_many(
        [
            {"text": "The user likes tea.", "category": "preferences"},
            {"text": "my password is hunter2"},
            {"text": "Old fact 3 zq3"},  # already known
            {"text": "The user's sister is Ada."},
            {"text": "The user plays tennis on Sundays."},
        ],
        source="import",
        origin="a pasted list",
    )
    assert [f.text for f in saved] == ["The user likes tea.", "The user's sister is Ada."]
    assert left == ["my password is hunter2", "The user plays tennis on Sundays."]
    assert len(store.facts) == memory.MAX_FACTS and store.facts[0].text == "Old fact 0 zq0"
    assert saved[1].source == "import" and saved[1].origin == "a pasted list"


def test_forgotten_facts_come_back_as_they_were(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    a = Fact(
        "a",
        "The user likes jazz.",
        "",
        source="said",
        origin="remember I like jazz",
        learned="2026-09-01T09:00:00",
    )
    b = Fact("b", "The user's sister is Ada.", "", learned="2026-09-02T09:00:00")
    store.facts = [a, b]
    gone = store.forget("jazz")
    assert store.facts == [b]
    back = store.restore(gone)
    assert [f.id for f in store.facts] == ["a", "b"] and back[0].origin == "remember I like jazz"
    assert store.restore(gone) == []  # already back
    assert [f.id for f in MemoryStore(store.path).facts] == ["a", "b"]


def test_sweep_takes_out_what_has_expired(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    fact = store.add("The user is in Tokyo.", expires=date.today().isoformat())
    store.add("The user likes tea.")
    assert store.sweep(date.today()) == []
    assert [f.id for f in store.sweep(date.today() + timedelta(days=1))] == [fact.id]
    assert [f.text for f in MemoryStore(store.path).facts] == ["The user likes tea."]


# ── provenance and the tools ──


async def test_remember_keeps_the_owners_words_it_came_from(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    tools = tools_for(store, provenance=lambda: ("said", "remember that Ann\x00 is my co-founder"))
    out = await tools["remember"](
        {"fact": "Ann is the user's co-founder.", "category": "people", "confidence": "high"}
    )
    assert not out.get("is_error")
    [fact] = store.facts
    assert (fact.source, fact.origin) == ("said", "remember that Ann is my co-founder")
    answer = said(await tools["why_i_know"]({"what": "Ann"}))
    assert "you told me on" in answer and "“remember that Ann is my co-founder”" in answer
    out = await tools["remember"]({"fact": "The user is in Rome.", "expires": "yesterday"})
    assert out["is_error"] and "isn't a date" in said(out) and len(store.facts) == 1


@pytest.mark.parametrize(
    ("source", "origin", "expected"),
    [
        ("settings", "", "you added it in Settings"),
        ("noticed", "I'm allergic to peanuts", "I noticed it in what you said"),
        ("proposed", "my sister Ada", "you approved it"),
        ("dream", "daily note of 2026-09-27", "going over your daily notes"),
        (
            "import",
            "ChatGPT export (export.zip)",
            "you imported it from ChatGPT export (export.zip)",
        ),
    ],
)
def test_why_says_how_each_kind_was_learned(source, origin, expected):
    fact = Fact(
        "a",
        "The user likes tea.",
        "2026-09-22T10:00:00",
        source=source,
        origin=origin,
        learned="2026-09-22T10:00:00",
    )
    assert expected in why(fact) and "Tuesday 22 September 2026" in why(fact)


async def test_edit_memory_corrects_one_fact_and_asks_which_when_several(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    store.add("Ann is the user's partner.")
    store.add("Ann's birthday is May 3.")
    asked = []

    async def gate(action, question):
        asked.append((action, question))
        return True

    tools = tools_for(store, gate=gate)
    out = await tools["edit_memory"]({"what": "Ann", "text": "Ann is the user's co-founder."})
    assert out["is_error"] and "several" in said(out)
    fact = store.facts[0]
    out = await tools["edit_memory"]({"what": fact.id, "text": "Ann is the user's co-founder."})
    assert not out.get("is_error") and store.facts[0].text == "Ann is the user's co-founder."
    assert asked == [
        ("edit_memory", "Change “Ann is the user's partner.” to “Ann is the user's co-founder.”?")
    ]
    out = await tools["edit_memory"]({"what": fact.id})
    assert "Say what to change" in said(out)


async def test_forget_learned_by_source_asks_with_the_list(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    for i in range(5):
        store.add(f"Imported fact {i} qq{i}", source="import", origin="ChatGPT export (export.zip)")
    store.add(
        "From Claude's file.",
        source="import",
        origin="Claude Code memory file (~/.claude/CLAUDE.md)",
    )
    store.add("The user likes tea.", source="said")
    cards, gated = [], []

    async def confirm(question, detail):
        cards.append((question, detail))
        return len(cards) > 1  # no the first time, yes the second

    async def gate(action, question):
        gated.append(action)
        return True

    tools = tools_for(store, gate=gate, confirm=confirm)
    out = await tools["forget_learned"]({"source": "chatgpt"})
    assert out["is_error"] and len(store.facts) == 7
    assert (
        cards[0][0] == "Forget 5 things I learned that way?"
        and "• Imported fact 0 qq0" in cards[0][1]
    )
    out = await tools["forget_learned"]({"source": "chatgpt"})
    assert "Forgot 5" in said(out) and len(store.facts) == 2
    out = await tools["forget_learned"]({"source": "claude code"})  # one: the gate, as forget
    assert "Forgot 1" in said(out) and gated == ["forget"]
    assert [f.text for f in store.facts] == ["The user likes tea."]
    out = await tools["forget_learned"]({"source": "horoscopes"})
    assert out["is_error"] and "conversations, Settings" in said(out)
    assert "Nothing I remember" in said(await tools["forget_learned"]({"source": "dreams"}))


async def test_forgetting_many_without_a_list_card_still_asks(tmp_path):
    from jarvis.hub import FEATURE_ASKED

    store = MemoryStore(tmp_path / "memory.json")
    for i in range(5):
        store.add(f"Imported fact {i} qq{i}", source="import", origin="ChatGPT export (x.zip)")
    gated = []

    async def gate(action, question):
        gated.append(action)
        return False

    out = await tools_for(store, gate=gate)["forget_learned"]({"source": "chatgpt"})
    assert out["is_error"] and len(store.facts) == 5
    assert gated == ["forget_learned"] and "forget_learned" not in FEATURE_ASKED


def test_where_by_day_and_stretch(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    for day in ("2026-09-20", "2026-09-22", "2026-09-25"):
        store.facts.append(
            Fact(
                day,
                f"Learned on {day}",
                f"{day}T09:00:00",
                source="said",
                learned=f"{day}T09:00:00",
            )
        )
    assert [f.id for f in store.where(day="2026-09-22")] == ["2026-09-22"]
    assert [f.id for f in store.where(since="2026-09-21")] == ["2026-09-22", "2026-09-25"]
    assert [f.id for f in store.where(source="conversations", until="2026-09-22")] == [
        "2026-09-20",
        "2026-09-22",
    ]
    assert store.where() == []
    with pytest.raises(ValueError, match="isn't a date"):
        store.where(day="last Tuesday")


async def test_incognito_keeps_nothing_new_but_still_forgets(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    store.add("The user likes jazz.")
    reason = "Incognito is on: nothing from this conversation is kept."
    tools = tools_for(store, paused=lambda: reason)
    out = await tools["remember"]({"fact": "The user likes blues."})
    assert out["is_error"] and said(out) == reason
    out = await tools["edit_memory"]({"what": "jazz", "text": "The user likes swing."})
    assert out["is_error"] and store.facts[0].text == "The user likes jazz."
    assert "Forgot" in said(await tools["forget"]({"what": "jazz"})) and store.facts == []


async def test_recall_lists_category_and_how_sure(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    store.add("Ann might move to London.", confidence="low", category="people")
    listed = said(await tools_for(store)["recall"]({"query": "people"}))
    assert listed.endswith("Ann might move to London. (people; not sure)")


def test_public_carries_every_field_newest_first(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    store.add("The user likes tea.")
    store.add("Ann is the user's co-founder.", source="said", origin="remember Ann")
    first = store.public()[0]
    assert first["text"] == "Ann is the user's co-founder." and first["origin"] == "remember Ann"
    assert set(first) >= {"category", "confidence", "expires", "source", "learned", "at"}
    assert datetime.fromisoformat(first["learned"])
    assert store.counts()["people"] == 1 and store.counts()["preferences"] == 1
