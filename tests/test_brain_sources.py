"""The second brain's newer sources (jarvis.brain_sources): JARVIS's own conversations,
Safari and other browsers' bookmarks, Reminders and Voice Memos. Every one is read from temp
folders and fakes here, never the real Messages, Safari, Reminders or Voice Memos data."""

import json
import os
import plistlib
import sqlite3
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from jarvis import brain_sources, delegate, meeting, reminders_kit
from jarvis.brain_sources import (
    ONE_OFF,
    collect_bookmarks,
    collect_conversations,
    collect_reminders,
    collect_safari,
    collect_voice_memos,
    extra_sources,
    finisher,
)
from jarvis.knowledge import Collector, KnowledgeBase

# ── conversations ──


def said(kind, content):
    return SimpleNamespace(type=kind, message={"content": content}, uuid="u")


def session(sid, messages, title=None, when=1_790_000_000_000, size=1000):
    return (
        SimpleNamespace(session_id=sid, last_modified=when, custom_title=title, file_size=size),
        messages,
    )


def fake_sdk(sessions):
    by_id = {info.session_id: messages for info, messages in sessions}
    listed = []

    def list_sessions(directory, limit, include_worktrees):
        listed.append((directory, limit, include_worktrees))
        return [info for info, _ in sessions][:limit]

    def get_messages(sid, directory):
        if by_id[sid] is None:
            raise ValueError("damaged record")
        return by_id[sid]

    return list_sessions, get_messages, listed


CHAT = [
    said("user", "[Note from the app: the weather is 18°C and sunny]\n\nWhat's on my calendar?"),
    said(
        "assistant",
        [
            {"type": "tool_use", "id": "t1", "name": "mcp__mac__list_events", "input": {}},
        ],
    ),
    said("user", [{"type": "tool_result", "tool_use_id": "t1", "content": "Dentist at 3pm"}]),
    said("assistant", [{"type": "text", "text": "Just the dentist at three."}]),
    said("user", "<system-reminder>internal</system-reminder>Move it to Friday"),
    said("user", "<task-notification>a background task finished</task-notification>"),
    said("assistant", [{"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": "Done."}]),
]


def test_a_conversation_keeps_both_sides_words_and_nothing_else(tmp_path):
    folder = tmp_path / "workspace"
    folder.mkdir()
    list_sessions, get_messages, listed = fake_sdk([session("s1", CHAT, title="Calendar")])
    notes = collect_conversations(
        folder, tmp_path / "saved", list_sessions=list_sessions, get_messages=get_messages
    )
    assert listed == [(str(folder), brain_sources.MAX_SESSIONS, False)]
    [n] = notes
    assert n.source == "conversations" and n.id == "conversation:s1:1" and n.title == "Calendar"
    assert "You: What's on my calendar?" in n.text
    assert "Jarvis: Just the dentist at three." in n.text and "You: Move it to Friday" in n.text
    for hidden in ("Note from the app", "18°C", "Dentist at 3pm", "internal", "hmm", "task"):
        assert hidden not in n.text
    assert n.modified.startswith("2026-")


def test_one_off_sessions_in_the_brains_folder_are_not_conversations(tmp_path):
    folder = tmp_path / "workspace"
    folder.mkdir()
    summary = meeting.SUMMARY_PROMPT.format(title="Standup", date="Monday", transcript="hello")
    drafts = [
        delegate.conversation_text([]),
        delegate.conversation_text([{"from": "them", "text": "hi", "at": ""}]),
    ]
    # What those modules really send still starts the way ONE_OFF expects.
    assert summary.startswith(ONE_OFF) and all(d.startswith(ONE_OFF) for d in drafts)
    sessions = [
        session(
            "m", [said("user", summary), said("assistant", [{"type": "text", "text": "# Notes"}])]
        ),
        session(
            "d", [said("user", drafts[1]), said("assistant", [{"type": "text", "text": "{}"}])]
        ),
        session("unanswered", [said("user", "hello?")]),
        session("broken", None),
        session("ok", [said("user", "Remind me about taxes"), said("assistant", "On it.")]),
    ]
    list_sessions, get_messages, _ = fake_sdk(sessions)
    notes = collect_conversations(
        folder, tmp_path / "saved", list_sessions=list_sessions, get_messages=get_messages
    )
    assert [n.ref for n in notes] == ["ok"]


