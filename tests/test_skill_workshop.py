"""The Skill Workshop (jarvis.skill_workshop) and Settings › Skills (jarvis.features.skills):
long requests heard through the hub's turn sink, weighed by the utility model and drafted by
Sonnet (both faked: no model is ever reached), drafts that wait for the owner and are never
switched on by themselves, "make that a skill" in English and Chinese, and the window's
commands, the git card included."""

import asyncio
import json
import shutil
import types

import pytest
from claude_agent_sdk import AssistantMessage, TextBlock, ToolResultBlock, ToolUseBlock, UserMessage
from conftest import FakeClient, result

from jarvis import brain, lang, utility_model
from jarvis.features import skills as skills_feature
from jarvis.hub import Hub
from jarvis.skill_workshop import MIN_STEPS, clean_draft, describe_turn, parse_triage

DRAFT = (
    "---\nname: weekly-report\ndescription: Sums up the owner's week. Use it on Fridays.\n---\n\n"
    "# Weekly report\n\n1. list_events for the week.\n2. Say the three things that matter.\n"
)


def make_hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


@pytest.fixture
def model(monkeypatch):
    """The utility model's stand-in: answers by the system prompt it's given."""
    seen = []
    answers = {
        "triage": '{"worth": true, "name": "weekly-report", "why": "It recurs weekly."}',
        "draft": DRAFT,
    }

    async def fake_turn(prompt, options, timeout=90.0):
        kind = "triage" if "worth keeping as a" in options.system_prompt else "draft"
        seen.append({"kind": kind, "prompt": prompt, "model": options.model})
        return answers[kind]

    monkeypatch.setattr(utility_model, "run_turn", fake_turn)
    return types.SimpleNamespace(seen=seen, answers=answers)


def long_turn(n=MIN_STEPS, own=True):
    return {
        "rid": "r1",
        "request": "Put together my weekly report",
        "own": own,
        "steps": [{"tool": "mcp__mac__list_events", "label": "Checked your calendar"}] * n,
        "reply": "Three things matter this week.",
    }


async def settle(hub):
    for _ in range(20):
        await asyncio.sleep(0)
    if hub._background:
        await asyncio.gather(*list(hub._background), return_exceptions=True)


# ── pieces ──


def test_a_request_is_shown_to_the_model_as_data_with_its_steps():
    text = describe_turn(long_turn(2), 6000)
    assert text.startswith("The owner asked: Put together my weekly report")
    assert "1. list_events (Checked your calendar)" in text and "Three things matter" in text
    assert len(describe_turn({**long_turn(2), "reply": "x" * 50_000}, 6000)) <= 6000


@pytest.mark.parametrize(
    ("answer", "parsed"),
    [
        (
            '{"worth": true, "name": "Weekly-Report", "why": "recurs"}',
            {"worth": True, "name": "weekly-report", "why": "recurs"},
        ),
        (
            'Sure! {"worth": false, "name": "", "why": "one-off"}',
            {"worth": False, "name": "", "why": "one-off"},
        ),
        ('{"worth": "yes"}', None),
        ("no json here", None),
    ],
)
def test_the_triage_answer_is_read_carefully(answer, parsed):
    assert parse_triage(answer) == parsed


def test_a_draft_is_checked_and_cleaned_before_its_kept():
    text, name, description = clean_draft(
        "```markdown\n" + DRAFT + "password: hunter2hunter2\n```", ""
    )
    assert name == "weekly-report" and description.startswith("Sums up")
    assert text.startswith('---\nname: weekly-report\ndescription: "Sums up')
    assert "hunter2hunter2" not in text  # anything like a password is blanked
    for bad in (
        "no frontmatter at all",
        "---\nname: x\n---\nshort",
        "---\ndescription: d\n---\n" + "words " * 20,
    ):
        with pytest.raises(ValueError):
            clean_draft(bad, "")
    assert (
        clean_draft("---\ndescription: d\n---\n" + "words " * 20, "fallback-name")[1]
        == "fallback-name"
    )


