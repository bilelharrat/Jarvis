"""Music by name, for JARVIS's brain (the "music" tool server; jarvis.music does the work):

- play_music: a song, album, artist or playlist from the owner's Apple Music library;
- queue_music: more after what JARVIS is playing;
- play_spotify: a Spotify link or URI (or, for words, Spotify's own search opened);
- list_speakers / set_speakers: Music's AirPlay speakers.

Like media_control, these play music and pick speakers without a card: the owner asked for
music, and nothing leaves the Mac or changes its settings.

Cost policy (Claude): nothing here calls a model.
"""

from __future__ import annotations

import re
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import mac_tools
from ..music import KINDS, Music, NotFound

SERVER = "music"
LABELS = {
    "play_music": "Played music",
    "queue_music": "Queued music",
    "play_spotify": "Played Spotify",
    "list_speakers": "Checked your speakers",
    "set_speakers": "Switched speakers",
}
PROMPT = (
    "\n- Music: play_music plays a song, album, artist or playlist from the user's Apple Music "
    "library by name; queue_music adds more after it; play_spotify plays a Spotify link (it "
    "can't search Spotify). list_speakers and set_speakers choose the AirPlay speakers Music "
    "plays on. media_control still pauses, skips and resumes."
)


def _text(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


def _error(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}], "is_error": True}


def _names(value: Any) -> list[str]:
    """Speaker names from a list, or "Kitchen, Den and Living Room"."""
    if isinstance(value, list):
        raw = [str(v) for v in value]
    else:
        raw = re.split(r"\s*(?:,|\band\b|&|和|跟|、)\s*", str(value or ""))
    return [n.strip() for n in raw if n and n.strip()][:8]


async def _done(work) -> dict[str, Any]:
    try:
        return _text(await work)
    except NotFound as exc:
        return _error(str(exc))
    except (mac_tools.ToolFailure, ValueError) as exc:
        return _error(str(exc))


def build_server(music: Music):
    @tool(
        "play_music",
        "Play music from the user's Apple Music library by name. what: a song, album, artist "
        "or playlist name. kind: song, album, artist, playlist, or any (default: a playlist "
        "of that name first, else songs). An album plays in order, an artist shuffled.",
        {
            "type": "object",
            "properties": {"what": {"type": "string"}, "kind": {"type": "string"}},
            "required": ["what"],
        },
    )
    async def play_music(args):
        kind = str(args.get("kind") or "any").strip().lower()
        return await _done(
            music.play(str(args.get("what") or ""), kind if kind in KINDS else "any")
        )

    @tool(
        "queue_music",
        "Add a song, album or artist from the user's library after what's playing (only after "
        "music you started with play_music). kind: song (default), album or artist.",
        {
            "type": "object",
            "properties": {"what": {"type": "string"}, "kind": {"type": "string"}},
            "required": ["what"],
        },
    )
    async def queue_music(args):
        kind = str(args.get("kind") or "song").strip().lower()
        return await _done(music.queue(str(args.get("what") or ""), kind))

    @tool(
        "play_spotify",
        "Play a Spotify link (open.spotify.com/…) or spotify: URI in the Spotify app. Given "
        "words instead, it opens Spotify's search for the user to pick from: Spotify can't be "
        "searched from here.",
        {"link_or_words": str},
    )
    async def play_spotify(args):
        return await _done(music.spotify(str(args.get("link_or_words") or "")))

    @tool("list_speakers", "The AirPlay speakers Music can play on, and which are playing.", {})
    async def list_speakers(_args):
        try:
            speakers = await music.speakers()
        except mac_tools.ToolFailure as exc:
            return _error(str(exc))
        if not speakers:
            return _text("Music sees no speakers.")
        rows = []
        for s in speakers:
            state = "playing" if s["selected"] else "available" if s["available"] else "offline"
            rows.append(f"- {s['name']} ({s['kind']}): {state}")
        return _text("\n".join(rows))

    @tool(
        "set_speakers",
        "Play Music on these AirPlay speakers, and only these: names from list_speakers, "
        "like “Kitchen, Living Room” (the Mac itself is usually named after it).",
        {"names": str},
    )
    async def set_speakers(args):
        return await _done(music.set_speakers(_names(args.get("names"))))

    return create_sdk_mcp_server(
        name=SERVER,
        version="0.1.0",
        tools=[play_music, queue_music, play_spotify, list_speakers, set_speakers],
    )


def install(hub: Any) -> None:
    music = Music()
    hub.music = music
    hub.register_server(
        SERVER,
        lambda: build_server(music),
        prompt=PROMPT,
        labels=LABELS,
        # What's playing: JARVIS's own words about what the owner asked for. The speakers'
        # names are whoever set each one up (on a shared network, anyone), so what
        # set_speakers answers ("Playing on …", "Available: …") counts as data, like
        # list_speakers.
        quiet=("play_music", "queue_music", "play_spotify"),
    )
