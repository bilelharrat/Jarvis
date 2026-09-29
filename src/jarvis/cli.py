"""The conversation loop: listen (or read typed text), think, speak."""

from __future__ import annotations

import argparse
import asyncio
import sys

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeSDKClient,
    CLINotFoundError,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)

from .brain import build_options
from .config import load_settings
from .speech import Speaker

EXIT_WORDS = {"q", "quit", "exit", "goodbye", "goodbye jarvis", "shut down"}
DIM, CYAN, RESET = "\033[2m", "\033[36m", "\033[0m"


def is_exit(text: str) -> bool:
    return text.strip().lower().rstrip(".!") in EXIT_WORDS


async def ask_line(prompt: str) -> str:
    return (await asyncio.to_thread(input, prompt)).strip()


async def run(text_mode: bool, muted: bool) -> None:
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


def main() -> None:
    parser = argparse.ArgumentParser(prog="jarvis", description="A voice assistant for your Mac.")
    parser.add_argument("--text", action="store_true", help="type instead of speaking")
    parser.add_argument("--mute", action="store_true", help="don't speak replies aloud")
    args = parser.parse_args()
    try:
        asyncio.run(run(text_mode=args.text, muted=args.mute))
    except KeyboardInterrupt:
        print()
    except CLINotFoundError:
        sys.exit("JARVIS needs Claude Code installed and signed in: https://claude.com/claude-code")
