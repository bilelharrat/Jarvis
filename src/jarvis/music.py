"""Music by name: a song, album, artist or playlist from the owner's Apple Music library,
more songs queued after it, the AirPlay speakers it plays on, and Spotify links.

Everything goes through Music's and Spotify's AppleScript (mac_tools.run_applescript), with
what the owner said passed as the script's arguments, never pasted into its text.

- Music's AppleScript can search only the library (not Apple Music's catalog) and has no
  Up Next. So what JARVIS plays goes into one playlist of its own, QUEUE, played from the
  top; "queue this" adds to its end, which plays next as long as that playlist is playing.
- Spotify's AppleScript can play a link or a spotify: URI but can't search; for words,
  Spotify's own search is opened for the owner to pick from.
"""

from __future__ import annotations

import random
import re
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote

from . import mac_tools

QUEUE = "Jarvis Queue"
KINDS = ("song", "album", "artist", "playlist", "any")
MAX_SEARCH = 200  # tracks read back from one search
ALBUM_TRACKS = 60
ARTIST_TRACKS = 50

Run = Callable[..., Awaitable[str]]

SEARCH_SCRIPT = """on run argv
    set q to item 1 of argv
    set kind to item 2 of argv
    set wanted to (item 3 of argv) as integer
    tell application "Music"
        if kind is "songs" then
            set found to search library playlist 1 for q only songs
        else if kind is "artists" then
            set found to search library playlist 1 for q only artists
        else if kind is "albums" then
            set found to search library playlist 1 for q only albums
        else
            set found to search library playlist 1 for q
        end if
        if found is missing value then return ""
        set out to ""
        set n to 0
        repeat with t in found
            set n to n + 1
            if n > wanted then exit repeat
            set out to out & (persistent ID of t) & tab & (name of t) & tab & (artist of t) & tab & (album of t) & tab & (disc number of t) & tab & (track number of t) & linefeed
        end repeat
        return out
    end tell
end run"""

# item 1: the playlist; item 2: "play" (start it afresh) or "add" (to its end); the rest:
# tracks' persistent IDs.
FILL_SCRIPT = """on run argv
    set listName to item 1 of argv
    set startNow to (item 2 of argv) is "play"
    tell application "Music"
        if exists user playlist listName then
            set pl to user playlist listName
            if startNow then delete every track of pl
        else
            set pl to make new user playlist with properties {name:listName}
        end if
        repeat with i from 3 to count of argv
            set pid to item i of argv
            duplicate (first track of library playlist 1 whose persistent ID is pid) to pl
        end repeat
        if startNow then play pl
    end tell
end run"""

PLAYLISTS_SCRIPT = """tell application "Music"
    set out to ""
    repeat with p in user playlists
        set out to out & (name of p) & linefeed
    end repeat
    return out
end tell"""

PLAY_PLAYLIST_SCRIPT = """on run argv
    tell application "Music" to play user playlist (item 1 of argv)
end run"""

STATE_SCRIPT = """tell application "Music"
    if player state is stopped then return "stopped" & tab & ""
    try
        return (player state as text) & tab & (name of current playlist)
    on error
        return (player state as text) & tab & ""
    end try
end tell"""

SPEAKERS_SCRIPT = """tell application "Music"
    set out to ""
    repeat with d in AirPlay devices
        set out to out & (name of d) & tab & (kind of d as text) & tab & (available of d) & tab & (selected of d) & linefeed
    end repeat
    return out
end tell"""

SET_SPEAKERS_SCRIPT = """on run argv
    tell application "Music"
        set wanted to {}
        repeat with n in argv
            set end of wanted to (first AirPlay device whose name is (n as text))
        end repeat
        set current AirPlay devices to wanted
    end tell
end run"""

SPOTIFY_PLAY_SCRIPT = """on run argv
    tell application "Spotify" to play track (item 1 of argv)
end run"""

