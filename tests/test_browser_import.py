"""Importing bookmarks and history from the owner's other browsers (features/browser_import.py),
from fake profiles in a temp home: never the Mac's real browsers."""

from __future__ import annotations

import asyncio
import json
import os
import plistlib
import sqlite3
from pathlib import Path

import pytest
from conftest import FakeClient

from jarvis.features import browser_import as bi
from jarvis.hub import Hub

CHROME_EPOCH_US = 11_644_473_600 * 1_000_000  # 1970-01-01 in Chromium's microseconds


def chrome_time(ms: int) -> int:
    return ms * 1000 + CHROME_EPOCH_US


def make_chromium(home: Path, rel: str, profile: str = "Default") -> Path:
    folder = home / rel / profile
    folder.mkdir(parents=True)
    bookmarks = {
        "roots": {
            "bookmark_bar": {
                "type": "folder",
                "name": "Bookmarks bar",
                "children": [
                    {"type": "url", "name": "Hacker News", "url": "https://news.ycombinator.com/"},
                    {
                        "type": "folder",
                        "name": "Work / Research",
                        "children": [
                            {
                                "type": "url",
                                "name": "  The   Docs ",
                                "url": "https://docs.example/",
                            },
                            {"type": "url", "name": "", "url": "https://untitled.example/"},
                            {"type": "url", "name": "Script", "url": "javascript:alert(1)"},
                        ],
                    },
                ],
            },
            "other": {
                "type": "folder",
                "children": [{"type": "url", "name": "Recipes", "url": "https://food.example/"}],
            },
            "synced": {"type": "folder", "children": []},
        }
    }
    (folder / "Bookmarks").write_text(json.dumps(bookmarks))
    con = sqlite3.connect(folder / "History")
    con.execute(
        "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, "
        "typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)"
    )
    rows = [
        ("https://news.ycombinator.com/", "Hacker News", 40, chrome_time(1_790_000_000_000), 0),
        ("https://docs.example/a", "Docs A", 3, chrome_time(1_780_000_000_000), 0),
        ("chrome://settings/", "Settings", 5, chrome_time(1_790_000_000_000), 0),
        ("https://hidden.example/", "Hidden", 1, chrome_time(1_790_000_000_000), 1),
        ("https://never.example/", "Never visited", 0, 0, 0),
    ]
    con.executemany(
        "INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) "
        "VALUES (?, ?, ?, 0, ?, ?)",
        rows,
    )
    con.commit()
    con.close()
    return folder


def make_safari(home: Path) -> Path:
    folder = home / "Library/Safari"
    folder.mkdir(parents=True)
    plist = {
        "WebBookmarkType": "WebBookmarkTypeList",
        "Title": "",
        "Children": [
            {"WebBookmarkType": "WebBookmarkTypeProxy", "Title": "History"},
            {
                "WebBookmarkType": "WebBookmarkTypeList",
                "Title": "BookmarksBar",
                "Children": [
                    {
                        "WebBookmarkType": "WebBookmarkTypeLeaf",
                        "URLString": "https://apple.com/",
                        "URIDictionary": {"title": "Apple"},
                    },
                    {
                        "WebBookmarkType": "WebBookmarkTypeList",
                        "Title": "News",
                        "Children": [
                            {
                                "WebBookmarkType": "WebBookmarkTypeLeaf",
                                "URLString": "https://bbc.co.uk/",
                                "URIDictionary": {"title": "BBC"},
                            }
                        ],
                    },
                ],
            },
            {
                "WebBookmarkType": "WebBookmarkTypeList",
                "Title": "com.apple.ReadingList",
                "Children": [
                    {
                        "WebBookmarkType": "WebBookmarkTypeLeaf",
                        "URLString": "https://longread.example/",
                        "URIDictionary": {},
                    }
                ],
            },
        ],
    }
    with (folder / "Bookmarks.plist").open("wb") as fh:
        plistlib.dump(plist, fh, fmt=plistlib.FMT_BINARY)
    con = sqlite3.connect(folder / "History.db")
    con.execute(
        "CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER)"
    )
    con.execute(
        "CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, "
        "visit_time REAL, title TEXT)"
    )
    con.execute("INSERT INTO history_items VALUES (1, 'https://apple.com/', 7)")
    con.execute("INSERT INTO history_items VALUES (2, 'file:///Users/me/x.html', 1)")
    # 2026-09-01 and a later visit with a newer title (seconds since 2001-01-01).
    con.execute("INSERT INTO history_visits VALUES (1, 1, 810000000.0, 'Apple (old)')")
    con.execute("INSERT INTO history_visits VALUES (2, 1, 810003600.5, 'Apple')")
    con.execute("INSERT INTO history_visits VALUES (3, 2, 810000000.0, 'Local')")
    con.commit()
    con.close()
    return folder


