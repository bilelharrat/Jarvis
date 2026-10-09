"""Importing memories: a ChatGPT export (its memories and custom instructions, never its
conversations), Claude Code's CLAUDE.md (read only, on the owner's click) and a pasted
list, each shown for review; only what the owner picks is saved, with its provenance."""

import json
import zipfile
from pathlib import Path

import pytest
from memory_fakes import desk_of, drain, make_hub

from jarvis import memory_import
from jarvis.memory import MAX_FACTS, Fact
from jarvis.memory_import import (
    NotImportable,
    checked_path,
    from_chatgpt,
    from_claude_md,
    from_text,
)


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


@pytest.fixture
def desk(hub):
    return desk_of(hub)


def review_of(q):
    [event] = [e for e in drain(q) if e["type"] == "memory_import_review"]
    return event


def export_zip(path: Path, with_memories: bool = True) -> Path:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "conversations.json",
            json.dumps(
                [
                    {
                        "title": "x",
                        "mapping": {"a": {"message": {"content": "remember I hate cilantro"}}},
                    }
                ]
            ),
        )
        archive.writestr(
            "user.json", json.dumps({"email": "me@x.com", "phone_number": "+15105550100"})
        )
        if with_memories:
            archive.writestr(
                "user_memories.json",
                json.dumps(
                    {
                        "memories": [
                            {"content": "Is a partner at a venture fund in Berkeley"},
                            {"content": "Prefers concise answers"},
                            "Has two kids, Maya and Leo",
                            {"content": "Bank password is hunter2"},
                            {"content": "Prefers concise answers"},
                        ]
                    }
                ),
            )
            archive.writestr(
                "custom_instructions.json",
                json.dumps(
                    {
                        "about_user_message": "I run a small fund.\nI live in Berkeley.",
                        "about_model_message": "Be brief. No emojis.",
                    }
                ),
            )
    return path


def test_a_chatgpt_export_gives_its_memories_and_instructions(tmp_path):
    review = from_chatgpt(export_zip(tmp_path / "chatgpt-export.zip"))
    assert [i["text"] for i in review.items] == [
        "Is a partner at a venture fund in Berkeley",
        "Prefers concise answers",
        "Has two kids, Maya and Leo",
    ]
    assert review.about == "I run a small fund.\nI live in Berkeley."
    assert review.behave == "Be brief. No emojis."
    assert review.origin == "ChatGPT export (chatgpt-export.zip)"
    assert any("password" in n for n in review.notes)
    assert all("cilantro" not in i["text"] and "me@x.com" not in i["text"] for i in review.items)


def test_an_export_without_memories_says_where_they_are(tmp_path):
    review = from_chatgpt(export_zip(tmp_path / "export.zip", with_memories=False))
    assert review.items == [] and "Manage memories" in review.notes[-1]


def test_a_json_or_text_file_of_memories_works_too(tmp_path):
    (tmp_path / "memories.json").write_text(
        json.dumps({"memory": ["Likes jazz a lot", "Runs on Saturdays"]})
    )
    assert [i["text"] for i in from_chatgpt(tmp_path / "memories.json").items] == [
        "Likes jazz a lot",
        "Runs on Saturdays",
    ]
    (tmp_path / "memories.txt").write_text("- Likes jazz a lot\n- Runs on Saturdays\n")
    assert len(from_chatgpt(tmp_path / "memories.txt").items) == 2


def test_big_or_broken_files_are_refused_plainly(tmp_path):
    with zipfile.ZipFile(tmp_path / "big.zip", "w") as archive:
        archive.writestr("memories.json", "[" + ",".join(['"x"'] * 10) + "]")
        info = zipfile.ZipInfo("memory_2.json")
        archive.writestr(info, "x" * (memory_import.MAX_JSON + 10))
    review = from_chatgpt(tmp_path / "big.zip")
    assert any("too big" in n for n in review.notes)
    (tmp_path / "bad.zip").write_text("not a zip")
    with pytest.raises(NotImportable, match="zip"):
        from_chatgpt(tmp_path / "bad.zip")


