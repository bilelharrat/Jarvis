"""Widgets: small pieces of HTML or SVG that JARVIS makes (a chart of the week, a table, a
countdown) shown on a card in the window, and pinned to the dashboard when the owner wants.

A widget's content is untrusted: JARVIS wrote it, but from pages, notes and mail anyone can
write. So it never runs in the window itself:
- it's served on its own address (/f/widgets/<id>, an id nobody could guess), and the window
  shows it in an iframe with sandbox (never allow-same-origin): its origin is opaque, so it
  can't read the window, its storage or its token, and the window's socket refuses it (the
  socket wants the token and the window's own origin);
- the document carries its own Content-Security-Policy: nothing from the network at all
  (default-src 'none': no fetch, no pictures or fonts but data: ones, no forms, no frames),
  scripts only when the widget asked for them, and the same sandbox again;
- the iframe sends no referrer, so the window's address (and its token) never reaches it;
- only the window may load it (Sec-Fetch-Dest iframe, this Mac's own address);
- a sandboxed frame may still navigate itself (a script setting location, a link), but the
  window's own policy (index.html: default-src 'self') lets its frames show only the
  window's own address, so a widget can't carry what it shows off to another one (the window
  suite has a widget that tries). Keep that policy's frame-src at 'self'.

Pinned widgets are kept in widgets.json beside the settings (MAX_PINNED of them); the rest
live while the app runs (the latest MAX_SHOWN).
"""

from __future__ import annotations

import re
import secrets
from collections import OrderedDict
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from . import jsonstore
from .textclean import clean_text

MAX_HTML = 200_000  # characters of a widget
MAX_PINNED = 12
MAX_SHOWN = 30
MIN_HEIGHT, MAX_HEIGHT, DEFAULT_HEIGHT = 80, 640, 220
ROUTE = "/f/widgets"
_ID = re.compile(r"[A-Za-z0-9_-]{16,40}")

BASE_CSS = """
:root { color-scheme: light dark; }
html, body { margin: 0; padding: 0; background: transparent; }
body { font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  color: #1c1b19; padding: 10px 12px; overflow-wrap: anywhere; }
@media (prefers-color-scheme: dark) { body { color: #ece9e3; } }
svg { max-width: 100%; height: auto; }
table { border-collapse: collapse; }
"""


def csp(scripts: bool) -> str:
    """The widget document's own policy: nothing from anywhere, its own styles, data:
    pictures and fonts, inline scripts only when asked for, and sandboxed again."""
    parts = [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src data:",
        "font-src data:",
        "media-src data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'self'",
        "sandbox allow-scripts" if scripts else "sandbox",
    ]
    if scripts:
        parts.insert(1, "script-src 'unsafe-inline'")
    return "; ".join(parts)


def clean_title(value: Any) -> str:
    return " ".join(clean_text(str(value or "")).split())[:80] or "Widget"


def clean_height(value: Any) -> int:
    try:
        return max(MIN_HEIGHT, min(MAX_HEIGHT, int(value)))
    except (TypeError, ValueError, OverflowError):
        return DEFAULT_HEIGHT


def document(html: str) -> str:
    """A widget's own document: its content in a page with calm, legible defaults."""
    body = html.strip()
    if re.match(r"(?is)^<!doctype html|^<html[\s>]", body):
        return body  # a whole page of its own: served as it is, under the same policy
    return (
        '<!doctype html><html><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<style>{BASE_CSS}</style></head><body>{body}</body></html>"
    )


@dataclass
class Widget:
    id: str
    title: str
    html: str
    scripts: bool = False
    height: int = DEFAULT_HEIGHT
    made: str = ""
    pinned: bool = False

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "url": f"{ROUTE}/{self.id}",
            "scripts": self.scripts,
            "height": self.height,
            "made": self.made,
            "pinned": self.pinned,
        }


class WidgetStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.shown: OrderedDict[str, Widget] = OrderedDict()  # newest last
        self.pinned: list[Widget] = []
        self.unreadable = ""
        self._loaded = False

    def _load(self) -> None:
        """Read at first use (a feature's install reads nothing); a damaged file is kept
        aside and nothing is pinned."""
        if self._loaded:
            return
        self._loaded = True
        try:
            data = jsonstore.load_json(self.path, dict)
        except jsonstore.Unreadable as exc:
            self.unreadable = exc.strerror or "it can't be read"
            return
        items = data.get("pinned") if isinstance(data, dict) else None
        for raw in items if isinstance(items, list) else []:
            if not isinstance(raw, dict) or not _ID.fullmatch(str(raw.get("id", ""))):
                continue
            html = raw.get("html")
            if not isinstance(html, str) or not html.strip() or len(html) > MAX_HTML:
                continue
            self.pinned.append(
                Widget(
                    id=str(raw["id"]),
                    title=clean_title(raw.get("title")),
                    html=html,
                    scripts=raw.get("scripts") is True,
                    height=clean_height(raw.get("height")),
                    made=str(raw.get("made") or "")[:32],
                    pinned=True,
                )
            )
            if len(self.pinned) >= MAX_PINNED:
                break

    def _save(self) -> None:
        if self.unreadable:
            raise jsonstore.refusal(self.path, self.unreadable)
        jsonstore.save_json(self.path, {"version": 1, "pinned": [asdict(w) for w in self.pinned]})

    def add(self, title: Any, html: Any, *, scripts: bool = False, height: Any = None) -> Widget:
        self._load()
        text = str(html or "")
        if not text.strip():
            raise ValueError("The widget has nothing in it.")
        if len(text) > MAX_HTML:
            raise ValueError(f"That widget is too big (over {MAX_HTML:,} characters).")
        widget = Widget(
            id=secrets.token_urlsafe(18),
            title=clean_title(title),
            html=text,
            scripts=bool(scripts),
            height=clean_height(height if height is not None else DEFAULT_HEIGHT),
            made=datetime.now().isoformat(timespec="seconds"),
        )
        self.shown[widget.id] = widget
        while len(self.shown) > MAX_SHOWN:
            self.shown.popitem(last=False)
        return widget

    def get(self, widget_id: str) -> Widget | None:
        self._load()
        found = self.shown.get(widget_id)
        return found or next((w for w in self.pinned if w.id == widget_id), None)

    def pin(self, widget_id: str) -> Widget:
        self._load()
        widget = self.get(widget_id)
        if widget is None:
            raise ValueError("That widget isn't there any more.")
        if widget.pinned:
            return widget
        if len(self.pinned) >= MAX_PINNED:
            raise ValueError(f"The dashboard holds {MAX_PINNED} widgets; remove one first.")
        widget.pinned = True
        self.pinned.append(widget)
        try:
            self._save()
        except OSError as exc:
            widget.pinned = False
            self.pinned.remove(widget)
            raise ValueError(f"I couldn't save that ({exc.strerror or 'disk error'}).") from None
        return widget

    def remove(self, widget_id: str) -> Widget:
        self._load()
        widget = next((w for w in self.pinned if w.id == widget_id), None)
        if widget is None:
            raise ValueError("That widget isn't on the dashboard.")
        before = list(self.pinned)
        self.pinned = [w for w in self.pinned if w.id != widget_id]
        widget.pinned = False
        try:
            self._save()
        except OSError as exc:
            self.pinned = before
            widget.pinned = True
            raise ValueError(f"I couldn't save that ({exc.strerror or 'disk error'}).") from None
        return widget

    def find(self, text: str) -> list[Widget]:
        """Pinned widgets by id or by words of their title."""
        self._load()
        want = str(text or "").strip()
        exact = [w for w in self.pinned if w.id == want]
        if exact:
            return exact
        words = {w for w in re.findall(r"\w+", want.lower()) if w not in ("the", "widget", "my")}
        return [
            w for w in self.pinned if words and words <= set(re.findall(r"\w+", w.title.lower()))
        ]

    def public(self) -> list[dict[str, Any]]:
        self._load()
        return [w.public() for w in self.pinned]


def build_route(store: WidgetStore):
    """GET /f/widgets/{id}: the widget's document, for the window's iframe only."""
    from starlette.requests import Request
    from starlette.responses import HTMLResponse, PlainTextResponse

    async def serve(request: Request):
        port = (request.scope.get("server") or ("", 0))[1]
        host = request.headers.get("host", "")
        if host not in {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}:
            return PlainTextResponse("Not here.", status_code=403)
        if request.headers.get("sec-fetch-dest", "iframe") != "iframe":
            return PlainTextResponse("Widgets show inside Jarvis.", status_code=403)
        widget_id = str(request.path_params.get("wid", ""))
        widget = store.get(widget_id) if _ID.fullmatch(widget_id) else None
        if widget is None:
            return PlainTextResponse("That widget isn't there any more.", status_code=404)
        return HTMLResponse(
            document(widget.html),
            headers={
                "Content-Security-Policy": csp(widget.scripts),
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                "Cache-Control": "no-store",
                "Cross-Origin-Resource-Policy": "same-origin",
                "X-Frame-Options": "SAMEORIGIN",
            },
        )

    return serve
