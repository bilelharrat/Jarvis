from jarvis.code_commands import catalog


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def test_commands_and_skills_from_the_project_and_the_user(tmp_path):
    project, home = tmp_path / "proj", tmp_path / "home"
    write(
        project / ".claude/commands/deploy.md",
        "---\ndescription: Ship it to staging\n---\nDeploy $ARGUMENTS",
    )
    write(project / ".claude/commands/frontend/component.md", "# Make a React component\nBody")
    write(home / ".claude/commands/deploy.md", "The user's own deploy (hidden by the project's)")
    write(home / ".claude/commands/standup.md", "\n\nWrite my standup notes\n")
    write(
        home / ".claude/skills/pdf-tools/SKILL.md",
        "---\nname: pdf-tools\ndescription: Fill PDF forms\n---\n",
    )
    write(
        home / ".claude/skills/secret/SKILL.md", "---\nname: secret\nuser-invocable: false\n---\n"
    )
    items = catalog(project, home)
    assert [(i["name"], i["scope"]) for i in items] == [
        ("deploy", "project"),
        ("component", "project"),
        ("standup", "user"),
        ("pdf-tools", "skill"),
    ]
    assert items[0]["help"] == "Ship it to staging"
    assert items[1]["help"] == "Make a React component"
    assert items[2]["help"] == "Write my standup notes"
    assert items[3]["help"] == "Fill PDF forms"


def test_nothing_there_is_an_empty_list(tmp_path):
    assert catalog(tmp_path / "proj", tmp_path / "home") == []


def test_links_out_of_the_commands_folder_are_skipped(tmp_path):
    project, home = tmp_path / "proj", tmp_path / "home"
    write(tmp_path / "elsewhere.md", "Outside")
    (project / ".claude/commands").mkdir(parents=True)
    (project / ".claude/commands/sneaky.md").symlink_to(tmp_path / "elsewhere.md")
    write(project / ".claude/commands/ok.md", "Fine")
    assert [i["name"] for i in catalog(project, home)] == ["ok"]


def test_agents_and_hooks_as_agents_and_hooks_show_them(tmp_path):
    from jarvis.code_commands import agents, describe, hooks

    project, home = tmp_path / "proj", tmp_path / "home"
    assert describe("agents", project, home).startswith("No custom subagents")
    assert describe("hooks", project, home).startswith("No hooks")
    write(
        project / ".claude/agents/reviewer.md",
        "---\nname: code-reviewer\ndescription: Reviews diffs\n---\nYou review.",
    )
    write(home / ".claude/agents/code-reviewer.md", "---\nname: code-reviewer\n---\nHidden")
    write(home / ".claude/agents/writer.md", "Writes docs")
    assert [(a["name"], a["scope"]) for a in agents(project, home)] == [
        ("code-reviewer", "project"),
        ("writer", "user"),
    ]
    assert "- code-reviewer (project): Reviews diffs" in describe("agents", project, home)
    write(
        project / ".claude/settings.json",
        '{"hooks": {"PostToolUse": [{"matcher": "Edit|Write", "hooks": '
        '[{"type": "command", "command": "npm run lint"}]}], "Stop": "odd"}}',
    )
    write(project / ".claude/settings.local.json", "{not json")
    write(home / ".claude/settings.json", '{"hooks": {"Stop": [{"hooks": [{"type": "command", '
          '"command": "say done"}, 7]}]}}')  # fmt: skip
    assert [(h["event"], h["command"], h["scope"]) for h in hooks(project, home)] == [
        ("Stop", "say done", "user"),
        ("PostToolUse", "npm run lint", "project"),
        ("", "", "local (unreadable)"),
    ]
    note = describe("hooks", project, home)
    assert "- PostToolUse [Edit|Write]: npm run lint (project)" in note
    assert "- local (unreadable) settings: not valid JSON" in note
