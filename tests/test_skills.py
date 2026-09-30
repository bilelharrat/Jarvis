"""Skills for JARVIS itself (jarvis.skills): SKILL.md frontmatter read the way skills write it,
what a skill needs to be used on this Mac, the folder and its switches, installing (a copy,
never a link, never bigger than a skill should be), the brain's tools, and cloning only over
https."""

import asyncio
import json
import os
import subprocess
from pathlib import Path

import pytest

from jarvis import skills
from jarvis.skills import SkillStore, clean_git_url, parse_frontmatter, problems_for, requirements


def write_skill(
    root: Path,
    name: str,
    description: str = "Does a thing. Use it for things.",
    body: str = "Step one.\nStep two.\n",
    extra: str = "",
) -> Path:
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n{extra}---\n\n{body}"
    )
    return folder


def make_store(tmp_path, have=("git",), trash=None):
    gone = []
    store = SkillStore(
        tmp_path / "skills",
        tmp_path / "skills.json",
        which=lambda name: name in have,
        trash=trash or (lambda path: gone.append(path)),
    )
    store.gone = gone
    return store


# ── frontmatter ──


def test_the_frontmatter_skills_write_is_read():
    meta, body = parse_frontmatter(
        "---\n"
        "name: pdf-processing\n"
        "description: Extract text and tables from PDF files. Use it when the user mentions PDFs.\n"
        "license: Apache-2.0  # a comment\n"
        "metadata:\n"
        "  author: example-org\n"
        '  version: "1.0"\n'
        "allowed-tools: Bash(git:*) Read\n"
        "---\n"
        "# PDF processing\n\nUse pypdf.\n"
    )
    assert meta["name"] == "pdf-processing"
    assert meta["description"].startswith("Extract text and tables")
    assert meta["license"] == "Apache-2.0"
    assert meta["metadata"] == {"author": "example-org", "version": "1.0"}
    assert meta["allowed-tools"] == "Bash(git:*) Read"
    assert body == "# PDF processing\n\nUse pypdf."


def test_block_scalars_lists_and_quotes():
    meta, _ = parse_frontmatter(
        "---\n"
        "name: 'weekly-report'\n"
        "description: >\n"
        "  Sums up the week from the calendar\n"
        "  and the inbox.\n"
        "\n"
        "  Use it on Fridays.\n"
        "notes: |\n"
        "  line one\n"
        "  line two\n"
        "tags:\n"
        "  - reports\n"
        "  - weekly\n"
        "steps:\n"
        "  - name: first\n"
        "    tool: list_events\n"
        "  - name: second\n"
        'quoted: "a \\"quoted\\" word: here"\n'
        "flag: true\n"
        "---\n"
    )
    assert meta["name"] == "weekly-report"
    assert (
        meta["description"]
        == "Sums up the week from the calendar and the inbox.\nUse it on Fridays."
    )
    assert meta["notes"] == "line one\nline two"
    assert meta["tags"] == ["reports", "weekly"]
    assert meta["steps"] == [{"name": "first", "tool": "list_events"}, {"name": "second"}]
    assert meta["quoted"] == 'a "quoted" word: here'
    assert meta["flag"] is True


def test_metadata_as_json_on_one_line_or_spread_over_several():
    one, _ = parse_frontmatter(
        "---\nname: gemini\ndescription: Gemini CLI.\n"
        'metadata: {"clawdbot":{"emoji":"*","requires":{"bins":["gemini"]}}}\n---\n'
    )
    assert one["metadata"]["clawdbot"]["requires"]["bins"] == ["gemini"]
    spread, _ = parse_frontmatter(
        "---\n"
        "name: obsidian\n"
        "description: Notes in Obsidian.\n"
        "metadata:\n"
        "  {\n"
        '    "openclaw":\n'
        "      {\n"
        '        "requires": { "bins": ["obsidian-cli"], "env": ["VAULT"] },\n'
        '        "os": ["darwin"],\n'
        "      },\n"
        "  }\n"
        "homepage: https://example.com\n"
        "---\n"
    )
    assert spread["metadata"]["openclaw"]["requires"] == {
        "bins": ["obsidian-cli"],
        "env": ["VAULT"],
    }
    assert spread["homepage"] == "https://example.com"


