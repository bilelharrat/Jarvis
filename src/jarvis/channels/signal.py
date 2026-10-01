"""Signal: talking to JARVIS from the owner's own Signal, through signal-cli linked to their
account as a secondary device (the way Signal Desktop is). JARVIS never installs signal-cli
or links it: Settings › Chats finds it on this Mac (Homebrew's, or on the PATH), lists the
accounts linked in it, and explains the setup when there's none.

It runs signal-cli's JSON-RPC daemon on its standard input and output (signal-cli -a
<number> jsonRpc): JSON-RPC requests in, results and "receive" notifications out. No port is
opened and nothing on the Mac listens to anyone.

Only the owner counts, and only their "Note to Self" chat: a message the owner sends to
their own number from their phone reaches this linked device as a sync of a sent message,
and nothing anyone else writes there is possible. A message from anyone else is theirs to
answer, never JARVIS's: never read as a request, never replied to. JARVIS writes back to the
owner's own number (signal-cli asked to notify, so the phone shows it), each message
starting with "Jarvis:". Approval cards come as words and are answered by a reply (yes, no,
"no, because …", or a quoted reply to the card); /code and the other commands work as in
Telegram. Text only: attachments aren't read here.

Cost: none of its own; a request is one normal JARVIS turn.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import os
import re
import shutil
import time
from collections import deque
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from .base import Channel, Inbound, clip, plain_text, split_text
from .words import NEEDS_OK, TEXT_ONLY, hint_for, say

log = logging.getLogger("jarvis")

TAG = "Jarvis:"
LIMIT = 4000
DETAIL = 600
CLI_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")
LIST_TIMEOUT = 60.0  # signal-cli starts a Java VM: listing accounts takes a few seconds
REQUEST_TIMEOUT = 60.0
LINE_LIMIT = 8 * 1024 * 1024
TEXT_ONLY_EVERY = 600.0
_NUMBER = re.compile(r"^\+[1-9]\d{6,14}$")


class SignalError(Exception):
    def __init__(self, message: str, code: int = 0) -> None:
        super().__init__(message)
        self.code = code


class SignalGone(Exception):
    """signal-cli ended, or never started."""


def find_cli() -> str | None:
    """signal-cli, where a Dock-launched app's PATH wouldn't find it too."""
    for path in [shutil.which("signal-cli"), *(f"{d}/signal-cli" for d in CLI_DIRS)]:
        if path and os.access(path, os.X_OK):
            return path
    return None


def parse_accounts(output: str) -> list[str]:
    """The numbers in `signal-cli -o json listAccounts` (or its plain "Number: +1…" lines)."""
    found: list[str] = []
    try:
        data = json.loads(output)
    except ValueError:
        data = None
    if isinstance(data, list):
        for item in data:
            number = item.get("number") if isinstance(item, dict) else item
            if isinstance(number, str):
                found.append(number.strip())
    else:
        found = re.findall(r"\+[1-9]\d{6,14}", output or "")
    return list(dict.fromkeys(n for n in found if _NUMBER.fullmatch(n)))


async def run_cli(argv: list[str], timeout: float) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        return 124, "timed out"
    return proc.returncode or 0, out.decode(errors="replace")


class Daemon:
    """signal-cli's JSON-RPC daemon on stdin/stdout: request() waits for its result; each
    notification goes to on_notice."""

    def __init__(self, proc: Any, on_notice: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        self.proc = proc
        self.on_notice = on_notice
        self.pending: dict[int, asyncio.Future] = {}
        self.ids = itertools.count(1)
        self.errors: deque[str] = deque(maxlen=20)
        self.reader = asyncio.get_running_loop().create_task(self._read())
        self.drainer = asyncio.get_running_loop().create_task(self._drain())

    @classmethod
    async def start(
        cls, argv: list[str], on_notice: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> Daemon:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=LINE_LIMIT,
        )
        return cls(proc, on_notice)

    async def _read(self) -> None:
        try:
            while line := await self.proc.stdout.readline():
                try:
                    packet = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(packet, dict):
                    continue
                if "id" in packet and ("result" in packet or "error" in packet):
                    future = self.pending.pop(packet.get("id"), None)
                    if future is not None and not future.done():
                        future.set_result(packet)
                elif packet.get("method"):
                    try:
                        await self.on_notice(packet)
                    except Exception as exc:  # one odd notice never stops the rest
                        log.warning("signal: couldn't handle a message (%s)", type(exc).__name__)
        except ValueError:
            log.warning("signal: signal-cli sent a line too long to read")
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(SignalGone())
            self.pending.clear()

    async def _drain(self) -> None:
        while line := await self.proc.stderr.readline():
            self.errors.append(line.decode(errors="replace").rstrip())

    async def request(self, method: str, params: dict[str, Any], timeout: float = REQUEST_TIMEOUT):
        if self.proc.returncode is not None or self.reader.done():
            raise SignalGone()
        req = next(self.ids)
        future = asyncio.get_running_loop().create_future()
        self.pending[req] = future
        packet = {"jsonrpc": "2.0", "method": method, "params": params, "id": req}
        try:
            self.proc.stdin.write((json.dumps(packet) + "\n").encode())
            await self.proc.stdin.drain()
            answer = await asyncio.wait_for(future, timeout)
        except (BrokenPipeError, ConnectionResetError) as exc:
            raise SignalGone() from exc
        finally:
            self.pending.pop(req, None)
        if "error" in answer:
            error = answer.get("error") if isinstance(answer.get("error"), dict) else {}
            raise SignalError(
                str(error.get("message") or "error")[:200], int(error.get("code") or 0)
            )
        return answer.get("result")

    async def wait(self) -> int:
        code = await self.proc.wait()
        await asyncio.gather(self.reader, self.drainer, return_exceptions=True)
        return code

    async def stop(self) -> None:
        if self.proc.returncode is None:
            with contextlib.suppress(Exception):
                self.proc.stdin.close()
            try:
                await asyncio.wait_for(self.proc.wait(), 5)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    self.proc.kill()
        await self.wait()


class Signal(Channel):
    name = "signal"
    title = "Signal"
    limit = LIMIT
    buttons = False
    pairs = False
    max_file = 100_000_000

    def __init__(self, router: Any) -> None:
        super().__init__(router)
        self.find: Callable[[], str | None] = find_cli  # tests: a fake path
        self.list_run: Callable[[list[str], float], Awaitable[tuple[int, str]]] = run_cli
        self.start: Callable[..., Awaitable[Any]] = Daemon.start  # tests: a fake daemon
        self.cli: str | None = None
        self.looked = False  # looked for signal-cli
        self.listed = False  # asked it for its accounts (Settings, when its card opens)
        self.accounts: list[str] = []
        self.problem = ""
        self.daemon: Any = None
        self.sent: deque[int] = deque(maxlen=500)  # timestamps of what JARVIS sent
        self._told_text_only = -1e18

    # ── set-up: found on this Mac, and which linked account ──

    def _real_offline(self) -> bool:
        """A hub that doesn't poll (the tests') never runs the real signal-cli."""
        return self.router.offline and (
            self.find is find_cli or self.list_run is run_cli or self.start == Daemon.start
        )

    def account(self) -> str:
        return self.router.state.bots.get(self.name, {}).get("id", "")

    def ready(self) -> bool:
        if not self.looked:
            self.looked = True
            self.cli = None if self._real_offline() else self.find()
        return bool(self.cli and self.account())

    def home_chat(self) -> str | None:
        return self.account() or None

    def save_secrets(self, secrets_: dict[str, str]) -> None:
        pass

    def forget_secrets(self) -> None:
        pass  # signal-cli keeps its link; Jarvis only stops using it

    async def verify(self, secrets_: dict[str, str]) -> dict[str, str]:
        raise ValueError("Pick the Signal account below.")

    async def look(self) -> None:
        """Find signal-cli and the accounts linked in it (a few seconds: it's Java)."""
        self.cli = None if self._real_offline() else await asyncio.to_thread(self.find)
        self.looked = self.listed = True
        self.accounts, self.problem = [], ""
        if self.cli is None:
            return
        code, output = await self.list_run([self.cli, "-o", "json", "listAccounts"], LIST_TIMEOUT)
        if code != 0:
            self.problem = "signal-cli couldn't list its accounts."
            log.info("signal: listAccounts failed (%s)", code)
            return
        self.accounts = parse_accounts(output)

    async def configure(self, msg: dict[str, Any]) -> None:
        """Settings › Chats: look again, and use the account picked (one linked in it)."""
        await self.look()
        wanted = str(msg.get("account") or "").strip()
        if not wanted:
            return
        if self.cli is None:
            raise ValueError("signal-cli isn't on this Mac.")
        if wanted not in self.accounts:
            raise ValueError("That account isn't linked in signal-cli.")
        self.router.state.bots[self.name] = {"id": wanted, "name": wanted}
        self.halted = False
        self.router.audit(self.name, "you", "connected")
        self.router.set_on(self.name, True)

    def public(self) -> dict[str, Any]:
        return {
            "found": bool(self.cli),
            "looked": self.listed,
            "accounts": list(self.accounts),
            "account": self.account(),
            "problem": self.problem,
            "how": "Jarvis,",
        }

    # ── the daemon ──

    async def run(self) -> None:
        account, cli = self.account(), self.cli
        if not account or not cli:
            self.set_state("needs_setup")
            return
        self.daemon = await self.start([cli, "-a", account, "jsonRpc"], self._notice)
        self.set_state("listening")
        try:
            code = await self.daemon.wait()
        finally:
            daemon, self.daemon = self.daemon, None
            if daemon is not None:
                with contextlib.suppress(Exception):
                    await daemon.stop()
        tail = " ".join(list(getattr(daemon, "errors", []))[-2:])[:200]
        log.warning("signal: signal-cli stopped (exit %s) %s", code, tail)
        raise SignalGone()

    async def _notice(self, packet: dict[str, Any]) -> None:
        if packet.get("method") != "receive":
            return
        params = packet.get("params") if isinstance(packet.get("params"), dict) else {}
        msg = self.parse(params)
        if msg is not None:
            await self.router.receive(msg)

    def parse(self, params: dict[str, Any]) -> Inbound | None:
        """A note to self from the owner's phone, as the router takes it; None for the rest
        (anyone else's message, receipts, typing, JARVIS's own)."""
        account = self.account()
        envelope = params.get("envelope") if isinstance(params.get("envelope"), dict) else {}
        if not account or params.get("account", account) != account:
            return None
        source = envelope.get("sourceNumber") or envelope.get("source")
        sync = envelope.get("syncMessage") if isinstance(envelope.get("syncMessage"), dict) else {}
        sent = sync.get("sentMessage") if isinstance(sync.get("sentMessage"), dict) else None
        if sent is None or source != account:
            return None  # someone else's, or not a message: never JARVIS's to answer
        to = sent.get("destinationNumber") or sent.get("destination")
        if to != account or sent.get("groupInfo") or sent.get("groupV2"):
            return None  # the owner writing to someone else
        stamp = sent.get("timestamp")
        text = str(sent.get("message") or "")
        if stamp in self.sent or text.startswith(TAG):
            return None
        if sent.get("attachments") and not text.strip():
            self._text_only(account)
            return None
        quote = sent.get("quote") if isinstance(sent.get("quote"), dict) else {}
        return Inbound(
            channel=self.name,
            chat=account,
            sender=account,
            name="you",
            text=text,
            at=float(stamp or 0) / 1000,
            owner=True,
            reply_to=str(quote.get("id") or ""),
        )

    def _text_only(self, chat: str) -> None:
        now = time.monotonic()
        if now - self._told_text_only < TEXT_ONLY_EVERY:
            return
        self._told_text_only = now
        self.router.spawn(self._say_text_only(chat))

    async def _say_text_only(self, chat: str) -> None:
        with contextlib.suppress(Exception):
            await self.send_text(chat, say(TEXT_ONLY, self.router.language), markup=False)

    # ── sending: always to the owner's own number ──

    async def _send(self, chat: str, params: dict[str, Any]) -> int:
        if self.daemon is None:
            raise SignalGone()
        if chat != self.account():
            raise SignalError("only the owner's own number")
        base = {"recipient": [chat], **params}
        try:
            result = await self.daemon.request("send", {**base, "notifySelf": True})
        except SignalError:  # an older signal-cli without --notify-self
            result = await self.daemon.request("send", base)
        stamp = (result or {}).get("timestamp") if isinstance(result, dict) else None
        if isinstance(stamp, int):
            self.sent.append(stamp)
            return stamp
        return 0

    async def send_text(
        self, chat: str, text: str, *, title: str = "", markup: bool = True
    ) -> None:
        body = plain_text(text) if markup else text
        if title:
            body = f"{title}\n{body}"
        for chunk in split_text(body, LIMIT - len(TAG) - 1):
            await self._send(chat, {"message": f"{TAG} {chunk}"})

    async def send_card(self, chat: str, card: dict[str, Any], lang: str) -> Any:
        lines = [f"{say(NEEDS_OK, lang)}: {clip(str(card.get('question', '')), 300)}"]
        detail = str(card.get("detail") or "").strip()
        if detail:
            lines.append(detail if len(detail) <= DETAIL else detail[:DETAIL] + "…")
        lines.append(hint_for(card, lang))
        body = "\n".join(lines)[: LIMIT - len(TAG) - 1]
        return {"id": str(await self._send(chat, {"message": f"{TAG} {body}"}))}

    async def send_file(self, chat: str, path: Path, caption: str = "") -> None:
        message = f"{TAG} {clip(caption, 900)}" if caption else TAG
        await self._send(chat, {"message": message, "attachments": [str(path)]})
