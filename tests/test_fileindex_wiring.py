"""The file index in the hub: the window may open only files the index showed; Settings
can forget the index."""

from test_hub import drain, make_hub

from jarvis import fileindex


async def test_only_files_the_index_showed_can_be_opened(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    shown = tmp_path / "Q3 Board Deck.key"
    shown.write_text("deck")
    other = tmp_path / "secret.txt"
    other.write_text("no")
    opened = []
    monkeypatch.setattr("jarvis.hub.subprocess.Popen", lambda args, *a, **k: opened.append(args))

    class Hit:
        def public(self):
            return {"path": str(shown), "name": shown.name, "kind": "presentation"}

    q = hub.subscribe()
    hub._files_shown([Hit()])
    assert [e for e in drain(q) if e["type"] == "files"][0]["items"][0]["name"] == shown.name
    await hub._handle({"type": "found_file_open", "path": str(other)})
    await hub._handle({"type": "found_file_open", "path": str(shown), "reveal": True})
    assert opened == [["open", "-R", str(shown)]]


async def test_settings_forget_the_index(settings, quiet_speaker, isolated, tmp_path):
    root = tmp_path / "docs"
    root.mkdir()
    (root / "plan.md").write_text("# Launch plan\nShip it in October")
    index = fileindex.FileIndex(tmp_path / "files2.db", [root], home=tmp_path)
    index.refresh()
    assert index.status()["files"] == 1
    hub = make_hub(settings, quiet_speaker, isolated={**isolated, "file_index": index})
    await hub.start()
    assert hub.snapshot()["file_index"]["files"] == 1
    q = hub.subscribe()
    await hub._handle({"type": "files_clear"})
    status = [e for e in drain(q) if e["type"] == "files_status"][-1]
    assert status["files"] == 0


async def test_forgetting_the_index_that_fails_says_so(settings, quiet_speaker, isolated, tmp_path):
    import sqlite3

    index = fileindex.FileIndex(tmp_path / "files2.db", [tmp_path], home=tmp_path)

    def broken():
        raise sqlite3.OperationalError("disk I/O error")

    index.clear = broken
    hub = make_hub(settings, quiet_speaker, isolated={**isolated, "file_index": index})
    await hub.start()
    q = hub.subscribe()
    await hub._handle({"type": "files_clear"})
    told = drain(q)
    assert [e["text"] for e in told if e["type"] == "error"] == [
        "Your file index couldn't be erased (disk I/O error). Try again in a moment."
    ]
    assert not [e for e in told if e["type"] == "files_status"]  # (it isn't empty)


async def test_a_refresh_reads_its_counts_in_its_own_thread_never_on_the_loop(
    settings, quiet_speaker, isolated, tmp_path
):
    """files_status during a refresh: the index's counts are read in the indexing thread
    (they scan the whole index), and only the event goes through the loop."""
    import asyncio
    import threading

    root = tmp_path / "docs"
    root.mkdir()
    for n in range(3):
        (root / f"note{n}.md").write_text(f"# Note {n}")
    index = fileindex.FileIndex(tmp_path / "files3.db", [root], home=tmp_path)
    read_in: list[str] = []
    real = index.status

    def status():
        read_in.append(threading.current_thread().name)
        return real()

    index.status = status
    hub = make_hub(settings, quiet_speaker, isolated={**isolated, "file_index": index})
    await hub.start()
    q = hub.subscribe()
    loop_thread = threading.current_thread().name
    await asyncio.to_thread(index.refresh, hub._files_progress)
    await asyncio.sleep(0)  # the event, handed to the loop
    told = [e for e in drain(q) if e["type"] == "files_status"]
    assert told and told[-1]["files"] in (0, 3)  # as far as the refresh had got
    assert read_in and loop_thread not in read_in
    assert index.status()["files"] == 3
