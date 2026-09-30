"""The Jarvis Code workspace feature (features/code_workspace.py), through the hub's window
commands: pictures from Claude Code's record for the transcript."""

import asyncio

import pytest
from code_session_fakes import make_hub

from jarvis.tasks import ClaudeTask

SID = "0f5d8c1e-7a41-4b8e-9d6b-2f1a3c4e5b6d"


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    return make_hub(settings, quiet_speaker, isolated)


def record(hub):
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    return seen


async def settle(seen, kind, n=1):
    for _ in range(400):
        if sum(k == kind for k, _ in seen) >= n:
            return [d for k, d in seen if k == kind]
        await asyncio.sleep(0.005)
    raise AssertionError(f"no {kind}: {seen}")


def session(hub, tmp_path, sid=SID):
    task = ClaudeTask(id=7, prompt="", cwd=tmp_path, session_id=sid)
    hub.tasks.tasks[task.id] = task
    return task


async def test_pictures_come_from_the_session_s_record_by_entry(hub, tmp_path):
    session(hub, tmp_path)
    asked = []

    def pictures(sid, cwd, keys):
        asked.append((sid, cwd, keys))
        return {"u-1": [{"media_type": "image/png", "data": "AAAA"}]}

    hub.code_workspace.media.pictures = pictures
    seen = record(hub)
    await hub.handle({"type": "cw_media", "id": 7, "keys": ["u-1", "t-2", 5], "ref": "big-1"})
    (reply,) = await settle(seen, "cw_media")
    assert asked == [(SID, tmp_path, ["u-1", "t-2"])]
    assert reply == {
        "id": 7,
        "keys": ["u-1", "t-2"],
        "items": {"u-1": [{"media_type": "image/png", "data": "AAAA"}]},
        "ref": "big-1",
    }


async def test_no_pictures_for_an_unknown_session_or_one_never_connected(hub, tmp_path):
    session(hub, tmp_path, sid="")
    hub.code_workspace.media.pictures = lambda *a: pytest.fail("the record was read")
    seen = record(hub)
    await hub.handle({"type": "cw_media", "id": 7, "keys": ["u-1"]})
    await hub.handle({"type": "cw_media", "id": 99, "keys": ["u-1"]})
    await hub.handle({"type": "cw_media", "id": "x", "keys": ["u-1"]})
    replies = await settle(seen, "cw_media", 3)
    assert [r["items"] for r in replies] == [{}, {}, {}]
    assert [r["id"] for r in replies] == [7, 0, 0]


# ── files: read, saved over their version, compared, opened elsewhere ──


def demo(tmp_path):
    root = tmp_path / "demo"
    (root / "src").mkdir(parents=True)
    (root / "src" / "app.py").write_text("a\nb\nc\n")
    return root


async def test_a_file_is_read_saved_and_a_conflict_compared_through_the_window(hub, tmp_path):
    root = demo(tmp_path)
    seen = record(hub)
    await hub.handle(
        {"type": "cw_file_read", "directory": "demo", "path": "src/app.py", "ref": "k1"}
    )
    (got,) = await settle(seen, "cw_file")
    assert got["text"] == "a\nb\nc\n" and got["ref"] == "k1" and got["path"] == "src/app.py"
    base = got["version"]
    await hub.handle(
        {
            "type": "cw_file_save",
            "directory": "demo",
            "path": "src/app.py",
            "text": "a\nB\nc\n",
            "base": base,
            "ref": "k1",
        }
    )
    (saved,) = await settle(seen, "cw_file_saved")
    assert saved["ok"] and (root / "src" / "app.py").read_text() == "a\nB\nc\n"
    # Claude changes it; the window's next save is a conflict, and the stat says so too.
    (root / "src" / "app.py").write_text("a\nb\nclaude\n")
    await hub.handle(
        {
            "type": "cw_file_stat",
            "directory": "demo",
            "path": "src/app.py",
            "base": saved["version"],
            "ref": "k1",
        }
    )
    (stat,) = await settle(seen, "cw_file_stat")
    assert stat["changed"] and not stat["missing"]
    await hub.handle(
        {
            "type": "cw_file_save",
            "directory": "demo",
            "path": "src/app.py",
            "text": "mine\n",
            "base": saved["version"],
            "ref": "k1",
        }
    )
    clash = (await settle(seen, "cw_file_saved", 2))[-1]
    assert clash["conflict"] and "disk_text" not in clash and "ok" not in clash
    await hub.handle(
        {
            "type": "cw_file_compare",
            "directory": "demo",
            "path": "src/app.py",
            "text": "a\nb\nmine\n",
            "ref": "k1",
        }
    )
    (diff,) = await settle(seen, "cw_file_compare")
    assert diff["hunks"] == [
        {"old_start": 1, "old_count": 4, "new_start": 1, "new_count": 4,
         "lines": [[" ", "a"], [" ", "b"], ["-", "claude"], ["+", "mine"], [" ", ""]]}
    ]  # fmt: skip
    assert (root / "src" / "app.py").read_text() == "a\nb\nclaude\n"


