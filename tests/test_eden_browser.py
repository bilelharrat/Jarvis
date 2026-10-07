"""Do this on a website (jarvis.eden_browser over jarvis.mcp_endpoint): a browser task starts
only on the owner's yes on a card, runs as its own Claude session (a FakeClient here) with the
browser agent's tools in its own tab, shows each step without what was typed, lists the cards
waiting on the Mac without ever answering them, and stops on browser_task_stop. Its gates
stay: a press the window marks asks on a card even with "Control my Mac without asking" on,
and every call goes through the hub's browser_call (the purchase guard). No real browser."""

import asyncio
import json

import pytest
from claude_agent_sdk import AssistantMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage
from conftest import FakeClient, result

from jarvis import eden_actions, eden_browser
from jarvis.eden_browser import browser_for
from jarvis.hub import Hub
from jarvis.mcp_endpoint import Endpoint

OPEN = "mcp__eden_web__browser_open"
ACT = "mcp__eden_web__browser_act"


def make_hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub.set_feature_prefs({"mcp_ask": False})
    hub.browser_available = True
    return hub


def endpoint_for(hub):
    endpoint = Endpoint(hub, hub.feature_path("mcp"))
    endpoint.token = "the-token"
    return endpoint


@pytest.fixture
def scripted():
    FakeClient.script = [
        AssistantMessage(
            content=[ToolUseBlock(id="s1", name=OPEN, input={"url": "https://www.tap.pt/en"})],
            model="m",
        ),
        UserMessage(
            content=[
                ToolResultBlock(
                    tool_use_id="s1", content="Opened.\nTAP — https://www.tap.pt/en", is_error=False
                )
            ]
        ),
        AssistantMessage(
            content=[
                ToolUseBlock(
                    id="s2",
                    name=ACT,
                    input={"action": "type", "ref": "e4", "text": "hunter2 secret", "submit": True},
                )
            ],
            model="m",
        ),
        UserMessage(
            content=[
                ToolResultBlock(
                    tool_use_id="s2", content="Typed into textbox “From”", is_error=False
                )
            ]
        ),
        AssistantMessage(
            content=[ToolUseBlock(id="s3", name=ACT, input={"action": "click", "ref": "e9"})],
            model="m",
        ),
        UserMessage(
            content=[ToolResultBlock(tool_use_id="s3", content="The user said no.", is_error=True)]
        ),
        AssistantMessage(
            content=[TextBlock(text="Found three flights; the cheapest is €89.")], model="m"
        ),
        result(text="Found three flights; the cheapest is €89.", cost=0.07),
    ]
    yield
    FakeClient.script = []


async def answer_card(hub, choice, question_part=""):
    for _ in range(500):
        await asyncio.sleep(0)
        for card in list(hub.approvals.values()):
            if question_part in card["question"]:
                assert hub.resolve(card["id"], choice)
                return card
    raise AssertionError("no card went up")


async def status(endpoint, ident, **extra):
    text, error = await endpoint.call("browser_task_status", {"id": ident, **extra}, "Eden")
    assert not error, text
    return json.loads(text)


async def test_a_task_starts_only_on_a_yes_and_shows_its_steps(
    settings, quiet_speaker, isolated, scripted
):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub)
    text, error = await endpoint.call(
        "browser_task",
        {"goal": "Find the cheapest flight to Lisbon on the 18th", "url": "tap.pt"},
        "Eden",
    )
    assert not error
    started = json.loads(text)
    assert started["status"] == "waiting_owner"
    for _ in range(50):  # the task asks as soon as it runs
        await asyncio.sleep(0)
    seen = await status(endpoint, started["id"])
    [waiting] = seen["approvals"]  # the start card itself, for Eden to show
    assert waiting["question"] == "Let Eden use the built-in browser for this?"
    card = await answer_card(hub, "allow", "built-in browser")
    assert "“Find the cheapest flight to Lisbon on the 18th”" in card["detail"]
    assert "Starting at: https://tap.pt" in card["detail"]
    assert [c["id"] for c in card["choices"]] == ["allow", "deny"]  # no pictures asked for
    task = browser_for(endpoint).tasks[started["id"]]
    await asyncio.wait_for(asyncio.shield(task.handle), 5)
    seen = await status(endpoint, started["id"], thumbnail=True)
    assert seen["status"] == "done" and seen["cost"] == 0.07 and seen["approvals"] == []
    assert seen["result"] == "Found three flights; the cheapest is €89."
    assert [(s["label"], s["detail"], s["ok"]) for s in seen["steps"]] == [
        ("Opened a page", "tap.pt", True),
        ("Acted on the page", "Typed into textbox “From”", True),
        ("Acted on the page", "The user said no.", False),
    ]
    assert "hunter2" not in json.dumps(seen)  # what was typed never shows
    assert seen["thumbnail"] is None and seen["shots"] is False
    # Eden's Activity timeline has it, as something that can't be undone.
    items = json.loads((await endpoint.call("actions_list", {}, "Eden"))[0])["items"]
    assert items[0]["kind"] == "browser" and items[0]["undo"] == {
        "possible": False,
        "why": eden_actions.NEVER["browser_task"],
    }
    listing = json.loads((await endpoint.call("browser_task_status", {}, "Eden"))[0])
    assert [t["id"] for t in listing["tasks"]] == [started["id"]]


