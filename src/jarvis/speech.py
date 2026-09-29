"""Text-to-speech with the macOS `say` command."""

from __future__ import annotations

import asyncio
import re
import subprocess

_CODE_BLOCK = re.compile(r"```.*?```", re.DOTALL)
_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_URL = re.compile(r"https?://\S+")
_BULLET = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+", re.MULTILINE)
_HEADING = re.compile(r"^\s*#{1,6}\s*", re.MULTILINE)
_EMPHASIS = re.compile(r"[*_`~]+")


def clean_for_speech(text: str) -> str:
    """Turn a markdown-ish reply into something that sounds natural aloud."""
    text = _CODE_BLOCK.sub(" I've put the details on screen. ", text)
    text = _LINK.sub(r"\1", text)
    text = _URL.sub("the link on screen", text)
    text = _HEADING.sub("", text)
    text = _BULLET.sub("", text)
    text = _EMPHASIS.sub("", text)
    text = re.sub(r"\s*\n+\s*", ". ", text.strip())
    text = re.sub(r"([.!?])\.\s", r"\1 ", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def available_voices() -> set[str]:
    try:
        out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return set()
    return {line.split("  ")[0].strip() for line in out.splitlines() if line.strip()}


class Speaker:
    def __init__(self, voice: str, rate: int, muted: bool = False) -> None:
        self.voice = voice if voice in available_voices() else ""
        self.rate = rate
        self.muted = muted

    async def say(self, text: str) -> None:
        spoken = clean_for_speech(text)
        if self.muted or not spoken:
            return
        args = ["say", "-r", str(self.rate)]
        if self.voice:
            args += ["-v", self.voice]
        # Text goes over stdin so a reply starting with "-" is never read as a flag.
        proc = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE)
        try:
            await proc.communicate(spoken.encode())
        except asyncio.CancelledError:
            proc.kill()
            raise
