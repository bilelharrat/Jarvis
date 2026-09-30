"""Browser memories (opt-in): a page the owner keeps on show for a minute is kept as text for
the second brain's Browsing source; never a sensitive site or this Mac's own pages, never a
secret from an address; forgotten one by one or all at once."""

import asyncio
import json

from test_hub import make_hub

from jarvis import brain_sources
from jarvis.features import brain as brain_feature
from jarvis.features import browser_ai
from jarvis.features.browser_ai import memories
from jarvis.features.browser_ai.memories import clean_url, collect_browsing, folder_for, read_pages
from jarvis.features.browser_ai.sites import ADDED_KEY
from jarvis.knowledge import Note

ARTICLE = "Soup has warmed people up for thousands of years. " * 12
URL = "https://news.example/2026/soup"


def desk_with(hub, answer, on=True):
    """The desk, its window's reading of a page answered with answer (a dict or fn(args))."""
    desk = browser_ai.desk_for(hub)
    calls = []

    async def call(action, args=None, timeout=None):
        calls.append((action, dict(args or {})))
        return dict(answer(args or {}) if callable(answer) else answer)

    desk.bridge.call = call
    refreshed = []

    async def refresh():
        refreshed.append(True)

    desk.memories.refresh = refresh
    if on:
        hub.set_feature_prefs({memories.PREF: True})
    return desk, calls, refreshed


def read(url=URL, **more):
    return {"ok": True, "url": url, "title": "Why soup is good", "site": "The Daily Spoon",
            "text": ARTICLE, **more}  # fmt: skip


def test_an_address_is_kept_without_its_secrets():
    assert (
        clean_url("https://news.example/a?id=4&utm=x#part") == "https://news.example/a?id=4&utm=x"
    )
    kept = clean_url("https://shop.example/r?token=abc&page=2&sessionId=9&reset_code=1&q=soup")
    assert kept == "https://shop.example/r?page=2&q=soup"
    for bad in ("javascript:alert(1)", "file:///etc/passwd", "about:blank", "", None, "http://"):
        assert clean_url(bad) == ""


