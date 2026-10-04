"""Labs (features/_labs.py): half-finished surfaces are off until turned on, both the
backend module and its window files."""

from jarvis.features import _labs
from jarvis.server import feature_assets


class Prefs:
    def __init__(self, on):
        self.on = on

    def feature(self, key):
        return self.on if key == "labs" else None


def test_labs_are_off_by_default_and_on_when_chosen(monkeypatch):
    monkeypatch.delenv("JARVIS_LABS", raising=False)
    assert _labs.skipped(Prefs([])) == set(_labs.LABS)
    assert _labs.skipped(Prefs(["code_acp"])) == set(_labs.LABS) - {"code_acp"}
    assert "code-acp" not in _labs.web_skipped(Prefs(["code_acp"]))
    assert _labs.enabled(None) == set()
    monkeypatch.setenv("JARVIS_LABS", "all")
    assert _labs.skipped(Prefs([])) == set()


def test_a_lab_that_is_off_loads_no_window_files(monkeypatch):
    monkeypatch.delenv("JARVIS_LABS", raising=False)
    scripts = feature_assets(skip=_labs.web_skipped(Prefs([])))["scripts"]
    assert not any("/code-acp.js" in s or "/code-plugins.js" in s for s in scripts)
    assert any("/code-sessions.js" in s for s in scripts)
