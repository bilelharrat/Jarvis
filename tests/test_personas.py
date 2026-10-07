"""The owner's own personas (personas.py): kept beside the built-in three, tidied, bounded,
with ids that never change, registered so Settings, the system prompt and set_personality
treat them as they treat JARVIS, TARS and FRIDAY."""

import json

import pytest

from jarvis import lang, personas, prefs
from jarvis.personas import PersonaStore, make_id


@pytest.fixture(autouse=True)
def _personas_put_back():
    """A test's personas never outlast it: the built-in three, as they were."""
    kept = [
        (table, dict(table))
        for table in (prefs.PERSONAS, lang.ZH_PERSONAS, personas.FIELDS, personas.KNOWN)
    ]
    listeners = list(personas.LISTENERS)
    yield
    for table, before in kept:
        table.clear()
        table.update(before)
    personas.LISTENERS[:] = listeners


ALFRED = {
    "name": "Alfred",
    "description": "A gentle old butler, patient and warm.",
    "zh_name": "阿尔弗雷德",
    "zh_description": "一位温和的老管家，耐心又亲切。",
    "humor": 30,
}


def test_ids_come_from_the_name_and_never_clash():
    assert make_id("Alfred", set()) == "alfred"
    assert make_id("Alfred", {"alfred"}) == "alfred-2"
    assert make_id("Mr. Jeeves the Third", set()) == "mr-jeeves-the-th"
    assert make_id("小爱", set()) == "persona-1"
    assert make_id("小爱", {"persona-1"}) == "persona-2"
    assert make_id("Jarvis", set()) == "jarvis-2"  # never a built-in's
    assert make_id("007", set()) == "persona-1"


def test_a_persona_is_kept_tidied_and_changed_by_its_id(tmp_path):
    store = PersonaStore(tmp_path / "personas.json")
    made = store.put({**ALFRED, "name": "  Alfred\u202e ", "humor": 250})
    assert (made.id, made.name, made.humor) == ("alfred", "Alfred", 100)
    changed = store.put({**ALFRED, "id": "alfred", "name": "Jeeves", "humor": 10})
    assert (changed.id, changed.name, changed.humor) == ("alfred", "Jeeves", 10)
    again = PersonaStore(tmp_path / "personas.json")
    assert [p.public() for p in again.items] == [changed.public()]
    with pytest.raises(ValueError, match="name"):
        store.put({**ALFRED, "name": " "})
    with pytest.raises(ValueError, match="Describe"):
        store.put({**ALFRED, "description": ""})
    with pytest.raises(ValueError, match="isn't there"):
        store.put({**ALFRED, "id": "nobody"})
    assert store.remove("alfred").name == "Jeeves" and store.items == []


def test_there_is_room_for_eight(tmp_path):
    store = PersonaStore(tmp_path / "personas.json")
    for n in range(personas.MAX_PERSONAS):
        store.put({**ALFRED, "name": f"Butler {n}"})
    with pytest.raises(ValueError, match="room for 8"):
        store.put({**ALFRED, "name": "One too many"})


def test_a_damaged_or_odd_file_never_stops_the_start(tmp_path):
    path = tmp_path / "personas.json"
    path.write_text(
        json.dumps(
            [
                {**ALFRED, "id": "alfred"},
                {**ALFRED, "id": "jarvis"},  # never a built-in's
                {**ALFRED, "id": "../x"},
                {"id": "empty", "name": "Empty"},  # no description
                {**ALFRED, "id": "alfred"},  # the same id twice
                "junk",
            ]
        )
    )
    assert [p.id for p in PersonaStore(path).items] == ["alfred"]
    path.write_text("{torn")
    assert PersonaStore(path).items == []


def test_a_humor_no_number_can_hold_is_the_one_it_starts_with(tmp_path):
    """JSON can hold NaN and Infinity, which no humor is: the persona keeps the usual 60,
    and the file still reads (it lost every persona at startup before)."""
    path = tmp_path / "personas.json"
    path.write_text(
        '[{"id": "alfred", "name": "Alfred", "description": "A butler.", "humor": NaN},'
        ' {"id": "ada", "name": "Ada", "description": "A mathematician.", "humor": -Infinity}]'
    )
    store = PersonaStore(path)
    assert [(p.id, p.humor) for p in store.items] == [("alfred", 60), ("ada", 60)]
    assert store.put({**ALFRED, "humor": float("inf")}).humor == 60
    assert store.put({**ALFRED, "name": "Bruce", "humor": 250}).humor == 100


def test_registered_ones_are_chosen_like_the_built_in_three(tmp_path):
    store = PersonaStore(tmp_path / "personas.json")
    alfred = store.put(ALFRED)
    personas.register(store.items)
    assert prefs.PERSONAS["alfred"] == ("Alfred", ALFRED["description"])
    assert lang.persona_for_prompt("alfred", "zh") == ("Alfred", ALFRED["zh_description"])
    assert {"id": "alfred", "name": "阿尔弗雷德"} in lang.personas_payload("zh")
    kept = prefs.Prefs()
    assert kept.update({"persona": "alfred"}) == ["persona"]
    personas.register([], dropped=[alfred.id, "jarvis"])
    assert "alfred" not in prefs.PERSONAS and "jarvis" in prefs.PERSONAS  # built-ins stay
    assert set(lang.ZH_PERSONAS) == set(prefs.PERSONAS)


def test_without_chinese_the_english_stands_in(tmp_path):
    store = PersonaStore(tmp_path / "personas.json")
    store.put({"name": "Sage", "description": "Calm and wise."})
    personas.register(store.items)
    assert lang.ZH_PERSONAS["sage"] == ("Sage", "Calm and wise.")


def test_fields_other_features_register_are_kept_for_them(tmp_path):
    personas.register_field("voice", lambda v: v if v in ("Daniel", "Kate") else None)
    store = PersonaStore(tmp_path / "personas.json")
    made = store.put({**ALFRED, "extra": {"voice": "Kate", "wake_words": ["alfred"]}})
    assert made.extra == {"voice": "Kate", "wake_words": ["alfred"]}  # unknown: kept as is
    changed = store.put({**ALFRED, "id": made.id, "extra": {"voice": "Bogus"}})
    assert changed.extra == {"voice": "Kate", "wake_words": ["alfred"]}  # a bad value: kept old


def test_whoever_listens_hears_them_and_one_that_fails_costs_nothing(tmp_path):
    heard = []
    personas.add_listener(lambda items: heard.append([p.id for p in items]))
    personas.add_listener(lambda items: 1 / 0)
    store = PersonaStore(tmp_path / "personas.json")
    alfred = store.put(ALFRED)
    personas.register(store.items)
    store.put({"name": "Sage", "description": "Calm and wise."})
    personas.register(store.items)
    personas.register(store.items[1:], dropped=[alfred.id])
    assert heard == [["alfred"], ["alfred", "sage"], ["sage"]]
    assert "alfred" not in prefs.PERSONAS and set(personas.KNOWN) == {"sage"}
