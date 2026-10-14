"""Eden Code's sandbox allowlists (codesandbox.SandboxBook) when their store is missing,
damaged, unreadable or odd: a book never lets more through than the owner allowed, a file
it can't read is never saved over, and the edge cases of adding and removing domains."""

import json
import os

import pytest

from jarvis import codesandbox, jsonstore
from jarvis.codesandbox import DomainError, SandboxBook


def test_a_book_with_no_file_lives_in_memory_and_saving_writes_nothing(tmp_path):
    """A book without a path keeps its lists in memory only: adding and removing work and
    no file appears anywhere."""
    book = SandboxBook(None)
    assert book.projects == {} and book.unreadable == ""
    assert book.add("/p", ["pypi.org"]) == ["pypi.org"]
    book.save()
    assert book.remove("/p", "pypi.org")
    assert book.projects == {} and list(tmp_path.iterdir()) == []


def test_a_missing_store_file_starts_with_empty_lists_and_is_created_on_the_first_add(tmp_path):
    """No code_sandbox.json yet: nothing is allowed, and the first domain allowed writes the
    file with that project's list."""
    path = tmp_path / "code_sandbox.json"
    book = SandboxBook(path)
    assert book.projects == {} and book.unreadable == "" and not path.exists()
    book.add("/p", ["github.com"])
    assert json.loads(path.read_text()) == {
        "projects": {"/p": {"domains": ["github.com"]}},
        "version": 1,
    }


def test_a_damaged_store_file_is_set_aside_and_the_lists_start_over(tmp_path):
    """A store that isn't JSON is kept beside it as a .bad copy, the book starts empty (the
    sandbox lets no domain through) and later saves work normally."""
    path = tmp_path / "code_sandbox.json"
    path.write_text("{this is not json")
    book = SandboxBook(path)
    assert book.projects == {} and book.unreadable == ""
    kept = [p.name for p in tmp_path.iterdir() if ".bad-" in p.name]
    assert len(kept) == 1 and (tmp_path / kept[0]).read_text() == "{this is not json"
    book.add("/p", ["pypi.org"])
    assert SandboxBook(path).domains("/p") == ["pypi.org"]


def test_a_damaged_store_file_comes_back_from_its_last_good_copy(tmp_path):
    """A store damaged after a save is read from the .bak copy the save before it kept."""
    path = tmp_path / "code_sandbox.json"
    book = SandboxBook(path)
    book.add("/p", ["pypi.org"])
    book.add("/p", ["github.com"])  # the second save keeps the first as code_sandbox.json.bak
    path.write_text("garbage")
    assert SandboxBook(path).domains("/p") == ["pypi.org"]


def test_a_store_file_of_the_wrong_shape_is_treated_as_damaged(tmp_path):
    """A JSON list where an object belongs is set aside like a damaged file: no domain is
    taken from it."""
    path = tmp_path / "code_sandbox.json"
    path.write_text(json.dumps(["pypi.org", "github.com"]))
    book = SandboxBook(path)
    assert book.projects == {} and book.unreadable == ""
    assert any(".bad-" in p.name for p in tmp_path.iterdir())


def test_a_store_file_that_cant_be_read_is_never_saved_over(tmp_path):
    """A store the app has no permission to read leaves the book empty and saying why, and
    any change refuses to save rather than replace the owner's lists."""
    path = tmp_path / "code_sandbox.json"
    original = json.dumps({"projects": {"/p": {"domains": ["pypi.org"]}}})
    path.write_text(original)
    os.chmod(path, 0)
    try:
        if os.access(path, os.R_OK):
            pytest.skip("running with permission to read any file")
        book = SandboxBook(path)
        assert book.projects == {} and book.unreadable
        with pytest.raises(jsonstore.Unreadable, match="so nothing was saved"):
            book.add("/q", ["github.com"])
    finally:
        os.chmod(path, 0o600)
    assert path.read_text() == original


