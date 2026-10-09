"""Eden Code's window commands with hostile values in them log no traceback: a number that
isn't one (infinity, NaN, null, words, a list, an object) names no session, as hub._msg_int
reads one, and a folder or file path no folder can have (a NUL in it, longer than macOS
opens, a name longer than a name can be) is refused before pathlib raises on it, as any
other folder that isn't a project is. Ordinary project folders still resolve."""

import asyncio
import logging

from test_code_voice_feature import close_all, hub_with, session

from jarvis.features.code_workspace import PATH_MAX, unopenable

ODD_NUMBERS = [None, "seven", [1], {"a": 1}, float("inf"), float("-inf"), float("nan"), 10**30]
ODD_PATHS = [
    "a\x00b",
    "/tmp/a\x00b",
    "x" * 5000,
    "/" + "y" * 5000,
    "~/" + "z" * 3000,
    "a/" * 500,  # (short names, but too long once it's in the projects folder)
    "/tmp/" + "y" * 300,  # (one name too long)
]
# The commands that read a session's id (and their other numbers: n, since, cols, rows,
# start, end, session) the way that logged OverflowError and TypeError tracebacks. Each
# names no session here, so none of them starts real work.
BY_NUMBER = [
    "code_bestof_keep", "dm_compare", "dm_refine", "dm_start", "dm_state", "dm_stop",
    "task_send", "code_git", "code_git_branch", "code_git_commit", "code_git_file",
    "code_git_hunk", "code_git_message", "code_git_push", "code_git_stage", "code_handoff",
    "code_handoff_back", "code_handoff_forget", "code_handoff_stop", "code_changes",
    "code_hunk", "code_lines", "code_limit", "code_pr", "code_pr_comment", "code_pr_draft",
    "code_pr_draft_drop", "code_pr_fix", "code_pr_forget", "code_pr_log", "code_pr_merge",
    "code_pr_open", "code_pr_push", "code_pr_refresh", "code_pr_resolve", "code_pr_set",
    "code_qa", "code_review", "code_review_dismiss", "code_review_fix", "code_review_state",
    "sec_list", "sec_remove", "code_btw", "code_draft", "code_goal", "code_meta_set",
    "code_rewind", "code_session_open", "cw_term_resize", "cv_problems", "cv_save",
    "cv_state", "cv_tests", "cv_logs", "cv_check", "cv_fix_check", "cv_session",
    "vp_record", "vp_state", "code_voice_seen", "cw_export", "cw_file_compare",
    "cw_file_read", "cw_file_save", "cw_file_stat", "cw_health", "cw_media", "cw_open_in",
    "cw_reconnect", "cw_search", "cw_symbols", "cw_term_new", "cw_terms", "code_lesson_add",
    "code_copy", "code_copies",
]  # fmt: skip
# The commands that take a project folder (directory) or a file (path).
BY_PATH = [
    "cv_problems", "cv_state", "cv_tests", "cw_file_compare", "cw_file_read",
    "cw_file_save", "cw_file_stat", "cw_open_in", "cw_search", "cw_symbols", "cw_term_new",
    "cw_terms", "file_open", "file_read", "project_files", "project_git", "slash_list",
    "task_new", "code_goal_new", "code_git", "cw_export_reveal",
]  # fmt: skip
NUMBERS = ("id", "n", "since", "cols", "rows", "start", "end", "session")


def running(hub):
    """The background work under way: the hub's, and the features' own."""
    owners = [hub, hub.code_workspace, hub.code_verify, hub.code_design]
    return {
        t
        for owner in owners
        for t in (getattr(owner, "_background", None) or getattr(owner, "_tasks", ()))
        if not t.done()
    }


async def settled(hub, before):
    """The background work the commands started (not what ran before them) done."""
    for _ in range(200):
        pending = running(hub) - before
        if not pending:
            return
        await asyncio.wait(pending, timeout=0.05)
    raise AssertionError(f"still running: {pending}")


def tracebacks(caplog):
    return [r for r in caplog.records if r.exc_info]


async def test_odd_numbers_in_jarvis_code_commands_log_no_traceback(
    settings, quiet_speaker, isolated, tmp_path, caplog
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    task = session(hub, "proj", "Add a retry")
    caplog.set_level(logging.WARNING)
    for kind in BY_NUMBER:
        before = running(hub)
        for odd in ODD_NUMBERS:
            await hub.handle({"type": kind, **dict.fromkeys(NUMBERS, odd)})
        await settled(hub, before)
        assert tracebacks(caplog) == [], kind
    # A real session's, with the command's other numbers odd (only commands that then do
    # nothing more than read: a session's id given to the rest would start real work).
    before = running(hub)
    for odd in ODD_NUMBERS:
        await hub.handle({"type": "code_lines", "id": task.id, "path": "a.py", "start": odd})
        await hub.handle({"type": "code_lines", "id": task.id, "path": "a.py", "end": odd})
        await hub.handle({"type": "cw_media", "id": task.id, "keys": odd})
        await hub.handle({"type": "cw_term_resize", "term": "none", "cols": odd, "rows": 9})
        await hub.handle({"type": "code_bestof_keep", "group": "none", "n": odd})
    await settled(hub, before)
    assert tracebacks(caplog) == []
    assert not hub._command_failures
    close_all(hub)


async def test_paths_no_folder_can_have_are_refused_without_a_traceback(
    settings, quiet_speaker, isolated, tmp_path, caplog
):
    hub, _ = await hub_with(settings, quiet_speaker, isolated, tmp_path, "proj")
    seen = hub.subscribe()
    caplog.set_level(logging.WARNING)
    for kind in BY_PATH:
        before = running(hub)
        for odd in ODD_PATHS:
            await hub.handle({"type": kind, "directory": odd, "path": odd, "prompt": "hi"})
        await settled(hub, before)
        assert tracebacks(caplog) == [], kind
    assert not hub._command_failures
    # Refused as any other folder that isn't a project is: the panes say so.
    errors = []
    while not seen.empty():
        event = seen.get_nowait()
        if event["type"] == "cv_error":
            errors.append(event["text"])
    assert errors and all(e.startswith("No project folder called") for e in errors)
    # An ordinary project still opens, by name and by its path.
    assert hub.tasks.resolve_dir("proj") == (tmp_path / "proj").resolve()
    assert hub.tasks.resolve_dir(str(tmp_path / "proj")) == (tmp_path / "proj").resolve()
    close_all(hub)


def test_unopenable_is_only_what_no_folder_can_have(tmp_path):
    assert not unopenable(str(tmp_path))
    assert not unopenable("~/Projects/jarvis")
    assert not unopenable("/" + "/".join(["n" * 255] * 3))  # (long names, each one allowed)
    longest = "/" + "/".join(["a" * 203] * 4 + ["a" * 207])  # (PATH_MAX characters in all)
    assert len(longest) == PATH_MAX and not unopenable(longest)
    assert unopenable(longest + "a")
    assert unopenable("/tmp/" + "n" * 256)
    assert unopenable("proj\x00/x")
    assert unopenable("~/" + "z/" * 600)  # (too long once ~ is the home folder)
