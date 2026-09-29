"""When Claude can't answer (its usage limit, an outage), JARVIS and Jarvis Code carry on
with the fallback model (Gemini through JARVIS's relay), every tool included."""

import asyncio

from claude_agent_sdk import AssistantMessage, TextBlock
from conftest import FakeClient, result
from test_hub import drain, make_hub

from jarvis.hub import FALLBACK_SECONDS

GEMINI_REF = "custom:gem1"


class ClaudeOrGemini(FakeClient):
    """Claude answers with its limit; the fallback model answers the question."""

    made: list = []

    def __init__(self, options=None):
        super().__init__(options)
        ClaudeOrGemini.made.append(self)
        on_gemini = getattr(options, "model", "") == "gemini-2.5-flash"
        self.script = (
            [
                AssistantMessage(
                    content=[TextBlock(text="Sunny and 68.")], model="gemini-2.5-flash"
                ),
                result(),
            ]
            if on_gemini
            else [
                AssistantMessage(
                    content=[TextBlock(text="API Error: usage limit reached")],
                    model="m",
                    error="rate_limit",
                ),
                result(is_error=True),
            ]
        )


def with_fallback(hub, monkeypatch):
    providers = hub.providers
    monkeypatch.setattr(
        providers,
        "known",
        lambda ref: ref in ("", GEMINI_REF) or ref in ("opus", "sonnet", "haiku"),
    )
    monkeypatch.setattr(
        providers, "describe", lambda ref: "Gemini 2.5 Flash" if ref == GEMINI_REF else ref
    )
    monkeypatch.setattr(providers, "kind_of", lambda ref: "")  # no relay needed for the fake
    monkeypatch.setattr(
        providers,
        "session_config",
        lambda ref, environ=None: {
            "model": "gemini-2.5-flash",
            "label": "Gemini 2.5 Flash",
            "provider": "p",
            "claude": False,
            "env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:1"},
            "settings": "{}",
            "ref": ref,
        },
    )
    hub.prefs.fallback_model = GEMINI_REF


async def test_claudes_limit_sends_the_question_to_the_fallback(
    settings, quiet_speaker, isolated, monkeypatch
):
    ClaudeOrGemini.made = []
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.client_factory = ClaudeOrGemini
    with_fallback(hub, monkeypatch)
    await hub.start()
    q = hub.subscribe()
    reply = await hub.ask("What's the weather?")
    assert reply == "Sunny and 68."
    events = drain(q)
    assert not [e for e in events if e["type"] == "error"]  # Claude's error isn't shown or said
    assert any(e["type"] == "notice" and "Gemini 2.5 Flash" in e["text"] for e in events)
    assert ClaudeOrGemini.made[-1].options.model == "gemini-2.5-flash"
    assert hub._connected_ref == GEMINI_REF
    # For half an hour it stays there; then it goes back to Claude on the next question.
    hub._fallback_until -= FALLBACK_SECONDS + 1
    assert hub._main_ref() == ""


async def test_without_a_fallback_claudes_error_is_what_you_hear(settings, quiet_speaker, isolated):
    ClaudeOrGemini.made = []
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.client_factory = ClaudeOrGemini
    await hub.start()
    q = hub.subscribe()
    await hub.ask("What's the weather?")
    assert len(ClaudeOrGemini.made) == 1  # no second try anywhere
    assert any(e["type"] == "error" for e in drain(q))


async def test_always_use_it_runs_jarvis_on_it_from_the_start(
    settings, quiet_speaker, isolated, monkeypatch
):
    ClaudeOrGemini.made = []
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.client_factory = ClaudeOrGemini
    with_fallback(hub, monkeypatch)
    hub.prefs.fallback_always = True
    await hub.start()
    assert await hub.ask("What's the weather?") == "Sunny and 68."
    assert all(c.options.model == "gemini-2.5-flash" for c in ClaudeOrGemini.made)