@pytest.mark.parametrize(
    "text",
    [
        "no frontmatter at all\n",
        "---\nname: x\nnever closed\n",
        "---\n: : :\n\t- [\n---\nbody",
        "---\n" + "a:\n " * 3000 + "---\n",
    ],
)
def test_odd_frontmatter_never_raises(text):
    meta, body = parse_frontmatter(text)
    assert isinstance(meta, dict) and isinstance(body, str)


# ── what a skill needs ──


def test_what_a_skill_needs_and_why_it_cant_be_used(monkeypatch):
    needs = requirements(
        {
            "metadata": {
                "openclaw": {
                    "os": ["linux"],
                    "requires": {
                        "bins": ["jq", "ffmpeg"],
                        "anyBins": ["rg", "grep"],
                        "env": ["NOTION_KEY", "bad name"],
                    },
                }
            }
        }
    )
    assert needs == {
        "os": ["linux"],
        "bins": ["jq", "ffmpeg"],
        "any_bins": ["rg", "grep"],
        "env": ["NOTION_KEY"],
    }
    monkeypatch.delenv("NOTION_KEY", raising=False)
    problems = problems_for(needs, which=lambda b: b in ("jq", "grep"))
    assert problems == [
        "It's made for linux, not macOS.",
        "It needs ffmpeg, which this Mac doesn't have.",
        "It needs NOTION_KEY set, and it isn't.",
    ]
    monkeypatch.setenv("NOTION_KEY", "set")
    assert problems_for(
        {"os": ["darwin"], "bins": ["jq"], "any_bins": ["x", "y"], "env": ["NOTION_KEY"]},
        which=lambda b: b == "jq",
    ) == ["It needs one of x, y, and this Mac has none of them."]


# ── the folder ──


def test_skills_in_the_folder_start_off_and_switch_on(tmp_path):
    store = make_store(tmp_path)
    write_skill(store.folder, "weekly-report")
    write_skill(
        store.folder,
        "needs-ffmpeg",
        extra='metadata: {"jarvis": {"requires": {"bins": ["ffmpeg"]}}}\n',
    )
    write_skill(store.folder, "Bad_Name")
    (store.folder / "no-description").mkdir()
    (store.folder / "no-description" / "SKILL.md").write_text(
        "---\nname: no-description\n---\nbody"
    )
    (store.folder / ".hidden").mkdir()
    shown = {s["name"]: s for s in store.public()}
    assert set(shown) == {"weekly-report", "needs-ffmpeg", "Bad_Name", "no-description"}
    assert not any(s["on"] for s in shown.values())
    assert shown["needs-ffmpeg"]["problems"] == ["It needs ffmpeg, which this Mac doesn't have."]
    assert "name isn't one a skill can have" in shown["Bad_Name"]["problems"][0]
    assert "no description" in shown["no-description"]["problems"][0]
    assert store.offered() == [] and store.prompt_block() == ""
    store.set_enabled("weekly-report", True)
    store.set_enabled("needs-ffmpeg", True)  # on, but not usable here: never offered
    assert [s.name for s in store.offered()] == ["weekly-report"]
    block = store.prompt_block()
    assert (
        "weekly-report (Does a thing. Use it for things.)" in block and "needs-ffmpeg" not in block
    )
    assert "grants nothing" in block
    again = make_store(tmp_path)  # kept across a restart
    assert [s.name for s in again.offered()] == ["weekly-report"]
    with pytest.raises(ValueError, match="no skill like that"):
        store.set_enabled("Bad_Name", True)


def test_a_linked_folder_is_not_a_skill(tmp_path):
    store = make_store(tmp_path)
    elsewhere = write_skill(tmp_path / "elsewhere", "linked")
    store.folder.mkdir(parents=True, exist_ok=True)
    os.symlink(elsewhere, store.folder / "linked")
    assert store.public() == []


def test_a_damaged_state_file_is_kept_aside(tmp_path):
    (tmp_path / "skills.json").write_text("{nope")
    store = make_store(tmp_path)
    write_skill(store.folder, "alpha")
    assert store.enabled == []
    store.set_enabled("alpha", True)
    assert json.loads((tmp_path / "skills.json").read_text())["enabled"] == ["alpha"]


