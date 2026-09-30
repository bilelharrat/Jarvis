"""Signing JARVIS in with the user's own Anthropic API key (claude_signin.py, features/
signin.py), the checkup's view of it, and the downloadable app's checkup lines. The key is
checked by a stand-in: nothing here reaches Anthropic, and the Keychain is a MemoryVault."""

import ast
import json
from pathlib import Path

import pytest
from claude_agent_sdk import ClaudeAgentOptions
from conftest import FakeClient

from jarvis import claude_signin
from jarvis.features import signin as signin_feature
from jarvis.features.ops import doctor
from jarvis.hub import Hub
from jarvis.providers import CREDENTIAL_ENV

KEY = "sk-ant-api03-" + "x" * 80 + "AbCd"
SRC = Path(claude_signin.__file__).parent


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    made = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    made.sent = []
    made.emit = lambda kind, **data: made.sent.append((kind, data))
    yield made
    claude_signin.deactivate()


def signin_of(hub, ok=True, error="Claude API key turned the key down (401). Check it."):
    checked = []

    async def check_key(pid):
        checked.append(pid)
        return {"ok": ok, "error": "" if ok else error, "models": []}

    found = signin_feature.signin_for(hub)
    found.check_key = check_key
    return found, checked


def last(hub, kind="signin"):
    return [data for k, data in hub.sent if k == kind][-1]


def options(**kw):
    return ClaudeAgentOptions(model="claude-haiku-4-5", env={"ENABLE_TOOL_SEARCH": "false"}, **kw)


async def test_with_no_key_nothing_changes(hub):
    claude_signin.activate(hub)
    made = claude_signin.signed_in(options())
    assert made.settings is None and made.env == {"ENABLE_TOOL_SEARCH": "false"}


async def test_not_turned_on_nothing_changes_even_with_a_key(hub):
    found, _ = signin_of(hub)
    await found.use_key({"key": KEY})
    claude_signin.deactivate()  # the tests' hubs never run the loop that turns it on
    assert claude_signin.signed_in(options()).settings is None


async def test_a_pasted_key_signs_every_run_in_through_the_keychain(hub):
    found, checked = signin_of(hub)
    await found.use_key({"key": KEY})
    event = last(hub)
    assert event["mode"] == "key" and event["hint"] == "sk-…AbCd" and not event["error"]
    pid = hub.prefs.feature(claude_signin.PREF)
    assert checked == [pid] and hub.providers.providers[pid].name == "Claude API key"
    claude_signin.activate(hub)
    made = claude_signin.signed_in(options())
    settings = json.loads(made.settings)
    assert (
        f"provider:{pid}:api_key" in settings["apiKeyHelper"]
        and " -I -c " in settings["apiKeyHelper"]
    )
    pins = settings["env"]
    assert pins["ANTHROPIC_BASE_URL"] == "" and pins["ANTHROPIC_MODEL"] == ""  # Claude's own
    assert all(pins[name] == "" for name in CREDENTIAL_ENV)
    assert made.env["ENABLE_TOOL_SEARCH"] == "false"  # the run's own env kept
    assert all(made.env[name] == "" for name in CREDENTIAL_ENV)  # no inherited credential
    # The key itself is nowhere a run (or its shell commands) could read it.
    assert KEY not in made.settings and KEY not in json.dumps(made.env)
    assert KEY not in json.dumps(event) and KEY not in json.dumps(hub.sent)


async def test_the_conversation_signs_in_with_the_key_on_a_built_in_model_too(hub):
    """JARVIS's own conversation (brain.build_options) signs in with the key; a built-in
    model picked to run it on (Settings › Brain) has no settings of its own and keeps it."""
    found, _ = signin_of(hub)
    await found.use_key({"key": KEY})
    claude_signin.activate(hub)
    await hub.start()
    await hub.ask("Hello?")
    assert "apiKeyHelper" in (hub.client.options.settings or "")
    await hub.stop()
    hub.prefs.fallback_model, hub.prefs.fallback_always = "sonnet", True
    await hub.start()
    await hub.ask("Hello again?")
    assert hub.client.options.model == "claude-sonnet-5-5"
    assert "apiKeyHelper" in (hub.client.options.settings or "")
    await hub.stop()


async def test_a_run_with_a_provider_of_its_own_keeps_it(hub):
    found, _ = signin_of(hub)
    await found.use_key({"key": KEY})
    claude_signin.activate(hub)
    own = '{"apiKeyHelper": "their own"}'
    made = claude_signin.signed_in(options(settings=own))
    assert made.settings == own and "ANTHROPIC_API_KEY" not in made.env


async def test_a_key_anthropic_turns_down_is_never_kept(hub):
    found, _ = signin_of(hub, ok=False)
    await found.use_key({"key": KEY})
    event = last(hub)
    assert event["mode"] == "account" and "turned the key down" in event["error"]
    assert hub.prefs.feature(claude_signin.PREF) == "" and hub.providers.providers == {}
    assert hub.providers.vault.data == {}  # and out of the Keychain again


async def test_a_second_key_waits_until_the_first_is_removed(hub):
    found, _ = signin_of(hub)
    await found.use_key({"key": KEY})
    first = hub.prefs.feature(claude_signin.PREF)
    await found.use_key({"key": KEY.replace("AbCd", "WxYz")})
    assert "Remove the key" in last(hub)["error"] and hub.prefs.feature(claude_signin.PREF) == first
    await found.forget()
    event = last(hub)
    assert event["mode"] == "account" and hub.providers.providers == {}
    assert hub.prefs.feature(claude_signin.PREF) == "" and not hub.providers.vault.data
    claude_signin.activate(hub)
    assert claude_signin.signed_in(options()).settings is None  # the account again


