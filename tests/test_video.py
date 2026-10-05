"""Video summaries: local files, links, YouTube captions, chunking, cancelling, the tools.

Nothing here loads Whisper or touches the network: the transcriber, the audio extraction
(save one test that runs the Mac's own afconvert on a WAV made here) and every HTTP client
are fakes."""

import asyncio
import json
import shutil
import threading
import wave
from pathlib import Path

import httpx
import numpy as np
import pytest

from jarvis import video
from jarvis.video import Segment, VideoDesk, VideoError, VideoJob

FIXTURES = Path(__file__).parent / "fixtures" / "video"
RATE = video.SAMPLE_RATE


def write_wav(path: Path, seconds: float, quiet_at: tuple[float, ...] = ()) -> None:
    """A tone with short silences at quiet_at (seconds), as 16 kHz mono 16-bit."""
    t = np.arange(int(seconds * RATE)) / RATE
    audio = 0.3 * np.sin(2 * np.pi * 220 * t)
    for at in quiet_at:
        audio[int(at * RATE) : int((at + 0.2) * RATE)] = 0
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((audio * 32767).astype("<i2").tobytes())


def fake_extract(seconds: float = 30.0, full: float | None = None, seen: list | None = None):
    async def extract(src, wav, limit, stop):
        if seen is not None:
            seen.append((Path(src), Path(src).read_bytes() if Path(src).exists() else b""))
        write_wav(wav, min(seconds, limit))
        return full if full is not None else seconds

    return extract


def chunk_transcriber(calls: list | None = None):
    """One segment per chunk, saying which chunk and how long it was."""

    def transcribe(audio, stop):
        n = len(calls) + 1 if calls is not None else 1
        if calls is not None:
            calls.append(len(audio) / RATE)
        return [Segment(0.0, len(audio) / RATE, f"chunk {n} words")]

    return transcribe


def desk_for(tmp_path, **kw) -> VideoDesk:
    kw.setdefault("extract", fake_extract())
    kw.setdefault("transcribe", chunk_transcriber())
    kw.setdefault("roots", [tmp_path])
    kw.setdefault("notes_dir", tmp_path / "Videos")
    return VideoDesk(**kw)


def media(tmp_path, name="talk.mov") -> Path:
    path = tmp_path / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"not really a movie")
    return path


def mock_http(handler):
    def make(**kw):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), **kw)

    return make


def text_of(result) -> str:
    return result["content"][0]["text"]


def tools(desk, **kw):
    return {t.name: t.handler for t in video.build_tools(desk, **kw)}


# ── local files ──


async def test_local_file_is_transcribed_in_chunks_with_timestamps(tmp_path):
    events = []
    calls = []
    desk = desk_for(
        tmp_path,
        extract=fake_extract(25.0),
        transcribe=chunk_transcriber(calls),
        chunk_seconds=10.0,
        emit=lambda kind, **data: events.append((kind, data)),
    )
    job = await desk.start(str(media(tmp_path)))
    await job.task
    assert job.state == "ready" and job.title == "talk"
    assert len(calls) == 3 and sum(calls) == pytest.approx(25.0, abs=0.01)
    starts = [s.start for s in job.segments]
    assert starts == sorted(starts) and starts[0] == 0.0
    assert starts[1] == pytest.approx(calls[0], abs=0.01)  # offset by the first chunk
    assert job.segments[-1].end == pytest.approx(25.0, abs=0.01)
    states = [d["job"]["state"] for k, d in events if k == "video"]
    assert states[0] == "starting" and "transcribing" in states and states[-1] == "ready"
    progress = [d["job"]["progress"] for k, d in events if k == "video"]
    assert progress == sorted(progress)
    # Filed as it finished, with its timestamps.
    filed = job.path.read_text()
    assert job.path.parent == tmp_path / "Videos" and "[0:00] chunk 1 words" in filed


async def test_three_hour_cap_is_applied_and_said(tmp_path):
    desk = desk_for(tmp_path, extract=fake_extract(40.0, full=100.0), max_seconds=20.0)
    job = await desk.start(str(media(tmp_path)))
    await job.task
    assert job.duration == 20.0 and job.public()["capped"]
    assert job.segments[-1].end <= 20.0
    assert "only the first 20 seconds of 2 minutes" in desk.transcript_part(job)