def test_reading_a_skills_files_stays_inside_it(tmp_path):
    store = make_store(tmp_path)
    folder = write_skill(store.folder, "alpha")
    (folder / "references").mkdir()
    (folder / "references" / "guide.md").write_text("The guide.")
    (folder / "logo.png").write_bytes(b"\x89PNG\x00\x00binary")
    (tmp_path / "secret.txt").write_text("the owner's secret")
    os.symlink(tmp_path / "secret.txt", folder / "references" / "leak.md")
    store.set_enabled("alpha", True)
    assert store.read_file("alpha", "references/guide.md") == "The guide."
    for path, why in [
        ("../../secret.txt", "path inside the skill"),
        ("references/leak.md", "no such file"),
        ("logo.png", "isn't text"),
        ("references", "a folder"),
        ("", "path inside the skill"),
    ]:
        with pytest.raises(ValueError, match=why):
            store.read_file("alpha", path)
    assert [f for f, _ in skills.skill_files(folder)] == ["logo.png", "references/guide.md"]


# ── installing ──


def test_installing_a_folder_copies_plain_files_and_leaves_skills_off(tmp_path):
    store = make_store(tmp_path)
    source = write_skill(tmp_path / "download", "alpha", body="Do alpha.\n")
    (source / "scripts").mkdir()
    (source / "scripts" / "run.py").write_text("print('hi')")
    (source / ".env").write_text("TOKEN=x")
    (tmp_path / "outside.txt").write_text("not the skill's")
    os.symlink(tmp_path / "outside.txt", source / "link.txt")
    done = store.install_folder(source, f"folder:{source}")
    assert done == {"installed": ["alpha"], "skipped": []}
    copied = sorted(
        p.relative_to(store.folder).as_posix() for p in store.folder.rglob("*") if p.is_file()
    )
    assert copied == ["alpha/SKILL.md", "alpha/scripts/run.py"]
    assert (
        not (store.folder / "alpha" / "link.txt").exists()
        and not (store.folder / "alpha" / ".env").exists()
    )
    assert store.public()[0]["on"] is False and store.public()[0]["source"] == f"folder:{source}"
    again = store.install_folder(source, "folder:x")
    assert again == {"installed": [], "skipped": [("alpha", skills.INSTALLED_ALREADY)]}


def test_installing_a_collection_finds_each_skill(tmp_path):
    store = make_store(tmp_path)
    repo = tmp_path / "repo"
    write_skill(repo / "skills", "alpha")
    write_skill(repo / "skills", "beta")
    write_skill(repo / "skills" / "beta" / "nested", "gamma")  # a skill's own subfolder: its files
    (repo / "skills" / "broken").mkdir(parents=True)
    (repo / "skills" / "broken" / "SKILL.md").write_text("no frontmatter")
    write_skill(repo / ".git", "hidden")
    done = store.install_folder(repo, "git:https://github.com/o/r")
    assert done["installed"] == ["alpha", "beta"]
    assert [label for label, _ in done["skipped"]] == ["broken"]
    assert (store.folder / "beta" / "nested" / "gamma" / "SKILL.md").exists()
    empty = tmp_path / "download-empty"
    empty.mkdir()
    with pytest.raises(ValueError, match="no skill in that folder"):
        store.install_folder(empty, "x")
    with pytest.raises(ValueError, match="isn't a folder"):
        store.install_folder(tmp_path / "missing", "x")


def test_a_skill_too_big_is_not_copied(tmp_path, monkeypatch):
    monkeypatch.setattr(skills, "MAX_SKILL_BYTES", 1000)
    store = make_store(tmp_path)
    source = write_skill(tmp_path / "d", "huge")
    (source / "blob.txt").write_text("x" * 5000)
    done = store.install_folder(source, "folder:d")
    assert done["installed"] == [] and "too big" in done["skipped"][0][1]
    assert not (store.folder / "huge").exists() and not list(store.folder.glob(".*part"))


def test_a_proposal_saved_as_a_skill_and_one_removed(tmp_path):
    store = make_store(tmp_path)
    name = store.install_text(
        "weekly", "---\nname: weekly\ndescription: The week.\n---\n\nDo it.", "drafted by Jarvis"
    )
    assert name == "weekly" and store.find("weekly").description == "The week."
    with pytest.raises(ValueError, match="already"):
        store.install_text("weekly", "---\nname: weekly\ndescription: d\n---\nx", "x")
    store.set_enabled("weekly", True)
    assert store.remove("weekly") == "weekly"
    assert store.gone == [store.folder / "weekly"] and store.enabled == []

    def refuse(_path):
        raise OSError("no Trash here")

    other = make_store(tmp_path / "o", trash=refuse)
    write_skill(other.folder, "keep")
    with pytest.raises(ValueError, match="couldn't move keep to the Trash"):
        other.remove("keep")


