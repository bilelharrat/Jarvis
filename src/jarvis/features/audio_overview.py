"""Audio overviews, as NotebookLM and the Gemini app make them: a short two-host conversation
about a document, a web page or a topic, to listen to like a podcast.

No extra model call: JARVIS's own conversation writes the dialogue (it has read the document)
and hands it to make_audio_overview, which voices each line with one of two of the Mac's own
voices (`say`, Premium voices first when installed), joins them with a breath between turns,
and saves an .m4a in Documents › Jarvis › Audio (afconvert), shown in Finder. On a PC Windows' own voices
read it (winsay, System.Speech) and it is saved as a .wav, shown in File Explorer.

Claude cost policy: no model is called here; the dialogue is the conversation's own answer.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import subprocess
import tempfile
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

log = logging.getLogger("jarvis")

MAX_LINES = 120
MAX_LINE = 1200
PAUSE_SECONDS = 0.35
RATE = 22050
RENDERERS = 4  # lines voiced at once (each `say` mostly keeps one core busy)
# Two hosts, a contrast in voice: the best installed first.
HOST_A_PC = ("Microsoft Aria", "Microsoft Jenny", "Microsoft Zira", "Microsoft Hazel", "Microsoft Susan")
HOST_B_PC = ("Microsoft Guy", "Microsoft Mark", "Microsoft David", "Microsoft George", "Microsoft Ryan")
HOST_A = ("Ava (Premium)", "Zoe (Premium)", "Ava (Enhanced)", "Samantha", "Flo", "Shelley")
HOST_B = ("Evan (Premium)", "Nathan (Premium)", "Evan (Enhanced)", "Daniel", "Reed", "Eddy")


def folder() -> Path:
    from .. import osplat

    return osplat.personal_folders()[0] / "Jarvis" / "Audio"


def installed_voices() -> list[str]:
    from .. import osplat

    if osplat.IS_WIN:
        from .. import winsay

        try:
            return [name for name, _culture in winsay.voices()]
        except (OSError, subprocess.SubprocessError):
            return []
    try:
        out = subprocess.run(
            ["/usr/bin/say", "-v", "?"], capture_output=True, text=True, timeout=10
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return [name for name in (voice_name(line) for line in out.splitlines()) if name]


def voice_name(line: str) -> str:
    """A voice's name from a line of `say -v ?`: "Samantha (English (US)) en_US    # Hello…"."""
    head = line.split("#", 1)[0].strip()
    return re.sub(r"\s+[a-z]{2,3}_[A-Za-z0-9]{2,4}$", "", head).strip()


def pick_voices(installed: list[str]) -> tuple[str, str]:
    """Two different voices: each host's first choice that's installed."""
    names = set(installed)
    base = {n.split(" (")[0]: n for n in installed}

    def first(choices: tuple[str, ...], avoid: str) -> str:
        for want in choices:
            found = want if want in names else base.get(want)
            if found and found != avoid:
                return found
        return next((n for n in installed if n != avoid), "")

    a = first(HOST_A + HOST_A_PC, "")
    return a, first(HOST_B + HOST_B_PC, a)


def clean_lines(raw: Any) -> list[tuple[int, str]]:
    """(host 0 or 1, words) for each line of the dialogue, at most MAX_LINES."""
    out: list[tuple[int, str]] = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        words = " ".join(str(item.get("text") or "").split())[:MAX_LINE]
        if not words:
            continue
        who = str(item.get("speaker") or "A").strip().upper()
        out.append((1 if who in ("B", "2", "HOST B") else 0, words))
        if len(out) >= MAX_LINES:
            break
    return out


def file_name(title: str, where: Path, ext: str = ".m4a") -> Path:
    safe = re.sub(r'[/\\:*?"<>|]+', "", title).strip()[:80] or "Audio overview"
    path = where / f"{safe}{ext}"
    n = 2
    while path.exists():
        path = where / f"{safe} ({n}){ext}"
        n += 1
    return path


def _voice_line(voice: str, words: str, part: Path) -> None:
    from .. import osplat

    if osplat.IS_WIN:
        import sys

        from .. import winsay

        subprocess.run(
            [sys.executable, "-I", "-m", "jarvis.winsay", "-v", voice, f"--data-format=LEI16@{RATE}", "-o", str(part)],
            input=words.encode("utf-8"), check=True, capture_output=True, timeout=120,
            creationflags=winsay.NO_WINDOW,
        )  # fmt: skip
        return
    subprocess.run(
        ["/usr/bin/say", "-v", voice, "--file-format=WAVE", f"--data-format=LEI16@{RATE}",
         "-o", str(part), "--", words],
        check=True, capture_output=True, timeout=120,
    )  # fmt: skip


