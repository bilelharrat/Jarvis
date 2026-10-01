"""Videos with Google's Veo on the owner's Gemini key (jarvis.videogen, features.video_gen):
the long-running operation as Google documents it (start, ask how it's going, fetch the
video by way of a redirect that never gets the key), saved in the test's own folder; a card
with the estimated price every time; capped a day across restarts; opened only by id.
Google is a fake (httpx.MockTransport): nothing leaves the Mac."""

import asyncio
import json

import httpx
import pytest
from conftest import FakeClient

from jarvis import lang, utility_model, videogen
from jarvis.features import video_gen
from jarvis.hub import Hub
from jarvis.videogen import VideoDesk, VideoError

GOOGLE_KEY = "AIza" + "v" * 35
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 200
OP = "models/veo-3.0-fast-generate-001/operations/abc123"
FILE_URI = "https://generativelanguage.googleapis.com/v1beta/files/f1:download?alt=media"
STORAGE = "https://storage.example-google-cdn.com/videos/f1.mp4?sig=xyz"


def finished(uri=FILE_URI):
    return {
        "name": OP,
        "done": True,
        "response": {"generateVideoResponse": {"generatedSamples": [{"video": {"uri": uri}}]}},
    }


class Google:
    """A fake Gemini API for Veo: the start, `pending` answers of "not yet", then `done`;
    the file redirects to storage, which serves `video`. Every request kept."""

    def __init__(self, done=None, pending=1, video=MP4, start=(200, {"name": OP})):
        self.done = done or finished()
        self.pending = pending
        self.video = video
        self.start = start
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        url = str(request.url)
        if url.endswith(":predictLongRunning"):
            status, body = self.start
            return httpx.Response(status, json=body)
        if url.endswith(OP):
            if self.pending:
                self.pending -= 1
                return httpx.Response(200, json={"name": OP})
            return httpx.Response(200, json=self.done)
        if url == FILE_URI:
            return httpx.Response(302, headers={"location": STORAGE})
        if url == STORAGE:
            return httpx.Response(200, content=self.video)
        return httpx.Response(404, json={"error": {"message": "no such thing"}})

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self))


def desk_for(tmp_path, google):
    desk = VideoDesk(tmp_path / "Videos", google.client())
    desk.poll_every = 0
    return desk


# ── the desk ──


async def test_a_video_is_started_waited_for_and_fetched_without_the_key_leaving_google(tmp_path):
    google = Google(pending=2)
    desk = desk_for(tmp_path, google)
    name = await desk.start(
        GOOGLE_KEY, "  a fox   running in snow ", model=videogen.DEFAULT_MODEL, aspect="9:16"
    )
    assert name == OP
    first = google.requests[0]
    assert str(first.url) == (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        "veo-3.0-fast-generate-001:predictLongRunning"
    )
    assert first.method == "POST" and first.headers["x-goog-api-key"] == GOOGLE_KEY
    assert json.loads(first.content) == {
        "instances": [{"prompt": "a fox running in snow"}],
        "parameters": {"aspectRatio": "9:16"},
    }
    done = await desk.wait(GOOGLE_KEY, name)
    polls = [r for r in google.requests if r.method == "GET" and str(r.url).endswith(OP)]
    assert (
        len(polls) == 3
        and str(polls[0].url) == f"https://generativelanguage.googleapis.com/v1beta/{OP}"
    )
    made = await desk.download(GOOGLE_KEY, desk.video_uri(done), "a fox running in snow")
    file_get, storage_get = google.requests[-2:]
    assert file_get.headers["x-goog-api-key"] == GOOGLE_KEY
    assert "x-goog-api-key" not in storage_get.headers  # the key never goes to another host
    saved = tmp_path / "Videos" / made["name"]
    assert made["path"] == str(saved) and saved.read_bytes() == MP4 and made["size"] == len(MP4)
    assert made["name"].endswith(" a fox running in snow.mp4")
    assert desk.path_of(made["id"]) == saved and desk.path_of("nope") is None
    assert not list((tmp_path / "Videos").glob(".*"))


