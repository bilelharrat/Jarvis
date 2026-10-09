"""The conversation loop: listen (or read typed text), think, speak."""

from __future__ import annotations

import argparse
import asyncio
import sys

# The Agent SDK, the brain and the voice are imported where they're used, not here: Claude
# Code and Claude Desktop start `jarvis mcp` for each session, and it needs none of them
# (importing them first took most of a second before it could answer).

EXIT_WORDS = {"q", "quit", "exit", "goodbye", "goodbye jarvis", "shut down"}
DIM, CYAN, RESET = "\033[2m", "\033[36m", "\033[0m"


def is_exit(text: str) -> bool:
    return text.strip().lower().rstrip(".!") in EXIT_WORDS


async def ask_line(prompt: str) -> str:
    return (await asyncio.to_thread(input, prompt)).strip()


async def run(text_mode: bool, muted: bool) -> None:
    from claude_agent_sdk import (
        AssistantMessage,
        ClaudeSDKClient,
        ResultMessage,
        TextBlock,
        ToolUseBlock,
    )

    from .brain import build_options
    from .config import load_settings
    from .speech import Speaker

    settings = load_settings()
    speaker = Speaker(settings.voice, settings.speech_rate, muted=muted)
    transcriber = None
    if not text_mode:
        from .listen import Transcriber

        transcriber = Transcriber(settings.whisper_model)
        transcriber.warm_up()

    async def confirm(question: str) -> bool:
        print(f"{CYAN}JARVIS:{RESET} {question}")
        await speaker.say(question)
        return (await ask_line("  [y/N] ")).lower() in {"y", "yes"}

    options = build_options(settings, confirm)
    tools = ", ".join(sorted(options.mcp_servers))
    print(f"{DIM}JARVIS · {settings.model} · tools: {tools}, web{RESET}")
    hint = "Type a message" if text_mode else "Press Enter and speak, or type a message"
    print(f"{DIM}{hint}. 'q' quits.{RESET}\n")

    async with ClaudeSDKClient(options=options) as client:
        await speaker.say("At your service.")
        while True:
            utterance = await next_utterance(text_mode, transcriber, settings.silence_seconds)
            if not utterance:
                continue
            if is_exit(utterance):
                await speaker.say("Goodbye.")
                return
            await client.query(utterance)
            async for message in client.receive_response():
                if isinstance(message, AssistantMessage):
                    for block in message.content:
                        if isinstance(block, TextBlock) and block.text.strip():
                            print(f"{CYAN}JARVIS:{RESET} {block.text.strip()}")
                            await speaker.say(block.text)
                        elif isinstance(block, ToolUseBlock):
                            print(f"{DIM}  → {block.name.split('__')[-1]}{RESET}")
                elif isinstance(message, ResultMessage) and message.is_error:
                    detail = "; ".join(message.errors or []) or message.subtype
                    print(f"{DIM}  (error: {detail}){RESET}")
                    await speaker.say("Sorry, something went wrong on my end.")
            print()


async def next_utterance(text_mode: bool, transcriber, silence_seconds: float) -> str:
    typed = await ask_line("You: " if text_mode else "🎙  ")
    if typed or text_mode:
        return typed
    from .listen import record_utterance

    print(f"{DIM}  listening…{RESET}", end="", flush=True)
    audio = await asyncio.to_thread(record_utterance, silence_seconds)
    if audio is None:
        print(f"\r{DIM}  (didn't catch anything){RESET}")
        return ""
    print(f"\r{DIM}  transcribing…{RESET}", end="", flush=True)
    heard = await asyncio.to_thread(transcriber.transcribe, audio)
    print(f"\r\033[KYou: {heard}")
    return heard


async def say_line(text: str) -> None:
    from .config import load_settings
    from .prefs import PrefsStore
    from .speech import Speaker, cloud_voice_from

    settings = load_settings()
    prefs = PrefsStore().prefs
    speaker = Speaker(
        settings.voice,
        settings.speech_rate,
        effect=prefs.voice_effect,
        cloud=cloud_voice_from(settings),
    )
    source = (
        f"{settings.tts} voice {settings.tts_voice_id}"
        if speaker.cloud
        else f"Mac voice {speaker.voice or 'default'}"
    )
    print(f"Speaking with the {source}{' + AI effect' if prefs.voice_effect else ''}…")
    await speaker.say(text)
    if speaker.cloud_error:
        print(f"The cloud voice failed, so the Mac voice spoke instead: {speaker.cloud_error}")