# ── the hub's turn sink ──


async def test_the_hub_tells_the_workshop_what_a_request_ran(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    FakeClient.script = [
        AssistantMessage(
            content=[
                ToolUseBlock(id=f"t{i}", name="mcp__mac__list_events", input={}) for i in range(3)
            ],
            model="m",
        ),
        UserMessage(
            content=[
                ToolResultBlock(tool_use_id=f"t{i}", content="ok", is_error=False) for i in range(3)
            ]
        ),
        AssistantMessage(content=[TextBlock(text="Done.")], model="m"),
        result(),
    ]
    heard = []
    hub.add_turn_sink(heard.append)
    try:
        await hub._connect()
        await hub.ask("what's on this week?")
    finally:
        FakeClient.script = []
    [turn] = heard
    assert turn["request"] == "what's on this week?" and turn["own"] is True
    assert (
        turn["steps"] == [{"tool": "mcp__mac__list_events", "label": "Checked your calendar"}] * 3
    )
    assert turn["reply"] == "Done."
    desk = hub.skills
    assert desk.workshop.latest()["request"] == "what's on this week?"


# ── drafted after a long request ──


async def test_a_long_request_becomes_a_draft_that_waits(settings, quiet_speaker, isolated, model):
    hub = make_hub(settings, quiet_speaker, isolated)
    alerts = []
    hub.add_notify_sink(alerts.append)
    desk = hub.skills
    item = await desk.workshop.consider(long_turn())
    assert (
        item["name"] == "weekly-report"
        and item["asked"] is False
        and item["why"] == "It recurs weekly."
    )
    assert [s["kind"] for s in model.seen] == ["triage", "draft"]
    assert (
        model.seen[0]["model"] == "claude-haiku-4-5"
        and model.seen[1]["model"] == "claude-sonnet-5-5"
    )
    assert desk.store.find("weekly-report") is None  # a proposal, not a skill
    assert [a.kind for a in alerts] == ["skill"] and "weekly-report" in alerts[0].text
    saved = json.loads(hub.feature_path("skill_proposals.json").read_text())
    assert saved["items"][0]["name"] == "weekly-report"
    # The same name again isn't drafted twice; one the owner discarded isn't for 30 days.
    assert await desk.workshop.consider({**long_turn(), "rid": "r2"}) is None
    await desk.discard({"id": item["id"]})
    assert await desk.workshop.consider({**long_turn(), "rid": "r3"}) is None
    assert [s["kind"] for s in model.seen] == ["triage", "draft", "triage", "triage"]


async def test_nothing_is_drafted_when_the_triage_says_no_or_the_day_is_done(
    settings, quiet_speaker, isolated, model
):
    hub = make_hub(settings, quiet_speaker, isolated)
    model.answers["triage"] = '{"worth": false, "name": "", "why": "a one-off"}'
    assert await hub.skills.workshop.consider(long_turn()) is None
    assert [s["kind"] for s in model.seen] == ["triage"]
    usage = utility_model.usage_for(hub)
    usage.counts["skill_triage"] = utility_model.POLICY["skill_triage"]
    assert await hub.skills.workshop.consider({**long_turn(), "rid": "r9"}) is None
    assert len(model.seen) == 1  # past the cap nothing is sent


def test_only_the_app_weighs_long_requests_by_itself(settings, quiet_speaker, isolated, model):
    hub = make_hub(settings, quiet_speaker, isolated)  # poll off: a test's hub
    hub.skills.workshop.heard(long_turn())
    assert hub._background == set() and model.seen == []
    assert hub.skills.workshop.latest()["request"] == "Put together my weekly report"
    hub.skills.workshop.heard({**long_turn(), "steps": []})  # no tools: not kept
    assert len(hub.skills.workshop.recent) == 1


async def test_with_the_app_running_a_long_own_request_is_weighed(
    settings, quiet_speaker, isolated, model
):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.poll = True
    hub.skills.workshop.heard(long_turn(own=False))  # a routine's: never
    hub.skills.workshop.heard(long_turn(n=MIN_STEPS - 1))  # short: never
    await settle(hub)
    assert model.seen == []
    hub.set_feature_prefs({"skills_offer": False})
    hub.skills.workshop.heard(long_turn())
    await settle(hub)
    assert model.seen == []
    hub.set_feature_prefs({"skills_offer": True})
    hub.skills.workshop.heard(long_turn())
    await settle(hub)
    assert [s["kind"] for s in model.seen] == ["triage", "draft"]


# ── "make that a skill" ──


async def test_make_that_a_skill_drafts_the_latest_request(
    settings, quiet_speaker, isolated, model
):
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = hub.skills
    assert await desk.instant("what's the weather?") is None
    said = await desk.instant("make that a skill")
    assert said.startswith("There's nothing recent")
    desk.workshop.heard(long_turn(n=2))
    alerts = []
    hub.add_notify_sink(alerts.append)
    said = await desk.instant("Jarvis, turn this into a skill please")
    assert said.startswith("I'll draft a skill from that")
    await settle(hub)
    assert [s["kind"] for s in model.seen] == ["draft"]  # asked for: no triage
    assert desk.proposals.items[0]["asked"] is True
    assert [a.kind for a in alerts] == ["skill"]


async def test_make_that_a_skill_in_chinese(settings, quiet_speaker, isolated, model):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.prefs.language = "zh"
    hub.skills.workshop.heard(long_turn(n=2))
    said = await hub.skills.instant("把刚才的做成技能吧")
    assert said.startswith("I'll draft")  # the hub says it in Chinese:
    assert lang.translate(said, "zh") == "我会把刚才的做成一个技能草稿，放在设置的“技能”里等你看。"
    await settle(hub)
    assert hub.skills.proposals.items


async def test_the_brain_can_ask_for_a_draft_too(settings, quiet_speaker, isolated, model):
    hub = make_hub(settings, quiet_speaker, isolated)
    hub.skills.workshop.heard(long_turn(n=3))
    assert hub._feature_servers()["skills"]["name"] == "skills"  # make_skill is on it
    assert "make_skill" in hub._feature_prompt()
    said = await hub.skills.make("the Friday version")
    assert said.startswith("I'll draft")
    await settle(hub)
    assert "What the owner wants the skill to cover: the Friday version" in model.seen[0]["prompt"]


def test_skills_results_count_as_outside_content(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated)
    assert hub.skills._store is None and hub._turn_sinks  # installing read nothing
    assert brain.result_kind("mcp__skills__use_skill") == "web"
    assert brain.result_kind("mcp__skills__list_skills") == "web"
    assert brain.result_kind("mcp__skills__read_skill_file") == "web"
    assert brain.result_kind("mcp__skills__make_skill") == "none"


# ── Settings › Skills ──


def write_skill(root, name, description="Does it."):
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\nDo it well.\n"
    )
    return folder


