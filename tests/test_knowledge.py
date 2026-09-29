import json

from jarvis.knowledge import (
    Collector,
    KnowledgeBase,
    Note,
    chunk_text,
    collect_apple_notes,
    collect_folder,
    layout,
)


def note(i, title, text, source="files"):
    return Note(id=f"{source}:{i}", source=source, title=title, text=text, ref=str(i))


CORPUS = [
    note(1, "Sourdough starter", "Feed the sourdough starter flour and water daily; bake bread."),
    note(2, "Bread baking temps", "Bake the sourdough bread at 250C with steam, then lower."),
    note(3, "ZaiNar risks", "Key risks: RF positioning adoption, telecom sales cycles, capital."),
    note(4, "Wi-Fi positioning", "Positioning over Wi-Fi and 5G networks; RF phase sync patents."),
    note(5, "Marathon plan", "Long run on Sunday, tempo run Tuesday, rest on Monday."),
    note(6, "Running shoes", "Rotate running shoes for the marathon; long run mileage."),
]


def test_search_ranks_the_right_note(tmp_path):
    kb = KnowledgeBase(tmp_path / "index.json")
    kb.build({"files": CORPUS})
    hits = kb.search("what are the risks for ZaiNar positioning")
    assert hits[0]["title"] == "ZaiNar risks"
    assert hits[0]["id"] == "files:3"
    assert "risks" in hits[0]["excerpt"].lower()
    assert kb.search("") == []


def test_galaxy_has_a_point_per_note_and_persists(tmp_path):
    kb = KnowledgeBase(tmp_path / "index.json")
    kb.build({"files": CORPUS})
    kb.save()
    again = KnowledgeBase(tmp_path / "index.json")
    assert again.load()
    galaxy = again.galaxy()
    assert len(galaxy["nodes"]) == 6
    assert all(len(n["p"]) == 3 and all(-1.5 <= v <= 1.5 for v in n["p"]) for n in galaxy["nodes"])
    assert again.get("files:5").title == "Marathon plan"


def test_layout_small_inputs():
    assert layout([])[0].shape == (0, 3)
    assert layout(["one", "two"])[0].shape == (2, 3)


def test_chunking_splits_long_text():
    chunks = chunk_text("T", "para one\n\n" + "x" * 3000)
    assert len(chunks) >= 3 and all(len(c) <= 1300 for c in chunks)


def test_collect_folder_reads_text_and_skips_hidden(tmp_path):
    (tmp_path / "ideas.md").write_text("# Big idea\nBuild JARVIS.")
    (tmp_path / ".secret.md").write_text("nope")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "x.md").write_text("nope")
    notes = collect_folder(tmp_path)
    assert [n.title for n in notes] == ["Big idea"]


def test_collect_apple_notes_parses_jxa_output():
    payload = json.dumps(
        [
            {
                "id": "x-coredata://1",
                "title": "Groceries",
                "text": "Milk\nEggs",
                "folder": "Notes",
                "modified": "",
            },
            {
                "id": "x-coredata://2",
                "title": "Empty",
                "text": "  ",
                "folder": "Notes",
                "modified": "",
            },
        ]
    )
    notes = collect_apple_notes(run=lambda _script: payload)
    assert [(n.id, n.group) for n in notes] == [("notes:x-coredata://1", "Notes")]


def test_partial_rebuild_keeps_other_sources(tmp_path, monkeypatch):
    kb = KnowledgeBase(tmp_path / "index.json")
    kb.build(
        {"bsh": [note(9, "BSH memo", "memo text about ZaiNar", source="bsh")], "files": CORPUS[:2]}
    )
    folder = tmp_path / "docs"
    folder.mkdir()
    (folder / "new.md").write_text("# New note\nfresh content")
    monkeypatch.setattr("jarvis.knowledge.RESEARCH_DIR", tmp_path / "research")
    Collector(kb, bsh_dir=tmp_path).run(
        notes=False, bsh=True, folders=[str(folder)], only={"files"}
    )
    titles = {n.title for n in kb.notes}
    assert "BSH memo" in titles  # untouched source kept
    assert "New note" in titles and "Sourdough starter" not in titles  # refreshed source replaced
