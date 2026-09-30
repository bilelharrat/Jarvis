"""Widgets (jarvis.widgets): small HTML or SVG pieces JARVIS makes, on a card in the window and
pinned to the dashboard, each in a sandbox that can't reach anything.

Registers:
- the "widgets" tool server: show_widget, pin_widget, list_widgets and remove_widget (it goes
  ahead when the owner's own words asked, else a card said aloud);
- the widget documents' own address on the window's server: /f/widgets/<id>
  (hub.register_route; see jarvis.widgets for its locks);
- window commands: widgets_state (-> widgets: the pinned ones), widget_pin {id} and
  widget_remove {id} (the owner's own clicks). Each widget shown goes to the window as a
  "widget" event.

Cost: no model calls of its own: JARVIS writes a widget within the turn the owner started.
"""

from __future__ import annotations

from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import lang, widgets
from ._asked import Asked

# "Remove the stocks widget", "take the clock widget off the dashboard", "删掉股票小组件",
# "把时钟小组件拿掉"; never 小组件删掉了吗.
_THE = r"(?:the\s+|that\s+|this\s+|those\s+|these\s+|my\s+|all\s+(?:of\s+)?(?:the\s+|my\s+)?)?"
ASKED = Asked(
    r"(?:remove|delete|unpin|take\s+(?:down|off|away)|get\s+rid\s+of|close|clear|drop)\s+"
    rf"{_THE}(?:[\w'-]+\s+){{0,4}}?widgets?\b"
    rf"|(?:take|get|put)\s+{_THE}(?:[\w'-]+\s+){{0,4}}?widgets?\s+(?:off|down|away)\b",
    rf"{lang._NOT_DONE_ZH}(?:"
    r"(?:删除|删掉|移除|取消固定|拿掉|去掉|关掉)[^，,。]{0,12}?(?:小组件|组件|小部件)"
    r"|把[^，,。]{0,12}?(?:小组件|组件|小部件)(?:从[^，,。]{0,10}?)?"
    r"(?:删掉|删除|删了|移除|拿掉|拿下来|去掉|取消固定|关掉)"
    r")",
)

ZH = {
    "Show the widget “{title}” with scripts?": "显示带脚本的小组件“{title}”吗？",
    "This conversation has read your data or a web page, and a widget's scripts can reach a server on the internet. Without scripts it can't.": "这次对话读过你的数据或网页，小组件的脚本可以连到互联网上的服务器；不带脚本就不行。",
    "Take {title} off the dashboard?": "要把 {title} 从仪表板上拿掉吗？",
    "Showed a widget": "显示了一个小组件",
    "Pinned a widget": "固定了一个小组件",
    "Listed the widgets": "列出了小组件",
    "Removed a widget": "移除了一个小组件",
    "The widget has nothing in it.": "这个小组件是空的。",
    "That widget isn't there any more.": "那个小组件已经不在了。",
    "The dashboard holds {n} widgets; remove one first.": "仪表板最多放 {n} 个小组件；请先移除一个。",
    "That widget isn't on the dashboard.": "那个小组件不在仪表板上。",
    "I couldn't save that ({error}).": "没能保存（{error}）。",
}
lang.add_texts(ZH)

PROMPT = (
    "\n- Widgets: show_widget puts a small piece of HTML or SVG you write on a card in the "
    "window, when something reads better on screen than aloud (a chart of the week, a table, "
    "a timeline, a countdown). Make it self-contained: inline styles and SVG, no links, "
    "pictures or fonts from the web (nothing from the network loads), and scripts only when "
    "it needs them (scripts=true). It runs sealed off from everything. The owner can pin it "
    "to the dashboard (pin_widget, or pin=true when they ask for it there); list_widgets and "
    "remove_widget manage the pinned ones. Say briefly that it's on screen; don't read it out."
)
LABELS = {
    "show_widget": "Showed a widget",
    "pin_widget": "Pinned a widget",
    "list_widgets": "Listed the widgets",
    "remove_widget": "Removed a widget",
}


