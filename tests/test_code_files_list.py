"""A project's file list for Eden Code's Files pane and @ suggestions (code_vocab, the hub's
project_files): names as they are, and every file findable in a big project.
Round 1 bug sweep, askeden/docs/bug-sweep/r1-eden-code-workspace.md (CF4, CF5)."""

import asyncio
import subprocess

import pytest
from code_session_fakes import make_hub

from jarvis import code_vocab
from jarvis.code_vocab import ProjectVocab

ODD = ["café ✓ 文件.py", "prøj ü space/a b.py", "src/plain.py"]


def git_repo(root, names):
    root.mkdir(parents=True)
    for rel in names:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text("x = 1\n")
    run = lambda *a: subprocess.run(["git", "-C", str(root), *a], check=True, capture_output=True)  # noqa: E731
    run("init", "-q")
    run("add", "-A")
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x")
    return root


def test_non_ascii_names_come_as_they_are(tmp_path):
    """CF4: git ls-files quoted them in octal ("caf\\303\\251…"): unopenable, unmentionable."""
    vocab = ProjectVocab(git_repo(tmp_path / "p", ODD))
    vocab.refresh()
    assert sorted(vocab.files) == sorted(ODD)
    (tmp_path / "p" / "new ü.txt").write_text("untracked\n")
    vocab.refresh(force=True)
    assert "new ü.txt" in vocab.files


def test_every_file_of_a_big_project_can_be_found(tmp_path, monkeypatch):
    """CF5: only the first 6,000 (of at most 20,000) went to the window; the rest could not
    be found by filtering. Now all are listed, and found by a query."""
    monkeypatch.setattr(code_vocab, "MAX_FILES", 50)
    names = [f"src/d{i:02}/f{j}.py" for i in range(20) for j in range(10)]
    vocab = ProjectVocab(git_repo(tmp_path / "big", names))
    vocab.refresh()
    assert len(vocab.files) == 50 and len(vocab.all_files) == 200
    assert vocab.find("d19/f9") == ["src/d19/f9.py"]
    assert vocab.find("F9.PY")[:2] == ["src/d00/f9.py", "src/d01/f9.py"]
    assert vocab.find("  ") == []


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


async def test_the_window_hears_how_many_there_are_and_finds_the_rest(hub, tmp_path, monkeypatch):
    monkeypatch.setattr(code_vocab, "_vocabs", {})
    names = [f"f{i:04}.py" for i in range(6100)]
    root = tmp_path / "big"
    root.mkdir()
    for rel in names:
        (root / rel).write_text("")
    hub.tasks.resolve_dir = lambda directory: root
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    await hub.handle({"type": "project_files", "directory": "big"})
    for _ in range(400):
        if seen:
            break
        await asyncio.sleep(0.01)
    first = seen[0][1]
    assert len(first["files"]) == 6000 and first["total"] == 6100 and "query" not in first
    await hub.handle({"type": "project_files", "directory": "big", "query": "f6099"})
    for _ in range(400):
        if len(seen) > 1:
            break
        await asyncio.sleep(0.01)
    found = seen[1][1]
    assert found["query"] == "f6099" and found["files"] == ["f6099.py"]