def test_a_long_conversation_is_kept_in_parts_read_note_returns_whole(tmp_path):
    folder = tmp_path / "workspace"
    folder.mkdir()
    turns = []
    for i in range(60):
        turns += [
            said("user", f"Question {i} " + "about the plan " * 20),
            said("assistant", "Answer " * 60),
        ]
    list_sessions, get_messages, _ = fake_sdk([session("long", turns)])
    notes = collect_conversations(
        folder, tmp_path / "saved", list_sessions=list_sessions, get_messages=get_messages
    )
    assert len(notes) > 2
    assert all(len(n.text) <= brain_sources.PART_CHARS + 200 for n in notes)
    assert notes[1].title.startswith("Question") and notes[1].id == "conversation:long:2"
    assert len({n.id for n in notes}) == len(notes)


def test_saved_conversations_are_read_and_records_past_the_size_budget_are_not(
    tmp_path, monkeypatch
):
    folder = tmp_path / "workspace"
    folder.mkdir()
    saved = tmp_path / "saved"
    saved.mkdir()
    (saved / "Conversation 2026-09-01 10.00.md").write_text("# Conversation\n\n**You**\n\nHi there")
    monkeypatch.setattr(brain_sources, "MAX_SESSION_BYTES", 1500)
    sessions = [
        session("a", [said("user", "first"), said("assistant", "one")], size=1000),
        session("b", [said("user", "second"), said("assistant", "two")], size=1000),
    ]
    list_sessions, get_messages, _ = fake_sdk(sessions)
    notes = collect_conversations(
        folder, saved, list_sessions=list_sessions, get_messages=get_messages
    )
    assert [n.ref for n in notes if n.id.startswith("conversation:")] == ["a"]
    assert any(n.id.startswith("file:") and n.source == "conversations" for n in notes)


def test_no_brain_folder_yet_means_no_conversations(tmp_path):
    def never(**_kw):
        raise AssertionError("listed a folder that isn't there")

    assert (
        collect_conversations(
            tmp_path / "none", tmp_path / "saved", list_sessions=never, get_messages=never
        )
        == []
    )


# ── Safari ──


def safari_plist(path, added=datetime(2026, 9, 1, 12, 0)):
    data = {
        "WebBookmarkType": "WebBookmarkTypeList",
        "Children": [
            {"WebBookmarkType": "WebBookmarkTypeProxy", "Title": "History"},
            {
                "WebBookmarkType": "WebBookmarkTypeList",
                "Title": "BookmarksBar",
                "Children": [
                    {
                        "WebBookmarkType": "WebBookmarkTypeLeaf",
                        "URLString": "https://example.com/pricing",
                        "URIDictionary": {"title": "Example pricing"},
                        "WebBookmarkUUID": "A1",
                    },
                    {
                        "WebBookmarkType": "WebBookmarkTypeLeaf",
                        "URLString": "javascript:alert(1)",
                        "URIDictionary": {"title": "A bookmarklet"},
                    },
                ],
            },
            {
                "WebBookmarkType": "WebBookmarkTypeList",
                "Title": "com.apple.ReadingList",
                "Children": [
                    {
                        "WebBookmarkType": "WebBookmarkTypeLeaf",
                        "URLString": "https://news.example.org/story",
                        "URIDictionary": {"title": "A long read"},
                        "WebBookmarkUUID": "B2",
                        "ReadingList": {"PreviewText": "Why batteries matter.", "DateAdded": added},
                    }
                ],
            },
        ],
    }
    path.write_bytes(plistlib.dumps(data, fmt=plistlib.FMT_BINARY))


def test_safari_bookmarks_and_reading_list_become_notes(tmp_path):
    path = tmp_path / "Bookmarks.plist"
    safari_plist(path)
    notes = {n.title: n for n in collect_safari(path)}
    assert set(notes) == {"Example pricing", "A long read"}  # no bookmarklet, no History
    bar, reading = notes["Example pricing"], notes["A long read"]
    assert bar.group == "Favourites" and bar.ref == "https://example.com/pricing"
    assert reading.group == "Reading List" and "Why batteries matter." in reading.text
    local = datetime(2026, 9, 1, 12, 0, tzinfo=UTC).astimezone().replace(tzinfo=None)
    assert reading.modified == local.isoformat(timespec="seconds")