async def test_a_key_that_isnt_one_is_said_plainly(hub):
    found, checked = signin_of(hub)
    for said, words in (
        ("", "Paste the API key first."),
        ("sk-or-v1-abcdefgh12345678", "OpenRouter"),
    ):
        await found.use_key({"key": said})
        assert words in last(hub)["error"]
    assert checked == [] and hub.providers.providers == {}


async def test_removing_its_provider_in_settings_ends_the_key_sign_in(hub):
    found, _ = signin_of(hub)
    await found.use_key({"key": KEY})
    claude_signin.activate(hub)
    hub.providers.remove_provider(hub.prefs.feature(claude_signin.PREF))
    assert claude_signin.signed_in(options()).settings is None
    await found.state()
    assert last(hub)["mode"] == "account"


async def test_the_window_reaches_it_by_its_commands(hub):
    found, _ = signin_of(hub)
    await hub._commands["signin_state"][0]({"type": "signin_state"})
    assert last(hub)["mode"] == "account" and last(hub)["key_url"].startswith("https://console")
    await hub._commands["signin_key"][0]({"type": "signin_key", "key": KEY})
    assert last(hub)["mode"] == "key"
    assert any(kind == "providers" for kind, _ in hub.sent)  # Settings › Models shows it too
    await hub._commands["signin_forget"][0]({"type": "signin_forget"})
    assert last(hub)["mode"] == "account"


def test_the_pref_takes_only_a_provider_id():
    clean = signin_feature._provider_id
    assert clean("") == "" and clean("a1b2c3d4e5f6") == "a1b2c3d4e5f6"
    assert clean("../../x") is None and clean(5) is None and clean("A" * 40) is None


# ── every run passes its options through signed_in() ──


def _made_options(tree: ast.AST):
    """(function, the name its ClaudeAgentOptions(...) goes into, or None when inline)."""
    for fn in ast.walk(tree):
        if not isinstance(fn, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        for node in ast.walk(fn):
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Call):
                call = node.value
                if getattr(call.func, "id", getattr(call.func, "attr", "")) == "ClaudeAgentOptions":
                    yield fn, node.targets[0].id if isinstance(node.targets[0], ast.Name) else None


def test_every_claude_code_run_jarvis_starts_can_sign_in_with_the_key():
    """A run made without signed_in() would still ask for the Claude account: in the app
    people download that's no sign-in at all. A new place that makes a run's options passes
    them through claude_signin.signed_in() before use."""
    missing = []
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Return) and isinstance(node.value, ast.Call):
                func = node.value.func
                if getattr(func, "id", getattr(func, "attr", "")) == "ClaudeAgentOptions":
                    missing.append(f"{path.relative_to(SRC)}:{node.lineno} returns it unsigned")
        for fn, name in _made_options(tree):
            signed = any(
                isinstance(call, ast.Call)
                and getattr(call.func, "id", "") == "signed_in"
                and call.args
                and getattr(call.args[0], "id", None) == name
                for call in ast.walk(fn)
            )
            if not signed:
                missing.append(f"{path.relative_to(SRC)}:{fn.name} ({name})")
    assert missing == [], "pass these through claude_signin.signed_in(): " + ", ".join(missing)


# ── the checkup ──


def probe(tmp_path, **kw):
    async def run(*argv, timeout=0):
        if argv[1:] == ("--version",):
            return 0, "2.1.284 (Claude Code)", ""
        if argv[1:3] == ("auth", "status"):
            return 0, json.dumps({"loggedIn": False}), ""
        return 1, "", ""

    return doctor.Probe(
        data=tmp_path, logs=tmp_path, home=tmp_path, run=run, claude_cli=lambda: "/x/claude", **kw
    )


async def test_the_checkup_asks_anthropic_about_the_key(tmp_path):
    async def good():
        return {"ok": True, "error": "", "hint": "sk-…AbCd"}

    async def bad():
        return {
            "ok": False,
            "error": "Claude API key turned the key down (401).",
            "hint": "sk-…AbCd",
        }

    ok = await doctor.claude_check(probe(tmp_path, key_signin=good))
    assert (ok["state"], ok["summary"], ok["meta"]) == ("ok", "Signed in", "API key · 2.1.284")
    no = await doctor.claude_check(probe(tmp_path, key_signin=bad))
    assert no["state"] == "problem" and no["summary"] == "Anthropic didn't take the API key"
    assert "turned the key down" in no["details"][0] and not no["command"]


async def test_the_downloadable_app_asks_for_a_key_not_a_terminal_login(tmp_path):
    async def none():
        return None

    theirs = await doctor.claude_check(probe(tmp_path, key_signin=none, packaged=lambda: True))
    assert theirs["summary"] == "Not signed in" and not theirs["command"]
    assert "Anthropic API key" in theirs["hint"]
    owners = await doctor.claude_check(probe(tmp_path, key_signin=none, packaged=lambda: False))
    assert owners["command"] == "claude auth login" or owners["command"].endswith("auth login")


async def test_the_downloadable_app_needs_no_swift_compiler(tmp_path):
    helpers = tmp_path / "helpers"
    helpers.mkdir()
    (helpers / "helpers.json").write_text("{}")
    ran = []

    async def run(*argv, timeout=0):
        ran.append(argv)
        return 1, "", ""

    built = await doctor.swift_check(
        doctor.Probe(
            data=tmp_path, logs=tmp_path, home=tmp_path, run=run, helpers_dir=lambda: helpers
        )
    )
    assert built["state"] == "ok" and "built in" in built["summary"] and ran == []
    gone = await doctor.swift_check(
        doctor.Probe(
            data=tmp_path, logs=tmp_path, home=tmp_path, run=run, helpers_dir=lambda: tmp_path / "x"
        )
    )
    assert gone["state"] == "warn"