async def pair(port: int) -> int:
    """Ask a running backend (no window: a cloud server) for an iPhone pairing code, and show
    its link and QR code in the terminal."""
    import json
    import os

    from websockets.asyncio.client import connect

    from . import qr
    from .packaged import TOKEN_ENV

    token = os.environ.get(TOKEN_ENV, "")
    if not token:
        print(f"Set {TOKEN_ENV} to the backend's token.")
        return 2
    address = f"127.0.0.1:{port}"
    async with connect(f"ws://{address}/ws?token={token}", origin=f"http://{address}") as ws:
        await ws.send(json.dumps({"type": "remote_pair"}))
        await ws.send(json.dumps({"type": "companion_pairing"}))
        async with asyncio.timeout(20):
            async for raw in ws:
                event = json.loads(raw)
                if event.get("type") != "companion_pairing":
                    continue
                if event.get("error"):
                    print(event["error"])
                    return 1
                url = str(event.get("url") or "")
                print(qr_text(qr.encode(url)))
                print(
                    f"Scan it in J.A.R.V.I.S. on the iPhone (Pair › Scan code) within "
                    f"{event.get('seconds', 300)} s.\n{url}"
                )
                return 0
    return 1


def qr_text(modules: list[list[bool]], quiet: int = 2) -> str:
    """A QR code for a terminal: two rows of modules a line, dark on a white background."""
    size = len(modules)
    grid = [[False] * (size + 2 * quiet) for _ in range(quiet)]
    grid += [[False] * quiet + list(row) + [False] * quiet for row in modules]
    grid += [[False] * (size + 2 * quiet) for _ in range(quiet + 1)]
    lines = []
    for top, bottom in zip(grid[0::2], grid[1::2], strict=False):
        cells = "".join(
            "█" if a and b else "▀" if a else "▄" if b else " "
            for a, b in zip(top, bottom, strict=True)
        )
        lines.append(f"\x1b[30;47m{cells}\x1b[0m")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(prog="jarvis", description="A voice assistant for your Mac.")
    parser.add_argument("--text", action="store_true", help="type instead of speaking")
    parser.add_argument("--mute", action="store_true", help="don't speak replies aloud")
    parser.add_argument(
        "command",
        nargs="?",
        choices=["serve", "say", "mcp", "pair"],
        help="serve: run the backend for the app. say: speak a line in JARVIS's voice. mcp: "
        "JARVIS's tools for Claude Code or Claude Desktop, over stdio (the app must be running). "
        "pair: a pairing code for the iPhone from a running backend with no window (a cloud "
        "server; --port is its port, JARVIS_TOKEN its token), shown as a QR code here",
    )
    parser.add_argument("words", nargs="*", help="what to say (with the say command)")
    parser.add_argument("--port", type=int, default=8765, help="port for serve")
    args = parser.parse_args()
    if args.command == "mcp":
        from .mcp_bridge import main as mcp_main

        mcp_main()  # stdout is the protocol's alone from here
        return
    if args.command == "pair":
        sys.exit(asyncio.run(pair(args.port)))
    if args.command == "say":
        asyncio.run(say_line(" ".join(args.words) or "Good evening. All systems are online."))
        return
    if args.command == "serve":
        import faulthandler
        import secrets
        import signal

        from .packaged import take_token

        # `kill -USR1 <pid>` writes every thread's stack to the backend's log: what a busy or
        # stuck backend is doing, without stopping it.
        if hasattr(signal, "SIGUSR1"):
            faulthandler.register(signal.SIGUSR1, all_threads=True)
        from .server import serve

        # The app passes its own token; a manual run gets a fresh one. It's taken out of the
        # environment: nothing this backend starts (sessions, terminals, dev servers) gets it.
        serve(args.port, take_token() or secrets.token_urlsafe(24))
        return
    from claude_agent_sdk import CLINotFoundError

    try:
        asyncio.run(run(text_mode=args.text, muted=args.mute))
    except KeyboardInterrupt:
        print()
    except CLINotFoundError:
        sys.exit("JARVIS needs Claude Code installed and signed in: https://claude.com/claude-code")
