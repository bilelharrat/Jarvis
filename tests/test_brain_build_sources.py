"""The rebuild process (python -m jarvis.brain_build) reads the newer sources it's given in
args["more"], in a home folder of its own here: saved conversations, Safari's and Chrome's
bookmarks. Nothing of the real home is read."""

import json
import os
import plistlib
import subprocess
import sys


def rebuild(store, home, more, only=None):
    args = {
        "store": str(store),
        "bsh": "",
        "bsh_on": False,
        "notes": False,
        "folders": [],
        "computer": False,
        "photos": False,
        "mail": False,
        "messages": False,
        "only": only,
        "more": more,
    }
    return subprocess.run(
        [sys.executable, "-m", "jarvis.brain_build", json.dumps(args)],
        capture_output=True,
        text=True,
        timeout=180,
        env={**os.environ, "HOME": str(home)},
    )


def test_the_rebuild_reads_the_newer_sources_it_is_given(tmp_path):
    home = tmp_path / "home"
    saved = home / "Documents" / "Jarvis" / "Conversations"
    saved.mkdir(parents=True)
    (saved / "Conversation 2026-09-01 10.00.md").write_text(
        "# Conversation with J.A.R.V.I.S.\n\n**You**\n\nThe wifi password: hunter2 for the lake house"
    )
    safari = home / "Library" / "Safari"
    safari.mkdir(parents=True)
    leaf = {
        "WebBookmarkType": "WebBookmarkTypeLeaf",
        "URLString": "https://example.com/deck",
        "URIDictionary": {"title": "Pitch deck examples"},
        "WebBookmarkUUID": "A1",
    }
    (safari / "Bookmarks.plist").write_bytes(
        plistlib.dumps({"WebBookmarkType": "WebBookmarkTypeList", "Children": [leaf]})
    )
    chrome = home / "Library" / "Application Support" / "Google" / "Chrome" / "Default"
    chrome.mkdir(parents=True)
    (chrome / "Bookmarks").write_text(
        json.dumps(
            {
                "roots": {
                    "bookmark_bar": {
                        "type": "folder",
                        "name": "Bar",
                        "children": [
                            {"type": "url", "name": "Linear", "url": "https://linear.app/team"}
                        ],
                    }
                }
            }
        )
    )
    store = tmp_path / "brain" / "index.json"
    more = {"conversations": True, "safari": True, "bookmarks": True, "images": False}
    run = rebuild(store, home, more)
    assert run.returncode == 0, run.stderr[-2000:]
    assert "Reading safari" in run.stdout and "Reading conversations" in run.stdout
    notes = json.loads(store.read_text())["notes"]
    by_source = {n["source"]: n for n in notes}
    assert set(by_source) == {"conversations", "safari", "bookmarks"}
    assert "hunter2" not in by_source["conversations"]["text"]
    assert by_source["safari"]["title"] == "Pitch deck examples"
    assert by_source["bookmarks"]["ref"] == "https://linear.app/team"

    # One source switched off, one rebuilt alone: the switched-off one goes, the rest stay.
    (safari / "Bookmarks.plist").unlink()
    again = rebuild(store, home, {**more, "bookmarks": False}, only=["bookmarks", "safari"])
    assert again.returncode == 0, again.stderr[-2000:]
    sources = {n["source"] for n in json.loads(store.read_text())["notes"]}
    assert sources == {"conversations"}
