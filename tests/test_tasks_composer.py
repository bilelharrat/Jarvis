"""Jarvis Code's composer features, as in Claude Code: steering, Auto mode, ultracode, more
folders, plugins, connectors per session, and another provider's model."""

from claude_agent_sdk import AssistantMessage, TextBlock, ToolUseBlock, UserMessage
from conftest import FakeClient
from test_tasks import res, until

from jarvis.tasks import SDK_MODES, TaskManager


class SteerClient(FakeClient):
    """What the real CLI did when a message came in mid-step (checked live): it took it up
    after the running tool, and both answers came back in one reply."""

    def __init__(self, options=None):
        super().__init__(options)
        SteerClient.last = self

    async def query(self, text):
        self.queries.append(text)
        if len(self.queries) == 1:  # the first step: a tool is running
            self._stream().put_nowait(UserMessage(content=str(text), uuid="u-1"))
            self._stream().put_nowait(
                AssistantMessage(
                    content=[ToolUseBlock(id="t1", name="Bash", input={"command": "sleep 4"})],
                    model="m",
                )
            )

    def finish(self):
        self._stream().put_nowait(UserMessage(content=self.queries[-1], uuid="u-2"))
        self._stream().put_nowait(
            AssistantMessage(content=[TextBlock(text="FIRST\n\nSECOND")], model="m")
        )
        self._stream().put_nowait(res("FIRST SECOND", 0.02))


def make(settings, client=SteerClient):
    events = []

    async def approve(*_a, **_k):
        return "deny"

    return TaskManager(
        settings, approve, lambda kind, **d: events.append((kind, d)), client
    ), events