async def test_a_no_on_the_card_does_nothing(settings, quiet_speaker, isolated, scripted):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub)
    started = json.loads((await endpoint.call("browser_task", {"goal": "Book a table"}, "Eden"))[0])
    await answer_card(hub, "deny", "built-in browser")
    task = browser_for(endpoint).tasks[started["id"]]
    await asyncio.wait_for(asyncio.shield(task.handle), 5)
    seen = await status(endpoint, started["id"])
    assert seen["status"] == "declined" and seen["steps"] == []
    assert json.loads((await endpoint.call("actions_list", {}, "Eden"))[0])["items"] == []


async def test_pictures_only_when_the_owner_chose_them(settings, quiet_speaker, isolated, scripted):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub)
    desk = browser_for(endpoint)
    calls = []

    async def browser_call(action, args=None):
        calls.append((action, dict(args or {})))
        return {"ok": True, "png": "iVBORw0KGgo=", "url": "https://www.tap.pt/en", "tab": 7}

    hub.browser_call = browser_call
    desk.make_thumbnail = lambda png: "data:image/jpeg;base64,c21hbGw="
    started = json.loads(
        (
            await endpoint.call(
                "browser_task", {"goal": "Find flights", "screenshots": True}, "Eden"
            )
        )[0]
    )
    card = await answer_card(hub, "shots", "built-in browser")
    assert [c["label"] for c in card["choices"]] == [
        "Start, and show pictures",
        "Start",
        "Don't start",
    ]
    task = desk.tasks[started["id"]]
    await asyncio.wait_for(asyncio.shield(task.handle), 5)
    task.tab = 7
    seen = await status(endpoint, started["id"], thumbnail=True)
    assert seen["shots"] is True and seen["thumbnail"] == "data:image/jpeg;base64,c21hbGw="
    assert calls == [("screenshot", {"tab": 7, "owner": f"eden:{started['id']}"})]


async def test_stop_ends_it_and_answers_its_cards_no(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub)
    started = json.loads((await endpoint.call("browser_task", {"goal": "Find flights"}, "Eden"))[0])
    for _ in range(50):
        await asyncio.sleep(0)
    assert hub.approvals  # the start card is up
    text, error = await endpoint.call("browser_task_stop", {"id": started["id"]}, "Eden")
    assert not error and json.loads(text) == {"stopped": True, "status": "stopped"}
    task = browser_for(endpoint).tasks[started["id"]]
    await asyncio.gather(task.handle, return_exceptions=True)
    assert not hub.approvals and task.status in ("stopped", "declined")
    again = json.loads((await endpoint.call("browser_task_stop", {"id": started["id"]}, "Eden"))[0])
    assert again["stopped"] is False


@pytest.mark.parametrize(
    "args, why",
    [
        ({}, "Say what the browser task should do"),
        ({"goal": "  "}, "Say what the browser task should do"),
        ({"goal": "x", "url": "javascript:alert(1)"}, "web address"),
        ({"goal": "x", "url": 5}, "url is text"),
    ],
)
async def test_bad_starts_put_up_no_card(settings, quiet_speaker, isolated, args, why):
    hub = make_hub(settings, quiet_speaker, isolated)
    text, error = await endpoint_for(hub).call("browser_task", args, "Eden")
    assert error and why in text and not hub.approvals


