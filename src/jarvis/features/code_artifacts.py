"""Artifacts in Eden Code, as in Claude: a session makes a mockup, a page, a diagram or a
document with create_artifact, changes it with update_artifact (a whole new version, or one
exact text replaced), and the window shows it live in the Artifact pane beside the chat
(web/features/code-artifacts.js), every version kept.

- The tools: an in-process MCP server ("eden_artifacts") added to every Eden Code session
  (TaskManager.session_extras), for whichever model runs it (Claude Code calls the tool).
- Kinds: html (a whole page; scripts may load from cdnjs, jsdelivr and unpkg), svg, markdown.
- Each change is a transcript entry (role "artifact": the artifact's id, version, title and
  kind; never its content) and an `artifact` event, which opens the pane on the session.
- Where it's shown: GET /f/code-artifacts/<id>/<version>, from this Mac only, in a sandbox
  of its own (CSP sandbox: an opaque origin, so a page can't reach Eden Code or its token),
  no network but the script and font hosts above. The id is random (nobody could guess it).
- Kept: APP_SUPPORT/code-artifacts/<id>.json, at most MAX_VERSIONS versions each.
- art_get {aid, version?} -> artifact_content {aid, version, versions, title, format, content}
  (the pane's Code view and its version arrows); art_open {aid, version, origin}: the
  version in the default browser.

Cost policy: the feature calls no model; a tool call is part of the session's own turn.
"""

from __future__ import annotations

import html as _html
import logging
import re
import secrets
import time
import webbrowser
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import jsonstore

log = logging.getLogger("jarvis")

SERVER = "eden_artifacts"
TOOLS = [f"mcp__{SERVER}__create_artifact", f"mcp__{SERVER}__update_artifact"]
ROUTE = "/f/code-artifacts"
KINDS = ("html", "svg", "markdown")
MAX_CONTENT = 1_000_000  # characters in one version
MAX_VERSIONS = 100
MAX_TITLE = 120
_ID = re.compile(r"[0-9a-f]{24}")

# What a shown artifact may load: scripts and styles from the usual CDNs (React, Tailwind,
# Chart.js…), Google's fonts, pictures from anywhere; nothing it can send data to.
CDNS = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com"
CSP = (
    "sandbox allow-scripts allow-forms allow-modals allow-popups; "
    f"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' {CDNS}; "
    f"style-src 'unsafe-inline' {CDNS} https://fonts.googleapis.com; "
    "font-src https://fonts.gstatic.com data:; img-src data: blob: https:; media-src data: blob: https:; "
    "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"
)

CREATE_DESCRIPTION = (
    "Show the person something visual or self-contained in Eden Code's Artifact pane, beside the "
    "chat, as Claude's artifacts do: a UI mockup or a page design, a prototype, an SVG diagram or "
    "drawing, a chart, or a document they'll read or copy. Use it whenever a picture of the "
    'result helps more than describing it ("mock up", "design", "show me", "draw", '
    '"diagram"), not for code that belongs in the project (write files for that). '
    "type: 'html' (one complete page: inline CSS and JS; libraries may load from "
    "cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com or cdn.tailwindcss.com; no other network), "
    "'svg' (one <svg> element) or 'markdown'. Returns the artifact's id: change it later with "
    "update_artifact rather than making a new one."
)
UPDATE_DESCRIPTION = (
    "Change an artifact you made with create_artifact; the person sees the new version at once "
    "and can step back to earlier ones. Either give content (the whole new version), or old_str "
    "and new_str to replace one exact piece of text that appears once in the current version "
    "(best for small edits). title renames it."
)