async def test_a_jarvis_code_session_moves_to_the_fallback_and_asks_again(
    settings, quiet_speaker, isolated, monkeypatch, tmp_path
):
    isolated_dir = tmp_path
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    with_fallback(hub, monkeypatch)
    moved, sent = [], []

    async def task_model(task_id, ref):
        moved.append((task_id, ref))

    monkeypatch.setattr(hub, "_task_model", task_model)
    monkeypatch.setattr(
        hub.tasks, "send", lambda task_id, text, *a, **k: sent.append((task_id, text)) or True
    )

    from jarvis.tasks import ClaudeTask

    def Task():
        task = ClaudeTask(id=7, prompt="", cwd=isolated_dir)
        task.falling_back = True
        task.transcript = [
            {"role": "user", "text": "fix the login bug"},
            {"role": "assistant", "text": "API Error"},
        ]
        return task

    task = Task()
    await hub._code_fallback(task, "rate_limit")
    assert moved == [(7, GEMINI_REF)] and sent == [(7, "fix the login bug")]
    assert task.falling_back is False
    assert "Gemini 2.5 Flash" in task.transcript[-1]["text"]
    hub.prefs.fallback_code = False
    moved.clear()
    await hub._code_fallback(Task(), "rate_limit")
    assert moved == []  # Jarvis Code keeps Claude when that's switched off


async def test_a_gemini_key_brings_flash_and_pro_and_picks_flash(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    added = []

    def add_model(pid, model, label=None):
        added.append(model)
        return {"ref": f"custom:{model}"}

    monkeypatch.setattr(hub.providers, "add_model", add_model)
    monkeypatch.setattr(hub.providers, "known", lambda ref: ref.startswith("custom:"))
    await hub._gemini_added("g1")
    assert added == ["gemini-flash-latest", "gemini-pro-latest"]
    assert hub.prefs.fallback_model == "custom:gemini-flash-latest"
    await asyncio.sleep(0)


async def test_gemini_sessions_point_at_the_relay(monkeypatch):
    import pytest

    from jarvis import gemini_proxy, providers

    gem = (
        providers.Provider(
            id="g",
            kind="gemini",
            name="Google Gemini",
            base_url="https://generativelanguage.googleapis.com",
            auth="x-api-key",
            key_hint="…1234",
            added="x",
        )
        if "added" in providers.Provider.__dataclass_fields__
        else None
    )
    if gem is None:
        pytest.skip("Provider fields changed")
    monkeypatch.setattr(gemini_proxy.PROXY, "port", 0)
    with pytest.raises(ValueError, match="relay"):
        providers.session_pins(gem, "gemini-2.5-flash", {})
    monkeypatch.setattr(gemini_proxy.PROXY, "port", 43210)
    pins = providers.session_pins(gem, "gemini-2.5-flash", {})
    assert pins["ANTHROPIC_BASE_URL"] == "http://127.0.0.1:43210"
    assert pins["ANTHROPIC_MODEL"] == "gemini-2.5-flash" and pins["ANTHROPIC_API_KEY"] == ""


async def test_a_session_tells_the_hub_once_when_claude_cant_answer(settings, tmp_path):
    from jarvis.tasks import TaskManager

    async def approve(*_a, **_k):
        return "deny"

    tm = TaskManager(settings, approve, lambda *a, **k: None, FakeClient)
    told = []

    async def down(task, why):
        told.append(why)

    tm.on_claude_down = down
    (tmp_path / "p").mkdir()
    from jarvis.tasks import ClaudeTask

    task = ClaudeTask(id=1, prompt="", cwd=tmp_path / "p")
    failed = AssistantMessage(
        content=[TextBlock(text="API Error: 529")], model="m", error="server_error"
    )
    tm._on_task_message(task, failed)
    tm._on_task_message(task, failed)
    await asyncio.sleep(0.01)
    assert told == ["server_error"]  # once, while the move is under way
