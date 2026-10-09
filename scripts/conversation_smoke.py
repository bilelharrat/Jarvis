"""A whole conversation, end to end, through the real Claude Code program, against a stand-in for
the Anthropic API on this computer (no key, no network, no cost):

    uv run python scripts/conversation_smoke.py

JARVIS's hub starts Claude Code with its own options (the whole system prompt, every tool), asks
it two things, and the stand-in answers: the first with a sentence; the second with a request to
use the system_status tool, which JARVIS runs on this machine, and then a sentence that carries
what the tool said. It checks that the system prompt and the tools reached the model's side,
that the tool ran, and that the answers came back. Windows runs it in CI: the system prompt is
longer than a Windows command line, which once kept Claude Code from starting at all.

The data folder is the user's own (HOME on a Mac), so run it on a Mac with a throwaway HOME:
    HOME=$(mktemp -d) uv run python scripts/conversation_smoke.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HELLO = "Hello from the stand-in for the Anthropic API."
TOOL_NAME = "mcp__mac__system_status"


def text_of(content) -> str:
    """The words in a message's content (a string, or blocks of text and tool results)."""
    if isinstance(content, str):
        return content
    out = []
    for block in content or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            out.append(block.get("text", ""))
        elif block.get("type") == "tool_result":
            out.append(text_of(block.get("content")))
    return "\n".join(out)


class Handler(BaseHTTPRequestHandler):
    """The few things Claude Code asks of the API: a message (streamed or not) and a token count."""

    def log_message(self, *_args) -> None:
        pass

    def _send(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        self._send(200, {"data": [], "has_more": False})

    def do_POST(self) -> None:  # noqa: N802
        size = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(size) or b"{}")
        except ValueError:
            body = {}
        path = self.path.split("?")[0]
        self.server.seen.append((path, body))  # type: ignore[attr-defined]
        if path.endswith("/count_tokens"):
            return self._send(200, {"input_tokens": 100})
        if not path.endswith("/messages"):
            return self._send(200, {})
        self.answer(body)

    def answer(self, body: dict) -> None:
        # (Claude Code puts system notes in the list after the user's turn: the last user message
        # is the person's words, or the result of the tool the model just asked for.)
        users = [m for m in body.get("messages") or [] if m.get("role") == "user"]
        last = users[-1] if users else {}
        last_text = text_of(last.get("content"))
        results = (
            [b for b in last["content"] if isinstance(b, dict) and b.get("type") == "tool_result"]
            if isinstance(last.get("content"), list)
            else []
        )
        names = {t.get("name") for t in body.get("tools") or []}
        if results:
            blocks = [{"type": "text", "text": f"The tool said: {last_text.strip()}"}]
            stop = "end_turn"
        elif "system_status" in last_text and TOOL_NAME in names:
            blocks = [{"type": "tool_use", "id": "toolu_01standin", "name": TOOL_NAME, "input": {}}]
            stop = "tool_use"
        else:
            blocks = [{"type": "text", "text": HELLO}]
            stop = "end_turn"
        message = {
            "id": "msg_01standin",
            "type": "message",
            "role": "assistant",
            "model": body.get("model") or "claude-standin",
            "content": blocks,
            "stop_reason": stop,
            "stop_sequence": None,
            "usage": {"input_tokens": 100, "output_tokens": 20},
        }
        if not body.get("stream"):
            return self._send(200, message)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()

        def event(kind: str, data: dict) -> None:
            self.wfile.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()

        event(
            "message_start",
            {"type": "message_start", "message": {**message, "content": [], "stop_reason": None}},
        )
        for index, block in enumerate(blocks):
            if block["type"] == "text":
                event(
                    "content_block_start",
                    {
                        "type": "content_block_start",
                        "index": index,
                        "content_block": {"type": "text", "text": ""},
                    },
                )
                event(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": index,
                        "delta": {"type": "text_delta", "text": block["text"]},
                    },
                )
            else:
                start = {**block, "input": {}}
                event(
                    "content_block_start",
                    {"type": "content_block_start", "index": index, "content_block": start},
                )
                event(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": index,
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": json.dumps(block["input"]),
                        },
                    },
                )
            event("content_block_stop", {"type": "content_block_stop", "index": index})
        event(
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": stop, "stop_sequence": None},
                "usage": {"output_tokens": 20},
            },
        )
        event("message_stop", {"type": "message_stop"})