def test_safari_without_full_disk_access_says_how_to_allow_it(tmp_path):
    path = tmp_path / "Bookmarks.plist"
    safari_plist(path)
    path.chmod(0)
    try:
        with pytest.raises(PermissionError, match="Full Disk Access"):
            collect_safari(path)
    finally:
        path.chmod(0o600)
    assert collect_safari(tmp_path / "missing.plist") == []
    (tmp_path / "bad.plist").write_bytes(b"not a plist")
    with pytest.raises(RuntimeError):
        collect_safari(tmp_path / "bad.plist")


# ── Chrome, Arc, Brave, Edge ──


def chrome_file(profile, entries):
    profile.mkdir(parents=True)
    (profile / "Bookmarks").write_text(
        json.dumps(
            {
                "roots": {
                    "bookmark_bar": {
                        "type": "folder",
                        "name": "Bookmarks bar",
                        "children": entries,
                    },
                    "other": {"type": "folder", "name": "Other", "children": []},
                }
            }
        )
    )


def test_every_profiles_bookmarks_and_arcs_sidebar_become_notes(tmp_path):
    chrome = tmp_path / "Chrome"
    chrome_file(
        chrome / "Default",
        [
            {
                "type": "url",
                "name": "Q3 dashboard",
                "url": "https://dash.example.com",
                "guid": "g1",
                "date_added": "13400000000000000",
            },
            {
                "type": "folder",
                "name": "Research",
                "children": [
                    {
                        "type": "url",
                        "name": "Paper",
                        "url": "https://arxiv.org/abs/1",
                        "guid": "g2",
                    },
                    {"type": "url", "name": "Local", "url": "file:///etc/passwd", "guid": "g3"},
                ],
            },
        ],
    )
    chrome_file(
        chrome / "Profile 1",
        [{"type": "url", "name": "Work wiki", "url": "https://wiki.example.com"}],
    )
    sidebar = tmp_path / "StorableSidebar.json"
    sidebar.write_text(
        json.dumps(
            {
                "sidebar": {
                    "containers": [
                        {},
                        {
                            "items": [
                                "id1",
                                {
                                    "id": "id1",
                                    "data": {
                                        "tab": {
                                            "savedURL": "https://linear.app/team",
                                            "savedTitle": "Linear",
                                        }
                                    },
                                },
                            ]
                        },
                    ]
                }
            }
        )
    )
    notes = collect_bookmarks(
        {"Chrome": chrome, "Brave": tmp_path / "none", "Arc": tmp_path / "arc"}, sidebar
    )
    by_title = {n.title: n for n in notes}
    assert set(by_title) == {"Q3 dashboard", "Paper", "Work wiki", "Linear"}
    assert by_title["Paper"].text.endswith("Bookmarked in Chrome: Research.")
    assert by_title["Linear"].group == "Arc" and by_title["Q3 dashboard"].modified.startswith(
        "2025-"
    )
    assert all(n.source == "bookmarks" for n in notes)


def test_a_damaged_bookmarks_file_is_skipped_unless_nothing_else_can_be_read(tmp_path):
    chrome = tmp_path / "Chrome"
    (chrome / "Default").mkdir(parents=True)
    (chrome / "Default" / "Bookmarks").write_text("{not json")
    with pytest.raises(RuntimeError, match="Chrome"):
        collect_bookmarks({"Chrome": chrome}, tmp_path / "none.json")
    chrome_file(
        tmp_path / "Edge" / "Default", [{"type": "url", "name": "Ok", "url": "https://ok.example"}]
    )
    notes = collect_bookmarks({"Chrome": chrome, "Edge": tmp_path / "Edge"}, tmp_path / "none.json")
    assert [n.title for n in notes] == ["Ok"]


# ── Reminders ──


