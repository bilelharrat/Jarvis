"""Eden Code's local API, the Changes pane's part (features/code_api.py), for the editor
extension (editors/vscode): a session's changes as the window's pane shows them (the same
hunk ids and numbers), Keep and Undo on one hunk (the window's pane kept in step), the
unchanged lines between hunks, the turns' receipts, and line comments sent to the session
as one message worded as the pane words it. Real git in temp repositories; the session's
edits go through Claude Code's tools as the manager hears them."""

from dataclasses import replace

import pytest
from test_code_api import TOKEN, client, turn_on
from test_code_changes import Session, make_repo, numbered

from jarvis.features import code_api


@pytest.fixture
def hub(settings, quiet_speaker, isolated, tmp_path):
    """A hub with the API, as test_code_api's: never listening on a real port."""
    from test_hub import make_hub

    projects = tmp_path / "projects"
    (projects / "app").mkdir(parents=True)
    hub = make_hub(replace(settings, projects_dir=projects), quiet_speaker, isolated=isolated)
    hub.events = []
    real_emit = hub.emit

    def emit(kind, **data):
        hub.events.append((kind, data))
        real_emit(kind, **data)

    hub.emit = emit
    hub.projects = projects
    lis = hub.code_api.listener

    async def start(port):  # (no real port: the requests go in-process)
        lis.port, lis.error = port, ""
        return True

    lis.start = start
    return hub


def session_with_edits(hub):
    folder = make_repo(hub.projects / "proj", {"a.py": numbered(40), ".env": "SECRET=1\n"})
    s = Session(hub.tasks, folder, task_id=5)
    task = s.task
    s.turn("u-1")
    s.edit(folder / "a.py", "line 5\n", "line five\n")
    s.edit(folder / "a.py", "line 30\n", "line thirty\n")
    return task, folder


async def test_changes_are_the_panes_own_view_with_keep_and_undo(hub):
    turn_on(hub)
    task, folder = session_with_edits(hub)
    async with client(hub) as c:
        view = (await c.get(f"/v1/sessions/{task.id}/changes?view=session")).json()
        assert view["git"] is True and view["totals"]["hunks"] == 2
        hunks = view["files"][0]["hunks"]
        assert view["files"][0]["path"] == "a.py" and [h["n"] for h in hunks] == [1, 2]
        assert ["+", "line five"] in hunks[0]["lines"]

        kept = await c.post(
            f"/v1/sessions/{task.id}/hunks", json={"hunk": hunks[1]["id"], "action": "keep"}
        )
        assert kept.status_code == 200 and kept.json()["done"] is True
        assert kept.json()["changes"]["files"][0]["hunks"][1]["kept"] is True
        assert (
            "code_kept",
            {"id": task.id, "kept": [hunks[1]["id"]]},
        ) in hub.events  # the window too

        undone = await c.post(
            f"/v1/sessions/{task.id}/hunks", json={"hunk": hunks[0]["id"], "action": "undo"}
        )
        body = undone.json()
        assert body["done"] is True and body["said"] == "Undid 1 change."
        assert body["changes"]["totals"]["hunks"] == 1
        assert (
            "line 5\n" in (folder / "a.py").read_text()
            and "line thirty" in (folder / "a.py").read_text()
        )
        assert any(k == "code_changes" for k, _ in hub.events)  # the window's pane, drawn again

        again = await c.post(
            f"/v1/sessions/{task.id}/hunks", json={"hunk": hunks[0]["id"], "action": "undo"}
        )
        assert again.json()["done"] is False and "isn't there" in again.json()["said"]
        bad = await c.post(f"/v1/sessions/{task.id}/hunks", json={"hunk": "x", "action": "delete"})
        assert bad.status_code == 400
        one = (await c.get(f"/v1/sessions/{task.id}/changes", params={"path": "a.py"})).json()
        assert one["file"]["path"] == "a.py"