def test_a_store_path_that_is_a_folder_is_unreadable_and_refuses_to_save(tmp_path):
    """A folder where the store file belongs can't be read; saving is refused and the
    folder is left as it was."""
    path = tmp_path / "code_sandbox.json"
    path.mkdir()
    book = SandboxBook(path)
    assert book.unreadable and book.projects == {}
    with pytest.raises(jsonstore.Unreadable):
        book.save()
    assert path.is_dir()


def test_odd_entries_in_the_store_are_left_out_and_lists_are_capped(tmp_path, monkeypatch):
    """Projects that aren't objects, domain lists that aren't lists, duplicates and lists
    past the per-project cap are read down to what's usable."""
    monkeypatch.setattr(codesandbox, "DOMAINS_PER_PROJECT", 2)
    path = tmp_path / "code_sandbox.json"
    path.write_text(
        json.dumps(
            {
                "projects": {
                    "/many": {"domains": ["a.com", "A.com", "b.com", "c.com"]},
                    "/not-a-list": {"domains": "pypi.org"},
                    "/nothing-usable": {"domains": ["bad one", None]},
                    "/string": ["pypi.org"],
                }
            }
        )
    )
    assert SandboxBook(path).projects == {"/many": ["a.com", "b.com"]}
    path.write_text(json.dumps({"projects": ["/p"]}))
    assert SandboxBook(path).projects == {}


def test_only_so_many_projects_are_read_from_the_store(tmp_path, monkeypatch):
    """A store with more projects than are kept is read up to that many."""
    monkeypatch.setattr(codesandbox, "PROJECTS_KEPT", 2)
    path = tmp_path / "code_sandbox.json"
    projects = {f"/p{n}": {"domains": ["pypi.org"]} for n in range(5)}
    path.write_text(json.dumps({"projects": projects}))
    assert list(SandboxBook(path).projects) == ["/p0", "/p1"]


def test_too_many_domains_for_a_new_project_adds_none_and_leaves_no_empty_list(
    tmp_path, monkeypatch
):
    """Allowing more domains than one project may hold refuses all of them, and a project
    that had none before isn't left behind with an empty list (nothing is saved)."""
    monkeypatch.setattr(codesandbox, "DOMAINS_PER_PROJECT", 2)
    path = tmp_path / "code_sandbox.json"
    book = SandboxBook(path)
    with pytest.raises(DomainError, match="as many domains"):
        book.add("/p", ["a.com", "b.com", "c.com"])
    assert book.projects == {} and not path.exists()
    book.add("/q", ["a.com", "b.com"])
    with pytest.raises(DomainError, match="as many domains"):
        book.add("/q", ["c.com"])
    assert SandboxBook(path).domains("/q") == ["a.com", "b.com"]


def test_adding_no_domains_or_ones_already_there_saves_nothing(tmp_path):
    """An empty add leaves no empty project behind, and re-adding a known domain changes
    nothing on disk."""
    path = tmp_path / "code_sandbox.json"
    book = SandboxBook(path)
    assert book.add("/p", []) == []
    assert book.projects == {} and not path.exists()
    book.add("/p", ["pypi.org"])
    before = path.stat().st_mtime_ns
    assert book.add("/p", ["PYPI.org"]) == []
    assert path.stat().st_mtime_ns == before


def test_removing_a_projects_last_domain_takes_the_project_off_the_store(tmp_path):
    """Once its last domain is removed a project is gone from the file too, and removing
    from a project that has none says so."""
    path = tmp_path / "code_sandbox.json"
    book = SandboxBook(path)
    book.add("/p", ["pypi.org"])
    assert book.remove("/p", "pypi.org")
    assert json.loads(path.read_text()) == {"projects": {}, "version": 1}
    assert not book.remove("/p", "pypi.org") and not book.remove("/never", "x.com")
    assert book.domains("/p") == []
