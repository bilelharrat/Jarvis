"""Eden Code's Changes pane (features/code_hunks.py): a session's views (this turn, this
session, the whole branch) as the window gets them, one hunk undone or kept, the unchanged
lines between hunks unfolded, and what it says in Chinese. Real git in temp repositories;
fake Claude Code sessions."""

from dataclasses import replace

import pytest
from test_code_changes import Session, make_repo, numbered
from test_code_isolation import isolated_session, until


@pytest.fixture
def projects(tmp_path):
    folder = tmp_path / "projects"
    folder.mkdir()
    return folder


@pytest.fixture
async def hub(settings, quiet_speaker, isolated, projects):
    import asyncio

    from test_hub import make_hub

    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.events = []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    yield hub
    handles = [t.handle for t in hub.tasks.tasks.values() if t.handle and not t.handle.done()]
    for handle in handles:
        handle.cancel()
    if handles:
        await asyncio.wait(handles, timeout=5)


async def test_the_changes_views_of_a_copy_and_undo_or_keep_a_hunk(hub, projects):
    make_repo(projects / "proj", {"a.py": numbered(40)})
    task = await isolated_session(hub)
    s = Session(hub.tasks, task.cwd, task=task)
    s.turn("u-1")
    s.edit(task.cwd / "a.py", "line 5\n", "line five\n")
    (task.cwd / "a.py").write_text((task.cwd / "a.py").read_text().replace("line 30\n", "by sed\n"))
    await hub.handle({"type": "code_changes", "id": task.id, "view": "session"})
    assert await until(lambda: any(k == "code_changes" for k, _ in hub.events))
    view = [d for k, d in hub.events if k == "code_changes"][-1]
    # In its own copy, everything is the session's: the command's change too.
    assert view["workspace"]["branch"].startswith("jarvis/") and view["totals"]["hunks"] == 2
    hunks = view["files"][0]["hunks"]
    await hub.handle({"type": "code_hunk", "id": task.id, "hunk": hunks[1]["id"], "action": "keep"})
    kept = ("code_kept", {"id": task.id, "kept": [hunks[1]["id"]]})
    assert await until(lambda: kept in hub.events)
    hub.events.clear()
    await hub.handle({"type": "code_hunk", "id": task.id, "hunk": hunks[0]["id"], "action": "undo"})
    assert await until(lambda: any(k == "code_changes" for k, _ in hub.events))
    assert ("caption", {"text": "Undid 1 change."}) in hub.events
    after = [d for k, d in hub.events if k == "code_changes"][-1]
    assert after["totals"]["hunks"] == 1 and after["files"][0]["hunks"][0]["kept"]


async def test_changes_of_a_session_outside_git_list_what_it_touched(hub, projects):
    (projects / "plain").mkdir()
    task = hub.tasks.start("", "plain")
    task.files_changed.add(str(projects / "plain" / "a.py"))
    await hub.handle({"type": "code_changes", "id": task.id})
    assert await until(lambda: any(k == "code_changes" for k, _ in hub.events))
    view = [d for k, d in hub.events if k == "code_changes"][-1]
    assert view["git"] is False and view["touched"] == [str(projects / "plain" / "a.py")]


async def test_folded_lines_unfold_from_the_sessions_folder_only(hub, projects, tmp_path):
    repo = make_repo(projects / "proj", {"a.py": numbered(300), ".env": "SECRET=1\n"})
    (tmp_path / "outside.txt").write_text("not yours\n")
    task = hub.tasks.start("", "proj")
    for msg in (
        {"path": "a.py", "start": 10, "end": 12},
        {"path": "a.py", "start": 1, "end": 5000},  # at most 200 at once
        {"path": "../outside.txt", "start": 1, "end": 1},
        {"path": ".env", "start": 1, "end": 1},
        {"path": "a.py", "start": "x", "end": 2},
    ):
        await hub.handle({"type": "code_lines", "id": task.id, **msg})
    assert await until(lambda: len([k for k, _ in hub.events if k == "code_lines"]) >= 2)
    got = {d["start"]: d for k, d in hub.events if k == "code_lines"}  # (in any order)
    assert sorted(got) == [1, 10]
    assert got[10] == {
        "id": task.id,
        "path": "a.py",
        "start": 10,
        "lines": ["line 10", "line 11", "line 12"],
    }
    assert len(got[1]["lines"]) == 200
    assert (repo / ".env").exists()


async def test_what_it_says_is_in_chinese_when_the_owner_speaks_chinese(hub, projects):
    make_repo(projects / "proj", {"a.py": numbered(40)})
    hub.set_prefs({"language": "zh"})
    task = hub.tasks.start("", "proj")
    s = Session(hub.tasks, task.cwd, task=task)
    s.turn("u-1")
    s.edit(task.cwd / "a.py", "line 5\n", "line five\n")
    await hub.handle({"type": "code_changes", "id": task.id})
    assert await until(lambda: any(k == "code_changes" for k, _ in hub.events))
    hunk = [d for k, d in hub.events if k == "code_changes"][-1]["files"][0]["hunks"][0]
    await hub.handle({"type": "code_hunk", "id": task.id, "hunk": hunk["id"], "action": "undo"})
    assert await until(lambda: ("caption", {"text": "已撤销 1 处改动。"}) in hub.events)
    await hub.handle({"type": "code_hunk", "id": task.id, "hunk": hunk["id"], "action": "undo"})
    assert await until(lambda: ("caption", {"text": "那处改动已经不在了。"}) in hub.events)
