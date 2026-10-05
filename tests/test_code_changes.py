"""A session's own changes (code_changes): a shared folder's diff split by who made each
hunk, three lines of context, stable hunk ids and numbers, and undoing one hunk without
touching the rest of its file. Real git, in temp repositories."""

import subprocess
from pathlib import Path

import pytest
from claude_agent_sdk import AssistantMessage, ToolResultBlock, ToolUseBlock, UserMessage
from conftest import FakeClient

from jarvis import code_changes as cc
from jarvis.tasks import ClaudeTask, TaskManager


def git(repo: Path, *args: str) -> str:
    done = subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    )
    return done.stdout


def make_repo(path: Path, files: dict[str, str]) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.email", "t@example.com")
    git(path, "config", "user.name", "t")
    for name, text in files.items():
        (path / name).parent.mkdir(parents=True, exist_ok=True)
        (path / name).write_text(text)
    git(path, "add", "-A")
    git(path, "commit", "-qm", "start")
    return path


def numbered(n: int, word: str = "line") -> str:
    return "".join(f"{word} {i}\n" for i in range(1, n + 1))


class Session:
    """A Jarvis Code session whose edits go through Claude Code's tools, as the manager
    hears them: a user message (a checkpoint), the tool call, then its result."""

    def __init__(
        self, tm: TaskManager, cwd: Path, task_id: int = 1, task: ClaudeTask | None = None
    ):
        self.tm = tm
        self.task = task or ClaudeTask(id=task_id, prompt="x", cwd=cwd)
        tm.tasks[self.task.id] = self.task
        self.n = 0

    def turn(self, uid: str) -> None:
        self.tm._on_task_message(self.task, UserMessage(content="do it", uuid=uid))

    def edit(self, path: Path, old: str, new: str, ok: bool = True) -> None:
        self.n += 1
        tool_id = f"e{self.task.id}-{self.n}"
        block = ToolUseBlock(
            id=tool_id,
            name="Edit",
            input={"file_path": str(path), "old_string": old, "new_string": new},
        )
        self.tm._on_task_message(self.task, AssistantMessage(content=[block], model="m"))
        if ok:
            path.write_text(path.read_text().replace(old, new, 1))
        result = ToolResultBlock(tool_use_id=tool_id, content="ok", is_error=not ok)
        self.tm._on_task_message(self.task, UserMessage(content=[result]))

    def write(self, path: Path, content: str) -> None:
        self.n += 1
        tool_id = f"w{self.task.id}-{self.n}"
        block = ToolUseBlock(
            id=tool_id, name="Write", input={"file_path": str(path), "content": content}
        )
        self.tm._on_task_message(self.task, AssistantMessage(content=[block], model="m"))
        path.write_text(content)
        result = ToolResultBlock(tool_use_id=tool_id, content="ok", is_error=False)
        self.tm._on_task_message(self.task, UserMessage(content=[result]))


@pytest.fixture
def tm(settings):
    async def approve(*_a, **_k):
        return "deny"

    return TaskManager(settings, approve, lambda *_a, **_k: None, FakeClient)


# ── the diff, parsed ──


