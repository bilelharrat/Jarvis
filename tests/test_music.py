"""Music by name (jarvis.music and the mac_music feature), with Music's and Spotify's
AppleScript recorded instead of run: nothing plays, no playlist is made, no speaker moves."""

from __future__ import annotations

import pytest
from conftest import FakeClient

from jarvis import music as music_module
from jarvis.features import mac_music as feature
from jarvis.hub import Hub
from jarvis.music import QUEUE, Music, NotFound

LIBRARY = (
    "A1\tAirbag\tRadiohead\tOK Computer\t1\t1\n"
    "A3\tSubterranean Homesick Alien\tRadiohead\tOK Computer\t1\t3\n"
    "A2\tParanoid Android\tRadiohead\tOK Computer\t1\t2\n"
    "K1\tKarma Police\tRadiohead\tOK Computer\t1\t6\n"
    "X1\tCreep\tRadiohead\tPablo Honey\t1\t2\n"
    "broken line\n"
)


class Mac:
    """Music's side: what each script is asked, and what it answers."""

    def __init__(self):
        self.calls = []
        self.answers = {
            music_module.PLAYLISTS_SCRIPT: "Road Trip\nChill Evening\nJarvis Queue\n",
            music_module.SEARCH_SCRIPT: LIBRARY,
            music_module.STATE_SCRIPT: "stopped\t",
            music_module.SPEAKERS_SCRIPT: (
                "MacBook Pro\tcomputer\ttrue\ttrue\n"
                "Kitchen\tHomePod\ttrue\tfalse\n"
                "Living Room TV\tApple TV\tfalse\tfalse\n"
            ),
        }

    async def run(self, script, *argv, timeout=30):
        self.calls.append((script, argv))
        return self.answers.get(script, "")

    async def command(self, *argv, **_k):
        self.calls.append(("command", argv))
        return ""

    def ran(self, script):
        return [argv for s, argv in self.calls if s == script]


@pytest.fixture
def mac():
    return Mac()


@pytest.fixture
def music(mac):
    return Music(run=mac.run, command=mac.command)


def test_tracks_read_from_the_library():
    tracks = music_module.parse_tracks(LIBRARY)
    assert [t["id"] for t in tracks] == ["A1", "A3", "A2", "K1", "X1"]
    assert tracks[0] == {
        "id": "A1",
        "name": "Airbag",
        "artist": "Radiohead",
        "album": "OK Computer",
        "disc": 1,
        "number": 1,
    }


async def test_a_song_plays_its_best_match_from_jarvis_own_playlist(music, mac):
    said = await music.play("karma police", "song")
    assert said == "Playing “Karma Police” by Radiohead."
    assert mac.ran(music_module.SEARCH_SCRIPT) == [("karma police", "songs", "200")]
    assert mac.ran(music_module.FILL_SCRIPT) == [(QUEUE, "play", "K1")]


async def test_an_album_plays_in_order_and_an_artist_shuffled(music, mac, monkeypatch):
    said = await music.play("OK Computer", "album")
    assert said == "Playing the album “OK Computer” by Radiohead (4 songs)."
    assert mac.ran(music_module.FILL_SCRIPT)[-1] == (QUEUE, "play", "A1", "A2", "A3", "K1")
    monkeypatch.setattr(music_module.random, "sample", lambda seq, n: list(reversed(seq)))
    said = await music.play("radiohead", "artist")
    assert said == "Playing 5 songs by Radiohead, shuffled."
    assert mac.ran(music_module.FILL_SCRIPT)[-1] == (QUEUE, "play", "X1", "K1", "A2", "A3", "A1")


async def test_a_playlist_by_name_comes_first(music, mac):
    assert await music.play("road trip") == "Playing your playlist “Road Trip”."
    assert mac.ran(music_module.PLAY_PLAYLIST_SCRIPT) == [("Road Trip",)]
    assert mac.ran(music_module.SEARCH_SCRIPT) == []
    with pytest.raises(NotFound, match="no playlist called Jarvis Queue"):
        await music.play("Jarvis Queue", "playlist")  # its own playlist isn't the owner's


async def test_nothing_in_the_library_says_so(music, mac):
    mac.answers[music_module.SEARCH_SCRIPT] = ""
    with pytest.raises(NotFound, match="Nothing called Unknown Song in your Music library"):
        await music.play("Unknown Song", "song")
    with pytest.raises(ValueError):
        await music.play("   ")
    assert mac.ran(music_module.FILL_SCRIPT) == []


async def test_queueing_adds_after_what_jarvis_is_playing(music, mac):
    mac.answers[music_module.STATE_SCRIPT] = f"playing\t{QUEUE}"
    assert await music.queue("creep") == "Queued “Creep” by Radiohead."
    assert mac.ran(music_module.FILL_SCRIPT) == [(QUEUE, "add", "X1")]