def test_chrome_bookmarks_keep_their_folders_and_only_web_pages(tmp_path):
    make_chromium(tmp_path, bi.CHROMIUM["chrome"][1])
    got = bi.read_browser("chrome", tmp_path)
    assert got["ok"] is True
    assert got["bookmarks"] == [
        {"url": "https://news.ycombinator.com/", "title": "Hacker News", "folder": "Bookmarks bar"},
        {
            "url": "https://docs.example/",
            "title": "The Docs",
            "folder": "Bookmarks bar/Work ∕ Research",  # a slash in a name isn't a subfolder
        },
        {
            "url": "https://untitled.example/",
            "title": "https://untitled.example/",
            "folder": "Bookmarks bar/Work ∕ Research",
        },
        {"url": "https://food.example/", "title": "Recipes", "folder": "Other bookmarks"},
    ]


def test_chrome_history_newest_first_with_visits_and_times(tmp_path):
    make_chromium(tmp_path, bi.CHROMIUM["chrome"][1])
    history = bi.read_browser("chrome", tmp_path)["history"]
    assert history == [
        {
            "url": "https://news.ycombinator.com/",
            "title": "Hacker News",
            "at": 1_790_000_000_000,
            "visits": 40,
        },
        {"url": "https://docs.example/a", "title": "Docs A", "at": 1_780_000_000_000, "visits": 3},
    ]


def test_the_history_is_read_from_a_copy_the_browser_s_own_file_untouched(tmp_path, monkeypatch):
    folder = make_chromium(tmp_path, bi.CHROMIUM["brave"][1])
    (folder / "History-journal").write_bytes(b"")
    before = (folder / "History").stat().st_mtime_ns
    opened = []
    real = sqlite3.connect
    monkeypatch.setattr(
        bi.sqlite3, "connect", lambda path, *a, **k: opened.append(path) or real(path, *a, **k)
    )
    assert bi.read_browser("brave", tmp_path)["history"]
    assert opened and Path(opened[0]).parent != folder, "the browser's own database was opened"
    assert not Path(opened[0]).exists(), "the copy was left behind"
    assert (folder / "History").stat().st_mtime_ns == before


def test_arc_and_edge_and_a_profile_other_than_default(tmp_path):
    make_chromium(tmp_path, bi.CHROMIUM["arc"][1])
    make_chromium(tmp_path, bi.CHROMIUM["edge"][1], profile="Profile 2")
    assert bi.read_browser("arc", tmp_path)["ok"]
    assert bi.read_browser("edge", tmp_path)["bookmarks"][0]["title"] == "Hacker News"


def test_safari_bookmarks_and_history(tmp_path):
    make_safari(tmp_path)
    got = bi.read_browser("safari", tmp_path)
    assert got["ok"] is True
    assert got["bookmarks"] == [
        {"url": "https://apple.com/", "title": "Apple", "folder": "Favorites"},
        {"url": "https://bbc.co.uk/", "title": "BBC", "folder": "Favorites/News"},
        {
            "url": "https://longread.example/",
            "title": "https://longread.example/",
            "folder": "Reading List",
        },
    ]
    assert got["history"] == [
        {
            "url": "https://apple.com/",
            "title": "Apple",  # its latest visit's title
            "at": (810003600 + 978307200) * 1000 + 500,
            "visits": 7,
        }
    ]


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads any file")
def test_safari_guarded_by_macos_asks_for_full_disk_access(tmp_path):
    folder = make_safari(tmp_path)
    (folder / "Bookmarks.plist").chmod(0)
    try:
        assert bi.read_browser("safari", tmp_path) == {"ok": False, "error": "full_disk_access"}
    finally:
        (folder / "Bookmarks.plist").chmod(0o600)