def test_a_patch_parses_with_context_renames_odd_names_and_missing_newlines():
    patch = (
        "diff --git a/keep.txt b/keep.txt\n"
        "index b68fde2..20cbb4d 100644\n"
        "--- a/keep.txt\n+++ b/keep.txt\n"
        "@@ -1 +1 @@ def keep():\n-k\n+no newline\n\\ No newline at end of file\n"
        "diff --git a/my file.txt b/my file.txt\n"
        "--- a/my file.txt\t\n+++ b/my file.txt\t\n"
        "@@ -1,2 +1,3 @@\n a\n\n+b\n"  # an empty context line whose space was stripped
        "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n"
        'diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"\n'
        '--- "a/tab\\tname.txt"\n+++ "b/tab\\tname.txt"\n@@ -1 +1,2 @@\n x\n+y\n'
        "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n"
        "diff --git a/gone.py b/gone.py\ndeleted file mode 100644\n--- a/gone.py\n+++ /dev/null\n"
        "@@ -1,2 +0,0 @@\n-x = 1\n-y = 2\n"
    )
    files = cc.parse_patch(patch)
    assert [f.path for f in files] == [
        "keep.txt",
        "my file.txt",
        "new.txt",
        "tab\tname.txt",
        "img.png",
        "gone.py",
    ]
    keep, spaced, renamed, tabbed, image, gone = files
    assert keep.hunks[0].lines == [
        ("-", "k"),
        ("+", "no newline"),
        ("\\", " No newline at end of file"),
    ]
    assert keep.hunks[0].where == "keep" and keep.added == 1 and keep.removed == 1
    assert spaced.hunks[0].lines == [(" ", "a"), (" ", ""), ("+", "b")]
    assert renamed.status == "R" and renamed.old_path == "old.txt" and not renamed.hunks
    assert tabbed.hunks[0].added == ["y"]
    assert image.binary and not image.hunks
    assert gone.status == "D" and gone.removed == 2
    assert len({h.id for f in files for h in f.hunks}) == 4


def test_a_huge_deleted_file_full_of_dash_dash_comments_parses_in_linear_time():
    """A deleted SQL dump: each removed "-- comment" line reads "--- comment", which once made
    the parser count the whole hunk again (minutes for tens of thousands of lines)."""
    import time

    n = 30_000
    body = "".join(f"--- comment {i}\n-SELECT {i};\n" for i in range(n))
    patch = (
        "diff --git a/dump.sql b/dump.sql\ndeleted file mode 100644\n--- a/dump.sql\n"
        f"+++ /dev/null\n@@ -1,{2 * n} +0,0 @@\n{body}"
    )
    started = time.perf_counter()
    [dump] = cc.parse_patch(patch)
    assert dump.status == "D" and len(dump.hunks) == 1
    assert dump.removed == 2 * n and dump.hunks[0].removed[0] == "-- comment 0"
    # About 0.05 s here, and a second or two on a busy Mac; the quadratic count took minutes.
    assert time.perf_counter() - started < 10.0


def test_quoting_round_trips_the_way_git_writes_names():
    for name in ["plain.py", "my file.txt", 'quote"d', "tab\there", "back\\slash", "ünïcode.txt"]:
        quoted = cc._quote(f"a/{name}")
        assert cc._unquote(quoted) == f"a/{name}"
    assert cc._quote("a/plain.py") == "a/plain.py"
    assert cc._unquote('"a/\\303\\274.txt"') == "a/ü.txt"  # octal bytes, as quotepath writes them


def test_hunk_ids_follow_the_lines_not_where_they_are():
    one = cc.parse_patch("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3,2 +3,2 @@\n a\n-b\n+c\n")
    moved = cc.parse_patch("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -9,2 +12,2 @@\n a\n-b\n+c\n")
    assert one[0].hunks[0].id == moved[0].hunks[0].id
    twice = cc.parse_patch(
        "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3 +3 @@\n-b\n+c\n@@ -9 +9 @@\n-b\n+c\n"
    )
    first, second = twice[0].hunks
    assert first.id != second.id and second.id.startswith(first.id)


# ── marks ──


def test_marks_hold_what_each_edit_tool_wrote_and_took_out():
    edit = cc.fingerprint(
        "Edit", {"old_string": "def a():\n    return 1\n", "new_string": "def a():\n    return 2\n"}
    )
    assert edit.added == {"return 2"} and edit.removed == {"return 1"}  # not the unchanged line
    multi = cc.fingerprint(
        "MultiEdit",
        {
            "edits": [
                {"old_string": "x = 1", "new_string": "x = 2"},
                {"old_string": "y", "new_string": ""},
            ]
        },
    )
    assert multi.added == {"x = 2"} and multi.removed == {"x = 1", "y"}
    write = cc.fingerprint("Write", {"content": "a\n\nb\n"})
    assert write.added == {"a", "b"} and write.whole
    assert cc.fingerprint("NotebookEdit", {"new_source": "print(1)"}).added == {"print(1)"}
    assert cc.fingerprint("Bash", {"command": "ls"}) is None
    big = "\n".join(f"line {i}" for i in range(cc.MARK_LINES + 50))
    huge = cc.fingerprint("Edit", {"old_string": big, "new_string": big + "\nextra"})
    assert huge.added == {"extra"} and not huge.removed  # lined up cheaply, still right