def _text(text: str, error: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
    if error:
        out["is_error"] = True
    return out


class Widgets:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.store = widgets.WidgetStore(hub.feature_path("widgets.json"))

    def tr(self, text: str, **values: Any) -> str:
        return lang.tr(text, self.hub.language, **values)

    def publish(self, error: str = "") -> None:
        self.hub.emit(
            "widgets", pinned=self.store.public(), error=lang.translate(error, self.hub.language)
        )

    # ── the brain ──

    def show(
        self, title: Any, html: Any, *, scripts: bool, height: Any, pin: bool
    ) -> tuple[str, bool]:
        try:
            widget = self.store.add(title, html, scripts=scripts, height=height)
            if pin:
                self.store.pin(widget.id)
        except ValueError as exc:
            return str(exc), True
        self.hub.emit("widget", rid=self.hub._rid, **widget.public())
        if pin:
            self.publish()
        where = "on screen and pinned to the dashboard" if pin else "on screen"
        return f"It's {where} (widget {widget.id}).", False

    async def scripts_ok(self, title: str) -> bool:
        """A widget with scripts, once the conversation has read the owner's data or a page:
        its page policy stops fetches and navigation but not WebRTC, which can reach any
        server, so it asks first (as an address that could carry what was read does)."""
        reads = self.hub._gate_reads()
        if not (reads["private"] or reads["web"]):
            return True
        question = self.tr("Show the widget “{title}” with scripts?", title=title[:80] or "Widget")
        detail = self.tr(
            "This conversation has read your data or a web page, and a widget's scripts can "
            "reach a server on the internet. Without scripts it can't."
        )
        return await self.hub._ask_user(question, detail)

    async def remove(self, which: str) -> tuple[str, bool]:
        found = self.store.find(which)
        if not found:
            return "No pinned widget like that. list_widgets names them.", True
        if len(found) > 1:
            names = ", ".join(f"{w.title} ({w.id})" for w in found[:6])
            return f"More than one fits: {names}. Ask which.", True
        widget = found[0]
        if not ASKED.by_owner(self.hub):
            question = self.tr("Take {title} off the dashboard?", title=widget.title)
            if not await self.hub._ask_user(question):
                return "The owner wanted it kept.", True
        try:
            self.store.remove(widget.id)
        except ValueError as exc:
            return str(exc), True
        self.publish()
        return f"Took {widget.title} off the dashboard.", False

    def build_tools(self) -> list:
        desk = self

        @tool(
            "show_widget",
            "Show a small piece of HTML or SVG on a card in the window: title, html (inline "
            "styles and SVG; nothing from the web loads), optional height in pixels (80-640), "
            "scripts (true only if it needs JavaScript), pin (true when the owner asked for it "
            "on the dashboard).",
            {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "html": {"type": "string"},
                    "height": {"type": "integer"},
                    "scripts": {"type": "boolean"},
                    "pin": {"type": "boolean"},
                },
                "required": ["title", "html"],
            },
        )
        async def show_widget(args):
            scripts = args.get("scripts") is True
            if scripts and not await desk.scripts_ok(str(args.get("title") or "")):
                return _text(
                    "The owner didn't OK a widget with scripts just now. Show it without "
                    "scripts, or not at all; don't try another way.",
                    error=True,
                )
            text, error = desk.show(
                args.get("title"),
                args.get("html"),
                scripts=scripts,
                height=args.get("height"),
                pin=args.get("pin") is True,
            )
            return _text(text, error)

        @tool(
            "pin_widget", "Pin a widget shown on a card to the dashboard, by its id.", {"id": str}
        )
        async def pin_widget(args):
            try:
                widget = desk.store.pin(str(args.get("id", "")))
            except ValueError as exc:
                return _text(str(exc), error=True)
            desk.publish()
            return _text(f"Pinned {widget.title} to the dashboard.")

        @tool("list_widgets", "The widgets pinned to the dashboard: their titles and ids.", {})
        async def list_widgets(_args):
            pinned = desk.store.public()
            if not pinned:
                return _text("Nothing is pinned to the dashboard.")
            return _text("\n".join(f"{w['title']} ({w['id']})" for w in pinned))

        @tool(
            "remove_widget",
            "Take a pinned widget off the dashboard, by its id or words of its title.",
            {"which": str},
        )
        async def remove_widget(args):
            text, error = await desk.remove(str(args.get("which", "")))
            return _text(text, error)

        return [show_widget, pin_widget, list_widgets, remove_widget]

    def build_server(self):
        return create_sdk_mcp_server(name="widgets", version="0.1.0", tools=self.build_tools())

    # ── the window ──

    def state(self, _msg: dict[str, Any]) -> None:
        self.publish()

    def pin(self, msg: dict[str, Any]) -> None:
        try:
            self.store.pin(str(msg.get("id", "")))
        except ValueError as exc:
            self.publish(error=str(exc))
            return
        self.publish()

    def unpin(self, msg: dict[str, Any]) -> None:
        try:
            self.store.remove(str(msg.get("id", "")))
        except ValueError as exc:
            self.publish(error=str(exc))
            return
        self.publish()


def install(hub: Any) -> None:
    desk = Widgets(hub)
    hub.widgets = desk
    hub.register_server(
        "widgets",
        desk.build_server,
        prompt=PROMPT,
        labels=LABELS,
        quiet=("show_widget", "pin_widget", "list_widgets", "remove_widget"),
    )
    hub.register_route(f"{widgets.ROUTE}/{{wid}}", widgets.build_route(desk.store))
    hub.register_command("widgets_state", desk.state)
    hub.register_command("widget_pin", desk.pin)
    hub.register_command("widget_remove", desk.unpin)
