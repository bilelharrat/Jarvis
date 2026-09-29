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