def test_a_refused_edit_leaves_no_mark_and_a_rewind_forgets_its_turns(tm, tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(30)})
    s = Session(tm, repo)
    s.turn("u-1")
    s.edit(repo / "a.py", "line 3\n", "line three\n")
    s.edit(repo / "a.py", "line 9\n", "line nine\n", ok=False)  # refused: nothing changed
    s.turn("u-2")
    s.edit(repo / "a.py", "line 20\n", "line twenty\n")
    assert [m.checkpoint for m in s.task.edit_marks] == ["u-1", "u-2"]
    assert s.task.pending_marks == {}
    cc.forget(s.task, {"u-2"})
    assert [m.checkpoint for m in s.task.edit_marks] == ["u-1"]


# ── whose hunks ──


def test_two_sessions_in_one_folder_each_see_only_their_own_hunks(tm, tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(40), "b.py": numbered(10, "b")})
    one, two = Session(tm, repo, 1), Session(tm, repo, 2)
    one.turn("u-1")
    one.edit(repo / "a.py", "line 5\n", "line five = 5\n")
    two.turn("v-1")
    two.edit(repo / "a.py", "line 30\n", "line thirty = 30\n")
    two.edit(repo / "b.py", "b 2\n", "b two\n")
    (repo / "a.py").write_text((repo / "a.py").read_text().replace("line 18\n", "owner was here\n"))

    mine = cc.task_view(one.task)
    assert [f.path for f in mine.files] == ["a.py"]
    assert [h.added for h in mine.files[0].hunks] == [["line five = 5"]]
    theirs = cc.task_view(two.task)
    assert sorted(f.path for f in theirs.files) == ["a.py", "b.py"]
    assert [h.added for h in next(f for f in theirs.files if f.path == "a.py").hunks] == [
        ["line thirty = 30"]
    ]
    # Three lines of context around each change, as git shows it.
    hunk = mine.files[0].hunks[0]
    assert [t for tag, t in hunk.lines if tag == " "] == [
        "line 2",
        "line 3",
        "line 4",
        "line 6",
        "line 7",
        "line 8",
    ]
    assert hunk.first_changed == 5
    # The whole branch is everyone's: the owner's line too.
    branch = cc.task_view(one.task, "branch")
    assert sum(len(f.hunks) for f in branch.files) == 4


def test_this_turn_is_the_latest_messages_hunks_numbered_as_the_session(tm, tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(40), "big.py": numbered(40, "x")})
    s = Session(tm, repo)
    s.turn("u-1")
    s.edit(repo / "a.py", "line 5\n", "line five\n")
    s.turn("u-2")
    s.edit(repo / "big.py", "x 3\n", "x three\nx three and a half\nx three and more\nx four soon\n")
    s.edit(repo / "a.py", "line 30\n", "line thirty\n")
    session = cc.task_view(s.task)
    # Biggest file first: "the first change" is in the first file "what changed" names.
    assert [f.path for f in session.files] == ["big.py", "a.py"]
    assert [(n, f.path) for n, f, _h in session.numbered()] == [
        (1, "big.py"),
        (2, "a.py"),
        (3, "a.py"),
    ]
    turn = cc.task_view(s.task, "turn")
    assert [(n, h.added) for n, _f, h in turn.numbered()] == [
        (1, ["x three", "x three and a half", "x three and more", "x four soon"]),
        (3, ["line thirty"]),
    ]
    assert session.by_number(2)[1].added == ["line five"]