def test_reminders_become_notes_and_no_access_is_said():
    found = {
        "reminders": [
            {
                "id": "r1",
                "title": "Call the dentist",
                "list": "Personal",
                "due": "2026-10-02",
                "notes": "Ask about the crown",
                "completed": False,
            },
            {
                "id": "r2",
                "title": "Send the Q3 memo",
                "list": "Work",
                "completed": True,
                "completed_at": "2026-09-20T10:00",
            },
            {"id": "r3", "title": ""},
            "junk",
        ]
    }
    notes = collect_reminders(lambda: found)
    assert [n.title for n in notes] == ["Call the dentist", "Send the Q3 memo"]
    assert "Due 2026-10-02." in notes[0].text and "Ask about the crown" in notes[0].text
    assert notes[0].group == "Personal" and notes[0].modified == "2026-10-02"
    with pytest.raises(PermissionError, match="Reminders access"):
        collect_reminders(lambda: {"error": reminders_kit.NO_ACCESS})
    with pytest.raises(RuntimeError):
        collect_reminders(lambda: {"error": "Reminders took too long to answer."})


def test_the_helper_keeps_open_reminders_and_last_months_done_ones():
    now = datetime(2026, 9, 29)
    rows = [
        {"title": "Old done", "completed": True, "completed_at": "2026-07-01T09:00"},
        {"title": "Recently done", "completed": True, "completed_at": "2026-09-20T09:00"},
        {"title": "Open later", "completed": False, "due": "2026-12-01"},
        {"title": "Open soon", "completed": False, "due": "2026-10-01"},
        {"title": "", "completed": False},
    ]
    assert [r["title"] for r in reminders_kit.keep(rows, now)] == [
        "Open soon",
        "Open later",
        "Recently done",
    ]


# ── Voice Memos ──


def memos_folder(tmp_path, names):
    folder = tmp_path / "Recordings"
    folder.mkdir()
    for i, name in enumerate(names):
        path = folder / name
        path.write_bytes(os.urandom(2048) + name.encode())
        os.utime(path, (1_790_000_000 + i * 60, 1_790_000_000 + i * 60))
    conn = sqlite3.connect(folder / "CloudRecordings.db")
    conn.execute("CREATE TABLE ZCLOUDRECORDING (ZPATH TEXT, ZENCRYPTEDTITLE TEXT, ZDATE REAL)")
    conn.execute(
        "INSERT INTO ZCLOUDRECORDING VALUES (?, ?, ?)",
        (f"{folder}/{names[0]}", "Standup ideas", 780_000_000.0),
    )
    conn.commit()
    conn.close()
    return folder


def test_voice_memos_are_transcribed_newest_first_a_few_a_rebuild_and_never_twice(tmp_path):
    folder = memos_folder(tmp_path, ["a.m4a", "b.m4a", "c.m4a", "notes.txt"])
    heard = []

    def transcriber():
        def transcribe(path):
            heard.append(path.name)
            return f"words from {path.name} password: hunter2"

        return transcribe

    cache = tmp_path / "brain" / "voicememos.db"
    first = collect_voice_memos(cache, transcriber, [folder], limit=2)
    assert heard == ["c.m4a", "b.m4a"] and len(first) == 2
    assert all("hunter2" not in n.text for n in first)  # blanked like every source
    second = collect_voice_memos(cache, transcriber, [folder], limit=2)
    assert heard == ["c.m4a", "b.m4a", "a.m4a"] and len(second) == 3
    titled = next(n for n in second if n.ref.endswith("a.m4a"))
    assert titled.title == "Standup ideas" and titled.source == "voicememos"
    assert collect_voice_memos(cache, transcriber, [folder]) and heard[-1] == "a.m4a"  # cached


def test_voice_memos_say_what_they_need(tmp_path):
    folder = memos_folder(tmp_path, ["a.m4a"])

    def no_model():
        raise RuntimeError("Jarvis's speech model isn't on this Mac yet")

    with pytest.raises(RuntimeError, match="speech model"):
        collect_voice_memos(tmp_path / "cache.db", no_model, [folder])
    folder.chmod(0)
    try:
        with pytest.raises(PermissionError, match="Full Disk Access"):
            collect_voice_memos(tmp_path / "cache.db", no_model, [folder])
    finally:
        folder.chmod(0o700)
    assert collect_voice_memos(tmp_path / "cache.db", no_model, [tmp_path / "none"]) == []