async def test_the_same_video_again_reuses_its_transcript(tmp_path):
    calls = []
    desk = desk_for(tmp_path, transcribe=chunk_transcriber(calls))
    path = media(tmp_path)
    first = await desk.start(str(path))
    await first.task
    again = await desk.start(f"file://{path}")
    assert again is first and len(calls) == 1


async def test_a_name_is_looked_up_in_the_file_index(tmp_path):
    path = media(tmp_path, "Clients/Okin demo.mp4")
    asked = []

    def find(query):
        asked.append(query)
        return [str(tmp_path / "notes.txt"), str(path)]

    desk = desk_for(tmp_path, find=find)
    job = await desk.start("Okin demo")
    await job.task
    assert asked == ["Okin demo"] and job.title == "Okin demo" and job.state == "ready"
    with pytest.raises(VideoError, match="can't find"):
        await desk_for(tmp_path, find=lambda q: []).start("nothing like it")


@pytest.mark.parametrize(
    ("name", "why"),
    [
        (".ssh/clip.mp4", "credentials"),
        ("Keys/server.key", "credentials"),
        ("talk.webm", "no reader"),
        ("notes.txt", "isn't a video"),
    ],
)
async def test_refused_files(tmp_path, name, why):
    desk = desk_for(tmp_path)
    with pytest.raises(VideoError, match=why):
        await desk.start(str(media(tmp_path, name)))
    assert not desk.jobs  # nothing started


async def test_files_outside_the_home_folder_and_drives_are_refused(tmp_path):
    outside = media(tmp_path, "elsewhere/talk.mp4")
    desk = desk_for(tmp_path, roots=[tmp_path / "home"])
    with pytest.raises(VideoError, match="home folder"):
        await desk.start(str(outside))
    # A link out of the allowed folder is judged by where it leads.
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / "link.mp4").symlink_to(outside)
    with pytest.raises(VideoError, match="home folder"):
        await desk.start(str(tmp_path / "home" / "link.mp4"))


async def test_a_file_with_no_speech_or_no_sound_fails_plainly(tmp_path):
    desk = desk_for(tmp_path, transcribe=lambda audio, stop: [])
    job = await desk.start(str(media(tmp_path)))
    await job.task
    assert job.state == "failed" and "didn't hear any speech" in job.error

    async def no_sound(src, wav, limit, stop):
        raise VideoError("I couldn't get any sound out of that file.")

    desk = desk_for(tmp_path, extract=no_sound)
    job = await desk.start(str(media(tmp_path, "b.mp4")))
    await job.task
    assert job.state == "failed" and "sound" in job.error


async def test_only_one_video_at_a_time(tmp_path):
    gate = asyncio.Event()

    async def slow(src, wav, limit, stop):
        await gate.wait()
        write_wav(wav, 5)
        return 5.0

    desk = desk_for(tmp_path, extract=slow)
    job = await desk.start(str(media(tmp_path)))
    with pytest.raises(VideoError, match="still on"):
        await desk.start(str(media(tmp_path, "other.mp4")))
    gate.set()
    await job.task
    assert job.state == "ready"


# ── chunking ──


def test_chunks_cut_at_the_quiet_moment_near_each_seam(tmp_path):
    wav = tmp_path / "a.wav"
    write_wav(wav, 25.0, quiet_at=(8.0, 17.5))
    pieces = list(video.chunks(wav, chunk=10.0, seam=4.0, limit=100))
    offsets = [o for o, _ in pieces]
    assert offsets[0] == 0.0
    assert offsets[1] == pytest.approx(8.1, abs=0.06)  # the silence at 8 s, not 10 s
    assert offsets[2] == pytest.approx(17.6, abs=0.06)
    assert sum(len(a) for _, a in pieces) == 25 * RATE  # nothing lost or doubled
    assert all(a.dtype == np.float32 and np.abs(a).max() <= 1.0 for _, a in pieces)


def test_chunks_stop_at_the_limit(tmp_path):
    wav = tmp_path / "a.wav"
    write_wav(wav, 12.0)
    pieces = list(video.chunks(wav, chunk=5.0, limit=7.0))
    assert sum(len(a) for _, a in pieces) == 7 * RATE


