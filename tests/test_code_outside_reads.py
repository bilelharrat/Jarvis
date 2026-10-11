"""Reads outside a session's folders ask first (owner decision 2026-10-10, "Ask for outside
reads"; outside_reads.py). A read-only command or a Read/Glob/Grep step inside the project, an
isolated copy's project or an added folder goes ahead; one that reads past them shows a card
(Manual, Plan, Accept edits; refused in an unattended run); a place holding keys or passwords
(~/.ssh, ~/.aws, the Keychain, ps eww, a .env outside…) asks every time, whatever a rule
says, Bypass aside. Paths: ~, .., links, the firmlink and case are all followed."""

import os

import pytest
from conftest import FakeClient

from jarvis import outside_reads
from jarvis.tasks import TaskManager

FREE, ASK, SECRET = "free", "ask", "secret"

# (tool, input with {proj} {PROJ} {added} {home} {other} filled in, what happens)
CASES = [
    # inside the session's folders: no card
    ("Bash", "cat README.md", FREE),
    ("Bash", "head -5 src/a.py", FREE),
    ("Bash", "grep -rn TODO src", FREE),
    ("Bash", "rg TODO", FREE),
    ("Bash", "ls -la", FREE),
    ("Bash", "find . -name '*.py'", FREE),
    ("Bash", "stat src/a.py", FREE),
    ("Bash", "file README.md", FREE),
    ("Bash", "git log --oneline | head -5", FREE),
    ("Bash", "cat *.md", FREE),
    ("Bash", 'grep -rn "/api/v1" src', FREE),  # (a pattern, not a file)
    ("Bash", "tree -L 2 src", FREE),
    ("Bash", "cat {proj}/README.md", FREE),
    ("Bash", "cat {PROJ}/README.md", FREE),  # case ignored, as APFS does
    ("Bash", "cat /System/Volumes/Data{proj}/README.md", FREE),  # the firmlink
    ("Bash", "wc -l ./src/../README.md", FREE),
    ("Bash", "cat {added}/notes.txt", FREE),  # a folder added with /add-dir
    ("Bash", "ps aux", FREE),
    ("Read", "{proj}/src/a.py", FREE),
    ("Read", "{added}/notes.txt", FREE),
    ("Grep", "{proj}/src", FREE),
    # outside them: a card
    ("Bash", "cat /etc/hosts", ASK),
    ("Bash", "cat ../other/README.md", ASK),
    ("Bash", "head ~/notes.txt", ASK),
    ("Bash", "ls ~", ASK),
    ("Bash", "grep -r token ~/Library/Logs", ASK),
    ("Bash", "find / -name x", ASK),
    ("Bash", "stat /Users", ASK),
    ("Bash", "cat link-out", ASK),  # a link in the project to a file outside
    ("Bash", "cat .*", ASK),  # a glob that can climb to ..
    ("Bash", "git diff --no-index /etc/hosts README.md", ASK),
    ("Bash", "rg --ignore-file=/etc/hosts foo", ASK),
    ("Bash", "grep -f {other}/patterns README.md", ASK),
    ("Bash", "cat {other}/README.md", ASK),
    ("Read", "/etc/hosts", ASK),
    ("Read", "{other}/README.md", ASK),
    # places that hold keys or passwords: asked every time
    ("Bash", "cat ~/.ssh/id_ed25519", SECRET),
    ("Bash", "cat ~/.SSH/config", SECRET),
    ("Bash", "ls ~/.aws", SECRET),
    ("Bash", "cat ~/.config/gcloud/credentials.db", SECRET),
    ("Bash", "cat ~/.netrc", SECRET),
    ("Bash", "cat {home}/.pgpass", SECRET),
    ("Bash", "cat ~/.docker/config.json", SECRET),
    ("Bash", "cat ~/../{user}/.ssh/id_rsa", SECRET),
    ("Bash", "ps eww", SECRET),
    ("Bash", "ps -E", SECRET),
    ("Bash", "ps auxe | grep node", SECRET),
    ("Bash", "cat ../other/.env", SECRET),
    ("Bash", "cat link-ssh", SECRET),  # a link in the project to ~/.ssh
    ("Bash", "ls ~/Library/Keychains", SECRET),
    ("Bash", "rg password ~", SECRET),  # a search over the folder that holds them
    ("Bash", "cat ~/Library/Application\\ Support/Google/Chrome/Default/Cookies", SECRET),
    ("Read", "~/.ssh/id_rsa", SECRET),
    ("Read", "{home}/.aws/credentials", SECRET),
    ("Grep", "~/.ssh", SECRET),
    ("Glob", "~/.aws/*", SECRET),
]