def test_only_a_file_in_the_home_folder_of_a_known_kind(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    (home / "export.zip").write_bytes(b"x")
    (home / "notes.exe").write_bytes(b"x")
    (tmp_path / "outside.zip").write_bytes(b"x")
    assert checked_path(home / "export.zip", home) == (home / "export.zip").resolve()
    with pytest.raises(NotImportable, match="home folder"):
        checked_path(tmp_path / "outside.zip", home)
    with pytest.raises(NotImportable, match=".zip"):
        checked_path(home / "notes.exe", home)
    with pytest.raises(NotImportable, match="can't be found"):
        checked_path(home / "missing.zip", home)
    (home / "link.zip").symlink_to(tmp_path / "outside.zip")
    with pytest.raises(NotImportable, match="home folder"):
        checked_path(home / "link.zip", home)


def test_claude_codes_file_gives_its_lines_not_its_headings_or_code(tmp_path):
    path = tmp_path / "CLAUDE.md"
    path.write_text(
        "# My preferences\n\n- Always use uv for Python.\n- Never push to main.\n\n"
        "```sh\nrm -rf /\n```\n<!-- a comment -->\n| a | b |\n"
        "I work on BSH Research Center. It's a Mac app for investors.\n"
    )
    review = from_claude_md(path)
    assert [i["text"] for i in review.items] == [
        "Always use uv for Python.",
        "Never push to main.",
        "I work on BSH Research Center.",
        "It's a Mac app for investors.",
    ]
    assert review.origin == "Eden Code's memory file (~/.claude/CLAUDE.md)"
    with pytest.raises(NotImportable, match="no ~/.claude/CLAUDE.md"):
        from_claude_md(tmp_path / "missing.md")


def test_a_pasted_list():
    review = from_text(
        "• My sister is Ada\n2. I like tea\nok\nmy api key is sk-abcdef1234567890abcd"
    )
    assert [i["text"] for i in review.items] == ["My sister is Ada", "I like tea"]
    assert [i["category"] for i in review.items] == ["people", "preferences"]
    assert review.notes == ["1 that looked like a password, key or account number was left out."]


async def test_nothing_is_saved_until_the_owner_picks(hub, desk, tmp_path):
    q = hub.subscribe()
    await desk.cmd_import(
        {"kind": "paste", "text": "My sister is Ada\nI like tea\nI swim on Fridays"}
    )
    review = review_of(q)
    assert len(review["items"]) == 3 and hub.memory.facts == [] and review["room"] == MAX_FACTS
    first, second, _third = review["items"]
    await hub.handle(
        {
            "type": "memory_import_save",
            "review": review["id"],
            "items": [
                {"id": first["id"], "text": "My sister is Ada Lovelace"},
                {"id": second["id"]},
                {"id": "nope"},
            ],
        }
    )
    assert [(f.text, f.source, f.origin) for f in hub.memory.facts] == [
        ("My sister is Ada Lovelace", "import", "a pasted list"),
        ("I like tea", "import", "a pasted list"),
    ]
    events = drain(q)
    assert any(e["type"] == "toast" and "Saved 2" in e["text"] for e in events)
    assert any(e["type"] == "memory_import_review" and e.get("done") for e in events)
    await hub.handle(
        {"type": "memory_import_save", "review": review["id"], "items": [{"id": _third["id"]}]}
    )
    assert "closed" in review_of(q)["error"] and len(hub.memory.facts) == 2


async def test_claude_md_is_read_only_when_asked_and_about_me_only_when_picked(hub, desk, tmp_path):
    desk.claude_md = tmp_path / "CLAUDE.md"
    desk.claude_md.write_text("- Always use uv for Python.\n")
    q = hub.subscribe()
    await desk.cmd_import({"kind": "claude"})
    review = review_of(q)
    assert (
        review["source"] == "claude"
        and desk.claude_md.read_text() == "- Always use uv for Python.\n"
    )
    zip_path = export_zip(tmp_path / "export.zip")  # a temp folder: outside the home folder
    await desk.cmd_import({"kind": "chatgpt", "path": str(zip_path)})
    assert "home folder" in review_of(q)["error"]
    desk.review = memory_import.from_chatgpt(zip_path)
    review = desk.review.public()
    await hub.handle(
        {"type": "memory_import_save", "review": review["id"], "items": [], "behave": True}
    )
    assert desk.about.texts == {"about": "", "behave": "Be brief. No emojis."}
    assert hub.memory.facts == []


async def test_an_import_bigger_than_the_room_left_saves_what_fits(hub, desk):
    hub.memory.facts = [Fact(f"f{i}", f"Old fact {i} zq{i}", "") for i in range(MAX_FACTS - 1)]
    q = hub.subscribe()
    await desk.cmd_import({"kind": "paste", "text": "I like tea\nMy sister is Ada"})
    review = review_of(q)
    assert review["room"] == 1
    await hub.handle(
        {
            "type": "memory_import_save",
            "review": review["id"],
            "items": [{"id": i["id"]} for i in review["items"]],
        }
    )
    assert len(hub.memory.facts) == MAX_FACTS and hub.memory.facts[0].text == "Old fact 0 zq0"
    toast = [e for e in drain(q) if e["type"] == "toast"][-1]
    assert "Saved 1" in toast["text"] and "1 didn't fit" in toast["text"]