async def test_a_session_s_files_are_its_own_folder_and_nothing_outside_a_project(hub, tmp_path):
    root = demo(tmp_path)
    task = ClaudeTask(id=7, prompt="", cwd=root)
    hub.tasks.tasks[7] = task
    seen = record(hub)
    await hub.handle({"type": "cw_file_read", "id": 7, "path": "src/app.py", "ref": "k"})
    await hub.handle({"type": "cw_file_read", "directory": "/etc", "path": "hosts", "ref": "k2"})
    await hub.handle({"type": "cw_file_read", "id": 7, "path": "../../etc/hosts", "ref": "k3"})
    got = await settle(seen, "cw_file", 3)
    by = {g["ref"]: g for g in got}
    assert by["k"]["text"] == "a\nb\nc\n"
    assert "error" in by["k2"] and "error" in by["k3"]


async def test_open_in_an_editor_runs_its_command_for_a_project_file_only(
    hub, tmp_path, monkeypatch
):
    from jarvis import mac_tools

    root = demo(tmp_path)
    ran = []

    async def run(*args, timeout=30):
        ran.append(list(args))
        return ""

    monkeypatch.setattr(mac_tools, "run_command", run)
    editor = {"id": "vscode", "name": "VS Code", "bundle": "com.microsoft.VSCode"}
    hub.code_workspace.editors.find = lambda: [editor]
    seen = record(hub)
    await hub.handle({"type": "cw_editors"})
    (listed,) = await settle(seen, "cw_editors")
    assert listed["items"] == [{"id": "vscode", "name": "VS Code"}]
    await hub.handle(
        {
            "type": "cw_open_in",
            "directory": "demo",
            "editor": "vscode",
            "path": "src/app.py",
            "line": 2,
        }
    )
    await hub.handle({"type": "cw_open_in", "directory": "demo", "editor": "vscode", "path": ""})
    await hub.handle(
        {"type": "cw_open_in", "directory": "demo", "editor": "finder", "path": "src/app.py"}
    )
    await hub.handle(
        {"type": "cw_open_in", "directory": "demo", "editor": "emacs", "path": "src/app.py"}
    )
    await hub.handle(
        {"type": "cw_open_in", "directory": "demo", "editor": "vscode", "path": "../x"}
    )
    await hub.handle(
        {"type": "cw_open_in", "directory": "demo", "editor": "app", "path": "src/app.py"}
    )
    for _ in range(400):
        if len(ran) >= 4 and sum(k == "caption" for k, _ in seen) >= 2:
            break
        await asyncio.sleep(0.005)
    app = root.resolve() / "src" / "app.py"
    # (each command runs in the background: they finish in any order)
    assert sorted(ran) == sorted(
        [
            ["open", f"vscode://file{app}:2:1"],
            ["open", "-b", "com.microsoft.VSCode", str(root.resolve())],
            ["open", "-R", str(app)],
            ["open", str(app)],
        ]
    )
    captions = sorted(d["text"] for k, d in seen if k == "caption")
    assert captions == ["That editor isn't on this Mac.", "That's outside the project."]


async def test_what_the_caption_says_is_in_the_owner_s_language(hub, tmp_path, monkeypatch):
    from jarvis import mac_tools

    demo(tmp_path)

    async def fail(*args, timeout=30):
        raise mac_tools.ToolFailure("no such app")

    monkeypatch.setattr(mac_tools, "run_command", fail)
    hub.code_workspace.editors.find = lambda: []  # (never the real Mac's apps)
    hub.prefs.language = "zh"  # (not set_prefs: that voices the fillers with the Mac's say)
    seen = record(hub)
    await hub.handle({"type": "cw_open_in", "directory": "demo", "editor": "zed", "path": ""})
    await hub.handle({"type": "cw_open_in", "directory": "demo", "editor": "app", "path": "../x"})
    await hub.handle(
        {"type": "cw_open_in", "directory": "demo", "editor": "app", "path": "src/app.py"}
    )
    for _ in range(400):
        if sum(k == "caption" for k, _ in seen) >= 3:
            break
        await asyncio.sleep(0.005)
    captions = sorted(d["text"] for k, d in seen if k == "caption")
    assert captions == sorted(
        ["这台 Mac 上没有那个编辑器。", "那在项目之外。", "没能打开：no such app"]
    )
