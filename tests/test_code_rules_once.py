"""The permission rules weigh each step on the event loop, often twice: what decide works
out about the step (its paths resolved, its command split into parts, its key) is worked
out once for all the rules, and the decision is the one each rule gives on its own."""

from pathlib import Path

from jarvis import coderules
from jarvis.coderules import decide, matches, valid

RULES = {
    "deny": [*(f"Read(./secret{i}/**)" for i in range(8)), "Bash(git push:*)",
             "Bash(rm -rf:*)", "WebFetch(domain:evil.com)", "Read(*.pem)", "Edit(//etc/**)",
             "mcp__github__delete_repo"],
    "ask": [*(f"Edit(src/gen{i}/**)" for i in range(8)), "Bash(npm publish)"],
    "allow": [*(f"Read(docs{i}/**)" for i in range(8)), "Bash(npm test:*)", "Bash(git status)",
              "Read(src/**)", "Grep(src)", "WebFetch(domain:docs.python.org)", "mcp__github"],
}  # fmt: skip
CALLS = [
    ("Read", {"file_path": "src/app/main.py"}),
    ("Read", {"file_path": "docs3/a.md"}),
    ("Read", {"file_path": "x/key.pem"}),
    ("Read", {"file_path": "secret5/token.txt"}),
    ("Edit", {"file_path": "src/app/main.py"}),
    ("Edit", {"file_path": "src/gen3/a.py"}),
    ("Write", {"file_path": "/etc/passwd"}),
    ("Bash", {"command": "npm test -- --watch"}),
    ("Bash", {"command": "git status"}),
    ("Bash", {"command": "sudo -u root git push origin"}),
    ("Bash", {"command": "cd src && npm test"}),
    ("Bash", {"command": "echo hi && rm -rf /"}),
    ("Bash", {"command": "npm publish"}),
    ("Bash", {"command": "FORCE_COLOR=1 npm test"}),
    ("Grep", {"pattern": "x", "path": "src"}),
    ("Glob", {"pattern": "/etc/*"}),
    ("LS", {}),
    ("WebFetch", {"url": "https://docs.python.org/3/"}),
    ("WebFetch", {"url": "https://a.evil.com/"}),
    ("mcp__github__delete_repo", {}),
    ("mcp__github__list_issues", {}),
    ("NotebookEdit", {"notebook_path": "src/gen1/n.ipynb"}),
]


def one_by_one(rules, tool, tool_input, cwd, home):
    """The decision with every rule weighed on its own, nothing shared between them."""
    for behavior in coderules.BEHAVIORS:
        for text in rules.get(behavior, ()):
            rule = valid(text)
            if rule is not None and matches(rule, behavior, tool, tool_input, cwd, home):
                return behavior, rule.text
    return None


def test_decide_gives_each_rules_own_answer(tmp_path):
    (tmp_path / "src").mkdir()
    home = Path.home()
    for rules in (RULES, *({k: v} for k, v in RULES.items())):
        for tool, tool_input in CALLS:
            assert decide(rules, tool, tool_input, tmp_path, home) == one_by_one(
                rules, tool, tool_input, tmp_path, home
            ), (tool, tool_input)
    assert decide(RULES, "Read", {"file_path": "x/key.pem"}, tmp_path)[0] == "deny"
    assert decide(RULES, "Bash", {"command": "cd src && npm test"}, tmp_path)[0] == "allow"


def test_a_steps_paths_and_command_are_worked_out_once(tmp_path, monkeypatch):
    work = {"paths": 0, "parts": 0, "key": 0}
    paths, parts = coderules._paths, coderules.command_parts

    def counted_paths(*args):
        work["paths"] += 1
        return paths(*args)

    def counted_parts(*args):
        work["parts"] += 1
        return parts(*args)

    from jarvis import tasks

    key = tasks.command_key

    def counted_key(*args):
        work["key"] += 1
        return key(*args)

    monkeypatch.setattr(coderules, "_paths", counted_paths)
    monkeypatch.setattr(coderules, "command_parts", counted_parts)
    monkeypatch.setattr(tasks, "command_key", counted_key)
    assert decide(RULES, "Read", {"file_path": "elsewhere/a.txt"}, tmp_path) is None
    assert work["paths"] == 1  # (17 path rules weighed it)
    assert decide(RULES, "Bash", {"command": "npm test -- -u"}, tmp_path)[0] == "allow"
    assert work["parts"] == 1 and work["key"] == 1  # (3 deny/ask and 2 allow rules)
