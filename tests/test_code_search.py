"""Jarvis Code's project search (code_search): git grep in a repository, a Python walk in a
plain folder; text or an expression, match case, whole words and which files; bounded,
stoppable, and never a credentials file."""

import subprocess

import pytest

from jarvis import code_search
from jarvis.code_search import Query, SearchError, Stop, search, wanted


def files(root, tree):
    for rel, text in tree.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(text, bytes):
            path.write_bytes(text)
        else:
            path.write_text(text)


TREE = {
    "src/app.py": "def retry(n):\n    return retry_max(n)\n\nRETRY = 3\n",
    "src/web/app.js": "function retry() { return 1; }\n",
    "tests/test_app.py": "from src.app import retry\n",
    "README.md": "Call retry() to try again.\n",
    ".env": "RETRY_TOKEN=secret\n",
    "data.bin": b"retry\x00\x01\x02",
}


def repo(tmp_path, tree=TREE, ignored=("build/",)):
    root = tmp_path / "proj"
    root.mkdir()
    files(root, tree)
    run = lambda *a: subprocess.run(["git", "-C", str(root), *a], check=True, capture_output=True)  # noqa: E731
    run("init", "-q")
    (root / ".gitignore").write_text("".join(f"{p}\n" for p in ignored))
    run("add", "-A")
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x")
    return root


def plain(tmp_path, tree=TREE):
    root = tmp_path / "plain"
    root.mkdir()
    files(root, tree)
    return root


def paths(result):
    return [f["path"] for f in result["files"]]


@pytest.mark.parametrize("make", [repo, plain], ids=["git", "walk"])
def test_text_search_finds_each_line_and_where_on_it(tmp_path, make):
    root = make(tmp_path)
    got = search(root, Query("retry"))
    assert got["engine"] == ("git" if make is repo else "walk")
    assert sorted(paths(got)) == ["README.md", "src/app.py", "src/web/app.js", "tests/test_app.py"]
    app = next(f for f in got["files"] if f["path"] == "src/app.py")
    assert [m["line"] for m in app["matches"]] == [1, 2, 4]  # (RETRY too: case doesn't matter)
    assert app["matches"][1]["text"] == "    return retry_max(n)"
    assert app["matches"][1]["spans"] == [[11, 16]]
    assert got["total"] == 6 and not got["truncated"] and not got["stopped"]
    # Never the credentials file, nor a binary one.
    assert ".env" not in paths(got) and "data.bin" not in paths(got)


@pytest.mark.parametrize("make", [repo, plain], ids=["git", "walk"])
def test_match_case_whole_words_and_expressions(tmp_path, make):
    root = make(tmp_path)
    assert search(root, Query("RETRY", case=True))["total"] == 1
    worded = search(root, Query("retry", word=True))
    app = next(f for f in worded["files"] if f["path"] == "src/app.py")
    assert [m["line"] for m in app["matches"]] == [1, 4]  # not retry_max
    expr = search(root, Query(r"retry\((\w*)\)", regex=True))
    assert sorted(paths(expr)) == ["README.md", "src/app.py", "src/web/app.js"]
    # Text is text: a dot is a dot.
    assert search(root, Query("retry.", regex=False))["total"] == 0


@pytest.mark.parametrize("make", [repo, plain], ids=["git", "walk"])
def test_which_files_to_search(tmp_path, make):
    root = make(tmp_path)
    assert sorted(paths(search(root, Query("retry", include="*.py")))) == [
        "src/app.py",
        "tests/test_app.py",
    ]
    assert paths(search(root, Query("retry", include="src/, !*.py"))) == ["src/web/app.js"]
    assert paths(search(root, Query("retry", include="src/**/*.js"))) == ["src/web/app.js"]
    assert "tests/test_app.py" not in paths(search(root, Query("retry", include="!tests/")))


def test_git_leaves_out_what_git_ignores_and_the_walk_leaves_out_what_a_project_doesnt_own(
    tmp_path,
):
    root = repo(tmp_path, {**TREE, "build/out.js": "retry()\n", "new.py": "retry = 1\n"})
    got = paths(search(root, Query("retry")))
    assert "build/out.js" not in got
    assert "new.py" in got  # untracked, not ignored: still the owner's
    walked = plain(tmp_path, {**TREE, "node_modules/x/i.js": "retry\n", ".cache/y": "retry\n"})
    assert all(
        not p.startswith(("node_modules", ".cache")) for p in paths(search(walked, Query("retry")))
    )


def test_limits_cut_the_answer_short_and_say_so(tmp_path, monkeypatch):
    many = {f"f{i:03}.py": "retry\n" * 5 for i in range(30)}
    root = plain(tmp_path, many)
    monkeypatch.setattr(code_search, "MATCHES_MAX", 40)
    monkeypatch.setattr(code_search, "PER_FILE_MAX", 3)
    got = search(root, Query("retry"))
    assert got["truncated"] and got["total"] == 40
    assert all(len(f["matches"]) <= 3 for f in got["files"])
    assert all(f.get("more") for f in got["files"][:-1])  # (the last one cut by the total)
    monkeypatch.setattr(code_search, "LINE_MAX", 10)
    (tmp_path / "long").mkdir()
    long = plain(tmp_path / "long", {"a.py": "x" * 50 + " retry\n"})
    (match,) = search(long, Query("retry"))["files"][0]["matches"]
    assert match["text"] == "x" * 10 and match["spans"] == []


@pytest.mark.parametrize("make", [repo, plain], ids=["git", "walk"])
def test_a_stopped_search_says_so(tmp_path, make):
    root = make(tmp_path)
    stop = Stop()
    stop.set()
    got = search(root, Query("retry"), stop)
    assert got["stopped"] and got["total"] <= 1
    assert Stop(seconds=0)  # out of time counts as stopped


def test_queries_that_cant_run_say_why(tmp_path):
    root = plain(tmp_path)
    for query, why in (
        (Query("  "), "Type something"),
        (Query("x" * 600), "too long"),
        (Query("a\nb"), "too long"),
        (Query("retry(", regex=True), "isn't a regular expression"),
    ):
        with pytest.raises(SearchError, match=why):
            search(root, query)


def test_the_file_filter():
    assert wanted("src/a.py", "")
    assert wanted("src/a.py", "*.py") and not wanted("src/a.js", "*.py")
    assert wanted("src/deep/a.py", "src/") and not wanted("lib/src2/a.py", "src/")
    assert wanted("lib/src/a.py", "src/")  # a folder of that name anywhere
    assert not wanted("tests/a.py", "!tests/") and wanted("src/a.py", "!tests/")
    assert wanted("Makefile", "Makefile, *.py")