async def test_no_browser_window_no_task_and_one_at_a_time(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub)
    hub.browser_available = False
    text, error = await endpoint.call("browser_task", {"goal": "Find flights"}, "Eden")
    assert error and "J.A.R.V.I.S. app window" in text
    hub.browser_available = True
    first = json.loads((await endpoint.call("browser_task", {"goal": "Find flights"}, "Eden"))[0])
    text, error = await endpoint.call("browser_task", {"goal": "Find hotels"}, "Eden")
    assert error and "running already" in text
    await endpoint.call("browser_task_stop", {"id": first["id"]}, "Eden")
    await asyncio.gather(browser_for(endpoint).tasks[first["id"]].handle, return_exceptions=True)
    assert (await endpoint.call("browser_task_status", {"id": "bt-nope"}, "Eden"))[1]


async def test_the_tools_keep_to_their_tab_and_their_presses_ask(settings, quiet_speaker, isolated):
    """The task's own tools: open makes its tab and later calls go there whatever tab the
    model names; a press the window marks needs a card (Control my Mac without asking
    doesn't count); a card that comes up mid-task is listed with the task."""
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.set_prefs({"control_always": True})
    desk = browser_for(endpoint_for(hub))
    task = eden_browser.BrowserTask(
        id="bt-0123456789", goal="Buy socks", url="", app="Eden", want_shots=False
    )
    task.status = "running"
    desk.tasks[task.id] = task
    desk._listen()
    calls = []

    async def browser_call(action, args=None):
        calls.append((action, dict(args or {})))
        if action == "act" and not args.get("force"):
            return {
                "ok": False,
                "needsConfirm": True,
                "label": "Place order",
                "url": "https://shop.example/checkout",
                "tab": 9,
            }
        return {
            "ok": True,
            "tab": 9,
            "url": "https://shop.example/",
            "title": "Shop",
            "message": "Clicked “Place order”",
        }

    hub.browser_call = browser_call
    tools = {t.name: t for t in desk.tools(task)}
    await tools["browser_open"].handler({"url": "shop.example"})
    assert task.tab == 9 and calls[0] == (
        "open",
        {"url": "shop.example", "newTab": True, "background": True, "owner": "eden:bt-0123456789"},
    )

    async def act():
        eden_browser.CURRENT.set(task.id)
        return await tools["browser_act"].handler({"action": "click", "ref": "e3", "tab": 2})

    pressing = asyncio.get_running_loop().create_task(act())
    for _ in range(200):
        await asyncio.sleep(0)
        if task.approvals:
            break
    [waiting] = task.approvals.values()
    assert waiting["question"] == "Press “Place order” in the built-in browser?"
    assert "Buy socks" in waiting["detail"]
    await answer_card(hub, "deny", "Place order")
    out = await pressing
    assert out["is_error"] and "said no" in out["content"][0]["text"]
    assert [c for c in calls if c[0] == "act"] == [
        ("act", {"kind": "click", "ref": "e3", "owner": "eden:bt-0123456789", "tab": 9})
    ]  # its own tab, not the one the model named; never forced without the yes
    assert task.approvals == {}  # gone with its card


async def test_a_finished_task_is_still_there_after_a_restart(
    settings, quiet_speaker, isolated, scripted
):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub)
    started = json.loads((await endpoint.call("browser_task", {"goal": "Find flights"}, "Eden"))[0])
    await answer_card(hub, "allow", "built-in browser")
    await asyncio.wait_for(asyncio.shield(browser_for(endpoint).tasks[started["id"]].handle), 5)
    before = await status(endpoint, started["id"])
    again = endpoint_for(hub)  # a new endpoint, so a new EdenBrowser: as after a restart
    assert browser_for(again) is not browser_for(endpoint)
    after = await status(again, started["id"])
    assert after == before and after["status"] == "done" and after["cost"] == 0.07
    assert after["result"] == "Found three flights; the cheapest is €89."
    assert [s["ok"] for s in after["steps"]] == [True, True, False]
    listing = json.loads((await again.call("browser_task_status", {}, "Eden"))[0])
    assert listing["tasks"] == [
        {
            "id": started["id"],
            "goal": "Find flights",
            "status": "done",
            "started": before["started"],
            "steps": 3,
        }
    ]