@pytest.mark.parametrize(
    "done, why",
    [
        (
            {"done": True, "error": {"code": 3, "message": "bad prompt"}},
            "Google couldn't make the video: bad prompt",
        ),
        (
            {
                "done": True,
                "response": {
                    "generateVideoResponse": {
                        "raiMediaFilteredCount": 1,
                        "raiMediaFilteredReasons": ["Celebrity likeness."],
                    }
                },
            },
            "safety filters held the video back: Celebrity",
        ),  # fmt: skip
        ({"done": True, "response": {}}, "Google finished without a video"),
    ],
)
def test_what_a_finished_operation_without_a_video_says(done, why):
    with pytest.raises(VideoError, match=why):
        VideoDesk.video_uri(done)


@pytest.mark.parametrize(
    "status, body, why",
    [
        (403, {"error": {"message": "API key not valid"}}, "didn't accept the key for videos"),
        (404, {"error": {"message": "not found"}}, "no video model called veo-9"),
        (429, {}, "limiting video requests"),
        (
            400,
            {"error": {"message": "prompt too long"}},
            "wouldn't make that video: prompt too long",
        ),
        (500, {}, r"a problem \(500\)"),
        (200, {"name": "elsewhere/operations/x"}, "didn't start a video"),
    ],
)
async def test_what_google_says_when_it_wont_start(tmp_path, status, body, why):
    desk = desk_for(tmp_path, Google(start=(status, body)))
    with pytest.raises(VideoError, match=why):
        await desk.start(GOOGLE_KEY, "a cat", model="veo-9")


async def test_nothing_is_fetched_from_elsewhere_and_only_a_video_is_kept(tmp_path):
    google = Google()
    desk = desk_for(tmp_path, google)
    with pytest.raises(VideoError, match="isn't its own"):
        await desk.download(GOOGLE_KEY, "https://evil.example.com/v.mp4", "x")
    with pytest.raises(VideoError, match="isn't its own"):
        await desk.download(GOOGLE_KEY, "http://generativelanguage.googleapis.com/x", "x")
    assert google.requests == []
    google.video = b"<html>not a video</html>"
    with pytest.raises(VideoError, match="isn't a video"):
        await desk.download(GOOGLE_KEY, FILE_URI, "x")
    assert not list((tmp_path / "Videos").iterdir())  # no half-kept file
    with pytest.raises(VideoError, match="isn't one of Google's video operations"):
        await desk.check(GOOGLE_KEY, "../../files/secret")


async def test_waiting_gives_up_in_the_end(tmp_path):
    desk = desk_for(tmp_path, Google(pending=10**6))
    desk.give_up_after = 0
    with pytest.raises(VideoError, match="took too long"):
        await desk.wait(GOOGLE_KEY, OP)


def test_models_and_what_they_cost():
    assert videogen.clean_model("veo-3.1-generate-preview") == "veo-3.1-generate-preview"
    assert (
        videogen.clean_model("gemini-2.5-flash") is None
        and videogen.clean_model("veo-/../x y") is None
    )
    assert videogen.estimate(videogen.DEFAULT_MODEL) == 1.2
    assert videogen.cost_note(videogen.DEFAULT_MODEL) == "about $1.20 for 8 seconds"
    assert videogen.estimate(
        "veo-99"
    ) is None and "Google's price for veo-99" in videogen.cost_note("veo-99")


# ── the feature on the hub ──


