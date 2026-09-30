"""Claude Code's questions (AskUserQuestion) in Jarvis Code: several options at once for a
question that takes them, an answer in the owner's own words, and the card's free answers
carried by hub.resolve only where the card offers them."""

import asyncio
import json

from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny, ToolPermissionContext
from conftest import FakeClient

from jarvis.hub import Hub
from jarvis.tasks import ClaudeTask, TaskManager, _question_answer

OPTIONS = ["Unit tests", "Integration tests", "Linting"]


def question(multi=False, n=3):
    return {
        "questions": [
            {
                "question": "What should run in CI?",
                "header": "CI",
                "multiSelect": multi,
                "options": [
                    {"label": label, "description": f"{label.lower()} on every push"}
                    for label in OPTIONS[:n]
                ],
            }
        ]
    }


def manager(settings, answers):
    asked = []

    async def approve(q, detail, choices, context=None):
        asked.append({"question": q, "choices": [c for c, _ in choices], **(context or {})})
        return answers[len(asked) - 1]

    return TaskManager(settings, approve, lambda *_a, **_k: None, FakeClient), asked


def test_an_answer_reads_as_claude_code_takes_it():
    assert _question_answer("opt1", OPTIONS) == "Integration tests"
    assert _question_answer("opt7", OPTIONS) == ""
    assert _question_answer("skip", OPTIONS) == ""
    assert _question_answer("other:  just   the linter  ", OPTIONS) == "just the linter"
    assert _question_answer("other:", OPTIONS) == ""
    pick = 'pick:{"picked": [2, 0, 0, 9, true, "1"]}'
    assert _question_answer(pick, OPTIONS) == "Unit tests, Linting"  # in order, known ones once
    both = 'pick:{"picked": [1], "other": "and a smoke test"}'
    assert _question_answer(both, OPTIONS) == "Integration tests, and a smoke test"
    assert _question_answer('pick:{"picked": []}', OPTIONS) == ""
    assert _question_answer("pick:not json", OPTIONS) == ""
    assert _question_answer("pick:[1, 2]", OPTIONS) == ""


async def test_several_options_and_the_owner_s_own_words_reach_claude(settings, tmp_path):
    answers = ['pick:{"picked": [0, 2], "other": "and a smoke test"}']
    tm, asked = manager(settings, answers)
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path)
    out = await tm.policy_for(task)(
        "AskUserQuestion", question(multi=True), ToolPermissionContext()
    )
    assert isinstance(out, PermissionResultAllow)
    expected = "Unit tests, Linting, and a smoke test"
    assert out.updated_input["answers"] == {"What should run in CI?": expected}
    card = asked[0]
    assert card["choices"] == ["opt0", "opt1", "opt2", "skip"]  # the phone and voice keep these
    assert card["multi"] is True and card["header"] == "CI"
    assert card["free_choices"] == ["pick", "other"]
    assert card["options"][2] == {"label": "Linting", "description": "linting on every push"}
    assert task.transcript[-1]["text"] == f"What should run in CI? → {expected}"


async def test_a_question_answered_in_words_or_not_at_all(settings, tmp_path):
    tm, _ = manager(settings, ["other:only the unit tests, quickly", "skip"])
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path)
    policy = tm.policy_for(task)
    out = await policy("AskUserQuestion", question(), ToolPermissionContext())
    assert out.updated_input["answers"] == {
        "What should run in CI?": "only the unit tests, quickly"
    }
    out = await policy("AskUserQuestion", question(), ToolPermissionContext())
    assert isinstance(out, PermissionResultDeny) and out.message == "The user didn't answer."


async def test_malformed_questions_are_left_out_never_a_crash(settings, tmp_path):
    tm, asked = manager(settings, ["opt0"])
    task = ClaudeTask(id=1, prompt="x", cwd=tmp_path)
    policy = tm.policy_for(task)
    weird = {"questions": ["nope", {"question": "", "options": [{"label": "a"}]},
                          {"question": "Pick one", "options": ["x", {"label": "Real"}]}]}  # fmt: skip
    out = await policy("AskUserQuestion", weird, ToolPermissionContext())
    assert out.updated_input["answers"] == {"Pick one": "Real"} and len(asked) == 1
    out = await policy("AskUserQuestion", {"questions": "nope"}, ToolPermissionContext())
    assert out.updated_input["answers"] == {}


async def test_resolve_carries_a_card_s_free_answers_only_where_it_offers_them(
    settings, quiet_speaker, isolated
):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    choices = [("opt0", "Unit tests"), ("skip", "Skip")]
    asked = asyncio.ensure_future(
        hub.request_approval("What should run?", "", choices, {"free_choices": ["pick", "other"]})
    )
    await asyncio.sleep(0)
    [card] = hub.approvals.values()
    assert card["free_choices"] == ["pick", "other"]
    assert not hub.resolve(card["id"], "hack", "x")  # still only its own answers
    picked = json.dumps({"picked": [0], "other": "and   lint"})
    assert hub.resolve(card["id"], "pick", picked)
    assert await asked == 'pick:{"picked": [0], "other": "and lint"}'

    plain = asyncio.ensure_future(
        hub.request_approval("Run it?", "", [("allow", "Yes"), ("deny", "No")])
    )
    await asyncio.sleep(0)
    [card] = hub.approvals.values()
    assert not hub.resolve(card["id"], "other", "anything")  # a card without them: no
    assert hub.resolve(card["id"], "allow", "ignored")
    assert await plain == "allow"  # (a yes carries no words)
