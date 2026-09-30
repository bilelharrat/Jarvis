"""When Claude can't answer (its usage limit, an outage), JARVIS and Jarvis Code carry on
with the fallback model (Gemini through JARVIS's relay), every tool included."""

import asyncio
import itertools
import time

from claude_agent_sdk import (
    AssistantMessage,
    RateLimitEvent,
    RateLimitInfo,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)
from conftest import FakeClient, result
from test_hub import drain, make_hub

from jarvis import tasks as tasks_module
from jarvis.hub import FALLBACK_SECONDS
from jarvis.providers import ProviderStore

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


async def test_a_jarvis_code_session_moves_to_the_fallback_and_carries_on(
    settings, quiet_speaker, isolated, monkeypatch, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    with_fallback(hub, monkeypatch)
    moved, sent = [], []

    async def task_model(task_id, ref):
        moved.append((task_id, ref))
        task.model_ref = ref  # as the real switch does

    monkeypatch.setattr(hub, "_task_model", task_model)
    monkeypatch.setattr(
        hub.tasks, "send", lambda task_id, text, *a, **k: sent.append((task_id, text, k)) or True
    )

    from jarvis.tasks import ClaudeTask

    task = ClaudeTask(id=7, prompt="", cwd=tmp_path, model="claude-opus-5-5", model_label="Opus")
    task.transcript = [{"role": "user", "text": "fix the login bug"}]
    assert hub._code_claude_down(task, "rate_limit", "You've hit your weekly limit")
    for _ in range(20):
        await asyncio.sleep(0)
    assert moved == [(7, GEMINI_REF)]
    [(task_id, text, how)] = sent
    assert task_id == 7 and how == {"steer": False, "note": True}
    # It carries on from where Claude stopped; the request itself isn't sent again.
    assert text.startswith("[Note from the app: Claude couldn't answer") and "Carry on" in text
    assert "Gemini 2.5 Flash" in text and "fix the login bug" not in text
    assert task.falling_back is False and task.reopen_now
    assert task.fell_back_from["model"] == "claude-opus-5-5"  # back there once Claude is
    assert "moved to Gemini 2.5 Flash" in task.transcript[-1]["text"]
    # Already on the fallback: nowhere else to go, Claude's error stands.
    assert not hub._code_claude_down(task, "rate_limit")


async def test_without_a_fallback_a_session_says_how_to_get_one(
    settings, quiet_speaker, isolated, tmp_path
):
    from jarvis.tasks import ClaudeTask

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    task = ClaudeTask(id=3, prompt="", cwd=tmp_path)
    assert not hub._code_claude_down(task, "rate_limit")  # nothing added: nothing to move to
    assert "Add a Gemini key" in task.transcript[-1]["text"]
    task.transcript.clear()
    hub.prefs.fallback_model = "off"  # turned off: Claude's error, and nothing more
    assert not hub._code_claude_down(task, "rate_limit") and not task.transcript
    hub.prefs.fallback_model, hub.prefs.fallback_code = "", False
    assert not hub._code_claude_down(task, "rate_limit")  # Jarvis Code keeps Claude


async def test_a_gemini_key_brings_flash_and_pro_and_automatic_picks_flash(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    # Google's list, as ProviderStore.newest_gemini reads it (tests never ask Google).
    listed = {
        "flash": ("gemini-3.8-flash", "Gemini 3.8 Flash"),
        "pro": ("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
    }

    async def newest(_store, _provider_id, _client=None):
        return dict(listed)

    monkeypatch.setattr(ProviderStore, "newest_gemini", newest)
    google = hub.providers.add_provider("gemini", "", "AIza" + "b" * 35)
    await hub._gemini_added(google["id"])
    models = {m["model"]: m for m in hub.providers.models() if not m["builtin"]}
    # By number, as Google names them
    assert [(model, m["label"]) for model, m in models.items()] == [
        ("gemini-3.8-flash", "Gemini 3.8 Flash"),
        ("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
    ]
    assert hub.prefs.fallback_model == ""  # left on Automatic, which picks Flash
    assert hub._fallback_ref() == models["gemini-3.8-flash"]["ref"]
    # A key Google won't list gets the undated names.
    listed.clear()
    work = hub.providers.add_provider("gemini", "Work", "AIza" + "c" * 35)["id"]
    await hub._gemini_added(work)
    assert [(e.model, e.label) for e in hub.providers.models_of(work)] == [
        ("gemini-flash-latest", "Gemini Flash"),
        ("gemini-pro-latest", "Gemini Pro"),
    ]
    # A fallback turned off stays off when a key is added.
    hub.prefs.fallback_model = "off"
    await hub._gemini_added(hub.providers.add_provider("gemini", "Home", "AIza" + "d" * 35)["id"])
    assert hub.prefs.fallback_model == "off" and hub._fallback_ref() == ""


async def test_gemini_models_added_before_the_numbers_are_numbered_at_start(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)

    async def newest(_store, _provider_id, _client=None):
        return {"flash": ("gemini-3.8-flash", "Gemini 3.8 Flash")}

    monkeypatch.setattr(ProviderStore, "newest_gemini", newest)
    google = hub.providers.add_provider("gemini", "", "AIza" + "b" * 35)["id"]
    ref = hub.providers.add_model(google, "gemini-flash-latest", "Gemini Flash")["ref"]
    hub.prefs.code_model = ref
    await hub._number_gemini_starters()
    (flash,) = [m for m in hub.providers.models() if not m["builtin"]]
    assert (flash["ref"], flash["model"], flash["label"]) == (
        ref,  # Jarvis Code's default is still this one
        "gemini-3.8-flash",
        "Gemini 3.8 Flash",
    )
    assert hub.providers.describe(hub.prefs.code_model) == "Gemini 3.8 Flash · Google Gemini"


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


def limit_result(words="You've hit your weekly limit · resets 5pm (America/Los_Angeles)"):
    """How Claude Code ends a turn the API refused: "success", with is_error."""
    return ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=True,
        num_turns=1,
        session_id="s",
        total_cost_usd=0.0,
        result=words,
    )


async def test_a_session_hands_over_once_and_its_end_is_no_failure(settings, tmp_path):
    from jarvis.tasks import ClaudeTask, TaskManager

    async def approve(*_a, **_k):
        return "deny"

    events = []
    tm = TaskManager(settings, approve, lambda kind, **d: events.append((kind, d)), FakeClient)
    told = []
    tm.on_claude_down = lambda task, why, said: told.append((why, said)) or True
    (tmp_path / "p").mkdir()
    task = ClaudeTask(id=1, prompt="", cwd=tmp_path / "p")
    task.turns_pending, task.busy, task.current = 1, True, "user"
    failed = AssistantMessage(
        content=[TextBlock(text="API Error: 529 Overloaded")], model="m", error="overloaded"
    )
    tm._on_task_message(task, failed)
    tm._on_task_message(task, failed)
    assert told == [("overloaded", "API Error: 529 Overloaded")]  # once, while it moves
    assert task.handover and task.falling_back
    tm._on_task_message(task, limit_result("API Error: 529 Overloaded"))
    assert not task.handover and not task.busy
    # No "Ended with an error: success", and not announced as a failure: it carries on.
    assert not [e for e in task.transcript if e["role"] == "system"]
    assert not [d for kind, d in events if kind == "task_finished"]


async def test_with_nowhere_to_go_the_turn_fails_in_claudes_own_words(settings, tmp_path):
    from jarvis.tasks import ClaudeTask, TaskManager

    async def approve(*_a, **_k):
        return "deny"

    events = []
    tm = TaskManager(settings, approve, lambda kind, **d: events.append((kind, d)), FakeClient)
    tm.on_claude_down = lambda task, why, said: False
    (tmp_path / "p").mkdir()
    task = ClaudeTask(id=1, prompt="", cwd=tmp_path / "p")
    task.turns_pending, task.busy, task.current = 1, True, "user"
    words = "You've hit your weekly limit · resets 5pm (America/Los_Angeles)"
    tm._on_task_message(
        task, AssistantMessage(content=[TextBlock(text=words)], model="m", error="rate_limit")
    )
    tm._on_task_message(task, limit_result())
    assert [e["text"] for e in task.transcript if e["role"] == "assistant"] == [words]
    assert not [e for e in task.transcript if e["role"] == "system"]  # it said why already
    assert [d["status"] for kind, d in events if kind == "task_finished"] == ["failed"]


def test_a_turn_that_failed_otherwise_says_why_in_words():
    from jarvis.tasks import _ended

    def ended(subtype, errors=None):
        return ResultMessage(
            subtype=subtype,
            duration_ms=1,
            duration_api_ms=1,
            is_error=True,
            num_turns=1,
            session_id="s",
            errors=errors,
        )

    assert _ended(ended("success")) == ""  # the reply was Claude Code's words for it
    assert "most steps" in _ended(ended("error_max_turns"))
    assert (
        _ended(ended("error_during_execution", ["exited 1"]))
        == "It stopped with an error. exited 1"
    )


def test_the_apps_note_goes_first_and_isnt_theirs_to_take_back():
    from jarvis.tasks import Inbox

    box = Inbox()
    box.put("and add a test")
    box.put("[Note from the app: …]\n\nCarry on.", note=True, front=True)
    assert [i["text"] for i in box.public()] == ["and add a test"]
    first = box.take()
    assert first["note"] and first["plain"]  # sent as it is: never with the ultracode keyword
    assert box.take()["text"] == "and add a test"


# ── Automatic: a Gemini model, however it was added ──


OPENROUTER_KEY = "sk-or-v1-" + "a" * 64
GOOGLE_KEY = "AIza" + "b" * 35


def test_the_automatic_fallback_prefers_gemini_flash_and_a_working_key(tmp_path):
    from jarvis.connectors import MemoryVault
    from jarvis.providers import ProviderStore

    store = ProviderStore(tmp_path / "providers.json", MemoryVault())
    assert store.pick_fallback() == ""
    router = store.add_provider("openrouter", "", OPENROUTER_KEY)
    other = store.add_model(router["id"], "openai/gpt-5")["ref"]
    assert store.pick_fallback() == other  # no Gemini: whatever was added
    routed = store.add_model(router["id"], "google/gemini-2.5-pro")["ref"]
    assert store.pick_fallback() == routed  # Gemini first, even through OpenRouter
    google = store.add_provider("gemini", "", GOOGLE_KEY)
    pro = store.add_model(google["id"], "gemini-pro-latest", "Gemini Pro")["ref"]
    assert store.pick_fallback() == pro  # Google's own key before one through OpenRouter
    store.add_model(google["id"], "gemini-flash-lite-latest", "Gemini Flash Lite")
    flash = store.add_model(google["id"], "gemini-flash-latest", "Gemini Flash")["ref"]
    assert store.pick_fallback() == flash  # Flash (not Lite) first: it answers quickly
    store.status[google["id"]] = {"ok": False, "error": "API key not valid"}
    assert store.pick_fallback() == routed  # a key that failed its check goes last


async def test_with_automatic_the_fallback_is_there_without_picking_one(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    store = hub.providers
    assert hub.prefs.fallback_model == "" and hub._fallback_ref() == ""  # nothing added
    router = store.add_provider("openrouter", "Gemini", OPENROUTER_KEY)
    gpt = store.add_model(router["id"], "openai/gpt-5")["ref"]
    gemini = store.add_model(router["id"], "google/gemini-2.5-pro")["ref"]
    assert hub._fallback_ref() == gemini  # the owner's setup when Claude's limit came
    hub.prefs.fallback_model = "off"
    assert hub._fallback_ref() == ""
    hub.prefs.fallback_model = gpt
    assert hub._fallback_ref() == gpt  # a pick is a pick...
    store.remove_model(gpt)
    assert hub._fallback_ref() == gemini  # ... until it's removed: Automatic again


# ── JARVIS's own conversation ──


class ToolThenLimit(FakeClient):
    """Claude looks at the calendar, then hits its limit before it can answer; the
    fallback answers."""

    made: list = []

    def __init__(self, options=None):
        super().__init__(options)
        ToolThenLimit.made.append(self)
        on_gemini = getattr(options, "model", "") == "gemini-2.5-flash"
        self.script = (
            [
                AssistantMessage(
                    content=[TextBlock(text="Two meetings tomorrow.")], model="gemini-2.5-flash"
                ),
                result(),
            ]
            if on_gemini
            else [
                AssistantMessage(
                    content=[ToolUseBlock(id="t1", name="mcp__mac__list_events", input={})],
                    model="m",
                ),
                UserMessage(content=[ToolResultBlock(tool_use_id="t1", content="ok")]),
                AssistantMessage(
                    content=[TextBlock(text="You've hit your weekly limit")],
                    model="m",
                    error="rate_limit",
                ),
                limit_result(),
            ]
        )


async def test_claudes_limit_partway_through_an_answer_carries_on_there(
    settings, quiet_speaker, isolated, monkeypatch
):
    ToolThenLimit.made = []
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.client_factory = ToolThenLimit
    with_fallback(hub, monkeypatch)
    await hub.start()
    q = hub.subscribe()
    assert await hub.ask("what's on tomorrow?") == "Two meetings tomorrow."
    claude, gemini = ToolThenLimit.made[-2:]
    assert gemini.options.model == "gemini-2.5-flash" and gemini.options.resume == "s"
    # Not asked again (the calendar would be read twice): it carries on from there.
    [asked] = gemini.queries
    assert asked.startswith("[Note from the app: Claude couldn't finish this answer")
    assert "what's on tomorrow" not in asked and "Gemini 2.5 Flash" in asked
    events = drain(q)
    assert not [e for e in events if e["type"] == "error"]  # no "Claude stopped: success"


async def test_the_fallback_lasts_until_claudes_limit_resets(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    with_fallback(hub, monkeypatch)

    async def reconnect():
        hub._connected_ref = hub._main_ref()

    monkeypatch.setattr(hub, "_reconnect", reconnect)
    resets = time.time() + 2 * 3600
    hub._rate_limit(RateLimitInfo(status="rejected", resets_at=int(resets)))
    hub._claude_couldnt()
    assert not hub._claude_back()
    hub._claude_down = "rate_limit"
    q = hub.subscribe()
    assert await hub._fall_back()
    assert 2 * 3600 - 60 < hub._fallback_until - time.monotonic() <= 2 * 3600
    [notice] = [e for e in drain(q) if e["type"] == "notice"]
    assert "when Claude's limit resets" in notice["text"]
    assert "until" in hub._claude_why("rate_limit")
    # Another model's "allowed" (Haiku while Opus's weekly limit is used up) isn't Claude
    # being back, nor is extra usage allowed past a limit news of one.
    hub._rate_limit(RateLimitInfo(status="allowed"))
    extra = RateLimitInfo(status="rejected", resets_at=int(resets + 60), overage_status="allowed")
    hub._rate_limit(extra)
    assert not hub._claude_back() and abs(hub._claude_back_at - resets) < 2
    # Claude Code gives milliseconds sometimes.
    hub._rate_limit(RateLimitInfo(status="rejected", resets_at=int((resets + 600) * 1000)))
    assert abs(hub._claude_back_at - resets - 600) < 2
    hub._claude_down_at -= 3 * 3600  # hit hours ago...
    hub._claude_back_at = time.time() - 1  # ... and the reset time has come
    assert hub._claude_back()


def test_after_an_outage_claude_is_tried_again_in_half_an_hour(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub._claude_back_at = time.time() - 3600  # an earlier limit's reset: not this time's
    hub._claude_couldnt()  # an outage: no reset time comes with it
    assert not hub._claude_back()
    assert hub._claude_why("server_error") == "an outage"
    hub._claude_down_at -= FALLBACK_SECONDS + 1
    assert hub._claude_back()


# ── Jarvis Code, end to end: the limit, the move, carrying on, and back to Claude ──


LIMIT = "You've hit your weekly limit · resets 5pm (America/Los_Angeles)"


class Limited(FakeClient):
    """Claude Code with a message stream per connection, as the SDK has: on Claude (no
    provider settings) it answers with its weekly limit while `limited`, as Claude Code
    does (the rate limit, then its words for it, then a result with is_error); on the
    fallback, or on Claude once it's back, it answers."""

    limited = True
    resets_at = 0.0
    made: list = []
    count = itertools.count(1)

    def __init__(self, options=None):
        super().__init__(options)
        Limited.made.append(self)

    @property
    def on_claude(self):
        return not getattr(self.options, "settings", None)

    async def query(self, text):
        self.queries.append(text)
        n = next(Limited.count)
        if self.on_claude and Limited.limited:
            info = RateLimitInfo(
                status="rejected", resets_at=int(Limited.resets_at), rate_limit_type="seven_day"
            )
            messages = [
                RateLimitEvent(rate_limit_info=info, uuid=f"r{n}", session_id="s"),
                UserMessage(content=str(text), uuid=f"u{n}"),
                AssistantMessage(
                    content=[TextBlock(text=LIMIT)], model="m", error="rate_limit", uuid=f"a{n}"
                ),
                limit_result(),
            ]
        else:
            reply = "Claude again." if self.on_claude else "Fixed it on Gemini."
            messages = [
                UserMessage(content=str(text), uuid=f"u{n}"),
                AssistantMessage(content=[TextBlock(text=reply)], model="m", uuid=f"a{n}"),
                ResultMessage(
                    subtype="success",
                    duration_ms=1,
                    duration_api_ms=1,
                    is_error=False,
                    num_turns=1,
                    session_id="s",
                    total_cost_usd=0.1,
                    result=reply,
                ),
            ]
        for message in messages:
            self._stream().put_nowait(message)


async def until(condition, seconds=5.0):
    for _ in range(int(seconds / 0.005)):
        if condition():
            return True
        await asyncio.sleep(0.005)
    return False


def limited_hub(settings, quiet_speaker, isolated, monkeypatch):
    """The owner's setup when the limit came: Gemini added through OpenRouter, the
    fallback left on Automatic."""
    monkeypatch.setattr(tasks_module, "REOPEN_QUIET", 0.01)
    Limited.made, Limited.limited = [], True
    Limited.resets_at = time.time() + 3 * 3600
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.tasks.client_factory = Limited
    router = hub.providers.add_provider("openrouter", "Gemini", OPENROUTER_KEY)
    gemini = hub.providers.add_model(router["id"], "google/gemini-2.5-pro")["ref"]
    (settings.projects_dir / "p").mkdir()
    return hub, gemini


async def test_claudes_limit_moves_a_session_to_gemini_where_it_carries_on(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub, gemini = limited_hub(settings, quiet_speaker, isolated, monkeypatch)
    q = hub.subscribe()
    task = hub.tasks.start(
        "fix the login bug", "p", mode="smart", model="claude-opus-5-5", model_label="Opus 5.5"
    )
    assert await until(lambda: task.result == "Fixed it on Gemini." and task.status == "waiting")
    claude, fallback = Limited.made
    assert claude.queries == ["fix the login bug"]
    assert fallback.options.model == "google/gemini-2.5-pro"
    assert fallback.options.resume == "s"  # the same conversation, so it knows what was done
    [note] = fallback.queries
    assert note.startswith("[Note from the app: Claude couldn't answer") and "Carry on" in note
    assert task.model_ref == gemini and task.fell_back_from["model"] == "claude-opus-5-5"
    assert task.mode == "edits"  # Claude Code's Auto is Claude's: edits go ahead, the rest asks
    assert abs(hub._claude_back_at - Limited.resets_at) < 2
    # What the window shows: the request once, Claude's words, the move, the answer.
    shown = [(e["role"], e["text"]) for e in task.transcript if e["role"] != "turn"]
    assert [t for r, t in shown if r == "user"] == ["fix the login bug"]
    assert [t for r, t in shown if r == "assistant"] == [LIMIT, "Fixed it on Gemini."]
    said = " ".join(t for r, t in shown if r == "system")
    assert "Ended with an error" not in said
    assert "moved to google/gemini-2.5-pro · Gemini to carry on" in said
    assert "takes it back to Opus 5.5" in said
    finished = [e for e in drain(q) if e["type"] == "task_finished"]
    assert [e["status"] for e in finished] == ["done"]  # never "failed", never "stopped"

    # Until Claude's limit resets, the session stays on Gemini.
    assert hub.tasks.send(task.id, "and the signup page")
    assert await until(lambda: len(fallback.queries) == 2 and task.status == "waiting")
    assert fallback.queries[-1] == "and the signup page" and len(Limited.made) == 2

    # Claude's limit resets: the next message takes the session back to Opus.
    Limited.limited = False
    hub._claude_down_at -= 3 * 3600  # hit hours ago...
    hub._claude_back_at = time.time() - 1  # ... and reset a second ago
    assert hub.tasks.send(task.id, "and add a test")
    assert await until(lambda: task.result == "Claude again." and task.status == "waiting")
    back = Limited.made[-1]
    assert back.on_claude and back.options.model == "claude-opus-5-5"
    assert back.queries == ["and add a test"] and back.options.resume == "s"
    assert task.model_ref == "" and not task.fell_back_from and task.mode == "smart"
    assert any("back on Opus 5.5" in e["text"] for e in task.transcript if e["role"] == "system")
    hub.tasks.cancel(task.id)


async def test_a_running_background_task_doesnt_hold_up_the_move(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub, gemini = limited_hub(settings, quiet_speaker, isolated, monkeypatch)
    task = hub.tasks.start("", "p", model="claude-opus-5-5", model_label="Opus 5.5")
    assert await until(lambda: task.client is not None and task.status == "waiting")
    task.background["b1"] = {"id": "b1", "description": "npm run dev", "status": "running"}
    hub.tasks.send(task.id, "fix the login bug")
    assert await until(lambda: task.result == "Fixed it on Gemini.")
    assert task.model_ref == gemini and len(Limited.made) == 2
    hub.tasks.cancel(task.id)
