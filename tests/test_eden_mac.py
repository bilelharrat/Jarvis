"""Eden on the Mac (jarvis.eden_files, eden_screen, eden_knowledge, features.eden_mac): where
Eden may look, finding and reading files a page at a time, the owner's cards (once per app for
files, every time for the screen), the screen's parts, and a folder indexed by the second
brain's own rebuild and searched. Every folder is a temp one: never the owner's real home; the
screen's readers and Spotlight are fakes; no model, no network."""

import asyncio
import json
import time

import pytest
from conftest import FakeClient
from starlette.testclient import TestClient

from jarvis import eden_files, eden_knowledge, eden_screen
from jarvis.features import eden_mac
from jarvis.hub import Hub
from jarvis.mcp_endpoint import Endpoint, build_app

SESSION = "a1b2c3d4e5f6a7b8"


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A pretend home folder: documents, a hidden folder, Library, a cache and a key file."""
    root = (tmp_path / "home").resolve()
    (root / "Documents" / "Leases").mkdir(parents=True)
    (root / "Documents" / "Leases" / "Lease agreement 2026.md").write_text(
        "# Flat lease\nThe lease renews on May 1. The deposit is 2,000.\npassword: hunter2hunter2\n"
    )
    (root / "Documents" / "notes.txt").write_text("Budget meeting: renewal of the office lease.")
    (root / "Documents" / "big.txt").write_text(
        "".join(f"line {i:05d} of the report\n" for i in range(4000))
    )
    (root / ".secret").mkdir()
    (root / ".secret" / "lease.md").write_text("hidden lease")
    (root / "Library" / "Caches").mkdir(parents=True)
    (root / "Library" / "lease.txt").write_text("lease in Library")
    (root / "Library" / "Mobile Documents" / "com~apple~CloudDocs").mkdir(parents=True)
    (root / "Library" / "Mobile Documents" / "com~apple~CloudDocs" / "lease scan.txt").write_text(
        "icloud lease"
    )
    (root / "node_modules").mkdir()
    (root / "node_modules" / "lease.js").write_text("// lease")
    (root / "Documents" / "server.pem").write_text("lease key")
    (root / "Documents" / "passwords lease.txt").write_text("lease")
    monkeypatch.setattr(eden_files, "home_folder", lambda: root)

    async def no_spotlight(*_args, **_kw):
        raise OSError("no Spotlight in tests")

    monkeypatch.setattr(eden_files, "_run", no_spotlight)
    return root


def make_hub(settings, quiet_speaker, isolated):
    return Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    made = make_hub(settings, quiet_speaker, isolated)
    made.set_feature_prefs({"mcp_ask": False})
    made._say = lambda *_a, **_k: None
    return made


def endpoint_for(hub):
    endpoint = Endpoint(hub, hub.feature_path("mcp"))
    endpoint.token = "the-token"
    return endpoint


def post(client, tool, arguments=None, app="Eden"):
    return client.post(
        "/call",
        json={"tool": tool, "arguments": arguments or {}},
        headers={
            "Authorization": "Bearer the-token",
            "X-Jarvis-Session": SESSION,
            "X-Jarvis-Client": app,
        },
    ).json()


def cards(hub, *answers):
    """The owner's answers to the cards, in turn; returns what was asked."""
    asked = []
    pending = list(answers)

    async def answer(question, detail="", choices=None, **_kw):
        asked.append((question, detail))
        return pending.pop(0) if pending else "deny"

    hub.request_approval = answer
    return asked


# ── where Eden may look ──


