"""Security: what comes back from Eden Cloud is fast-forwarded into the copy only when it
can't make code run on this Mac (code_eden_cloud._landing_risks on top of code_handoff's
list): a risky name in other letters (a Mac's disk ignores case), a symbolic link, a
submodule, an editor's folder all stay parked under their ref. No network, no model."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from jarvis.features.code_eden_cloud import _landing_risks


def git(cwd, *args):
    return subprocess.run(
        ["git", "-c", "user.name=T", "-c", "user.email=t@x", "-c", "core.hooksPath=/dev/null", *args],
        cwd=cwd, capture_output=True, check=True, text=True,
    ).stdout.strip()  # fmt: skip


@pytest.fixture
def repo(tmp_path: Path) -> tuple[Path, str]:
    root = tmp_path / "r"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    (root / "a.txt").write_text("a\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "base")
    return root, git(root, "rev-parse", "HEAD")


def changed(root: Path, base: str, make) -> list[str]:
    git(root, "checkout", "-q", "-B", "back", base)
    make(root)
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "came back")
    return _landing_risks(root, base, "back")


def test_a_plain_change_lands(repo):
    root, base = repo
    assert changed(root, base, lambda r: (r / "b.txt").write_text("b\n")) == []


def test_risky_names_in_other_letters_are_parked(repo):
    root, base = repo

    def make(r: Path) -> None:
        # Written by git's own index (not this Mac's disk, which would fold the case).
        for name in (".Claude/settings.json", "claude.md", ".MCP.json", ".Husky/pre-commit"):
            blob = subprocess.run(
                ["git", "hash-object", "-w", "--stdin"], cwd=r, input="{}\n",
                capture_output=True, text=True, check=True,
            ).stdout.strip()  # fmt: skip
            git(r, "update-index", "--add", "--cacheinfo", f"100644,{blob},{name}")

    git(root, "checkout", "-q", "-B", "back", base)
    make(root)
    git(root, "commit", "-q", "-m", "came back")
    found = _landing_risks(root, base, "back")
    assert sorted(found) == sorted([".Claude/settings.json", "claude.md", ".MCP.json", ".Husky/pre-commit"])


def test_a_symlink_or_an_editor_folder_is_parked(repo):
    root, base = repo

    def make(r: Path) -> None:
        os.symlink(os.path.expanduser("~/.ssh/id_ed25519"), r / "notes.txt")
        (r / ".vscode").mkdir()
        (r / ".vscode" / "tasks.json").write_text('{"tasks": [{"runOptions": {"runOn": "folderOpen"}}]}')

    found = changed(root, base, make)
    assert "notes.txt" in found and ".vscode/tasks.json" in found


def test_a_submodule_is_parked(repo):
    root, base = repo
    git(root, "checkout", "-q", "-B", "back", base)
    git(root, "update-index", "--add", "--cacheinfo", f"160000,{base},vendor/lib")
    git(root, "commit", "-q", "-m", "came back")
    assert _landing_risks(root, base, "back") == ["vendor/lib"]


def test_an_unreadable_list_parks_everything(repo):
    root, base = repo
    assert _landing_risks(root, base, "no-such-ref") == ["(couldn't list what it changed)"]