def test_paragraphs_and_pages_keep_timestamps():
    segs = [Segment(i * 10.0, i * 10.0 + 9, f"line {i}") for i in range(400)]
    lines = video.paragraphs(segs)
    assert lines[0] == "[0:00] line 0 line 1 line 2 line 3"  # about half a minute a line
    assert lines[1].startswith("[0:40] line 4")
    assert video.stamp(3725) == "1:02:05" and video.stamp(65) == "1:05"
    parts = video.pages(segs, size=1000)
    assert len(parts) > 1 and all(len(p) <= 1000 for p in parts)
    assert "\n".join(parts) == "\n".join(lines)


# ── cancelling ──


async def test_cancel_stops_the_transcription_and_reports_nothing(tmp_path):
    started = threading.Event()
    ready = []

    def endless(audio, stop):
        started.set()
        stop.wait(10)  # a real one checks stop between segments
        return [Segment(0, 1, "partial")]

    desk = desk_for(tmp_path, transcribe=endless, on_ready=ready.append)
    job = await desk.start(str(media(tmp_path)))
    while not started.is_set():
        await asyncio.sleep(0.01)
    assert desk.cancel() is job
    await asyncio.wait({job.task}, timeout=2)
    assert job.state == "cancelled" and job.stop.is_set() and not ready
    assert desk.cancel() is None  # nothing left running
    assert desk.current() is None  # a new video may start


async def test_close_cancels_whatever_runs(tmp_path):
    def endless(audio, stop):
        stop.wait(10)
        return []

    desk = desk_for(tmp_path, transcribe=endless)
    job = await desk.start(str(media(tmp_path)))
    await asyncio.sleep(0.05)
    await desk.close()
    assert job.state == "cancelled"


async def test_run_kills_a_tool_when_cancelled():
    stop = threading.Event()
    task = asyncio.create_task(video._run(["sleep", "5"], stop, 30))
    await asyncio.sleep(0.2)
    stop.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 2)


# ── links ──


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8765/clip.mp4",
        "http://127.0.0.1/clip.mp4",
        "http://192.168.1.10/clip.mp4",
        "http://[::1]/clip.mp4",
        "http://printer.local/clip.mp4",
        "ftp://example.com/clip.mp4",
    ],
)
def test_links_to_this_mac_or_the_local_network_are_refused(url):
    with pytest.raises(VideoError):
        video.public_url(url)


async def test_a_media_link_is_downloaded_and_transcribed(tmp_path):
    seen = []

    def handler(request):
        assert request.url.host == "cdn.example.com"
        return httpx.Response(
            200, headers={"content-type": "video/mp4"}, content=b"\x00\x00\x00 ftypmp42" * 100
        )

    desk = desk_for(tmp_path, http=mock_http(handler), extract=fake_extract(seen=seen))
    job = await desk.start("https://cdn.example.com/media/keynote.mp4?sig=1")
    await job.task
    assert job.state == "ready" and job.kind == "url" and job.title == "keynote.mp4"
    path, data = seen[0]
    assert path.suffix == ".mp4" and data.startswith(b"\x00\x00\x00 ftyp")
    assert not path.exists()  # the temp download is gone
    assert "Link: https://cdn.example.com/media/keynote.mp4" in desk.transcript_part(job)


async def test_download_size_limits(tmp_path):
    def declared(request):
        return httpx.Response(
            200, headers={"content-type": "audio/mpeg", "content-length": "5000"}, content=b"x"
        )

    desk = desk_for(tmp_path, http=mock_http(declared), max_download=1000)
    job = await desk.start("https://example.com/a.mp3")
    await job.task
    assert job.state == "failed" and "over" in job.error

    async def body():
        for _ in range(10):
            yield b"x" * 400

    def undeclared(request):  # no length said: stopped as the bytes pass the cap
        return httpx.Response(200, headers={"content-type": "audio/mpeg"}, content=body())

    desk = desk_for(tmp_path, http=mock_http(undeclared), max_download=1000)
    job = await desk.start("https://example.com/b.mp3")
    await job.task
    assert job.state == "failed" and "over" in job.error


