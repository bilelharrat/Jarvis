import pytest

from jarvis.memory import MemoryStore, build_tools


def test_remember_recall_forget(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    store.add("Ann Lee is the user's co-founder.")
    store.add("The user takes their coffee black.")
    assert [f.text for f in store.search("who is Ann")] == ["Ann Lee is the user's co-founder."]
    assert "coffee black" in store.prompt_block()
    again = MemoryStore(tmp_path / "memory.json")  # survives a restart
    assert len(again.facts) == 2
    assert [f.text for f in again.forget("coffee")] == ["The user takes their coffee black."]
    assert len(MemoryStore(tmp_path / "memory.json").facts) == 1


def test_restating_a_fact_replaces_it(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    store.add("The user's gym is Equinox on Market Street.")
    store.add("The user's gym is the Equinox on Market Street.")
    assert len(store.facts) == 1


@pytest.mark.parametrize(
    "secret",
    [
        "My bank password is hunter2",
        "The Fish API key is sk-fish-abcdef123456",
        "Card 4242 4242 4242 4242 expires 12/30",
    ],
)
def test_secrets_are_never_stored(tmp_path, secret):
    store = MemoryStore(tmp_path / "memory.json")
    with pytest.raises(ValueError, match="don't keep"):
        store.add(secret)
    assert store.facts == []


async def test_tools_round_trip(tmp_path):
    store = MemoryStore(tmp_path / "memory.json")
    changes = []
    tools = {t.name: t.handler for t in build_tools(store, lambda: changes.append(1))}
    out = await tools["remember"]({"fact": "The user prefers aisle seats."})
    assert "aisle seats" in out["content"][0]["text"] and changes == [1]
    refused = await tools["remember"]({"fact": "my password is swordfish"})
    assert refused["is_error"] and len(store.facts) == 1
    listed = await tools["recall"]({"query": ""})
    assert "aisle seats" in listed["content"][0]["text"]
    gone = await tools["forget"]({"what": store.facts[0].id})
    assert "Forgot" in gone["content"][0]["text"] and store.facts == [] and changes == [1, 1]
