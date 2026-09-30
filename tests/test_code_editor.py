"""Jarvis Code's editor (code_editor): project files read with their version and saved only
over that version (a conflict otherwise), atomically, keeping line endings and mode; never
outside the project, a credentials file or git's own files; and "Open in" the editors on
this Mac."""

import os
import stat

from jarvis import code_editor
from jarvis.code_editor import EDIT_MAX, Editors, find_editors, open_command, read, save, stat_of


def project(tmp_path):
    root = tmp_path / "proj"
    (root / "src").mkdir(parents=True)
    (root / "src" / "app.py").write_text("def main():\n    return 1\n")
    return root


def test_a_file_reads_with_its_version_and_saves_over_it(tmp_path):
    root = project(tmp_path)
    got = read(root, "src/app.py")
    assert got["text"] == "def main():\n    return 1\n" and got["editable"] and not got["crlf"]
    version = got["version"]
    assert set(version) == {"mtime_ns", "size", "sha"}
    done = save(root, "src/app.py", "def main():\n    return 2\n", version)
    assert done["ok"] and done["version"]["sha"] != version["sha"]
    assert (root / "src" / "app.py").read_text() == "def main():\n    return 2\n"
    # No temporary file is left beside it.
    assert sorted(p.name for p in (root / "src").iterdir()) == ["app.py"]


def test_a_file_changed_on_disk_since_it_was_opened_is_a_conflict_not_overwritten(tmp_path):
    root = project(tmp_path)
    version = read(root, "src/app.py")["version"]
    (root / "src" / "app.py").write_text("def main():\n    return 'claude'\n")
    clash = save(root, "src/app.py", "mine\n", version)
    assert clash["conflict"] and "ok" not in clash
    assert clash["disk_text"] == "def main():\n    return 'claude'\n"
    assert (root / "src" / "app.py").read_text() == "def main():\n    return 'claude'\n"
    # The owner chooses: theirs goes over it.
    assert save(root, "src/app.py", "mine\n", version, force=True)["ok"]
    assert (root / "src" / "app.py").read_text() == "mine\n"
    # Deleted meanwhile: a conflict too, and the save makes it again only when forced.
    version = read(root, "src/app.py")["version"]
    (root / "src" / "app.py").unlink()
    assert save(root, "src/app.py", "again\n", version) == {
        "path": "src/app.py",
        "conflict": True,
        "missing": True,
    }
    assert save(root, "src/app.py", "again\n", version, force=True)["ok"]


def test_touching_a_file_without_changing_it_is_no_conflict(tmp_path):
    root = project(tmp_path)
    version = read(root, "src/app.py")["version"]
    path = root / "src" / "app.py"
    os.utime(path, ns=(version["mtime_ns"] + 5_000_000_000, version["mtime_ns"] + 5_000_000_000))
    assert save(root, "src/app.py", "changed\n", version)["ok"]
    assert stat_of(root, "src/app.py")["version"]["sha"] != version["sha"]


def test_line_endings_mode_and_links_are_kept(tmp_path):
    root = project(tmp_path)
    win = root / "win.txt"
    win.write_bytes(b"one\r\ntwo\r\n")
    os.chmod(win, 0o755)
    got = read(root, "win.txt")
    assert got["text"] == "one\ntwo\n" and got["crlf"]
    assert save(root, "win.txt", "one\ntwo\nthree\n", got["version"], crlf=True)["ok"]
    assert win.read_bytes() == b"one\r\ntwo\r\nthree\r\n"
    assert stat.S_IMODE(win.stat().st_mode) == 0o755
    # A link inside the project: the file it points to is written, the link stays a link.
    (root / "link.py").symlink_to(root / "src" / "app.py")
    version = read(root, "link.py")["version"]
    assert save(root, "link.py", "via link\n", version)["ok"]
    assert (root / "link.py").is_symlink() and (root / "src" / "app.py").read_text() == "via link\n"


def test_nothing_outside_the_project_private_or_git_s_own(tmp_path):
    root = project(tmp_path)
    (tmp_path / "outside.txt").write_text("secret")
    (root / ".env").write_text("KEY=1")
    (root / "out").symlink_to(tmp_path / "outside.txt")
    (root / ".git").mkdir()
    (root / ".git" / "config").write_text("[core]\n")
    for rel in ("../outside.txt", "out", str(tmp_path / "outside.txt"), ".env", "", "a\0b"):
        assert "error" in read(root, rel), rel
        assert "error" in save(root, rel, "x", None, create=True), rel
    assert (tmp_path / "outside.txt").read_text() == "secret"
    git = read(root, ".git/config")
    assert git["editable"] is False and git["why"] == "git"
    assert "error" in save(root, ".git/config", "[core]\nhooksPath=/tmp\n", git.get("version"))
    # An absolute path inside the project is the same file.
    assert read(root, str(root / "src" / "app.py"))["text"].startswith("def main")