@pytest.mark.parametrize(
    ("content_type", "url", "why"),
    [
        ("text/plain", "https://example.com/a.txt", "isn't a video"),
        ("application/zip", "https://example.com/a.zip", "isn't a video"),
        ("video/webm", "https://example.com/a.webm", "no reader"),
        ("application/octet-stream", "https://example.com/a.mkv", "no reader"),
        ("application/vnd.apple.mpegurl", "https://example.com/a.m3u8", "streaming"),
    ],
)
async def test_links_that_arent_readable_media(tmp_path, content_type, url, why):
    seen = []

    def handler(request):
        return httpx.Response(200, headers={"content-type": content_type}, content=b"data")

    desk = desk_for(tmp_path, http=mock_http(handler), extract=fake_extract(seen=seen))
    job = await desk.start(url)
    await job.task
    assert job.state == "failed" and why in job.error and not seen


async def test_an_octet_stream_with_a_media_name_is_accepted(tmp_path):
    def handler(request):
        return httpx.Response(
            200, headers={"content-type": "application/octet-stream"}, content=b"m4a"
        )

    seen = []
    desk = desk_for(tmp_path, http=mock_http(handler), extract=fake_extract(seen=seen))
    job = await desk.start("https://example.com/files/episode.m4a")
    await job.task
    assert job.state == "ready" and seen[0][0].suffix == ".m4a"


async def test_a_redirect_to_the_local_network_is_refused(tmp_path):
    hosts = []

    def handler(request):
        hosts.append(request.url.host)
        return httpx.Response(302, headers={"location": "http://127.0.0.1:8765/secret.mp4"})

    desk = desk_for(tmp_path, http=mock_http(handler))
    job = await desk.start("https://example.com/v.mp4")
    await job.task
    assert job.state == "failed" and "local network" in job.error
    assert hosts == ["example.com"]  # the local address was never asked


async def test_a_page_is_followed_once_to_its_video(tmp_path):
    def handler(request):
        if request.url.path == "/watch/42":
            page = (
                "<html><head><title>Board talk</title>"
                '<meta property="og:video" content="/media/42.mov"></head></html>'
            )
            return httpx.Response(200, headers={"content-type": "text/html"}, text=page)
        assert request.url.path == "/media/42.mov"
        return httpx.Response(200, headers={"content-type": "video/quicktime"}, content=b"mov")

    seen = []
    desk = desk_for(tmp_path, http=mock_http(handler), extract=fake_extract(seen=seen))
    job = await desk.start("https://videos.example.com/watch/42")
    await job.task
    assert job.state == "ready" and job.title == "Board talk" and seen[0][0].suffix == ".mov"


async def test_a_page_without_a_video_file_says_so(tmp_path):
    def handler(request):
        return httpx.Response(
            200, headers={"content-type": "text/html"}, text="<html><video></video></html>"
        )

    desk = desk_for(tmp_path, http=mock_http(handler))
    job = await desk.start("https://example.com/player")
    await job.task
    assert job.state == "failed" and "drop it on the window" in job.error


# ── YouTube ──


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/watch?v=AbCdEfGhIjK&t=30s",
        "https://youtu.be/AbCdEfGhIjK?si=x",
        "youtube.com/shorts/AbCdEfGhIjK",
        "https://m.youtube.com/live/AbCdEfGhIjK",
        "https://www.youtube-nocookie.com/embed/AbCdEfGhIjK",
    ],
)
def test_youtube_ids(url):
    assert video.youtube_id(url) == "AbCdEfGhIjK"


def test_youtube_ids_only_on_youtube():
    assert video.youtube_id("https://example.com/watch?v=AbCdEfGhIjK") is None
    assert video.youtube_id("https://www.youtube.com/watch?v=short") is None


def test_player_response_and_tracks_from_a_saved_page():
    page = (FIXTURES / "youtube_watch.html").read_text()
    player = video.player_response(page)
    assert player["videoDetails"]["title"] == "Quarterly Review: Launch Plan"
    assert video.innertube_key(page) == "AIzaFakeKeyForTests_123"
    tracks = video.caption_tracks(player)
    assert [t["languageCode"] for t in tracks] == ["en", "de"]