def _text(message: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": message}]}
    if error:
        out["is_error"] = True
    return out


def page_for(kind: str, title: str, content: str) -> str:
    """What the browser gets for a version: an html artifact as it is; an svg one centred on
    a page; markdown as readable text (the pane renders it richly itself)."""
    if kind == "html":
        return content
    head = (
        f"<!doctype html><html><head><meta charset='utf-8'><title>{_html.escape(title)}</title>"
        "<meta name='viewport' content='width=device-width, initial-scale=1'>"
        "<style>html,body{margin:0;height:100%;background:#fff;color:#1d1d1f;"
        "font:15px/1.55 -apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif}"
    )
    if kind == "svg":
        return (
            head + "body{display:grid;place-items:center;padding:16px;box-sizing:border-box}"
            "svg{max-width:100%;height:auto}</style></head><body>" + content + "</body></html>"
        )
    return (
        head + "body{max-width:760px;margin:0 auto;padding:24px}pre{white-space:pre-wrap}</style>"
        f"</head><body><pre>{_html.escape(content)}</pre></body></html>"
    )


class ArtifactDesk:
    def __init__(self, hub: Any, home: Path | None = None) -> None:
        self.hub = hub
        if home is None:
            from ..prefs import APP_SUPPORT

            home = APP_SUPPORT / "code-artifacts"
        self.home = home

    # ── the store ──

    def _path(self, aid: str) -> Path | None:
        return self.home / f"{aid}.json" if _ID.fullmatch(str(aid or "")) else None

    def load(self, aid: str) -> dict[str, Any] | None:
        path = self._path(aid)
        if path is None or not path.exists():
            return None
        data = jsonstore.load_json(path, dict)
        if not isinstance(data, dict) or not isinstance(data.get("versions"), list):
            return None
        return data

    def _save(self, art: dict[str, Any]) -> None:
        self.home.mkdir(parents=True, exist_ok=True)
        jsonstore.save_json(self.home / f"{art['id']}.json", art, indent=None, backup=False)

    # ── the tools ──

    def create(self, task_id: int, title: Any, kind: Any, content: Any) -> dict[str, Any]:
        title = " ".join(str(title or "").split())[:MAX_TITLE] or "Untitled"
        kind = str(kind or "").strip().lower()
        if kind not in KINDS:
            return _text(f"type must be one of {', '.join(KINDS)}.", error=True)
        if not isinstance(content, str) or not content.strip():
            return _text("Give the artifact's content.", error=True)
        if len(content) > MAX_CONTENT:
            return _text(f"That's over {MAX_CONTENT:,} characters; make it smaller.", error=True)
        art = {
            "id": secrets.token_hex(12),
            "task": task_id,
            "title": title,
            "kind": kind,
            "versions": [],
        }
        return self._add_version(task_id, art, title, content, "Created")

    def update(self, task_id: int, args: dict[str, Any]) -> dict[str, Any]:
        art = self.load(str(args.get("id") or ""))
        if art is None:
            return _text(
                "There's no artifact with that id. Make one with create_artifact.", error=True
            )
        current = art["versions"][-1]["content"]
        title = " ".join(str(args.get("title") or "").split())[:MAX_TITLE] or art["title"]
        content = args.get("content")
        old, new = args.get("old_str"), args.get("new_str")
        if isinstance(content, str) and content.strip():
            pass
        elif isinstance(old, str) and old and isinstance(new, str):
            count = current.count(old)
            if count != 1:
                where = "isn't in" if count == 0 else f"is in {count} places in"
                return _text(
                    f"old_str {where} the current version; it must appear exactly once.", error=True
                )
            content = current.replace(old, new, 1)
        elif args.get("title"):
            content = current  # a rename alone
        else:
            return _text("Give content, or old_str and new_str.", error=True)
        if len(content) > MAX_CONTENT:
            return _text(f"That's over {MAX_CONTENT:,} characters; make it smaller.", error=True)
        if content == current and title == art["title"]:
            return _text(
                f"Nothing changed: {art['title']} stays at version {len(art['versions'])}."
            )
        return self._add_version(task_id, art, title, content, "Updated")

    def _add_version(
        self, task_id: int, art: dict[str, Any], title: str, content: str, verb: str
    ) -> dict[str, Any]:
        art["title"] = title
        art["versions"].append({"title": title, "content": content, "at": time.time()})
        if len(art["versions"]) > MAX_VERSIONS:
            art["versions"] = art["versions"][-MAX_VERSIONS:]
        version = len(art["versions"])
        try:
            self._save(art)
        except OSError as exc:
            log.warning("code artifacts: couldn't save %s: %s", art["id"], exc)
            return _text("Eden Code couldn't save the artifact on this Mac.", error=True)
        shown = {"aid": art["id"], "version": version, "title": title, "kind": art["kind"]}
        self.hub.tasks.add_entry(
            task_id, "artifact", f"Artifact: {title} (version {version})", **shown
        )
        self.hub.emit(
            "artifact", id=task_id, aid=art["id"], version=version, title=title
        )  # (emit's own first argument is "kind")
        return _text(
            f"{verb} artifact {art['id']} (version {version}), \"{title}\". It's showing in Eden Code's "
            "Artifact pane. Change it with update_artifact and this id."
        )

    def tools(self, task_id: int) -> list[Any]:
        desk = self

        @tool(
            "create_artifact",
            CREATE_DESCRIPTION,
            {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "A short name for it."},
                    "type": {"type": "string", "enum": list(KINDS)},
                    "content": {"type": "string", "description": "The whole artifact."},
                },
                "required": ["title", "type", "content"],
            },
        )
        async def create_artifact(args):
            return desk.create(task_id, args.get("title"), args.get("type"), args.get("content"))

        @tool(
            "update_artifact",
            UPDATE_DESCRIPTION,
            {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "content": {"type": "string", "description": "The whole new version."},
                    "old_str": {"type": "string", "description": "Exact text to replace (once)."},
                    "new_str": {"type": "string"},
                    "title": {"type": "string"},
                },
                "required": ["id"],
            },
        )
        async def update_artifact(args):
            return desk.update(task_id, args)

        return [create_artifact, update_artifact]

    def extend(self, task: Any, options: Any) -> None:
        """TaskManager.session_extras: the artifact tools for an Eden Code session (not an
        outside agent's over ACP, which brings its own)."""
        if getattr(task, "kind", "code") != "code" or str(
            getattr(task, "model_ref", "") or ""
        ).startswith("acp:"):
            return
        base = options.mcp_servers if isinstance(options.mcp_servers, dict) else {}
        options.mcp_servers = {
            **base,
            SERVER: create_sdk_mcp_server(name=SERVER, version="0.1.0", tools=self.tools(task.id)),
        }
        options.allowed_tools = [*options.allowed_tools, *TOOLS]

    # ── the window ──

    def _version(self, art: dict[str, Any], raw: Any) -> int:
        try:
            v = int(raw)
        except (TypeError, ValueError):
            v = len(art["versions"])
        return max(1, min(v, len(art["versions"])))

    async def cmd_get(self, msg: dict[str, Any]) -> None:
        art = self.load(str(msg.get("aid") or ""))
        if art is None:
            self.hub.emit(
                "artifact_content",
                aid=str(msg.get("aid") or "")[:40],
                error="That artifact isn't on this Mac any more.",
            )
            return
        v = self._version(art, msg.get("version"))
        ver = art["versions"][v - 1]
        self.hub.emit(
            "artifact_content",
            aid=art["id"],
            version=v,
            versions=len(art["versions"]),
            title=ver.get("title") or art["title"],
            format=art["kind"],
            content=ver["content"],
        )

    async def cmd_open(self, msg: dict[str, Any]) -> None:
        """The version in the default browser: this server's own address only."""
        art = self.load(str(msg.get("aid") or ""))
        origin = str(msg.get("origin") or "")
        parts = urlsplit(origin)
        if (
            art is None
            or parts.scheme != "http"
            or parts.hostname not in ("127.0.0.1", "localhost", "::1")
            or parts.path not in ("", "/")
        ):
            return
        v = self._version(art, msg.get("version"))
        webbrowser.open(f"{origin.rstrip('/')}{ROUTE}/{art['id']}/{v}")

    async def serve(self, request: Any) -> Any:
        from starlette.responses import PlainTextResponse, Response

        port = (request.scope.get("server") or ("", 0))[1]
        if request.headers.get("host", "") not in {
            f"127.0.0.1:{port}",
            f"localhost:{port}",
            f"[::1]:{port}",
        }:
            return PlainTextResponse("Not here.", status_code=403)
        art = self.load(str(request.path_params.get("aid", "")))
        if art is None:
            return PlainTextResponse("Not here.", status_code=404)
        v = self._version(art, request.path_params.get("version"))
        ver = art["versions"][v - 1]
        body = page_for(art["kind"], ver.get("title") or art["title"], ver["content"])
        return Response(
            body.encode("utf-8"),
            media_type="text/html; charset=utf-8",
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": CSP,
                "Referrer-Policy": "no-referrer",
            },
        )


def install(hub: Any) -> None:
    desk = ArtifactDesk(hub)
    hub.code_artifacts = desk  # (for the tests)
    hub.tasks.session_extras.append(desk.extend)
    hub.register_route(f"{ROUTE}/{{aid}}/{{version}}", desk.serve)
    hub.register_command("art_get", desk.cmd_get)
    hub.register_command("art_open", desk.cmd_open)


__all__ = ["ArtifactDesk", "install", "page_for"]