@pytest.fixture
def place(tmp_path, monkeypatch):
    home = tmp_path / "home"
    proj = tmp_path / "proj"
    (proj / "src").mkdir(parents=True)
    (proj / "README.md").write_text("hi\n")
    (proj / "src" / "a.py").write_text("x = 1\n")
    other = tmp_path / "other"
    other.mkdir()
    (other / "README.md").write_text("theirs\n")
    (other / ".env").write_text("KEY=x\n")
    added = tmp_path / "added"
    added.mkdir()
    (added / "notes.txt").write_text("n\n")
    (home / ".ssh").mkdir(parents=True)
    (home / ".ssh" / "id_rsa").write_text("key\n")
    os.symlink(other / "README.md", proj / "link-out")
    os.symlink(home / ".ssh" / "id_rsa", proj / "link-ssh")
    monkeypatch.setenv("HOME", str(home))
    return {"proj": proj, "home": home, "other": other, "added": added}


def _input(tool, raw, place):
    filled = raw.format(
        proj=place["proj"],
        PROJ=str(place["proj"]).upper(),
        added=place["added"],
        home=place["home"],
        other=place["other"],
        user=place["home"].name,
    )
    if tool == "Bash":
        return {"command": filled}
    if tool == "Read":
        return {"file_path": filled}
    if tool == "Glob":
        return {"pattern": filled}
    return {"pattern": "x", "path": filled}


def _manager(settings, place, rule=None):
    asked = []

    async def approve(title, detail, choices, context=None):
        asked.append((title, [c for c, _ in choices]))
        return "deny"

    tm = TaskManager(settings, approve, lambda *a, **k: None, FakeClient)
    tm.read_only_free = lambda: True
    if rule is not None:
        tm.rule_check = lambda task, tool, tool_input: rule
    task = tm.start("", "proj")
    task.add_dirs.append(str(place["added"]))
    return tm, task, asked


@pytest.mark.parametrize(("tool", "raw", "want"), CASES, ids=[f"{t}:{r}" for t, r, _ in CASES])
@pytest.mark.parametrize("mode", ["ask", "plan", "edits"])
async def test_reads_past_the_session_s_folders_ask(settings, place, tool, raw, want, mode):
    tm, task, asked = _manager(settings, place)
    task.mode = mode
    await tm.policy_for(task)(tool, _input(tool, raw, place), None)
    assert bool(asked) == (want != FREE), (asked, tm.audit_of(task.id))
    if want == SECRET and tool == "Bash":
        assert "always" not in asked[0][1]  # no "don't ask again" for a secret place
    task.handle.cancel()


@pytest.mark.parametrize(
    ("tool", "raw", "want"), [c for c in CASES if c[2] != FREE], ids=lambda v: str(v)[:40]
)
async def test_a_secret_place_asks_even_past_an_allow_rule_and_bypass_doesn_t(
    settings, place, tool, raw, want
):
    tm, task, asked = _manager(settings, place, rule=("allow", "Bash(*)"))
    can = tm.policy_for(task)
    await can(tool, _input(tool, raw, place), None)
    assert bool(asked) == (want == SECRET)  # the owner's own allow rule covers the rest
    task.mode = "auto"  # Bypass (behind its Touch ID proof)
    before = len(asked)
    await can(tool, _input(tool, raw, place), None)
    assert len(asked) == before
    task.handle.cancel()


async def test_a_saved_ps_rule_never_lets_ps_eww_by(settings, place):
    tm, task, asked = _manager(settings, place)
    tm.read_only_free = lambda: False
    tm.rules.add(tm.rule_folder(task), "ps")
    can = tm.policy_for(task)
    await can("Bash", {"command": "ps aux"}, None)
    assert not asked
    await can("Bash", {"command": "ps eww"}, None)
    assert asked
    task.handle.cancel()


def test_the_keychain_and_environment_readers_are_secret_in_any_command(place):
    cwd = place["proj"]
    for command in (
        "security dump-keychain",
        "security find-generic-password -s github -w",
        "security -q find-internet-password -a me",
        "ps -wwE -p 1",
        "python3 -c 'print(open(\"~/.ssh/id_rsa\").read())'",
        "cp ~/.aws/credentials /tmp/x",
        "tar czf out.tgz $HOME/.ssh",
    ):
        assert outside_reads.secret_command(command, cwd), command
    for command in ("security list-keychains", "ps -ef", "cat README.md", "npm test"):
        assert not outside_reads.secret_command(command, cwd), command


async def test_an_unattended_run_refuses_a_scope_command_that_reads_outside(settings, place):
    from types import SimpleNamespace

    from jarvis.features.code_unattended import Runs

    tm, task, _asked = _manager(settings, place)
    runs = Runs(SimpleNamespace(tasks=tm))
    assert not runs.reads_outside(task, "cat README.md")
    assert runs.reads_outside(task, "cat /etc/hosts")
    assert runs.reads_outside(task, "cat ~/.ssh/id_rsa")
    assert runs.reads_outside(task, "ps eww")
    assert not runs.reads_outside(task, "npm test")
    task.handle.cancel()
