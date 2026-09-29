"""Tools & Accounts: connect JARVIS to your services through their official MCP servers.

JARVIS holds each connection itself (OAuth sign-in in your browser, or a token you paste)
and hands the service's tools to Claude as an in-process MCP server. That keeps sign-ins
refreshing on their own and every call under JARVIS's permission rules: read-only tools
run freely, anything that changes data asks first unless you've said otherwise.

Secrets (tokens, OAuth credentials) live in the macOS Keychain, never in files.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import re
import shlex
import subprocess
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .prefs import APP_SUPPORT

SERVICE = "Jarvis connectors"
CALLBACK_PORT = 47823
REDIRECT_URI = f"http://localhost:{CALLBACK_PORT}/callback"
SERVER_PREFIX = "acct_"
SIGN_IN_TIMEOUT = 300

POLICIES = ("ask", "allow", "read_only")


@dataclass(frozen=True)
class CatalogEntry:
    id: str
    name: str
    category: str
    url: str
    auth: str  # oauth | token | own_app
    blurb: str
    scope: str = ""
    help_url: str = ""
    help: str = ""


_G = "https://www.googleapis.com/auth/"
GOOGLE_HELP = (
    "Google's connectors are a developer preview. Join the Workspace Developer Preview, "
    "create a Google Cloud project, enable the API and its MCP API, set up the OAuth "
    f"consent screen, and create a Web OAuth client with redirect URI {REDIRECT_URI}. "
    "Then paste its client ID and secret here."
)

CATALOG: list[CatalogEntry] = [
    CatalogEntry(
        "notion",
        "Notion",
        "Work",
        "https://mcp.notion.com/mcp",
        "oauth",
        "Search, read and write pages and databases.",
    ),
    CatalogEntry(
        "linear",
        "Linear",
        "Work",
        "https://mcp.linear.app/mcp",
        "oauth",
        "Issues, projects and cycles.",
    ),
    CatalogEntry(
        "atlassian",
        "Jira & Confluence",
        "Work",
        "https://mcp.atlassian.com/v2/mcp",
        "oauth",
        "Atlassian's Rovo server: Jira issues and Confluence pages.",
    ),
    CatalogEntry(
        "asana",
        "Asana",
        "Work",
        "https://mcp.asana.com/v2/mcp",
        "own_app",
        "Tasks and projects. Needs an MCP app from Asana's developer console.",
        help_url="https://developers.asana.com/docs/integrating-with-asanas-mcp-server",
        help=f"Create an MCP app in Asana's developer console with redirect URI {REDIRECT_URI}, then paste its client ID and secret.",
    ),
    CatalogEntry(
        "monday",
        "monday.com",
        "Work",
        "https://mcp.monday.com/mcp",
        "oauth",
        "Boards, items and updates.",
    ),
    CatalogEntry(
        "todoist", "Todoist", "Work", "https://ai.todoist.net/mcp", "oauth", "Tasks and projects."
    ),
    CatalogEntry(
        "gmail",
        "Gmail",
        "Google",
        "https://gmailmcp.googleapis.com/mcp/v1",
        "own_app",
        "Read mail and write drafts (Google's official connector).",
        scope=f"{_G}gmail.readonly {_G}gmail.compose",
        help_url="https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
        help=GOOGLE_HELP,
    ),
    CatalogEntry(
        "gcal",
        "Google Calendar",
        "Google",
        "https://calendarmcp.googleapis.com/mcp/v1",
        "own_app",
        "Your calendars and events.",
        scope=f"{_G}calendar.calendarlist.readonly {_G}calendar.events.readonly",
        help_url="https://developers.google.com/workspace/guides/configure-mcp-servers",
        help=GOOGLE_HELP,
    ),
    CatalogEntry(
        "gdrive",
        "Google Drive",
        "Google",
        "https://drivemcp.googleapis.com/mcp/v1",
        "own_app",
        "Find and read files; create new ones.",
        scope=f"{_G}drive.readonly {_G}drive.file",
        help_url="https://developers.google.com/workspace/guides/configure-mcp-servers",
        help=GOOGLE_HELP,
    ),
    CatalogEntry(
        "github",
        "GitHub",
        "Developer",
        "https://api.githubcopilot.com/mcp/",
        "token",
        "Repos, issues, pull requests and Actions.",
        help_url="https://github.com/settings/personal-access-tokens/new",
        help="Create a fine-grained personal access token with the repos and permissions you want Jarvis to have, then paste it here.",
    ),
    CatalogEntry(
        "sentry",
        "Sentry",
        "Developer",
        "https://mcp.sentry.dev/mcp",
        "oauth",
        "Errors, issues and releases.",
    ),
    CatalogEntry(
        "vercel",
        "Vercel",
        "Developer",
        "https://mcp.vercel.com",
        "oauth",
        "Projects, deployments and logs.",
    ),
    CatalogEntry(
        "supabase",
        "Supabase",
        "Developer",
        "https://mcp.supabase.com/mcp",
        "oauth",
        "Databases, tables and edge functions.",
    ),
    CatalogEntry(
        "huggingface",
        "Hugging Face",
        "Developer",
        "https://huggingface.co/mcp",
        "oauth",
        "Models, datasets and Spaces.",
    ),
    CatalogEntry(
        "stripe",
        "Stripe",
        "Business",
        "https://mcp.stripe.com",
        "oauth",
        "Customers, payments and invoices.",
    ),
    CatalogEntry(
        "hubspot",
        "HubSpot",
        "Business",
        "https://mcp.hubspot.com/",
        "own_app",
        "CRM contacts, companies and deals. Needs an MCP auth app from HubSpot.",
        help_url="https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
        help=f"In HubSpot, create an MCP auth app (Development > MCP Auth Apps) with redirect URI {REDIRECT_URI}, then paste its client ID and secret.",
    ),
    CatalogEntry(
        "zapier",
        "Zapier",
        "Business",
        "https://mcp.zapier.com/api/v1/connect",
        "oauth",
        "Actions across thousands of apps you've set up in Zapier.",
    ),
    CatalogEntry(
        "canva",
        "Canva",
        "Design",
        "https://mcp.canva.com/mcp",
        "oauth",
        "Designs and brand assets.",
    ),
]
CATALOG_BY_ID = {e.id: e for e in CATALOG}


@dataclass
class Connection:
    id: str
    name: str
    kind: str  # http | stdio
    url: str = ""
    command: list[str] = field(default_factory=list)
    auth: str = "none"  # oauth | token | own_app | none
    scope: str = ""
    policy: str = "ask"
    always_allow: list[str] = field(default_factory=list)
    enabled: bool = True


# ── secrets ──


class Vault:
    """The macOS Keychain, via keyring. Keys look like "<connection>:<what>"."""

    def get(self, conn_id: str, key: str) -> str | None:
        import keyring

        return keyring.get_password(SERVICE, f"{conn_id}:{key}")

    def set(self, conn_id: str, key: str, value: str) -> None:
        import keyring

        keyring.set_password(SERVICE, f"{conn_id}:{key}", value)

    def delete(self, conn_id: str, key: str) -> None:
        import keyring
        from keyring.errors import PasswordDeleteError

        with contextlib.suppress(PasswordDeleteError):
            keyring.delete_password(SERVICE, f"{conn_id}:{key}")

    def forget(self, conn_id: str) -> None:
        for key in ("token", "oauth_tokens", "oauth_client"):
            self.delete(conn_id, key)


class MemoryVault(Vault):
    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    def get(self, conn_id: str, key: str) -> str | None:
        return self.data.get(f"{conn_id}:{key}")

    def set(self, conn_id: str, key: str, value: str) -> None:
        self.data[f"{conn_id}:{key}"] = value

    def delete(self, conn_id: str, key: str) -> None:
        self.data.pop(f"{conn_id}:{key}", None)


class KeychainTokenStorage:
    """The MCP SDK's TokenStorage, kept in the Keychain."""

    def __init__(self, vault: Vault, conn_id: str) -> None:
        self.vault = vault
        self.conn_id = conn_id

    async def get_tokens(self):
        from mcp.shared.auth import OAuthToken

        raw = self.vault.get(self.conn_id, "oauth_tokens")
        return OAuthToken.model_validate_json(raw) if raw else None

    async def set_tokens(self, tokens) -> None:
        self.vault.set(self.conn_id, "oauth_tokens", tokens.model_dump_json(exclude_none=True))

    async def get_client_info(self):
        from mcp.shared.auth import OAuthClientInformationFull

        raw = self.vault.get(self.conn_id, "oauth_client")
        return OAuthClientInformationFull.model_validate_json(raw) if raw else None

    async def set_client_info(self, client_info) -> None:
        self.vault.set(self.conn_id, "oauth_client", client_info.model_dump_json(exclude_none=True))