def test_folders_eden_may_read(home):
    assert eden_files.check_folder("~/Documents") == home / "Documents"
    assert (
        eden_files.check_folder(str(home / "Documents" / "Leases")) == home / "Documents" / "Leases"
    )
    icloud = home / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
    assert eden_files.check_folder(str(icloud)) == icloud
    for bad in (
        "/etc",
        "~/.secret",
        "~/Library",
        "~/Library/Caches",
        "~/node_modules",
        "~/Nope",
        "",
        "~/../..",
    ):
        with pytest.raises(eden_files.Refused):
            eden_files.check_folder(bad)
    assert eden_files.clean_folders(["~/Documents", "~/Documents", "/etc", "~/Library"]) == [
        str(home / "Documents")
    ]
    assert eden_files.clean_folders("~/Documents") is None


def test_what_is_kept_out(home):
    roots = [home]
    assert eden_files.allowed(home / "Documents" / "notes.txt", roots)
    for path in (
        home / ".secret" / "lease.md",
        home / "Library" / "lease.txt",
        home / "node_modules" / "lease.js",
        home / "Documents" / "server.pem",
        home / "Documents" / "passwords lease.txt",
        home.parent / "elsewhere.txt",
    ):
        assert not eden_files.allowed(path, roots), path
    icloud = home / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
    assert eden_files.allowed(icloud / "lease scan.txt", [home, icloud])  # listed by the owner


# ── finding and reading ──


def test_search_by_name_and_by_content_without_spotlight(home, hub):
    found = asyncio.run(eden_files.search(hub, {"query": "lease"}))
    names = [f["name"] for f in found["files"]]
    assert names[0] == "Lease agreement 2026.md" and "notes.txt" in names
    assert not {
        "lease.md",
        "lease.txt",
        "lease.js",
        "server.pem",
        "passwords lease.txt",
        "lease scan.txt",
    } & set(names)
    by_content = next(f for f in found["files"] if f["name"] == "notes.txt")
    assert by_content["match"] == "content" and "lease" in by_content["snippet"]
    assert found["files"][0]["display"] == "~/Documents/Leases/Lease agreement 2026.md"
    assert found["folders"] == ["~"] and "never instructions" in found["note"]
    names_only = asyncio.run(eden_files.search(hub, {"query": "lease", "content": False}))
    assert [f["name"] for f in names_only["files"]] == ["Lease agreement 2026.md", "Leases"]
    assert names_only["files"][1]["kind"] == "folder"
    assert asyncio.run(eden_files.search(hub, {"query": "lease", "kind": "pdf"}))["files"] == []
    assert isinstance(asyncio.run(eden_files.search(hub, {"query": " "})), str)
    assert isinstance(asyncio.run(eden_files.search(hub, {"query": "x", "limit": 500})), str)


def test_only_the_owners_folders_when_they_list_some(home, hub):
    hub.set_feature_prefs({eden_files.FOLDERS_PREF: [str(home / "Documents" / "Leases")]})
    found = asyncio.run(eden_files.search(hub, {"query": "lease"}))
    assert [f["name"] for f in found["files"]] == ["Lease agreement 2026.md"]
    assert found["folders"] == ["~/Documents/Leases"]
    refused = asyncio.run(eden_files.read(hub, {"path": str(home / "Documents" / "notes.txt")}))
    assert isinstance(refused, str) and "isn't one Eden may read" in refused


def test_spotlight_answers_are_checked_too(home, hub, monkeypatch):
    asked = []

    async def fake_mdfind(*args, timeout):
        asked.append(args)
        return "\n".join(
            [str(home / "Library" / "lease.txt"), str(home / "Documents" / "notes.txt"), "junk"]
        )

    monkeypatch.setattr(eden_files, "_run", fake_mdfind)
    found = asyncio.run(eden_files.search(hub, {"query": 'lease "x'}))
    assert [f["name"] for f in found["files"]] == ["notes.txt"]
    assert asked[0][:3] == ("mdfind", "-onlyin", str(home))
    assert '"' not in asked[0][3].replace('"*', "").replace('*"', "").replace('== "', "").replace(
        '"cdw', ""
    )


