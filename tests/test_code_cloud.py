"""Jarvis Code in the cloud (features/code_cloud.py): sessions started there, and every working
session moved there with one card, on top of the hand-offs (faked here)."""

from __future__ import annotations

import asyncio
import itertools
from types import SimpleNamespace

from jarvis.features import code_cloud
from jarvis.features.code_cloud import Cloud


class Task(SimpleNamespace):
    pass


class Tasks:
    def __init__(self):
        self.tasks = {}
        self.ids = itertools.count(1)
        self.sent, self.interrupted, self.logged = [], [], []

    def add(self, **kw):
        task = Task(
            id=next(self.ids), kind="code", busy=False, workspace={}, title="", prompt="",
            last_action="", cwd="/p",
        )  # fmt: skip
        task.__dict__.update(kw)
        self.tasks[task.id] = task
        return task

    async def interrupt(self, task_id):
        self.interrupted.append(task_id)
        self.tasks[task_id].busy = False
        return True

    def send(self, task_id, text, images=None):
        self.sent.append((task_id, text))
        return True

    def _log(self, task, kind, text):
        self.logged.append((task.id, text))

    def _changed(self):
        pass


class Desk:
    def __init__(self, machines=("jarvis-cloud",)):
        self.machines = [SimpleNamespace(alias=a, ok=True, problem="") for a in machines]
        self.handed = []
        self.records = {}

    def load(self):
        pass

    def machine(self, alias):
        return next((m for m in self.machines if m.alias == alias), None)

    def of_task(self, task):
        return self.records.get(task.id)

    def tr(self, text):
        return text

    async def hand_off(self, task, alias, instructions="", by_voice=False, preapproved=False):
        self.handed.append((task.id, alias, instructions, preapproved))
        return f"Handed off to {alias}: it carries on there."


class Hub:
    def __init__(self, answer="go", machines=("jarvis-cloud",)):
        self.tasks = Tasks()
        self.code_handoff = Desk(machines)
        self.prefs = SimpleNamespace(features={}, feature=lambda key: None)
        self.events, self.cards, self.spawned, self.said = [], [], [], []
        self.answer = answer

    def emit(self, kind, **values):
        self.events.append((kind, values))

    async def request_approval(self, question, detail, choices, context=None):
        self.cards.append((question, detail, choices))
        return self.answer

    def _spawn(self, coro):
        self.spawned.append(asyncio.ensure_future(coro))

    def _say(self, text):
        self.said.append(text)

    async def _handle(self, msg):
        # The hub's own task_new: a new session, its isolated copy made a moment later.
        task = self.tasks.add(prompt=msg["prompt"], title=msg.get("title", ""))
        task.isolate = msg.get("isolated")

        async def copy_made():
            await asyncio.sleep(0.05)
            task.workspace = {"slug": f"s{task.id}"}

        asyncio.ensure_future(copy_made())


def test_a_session_started_in_the_cloud_hands_its_first_message_over():
    hub = Hub()
    cloud = Cloud(hub)

    async def go():
        result = await cloud.task_new(
            {"type": "task_new", "cloud": True, "prompt": "Fix the flaky test", "directory": "/p"}
        )
        await asyncio.gather(*hub.spawned)
        return result

    assert asyncio.run(go()) is None  # taken here
    task = hub.tasks.tasks[1]
    assert task.prompt == "" and task.isolate is True  # nothing runs here first
    assert task.title == "Fix the flaky test"
    assert hub.code_handoff.handed == [(1, "jarvis-cloud", "Fix the flaky test", True)]
    assert hub.cards == []  # the owner asked for the cloud: no second card


def test_without_cloud_or_a_prompt_the_hub_starts_it_as_usual():
    cloud = Cloud(Hub())
    assert (
        asyncio.run(cloud.task_new({"type": "task_new", "prompt": "x", "directory": "/p"})) is False
    )
    assert asyncio.run(cloud.task_new({"type": "task_new", "cloud": True, "prompt": ""})) is False
    resumed = {"type": "task_new", "cloud": True, "prompt": "x", "session_id": "abc"}
    assert asyncio.run(cloud.task_new(resumed)) is False


def test_without_a_machine_it_says_so():
    hub = Hub(machines=())
    cloud = Cloud(hub)
    asyncio.run(
        cloud.task_new({"type": "task_new", "cloud": True, "prompt": "x", "directory": "/p"})
    )
    assert hub.events[-1][0] == "error" and "Machines" in hub.events[-1][1]["text"]
    assert hub.tasks.tasks == {}


def test_no_isolated_copy_runs_it_here():
    hub = Hub()
    cloud = Cloud(hub)
    code_cloud.COPY_WAIT = 0.1
    try:
        task = hub.tasks.add()
        said = asyncio.run(cloud.to_cloud(task, "jarvis-cloud", "Do it"))
    finally:
        code_cloud.COPY_WAIT = 90.0
    assert "runs here" in said and hub.tasks.sent == [(task.id, "Do it")]


def test_heading_out_moves_every_working_session_after_one_card():
    hub = Hub()
    tm = hub.tasks
    busy = tm.add(busy=True, workspace={"slug": "a"}, title="Refactor", last_action="Running tests")
    idle = tm.add(workspace={"slug": "b"}, title="Idle")
    shared = tm.add(busy=True, title="In the folder")  # no isolated copy
    cloud = Cloud(hub)
    said = asyncio.run(cloud.away())
    assert len(hub.cards) == 1
    question, detail, _ = hub.cards[0]
    assert question == "Move 1 working session to jarvis-cloud?"
    assert "Refactor" in detail and "In the folder" in detail and "Idle" not in detail
    assert tm.interrupted == [busy.id]
    moved = hub.code_handoff.handed
    assert [(m[0], m[1], m[3]) for m in moved] == [(busy.id, "jarvis-cloud", True)]
    assert "Running tests" in moved[0][2]
    assert said.startswith("Moved 1 of 1 to jarvis-cloud")
    assert idle.id not in tm.interrupted and shared.id not in tm.interrupted


def test_heading_out_can_be_declined_or_have_nothing_to_move():
    hub = Hub(answer="deny")
    hub.tasks.add(busy=True, workspace={"slug": "a"})
    assert asyncio.run(Cloud(hub).away()) == "Left them here."
    assert hub.code_handoff.handed == []
    assert "nothing to move" in asyncio.run(Cloud(Hub()).away())
    hub = Hub()
    hub.tasks.add(busy=True)  # only a shared-folder session
    assert "can't move" in asyncio.run(Cloud(hub).away())


def test_sessions_already_on_a_machine_arent_moved_again():
    hub = Hub()
    task = hub.tasks.add(busy=True, workspace={"slug": "a"})
    hub.code_handoff.records[task.id] = SimpleNamespace(live=True)
    assert "nothing to move" in asyncio.run(Cloud(hub).away())


def test_the_machine_is_the_one_settings_names_or_the_only_one():
    hub = Hub(machines=("studio",))
    assert Cloud(hub).alias() == "studio"
    hub = Hub(machines=("studio", "box"))
    assert Cloud(hub).alias() == ""
    hub = Hub(machines=("studio", "jarvis-cloud"))
    assert Cloud(hub).alias() == "jarvis-cloud"
    Cloud(hub).state()
    assert hub.events[-1] == (
        "code_cloud",
        {"machine": "jarvis-cloud", "ready": True, "problem": ""},
    )
