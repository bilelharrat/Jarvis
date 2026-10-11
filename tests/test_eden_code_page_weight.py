"""Eden Code's page loads only what it shows (r2 CH2 page weight): the assistant's modules whose
groups Eden Code's Settings hides even from search (settings-nav.js JARVIS_ONLY) aren't sent to it;
the ones it still shows or searches stay."""

import re
from pathlib import Path

from conftest import CALENDAR_TURN, FakeClient
from starlette.testclient import TestClient

from jarvis.hub import Hub
from jarvis.server import EDEN_ONLY_FEATURES, create_app

WEB = Path(__file__).resolve().parents[1] / "src" / "jarvis" / "web"
HIDDEN_IN_EDEN_CODE = {
    "eden-hotkey", "eden-pop", "sms_line", "mail-accounts", "personas", "personas-voices",
    "conversation", "convo-manage", "chat-projects",
}  # fmt: skip
# Kept: Eden Code shows them, finds them by search, or depends on them (newuser.css holds
# Settings' `.row[hidden]` rule; punctuation is accessibility.js's; voice is searchable).
KEPT = {
    "code-sessions", "settings-nav", "intro", "local-models", "accessibility", "punctuation",
    "newuser", "voice", "proactive", "companion", "channels", "brain", "memory", "eden-mac",
    "jarvis-mcp", "ops", "shell", "updates", "model-menu",
}  # fmt: skip


def stems(paths):
    return {p.split("/")[-1].split("?")[0].rsplit(".", 1)[0] for p in paths}


def test_eden_code_loads_none_of_the_assistants_hidden_modules(settings, quiet_speaker, isolated, monkeypatch):
    class Client(FakeClient):
        script = CALENDAR_TURN

    monkeypatch.delenv("JARVIS_PROFILE", raising=False)
    hub = Hub(settings, client_factory=Client, speaker=quiet_speaker, poll=False, **isolated)
    with TestClient(create_app(hub, "t0k"), base_url="http://127.0.0.1:8123") as c:
        eden = c.get("/features.json").json()
        code = c.get("/features.json?app=code").json()
    assert HIDDEN_IN_EDEN_CODE <= EDEN_ONLY_FEATURES
    assert HIDDEN_IN_EDEN_CODE <= stems(eden["scripts"])  # Eden's own window keeps them all
    assert not HIDDEN_IN_EDEN_CODE & stems(code["scripts"])
    assert not HIDDEN_IN_EDEN_CODE & stems(code["styles"])
    assert KEPT <= stems(code["scripts"])
    assert len(code["scripts"]) <= len(eden["scripts"]) - len(EDEN_ONLY_FEATURES & stems(eden["scripts"]))


def test_what_eden_code_leaves_out_is_hidden_there_even_from_search():
    """Each left-out module's Settings group is one settings-nav.js never shows in Eden Code."""
    nav = (WEB / "features" / "settings-nav.js").read_text()
    only = re.search(r"const JARVIS_ONLY = \[([^\]]*)\]", nav).group(1)
    inside = re.search(r"const JARVIS_ONLY_INSIDE = \[([^\]]*)\]", nav).group(1)
    for group in ("mail-group", "convo-group", "sms-line-group"):
        assert f"'{group}'" in only
    assert "'persona-group'" in inside
    feats = WEB / "features"
    assert "group.id = 'mail-group'" in (feats / "mail-accounts.js").read_text() or "'mail-group'" in (feats / "mail-accounts.js").read_text()
    assert "'sms-line-group'" in (feats / "sms_line.js").read_text()
    assert "'convo-group'" in (feats / "conversation.js").read_text() or "convo-group" in (feats / "conversation.js").read_text()
    assert "persona-group" in (feats / "personas.js").read_text()
    # the rule Settings' hidden rows rely on lives in a module Eden Code keeps
    assert "#settings .row[hidden] { display: none; }" in (feats / "newuser.css").read_text()