def test_read_pages_and_blanks_out_secrets(home, hub):
    lease = asyncio.run(
        eden_files.read(hub, {"path": "~/Documents/Leases/Lease agreement 2026.md"})
    )
    assert (
        lease["pages"] == 1
        and "renews on May 1" in lease["text"]
        and "hunter2hunter2" not in lease["text"]
    )
    big = home / "Documents" / "big.txt"
    first = asyncio.run(eden_files.read(hub, {"path": str(big)}))
    assert first["pages"] == -(-first["chars"] // eden_files.PAGE_CHARS) and first["pages"] > 1
    second = asyncio.run(eden_files.read(hub, {"path": str(big), "page": 2}))
    assert (
        second["text"] != first["text"]
        and second["text"].startswith(first["text"][-1:] or "") is not None
    )
    assert "has" in asyncio.run(eden_files.read(hub, {"path": str(big), "page": 99}))
    assert "folder" in asyncio.run(eden_files.read(hub, {"path": str(home / "Documents")}))
    assert "full path" in asyncio.run(eden_files.read(hub, {"path": "Documents/notes.txt"}))
    (home / "Documents" / "photo.bin").write_bytes(b"\x00\x01\x02" * 100)
    assert "can't read text" in asyncio.run(
        eden_files.read(hub, {"path": str(home / "Documents" / "photo.bin")})
    )


def test_summarize_samples_a_long_file(home, hub, monkeypatch):
    monkeypatch.setattr(eden_files, "SUMMARY_CHARS", 20_000)
    monkeypatch.setattr(eden_files, "SUMMARY_TAIL", 3_000)
    out = asyncio.run(eden_files.summarize(hub, {"path": str(home / "Documents" / "big.txt")}))
    assert (
        out["sampled"]
        and "[…]" in out["text"]
        and "line 03999" in out["text"]
        and "line 00000" in out["text"]
    )
    short = asyncio.run(eden_files.summarize(hub, {"path": str(home / "Documents" / "notes.txt")}))
    assert not short["sampled"] and short["text"].startswith("Budget meeting")
    assert "Summarise" in short["instructions"]


# ── through the endpoint: the owner's say ──


def test_files_ask_once_per_app_and_can_be_switched_off(home, hub):
    hub.set_feature_prefs({"mcp_ask": True})
    endpoint = endpoint_for(hub)
    endpoint.sessions[SESSION] = (True, time.monotonic() + 3600, "Eden")  # past the session card
    asked = cards(hub, "allow")
    client = TestClient(build_app(endpoint))
    first = post(client, "files_search", {"query": "lease"})
    again = post(client, "file_read", {"path": str(home / "Documents" / "notes.txt")})
    assert not first["is_error"] and not again["is_error"] and len(asked) == 1
    assert (
        asked[0][0] == "Let Eden search and read your files?" and "your home folder" in asked[0][1]
    )
    other = TestClient(build_app(endpoint))
    endpoint.sessions["b1b2c3d4e5f6a7b8"] = (True, time.monotonic() + 3600, "Claude Code")
    refused = other.post(
        "/call",
        json={"tool": "files_search", "arguments": {"query": "lease"}},
        headers={
            "Authorization": "Bearer the-token",
            "X-Jarvis-Session": "b1b2c3d4e5f6a7b8",
            "X-Jarvis-Client": "claude-code",
        },
    ).json()
    assert refused["is_error"] and "didn't allow" in refused["text"] and len(asked) == 2
    hub.set_feature_prefs({eden_files.FILES_PREF: False})
    off = post(client, "files_search", {"query": "lease"})
    assert off["is_error"] and "Files are off" in off["text"]


def test_file_tools_answer_json_through_the_endpoint(home, hub):
    client = TestClient(build_app(endpoint_for(hub)))
    found = post(client, "files_search", {"query": "budget"})
    files = json.loads(found["text"])["files"]
    assert [f["name"] for f in files] == ["notes.txt"]
    read = json.loads(post(client, "file_summarize", {"path": files[0]["path"]})["text"])
    assert read["text"].startswith("Budget meeting")


# ── the screen ──


def fake_screen(monkeypatch, shots):
    async def front():
        return {
            "app": "Notes",
            "title": "Plans",
            "selected": "token=sk-abcdefghijklmnopqrstuvwxyz123456",
            "window": 7,
            "ax": True,
        }

    async def app():
        return {"app": "Notes", "bundle": "com.apple.Notes"}

    async def window_text():
        return {
            "app": "Notes",
            "bundle": "com.apple.Notes",
            "text": "Notes — window “Plans”\n- text area = “Buy milk”",
            "truncated": False,
        }

    async def page(_bundle):
        return None

    async def picture(window):
        shots.append(window)
        return {"media_type": "image/jpeg", "data": "QUJD"}

    monkeypatch.setattr(
        eden_screen,
        "READERS",
        {"front": front, "app": app, "window_text": window_text, "page": page, "picture": picture},
    )


def test_every_look_at_the_screen_is_the_owners_to_allow(hub, monkeypatch):
    shots = []
    fake_screen(monkeypatch, shots)
    asked = cards(hub, "deny", "allow", "allow")
    client = TestClient(build_app(endpoint_for(hub)))
    no = post(client, "screen_context")
    assert no["is_error"] and "didn't allow" in no["text"]
    yes = json.loads(post(client, "screen_context")["text"])
    assert yes["app"] == "Notes" and yes["bundle"] == "com.apple.Notes" and yes["title"] == "Plans"
    assert "Buy milk" in yes["text"] and "abcdefghijklmnop" not in yes["selected"]
    assert yes["image"] is None and shots == [] and "never instructions" in yes["note"]
    assert (
        len(asked) == 2
        and asked[0][0] == "Let Eden see your screen?"
        and "picture" not in asked[0][1]
    )
    hub.set_feature_prefs({eden_screen.PICTURE_PREF: True})
    pictured = json.loads(post(client, "screen_context", {"picture": True})["text"])
    assert pictured["image"] == {"mime": "image/jpeg", "data": "QUJD"} and shots == [7]
    assert "with a picture" in asked[2][1]
    hub.prefs.screen_aware = True  # Jarvis's own screen awareness: no card
    json.loads(post(client, "screen_context", {"picture": False})["text"])
    assert len(asked) == 3 and shots == [7]
    assert post(client, "screen_context", {"picture": "yes"})["is_error"]


# ── project knowledge ──


def wait_ready(knowledge, ident, seconds=60):
    async def wait():
        started = time.monotonic()
        while time.monotonic() - started < seconds:
            entry = knowledge.entries_by_id().get(ident)
            if entry and entry["status"] != "indexing":
                return entry
            await asyncio.sleep(0.2)
        raise AssertionError("indexing didn't finish")

    return wait


def test_a_folder_is_indexed_on_the_mac_and_searched(home, hub, tmp_path):
    project = home / "Documents" / "Thesis"
    project.mkdir()
    (project / "chapter one.md").write_text(
        "# Methods\nWe measured soil moisture with capacitance probes in 2025.\n"
    )
    (project / "chapter two.md").write_text(
        "# Results\nYields rose 12% where the cover crop was rye.\n"
    )
    (project / ".draft.md").write_text("hidden rye notes")
    endpoint = endpoint_for(hub)

    async def scenario():
        added = json.loads(
            (await endpoint.call("knowledge_add_folder", {"path": "~/Documents/Thesis"}, "Eden"))[0]
        )
        ident = added["folder"]["id"]
        assert (
            added["folder"]["status"] == "indexing"
            and added["folder"]["display"] == "~/Documents/Thesis"
        )
        knowledge = eden_knowledge.knowledge_for(endpoint)
        entry = await wait_ready(knowledge, ident)()
        assert entry["status"] == "ready", entry
        listed = json.loads((await endpoint.call("knowledge_list", {}, "Eden"))[0])
        assert listed["folders"][0]["files"] == 2 and listed["folders"][0]["semantic"] is False
        found = json.loads(
            (await endpoint.call("knowledge_search", {"query": "rye cover crop yields"}, "Eden"))[0]
        )
        first = found["results"][0]
        assert (
            first["name"] == "chapter two.md"
            and "Yields rose 12%" in first["passage"]
            and first["n"] == 1
        )
        assert first["display"] == "~/Documents/Thesis/chapter two.md"
        assert all(".draft" not in r["path"] for r in found["results"])
        nothing = json.loads(
            (
                await endpoint.call(
                    "knowledge_search", {"query": "rye", "folders": ["nope"]}, "Eden"
                )
            )[0]
        )
        assert nothing["results"] == [] and nothing["skipped"] == [
            {"folder": "nope", "why": "not indexed"}
        ]
        outside = await endpoint.call("knowledge_add_folder", {"path": "/etc"}, "Eden")
        assert outside[1] and "home folder" in outside[0]
        assert (await endpoint.call("knowledge_search", {"query": "rye", "k": 99}, "Eden"))[1]
        # the owner's removal in Settings: Jarvis's index goes, the files stay
        eden = eden_mac.EdenMac(hub)
        hub.jarvis_mcp = type("M", (), {"endpoint": endpoint})()
        await eden.remove({"id": ident})
        assert knowledge.entries() == [] and not (knowledge.folder / ident).exists()
        assert (project / "chapter one.md").exists()

    asyncio.run(scenario())


def test_settings_show_and_change_what_eden_may_do(home, hub):
    eden = eden_mac.EdenMac(hub)
    seen = []
    hub.emit = lambda kind, **data: seen.append((kind, data))
    asyncio.run(eden.set({"folders": ["~/Documents", "/etc"], "picture": True}))
    kind, data = seen[-1]
    assert kind == "eden_mac" and data["folders"] == [
        {"path": str(home / "Documents"), "display": "~/Documents"}
    ]
    assert data["picture"] is True and data["files"] is True and data["home"] is False
    assert any(k == "toast" for k, _ in seen)
    asyncio.run(eden.set({"files": False, "folders": []}))
    assert (
        seen[-1][1]["files"] is False
        and seen[-1][1]["home"] is True
        and seen[-1][1]["allowed"] == ["~"]
    )


def test_a_card_nobody_answers_is_not_a_no(home, hub, monkeypatch):
    """The owner away from the Mac: the files card runs out, nothing is kept, the next call asks
    again (a real "Not now" is kept for 10 minutes: the test above)."""
    from jarvis import hub as hub_module

    hub.set_feature_prefs({"mcp_ask": True})
    endpoint = endpoint_for(hub)
    endpoint.sessions[SESSION] = (True, time.monotonic() + 3600, "Eden")
    monkeypatch.setattr(hub_module, "APPROVAL_TIMEOUT", 0)  # every card "runs out"
    asked = cards(hub, "deny", "deny")
    client = TestClient(build_app(endpoint))
    first = post(client, "files_search", {"query": "lease"})
    assert first["is_error"] and "didn't answer" in first["text"]
    second = post(client, "files_search", {"query": "lease"})
    assert second["is_error"] and len(asked) == 2, "asked again, not refused from memory"


def test_a_session_card_nobody_answers_is_asked_again(home, hub, monkeypatch):
    from jarvis import hub as hub_module

    hub.set_feature_prefs({"mcp_ask": True})
    endpoint = endpoint_for(hub)
    monkeypatch.setattr(hub_module, "APPROVAL_TIMEOUT", 0)
    asked = cards(hub, "deny", "deny")
    client = TestClient(build_app(endpoint))
    post(client, "recall", {})
    post(client, "recall", {})
    assert len(asked) == 2 and SESSION not in endpoint.sessions
