"""Eden Code's artifacts (features/code_artifacts.py), wired into a real hub: a session makes
one with create_artifact and changes it with update_artifact (whole, or one exact piece), each
version kept, carded in the transcript and announced to the window; the window reads a version
back (art_get); it's shown from this Mac only, sandboxed, and only by an id nobody could guess."""

import types

import pytest
from conftest import FakeClient

from jarvis.features import code_artifacts
from jarvis.hub import Hub
from jarvis.tasks import ClaudeTask

PAGE = "<!doctype html><html><body><h1>Shop</h1><button>Buy</button></body></html>"


@pytest.fixture
def hub(settings, quiet_speaker, isolated, tmp_path):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub.code_artifacts.home = tmp_path / "code-artifacts"
    folder = settings.projects_dir / "shop"
    folder.mkdir()
    hub.tasks.tasks[8] = ClaudeTask(id=8, prompt="x", cwd=folder.resolve())
    return hub


def drain(queue, kind):
    out = []
    while not queue.empty():
        ev = queue.get_nowait()
        if ev["type"] == kind:
            out.append(ev)
    return out


def text(result):
    return result["content"][0]["text"]


def made_id(result):
    return text(result).split()[2]


class Request:
    def __init__(self, aid, version="1", host=None):
        self.path_params = {"aid": aid, "version": version}
        self.scope = {"server": ("127.0.0.1", 8765)}
        self.headers = {"host": host or "127.0.0.1:8765"}


def cards(hub):
    return [e for e in hub.tasks.tasks[8].transcript if e["role"] == "artifact"]


async def test_made_then_changed_each_version_kept_carded_and_announced(hub):
    desk = hub.code_artifacts
    q = hub.subscribe()
    made = desk.create(8, "  Shop   mockup ", "html", PAGE)
    assert "is_error" not in made
    aid = made_id(made)
    assert code_artifacts._ID.fullmatch(aid)
    [ev] = drain(q, "artifact")
    assert (
        ev["id"] == 8 and ev["aid"] == aid and ev["version"] == 1 and ev["title"] == "Shop mockup"
    )

    # one exact piece replaced, then the whole of it, then a rename
    assert "is_error" not in desk.update(8, {"id": aid, "old_str": "Buy", "new_str": "Add to cart"})
    assert "is_error" not in desk.update(8, {"id": aid, "content": "<p>v3</p>"})
    assert "is_error" not in desk.update(8, {"id": aid, "title": "Checkout"})
    art = desk.load(aid)
    assert [v["content"] for v in art["versions"]] == [
        PAGE,
        PAGE.replace("Buy", "Add to cart"),
        "<p>v3</p>",
        "<p>v3</p>",
    ]
    assert art["title"] == "Checkout"
    # the transcript has a card per version, never the content
    assert [(c["aid"], c["version"]) for c in cards(hub)] == [(aid, n) for n in (1, 2, 3, 4)]
    assert all("<p>" not in str(c) and "<h1>" not in str(c) for c in cards(hub))

    await hub._handle({"type": "art_get", "aid": aid, "version": 2})
    [got] = drain(q, "artifact_content")
    assert got["version"] == 2 and got["versions"] == 4 and "Add to cart" in got["content"]
    await hub._handle({"type": "art_get", "aid": aid, "version": 99})  # past the last: the last
    assert drain(q, "artifact_content")[0]["version"] == 4


async def test_what_it_refuses(hub):
    desk = hub.code_artifacts
    assert desk.create(8, "x", "exe", "a")["is_error"]
    assert desk.create(8, "x", "html", "   ")["is_error"]
    assert desk.create(8, "x", "html", "a" * (code_artifacts.MAX_CONTENT + 1))["is_error"]
    aid = made_id(desk.create(8, "x", "markdown", "one two two"))
    assert "isn't in" in text(desk.update(8, {"id": aid, "old_str": "three", "new_str": "3"}))
    assert "2 places" in text(desk.update(8, {"id": aid, "old_str": "two", "new_str": "2"}))
    assert desk.update(8, {"id": aid})["is_error"]
    assert desk.update(8, {"id": "../../etc/passwd", "content": "x"})["is_error"]
    assert "Nothing changed" in text(desk.update(8, {"id": aid, "content": "one two two"}))
    assert len(desk.load(aid)["versions"]) == 1


async def test_shown_sandboxed_from_this_mac_only(hub):
    desk = hub.code_artifacts
    aid = made_id(
        desk.create(8, "Diagram", "svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>")
    )
    response = await desk.serve(Request(aid))
    assert response.status_code == 200
    csp = response.headers["content-security-policy"]
    assert csp.startswith("sandbox allow-scripts") and "allow-same-origin" not in csp
    assert "connect-src 'none'" in csp
    assert b"<svg" in response.body and b"<!doctype html>" in response.body
    assert (await desk.serve(Request(aid, host="evil.test"))).status_code == 403
    assert (await desk.serve(Request("0" * 24))).status_code == 404
    assert (await desk.serve(Request("../../etc/passwd"))).status_code == 404


def test_markdown_shown_as_text_never_as_markup():
    page = code_artifacts.page_for("markdown", "<b>t</b>", "# Hi <script>alert(1)</script>")
    assert "<script>" not in page and "&lt;script&gt;" in page and "<b>t</b>" not in page


async def test_open_in_browser_only_this_servers_own_address(hub, monkeypatch):
    opened = []
    monkeypatch.setattr(code_artifacts.webbrowser, "open", opened.append)
    aid = made_id(hub.code_artifacts.create(8, "x", "html", PAGE))
    await hub._handle({"type": "art_open", "aid": aid, "version": 1, "origin": "https://evil.test"})
    await hub._handle(
        {"type": "art_open", "aid": aid, "version": 1, "origin": "http://127.0.0.1:8765/x"}
    )
    await hub._handle(
        {"type": "art_open", "aid": aid, "version": 1, "origin": "http://127.0.0.1:8765"}
    )
    assert opened == [f"http://127.0.0.1:8765/f/code-artifacts/{aid}/1"]


def test_every_eden_code_session_gets_the_tools_but_an_outside_agent_doesnt(hub):
    desk = hub.code_artifacts
    options = types.SimpleNamespace(mcp_servers={}, allowed_tools=["Read"])
    desk.extend(hub.tasks.tasks[8], options)
    assert code_artifacts.SERVER in options.mcp_servers
    assert options.allowed_tools == ["Read", *code_artifacts.TOOLS]
    outside = types.SimpleNamespace(id=9, kind="code", model_ref="acp:gemini")
    other = types.SimpleNamespace(mcp_servers={}, allowed_tools=[])
    desk.extend(outside, other)
    assert other.mcp_servers == {} and other.allowed_tools == []
    assert desk.extend in hub.tasks.session_extras