def test_a_line_that_is_everywhere_never_claims_someone_elses_hunk(tm, tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(40)})
    s = Session(tm, repo)
    s.turn("u-1")
    s.edit(repo / "a.py", "line 5\n", "if ready:\n    start_engine()\nelse:\n")
    text = (repo / "a.py").read_text().replace("line 30\n", "else:\n    stop_engine()\n")
    (repo / "a.py").write_text(text)  # the owner's, sharing only "else:"
    view = cc.task_view(s.task)
    assert [h.added for h in view.files[0].hunks] == [["if ready:", "    start_engine()", "else:"]]


def test_a_file_it_wrote_whole_and_a_new_file_are_its_own(tm, tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(10)})
    s = Session(tm, repo)
    s.turn("u-1")
    s.write(repo / "a.py", "line 1\nline 2\n")  # everything after line 2 gone
    s.write(repo / "fresh.py", "print('hi')\n")
    (repo / "owner.py").write_text("mine\n")
    view = cc.task_view(s.task)
    by_path = {f.path: f for f in view.files}
    assert sorted(by_path) == ["a.py", "fresh.py"]
    assert by_path["a.py"].removed == 8 and by_path["fresh.py"].new


# ── undoing one hunk ──


def test_undoing_a_hunk_puts_back_only_that_hunk_and_its_staged_copy(tm, tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(40)})
    s = Session(tm, repo)
    s.turn("u-1")
    s.edit(repo / "a.py", "line 5\n", "line five\n")
    s.edit(repo / "a.py", "line 30\n", "line thirty\n")
    git(repo, "add", "a.py")  # staged as well
    view = cc.task_view(s.task)
    first = view.by_number(1)
    assert cc.undo_hunk(view.repo, *first) == ""
    text = (repo / "a.py").read_text()
    assert "line 5\n" in text and "line thirty\n" in text
    staged = git(repo, "diff", "--cached")
    assert "line five" not in staged and "line thirty" in staged
    # The same hunk again: it's gone, so the view it came from has moved on.
    assert "moved on" in cc.undo_hunk(view.repo, *first)


def test_undo_never_deletes_a_new_file_or_shows_credentials(tm, tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": "x = 1\n"})
    s = Session(tm, repo)
    s.turn("u-1")
    s.write(repo / "fresh.py", "print('hi')\n")
    s.write(repo / ".env", "API_KEY=sk-live-123\n")
    view = cc.task_view(s.task)
    fresh = next(f for f in view.files if f.path == "fresh.py")
    assert "new file" in cc.undo_hunk(view.repo, fresh, fresh.hunks[0])
    assert (repo / "fresh.py").exists()
    env = next(f for f in view.files if f.path == ".env")
    assert env.sensitive and not env.hunks
    shown = cc.public(view)
    assert "sk-live" not in str(shown)


def test_undo_file_undoes_the_sessions_hunks_and_leaves_the_owners(tm, tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(40), "b.py": "b\n"})
    s = Session(tm, repo)
    s.turn("u-1")
    s.edit(repo / "a.py", "line 5\n", "line five\n")
    s.edit(repo / "a.py", "line 20\n", "line twenty\n")
    (repo / "a.py").write_text((repo / "a.py").read_text().replace("line 35\n", "owner edit\n"))
    (repo / "b.py").write_text("owner b\n")
    assert cc.undo_file(s.task, "a.py") == "Undid this session's 2 changes in a.py."
    text = (repo / "a.py").read_text()
    assert "line 5\n" in text and "line 20\n" in text and "owner edit\n" in text
    assert "None of the changes in b.py" in cc.undo_file(s.task, "b.py")
    assert (repo / "b.py").read_text() == "owner b\n"
    assert cc.undo_file(s.task, "../outside.py").endswith("has no changes to revert.")