async def test_queueing_while_something_else_plays_says_it_cant(music, mac):
    mac.answers[music_module.STATE_SCRIPT] = "playing\tRoad Trip"
    with pytest.raises(NotFound, match="playing Road Trip that I didn't start"):
        await music.queue("creep")
    mac.answers[music_module.STATE_SCRIPT] = "stopped\t"  # nothing playing: it just plays
    assert await music.queue("creep") == "Playing “Creep” by Radiohead."


async def test_speakers_are_listed_and_switched(music, mac):
    speakers = await music.speakers()
    assert [(s["name"], s["available"], s["selected"]) for s in speakers] == [
        ("MacBook Pro", True, True),
        ("Kitchen", True, False),
        ("Living Room TV", False, False),
    ]
    assert await music.set_speakers(["kitchen", "macbook pro"]) == (
        "Playing on Kitchen and MacBook Pro."
    )
    assert mac.ran(music_module.SET_SPEAKERS_SCRIPT) == [("Kitchen", "MacBook Pro")]
    with pytest.raises(NotFound, match="isn't available"):
        await music.set_speakers(["living room tv"])
    with pytest.raises(NotFound, match="Available: MacBook Pro, Kitchen"):
        await music.set_speakers(["garage"])


async def test_spotify_links_play_and_words_open_its_search(music, mac):
    link = "https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=abc"
    assert await music.spotify(link) == "Playing it in Spotify."
    assert mac.ran(music_module.SPOTIFY_PLAY_SCRIPT) == [("spotify:track:4uLU6hMCjMI75M1A2tKUQC",)]
    said = await music.spotify("lo-fi beats")
    assert said.startswith("Spotify's AppleScript can't search")
    assert mac.ran("command") == [("open", "spotify:search:lo-fi%20beats")]
    assert music_module.spotify_uri("spotify:album:1DFixLWuPkv3KT3TnV35m3")
    assert music_module.spotify_uri("https://evil.example/track/1") is None


def test_best_name_is_exact_or_the_only_one():
    names = ["Road Trip", "Road Trip 2", "Chill"]
    assert music_module.best_name(names, "road trip!") == "Road Trip"
    assert music_module.best_name(names, "chil") == "Chill"
    assert music_module.best_name(names, "road") is None  # two could be meant
    assert music_module.best_name(names, "") is None


@pytest.fixture
def tools(settings, quiet_speaker, isolated, monkeypatch, mac):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    monkeypatch.setattr(feature, "create_sdk_mcp_server", lambda **k: k["tools"])
    hub.music.run, hub.music.command = mac.run, mac.command
    mac.hub = hub
    return {t.name: t.handler for t in feature.build_server(hub.music)}


def test_what_other_devices_are_called_counts_as_data(tools):
    """Speakers are named by whoever set each one up (on a shared network, anyone), and
    set_speakers answers with those names ("Playing on …", "Available: …"): like
    list_speakers, its answer is the owner's data to the turn gate, not JARVIS's own words."""
    from jarvis import hub as hub_module

    quiet = hub_module.EXTRA_QUIET_RESULTS
    assert "mcp__music__play_music" in quiet
    assert "mcp__music__set_speakers" not in quiet and "mcp__music__list_speakers" not in quiet


async def test_the_tools_say_what_happened(tools, mac):
    out = await tools["play_music"]({"what": "OK Computer", "kind": "album"})
    assert out["content"][0]["text"].startswith("Playing the album")
    out = await tools["play_music"]({"what": "Nothing", "kind": "podcast"})
    assert mac.ran(music_module.SEARCH_SCRIPT)[-1][1] == "all"  # an unknown kind: any
    out = await tools["set_speakers"]({"names": "Kitchen and MacBook Pro"})
    assert out["content"][0]["text"] == "Playing on Kitchen and MacBook Pro."
    listed = (await tools["list_speakers"]({}))["content"][0]["text"]
    assert "- Living Room TV (Apple TV): offline" in listed
    mac.answers[music_module.SEARCH_SCRIPT] = ""
    out = await tools["queue_music"]({"what": "xyz"})
    assert out["is_error"]


async def test_music_that_music_refuses_is_an_error_not_a_crash(tools, mac):
    async def refuse(*_a, **_k):
        raise feature.mac_tools.ToolFailure("Not authorized to send Apple events to Music.")

    mac.hub.music.run = refuse
    out = await tools["play_music"]({"what": "anything"})
    assert out["is_error"] and "Not authorized" in out["content"][0]["text"]