async def test_a_task_cut_off_by_a_restart_comes_back_stopped(settings, quiet_speaker, isolated):
    """Saved as it runs, owner-only, without its picture, its cards or what was typed; after
    a restart it can't go on: stopped, its steps kept, the one that hadn't finished failed."""
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = browser_for(endpoint_for(hub))
    task = eden_browser.BrowserTask(
        id="bt-0123456789",
        goal="Buy socks",
        url="https://shop.example/",
        app="Eden",
        want_shots=True,
    )
    task.status, task.shots, task.tab = "running", True, 9
    task.thumb = "data:image/jpeg;base64,c21hbGw="
    task.approvals["a1"] = {"id": "a1", "question": "Press “Place order”?", "detail": ""}
    desk.tasks[task.id] = task
    desk._step(task, "t1", "browser_open", {"url": "https://www.shop.example/"})
    desk._step_done(
        task, "t1", ToolResultBlock(tool_use_id="t1", content="Opened.", is_error=False)
    )
    desk._step(task, "t2", "browser_act", {"action": "type", "ref": "e4", "text": "hunter2 secret"})
    path = hub.feature_path("eden-browser-tasks.json")
    assert path.stat().st_mode & 0o777 == 0o600
    raw = path.read_text()
    [saved] = json.loads(raw)["tasks"]
    assert json.loads(raw)["version"] == 1 and saved["status"] == "running"
    assert set(saved) == {*eden_browser._SAVED, "steps"}  # no thumb, approvals, tab, handle
    assert [s["ok"] for s in saved["steps"]] == [True, None]
    assert not any(never in raw for never in ("hunter2", "c21hbGw", "Place order"))

    again = endpoint_for(hub)
    seen = await status(again, task.id, thumbnail=True)
    assert seen["status"] == "stopped" and seen["result"] == "Stopped: Jarvis restarted."
    assert seen["ended"] and seen["approvals"] == [] and seen["thumbnail"] == ""
    assert [(s["label"], s["detail"], s["ok"]) for s in seen["steps"]] == [
        ("Opened a page", "shop.example", True),
        ("Acted on the page", "Typed 14 characters", False),
    ]
    assert json.loads(path.read_text())["tasks"][0]["status"] == "stopped"  # and saved so
    assert not any(t.running for t in browser_for(again).tasks.values())  # a new one may start


async def test_a_task_waiting_on_its_card_at_a_restart_is_stopped(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated)
    endpoint = endpoint_for(hub)
    started = json.loads((await endpoint.call("browser_task", {"goal": "Find flights"}, "Eden"))[0])
    seen = await status(endpoint_for(hub), started["id"])
    assert seen["status"] == "stopped" and seen["result"] == "Stopped: Jarvis restarted."
    assert seen["steps"] == [] and seen["ended"]
    await endpoint.call("browser_task_stop", {"id": started["id"]}, "Eden")
    await asyncio.gather(browser_for(endpoint).tasks[started["id"]].handle, return_exceptions=True)


async def test_a_damaged_tasks_file_is_ignored(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    path = hub.feature_path("eden-browser-tasks.json")
    good = {
        "id": "bt-00000000aa",
        "goal": "Find flights",
        "url": "",
        "app": "Eden",
        "want_shots": False,
        "status": "done",
        "started": "2026-10-06T09:00:00",
        "ended": "2026-10-06T09:01:00",
        "shots": False,
        "page_url": "",
        "title": "",
        "result": "Done.",
        "cost": 0.02,
        "steps": [
            {
                "n": 1,
                "at": "2026-10-06T09:00:10",
                "tool": "browser_open",
                "label": "Opened a page",
                "detail": "tap.pt",
                "ok": True,
            }
        ],
    }
    for text in ("{not json", "[]", json.dumps({"version": 2, "tasks": [good]}), '{"version": 1}'):
        path.write_text(text)
        endpoint = endpoint_for(hub)
        listing = json.loads((await endpoint.call("browser_task_status", {}, "Eden"))[0])
        assert listing == {"tasks": []}
    bad = [
        "x",
        {**good, "id": "bt-nope"},
        {**good, "id": "../../x"},
        {**good, "status": "flying"},
        {**good, "cost": "free"},
        {**good, "goal": None},
        {**good, "shots": "yes"},
        {**good, "steps": None},
        {**good, "steps": [{"n": "1"}]},
    ]
    path.write_text(json.dumps({"version": 1, "tasks": [*bad, good]}))
    endpoint = endpoint_for(hub)
    assert list(browser_for(endpoint).tasks) == [good["id"]]  # each entry on its own
    seen = await status(endpoint, good["id"])
    assert seen["status"] == "done" and seen["result"] == "Done." and seen["cost"] == 0.02
    assert seen["steps"][0]["detail"] == "tap.pt"
    text, error = await endpoint.call("browser_task_status", {"id": "bt-0000000000"}, "Eden")
    assert error and "keeps the last 10" in text