def test_a_project_in_a_subfolder_of_its_repository(tm, tmp_path):
    repo = make_repo(tmp_path / "mono", {"app/a.py": numbered(20), "lib/b.py": "b\n"})
    s = Session(tm, repo / "app")
    s.turn("u-1")
    s.edit(repo / "app" / "a.py", "line 4\n", "line four\n")
    (repo / "lib" / "b.py").write_text("elsewhere\n")
    view = cc.task_view(s.task, "branch")
    assert [view.repo.shown(f.path) for f in view.files] == ["a.py"]  # only its folder
    shown = cc.public(cc.task_view(s.task))
    assert shown["files"][0]["path"] == "a.py"
    assert cc.undo_file(s.task, "a.py").startswith("Undid")
    assert (repo / "app" / "a.py").read_text() == numbered(20)


def test_an_isolated_copy_owns_everything_since_its_start(tm, tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(20)})
    base = git(repo, "rev-parse", "HEAD").strip()
    (repo / "a.py").write_text(numbered(20).replace("line 2\n", "committed\n"))
    git(repo, "commit", "-qam", "on the branch")
    (repo / "a.py").write_text((repo / "a.py").read_text().replace("line 15\n", "by a command\n"))
    task = ClaudeTask(id=1, prompt="x", cwd=repo)
    task.workspace = {"slug": "s", "branch": "jarvis/s", "base": base, "into": "main"}
    view = cc.task_view(task)
    assert [h.added for h in view.files[0].hunks] == [["committed"], ["by a command"]]
    # Undoing a committed change leaves it undone in the files, the index alone.
    assert cc.undo_file(task, "a.py").startswith("Undid")
    assert (repo / "a.py").read_text() == numbered(20)
    assert git(repo, "diff", "--cached") == ""


# ── what a window gets ──


def test_the_window_view_is_bounded(tm, tmp_path, monkeypatch):
    repo = make_repo(tmp_path / "p", {"a.py": numbered(3000), "b.py": numbered(50, "b")})
    s = Session(tm, repo)
    s.turn("u-1")
    s.write(repo / "a.py", numbered(3000, "new"))
    s.edit(repo / "b.py", "b 3\n", "b three\n")
    monkeypatch.setattr(cc, "MAX_HUNK_LINES", 100)
    monkeypatch.setattr(cc, "MAX_VIEW_LINES", 90)
    shown = cc.public(cc.task_view(s.task), kept={"nope"})
    big, small = shown["files"]
    assert big["path"] == "a.py" and big["omitted"] and big["hunks"] == []
    assert small["path"] == "b.py" and not small["omitted"] and small["hunks"][0]["n"] == 2
    assert shown["totals"] == {"files": 2, "added": 3001, "removed": 3001, "hunks": 2}
    one = cc.file_public(cc.task_view(s.task), "a.py")
    assert len(one["hunks"][0]["lines"]) == 100 and one["hunks"][0]["cut"] == 5900


def test_untracked_files_links_and_binaries(tm, tmp_path):
    repo = make_repo(tmp_path / "p", {"a.py": "x\n"})
    outside = tmp_path / "secret.txt"
    outside.write_text("keep out\n")
    (repo / "link.txt").symlink_to(outside)
    (repo / "blob.bin").write_bytes(b"\0\1\2" * 10)
    (repo / "notes.txt").write_text("hello\nworld")  # no newline at the end
    found = {f.path: f for f in cc.untracked_files(cc.repo_of(repo))}
    assert found["link.txt"].hunks == []  # never what it points to
    assert found["blob.bin"].binary
    notes = found["notes.txt"].hunks[0]
    assert notes.lines == [("+", "hello"), ("+", "world"), ("\\", " No newline at end of file")]
    assert cc.repo_of(tmp_path) is None
    assert cc.session_view(tmp_path, []) is None