def test_pick_track_prefers_the_uploaders_captions_in_the_language():
    android = json.loads((FIXTURES / "youtube_player_android.json").read_text())
    tracks = video.caption_tracks(android)
    assert "signature=def" in video.pick_track(tracks, "en")["baseUrl"]  # not the asr one
    assert video.pick_track(tracks, "de")["languageCode"] == "de"
    assert video.pick_track(tracks[:1], "zh")["kind"] == "asr"  # anything beats nothing
    assert video.pick_track([], "en") is None


def test_caption_formats_parse():
    segs = video.parse_json3((FIXTURES / "captions.json3").read_text())
    assert [round(s.start, 1) for s in segs] == [1.2, 34.0, 65.5]
    assert segs[1].text == "Revenue grew twelve percent."
    assert "Friday & we launch" in segs[2].text
    xml = video.parse_timedtext_xml((FIXTURES / "captions.xml").read_text())
    assert xml[1].text == "We're up twelve percent." and xml[2].start == 65.5
    srv3 = video.parse_timedtext_xml('<timedtext><body><p t="1500" d="2000">Hi <s>there</s></p>')
    assert srv3 == [Segment(1.5, 3.5, "Hi there")]


def test_caption_links_stay_on_youtube():
    url = video.caption_url("https://www.youtube.com/api/timedtext?v=x&fmt=srv3&lang=en")
    assert url.endswith("fmt=json3") and "srv3" not in url and "lang=en" in url
    with pytest.raises(VideoError):
        video.caption_url("https://evil.example.com/api/timedtext?v=x")


def youtube_handler(captions: str | None = None, android: bool = True, asked: list | None = None):
    page = (FIXTURES / "youtube_watch.html").read_text()
    player = (FIXTURES / "youtube_player_android.json").read_text()
    json3 = captions if captions is not None else (FIXTURES / "captions.json3").read_text()

    def handler(request):
        if asked is not None:
            asked.append(str(request.url))
        assert request.url.host == "www.youtube.com"  # nothing else is ever fetched
        if request.url.path == "/watch":
            return httpx.Response(200, text=page)
        if request.url.path == "/youtubei/v1/player":
            body = json.loads(request.content)
            assert body["videoId"] == "AbCdEfGhIjK"
            assert body["context"]["client"]["clientName"] == "ANDROID"
            assert request.url.params["key"] == "AIzaFakeKeyForTests_123"
            if not android:
                return httpx.Response(200, json={"playabilityStatus": {"status": "OK"}})
            return httpx.Response(200, text=player)
        if request.url.path == "/api/timedtext":
            if "exp=xpe" in str(request.url):
                return httpx.Response(200, text="")  # the web page's links: empty now
            if request.url.params["fmt"] == "json3":
                return httpx.Response(200, text=json3)
            return httpx.Response(200, text=(FIXTURES / "captions.xml").read_text())
        return httpx.Response(404)

    return handler


async def test_youtube_captions_through_the_android_player(tmp_path):
    asked = []
    desk = desk_for(tmp_path, http=mock_http(youtube_handler(asked=asked)))
    job = await desk.start("https://youtu.be/AbCdEfGhIjK")
    await job.task
    assert job.state == "ready" and job.kind == "youtube"
    assert job.title == "Quarterly Review: Launch Plan (Summit Labs)"
    assert job.method == "from the video's captions on YouTube"
    assert job.duration == 95.0 and job.segments[0].text == "Welcome to the quarterly review."
    assert any("signature=def" in u and "fmt=json3" in u for u in asked)  # the uploader's
    part = desk.transcript_part(job)
    assert "[0:01] Welcome" in part and "Length: 1:35" in part


async def test_youtube_falls_back_to_the_xml_captions(tmp_path):
    desk = desk_for(tmp_path, http=mock_http(youtube_handler(captions="")))
    job = await desk.start("https://www.youtube.com/watch?v=AbCdEfGhIjK")
    await job.task
    assert job.state == "ready" and job.segments[1].text == "We're up twelve percent."


async def test_youtube_without_captions_says_what_to_do(tmp_path):
    desk = desk_for(tmp_path, http=mock_http(youtube_handler(android=False)))
    job = await desk.start("https://www.youtube.com/watch?v=AbCdEfGhIjK")
    await job.task
    assert job.state == "failed" and job.error == video.NO_CAPTIONS