@pytest.fixture
def hub(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    hub.providers.add_provider("gemini", "", GOOGLE_KEY)
    hub.google = Google()
    hub.videos.desk.client = hub.google.client()
    hub.videos.desk.poll_every = 0
    hub.opened = []
    hub.videos.open = lambda *args: hub.opened.append(args)  # never a real app
    hub.events, hub.alerts = [], []
    hub.emit = lambda kind, **data: hub.events.append((kind, data))
    hub.add_notify_sink(hub.alerts.append)
    return hub


async def make(hub, prompt="a fox running in snow", answer="allow"):
    [generate_video] = hub.videos.build_tools()
    call = asyncio.ensure_future(generate_video.handler({"prompt": prompt}))
    for _ in range(200):
        await asyncio.sleep(0.005)
        if hub.approvals or call.done():
            break
    cards = list(hub.approvals.values())
    if cards:
        hub.resolve(cards[0]["id"], answer)
    out = await call
    await asyncio.gather(*list(hub.videos.running))
    return out, cards


async def test_even_the_owners_own_words_get_a_card_with_the_estimate(hub):
    hub._turn_text = "make me a video of a fox running in snow"
    out, [card] = await make(hub)
    assert "Make a video with Google Veo?" in card["question"]
    assert (
        "a fox running in snow" in card["detail"] and "about $1.20 for 8 seconds" in card["detail"]
    )
    assert not out.get("is_error") and "Started" in out["content"][0]["text"]
    [(kind, made)] = [e for e in hub.events if e[0] == "video_made"]
    assert made["path"].startswith(str(hub.feature_path("Videos")))  # never ~/Documents here
    assert made["cost"] == "about $1.20 for 8 seconds"
    [alert] = hub.alerts
    assert alert.title == "Video" and alert.text == f"Your video is ready: {made['name']}."
    await hub._handle({"type": "video_open", "id": made["id"]})
    await hub._handle({"type": "video_reveal", "id": made["id"]})
    await hub._handle({"type": "video_open", "id": "not-one-of-ours"})
    assert hub.opened == [(made["path"],), ("-R", made["path"])]


async def test_a_no_sends_nothing(hub):
    out, [_card] = await make(hub, answer="deny")
    assert out.get("is_error") and hub.google.requests == [] and hub.alerts == []


async def test_no_key_no_card_and_nothing_sent(settings, quiet_speaker, isolated):
    hub = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    google = Google()
    hub.videos.desk.client = google.client()
    out, cards = await make(hub)
    assert out.get("is_error") and "no Google Gemini key" in out["content"][0]["text"]
    assert cards == [] and google.requests == []


async def test_a_failed_video_says_why_in_a_heads_up(hub):
    hub.google.done = {"done": True, "error": {"message": "quota"}}
    out, _cards = await make(hub)
    assert not out.get("is_error")  # it started; what came of it is the heads-up's
    [alert] = hub.alerts
    assert alert.text == "No video this time: Google couldn't make the video: quota"
    assert not [e for e in hub.events if e[0] == "video_made"]


async def test_a_day_holds_so_many_even_across_a_restart(hub, settings, quiet_speaker, isolated):
    for _ in range(videogen.PER_DAY):
        out, _ = await make(hub)
        assert not out.get("is_error")
    out, _ = await make(hub)
    assert out.get("is_error") and f"{videogen.PER_DAY} videos today" in out["content"][0]["text"]
    starts = [r for r in hub.google.requests if str(r.url).endswith(":predictLongRunning")]
    assert len(starts) == videogen.PER_DAY  # the one past the cap was never sent
    again = Hub(settings, client_factory=FakeClient, speaker=quiet_speaker, poll=False, **isolated)
    assert utility_model.usage_for(again).left("video") == 0


async def test_another_model_and_the_settings_view(hub):
    hub.set_feature_prefs({"video_model": "not a model!"})  # refused: the default stays
    assert hub.videos.model() == videogen.DEFAULT_MODEL
    hub.set_feature_prefs({"video_model": "veo-3.1-generate-preview"})
    await make(hub)
    assert "/veo-3.1-generate-preview:predictLongRunning" in str(hub.google.requests[0].url)
    hub.videos.state({})
    view = hub.events[-1][1]
    assert (
        view["key"]
        and view["model"] == "veo-3.1-generate-preview"
        and view["cost"] == "about $3.20 for 8 seconds"
    )


async def test_in_chinese(hub):
    hub.prefs.language = "zh"
    assert hub.videos.cost(videogen.DEFAULT_MODEL) == "8 秒大约 1.20 美元"
    for english, chinese in video_gen.ZH.items():
        assert lang.translate(english, "zh") == chinese or "{" in english, english
    assert (
        lang.translate("Google couldn't make the video: quota", "zh")
        == "Google 没能做出这段视频：quota"
    )