_SPOTIFY_LINK = re.compile(
    r"^https?://open\.spotify\.com/(?:intl-[a-z-]+/)?(track|album|playlist|artist|episode|show)"
    r"/([A-Za-z0-9]+)"
)
_SPOTIFY_URI = re.compile(r"^spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]+$")


class NotFound(ValueError):
    pass


def _plain(text: str) -> str:
    return " ".join(re.findall(r"[^\W_]+", str(text or "").lower()))


def parse_tracks(raw: str) -> list[dict[str, Any]]:
    tracks = []
    for line in (raw or "").splitlines():
        parts = line.split("\t")
        if len(parts) < 6 or not parts[0]:
            continue
        pid, name, artist, album, disc, number = parts[:6]
        tracks.append(
            {
                "id": pid,
                "name": name,
                "artist": artist,
                "album": album,
                "disc": int(disc) if disc.isdigit() else 0,
                "number": int(number) if number.isdigit() else 0,
            }
        )
    return tracks


def pick_tracks(tracks: list[dict[str, Any]], query: str, kind: str) -> list[dict[str, Any]]:
    """What "play <query>" means among the library's matches: a song's best match; an
    album's tracks in order; an artist's, shuffled (at most ARTIST_TRACKS)."""
    if not tracks:
        return []
    said = _plain(query)
    if kind == "album":
        albums: dict[str, list[dict[str, Any]]] = {}
        for t in tracks:
            albums.setdefault(t["album"], []).append(t)
        exact = [a for a in albums if _plain(a) == said]
        best = exact[0] if exact else max(albums, key=lambda a: len(albums[a]))
        return sorted(albums[best], key=lambda t: (t["disc"], t["number"]))[:ALBUM_TRACKS]
    if kind == "artist":
        exact = [t for t in tracks if _plain(t["artist"]) == said]
        chosen = exact or tracks
        chosen = random.sample(chosen, len(chosen))
        return chosen[:ARTIST_TRACKS]
    exact = [t for t in tracks if _plain(t["name"]) == said]
    return [exact[0] if exact else tracks[0]]


def best_name(names: list[str], query: str) -> str | None:
    """The name the owner meant: an exact match (ignoring case and punctuation), else the
    only one that contains what they said. None when there's none, or it's unclear."""
    said = _plain(query)
    if not said:
        return None
    exact = [n for n in names if _plain(n) == said]
    if exact:
        return exact[0]
    within = [n for n in names if said in _plain(n)]
    return within[0] if len(within) == 1 else None


def describe(tracks: list[dict[str, Any]], kind: str) -> str:
    first = tracks[0]
    if kind == "album":
        return f"the album “{first['album']}” by {first['artist']} ({len(tracks)} songs)"
    if kind == "artist":
        return f"{len(tracks)} songs by {first['artist']}, shuffled"
    return f"“{first['name']}” by {first['artist']}"


def spotify_uri(text: str) -> str | None:
    """A Spotify link or URI as the URI its AppleScript plays; None for anything else."""
    text = str(text or "").strip()
    if _SPOTIFY_URI.match(text):
        return text
    m = _SPOTIFY_LINK.match(text)
    return f"spotify:{m.group(1)}:{m.group(2)}" if m else None


def spotify_search_url(query: str) -> str:
    return "spotify:search:" + quote(" ".join(str(query or "").split()), safe="")


def parse_speakers(raw: str) -> list[dict[str, Any]]:
    speakers = []
    for line in (raw or "").splitlines():
        parts = line.split("\t")
        if len(parts) < 4 or not parts[0]:
            continue
        speakers.append(
            {
                "name": parts[0],
                "kind": parts[1],
                "available": parts[2] == "true",
                "selected": parts[3] == "true",
            }
        )
    return speakers


