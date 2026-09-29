from jarvis.prefs import Prefs, PrefsStore


def test_update_validates(tmp_path):
    p = Prefs()
    changed = p.update(
        {
            "model": "sonnet",
            "persona": "hal9000",
            "humor": 250,
            "briefing_time": "7:30",
            "brain_folders": [str(tmp_path), "/etc"],
            "last_briefing": "2020-01-01",
        }
    )
    assert p.model == "sonnet" and p.model_id() == "claude-sonnet-5-5"
    assert p.persona == "jarvis"  # unknown persona ignored
    assert p.humor == 100
    assert p.briefing_time == "08:00"  # malformed time ignored
    assert p.last_briefing == ""  # not settable from the window
    assert "/etc" not in p.brain_folders
    assert set(changed) >= {"model", "humor"}


def test_store_round_trip(tmp_path):
    store = PrefsStore(tmp_path / "prefs.json")
    store.prefs.update({"humor": 90, "persona": "tars"})
    store.prefs.last_briefing = "2026-09-28"
    store.save()
    again = PrefsStore(tmp_path / "prefs.json").prefs
    assert (again.humor, again.persona, again.last_briefing) == (90, "tars", "2026-09-28")


def test_corrupt_file_falls_back(tmp_path):
    path = tmp_path / "prefs.json"
    path.write_text("{not json")
    assert PrefsStore(path).prefs == Prefs()
