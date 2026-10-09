"""Eden Code's permission audit (every decision, and why) and the read-only commands
that run without asking."""

import pytest
from conftest import FakeClient

from jarvis.tasks import TaskManager, is_read_only


@pytest.mark.parametrize(
    "command",
    [
        "ls -la",
        "git status",
        "git log --oneline | head -5",
        "grep -rn TODO src | wc -l",
        "git diff HEAD~1",
        "npm --version",
        "git branch -a",
        "find . -name '*.py'",
        "cat README.md",
        "git stash list",
        # Common options on the programs that can also write or run something stay read-only.
        "sort -rn data.txt",
        "sort -k2 -t, people.csv",
        "rg -n --type py TODO",
        "tree -L 2 src",
        "cut -d: -f1 people.txt",
        "head -c 200 notes.md",
    ],
)
def test_commands_that_only_look(command):
    assert is_read_only(command)


@pytest.mark.parametrize(
    "command",
    [
        "rm -rf build",
        "ls > listing.txt",
        "cat a; rm b",
        "ls && rm x",
        "echo $(whoami)",
        "echo `id`",
        "git push",
        "git commit -m x",
        "git -c core.pager=sh status",
        "git branch -D old",
        "git diff --output=x",
        "git grep -O foo",
        "find . -delete",
        "find . -exec rm {} ;",
        "sort -o out.txt in.txt",
        "tree -o out",
        "rg --pre ./x foo",
        "npm install",
        "python3 script.py",
        "/bin/ls",
        "FOO=1 ls",
        "hostname evil",
        "sleep 5 &",
        "cat <(rm x)",
        "uniq a b",
        "less file",
        "",
        # A write option whose value is attached, so the old flag-by-flag check missed it.
        "sort -oout.txt in.txt",
        "tree -oout.html",
        # An option that runs another program, not on the program's safe list.
        "sort --compress-program=gzip in.txt",
        "sort --files0-from=list.txt in.txt",
        "ag --pager sh TODO",
        "rg --pre=./run.sh foo",
        "rg --pre-glob=*.gz foo",
        "file -C -m evil.magic",
        "file -Cm evil.magic",
        # Shell expansion the classifier judged before the shell ran it.
        "cat $HOME/.netrc",
        "echo ${SECRET}",
        "rg {--pre=sh,} foo",
        "grep {a,b} file",
        "cat file{1..9}",
    ],
)
def test_anything_that_writes_runs_or_chains_asks(command):
    assert not is_read_only(command)


async def test_every_decision_is_in_the_audit(settings, tmp_path):
    asked = []

    async def approve(title, detail, choices, context=None):
        asked.append(detail)
        return "deny" if "rm" in detail else "allow"

    tm = TaskManager(settings, approve, lambda *a, **k: None, FakeClient)
    (tmp_path / "proj").mkdir()
    task = tm.start("", "proj")
    can = tm.policy_for(task)
    await can("Bash", {"command": "git status"}, None)
    await can("Bash", {"command": "npm test"}, None)
    await can("Bash", {"command": "rm -rf build"}, None)
    decisions = [(a["decision"], a["why"]) for a in tm.audit_of(task.id)]
    assert decisions[0] == ("auto", "a read-only command")
    assert decisions[1] == ("allowed", "you allowed it")
    assert decisions[2][0] == "denied"
    assert len(asked) == 2  # git status never asked
    tm.read_only_free = lambda: False
    await can("Bash", {"command": "git status"}, None)
    assert len(asked) == 3  # with the setting off, it asks
    task.handle.cancel()
