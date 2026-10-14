"""Round 3 of the Touch ID gate (r3-findings SEC):

- S3-6: what a shell reads as rm (\\rm, r\\m, r''m, rm${IFS}-rf) and a program known only when
  it runs (x=rm; $x -rf ~, $'rm') are risky: the shared table (tests/fixtures/risky_commands.json,
  checked by test_touchid_round2) has them; here the backend's own helpers.
- S3-7: prefs.json (everyone's mode, each project's defaults) and code_sessions/remembered.json
  (how a session resumes) are the app's data folder: a session's command or edit that names it
  asks on a card marked for Touch ID, and a Bypass found in remembered.json (which Eden never
  writes there) is never how a resumed session starts.
"""

import asyncio
import json
from pathlib import Path

from code_session_fakes import make_hub
from test_touchid_round2 import ask, bash, gated_task

from jarvis.features import code_touchid
from jarvis.tasks import ClaudeTask


def test_a_shell_s_ways_of_writing_rm_are_rm():
    read = code_touchid.as_shell_reads
    assert read(r"\rm -rf ~") == "rm -rf ~"
    assert read(r"r\m -rf ~") == "rm -rf ~"
    assert read("r''m -rf ~") == "rm -rf ~"
    assert read("rm${IFS}-rf ~") == "rm -rf ~"
    for command in (r"\rm -rf ~", "$'rm' -rf ~", "rm${IFS}-rf ~", "x=rm; $x -rf ~", r"r\m -rf ~"):
        assert code_touchid.risky_command(command), command
    for command in ("echo $HOME", 'git commit -m "push the fix"', "x=$(date)", "ls -la"):
        assert not code_touchid.risky_command(command), command


def test_naming_the_app_s_data_folder_however_it_s_written():
    home = "/Users/me"
    data = ["/Users/me/Library/Application Support/Jarvis"]
    names = lambda text, own=None: code_touchid.names_folder(text, data, home, own)  # noqa: E731
    assert names('echo x > "/Users/me/Library/Application Support/Jarvis/prefs.json"')
    assert names(r"cat > ~/Library/Application\ Support/Jarvis/prefs.json")
    assert names('python3 x.py "$HOME/Library/Application Support/jarvis/code_sessions"')
    assert names('cd ~/Library/"Application Support"/Jarvis && sed -i "" s/ask/auto/ prefs.json')
    assert not names("npm test")
    assert not names("cat ~/Library/Application Support/Other/x.json")
    # A session whose copy is in the data folder (worktrees/) works in its own folder freely,
    # but a step up out of it names the rest.
    copy = "/Users/me/Library/Application Support/Jarvis/worktrees/shop-1"
    assert not names(f'ls "{copy}/src" && cat {copy}/README.md', [copy])
    assert names("echo x > ../../prefs.json", [copy])
    assert not names("git log main..HEAD", [copy])


async def test_a_command_or_an_edit_of_the_data_folder_asks_on_a_touch_id_card(
    settings, quiet_speaker, isolated, tmp_path, tmp_path_factory
):
    hub = make_hub(settings, quiet_speaker, isolated)
    await hub.start()
    project = tmp_path_factory.mktemp("shop")  # (beside the data folder, as a real project is)
    task, cards = gated_task(hub, project)
    data = Path(hub.feature_path("prefs.json")).parent
    assert not project.is_relative_to(data)
    prefs = data / "prefs.json"
    gate = hub.code_touchid
    tampering = f'echo \'{{"code_mode": "auto"}}\' > {prefs}'
    assert gate.risky_step(task, "Bash", {"command": tampering})
    assert gate.app_data_step(
        task, "Write", {"file_path": str(data / "code_sessions" / "remembered.json")}
    )
    assert not gate.app_data_step(task, "Bash", {"command": "npm test"})
    assert not gate.app_data_step(task, "Write", {"file_path": str(project / "a.py")})
    assert await ask(hub, task, *bash(tampering), cards) == "card"
    card = cards[-1]
    assert card.get("touchid") is True, card
    assert code_touchid.risky(card, "allow") and code_touchid.mac_only(card)
    # A harmless command's card isn't marked.
    assert await ask(hub, task, *bash("touch notes.txt"), cards) == "card"
    assert not cards[-1].get("touchid")
    # In a copy in the data folder, its own files are its own.
    copy = data / "worktrees" / "shop-1"
    copy.mkdir(parents=True)
    other = ClaudeTask(id=8, prompt="", cwd=copy, mode="ask")
    hub.tasks.tasks[8] = other
    assert not gate.app_data_step(other, "Bash", {"command": f"ls {copy}/src"})
    assert not gate.app_data_step(other, "Edit", {"file_path": str(copy / "a.py")})
    assert gate.app_data_step(other, "Bash", {"command": "cat ../../prefs.json"})
    await hub.stop()


async def test_a_bypass_written_into_remembered_json_is_not_how_a_session_resumes(
    settings, quiet_speaker, isolated, tmp_path
):
    hub = make_hub(settings, quiet_speaker, isolated)
    project = tmp_path / "proj"
    project.mkdir()
    sessions = hub.code_sessions
    sessions.remembered["s-tampered"] = {"mode": "auto", "effort": "high"}
    sessions.remembered["s-planned"] = {"mode": "plan"}
    found = sessions.start_defaults(project, "s-tampered")
    assert found.get("mode") != "auto" and found["effort"] == "high"
    assert sessions.start_defaults(project, "s-planned")["mode"] == "plan"
    # And Eden itself never remembers Bypass.
    task = ClaudeTask(id=9, prompt="", cwd=project, mode="auto", session_id="s-mine")
    sessions._remember(task)
    assert "mode" not in sessions.remembered["s-mine"]
    await asyncio.sleep(0)
    json.dumps(sessions.remembered)  # (still what it saves)
