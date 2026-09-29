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