# ── the browser sign-in callback ──

SIGNED_IN_PAGE = (
    "<!doctype html><meta charset=utf-8><title>Jarvis</title>"
    "<body style='font:17px -apple-system,sans-serif;display:grid;place-items:center;"
    "height:100vh;margin:0;background:#f4f0e8;color:#1c1b19'>"
    "<p>{message} You can close this tab.</p>"
)


class CallbackServer:
    """A tiny HTTP listener on localhost:47823 that catches the OAuth redirect."""

    def __init__(self, port: int = CALLBACK_PORT) -> None:
        self.port = port
        self._server: asyncio.base_events.Server | None = None
        self._waiter: asyncio.Future | None = None
        self._lock = asyncio.Lock()

    async def wait_for_code(self, timeout: float = SIGN_IN_TIMEOUT) -> tuple[str, str | None]:
        async with self._lock:
            loop = asyncio.get_running_loop()
            self._waiter = loop.create_future()
            self._server = await asyncio.start_server(
                self._handle, host=["127.0.0.1", "::1"], port=self.port
            )
            try:
                return await asyncio.wait_for(self._waiter, timeout)
            finally:
                self._server.close()
                self._server = None
                self._waiter = None

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request = await asyncio.wait_for(reader.readline(), 10)
            parts = request.decode(errors="replace").split()
            target = urlparse(parts[1]) if len(parts) > 1 else urlparse("/")
            query = parse_qs(target.query)
            if target.path != "/callback":
                message, status = "Not found.", "404 Not Found"
            elif "code" in query:
                message, status = "Signed in to Jarvis.", "200 OK"
                if self._waiter is not None and not self._waiter.done():
                    self._waiter.set_result((query["code"][0], query.get("state", [None])[0]))
            else:
                error = query.get(
                    "error_description", query.get("error", ["Sign-in was cancelled."])
                )[0]
                message, status = f"Sign-in didn't finish: {error}.", "400 Bad Request"
                if self._waiter is not None and not self._waiter.done():
                    self._waiter.set_exception(RuntimeError(error))
            body = SIGNED_IN_PAGE.format(message=_html_escape(message)).encode()
            writer.write(
                f"HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n"
                f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
                + body
            )
            await writer.drain()
        finally:
            writer.close()