async def test_a_follow_up_steers_the_running_step_when_asked(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = make(settings)
    tm.steer_now = lambda: True
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    tm.send(task.id, "run the slow thing")
    assert await until(lambda: task.busy and task.current == "user")
    assert tm.send(task.id, "and say SECOND at the end")
    assert await until(lambda: len(SteerClient.last.queries) == 2)
    assert task.inbox.empty() and task.steered == 1 and task.turns_pending == 1
    SteerClient.last.finish()
    assert await until(lambda: not task.busy and task.status == "waiting")
    assert task.steered == 0 and task.turns_pending == 0
    assert task.checkpoints == ["u-1", "u-2"]  # both are points to undo to
    users = [e["text"] for e in task.transcript if e["role"] == "user"]
    assert users == ["run the slow thing", "and say SECOND at the end"]
    assert task.result == "FIRST\n\nSECOND"
    task.handle.cancel()


async def test_with_queueing_on_a_follow_up_waits(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = make(settings)
    tm.steer_now = lambda: False
    task = tm.start("", "proj")
    assert await until(lambda: task.status == "waiting")
    tm.send(task.id, "run the slow thing")
    assert await until(lambda: task.busy)
    tm.send(task.id, "then the docs")
    assert [i["text"] for i in task.inbox.public()] == ["then the docs"]
    assert len(SteerClient.last.queries) == 1
    task.handle.cancel()


async def test_auto_mode_needs_a_model_that_has_it(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = make(settings, FakeClient)
    haiku = tm.start("", "proj", mode="smart", model="claude-haiku-4-5-20251001")
    assert haiku.mode == "ask"
    assert not tm.set_mode(haiku.id, "smart") and haiku.mode == "ask"
    sonnet = tm.start("", "proj", mode="smart", model="claude-sonnet-5-5")
    assert (
        sonnet.mode == "smart"
        and tm.options_for(sonnet).permission_mode == SDK_MODES["smart"] == "auto"
    )
    assert tm.options_for(sonnet).permission_mode == "auto"
    for t in (haiku, sonnet):
        t.handle.cancel()


async def test_ultracode_goes_with_every_message_but_not_the_transcript(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = make(settings, FakeClient)
    FakeClient.script = []
    task = tm.start("", "proj", ultracode=True)
    assert await until(lambda: task.status == "waiting")
    tm.send(task.id, "migrate the tests to pytest")
    assert await until(lambda: task.client and task.client.queries)
    assert (
        task.client.queries[-1].endswith("ultracode")
        and "migrate the tests" in task.client.queries[-1]
    )
    assert [e["text"] for e in task.transcript if e["role"] == "user"] == [
        "migrate the tests to pytest"
    ]
    assert tm.set_ultracode(task.id, False) and not task.ultracode
    task.handle.cancel()


async def test_folders_plugins_connectors_and_models_reach_the_options(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    (tmp_path / "shared-lib").mkdir()
    plugin = tmp_path / "my-plugin"
    (plugin / ".claude-plugin").mkdir(parents=True)
    (plugin / ".claude-plugin" / "plugin.json").write_text('{"name": "my-plugin"}')
    tm, _ = make(settings, FakeClient)
    task = tm.start("", "proj")
    assert tm.add_dir(task.id, str(tmp_path / "shared-lib")) == ""
    assert task.reopen and "already" in tm.add_dir(task.id, str(tmp_path / "shared-lib"))
    assert "pick a project folder" in tm.add_dir(task.id, "~")
    assert "isn't a Claude Code plugin" in tm.add_plugin(task.id, str(tmp_path / "shared-lib"))
    assert tm.add_plugin(task.id, str(plugin)) == ""
    assert tm.set_mcp(task.id, "github", False) and not tm.set_mcp(task.id, "bad name!", False)
    assert tm.set_env(
        task.id, "openai/gpt-5", {"ANTHROPIC_BASE_URL": "https://openrouter.ai/api"}, "GPT-5"
    )
    opts = tm.options_for(task)
    assert opts.add_dirs == [str((tmp_path / "shared-lib").resolve())]
    assert opts.plugins == [{"type": "local", "path": str(plugin.resolve())}]
    assert "mcp__github" in opts.disallowed_tools
    assert (
        opts.env == {"ANTHROPIC_BASE_URL": "https://openrouter.ai/api"}
        and opts.model == "openai/gpt-5"
    )
    public = task.public()
    assert public["mode_label"] == "Manual" and public["model_label"] == "GPT-5"
    assert public["disabled_mcp"] == ["github"] and public["add_dirs"] and public["plugins"]
    task.handle.cancel()


def test_voice_says_auto_for_auto_and_full_auto_for_bypass():
    from jarvis import voicecode as vc

    assert [vc.parse(u).arg for u in ("auto mode", "full auto", "bypass permissions")] == [
        "smart",
        "auto",
        "auto",
    ]
    intent = vc.parse("auto mode and fix the flaky test")
    assert intent.kind == "mode" and intent.arg == "smart" and intent.text == "fix the flaky test"
    assert vc.MODE_NAMES["smart"].startswith("Auto mode")


async def test_switching_to_haiku_leaves_auto_for_manual(settings, tmp_path):
    (tmp_path / "proj").mkdir()
    tm, _ = make(settings, FakeClient)
    task = tm.start("", "proj", mode="smart", model="claude-sonnet-5-5")
    assert task.mode == "smart"
    assert await tm.set_model(task.id, "claude-haiku-4-5-20251001")
    assert task.mode == "ask"
    assert any("Permission mode: Manual." == e["text"] for e in task.transcript)
    task.handle.cancel()


async def test_pictures_pdfs_and_text_files_go_as_blocks_with_their_names():
    from jarvis.tasks import _with_images, attachment_counts

    items = [
        {"media_type": "image/png", "data": "iVBOR", "name": "shot.png"},
        {"media_type": "application/pdf", "data": "JVBERi0", "name": "spec.pdf"},
        {"media_type": "text/x-python", "data": "print('hi')\n", "name": "hi.py"},
        {"media_type": "application/json", "data": "{}", "name": "data.json"},
        {"media_type": "application/zip", "data": "UEsDB", "name": "stuff.zip"},
    ]
    message = [m async for m in _with_images("look", items)][0]["message"]["content"]
    assert [b["type"] for b in message] == ["image", "document", "document", "document", "text"]
    assert message[1]["source"] == {
        "type": "base64",
        "media_type": "application/pdf",
        "data": "JVBERi0",
    }
    assert message[1]["title"] == "spec.pdf"
    assert message[2]["source"] == {
        "type": "text",
        "media_type": "text/plain",
        "data": "print('hi')\n",
    }
    assert message[2]["title"] == "hi.py" and message[3]["title"] == "data.json"
    assert attachment_counts(items) == {
        "images": 1,
        "files": ["spec.pdf", "hi.py", "data.json", "stuff.zip"],
    }
    assert attachment_counts([{"media_type": "image/jpeg", "data": "x"}]) == {"images": 1}


def test_typed_mode_commands_use_the_menu_names():
    from jarvis.voicecode import slash_intent

    modes = {
        n: slash_intent(n, "").arg for n in ("plan", "manual", "ask", "edits", "auto", "bypass")
    }
    assert modes == {
        "plan": "plan",
        "manual": "ask",
        "ask": "ask",
        "edits": "edits",
        "auto": "smart",  # Claude Code's Auto, never Bypass
        "bypass": "auto",
    }
    assert slash_intent("deploy", "staging") is None  # a custom command: to the session as typed