def render(lines: list[tuple[int, str]], voices: tuple[str, str], out: Path) -> Path:
    """Voices each line, joins them with a pause, and writes out (an .m4a). Blocking.

    RENDERERS lines are voiced at once, each into a file of its own: one after another, an
    overview of a hundred lines took minutes. They're joined in their order as before, and
    the first line that fails (in that order) is the error, as it was."""
    with tempfile.TemporaryDirectory() as tmp:
        parts = [Path(tmp) / f"{i:03d}.wav" for i in range(len(lines))]
        with ThreadPoolExecutor(RENDERERS, thread_name_prefix="jarvis-overview") as pool:
            jobs = [
                pool.submit(_voice_line, voices[host], words, part)
                for (host, words), part in zip(lines, parts, strict=True)
            ]
            try:
                for job in jobs:
                    job.result()
            except BaseException:
                for job in jobs:
                    job.cancel()  # what hasn't started never does; the rest finish first
                raise
        joined = Path(tmp) / "all.wav"
        silence = b"\x00\x00" * int(RATE * PAUSE_SECONDS)
        with wave.open(str(joined), "wb") as dest:
            dest.setnchannels(1)
            dest.setsampwidth(2)
            dest.setframerate(RATE)
            for part in parts:
                with wave.open(str(part), "rb") as src:
                    dest.writeframes(src.readframes(src.getnframes()))
                dest.writeframes(silence)
        out.parent.mkdir(parents=True, exist_ok=True)
        if out.suffix == ".wav":  # a PC: the joined file is the overview (no afconvert there)
            import shutil

            shutil.copyfile(joined, out)
            return out
        subprocess.run(
            ["/usr/bin/afconvert", "-f", "m4af", "-d", "aac", str(joined), str(out)],
            check=True, capture_output=True, timeout=300,
        )  # fmt: skip
    return out


class AudioOverview:
    def __init__(self, hub: Any) -> None:
        self.hub = hub

    async def make(self, title: str, raw_lines: Any) -> tuple[str, bool]:
        lines = clean_lines(raw_lines)
        if len(lines) < 2:
            return "Write the dialogue first: lines for host A and host B, at least two.", True
        voices = pick_voices(await asyncio.to_thread(installed_voices))
        from .. import osplat

        pc = osplat.IS_WIN
        if not all(voices):
            return f"This {'computer' if pc else 'Mac'} has no voices to read it with.", True
        title = " ".join(str(title or "").split())[:120] or "Audio overview"
        out = file_name(title, folder(), ".wav" if pc else ".m4a")
        try:
            await asyncio.to_thread(render, lines, voices, out)
        except (OSError, subprocess.SubprocessError) as exc:
            log.warning("audio overview: couldn't render: %s", exc)
            return f"The audio couldn't be made on this {'computer' if pc else 'Mac'}.", True
        self.hub.emit("caption", text=f"Saved the audio overview “{title}”.")
        with contextlib.suppress(Exception):
            if pc:
                osplat.open_target(str(out), reveal=True)
            else:
                from .. import mac_tools

                await mac_tools.run_command("open", "-R", str(out))
        minutes = sum(len(w.split()) for _h, w in lines) / 150
        return (
            f"Made it: {out.name} (about {max(1, round(minutes))} min, voices {voices[0]} and "
            f"{voices[1]}), in Documents › Jarvis › Audio, shown in {'File Explorer' if pc else 'Finder'}.",
            False,
        )

    def build_server(self):
        overview = self

        @tool(
            "make_audio_overview",
            "Make an audio overview the owner can listen to, like a podcast: a lively two-host "
            "conversation about a document, page or topic. First read the source; then write "
            "the dialogue yourself (host A explains, host B asks the questions a listener "
            "would; 3 to 8 minutes, about 150 words a minute; plain spoken sentences, no "
            "markdown) and pass it as lines [{speaker: 'A' or 'B', text}]. Saved as an .m4a "
            "in Documents › Jarvis › Audio.",
            {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "lines": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "speaker": {"type": "string"},
                                "text": {"type": "string"},
                            },
                            "required": ["speaker", "text"],
                        },
                    },
                },
                "required": ["title", "lines"],
            },
        )
        async def make_audio_overview(args):
            text, error = await overview.make(str(args.get("title", "")), args.get("lines"))
            out: dict[str, Any] = {"content": [{"type": "text", "text": text}]}
            if error:
                out["is_error"] = True
            return out

        return create_sdk_mcp_server(
            name="audio_overview", version="0.1.0", tools=[make_audio_overview]
        )


PROMPT = (
    "Audio overviews: when the owner asks for an audio overview, a podcast or something to "
    "listen to about a document, page or topic, read it, write a two-host dialogue and call "
    "make_audio_overview."
)


def install(hub: Any) -> None:
    overview = AudioOverview(hub)
    hub.audio_overview = overview
    hub.register_server(
        "audio_overview",
        overview.build_server,
        prompt=PROMPT,
        labels={"make_audio_overview": "Made an audio overview"},
        quiet=("make_audio_overview",),
    )
