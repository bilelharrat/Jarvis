"""Settings › Listening › Recognise my voice has Chinese for everything it shows: the
window's strings (web/features/voice_id.js), the ones it builds, the backend's notes."""

from test_hub import make_hub

from jarvis.features import voice_id


def test_every_string_the_pane_shows_has_chinese(settings, quiet_speaker, isolated):
    import re
    from pathlib import Path

    from test_voice_i18n import _js_literals

    from jarvis.server import zh_strings

    merged = zh_strings()
    patterns = [re.compile(p) for p, _r in merged["patterns"]]

    def has_zh(text):
        return text in merged["strings"] or any(p.search(text) for p in patterns)

    script = (Path(voice_id.__file__).parents[1] / "web/features/voice_id.js").read_text()
    shown = [
        s for s in _js_literals(script)
        if re.search(r"[A-Z].*[a-z]", s) and not re.match(r"^voice_id|^voice-id", s)
    ]  # fmt: skip
    assert len(shown) > 20 and [s for s in shown if not has_zh(s)] == []
    built = [
        "The voice model is 26.5 MB and stays on this Mac.",
        "Read sentence 2 of 5 aloud:",
        "I didn’t catch that. Read sentence 3 of 5 again:",
        "The voice model didn’t download: timed out",
        "I couldn’t record: no microphone",
    ]
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    guard = voice_id.guard_for(hub)
    hub.set_feature_prefs({"voice_id_on": True})
    backend = [guard.why_off()]
    guard.model = {"url": "https://example.test/m.onnx", "sha256": "0" * 64}
    backend.append(guard.why_off())
    guard.model_path.parent.mkdir(parents=True)
    guard.model_path.write_bytes(b"x")
    backend.append(guard.why_off())
    guard.load_error = "bad"
    backend.append(guard.why_off())
    assert [s for s in built + backend if not has_zh(s)] == []