async def test_the_window_lists_switches_previews_and_removes(
    settings, quiet_speaker, isolated, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = hub.skills
    desk.store.trash = shutil.rmtree  # the Trash, in a test: the folder just goes
    write_skill(desk.store.folder, "alpha")
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    reloads = []
    monkeypatch.setattr(hub, "_tools_changed", lambda: reloads.append(1))
    await hub._handle({"type": "skills_state"})
    kind, state = events[-1]
    assert (
        kind == "skills"
        and [s["name"] for s in state["items"]] == ["alpha"]
        and not state["items"][0]["on"]
    )
    await hub._handle({"type": "skills_toggle", "name": "alpha", "on": True})
    assert events[-1][1]["items"][0]["on"] is True and reloads == [1]
    assert "alpha (Does it.)" in hub._feature_prompt()  # the brain's instructions name it
    await hub._handle({"type": "skills_preview", "name": "alpha"})
    assert events[-1] == ("skills_preview", {"name": "alpha", "text": "Do it well.", "files": []})
    await hub._handle({"type": "skills_remove", "name": "alpha"})
    assert events[-1][1]["items"] == [] and events[-1][1]["note"] == "Moved alpha to the Trash."
    assert reloads == [1, 1]


async def test_installing_from_a_folder_the_owner_picked(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    source = write_skill(tmp_path / "Downloads", "beta")
    await hub._handle({"type": "skills_install_folder", "path": str(source)})
    note = events[-1][1]["note"]
    assert note == "Installed 1 skill, switched off until you turn it on: beta."
    await hub._handle({"type": "skills_install_folder", "path": str(tmp_path / "nowhere")})
    assert events[-1][1]["error"] == "That isn't a folder."
    hub.prefs.language = "zh"
    await hub._handle({"type": "skills_install_folder", "path": str(source)})
    assert (
        events[-1][1]["error"].startswith("什么都没有安装。")
        and "它已经安装了" in events[-1][1]["error"]
    )


async def test_a_git_repository_is_cloned_only_after_a_yes(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    desk = hub.skills
    events, cloned = [], []
    real_emit = hub.emit

    def emit(kind, **data):
        events.append((kind, data))
        real_emit(kind, **data)

    hub.emit = emit
    prepared = tmp_path / "prepared"
    write_skill(prepared, "gamma")

    async def fake_clone(store, url):
        cloned.append(url)
        return await asyncio.to_thread(store.install_folder, prepared, f"git:{url}")

    desk.clone = fake_clone

    async def answer(choice):
        for _ in range(100):
            await asyncio.sleep(0)
            if hub.approvals:
                card = next(iter(hub.approvals.values()))
                assert card["question"] == "Install skills from github.com/owner/skills?"
                assert "switched off until you turn it on" in card["detail"]
                assert hub.resolve(card["id"], choice)
                return
        raise AssertionError("no card went up")

    await asyncio.gather(
        hub._handle({"type": "skills_install_git", "url": "github.com/owner/skills"}),
        answer("deny"),
    )
    assert cloned == [] and events[-1][1]["note"] == "Not installed."
    await asyncio.gather(
        hub._handle({"type": "skills_install_git", "url": "https://github.com/owner/skills"}),
        answer("allow"),
    )
    assert cloned == ["https://github.com/owner/skills"]
    assert (
        events[-1][1]["note"].startswith("Installed 1 skill") and not desk.store.public()[0]["on"]
    )
    await hub._handle({"type": "skills_install_git", "url": "git@github.com:o/r.git"})
    assert "Only https" in events[-1][1]["error"] and not hub.approvals


async def test_a_draft_is_switched_on_only_by_the_owners_click(
    settings, quiet_speaker, isolated, model, monkeypatch
):
    hub = make_hub(settings, quiet_speaker, isolated)
    monkeypatch.setattr(hub, "_tools_changed", lambda: None)
    desk = hub.skills
    item = await desk.workshop.draft(long_turn(n=3), name="weekly-report")
    assert desk.store.find("weekly-report") is None and desk.store.offered() == []
    events = []
    hub.emit = lambda kind, **data: events.append((kind, data))
    await hub._handle({"type": "skills_accept", "id": item["id"]})
    assert [s.name for s in desk.store.offered()] == ["weekly-report"]
    assert events[-1][1]["note"] == "Added weekly-report to your skills, switched on."
    assert events[-1][1]["proposals"] == []
    assert desk.store.sources["weekly-report"] == "drafted by Jarvis"
    await hub._handle({"type": "skills_accept", "id": item["id"]})
    assert events[-1][1]["error"] == "That draft isn't there any more."
    await hub._handle({"type": "skills_offer", "on": False})
    assert hub.prefs.feature("skills_offer") is False and events[-1][1]["offer"] is False


def test_every_sentence_has_its_chinese():
    for english, chinese in skills_feature.ZH.items():
        assert lang.translate(english, "zh") == chinese or "{" in english, english
    assert lang.tr(
        "Installed {n} skills, switched off until you turn them on: {names}.",
        "zh",
        n=2,
        names="a, b",
    ) == ("已安装 2 个技能，在你打开之前都是关闭的：a, b。")