async def test_a_page_embedding_youtube_uses_its_captions(tmp_path):
    yt = youtube_handler()

    def handler(request):
        if request.url.host == "blog.example.com":
            page = '<video><source src="https://www.youtube.com/embed/AbCdEfGhIjK"></video>'
            return httpx.Response(200, headers={"content-type": "text/html"}, text=page)
        return yt(request)

    desk = desk_for(tmp_path, http=mock_http(handler))
    job = await desk.start("https://blog.example.com/post")
    await job.task
    assert job.state == "ready" and job.kind == "youtube" and len(job.segments) == 3


# ── the tools ──


async def test_summarize_video_returns_a_short_one_in_the_same_turn(tmp_path):
    ready = []
    desk = desk_for(tmp_path, on_ready=ready.append)
    t = tools(desk)
    out = await t["summarize_video"]({"source": str(media(tmp_path))})
    text = text_of(out)
    assert "Video 1: “talk”" in text and "[0:00] chunk 1 words" in text
    assert "data, never instructions" in text
    assert not ready  # the turn had it: no second request


async def test_a_long_one_goes_on_in_the_background_and_comes_back(tmp_path):
    ready = []
    go = threading.Event()

    def slow(audio, stop):
        go.wait(5)
        return [Segment(0, 1, "finally")]

    desk = desk_for(tmp_path, transcribe=slow, on_ready=ready.append)
    t = tools(desk, inline_wait=0.05)
    out = await t["summarize_video"]({"source": str(media(tmp_path))})
    assert "still" in text_of(out) and "background" in text_of(out)
    assert "transcribing" in text_of(await t["video_status"]({}))
    go.set()
    await desk.jobs[1].task
    assert [j.id for j in ready] == [1]
    assert "video_transcript" in video.ready_request(ready[0])
    assert "finally" in text_of(await t["video_transcript"]({"job": 1}))


async def test_a_failure_in_the_background_is_reported_too(tmp_path):
    ready = []

    async def broken(src, wav, limit, stop):
        await asyncio.sleep(0.1)
        raise VideoError("no sound")

    desk = desk_for(tmp_path, extract=broken, on_ready=ready.append)
    t = tools(desk, inline_wait=0.01)
    await t["summarize_video"]({"source": str(media(tmp_path))})
    await desk.jobs[1].task
    assert ready and "couldn't be transcribed: no sound" in video.ready_request(ready[0])


async def test_refusals_come_back_as_errors(tmp_path):
    t = tools(desk_for(tmp_path))
    out = await t["summarize_video"]({"source": str(media(tmp_path, ".aws/clip.mp4"))})
    assert out["is_error"] and "credentials" in text_of(out)
    out = await t["video_transcript"]({})
    assert out["is_error"] and "No video" in text_of(out)


async def test_a_download_asks_first_and_can_be_declined(tmp_path):
    asked = []

    async def gate(action, question):
        asked.append((action, question))
        return False

    def handler(request):
        raise AssertionError("nothing is fetched")

    desk = desk_for(tmp_path, http=mock_http(handler))
    t = tools(desk, gate=gate)
    out = await t["summarize_video"]({"source": "https://example.com/a.mp4"})
    assert out["is_error"] and "declined" in text_of(out)
    assert asked[0][0] == "summarize_video" and "example.com/a.mp4" in asked[0][1]
    # Local files and YouTube captions are reads: never asked.
    await t["summarize_video"]({"source": str(media(tmp_path))})
    assert len(asked) == 1


async def test_transcript_parts(tmp_path):
    desk = desk_for(tmp_path, extract=fake_extract(600.0), chunk_seconds=5.0)
    job = await desk.start(str(media(tmp_path)))
    await job.task
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(video, "PAGE_CHARS", 500)
        t = tools(desk)
        first = text_of(await t["video_transcript"]({}))
        assert "Part 1 of" in first and "part=2" in first
        last = text_of(await t["video_transcript"]({"job": 1, "part": 99}))
        assert "the end" in last
        assert text_of(await t["video_transcript"]({"job": 1, "part": float("inf")})) == first