def test_missing_damaged_or_unknown_browsers_say_so(tmp_path):
    assert bi.read_browser("chrome", tmp_path) == {"ok": False, "error": "not_found"}
    assert bi.read_browser("safari", tmp_path) == {"ok": False, "error": "not_found"}
    assert bi.read_browser("netscape", tmp_path) == {"ok": False, "error": "unknown"}
    folder = make_chromium(tmp_path, bi.CHROMIUM["chrome"][1])
    (folder / "Bookmarks").write_text("{ not json")
    (folder / "History").write_bytes(b"not a database at all")
    assert bi.read_browser("chrome", tmp_path) == {"ok": False, "error": "unreadable"}
    # Bookmarks that say nothing and no history at all: nothing to import, and no error.
    (folder / "Bookmarks").write_text(json.dumps({"roots": "nonsense"}))
    (folder / "History").unlink()
    assert bi.read_browser("chrome", tmp_path) == {"ok": True, "bookmarks": [], "history": []}


def test_a_huge_profile_is_read_only_as_far_as_the_browser_keeps(tmp_path):
    folder = tmp_path / bi.CHROMIUM["chrome"][1] / "Default"
    folder.mkdir(parents=True)
    many = [{"type": "url", "name": f"B{i}", "url": f"https://b{i}.example/"} for i in range(7000)]
    deep: dict = {"type": "url", "name": "Deep", "url": "https://deep.example/"}
    for i in range(40):
        deep = {"type": "folder", "name": f"F{i}", "children": [deep]}
    roots = {"bookmark_bar": {"type": "folder", "children": [*many, deep]}}
    (folder / "Bookmarks").write_text(json.dumps({"roots": roots}))
    got = bi.read_browser("chrome", tmp_path)
    assert len(got["bookmarks"]) == bi.BOOKMARKS_MAX
    assert got["history"] == []


def test_sources_list_what_is_on_this_mac(tmp_path):
    make_chromium(tmp_path, bi.CHROMIUM["chrome"][1])
    make_safari(tmp_path)
    assert bi.sources(tmp_path) == [
        {"id": "chrome", "name": "Chrome", "found": True},
        {"id": "arc", "name": "Arc", "found": False},
        {"id": "brave", "name": "Brave", "found": False},
        {"id": "edge", "name": "Edge", "found": False},
        {"id": "safari", "name": "Safari", "found": True},
    ]


@pytest.fixture
def hub(settings, quiet_speaker, isolated, tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(bi, "home", lambda: home)  # never the real home folder
    h = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    h.test_home = home
    return h


async def events_of(hub, msg, kind):
    queue = hub.subscribe()
    await hub._handle(msg)
    importer = hub._commands[msg["type"]][0].__self__
    await asyncio.gather(*importer._tasks)
    found = []
    while not queue.empty():
        event = queue.get_nowait()
        if event["type"] == kind:
            found.append(event)
    hub.unsubscribe(queue)
    return found


def test_the_feature_is_installed(hub):
    assert "browser_import" in hub.features


async def test_the_window_asks_and_hears_back_without_waiting(hub):
    make_chromium(hub.test_home, bi.CHROMIUM["chrome"][1])
    [sources] = await events_of(hub, {"type": "browser_import_sources"}, "browser_import_sources")
    assert [s["id"] for s in sources["sources"] if s["found"]] == ["chrome"]
    [event] = await events_of(
        hub, {"type": "browser_import", "browser": "chrome"}, "browser_import"
    )
    assert event["ok"] is True and event["name"] == "Chrome" and event["browser"] == "chrome"
    assert len(event["bookmarks"]) == 4 and len(event["history"]) == 2
    [bad] = await events_of(hub, {"type": "browser_import", "browser": "../etc"}, "browser_import")
    assert bad["ok"] is False and bad["error"] == "unknown"


async def test_an_unforeseen_failure_is_that_import_only(hub, monkeypatch):
    def boom(*_a):
        raise RuntimeError("odd file")

    monkeypatch.setattr(bi, "read_browser", boom)
    [event] = await events_of(hub, {"type": "browser_import", "browser": "arc"}, "browser_import")
    assert event == {
        "type": "browser_import",
        "browser": "arc",
        "name": "Arc",
        "ok": False,
        "error": "unreadable",
    }
