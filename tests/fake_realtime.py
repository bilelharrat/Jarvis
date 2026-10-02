"""A stand-in for the realtime providers in tests: a local WebSocket server (127.0.0.1, a
free port) speaking enough of OpenAI's Realtime and Gemini Live protocols. No network, no
model: it answers loud audio followed by quiet with a burst of "speech", and a user text
or a transcript asking something with an ask_jarvis call.

    server = await FakeRealtime.start("openai")   # or "gemini"
    server.url                                     # ws://127.0.0.1:<port>
    server.received                                # every message it got (decoded JSON)
"""

from __future__ import annotations

import asyncio
import base64
import json
from typing import Any

import numpy as np
from websockets.asyncio.server import serve

REPLY = (np.sin(np.arange(2400) / 3) * 8000).astype("<i2").tobytes()  # 0.1 s at 24 kHz


def loud(seconds: float = 0.05, rate: int = 16000) -> np.ndarray:
    return (np.sin(np.arange(int(rate * seconds)) / 4) * 0.3).astype(np.float32)


def quiet(seconds: float = 0.05, rate: int = 16000) -> np.ndarray:
    return np.zeros(int(rate * seconds), dtype=np.float32)


class FakeRealtime:
    def __init__(self, kind: str) -> None:
        self.kind = kind
        self.received: list[dict[str, Any]] = []
        self.headers: dict[str, str] = {}
        self.path = ""
        self.transcript = "what's on tomorrow"  # what it "heard" the owner say
        self.tool_request = "what's on tomorrow"
        self.refuse_setup = False
        self.closed = asyncio.Event()
        self._server: Any = None
        self.url = ""

    @classmethod
    async def start(cls, kind: str) -> FakeRealtime:
        fake = cls(kind)
        fake._server = await serve(fake._handle, "127.0.0.1", 0)
        port = fake._server.sockets[0].getsockname()[1]
        fake.url = f"ws://127.0.0.1:{port}"
        return fake

    async def stop(self) -> None:
        self._server.close()
        await self._server.wait_closed()

    def of_type(self, kind: str) -> list[dict[str, Any]]:
        if self.kind == "openai":
            return [m for m in self.received if m.get("type") == kind]
        return [m for m in self.received if kind in m]

    async def _handle(self, ws) -> None:
        self.headers = dict(ws.request.headers)
        self.path = ws.request.path
        loud_blocks = 0
        try:
            async for raw in ws:
                message = json.loads(raw)
                self.received.append(message)
                if self.kind == "openai":
                    loud_blocks = await self._openai(ws, message, loud_blocks)
                else:
                    loud_blocks = await self._gemini(ws, message, loud_blocks)
        except Exception:
            pass
        finally:
            self.closed.set()

    # ── OpenAI ──

    async def _openai(self, ws, message: dict[str, Any], loud_blocks: int) -> int:
        kind = message.get("type")

        async def send(m):
            await ws.send(json.dumps(m))

        if kind == "session.update":
            if self.refuse_setup:
                error = {"code": "invalid_api_key", "message": "bad key"}
                await send({"type": "error", "error": error})
                return loud_blocks
            await send({"type": "session.updated", "session": {}})
        elif kind == "input_audio_buffer.append":
            pcm = np.frombuffer(base64.b64decode(message["audio"]), dtype="<i2")
            if np.abs(pcm).mean() > 500:
                if loud_blocks == 0:
                    await send({"type": "input_audio_buffer.speech_started"})
                return loud_blocks + 1
            if loud_blocks >= 3:  # speech, then quiet: it "answers"
                await send(
                    {
                        "type": "conversation.item.input_audio_transcription.completed",
                        "transcript": self.transcript,
                    }
                )
                if "ask" in self.transcript or "tomorrow" in self.transcript:
                    await self._openai_call(send)
                else:
                    await self._openai_reply(send)
            return 0
        elif kind == "conversation.item.create":
            item = message["item"]
            if item.get("type") == "message":
                self.tool_request = item["content"][0]["text"]
                await self._openai_call(send)
            elif item.get("type") == "function_call_output":
                await self._openai_reply(send)
        return loud_blocks

    async def _openai_call(self, send) -> None:
        await send(
            {
                "type": "response.function_call_arguments.done",
                "call_id": "call_1",
                "name": "ask_jarvis",
                "arguments": json.dumps({"request": self.tool_request}),
            }
        )
        await send({"type": "response.done"})

    async def _openai_reply(self, send) -> None:
        delta = base64.b64encode(REPLY).decode()
        for _ in range(3):
            await send({"type": "response.output_audio.delta", "delta": delta})
        await send({"type": "response.output_audio_transcript.delta", "delta": "Two meetings."})
        await send({"type": "response.output_audio_transcript.done", "transcript": "Two meetings."})
        await send({"type": "response.done"})

    # ── Gemini ──

    async def _gemini(self, ws, message: dict[str, Any], loud_blocks: int) -> int:
        async def send(m):
            await ws.send(json.dumps(m).encode())  # binary frames, as Google sends them

        if "setup" in message:
            await send({"setupComplete": {}})
        elif "realtimeInput" in message:
            data = message["realtimeInput"]["audio"]["data"]
            pcm = np.frombuffer(base64.b64decode(data), "<i2")
            if np.abs(pcm).mean() > 500:
                return loud_blocks + 1
            if loud_blocks >= 3:
                await send({"serverContent": {"inputTranscription": {"text": self.transcript}}})
                await self._gemini_call(send)
            return 0
        elif "clientContent" in message:
            self.tool_request = message["clientContent"]["turns"][0]["parts"][0]["text"]
            await self._gemini_call(send)
        elif "toolResponse" in message:
            data = base64.b64encode(REPLY).decode()
            part = {"inlineData": {"mimeType": "audio/pcm;rate=24000", "data": data}}
            await send({"serverContent": {"modelTurn": {"parts": [part, part]}}})
            done = {"outputTranscription": {"text": "Two meetings."}, "turnComplete": True}
            await send({"serverContent": done})
        return loud_blocks

    async def _gemini_call(self, send) -> None:
        call = {"id": "fc_1", "name": "ask_jarvis", "args": {"request": self.tool_request}}
        await send({"toolCall": {"functionCalls": [call]}})


class FakePlayer:
    """The live player's surface: what was written, and barge-in's stop."""

    def __init__(self, rate: int = 24000) -> None:
        self.rate = rate
        self.alive = True
        self.written: list[bytes] = []
        self.stops = 0
        self.first_at: float | None = None

    async def write(self, pcm: bytes) -> None:
        if self.first_at is None:
            self.first_at = asyncio.get_running_loop().time()
        self.written.append(pcm)

    def stop_now(self) -> None:
        self.stops += 1
