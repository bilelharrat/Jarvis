"""Loop detection (jarvis.loopguard, jarvis.features.loops, background.py): the same call
three times in a row, or a cycle of two or three calls going round three times, stops
JARVIS's turn politely (said, and offered another way) and a background task (its heads-up
says why), and puts a notice with a Stop button in an Eden Code session without stopping
it. Progress (different calls, different arguments) never trips it. All on fake Claudes."""

import asyncio

import pytest
from claude_agent_sdk import AssistantMessage, TextBlock, ToolUseBlock
from conftest import FakeClient, result

from jarvis import background, lang, loopguard
from jarvis.features import loops as loops_feature
from jarvis.hub import Hub
from jarvis.loopguard import Loop, LoopGuard
from jarvis.tasks import ClaudeTask


def calls(guard: LoopGuard, *items):
    """Each (name, args) noted in turn; the loops found, by the call that found them."""
    return [(i, found) for i, (name, args) in enumerate(items) if (found := guard.note(name, args))]


# ── the guard ──


def test_the_same_call_three_times_in_a_row_is_a_loop():
    guard = LoopGuard()
    found = calls(
        guard,
        ("recall", {"query": "ann"}),
        ("recall", {"query": "ann"}),
        ("recall", {"query": "ann"}),
    )
    assert [(i, f.kind, f.tools, f.times) for i, f in found] == [(2, "repeat", ["recall"], 3)]


def test_argument_order_doesnt_matter_but_their_values_do():
    guard = LoopGuard()
    same = [
        ("search", {"q": "x", "n": 5}),
        ("search", {"n": 5, "q": "x"}),
        ("search", {"q": "x", "n": 5}),
    ]
    assert len(calls(guard, *same)) == 1
    guard = LoopGuard()
    moving = [("read", {"page": n}) for n in range(10)]  # paging through: progress
    assert calls(guard, *moving) == []


def test_two_and_three_call_cycles_go_round_three_times():
    a, b, c = ("open", {"url": "a"}), ("read", {}), ("back", {})
    guard = LoopGuard()
    found = calls(guard, a, b, a, b, a, b)
    assert [(i, f.kind, f.tools) for i, f in found] == [(5, "cycle", ["open", "read"])]
    guard = LoopGuard()
    found = calls(guard, a, b, c, a, b, c, a, b, c)
    assert [(i, f.kind, f.tools) for i, f in found] == [(8, "cycle", ["open", "read", "back"])]
    guard = LoopGuard()
    assert calls(guard, a, b, a, b, a) == []  # twice round and a bit: not yet


def test_calls_in_between_break_it_and_a_found_loop_starts_over():
    x = ("recall", {"query": "ann"})
    guard = LoopGuard()
    assert calls(guard, x, x, ("recall", {"query": "bob"}), x, x) == []
    guard = LoopGuard()
    found = calls(guard, x, x, x, x, x, x)
    assert [i for i, _ in found] == [2, 5]  # found, then found again only after as many more
    guard.note(*x)
    guard.reset()
    assert guard.note(*x) is None


def test_odd_arguments_never_break_it():
    guard = LoopGuard()
    odd = {"when": object()}  # not JSON: compared by what it is
    assert guard.note("t", odd) is None
    loop = Loop("cycle", ["a", "b"], 3)
    assert "went round the same 2 calls (a, b) 3 times" == loop.describe()
    assert loopguard.fingerprint("t", {"a": 1}) != loopguard.fingerprint("u", {"a": 1})


def test_what_the_owner_hears_in_english_and_chinese():
    repeat = Loop("repeat", ["mcp__memory__recall"], 3)
    said = loops_feature.owner_words(repeat, ["Searched memory"], "en")
    assert said.startswith("I stopped there: I kept repeating the same step (Searched memory)")
    assert said.endswith("Shall I try a different way?")
    cycle = Loop("cycle", ["a", "b"], 3)
    assert "going round in circles (One, Two)" in loops_feature.owner_words(
        cycle, ["One", "Two"], "en"
    )
    zh = loops_feature.owner_words(repeat, ["Some step with no Chinese"], "zh")
    assert zh == "我先停下了：我一直在重复同一步，却没有进展。要我换个办法再试吗？"
    for english in (loops_feature.REPEATED_PLAIN, loops_feature.CIRCLES_PLAIN):
        assert lang.has_cjk(lang.translate(english, "zh"))
    assert lang.has_cjk(lang.tr(loops_feature.CIRCLES, "zh", step="查看了角色"))


# ── JARVIS's own turn ──


def tool_use(n, name="mcp__memory__recall", args=None):
    return AssistantMessage(
        content=[ToolUseBlock(id=f"t{n}", name=name, input=args or {"query": "ann"})], model="m"
    )


class Streaming(FakeClient):
    """As Claude Code's stream is: other work runs between one message and the next."""

    async def receive_response(self):
        for message in self.script:
            await asyncio.sleep(0)
            yield message


@pytest.fixture
def make_hub(settings, quiet_speaker, isolated):
    made = []

    def make():
        hub = Hub(settings, client_factory=Streaming, speaker=quiet_speaker, poll=False, **isolated)
        made.append(hub)
        return hub

    yield make
    FakeClient.script = []