def _html_escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ── one live connection ──


def _root_error(exc: BaseException) -> str:
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    text = str(exc) or type(exc).__name__
    if "401" in text or "Unauthorized" in text:
        return "The service turned the sign-in down (401). Check the token, or reconnect."
    return text[:300]


def convert_result(result: Any) -> dict[str, Any]:
    """An MCP CallToolResult as the in-process tool result the Agent SDK expects."""
    content = []
    for item in result.content or []:
        kind = getattr(item, "type", "")
        if kind == "text":
            content.append({"type": "text", "text": item.text})
        elif kind == "image":
            content.append({"type": "image", "data": item.data, "mimeType": item.mime_type})
        else:
            content.append(
                {"type": "text", "text": item.model_dump_json(exclude_none=True)[:20000]}
            )
    if not content and getattr(result, "structured_content", None) is not None:
        content.append({"type": "text", "text": json.dumps(result.structured_content)[:20000]})
    out: dict[str, Any] = {"content": content or [{"type": "text", "text": "(no output)"}]}
    if result.is_error:
        out["is_error"] = True
    return out


class Live:
    """Holds one MCP session open in a background task."""

    def __init__(self, conn: Connection, manager: ConnectorManager) -> None:
        self.conn = conn
        self.manager = manager
        self.session: Any = None
        self.tools: list[Any] = []
        self.status = "connecting"
        self.error = ""
        self.ready = asyncio.Event()
        self._stop = asyncio.Event()
        self.task: asyncio.Task | None = None

    def start(self) -> None:
        self.task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stop.set()
        if self.task is None or self.task.done():
            return
        # A connection still waiting on a browser sign-in never sees the stop event.
        done, _ = await asyncio.wait({self.task}, timeout=2)
        if not done:
            self.task.cancel()
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await self.task

    async def _run(self) -> None:
        from mcp import ClientSession
        from mcp_types import Implementation

        try:
            async with self._transport() as streams:
                read, write = streams[0], streams[1]
                async with ClientSession(
                    read, write, client_info=Implementation(name="Jarvis", version="0.1.0")
                ) as session:
                    await session.initialize()
                    self.tools = await _list_all_tools(session)
                    self.session = session
                    self.status, self.error = "connected", ""
                    self.ready.set()
                    self.manager.changed(tools_changed=True)
                    await self._stop.wait()
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # sign-in cancelled, bad token, network, server crash
            self.status, self.error = "error", _root_error(exc)
        finally:
            was_connected = self.session is not None
            self.session = None
            if self.status == "connected":
                self.status = "disconnected"
            self.ready.set()
            self.manager.changed(tools_changed=was_connected)

    @contextlib.asynccontextmanager
    async def _transport(self):
        if self.conn.kind == "stdio":
            from mcp.client.stdio import StdioServerParameters, stdio_client

            params = StdioServerParameters(command=self.conn.command[0], args=self.conn.command[1:])
            async with stdio_client(params) as streams:
                yield streams
            return
        from mcp.client.streamable_http import streamable_http_client
        from mcp.shared._httpx_utils import create_mcp_http_client

        headers: dict[str, str] = {}
        auth = None
        if self.conn.auth == "token":
            token = self.manager.vault.get(self.conn.id, "token")
            if not token:
                raise RuntimeError("No token saved. Reconnect and paste one.")
            headers["Authorization"] = f"Bearer {token}"
        elif self.conn.auth in ("oauth", "own_app"):
            auth = self.manager.oauth_provider(self.conn)
        async with create_mcp_http_client(headers=headers, auth=auth) as client:
            async with streamable_http_client(self.conn.url, http_client=client) as streams:
                yield streams

    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if self.session is None:
            return {
                "content": [
                    {"type": "text", "text": f"{self.conn.name} isn't connected right now."}
                ],
                "is_error": True,
            }
        try:
            result = await self.session.call_tool(name, arguments)
        except BaseException as exc:  # noqa: BLE001 - reported to Claude as a tool error
            if isinstance(exc, asyncio.CancelledError):
                raise
            return {"content": [{"type": "text", "text": _root_error(exc)}], "is_error": True}
        return convert_result(result)


