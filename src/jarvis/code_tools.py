"""Tools an Eden Code session gets on top of Claude Code's own, as in Claude Code's desktop
app: the built-in browser (to try the web app it's building, in the same window the user
watches) and the iOS Simulator (boot, install, launch, open a link, look at the screen).

Looking (reading a page, a screenshot, the list of simulators) needs no OK; anything that
acts goes through the session's permission mode like every other tool.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from . import browser_agent, browser_pdf

BROWSER = "jarvis_browser"
SIMULATOR = "jarvis_simulator"
READ_ONLY = [
    f"mcp__{BROWSER}__browser_read",
    f"mcp__{BROWSER}__browser_screenshot",
    f"mcp__{BROWSER}__browser_snapshot",
    f"mcp__{BROWSER}__browser_wait",
    f"mcp__{BROWSER}__browser_console",
    f"mcp__{BROWSER}__browser_network",
    f"mcp__{BROWSER}__browser_scroll",
    f"mcp__{BROWSER}__browser_back",
    f"mcp__{SIMULATOR}__sim_list",
    f"mcp__{SIMULATOR}__sim_screenshot",
]
UDID = re.compile(r"^[0-9A-Fa-f-]{36}$")
BUNDLE_ID = re.compile(r"^[A-Za-z0-9.\-]{3,155}$")

BrowserCall = Callable[[str, dict[str, Any] | None], Awaitable[dict[str, Any]]]


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out


def _page(r: dict[str, Any], what: str = "") -> dict[str, Any]:
    if r.get("error"):
        return _text(r["error"], error=True)
    if r.get("ok") is False:
        return _text(r.get("message") or "That didn't work.", error=True)
    where = f"{r.get('title', '')} — {r.get('url', '')}".strip(" —")
    return _text(" ".join(p for p in (r.get("message", ""), what, where) if p) or "Done.")


def browser_tools(call: BrowserCall, session: browser_agent.CodeSession | None = None) -> list[Any]:
    """The browser tools for one session (session: which one it is, for its own tab and its
    approvals; without one, presses that need an OK off this Mac are refused)."""
    session = session or browser_agent.CodeSession()

    @tool(
        "browser_open",
        "Open a URL in the J.A.R.V.I.S. built-in browser (the user watches it), in this "
        "session's own tab: to try the web app you're building, e.g. http://localhost:5173. "
        "new_tab: true for another tab; background: true to keep it behind the tab on show.",
        {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "new_tab": {"type": "boolean"},
                "background": {"type": "boolean"},
            },
            "required": ["url"],
        },
    )
    async def browser_open(args):
        r = await session.open(call, args)
        return _page(r, f"Opened in tab {r.get('tab')}" if r.get("tab") else "Opened")

    @tool(
        "browser_read",
        browser_agent.READ_DESC,
        {
            "type": "object",
            "properties": {"offset": {"type": "integer"}, "tab": {"type": "integer"}},
        },
    )
    async def browser_read(args):
        ask = browser_pdf.ask(browser_agent.read_request(args or {}))  # a PDF: its text
        r = await browser_pdf.expand(await call("read", session.route(ask)))
        if r.get("error") or r.get("ok") is False:
            return _page(r)
        return _text(browser_agent.read_text(r))

    @tool(
        "browser_click",
        "Click a link or button in the built-in browser by its visible text or a CSS selector.",
        {
            "type": "object",
            "properties": {"text": {"type": "string"}, "selector": {"type": "string"}},
        },
    )
    async def browser_click(args):
        req = session.route({k: str(args.get(k, "")) for k in ("text", "selector")})
        r = await call("click", req)
        if r.get("needsConfirm"):  # it submits, sends, posts, pays or deletes
            # On the app it's building (localhost) the session's own OK for this tool counts;
            # elsewhere it asks through the session's card.
            label = str(r.get("label") or req["text"] or req["selector"])
            if not await session.press_ok(label, r):
                return _text(f"The user said no. Don't press “{label}”.", error=True)
            r = await call("click", {**req, "force": True})
        return _page(r)

    @tool(
        "browser_type",
        "Type into a field in the built-in browser (field: words from its label or placeholder; "
        "submit: press Return). Never passwords or card numbers.",
        {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "field": {"type": "string"},
                "submit": {"type": "boolean"},
            },
            "required": ["text"],
        },
    )
    async def browser_type(args):
        return _page(
            await call(
                "type",
                session.route(
                    {
                        "text": str(args.get("text", "")),
                        "field": str(args.get("field", "")),
                        "submit": bool(args.get("submit")),
                    }
                ),
            ),
            "Typed",
        )

    @tool("browser_screenshot", browser_agent.SCREENSHOT_DESC, browser_agent.SCREENSHOT_SCHEMA)
    async def browser_screenshot(args):
        r = await call("screenshot", session.route(browser_agent.screenshot_request(args or {})))
        return browser_agent.screenshot_content(r)

    return [
        browser_open,
        browser_read,
        browser_click,
        browser_type,
        browser_screenshot,
        *browser_agent.code_tools(call, session),
    ]


async def _simctl(*args: str, timeout: float = 120) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            "xcrun",
            "simctl",
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except OSError as exc:
        return 1, str(exc)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return 1, "simctl didn't finish in time."
    return proc.returncode or 0, out.decode(errors="replace").strip()


def simulator_tools(workbench: Any, project: Callable[[], Path]) -> list[Any]:
    """workbench: the window's Workbench (simulators, boot, screenshot); project: the
    session's folder (apps must be built inside it)."""

    async def device(udid: str) -> str | None:
        if udid and UDID.match(udid):
            return udid
        booted = [d for d in await workbench.simulators() if d["state"] == "Booted"]
        return booted[0]["udid"] if booted else None

    @tool("sim_list", "The iOS Simulators on this Mac, booted ones first.", {})
    async def sim_list(_args):
        devices = await workbench.simulators()
        if not devices:
            return _text("No simulators (is Xcode installed?).")
        return _text(
            "\n".join(f"{d['name']} · {d['os']} · {d['state']} · {d['udid']}" for d in devices)
        )

    @tool("sim_boot", "Boot a simulator (udid from sim_list) and show it.", {"udid": str})
    async def sim_boot(args):
        udid = str(args.get("udid", ""))
        if not UDID.match(udid):
            return _text("Give a simulator's udid from sim_list.", error=True)
        await workbench.boot(udid)
        return _text(f"Booted {udid}.")

    @tool(
        "sim_install",
        "Install a built .app (a path inside this project, e.g. from xcodebuild's "
        "-derivedDataPath) on the booted simulator (or udid).",
        {
            "type": "object",
            "properties": {"app": {"type": "string"}, "udid": {"type": "string"}},
            "required": ["app"],
        },
    )
    async def sim_install(args):
        root = project().resolve()
        app = (root / str(args.get("app", ""))).resolve()
        if not (app.suffix == ".app" and app.is_dir() and (root == app or root in app.parents)):
            return _text("Give the path of a built .app inside this project.", error=True)
        udid = await device(str(args.get("udid", "")))
        if udid is None:
            return _text("No simulator is booted: sim_boot one first.", error=True)
        code, out = await _simctl("install", udid, str(app))
        return _text(out or f"Installed {app.name}.", error=code != 0)

    @tool(
        "sim_launch",
        "Launch an app by bundle id on the booted simulator (or udid).",
        {
            "type": "object",
            "properties": {"bundle_id": {"type": "string"}, "udid": {"type": "string"}},
            "required": ["bundle_id"],
        },
    )
    async def sim_launch(args):
        bundle = str(args.get("bundle_id", ""))
        if not BUNDLE_ID.match(bundle):
            return _text("That isn't a bundle id.", error=True)
        udid = await device(str(args.get("udid", "")))
        if udid is None:
            return _text("No simulator is booted: sim_boot one first.", error=True)
        code, out = await _simctl("launch", "--terminate-running-process", udid, bundle)
        return _text(out or f"Launched {bundle}.", error=code != 0)

    @tool(
        "sim_open_url",
        "Open a URL (a web page or an app's deep link) in the booted simulator (or udid).",
        {
            "type": "object",
            "properties": {"url": {"type": "string"}, "udid": {"type": "string"}},
            "required": ["url"],
        },
    )
    async def sim_open_url(args):
        url = str(args.get("url", "")).strip()
        if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://\S+$", url):
            return _text("That isn't a URL.", error=True)
        udid = await device(str(args.get("udid", "")))
        if udid is None:
            return _text("No simulator is booted: sim_boot one first.", error=True)
        code, out = await _simctl("openurl", udid, url)
        return _text(out or f"Opened {url}.", error=code != 0)

    @tool(
        "sim_screenshot", "See the booted simulator's screen (or udid) as an image.", {"udid": str}
    )
    async def sim_screenshot(args):
        udid = await device(str(args.get("udid", "")))
        if udid is None:
            return _text("No simulator is booted.", error=True)
        jpeg = await workbench.screenshot(udid)
        if not jpeg:
            return _text("The screenshot came back empty.", error=True)
        return {"content": [{"type": "image", "data": jpeg, "mimeType": "image/jpeg"}]}

    return [sim_list, sim_boot, sim_install, sim_launch, sim_open_url, sim_screenshot]


def build_servers(
    browser_call: BrowserCall,
    workbench: Any,
    project: Callable[[], Path],
    session: browser_agent.CodeSession | None = None,
) -> dict[str, Any]:
    """The MCP servers for one session (project: that session's folder; session: which
    session, for its own browser tab and its approvals)."""
    return {
        BROWSER: create_sdk_mcp_server(
            name=BROWSER, version="0.1.0", tools=browser_tools(browser_call, session)
        ),
        SIMULATOR: create_sdk_mcp_server(
            name=SIMULATOR, version="0.1.0", tools=simulator_tools(workbench, project)
        ),
    }