async def test_the_hub_revert_and_explain_use_the_sessions_own_numbered_hunks(
    settings, quiet_speaker, isolated, tmp_path
):
    from test_hub import make_hub

    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    repo = make_repo(tmp_path / "proj", {"a.py": numbered(40), "b.py": numbered(40, "b")})
    task = hub.tasks.start("", "proj")
    s = Session(hub.tasks, repo, task=task)
    s.turn("u-1")
    s.edit(repo / "b.py", "b 3\n", "b three\nb three more\n")
    s.edit(repo / "a.py", "line 30\n", "line thirty\n")
    prompt = await hub.explain_change_prompt(task, 1)  # "the second change"
    assert "a.py line 30" in prompt and "+line thirty" in prompt
    task.handle.cancel()


def test_marks_resolve_each_path_once_and_keep_their_order(tmp_path, monkeypatch):
    """A long session's marks are mostly the same few files: each path is resolved once
    (each resolve looks at every folder on the way), the marks keep their order, and a mark
    outside the folder is left out, however it's written."""
    top = tmp_path / "proj"
    (top / "src").mkdir(parents=True)
    (top / "src" / "a.py").write_text("a\n")
    (top / "src" / "b.py").write_text("b\n")
    outside = tmp_path / "elsewhere.py"
    paths = ["src/a.py", str(top / "src" / "a.py"), "src/b.py", str(outside)] * 50
    marks = [
        cc.EditMark(p, f"u{i}", frozenset({f"x{i}"}), frozenset()) for i, p in enumerate(paths)
    ]
    resolved = []
    real = cc._relative
    monkeypatch.setattr(cc, "_relative", lambda raw, root: resolved.append(raw) or real(raw, root))
    by_file = cc.marks_by_file(marks, top)
    assert sorted(resolved) == sorted(set(paths))
    assert by_file == {
        "src/a.py": [m for m in marks if m.path in ("src/a.py", str(top / "src" / "a.py"))],
        "src/b.py": [m for m in marks if m.path == "src/b.py"],
    }


def test_scope_keeps_just_the_hunks_owns_says_are_the_sessions(tmp_path):
    """scope works out a file's marks once for all of its hunks: what it keeps is what owns()
    says, hunk by hunk (telling lines, "}" alone, and a rewritten file's removed lines)."""
    top = tmp_path / "proj"
    (top / "src").mkdir(parents=True)
    for name in ("a.py", "b.py", "c.py"):
        (top / "src" / name).write_text("x\n")
    hunks = [
        cc.Hunk(1, 1, 1, 1, "", [("-", "old_value = 1"), ("+", "new_value = 2")]),
        cc.Hunk(9, 1, 9, 1, "", [("-", "someone_elses = 1"), ("+", "theirs = 2")]),
        cc.Hunk(20, 1, 20, 1, "", [("+", "}")]),
        cc.Hunk(30, 1, 30, 0, "", [("-", "gone_line = 3")]),
        cc.Hunk(40, 0, 40, 1, "", [("+", "    return None")]),
    ]
    files = [cc.FileDiff(f"src/{n}", hunks=list(hunks)) for n in ("a.py", "b.py", "c.py")]
    for f in files:
        cc._stamp(f)
    marks = [
        cc.EditMark(
            "src/a.py", "u1", frozenset({"new_value = 2", "}"}), frozenset({"old_value = 1"})
        ),
        cc.EditMark("src/a.py", "u2", frozenset({"return None"}), frozenset()),
        cc.EditMark("src/b.py", "u1", frozenset({"}"}), frozenset(), whole=True),
        cc.EditMark(str(top / "src" / "b.py"), "u3", frozenset({"theirs = 2"}), frozenset()),
    ]
    kept = cc.scope(files, marks, top)
    by_file = cc.marks_by_file(marks, top)
    expected = {
        f.path: [h.id for h in f.hunks if cc.owns(h, by_file[f.path])]
        for f in files
        if f.path in by_file
    }
    assert {f.path: [h.id for h in f.hunks] for f in kept} == {
        path: ids for path, ids in expected.items() if ids
    }
    assert [h.header for h in kept[0].hunks] == [""] * len(kept[0].hunks)
    assert "src/c.py" not in {f.path for f in kept}  # no mark of the session's in it