class Music:
    def __init__(self, run: Run | None = None, command: Run | None = None) -> None:
        self.run = run or mac_tools.run_applescript
        self.command = command or mac_tools.run_command

    async def search(self, query: str, kind: str) -> list[dict[str, Any]]:
        only = {"song": "songs", "album": "albums", "artist": "artists"}.get(kind, "all")
        raw = await self.run(SEARCH_SCRIPT, query, only, str(MAX_SEARCH), timeout=60)
        return parse_tracks(raw)

    async def playlists(self) -> list[str]:
        raw = await self.run(PLAYLISTS_SCRIPT, timeout=30)
        return [line for line in raw.splitlines() if line.strip() and line != QUEUE]

    async def play(self, query: str, kind: str = "any") -> str:
        """Start playing what the owner named; what's playing, in words. NotFound when the
        library has nothing like it."""
        query = " ".join(str(query or "").split())[:200]
        if not query:
            raise ValueError("Say what to play.")
        kind = kind if kind in KINDS else "any"
        if kind in ("playlist", "any"):
            name = best_name(await self.playlists(), query)
            if name is not None:
                await self.run(PLAY_PLAYLIST_SCRIPT, name, timeout=30)
                return f"Playing your playlist “{name}”."
            if kind == "playlist":
                raise NotFound(f"There's no playlist called {query} in Music.")
        tracks = pick_tracks(await self.search(query, kind), query, kind)
        if not tracks:
            raise NotFound(
                f"Nothing called {query} in your Music library. (Apple Music's catalog can't "
                "be searched from here: add it to your library first.)"
            )
        await self.run(FILL_SCRIPT, QUEUE, "play", *(t["id"] for t in tracks), timeout=120)
        return f"Playing {describe(tracks, kind)}."

    async def queue(self, query: str, kind: str = "song") -> str:
        """Add to what JARVIS is playing. When Music is playing something else, it says so
        instead (its AppleScript has no Up Next to add to)."""
        query = " ".join(str(query or "").split())[:200]
        if not query:
            raise ValueError("Say what to queue.")
        kind = kind if kind in ("song", "album", "artist") else "song"
        state, playlist = (await self.run(STATE_SCRIPT, timeout=15)).partition("\t")[::2]
        if state == "stopped":
            return await self.play(query, kind)
        if playlist != QUEUE:
            raise NotFound(
                f"Music is playing {playlist or 'something'} that I didn't start, and I can only "
                "add songs after what I'm playing. I can play it now instead."
            )
        tracks = pick_tracks(await self.search(query, kind), query, kind)
        if not tracks:
            raise NotFound(f"Nothing called {query} in your Music library.")
        await self.run(FILL_SCRIPT, QUEUE, "add", *(t["id"] for t in tracks), timeout=120)
        return f"Queued {describe(tracks, kind)}."

    async def speakers(self) -> list[dict[str, Any]]:
        return parse_speakers(await self.run(SPEAKERS_SCRIPT, timeout=30))

    async def set_speakers(self, names: list[str]) -> str:
        """Play on these AirPlay speakers (and only these)."""
        known = await self.speakers()
        chosen: list[str] = []
        for wanted in names:
            name = best_name([s["name"] for s in known], wanted)
            if name is None:
                have = ", ".join(s["name"] for s in known if s["available"]) or "none"
                raise NotFound(f"No speaker called {wanted}. Available: {have}.")
            if not next(s for s in known if s["name"] == name)["available"]:
                raise NotFound(f"{name} isn't available right now.")
            if name not in chosen:
                chosen.append(name)
        if not chosen:
            raise ValueError("Say which speakers.")
        await self.run(SET_SPEAKERS_SCRIPT, *chosen, timeout=30)
        return "Playing on " + " and ".join(chosen) + "."

    async def spotify(self, link_or_words: str) -> str:
        """A Spotify link or URI played; for words, Spotify's search opened for the owner."""
        text = " ".join(str(link_or_words or "").split())[:300]
        if not text:
            raise ValueError("Give a Spotify link, or what to look for.")
        uri = spotify_uri(text)
        if uri is not None:
            await self.run(SPOTIFY_PLAY_SCRIPT, uri, timeout=30)
            return "Playing it in Spotify."
        await self.command("open", spotify_search_url(text))
        return (
            f"Spotify's AppleScript can't search, so I opened Spotify's search for {text}; "
            "pick one there, or give me a Spotify link."
        )