async def _list_all_tools(session: Any) -> list[Any]:
    tools, cursor = [], None
    for _ in range(20):
        if cursor:
            from mcp_types import PaginatedRequestParams

            page = await session.list_tools(params=PaginatedRequestParams(cursor=cursor))
        else:
            page = await session.list_tools()
        tools.extend(page.tools)
        cursor = page.next_cursor
        if not cursor:
            break
    return tools


def is_read_only(tool: Any) -> bool:
    annotations = getattr(tool, "annotations", None)
    return bool(annotations and annotations.read_only_hint)


def server_name(conn_id: str) -> str:
    return SERVER_PREFIX + re.sub(r"[^a-z0-9_]", "_", conn_id.lower())


# ── the manager ──

Approve = Callable[[str, str, list[tuple[str, str]]], Awaitable[str]]


class ConnectorManager:
    def __init__(
        self,
        emit: Callable[..., None],
        approve: Approve,
        vault: Vault | None = None,
        store: Path | None = None,
        open_url: Callable[[str], None] | None = None,
    ) -> None:
        self.emit = emit
        self.approve = approve
        self.vault = vault or Vault()
        self.store = store or APP_SUPPORT / "connections.json"
        self.open_url = open_url or (lambda url: subprocess.Popen(["open", url]))
        self.callback = CallbackServer()
        self.connections: dict[str, Connection] = {}
        self.live: dict[str, Live] = {}
        self.signing_in: dict[str, str] = {}
        self.on_tools_changed: Callable[[], None] | None = None
        self._load()

    # persistence

    def _load(self) -> None:
        try:
            data = json.loads(self.store.read_text())
        except (OSError, ValueError):
            return
        for item in data.get("connections", []):
            with contextlib.suppress(TypeError):
                conn = Connection(**item)
                self.connections[conn.id] = conn

    def _save(self) -> None:
        self.store.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.store.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"connections": [asdict(c) for c in self.connections.values()]}, indent=2)
        )
        tmp.replace(self.store)

    # state for the window

    def public(self) -> dict[str, Any]:
        return {
            "catalog": [asdict(e) | {"connected": e.id in self.connections} for e in CATALOG],
            "connections": [self._public(c) for c in self.connections.values()],
            "redirect_uri": REDIRECT_URI,
        }

    def _public(self, conn: Connection) -> dict[str, Any]:
        live = self.live.get(conn.id)
        status = live.status if live else ("off" if not conn.enabled else "disconnected")
        if conn.id in self.signing_in:
            status = "signing_in"
        tools = live.tools if live else []
        return {
            "id": conn.id,
            "name": conn.name,
            "kind": conn.kind,
            "url": conn.url,
            "command": " ".join(shlex.quote(c) for c in conn.command),
            "auth": conn.auth,
            "policy": conn.policy,
            "status": status,
            "error": live.error if live else "",
            "sign_in_url": self.signing_in.get(conn.id, ""),
            "tools": [
                {"name": t.name, "title": t.title or t.name, "read_only": is_read_only(t)}
                for t in tools
            ],
            "always_allow": conn.always_allow,
        }

    def changed(self, tools_changed: bool = False) -> None:
        self.emit("connectors", **self.public())
        if tools_changed and self.on_tools_changed is not None:
            self.on_tools_changed()

    # lifecycle

    async def start_all(self) -> None:
        for conn in self.connections.values():
            if conn.enabled:
                self._start(conn)

    async def close(self) -> None:
        await asyncio.gather(*(live.stop() for live in self.live.values()), return_exceptions=True)

    def _start(self, conn: Connection) -> Live:
        old = self.live.pop(conn.id, None)
        if old is not None:
            asyncio.create_task(old.stop())
        live = Live(conn, self)
        self.live[conn.id] = live
        live.start()
        return live

    async def connect(
        self,
        entry_id: str,
        *,
        token: str = "",
        client_id: str = "",
        client_secret: str = "",
    ) -> None:
        entry = CATALOG_BY_ID.get(entry_id)
        if entry is None:
            raise ValueError("Unknown service.")
        conn = self.connections.get(entry.id) or Connection(
            id=entry.id,
            name=entry.name,
            kind="http",
            url=entry.url,
            auth=entry.auth,
            scope=entry.scope,
        )
        if entry.auth == "token":
            if not token.strip():
                raise ValueError(f"Paste a {entry.name} token first.")
            self.vault.set(conn.id, "token", token.strip())
        elif entry.auth == "own_app":
            if not client_id.strip():
                raise ValueError("Paste the OAuth client ID first.")
            self._save_own_client(conn, client_id.strip(), client_secret.strip())
        self.connections[conn.id] = conn
        conn.enabled = True
        self._save()
        self._start(conn)
        self.changed()

    def _save_own_client(self, conn: Connection, client_id: str, client_secret: str) -> None:
        from mcp.shared.auth import OAuthClientInformationFull

        info = OAuthClientInformationFull(
            client_id=client_id,
            client_secret=client_secret or None,
            redirect_uris=[REDIRECT_URI],
            token_endpoint_auth_method="client_secret_post" if client_secret else "none",
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
            scope=conn.scope or None,
        )
        self.vault.delete(conn.id, "oauth_tokens")
        self.vault.set(conn.id, "oauth_client", info.model_dump_json(exclude_none=True))

    async def add_custom(self, name: str, target: str, token: str = "") -> Connection:
        name = name.strip()[:40] or "Custom tool"
        target = target.strip()
        slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:24] or "custom"
        conn_id = slug
        n = 2
        while conn_id in self.connections or conn_id in CATALOG_BY_ID:
            conn_id, n = f"{slug}_{n}", n + 1
        if target.startswith(("https://", "http://localhost", "http://127.0.0.1")):
            conn = Connection(
                id=conn_id,
                name=name,
                kind="http",
                url=target,
                auth="token" if token.strip() else "oauth",
            )
            if token.strip():
                self.vault.set(conn_id, "token", token.strip())
        elif target.startswith("http://"):
            raise ValueError("Remote servers need https.")
        else:
            command = shlex.split(target)
            if not command:
                raise ValueError("Give a server URL or the command that starts it.")
            conn = Connection(id=conn_id, name=name, kind="stdio", command=command)
        self.connections[conn.id] = conn
        self._save()
        self._start(conn)
        self.changed()
        return conn

    async def disconnect(self, conn_id: str) -> None:
        conn = self.connections.pop(conn_id, None)
        live = self.live.pop(conn_id, None)
        if live is not None:
            await live.stop()
        if conn is not None:
            self.vault.forget(conn_id)
            self._save()
        self.changed(tools_changed=True)

    async def reconnect(self, conn_id: str) -> None:
        conn = self.connections.get(conn_id)
        if conn is not None:
            conn.enabled = True
            self._save()
            self._start(conn)
            self.changed()

    def set_policy(self, conn_id: str, policy: str) -> None:
        conn = self.connections.get(conn_id)
        if conn is None or policy not in POLICIES:
            return
        conn.policy = policy
        self._save()
        self.changed(tools_changed=True)

    # OAuth

    def oauth_provider(self, conn: Connection):
        from mcp.client.auth import OAuthClientProvider
        from mcp.shared.auth import AuthorizationCodeResult, OAuthClientMetadata

        async def redirect(url: str) -> None:
            self.signing_in[conn.id] = url
            self.changed()
            self.open_url(url)

        async def callback() -> AuthorizationCodeResult:
            try:
                code, state = await self.callback.wait_for_code()
            finally:
                self.signing_in.pop(conn.id, None)
                self.changed()
            return AuthorizationCodeResult(code=code, state=state)

        metadata = OAuthClientMetadata(
            client_name="Jarvis",
            redirect_uris=[REDIRECT_URI],
            grant_types=["authorization_code", "refresh_token"],
            response_types=["code"],
            token_endpoint_auth_method="none",
            scope=conn.scope or None,
        )
        return OAuthClientProvider(
            server_url=conn.url,
            client_metadata=metadata,
            storage=KeychainTokenStorage(self.vault, conn.id),
            redirect_handler=redirect,
            callback_handler=callback,
        )

    # tools for Claude

    def build_servers(self) -> tuple[dict[str, Any], list[str]]:
        """In-process MCP servers for every connected service, and which tools run unasked."""
        from claude_agent_sdk import SdkMcpTool, create_sdk_mcp_server

        servers: dict[str, Any] = {}
        allowed: list[str] = []
        for conn_id, live in self.live.items():
            conn = self.connections.get(conn_id)
            if conn is None or live.status != "connected" or not live.tools:
                continue
            name = server_name(conn_id)
            tools = []
            for t in live.tools:
                if conn.policy == "read_only" and not is_read_only(t):
                    continue
                tools.append(
                    SdkMcpTool(
                        name=t.name,
                        description=f"[{conn.name}] {t.description or t.title or t.name}"[:1024],
                        input_schema=t.input_schema or {"type": "object", "properties": {}},
                        handler=_forwarder(live, t.name),
                    )
                )
                if conn.policy == "allow" or is_read_only(t) or t.name in conn.always_allow:
                    allowed.append(f"mcp__{name}__{t.name}")
            if tools:
                servers[name] = create_sdk_mcp_server(name=name, version="0.1.0", tools=tools)
        return servers, allowed

    def connected_names(self) -> list[str]:
        return [
            self.connections[c].name
            for c, live in self.live.items()
            if live.status == "connected" and c in self.connections
        ]

    async def gate(self, tool_name: str, tool_input: dict[str, Any]) -> bool | None:
        """Permission for a connector tool; None when the tool isn't a connector's."""
        if not tool_name.startswith(f"mcp__{SERVER_PREFIX}"):
            return None
        _, server, tool = tool_name.split("__", 2)
        conn = next((c for c in self.connections.values() if server_name(c.id) == server), None)
        if conn is None:
            return False
        if conn.policy == "allow" or tool in conn.always_allow:
            return True
        detail = json.dumps(tool_input, indent=2, ensure_ascii=False)
        choice = await self.approve(
            f"{conn.name} wants to: {tool.replace('_', ' ')}",
            detail if len(detail) < 1500 else detail[:1500] + "\n…",
            [("allow", "Allow"), ("always", "Always allow this"), ("deny", "Deny")],
        )
        if choice == "always":
            conn.always_allow.append(tool)
            self._save()
            self.changed()
        return choice in ("allow", "always")


def _forwarder(live: Live, name: str):
    async def handler(args: dict[str, Any]) -> dict[str, Any]:
        return await live.call(name, args)

    return handler
