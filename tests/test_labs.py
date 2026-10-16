"""Labs (features/_labs.py): half-finished surfaces are off until turned on, both the
backend module and its window files; a graduated one (Other agents, ACP) is on for everyone,
with its own switch, and an owner who had turned it on in Labs keeps that."""

from jarvis import prefs
from jarvis.features import _labs
from jarvis.server import feature_assets


class Prefs:
    def __init__(self, on, **features):
        self.on = on
        self.features = features

    def feature(self, key):
        return self.on if key == "labs" else self.features.get(key)


def test_labs_are_off_by_default_and_on_when_chosen(monkeypatch):
    monkeypatch.delenv("JARVIS_LABS", raising=False)
    assert _labs.skipped(Prefs([])) == set(_labs.LABS)
    assert _labs.skipped(Prefs(["code_plugins"])) == set(_labs.LABS) - {"code_plugins"}
    assert "code-plugins" not in _labs.web_skipped(Prefs(["code_plugins"]))
    assert _labs.enabled(None) == set()
    monkeypatch.setenv("JARVIS_LABS", "all")
    assert _labs.skipped(Prefs([])) == set()


def test_a_lab_that_is_off_loads_no_window_files(monkeypatch):
    monkeypatch.delenv("JARVIS_LABS", raising=False)
    scripts = feature_assets(skip=_labs.web_skipped(Prefs([])))["scripts"]
    assert not any("/code-plugins.js" in s for s in scripts)
    assert any("/code-sessions.js" in s for s in scripts)


def test_other_agents_left_labs_on_for_everyone_with_a_switch_of_their_own(monkeypatch):
    monkeypatch.delenv("JARVIS_LABS", raising=False)
    assert "code_acp" not in _labs.LABS and "code_acp" in _labs.GRADUATED
    assert "code_acp" not in {lab["name"] for lab in _labs.public()}  # (not in the Labs list)
    for chose in ([], ["code_acp"]):  # never turned on, or turned on back in Labs: on
        assert "code_acp" not in _labs.skipped(Prefs(chose))
        assert "code-acp" not in _labs.web_skipped(Prefs(chose))
    scripts = feature_assets(skip=_labs.web_skipped(Prefs([])))["scripts"]
    assert any("/code-acp.js" in s for s in scripts)
    off = Prefs(["code_acp"], code_acp_agents=False)  # its own switch turns it off
    assert "code_acp" in _labs.skipped(off) and "code-acp" in _labs.web_skipped(off)
    monkeypatch.setenv("JARVIS_LABS", "all")
    assert "code_acp" in _labs.skipped(off)  # (Labs all is about Labs only)


def test_an_owner_s_old_labs_choice_is_kept_in_their_settings():
    """A build from before it graduated reads the same labs list: it still finds it on."""
    kept = prefs.clean_feature_values({"labs": ["code_plugins", "gone", "code_acp"]})
    assert kept == {"labs": ["code_acp", "code_plugins"]}
    assert prefs.Prefs().feature("code_acp_agents") is True  # on unless turned off
    assert prefs.clean_feature_values({"code_acp_agents": False}) == {"code_acp_agents": False}
    assert prefs.clean_feature_values({"code_acp_agents": "no"}) == {}
