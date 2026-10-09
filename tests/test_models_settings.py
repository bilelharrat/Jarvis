"""Settings › Eden Code › Models & API keys, and the composer's model picker: a key goes
from the window to the Keychain and never comes back; sessions on another provider's
model get its environment, and leave it when switched back to Claude."""

import json

from test_hub import drain, make_hub

KEY = "sk-or-v1-" + "0123456789abcdef" * 4


async def test_a_provider_key_never_comes_back_to_the_window(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub._handle({"type": "providers_add", "kind": "openrouter", "name": "", "key": KEY})
    events = drain(q)
    assert KEY not in json.dumps(events) and KEY[-12:] not in json.dumps(events)
    listed = [e for e in events if e["type"] == "providers"][-1]
    (provider,) = listed["providers"]
    assert provider["kind"] == "openrouter" and provider["key_hint"].endswith(KEY[-4:])
    await hub._handle(
        {"type": "providers_add_model", "id": provider["id"], "model": "openai/gpt-5"}
    )
    models = [e for e in drain(q) if e["type"] == "providers"][-1]["models"]
    custom = [m for m in models if not m["builtin"]]
    assert [m["model"] for m in custom] == ["openai/gpt-5"]
    assert KEY not in json.dumps(hub.snapshot())


async def test_add_all_puts_every_listed_model_in_the_picker(settings, quiet_speaker, isolated):
    from jarvis.providers import MAX_MODELS

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    provider = hub.providers.add_provider("openrouter", "", KEY)
    q = hub.subscribe()
    listed = [
        {"model": "google/gemini-2.5-pro", "label": "Gemini 2.5 Pro"},
        {"model": "google/gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
        "not a model",
    ]
    await hub._handle({"type": "providers_add_models", "id": provider["id"], "models": listed})
    events = drain(q)
    picker = [e for e in events if e["type"] == "providers"][-1]["models"]
    assert [(m["model"], m["label"]) for m in picker if not m["builtin"]] == [
        ("google/gemini-2.5-pro", "Gemini 2.5 Pro"),
        ("google/gemini-2.5-flash", "Gemini 2.5 Flash"),
    ]
    assert not [e for e in events if e["type"] == "providers_error"]
    many = [{"model": f"google/gemini-9.{n}-flash"} for n in range(MAX_MODELS)]
    await hub._handle({"type": "providers_add_models", "id": provider["id"], "models": many})
    (error,) = [e for e in drain(q) if e["type"] == "providers_error"]
    assert error["text"].startswith(f"Added {MAX_MODELS - 2}.")


async def test_bad_input_is_said_plainly(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    q = hub.subscribe()
    await hub._handle({"type": "providers_add", "kind": "openrouter", "key": ""})
    errors = [e for e in drain(q) if e["type"] == "providers_error"]
    assert errors and errors[0]["text"]


async def test_sessions_take_the_provider_model_and_can_go_back(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    store = hub.providers
    provider = store.add_provider("openrouter", "", KEY)
    ref = store.add_model(provider["id"], "openai/gpt-5")["ref"]
    (tmp_path / "proj").mkdir()
    await hub._handle({"type": "task_new", "directory": "proj", "model": ref})  # in projects_dir
    task = list(hub.tasks.tasks.values())[-1]
    assert task.model == "openai/gpt-5" and task.model_ref == ref
    # The key is nowhere a shell command could read it: a Keychain helper fetches it.
    settings_json = json.loads(task.provider_settings)
    assert settings_json["apiKeyHelper"] and settings_json["env"]["ANTHROPIC_BASE_URL"].startswith(
        "https://openrouter.ai"
    )
    options = hub.tasks.options_for(task)
    assert KEY not in json.dumps(dict(options.env)) and KEY not in (options.settings or "")
    assert KEY not in json.dumps(task.public()) and "OpenRouter" in task.public()["model_label"]
    await hub._handle({"type": "task_model", "id": task.id, "ref": "sonnet"})
    assert task.env == {} and task.provider_settings == "" and task.reopen
    assert task.model == "claude-sonnet-5-5" and task.model_ref == "sonnet"
    assert task.model_label == "Sonnet 5.5" and hub.tasks.options_for(task).settings is None
    task.handle.cancel()


async def test_a_default_model_must_be_on_the_list(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    await hub._handle(
        {"type": "code_defaults", "code_model": "custom:nothere", "code_effort": "max"}
    )
    assert hub.prefs.code_model == "" and hub.prefs.code_effort == "max"
    await hub._handle({"type": "code_defaults", "code_model": "haiku"})
    assert hub.prefs.code_model == "haiku"


async def test_removing_a_provider_moves_its_sessions_back_to_claude(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    provider = hub.providers.add_provider("openrouter", "", KEY)
    ref = hub.providers.add_model(provider["id"], "openai/gpt-5")["ref"]
    (tmp_path / "proj").mkdir()
    await hub._handle({"type": "task_new", "directory": "proj", "model": ref})
    task = list(hub.tasks.tasks.values())[-1]
    assert json.loads(hub.tasks.options_for(task).settings)["apiKeyHelper"]  # fresh each time
    await hub._handle({"type": "providers_remove", "id": provider["id"]})
    assert task.model_ref == "" and task.provider_settings == "" and task.env == {}
    assert hub.tasks.options_for(task).settings is None
    task.handle.cancel()