# ── the brain's tools ──


async def call(tools, name, args):
    tool = next(t for t in tools if t.name == name)
    return await tool.handler(args)


async def test_the_brain_gets_instructions_as_words_that_grant_nothing(tmp_path):
    store = make_store(tmp_path)
    folder = write_skill(
        store.folder,
        "alpha",
        body="1. Check the calendar.\n2. Say it briefly.\n",
        extra="allowed-tools: Bash\n",
    )
    (folder / "reference.md").write_text("More.")
    write_skill(store.folder, "beta")
    tools = skills.build_tools(store)
    listed = await call(tools, "list_skills", {})
    assert "No skills are switched on" in listed["content"][0]["text"]
    refused = await call(tools, "use_skill", {"name": "alpha"})
    assert refused.get("is_error")  # off: not offered
    store.set_enabled("alpha", True)
    used = (await call(tools, "use_skill", {"name": "alpha"}))["content"][0]["text"]
    assert "grant nothing" in used and "1. Check the calendar." in used
    assert "- reference.md (5 bytes)" in used
    read = await call(tools, "read_skill_file", {"name": "alpha", "path": "reference.md"})
    assert read["content"][0]["text"] == "More."
    listed = await call(tools, "list_skills", {})
    assert listed["content"][0]["text"] == "alpha: Does a thing. Use it for things."
    assert [t.name for t in tools] == ["list_skills", "use_skill", "read_skill_file"]


# ── cloning ──


@pytest.mark.parametrize(
    ("given", "kept"),
    [
        ("https://github.com/anthropics/skills", "https://github.com/anthropics/skills"),
        ("github.com/owner/repo.git", "https://github.com/owner/repo.git"),
    ],
)
def test_git_addresses_that_can_be_cloned(given, kept):
    assert clean_git_url(given) == kept


@pytest.mark.parametrize(
    ("given", "why"),
    [
        ("", "Give the repository"),
        ("http://github.com/o/r", "Only https"),
        ("git@github.com:o/r.git", "Only https"),
        ("file:///Users/me/repo", "Only https"),
        ("ssh://github.com/o/r", "Only https"),
        ("https://user:pw@github.com/o/r", "user name or password"),
        ("https://github.com/o/r?x=1", "doesn't look like"),
        ("https://github.com/o/r;rm -rf", "Give the repository"),
    ],
)
def test_git_addresses_that_are_refused(given, why):
    with pytest.raises(ValueError, match=why):
        clean_git_url(given)


async def test_install_git_clones_then_installs_then_cleans_up(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    source = tmp_path / "prepared"
    write_skill(source / "skills", "alpha")
    seen = []

    async def fake_clone(url, into, timeout=0):
        seen.append((url, into))
        import shutil

        shutil.copytree(source, into)

    monkeypatch.setattr(skills, "clone", fake_clone)
    done = await skills.install_git(store, "https://github.com/o/r")
    assert done["installed"] == ["alpha"] and store.sources["alpha"] == "git:https://github.com/o/r"
    assert not seen[0][1].exists() and not seen[0][1].parent.exists()  # the clone is gone

    async def failing(url, into, timeout=0):
        raise OSError("repository not found")

    monkeypatch.setattr(skills, "clone", failing)
    with pytest.raises(ValueError, match="couldn't clone it: repository not found"):
        await skills.install_git(store, "https://github.com/o/missing")


async def test_clone_takes_nothing_but_https(tmp_path):
    """A real git, run on this Mac only: a local repository behind a file:// address is
    refused (protocol.allow=never), so no address can reach the owner's own files."""
    repo = tmp_path / "local"
    repo.mkdir()
    env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
    subprocess.run(["git", "init", "-q", str(repo)], check=True, env=env)
    (repo / "SKILL.md").write_text("---\nname: x\ndescription: y\n---\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True, env=env)
    subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x"],
        check=True,
        env=env,
    )
    with pytest.raises(OSError):
        await skills.clone(f"file://{repo}", tmp_path / "into", timeout=30)
    assert not (tmp_path / "into" / "SKILL.md").exists()
    assert asyncio.get_running_loop() is not None
