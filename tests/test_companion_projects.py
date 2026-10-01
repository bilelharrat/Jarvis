"""The Mac's Projects from the phone (companion_projects.py)."""

from __future__ import annotations

from test_companion_api import api  # noqa: F401 (the fixture)

from jarvis.features.chat_projects import ChatProjects

SID = "11111111-2222-3333-4444-555555555555"


def desk(api, tmp_path):  # noqa: F811
    api.hub.chat_projects = ChatProjects(api.hub, folder=tmp_path / "projects")
    return api.hub.chat_projects


def test_made_filed_and_listed_from_the_phone(api, tmp_path):  # noqa: F811
    d = desk(api, tmp_path)
    made = api.post("/api/projects/save", {"name": "Trip", "instructions": "Be brief."}).json()
    pid = made["id"]
    assert made["ok"] is True and made["active"] == pid
    assert made["items"][0]["name"] == "Trip"
    filed = api.post("/api/projects/file", {"id": pid, "name": "plan.md", "text": "Day 1: Alfama"})
    assert filed.json()["items"][0]["files"][0]["name"] == "plan.md"
    bad = api.post("/api/projects/file", {"id": pid, "name": "x.txt", "text": ""})
    assert bad.status_code == 400 and bad.json()["error"]
    api.post("/api/projects/assign", {"session_id": SID, "id": pid})
    listing = api.get("/api/projects").json()
    assert listing["items"][0]["conversations"][0]["session_id"] == SID
    api.post("/api/projects/unfile", {"id": pid, "name": "plan.md"})
    assert d.find(pid)["files"] == []
    assert api.post("/api/projects/use", {"id": ""}).json()["active"] == ""
    api.post("/api/projects/delete", {"id": pid})
    assert api.get("/api/projects").json()["items"] == []


def test_a_project_needs_a_name(api, tmp_path):  # noqa: F811
    desk(api, tmp_path)
    assert api.post("/api/projects/save", {"name": "  "}).status_code == 400


def test_without_the_feature(api):  # noqa: F811
    api.hub.chat_projects = None
    assert api.get("/api/projects").json()["items"] == []
    assert api.post("/api/projects/save", {"name": "x"}).status_code == 404