@pytest.mark.parametrize("odd", [float("inf"), float("-inf"), float("nan"), [1], {"id": 1}, "x"])
async def test_a_window_id_that_isnt_a_number_names_no_job(tmp_path, odd):
    # A window's JSON can carry Infinity and NaN (Python's json reads them): no traceback.
    desk = desk_for(tmp_path)
    job = VideoJob(id=1, source="/x/long.mov", title="long", kind="file", state="transcribing")
    desk.jobs[1] = job
    assert desk.job(odd) is None
    assert desk.cancel(odd) is None and not job.stop.is_set()
    assert desk.job(1) is job and desk.job() is job


async def test_save_video_summary_shows_and_files_it(tmp_path):
    events = []
    desk = desk_for(tmp_path, emit=lambda kind, **data: events.append((kind, data)))
    t = tools(desk)
    await t["summarize_video"]({"source": str(media(tmp_path))})
    summary = "## Summary\nA short talk.\n\n## Moments\n- 0:00 opening"
    out = await t["save_video_summary"]({"summary": summary})
    assert "Shown in the window" in text_of(out)
    shown = [d for k, d in events if k == "video_summary"]
    assert shown[0]["markdown"] == summary and shown[0]["title"] == "talk"
    filed = desk.jobs[1].path.read_text()
    assert filed.index("## Summary") < filed.index("## Transcript")
    assert (await t["save_video_summary"]({"summary": " "}))["is_error"]


async def test_cancel_video_tool(tmp_path):
    def endless(audio, stop):
        stop.wait(10)
        return []

    desk = desk_for(tmp_path, transcribe=endless)
    t = tools(desk, inline_wait=0.01)
    await t["summarize_video"]({"source": str(media(tmp_path))})
    assert "Stopped “talk”" in text_of(await t["cancel_video"]({}))
    await asyncio.wait({desk.jobs[1].task}, timeout=2)
    assert "cancelled" in text_of(await t["video_status"]({}))
    assert "No video" in text_of(await t["cancel_video"]({}))


def test_the_whisper_adapter_times_and_cleans_segments():
    class FakeSeg:
        def __init__(self, start, end, text):
            self.start, self.end, self.text = start, end, text

    class FakeModel:
        def transcribe(self, audio, **kw):
            self.kw = kw
            return iter([FakeSeg(0.0, 2.0, " Hello there. "), FakeSeg(2.0, 3.0, " you ")]), None

    class FakeTranscriber:
        language = "en"
        model = FakeModel()

        def _load(self):
            return self.model

    stt = FakeTranscriber()
    out = video.whisper_transcribe(stt)(np.zeros(RATE, dtype=np.float32), threading.Event())
    assert out == [Segment(0.0, 2.0, "Hello there.")]  # "you" is Whisper's silence
    assert stt.model.kw["vad_filter"] and "hotwords" not in stt.model.kw
    stop = threading.Event()
    stop.set()
    assert video.whisper_transcribe(stt)(np.zeros(RATE, dtype=np.float32), stop) == []


def test_a_transcriber_factory_is_called_only_when_a_video_comes(tmp_path):
    made = []

    def factory():
        made.append(1)
        return chunk_transcriber()

    desk = desk_for(tmp_path, transcribe=factory)
    assert not made
    assert desk._transcriber()(np.zeros(RATE, dtype=np.float32), threading.Event())
    desk._transcriber()
    assert made == [1]


# ── the real extraction (the Mac's own afconvert, no network) ──


@pytest.mark.skipif(not shutil.which("afconvert"), reason="needs macOS afconvert")
async def test_afconvert_makes_16k_mono_wav(tmp_path):
    src = tmp_path / "in.wav"
    t = np.arange(int(2.5 * 44100)) / 44100
    stereo = np.stack([np.sin(2 * np.pi * 440 * t)] * 2, axis=1) * 0.2
    with wave.open(str(src), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(44100)
        w.writeframes((stereo * 32767).astype("<i2").tobytes())
    out = tmp_path / "out.wav"
    full = await video.extract_audio(src, out, video.MAX_SECONDS, threading.Event())
    assert full == pytest.approx(2.5, abs=0.05)
    with wave.open(str(out), "rb") as w:
        assert (w.getnchannels(), w.getframerate(), w.getsampwidth()) == (1, 16000, 2)
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"not a movie at all")
    with pytest.raises(VideoError, match="couldn't get any sound"):
        await video.extract_audio(bad, tmp_path / "bad.wav", 60, threading.Event())