async def test_lines_between_hunks_never_credentials_or_outside(hub):
    turn_on(hub)
    task, _ = session_with_edits(hub)
    async with client(hub) as c:
        got = (await c.get(f"/v1/sessions/{task.id}/lines?path=a.py&start=10&end=12")).json()
        assert got["lines"] == ["line 10", "line 11", "line 12"]
        assert (await c.get(f"/v1/sessions/{task.id}/lines?path=.env&start=1")).status_code == 404
        assert (await c.get(f"/v1/sessions/{task.id}/lines?path=../x&start=1")).status_code == 404
        assert (await c.get(f"/v1/sessions/{task.id}/lines?path=a.py&start=x")).status_code == 400


async def test_receipts_without_the_checks_picture(hub):
    turn_on(hub)
    task, _ = session_with_edits(hub)
    receipt = {"files": ["a.py"], "file_count": 1, "tests": None, "risk": "low", "why": "small",
               "check": {"status": "ok", "text": "fine", "url": "", "thumb": "data:image/png;base64,AAAA"}}  # fmt: skip
    hub.tasks._log(task, "system", "Changed 1 file. Risk: low.", receipt=receipt)
    hub.tasks._log(task, "assistant", "done")
    async with client(hub) as c:
        got = (await c.get(f"/v1/sessions/{task.id}/receipts")).json()
    assert len(got["receipts"]) == 1
    r = got["receipts"][0]
    assert r["text"].startswith("Changed 1 file") and r["receipt"]["risk"] == "low"
    assert r["receipt"]["check"] == {"status": "ok", "text": "fine", "url": ""}


async def test_comments_go_to_the_session_as_the_panes_one_message(hub, monkeypatch):
    turn_on(hub)
    task, _ = session_with_edits(hub)
    sent = []

    async def handle(msg):
        sent.append(msg)

    monkeypatch.setattr(hub, "handle", handle)
    comments = [{"path": "a.py", "line": 5, "excerpt": "line `five`", "text": "Name it five"},
                {"path": "a.py", "line": 30, "side": "o", "text": "Keep this\nline"}]  # fmt: skip
    async with client(hub) as c:
        answer = await c.post(f"/v1/sessions/{task.id}/comments", json={"comments": comments})
        assert answer.status_code == 202
        assert (
            await c.post(f"/v1/sessions/{task.id}/comments", json={"comments": []})
        ).status_code == 400
        nothing = [{"path": "a.py", "line": "5", "text": "x"}]
        assert (
            await c.post(f"/v1/sessions/{task.id}/comments", json={"comments": nothing})
        ).status_code == 400
    assert sent == [{"type": "task_send", "id": task.id, "text":
                     "Review comments:\n- a.py:5 (`line 'five'`) — Name it five\n"
                     "- a.py (removed line 30) — Keep this line"}]  # fmt: skip


def test_a_hunk_kept_or_undone_is_on_the_event_stream(hub):
    task = Session(hub.tasks, hub.projects / "app", task_id=6).task
    shape = hub.code_api.shape
    assert shape({"type": "code_kept", "id": task.id, "kept": []}) == {
        "type": "changes",
        "id": task.id,
    }
    assert shape({"type": "code_hunk_undone", "id": task.id}) == {"type": "changes", "id": task.id}
    assert shape({"type": "code_kept", "id": 999}) is None
    assert "code_kept" in code_api.STREAMED


@pytest.mark.parametrize("path", ["changes", "receipts", "lines?path=a.py"])
async def test_the_review_endpoints_need_the_token(hub, path):
    turn_on(hub)
    task, _ = session_with_edits(hub)
    async with client(hub, token="nope") as c:
        assert (await c.get(f"/v1/sessions/{task.id}/{path}")).status_code == 401
    async with client(hub) as c:
        assert (await c.get(f"/v1/sessions/999/{path}")).status_code == 404
    assert TOKEN
