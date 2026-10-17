"""Security: a "run this without me" card (one run, a schedule, a file watch, a webhook) that
lets the run use commands (tests, builds: the project's own scripts, which the run can edit)
runs code on this Mac with nobody there, so it's a Touch ID card only the Mac answers
(code_touchid.mac_only): never the phone, a chat or a voice "yes". A run with only the
read-only commands keeps its plain card. No network, no model."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from jarvis.features import code_touchid
from jarvis.features.code_unattended import Runs, Scope

ROOT = Path(__file__).parent.parent


def scope(commands):
    return Scope(prompt="fix it", project="/tmp/p", commands=commands)


def test_touchid_name_only_when_the_run_may_run_commands():
    assert Runs.touchid_for(scope(["npm test"])) == "code_run"
    assert Runs.touchid_for(scope(["pytest"]), "code_hook_add") == "code_hook_add"
    assert Runs.touchid_for(scope([])) == ""


@pytest.mark.asyncio
async def test_a_run_with_commands_asks_on_a_card_only_the_mac_answers():
    seen = []

    async def request_approval(question, detail, choices, context=None):
        seen.append(context)
        return "start"

    fake = SimpleNamespace(
        tr=lambda text: text,
        hub=SimpleNamespace(request_approval=request_approval, _say=lambda _t: None),
        scope_from=lambda raw: scope(raw["commands"]),
        card=lambda s, n, w="": ("Q", "D"),
        start=lambda s: "stopped here",
        touchid_for=Runs.touchid_for,
    )
    fake.ask = lambda *a, **k: Runs.ask(fake, *a, **k)

    fake._where = lambda s: ("/tmp/p", "p")
    await Runs.request(fake, {"commands": ["npm test"], "prompt": "x"}, speak=True)
    assert code_touchid.mac_only(seen[-1]) and seen[-1]["tool"] == "code_run"
    await Runs.request(fake, {"commands": [], "prompt": "x"})
    assert seen[-1] is None


def test_the_watch_and_webhook_cards_name_their_touch_id_card():
    source = (ROOT / "src/jarvis/features/code_automate.py").read_text()
    assert 'touchid_for(scope, "code_watch_add")' in source
    assert 'touchid_for(scope, "code_hook_add")' in source
    runs = (ROOT / "src/jarvis/features/code_unattended.py").read_text()
    assert 'touchid_for(scope, "code_run_schedule")' in runs