async def test_a_page_read_for_a_minute_is_kept(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, calls, _ = desk_with(hub, read())
    await desk.memories.on_dwell({"url": URL + "#comments", "tab": 3, "seconds": 60})
    assert calls == [("extract", {"limit": memories.TEXT_MAX, "tab": 3})]
    pages = read_pages(folder_for(hub.kb.store))
    assert len(pages) == 1
    page = pages[0]
    assert page["url"] == URL and page["title"] == "Why soup is good" and page["visits"] == 1
    assert page["site"] == "The Daily Spoon" and page["text"].startswith("Soup has warmed")
    first = page["first"]
    await desk.memories.on_dwell({"url": URL, "tab": 3})  # read again another day
    page = read_pages(folder_for(hub.kb.store))[0]
    assert (
        page["visits"] == 2
        and page["first"] == first
        and len(list(folder_for(hub.kb.store).glob("*"))) == 1
    )


async def test_nothing_is_kept_while_it_s_off_or_where_it_mustn_t_be(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, calls, _ = desk_with(hub, read(), on=False)
    await desk.memories.on_dwell({"url": URL, "tab": 3})
    assert calls == []
    hub.set_feature_prefs(
        {memories.PREF: True, ADDED_KEY: [{"host": "myclinic.org", "kind": "health"}]}
    )
    for url in (
        "https://secure.chase.com/accounts",
        "https://mail.google.com/mail/u/0/#inbox",
        "https://portal.myclinic.org/results",
        "http://localhost:3000/",
        "http://127.0.0.1:8080/admin",
        "about:blank",
    ):
        await desk.memories.on_dwell({"url": url, "tab": 3})
    await desk.memories.on_dwell({"url": URL, "tab": 3, "research": True})
    assert calls == []
    # The page moved on before it was read, or has too little text to be worth keeping.
    desk, calls, _ = desk_with(hub, read(url="https://news.example/other"))
    await desk.memories.on_dwell({"url": URL, "tab": 3})
    desk, calls, _ = desk_with(hub, read(text="Sign in"))
    await desk.memories.on_dwell({"url": URL, "tab": 3})
    desk, calls, _ = desk_with(hub, {"ok": False, "message": "The page did not answer."})
    await desk.memories.on_dwell({"url": URL, "tab": 3})
    assert read_pages(folder_for(hub.kb.store)) == []


async def test_the_oldest_go_past_the_cap(settings, quiet_speaker, isolated, monkeypatch):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    monkeypatch.setattr(memories, "MAX_PAGES", 3)
    desk, _, _ = desk_with(hub, lambda args: read(url=args["url"]))
    clock = iter(range(1000, 2000))
    monkeypatch.setattr(memories.time, "time", lambda: next(clock))
    for n in range(5):
        url = f"https://news.example/{n}"

        async def call(action, args=None, timeout=None, url=url):
            return read(url=url)

        desk.bridge.call = call
        await desk.memories.on_dwell({"url": url})
    kept = [p["url"] for p in read_pages(folder_for(hub.kb.store))]
    assert kept == ["https://news.example/4", "https://news.example/3", "https://news.example/2"]


async def test_new_pages_reach_the_brain_in_one_refresh(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    monkeypatch.setattr(memories, "REFRESH_DELAY", 0.01)
    rebuilt = []

    async def rebuild(only=None):
        rebuilt.append(only)

    hub.rebuild_brain = rebuild
    desk = browser_ai.desk_for(hub)

    async def call(action, args=None, timeout=None):
        return read()

    desk.bridge.call = call
    hub.set_feature_prefs({memories.PREF: True})
    await desk.memories.on_dwell({"url": URL})
    await desk.memories.on_dwell({"url": URL})
    await asyncio.sleep(0.1)
    assert rebuilt == [{"browsing"}]


async def test_the_window_lists_and_forgets_them(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    desk, _, refreshed = desk_with(hub, lambda args: read())
    for n in range(2):

        async def call(action, args=None, timeout=None, n=n):
            return read(url=f"https://news.example/{n}", title=f"Page {n}")

        desk.bridge.call = call
        await desk.memories.on_dwell({"url": f"https://news.example/{n}"})
    q = hub.subscribe()
    await hub._handle({"type": "browser_ai_memories"})
    await asyncio.sleep(0.05)  # it runs in the background
    events = []
    while not q.empty():
        events.append(q.get_nowait())
    listed = [e for e in events if e["type"] == "browser_ai_memories"][-1]
    assert listed["on"] is True and listed["count"] == 2
    assert [m["title"] for m in listed["recent"]] == ["Page 1", "Page 0"]
    assert set(listed["recent"][0]) == {"url", "title", "site", "last"}  # never the text
    await desk.memories.on_forget({"url": "https://news.example/0"})
    assert [p["url"] for p in read_pages(folder_for(hub.kb.store))] == ["https://news.example/1"]
    await desk.memories.on_forget({"all": True})
    await asyncio.sleep(0.01)
    assert read_pages(folder_for(hub.kb.store)) == [] and refreshed


def test_the_brain_reads_them_as_its_browsing_source(tmp_path):
    folder = folder_for(tmp_path / "brain" / "index.json")
    folder.mkdir(parents=True)
    page = {"url": URL, "title": "Why soup is good", "site": "The Daily Spoon", "text": ARTICLE,
            "first": 1_790_000_000, "last": 1_790_000_100, "visits": 2}  # fmt: skip
    (folder / "a.json").write_text(json.dumps(page))
    (folder / "b.json").write_text("{not json")
    (folder / "c.json").write_text(json.dumps({"title": "no address"}))
    notes = collect_browsing(folder)
    assert len(notes) == 1
    note = notes[0]
    assert note.source == "browsing" and note.ref == URL and note.group == "The Daily Spoon"
    assert note.title == "Why soup is good" and "Soup has warmed" in note.text and note.modified
    store = tmp_path / "brain" / "index.json"
    assert "browsing" not in brain_sources.extra_sources({"store": str(store), "more": {}})
    sources = brain_sources.extra_sources({"store": str(store), "more": {"browsing": True}})
    assert [n.ref for n in sources["browsing"]()] == [URL]


async def test_a_remembered_page_opens_in_the_built_in_browser(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    opened = []

    async def raw(action, args=None):
        opened.append((action, args))
        return {"ok": True}

    hub._browser_raw = raw
    assert "browsing" in brain_feature.SWITCHES  # the feature's switches: the source is one
    page = Note(id="browsing:x", source="browsing", title="Soup", text="", ref=URL)
    assert hub.brain_extension.open_note(page) is True
    await asyncio.sleep(0.01)
    assert opened == [("open", {"url": URL, "newTab": True})]
    hub.brain_extension.open_note(
        Note(id="browsing:y", source="browsing", title="", text="", ref="javascript:x")
    )
    await asyncio.sleep(0.01)
    assert len(opened) == 1