def start_stand_in() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.seen = []  # type: ignore[attr-defined]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def conversation(server: ThreadingHTTPServer) -> list[str]:
    from dataclasses import replace

    from jarvis.config import Settings
    from jarvis.hub import Hub

    hub = Hub(replace(Settings(), bsh_dir=None), poll=False)
    hub.speaker.muted = True
    hub.prefs.hands_free = False
    events: list[tuple[str, dict]] = []
    hub.emit = lambda kind, **data: events.append((kind, data))  # type: ignore[method-assign]
    notes: list[str] = []
    try:
        started = time.monotonic()
        said = await asyncio.wait_for(hub.ask("Say hello."), 240)
        assert HELLO in said, (
            f"the first answer was {said!r}; events {[k for k, _ in events][-12:]}"
        )
        notes.append(f"asked and answered in {time.monotonic() - started:.1f}s")

        first = next(
            (b for p, b in server.seen if p.endswith("/messages") and b.get("system")), None
        )  # type: ignore[attr-defined]
        assert first is not None, "no message reached the stand-in with a system prompt"
        system = text_of(first["system"])
        assert "JARVIS" in system and len(system) > 20_000, (
            f"system prompt of {len(system)} characters"
        )
        tools = {t.get("name") for t in first.get("tools") or []}
        assert TOOL_NAME in tools, f"JARVIS's tools were not offered: {sorted(tools)[:8]}"
        if (
            sys.platform == "win32"
        ):  # what a PC is meant to offer: the calendar, reminders and the file tools
            wanted = [
                "mcp__mac__list_events",
                "mcp__mac__find_free_slots",
                "mcp__mac__create_event",
                "mcp__mac__edit_event",
                "mcp__mac__remove_event",
                "mcp__file_actions__move_files",
                "mcp__file_actions__rename_file",
                "mcp__file_actions__trash_files",
                "mcp__file_actions__undo_file_action",
                "mcp__reminders__list_reminders",
                "mcp__reminders__add_to_reminders",
            ]
            missing = [t for t in wanted if t not in tools]
            assert not missing, f"tools a PC should have, that were not offered: {missing}"
            assert not any(t.startswith("mcp__messages__") for t in tools), (
                "a text-sending tool is offered on a PC, where texts are not set up"
            )
            print(
                "servers offered:",
                sorted({t.split("__")[1] for t in tools if t.startswith("mcp__")}),
                flush=True,
            )
        notes.append(
            f"the model's side got a system prompt of {len(system)} characters and {len(tools)} tools"
        )

        said = await asyncio.wait_for(
            hub.ask("Use the system_status tool and tell me what it says."), 240
        )
        assert "The tool said:" in said and "Local time" in said, f"the tool's answer was {said!r}"
        notes.append(f"a tool ran on this machine and its words came back: {said[:90]!r}")
    finally:
        client = getattr(hub, "client", None)
        if client is not None:
            await client.disconnect()
    return notes


def main() -> int:
    server = start_stand_in()
    os.environ["ANTHROPIC_BASE_URL"] = f"http://127.0.0.1:{server.server_address[1]}"
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-api03-stand-in-not-a-real-key"
    for name in (
        "DISABLE_TELEMETRY",
        "DISABLE_ERROR_REPORTING",
        "DISABLE_AUTOUPDATER",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    ):
        os.environ[name] = "1"
    os.environ.pop("CLAUDECODE", None)
    try:
        for line in asyncio.run(conversation(server)):
            print("ok    ", line, flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED {type(exc).__name__}: {exc}", flush=True)
        print(
            f"requests the stand-in saw: {[(p, len(json.dumps(b))) for p, b in server.seen][:12]}",
            flush=True,
        )  # type: ignore[attr-defined]
        return 1
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
