"""Recorded answers of GitLab, Bitbucket, Azure DevOps and Jira, behind httpx.MockTransport.

Each host's answers are in tests/fixtures/githosts/<kind>.json, keyed "METHOD address"
(the address as sent, percent-encoding and all, without its query): an answer is
{status, body | text, headers}, or a list of them given in turn (the last one again after
that). A test may change one (answer()) to play out what happens next. Every request is
recorded; a request with no answer is a 599 and is listed in .missing, so a test that
reaches anything it didn't expect fails loudly. Nothing ever leaves the machine."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import httpx

FIXTURES = Path(__file__).parent / "fixtures" / "githosts"


class Recorded:
    def __init__(self, kind: str) -> None:
        self.kind = kind
        raw = json.loads((FIXTURES / f"{kind}.json").read_text())
        self.answers: dict[str, Any] = {k: v for k, v in raw.items() if not k.startswith("_")}
        self.requests: list[httpx.Request] = []
        self.missing: list[str] = []
        self._turns: dict[str, int] = {}

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def answer(self, key: str, body: Any = None, *, status: int = 200, text: str | None = None,
               headers: dict[str, str] | None = None) -> None:  # fmt: skip
        entry: dict[str, Any] = {"status": status, "headers": headers or {}}
        if text is not None:
            entry["text"] = text
        else:
            entry["body"] = body
        self.answers[key] = entry
        self._turns.pop(key, None)

    def body(self, key: str) -> Any:
        """A recorded answer's body, to change in place."""
        found = self.answers[key]
        return (found[-1] if isinstance(found, list) else found).get("body")

    def sent(self, method: str = "", contains: str = "") -> list[httpx.Request]:
        return [r for r in self.requests
                if (not method or r.method == method) and contains in str(r.url)]  # fmt: skip

    def json_sent(self, method: str, contains: str) -> list[Any]:
        return [json.loads(r.content) for r in self.sent(method, contains) if r.content]

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        address = f"{request.url.scheme}://{request.url.netloc.decode()}{request.url.raw_path.decode().split('?')[0]}"
        key = f"{request.method} {address}"
        found = self.answers.get(key)
        if found is None:
            self.missing.append(key)
            return httpx.Response(599, json={"message": f"no recorded answer for {key}"})
        if isinstance(found, list):
            turn = self._turns.get(key, 0)
            self._turns[key] = turn + 1
            found = found[min(turn, len(found) - 1)]
        found = copy.deepcopy(found)
        headers = found.get("headers") or {}
        if "text" in found:
            return httpx.Response(found.get("status", 200), text=found["text"], headers=headers)
        if found.get("body") is None and found.get("status", 200) in (204, 302, 307):
            return httpx.Response(found["status"], headers=headers)
        return httpx.Response(found.get("status", 200), json=found.get("body"), headers=headers)