def test_a_recording_this_mac_cant_decode_is_not_tried_again(tmp_path):
    folder = memos_folder(tmp_path, ["bad.m4a"])
    tries = []

    def transcriber():
        def transcribe(path):
            tries.append(path)
            raise OSError("afconvert failed")

        return transcribe

    cache = tmp_path / "cache.db"
    assert collect_voice_memos(cache, transcriber, [folder]) == []
    assert collect_voice_memos(cache, transcriber, [folder]) == []
    assert len(tries) == 1


# ── what the rebuild is given ──


def test_only_the_sources_switched_on_are_read(tmp_path):
    base = {"store": str(tmp_path / "brain" / "index.json"), "folders": [], "computer": False}
    assert extra_sources(base) == {}  # an older app passes nothing: none of them
    more = {
        "conversations": True,
        "images": True,
        "safari": False,
        "bookmarks": True,
        "reminders": False,
        "voicememos": True,
        "whisper": {"model": "base.en"},
    }
    got = extra_sources({**base, "more": more})
    assert set(got) == {"conversations", "bookmarks", "voicememos"}  # images: no folders
    got = extra_sources({**base, "more": more, "folders": [str(tmp_path)]})
    assert "images" in got
    assert finisher(base) is None and finisher({**base, "more": {"semantic": True}}) is not None


def test_new_sources_are_blanked_kept_on_failure_and_finished(tmp_path, monkeypatch):
    monkeypatch.setattr("jarvis.knowledge.RESEARCH_DIR", tmp_path / "research")
    monkeypatch.setattr("jarvis.knowledge.MEETINGS_DIR", tmp_path / "meetings")
    monkeypatch.setattr("jarvis.knowledge.VIDEOS_DIR", tmp_path / "videos")
    kb = KnowledgeBase(tmp_path / "brain" / "index.json")

    def conversations():
        from jarvis.knowledge import Note

        return [
            Note("conversation:s:1", "conversations", "Wifi", "the wifi password: hunter2", "s")
        ]

    finished = []
    Collector(kb, None).run(
        notes=False,
        bsh=False,
        folders=[],
        extra={"conversations": conversations},
        finish=lambda k, _progress: finished.append(len(k.notes)),
    )
    [n] = kb.notes
    assert "hunter2" not in n.text and finished == [1]

    def broken():
        raise PermissionError("Voice Memos need Full Disk Access: …")

    Collector(kb, None).run(
        notes=False,
        bsh=False,
        folders=[],
        extra={"conversations": conversations, "voicememos": broken},
        only={"voicememos"},
        finish=lambda *_a: 1 / 0,  # a failing finish keeps the index
    )
    assert [n.id for n in kb.notes] == ["conversation:s:1"]
    assert "Full Disk Access" in kb.errors["voicememos"]
    assert KnowledgeBase(kb.store).load()


def test_the_finishing_step_makes_vectors_and_links_with_the_helper(tmp_path, monkeypatch):
    from test_embeddings import FakeEmbedder

    from jarvis import embeddings, swift_helper
    from jarvis.knowledge import Note

    kb = KnowledgeBase(tmp_path / "brain" / "index.json")
    kb.build(
        {
            "files": [
                Note(f"f:{i}", "files", f"Car {i}", "car repair brakes garage", str(i))
                for i in range(4)
            ]
        }
    )
    monkeypatch.setattr(swift_helper, "ensure", lambda name: tmp_path / name)
    monkeypatch.setattr(embeddings, "HelperEmbedder", lambda binary: FakeEmbedder())
    finisher({"store": str(kb.store), "more": {"semantic": True}})(kb, lambda _m: None)
    assert embeddings.VectorFile.read(embeddings.vectors_path(kb.store)).status()["vectors"] == 4
    assert kb.edges  # the four alike notes are linked by meaning
    monkeypatch.setattr(
        swift_helper, "ensure", lambda name: None
    )  # no helper: no vectors, no crash
    finisher({"store": str(kb.store), "more": {"semantic": True}})(kb, lambda _m: None)
