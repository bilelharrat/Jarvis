from jarvis.prefs import CAUTIOUS, Prefs, PrefsStore


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
    """A damaged file with no good copy starts with the microphone and private indexing off
    and says so; the damaged file is kept. (It used to fall back to the product defaults,
    which switched the always-on microphone and mail and messages indexing back on.)"""
    path = tmp_path / "prefs.json"
    path.write_text("{not json")
    store = PrefsStore(path)
    assert store.prefs == Prefs(**CAUTIOUS) and store.notice
    assert [p.read_text() for p in tmp_path.glob("prefs.json.bad-*")] == ["{not json"]


def test_the_old_local_research_address_moves_to_the_hosted_one(tmp_path):
    import json

    path = tmp_path / "prefs.json"
    path.write_text(json.dumps({"research_url": "http://127.0.0.1:8010", "humor": 40}))
    store = PrefsStore(path)
    assert store.prefs.research_url == "https://app.bshventures.com/research"
    assert store.prefs.humor == 40
    store.save()
    assert json.loads(path.read_text())["version"] == 4


def test_choosing_the_local_address_again_is_kept(tmp_path):
    store = PrefsStore(tmp_path / "prefs.json")
    store.prefs.update({"research_url": "127.0.0.1:8010"})
    store.save()
    assert PrefsStore(tmp_path / "prefs.json").prefs.research_url == "http://127.0.0.1:8010"


def test_a_chosen_research_address_is_never_moved(tmp_path):
    import json

    path = tmp_path / "prefs.json"
    path.write_text(json.dumps({"research_url": "http://192.168.1.5:8010"}))
    assert PrefsStore(path).prefs.research_url == "http://192.168.1.5:8010"


def test_a_new_install_has_no_research_center(tmp_path):
    """The Research Center is the owner's own (private to BSH): someone else's first start has
    none, and Markets shows only the markets."""
    import json

    store = PrefsStore(tmp_path / "prefs.json")
    assert store.prefs.research_url == ""
    store.save()
    saved = json.loads((tmp_path / "prefs.json").read_text())
    assert saved["research_url"] == "" and saved["version"] == 4
    assert PrefsStore(tmp_path / "prefs.json").prefs.research_url == ""  # kept empty


def test_an_install_from_before_keeps_its_research_center(tmp_path):
    import json

    hosted = "https://app.bshventures.com/research"
    path = tmp_path / "prefs.json"
    # The owner's file as it is today: version 3, the hosted address saved in it.
    path.write_text(json.dumps({"research_url": hosted, "humor": 40, "version": 3}))
    assert PrefsStore(path).prefs.research_url == hosted
    # One from before the address was saved at all, or with it unreadable.
    path.write_text(json.dumps({"humor": 40, "version": 3}))
    assert PrefsStore(path).prefs.research_url == hosted
    path.write_text(json.dumps({"research_url": "http://[zz", "version": 3}))
    assert PrefsStore(path).prefs.research_url == hosted
    # Another address chosen before is kept as it is.
    path.write_text(json.dumps({"research_url": "https://research.example.org", "version": 3}))
    assert PrefsStore(path).prefs.research_url == "https://research.example.org"


def test_clearing_the_research_center_is_kept(tmp_path):
    store = PrefsStore(tmp_path / "prefs.json")
    store.prefs.update({"research_url": "https://research.example.org"})
    store.save()
    reread = PrefsStore(tmp_path / "prefs.json")
    assert reread.prefs.update({"research_url": ""}) == ["research_url"]
    reread.save()
    assert PrefsStore(tmp_path / "prefs.json").prefs.research_url == ""


def test_stark_glass_tone_is_dark_light_or_auto():
    p = Prefs()
    assert p.glass_tone == "dark"
    assert p.update({"glass_tone": "light"}) == ["glass_tone"]
    assert p.update({"glass_tone": "auto"}) == ["glass_tone"]
    assert p.update({"glass_tone": "sepia"}) == []
    assert p.glass_tone == "auto"