def test_big_binary_and_non_utf8_files_are_read_only(tmp_path, monkeypatch):
    root = project(tmp_path)
    monkeypatch.setattr(code_editor, "EDIT_MAX", 1000)
    monkeypatch.setattr(code_editor, "VIEW_MAX", 100)
    (root / "big.log").write_text("x" * 5000)
    big = read(root, "big.log")
    assert big["editable"] is False and big["truncated"] and len(big["text"]) == 100
    assert "version" not in big
    (root / "blob.bin").write_bytes(b"\x00\x01" * 50)
    assert read(root, "blob.bin")["error"] == "That's a binary file."
    (root / "latin.txt").write_bytes("café".encode("latin-1"))
    assert read(root, "latin.txt")["why"] == "not_utf8"
    assert EDIT_MAX == 1_000_000  # (the real limit)


def test_mixed_line_endings_are_read_only_since_a_save_would_change_them(tmp_path):
    root = project(tmp_path)
    for name, raw in (("both.txt", b"one\r\ntwo\nthree\r\n"), ("mac.txt", b"one\rtwo\n")):
        (root / name).write_bytes(raw)
        got = read(root, name)
        assert got["editable"] is False and got["why"] == "line_endings" and "version" not in got
    # A conflict with such a file never offers its text as the one to compare with.
    version = read(root, "src/app.py")["version"]
    (root / "src" / "app.py").write_bytes(b"a\r\nb\n")
    clash = save(root, "src/app.py", "x\n", version)
    assert clash["conflict"] and "disk_text" not in clash
    # One kind throughout is fine, either kind.
    (root / "unix.txt").write_bytes(b"a\nb\n")
    (root / "dos.txt").write_bytes(b"a\r\nb\r\n")
    assert read(root, "unix.txt")["editable"] and read(root, "dos.txt")["editable"]


def test_a_new_file_is_made_only_when_asked_and_only_if_nobody_made_it_meanwhile(tmp_path):
    root = project(tmp_path)
    assert read(root, "CLAUDE.local.md")["missing"]
    assert save(root, "CLAUDE.local.md", "# local\n", None)["error"] == "There's no such file."
    assert save(root, "CLAUDE.local.md", "# local\n", None, create=True)["ok"]
    assert (root / "CLAUDE.local.md").read_text() == "# local\n"
    clash = save(root, "CLAUDE.local.md", "# other\n", None, create=True)
    assert clash["conflict"] and clash["disk_text"] == "# local\n"


def test_the_editors_on_this_mac_and_how_each_opens_a_file(tmp_path):
    apps = tmp_path / "Applications"
    (apps / "Visual Studio Code.app").mkdir(parents=True)
    (apps / "Zed Preview.app").mkdir()
    asked = []

    def spotlight(bundles):
        asked.append(bundles)
        return bundles == ("com.todesktop.230313mzl4w4u92",)

    found = find_editors(lambda: [apps], spotlight)
    assert [e["id"] for e in found] == ["vscode", "cursor", "zed"]
    assert found[0]["bundle"] == "com.microsoft.VSCode"
    assert found[2]["bundle"] == "dev.zed.Zed-Preview"
    root = project(tmp_path)
    path = root / "src" / "app.py"
    vscode, cursor, zed = found
    assert open_command(vscode, path, 12) == ["open", f"vscode://file{path}:12:1"]
    assert open_command(cursor, path, 3)[1].startswith("cursor://file/")
    assert open_command(zed, path, 3) == ["open", "-b", "dev.zed.Zed-Preview", str(path)]
    assert open_command(vscode, root) == ["open", "-b", "com.microsoft.VSCode", str(root)]
    # A path with a space is quoted in the address.
    spaced = root / "my file.py"
    spaced.write_text("x")
    assert "my%20file.py:1:1" in open_command(vscode, spaced, 1)[1]
    # Looked for once, then remembered a while.
    calls = []
    editors = Editors(lambda: calls.append(1) or found)
    assert editors.get("zed")["name"] == "Zed" and editors.get("xcode") is None
    assert len(calls) == 1