async def test_a_turn_going_round_in_circles_is_stopped_and_says_so(make_hub):
    FakeClient.script = [
        AssistantMessage(content=[TextBlock(text="Let me look.")], model="m"),
        tool_use(1),
        tool_use(2),
        tool_use(3),
        tool_use(4),  # after the stop: not weighed again
        result(text="..."),
    ]
    hub = make_hub()
    said = []
    hub.say = lambda text, follow_up=True: said.append(text)
    await hub.start()
    reply = await hub.ask("who is ann?")
    await asyncio.sleep(0.05)  # the stop and the words, spawned
    assert reply.startswith("Let me look. I stopped there: I kept repeating the same step")
    assert reply.endswith("Shall I try a different way?")
    assert hub.client.interrupted and len(said) == 1 and said[0] in reply
    assert hub.history[-1]["text"] == reply
    # Claude hears why with the next request, and that it should try something else.
    assert "stopped your last turn" in hub._style_note and "different approach" in hub._style_note
    assert "recall with the same arguments 3 times" in hub._style_note


async def test_a_turn_making_progress_runs_on_and_each_turn_starts_over(make_hub):
    FakeClient.script = [
        tool_use(1),
        tool_use(2),
        tool_use(3, args={"query": "bob"}),
        AssistantMessage(content=[TextBlock(text="Ann is your co-founder.")], model="m"),
        result(),
    ]
    hub = make_hub()
    await hub.start()
    assert await hub.ask("who is ann?") == "Ann is your co-founder."
    FakeClient.script = [
        tool_use(1),
        AssistantMessage(content=[TextBlock(text="Yes.")], model="m"),
        result(),
    ]
    assert await hub.ask("and again?") == "Yes."  # two from before and one now: never three
    assert not hub.client.interrupted


async def test_the_same_call_made_several_times_at_once_is_one_step(make_hub):
    batch = AssistantMessage(
        content=[
            ToolUseBlock(id=f"b{i}", name="mcp__mac__list_events", input={}) for i in range(3)
        ],
        model="m",
    )
    FakeClient.script = [
        batch,
        AssistantMessage(content=[TextBlock(text="Done.")], model="m"),
        result(),
    ]
    hub = make_hub()
    await hub.start()
    assert await hub.ask("what's on this week?") == "Done." and not hub.client.interrupted


async def test_in_chinese_the_stop_is_said_in_chinese(make_hub):
    FakeClient.script = [tool_use(1), tool_use(2), tool_use(3), result()]
    hub = make_hub()
    hub.prefs.language = "zh"
    said = []
    hub.say = lambda text, follow_up=True: said.append(text)
    await hub.start()
    reply = await hub.ask("安是谁？")
    await asyncio.sleep(0.05)
    assert reply.startswith("我先停下了") and said == [reply]


# ── background tasks ──


async def test_a_background_task_that_loops_stops_and_its_heads_up_says_why(make_hub):
    FakeClient.script = [
        tool_use(1, "WebSearch", {"query": "flights"}),
        tool_use(2, "WebSearch", {"query": "flights"}),
        tool_use(3, "WebSearch", {"query": "flights"}),
        AssistantMessage(content=[TextBlock(text="Found them.")], model="m"),
        result(text="Found them.", cost=0.05),
    ]
    hub = make_hub()
    alerts = []
    hub.add_notify_sink(alerts.append)
    task = hub.background.start("Find flights.", words="find flights in the background")
    await asyncio.wait_for(asyncio.shield(task.handle), 10)
    assert task.status == "failed" and task.cost_usd == 0.05 and not task.report_path
    [alert] = alerts
    assert alert.text.startswith(
        "Your background task didn't finish: it kept repeating the same steps without getting "
        "anywhere, so it stopped itself"
    )
    assert lang.translate(background.LOOPED, "zh").startswith("它一直在重复同样的步骤")


# ── Eden Code ──


async def test_a_jarvis_code_session_gets_a_notice_with_stop_never_a_stop(make_hub, tmp_path):
    hub = make_hub()
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    tasks = hub.tasks
    task = ClaudeTask(id=7, prompt="fix it", cwd=tmp_path)
    tasks.tasks[7] = task

    def step(text, detail):
        tasks._log(task, "tool", text, tool="Bash", tool_id=text, detail=detail, status="running")

    for _ in range(3):
        step("Running the tests", "pytest -q")
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    notices = [e for e in task.transcript if e["role"] == "loop"]
    assert len(notices) == 1
    [notice] = notices
    assert notice["task_id"] == 7 and notice["kind"] == "repeat" and notice["times"] == 3
    assert notice["steps"] == ["Running the tests"] and task.status == "running"
    assert ("task_log", {"id": 7, "entry": notice}) in events
    # The owner writes to it: a fresh start, and different steps are progress.
    tasks._log(task, "user", "try the other test")
    step("Running the tests", "pytest -q")
    step("Running the tests", "pytest -q")
    step("Reading app.py", "app.py")
    for n in range(4):
        step("Editing app.py", f"change {n}")
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert len([e for e in task.transcript if e["role"] == "loop"]) == 1
    task.status = "done"  # a notice due after the session finished isn't shown
    for _ in range(3):
        step("Reading app.py", "app.py")
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert len([e for e in task.transcript if e["role"] == "loop"]) == 1
