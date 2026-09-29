"""The hub's side of video summaries: served and prompted, a video dropped on the window is
asked about, a background one reports back as a turn of its own, and "Open" opens only a
write-up the desk filed. Fakes for Claude and the desk's folders in a temp folder."""

import asyncio

from test_hub import drain, make_hub

from jarvis import hub as hub_module
from jarvis.video import VideoJob


async def _first_query(hub):
    for _ in range(200):
        await asyncio.sleep(0.01)
        if hub.client and hub.client.queries:
            return hub.client.said[-1]
    raise AssertionError("no turn was started")


def test_the_video_tools_are_served_and_prompted(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    assert "video" in hub._feature_servers()
    assert "summarize_video" in hub._feature_prompt()
    assert hub.video.notes_dir == tmp_path / "Videos"  # never the real Documents folder
    assert hub.snapshot()["videos"] == []


async def test_a_dropped_video_is_summarized(settings, quiet_speaker, isolated, tmp_path):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    clip = tmp_path / "Q3 review.mp4"
    await hub._handle({"type": "video_summarize", "path": str(clip)})
    assert await _first_query(hub) == f"Summarize the video at {clip}"
    # The window shows the file's name, not the request built around its path.
    assert [h["text"] for h in hub.history if h["role"] == "user"] == ["Summarize “Q3 review.mp4”"]
    # A drop isn't the owner's own words: nothing is learned from it.
    assert hub.suggester.history == [] and hub.hearing.corrections == {}


async def test_a_background_video_reports_back(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    job = VideoJob(id=3, source="/x/talk.mp4", title="talk", kind="file", state="ready")
    hub.video.on_ready(job)
    said = await _first_query(hub)
    assert said.startswith("[Video 3, “talk”, is transcribed.]")
    assert "save_video_summary" in said
    assert [h["text"] for h in hub.history if h["role"] == "user"] == ["Video: talk"]


async def test_progress_reaches_the_window(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    q = hub.subscribe()
    job = VideoJob(id=4, source="/x/talk.mp4", title="talk", kind="file", state="transcribing")
    hub.video.jobs[4] = job
    hub.video._changed(job)
    events = [e for e in drain(q) if e["type"] == "video"]
    assert events and events[-1]["job"]["id"] == 4 and events[-1]["job"]["state"] == "transcribing"


def test_a_named_video_is_looked_up_only_with_the_index_on(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    hub.prefs.file_index = False
    assert hub._video_find("the Okin demo") == []


async def test_open_only_opens_what_the_desk_filed(
    settings, quiet_speaker, isolated, tmp_path, monkeypatch
):
    opened = []
    monkeypatch.setattr(hub_module.subprocess, "Popen", lambda args, **_k: opened.append(args))
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub._handle({"type": "video_open", "id": 99})  # no such job
    await hub._handle({"type": "video_open", "id": "../../etc/passwd"})
    job = VideoJob(id=7, source="/x/talk.mp4", title="talk", kind="file", state="ready")
    hub.video.jobs[7] = job
    await hub._handle({"type": "video_open", "id": 7})  # nothing filed yet
    assert opened == []

    filed = tmp_path / "Videos" / "talk.md"
    filed.parent.mkdir(parents=True, exist_ok=True)
    filed.write_text("# talk\n")
    job.path = filed
    await hub._handle({"type": "video_open", "id": 7})
    await hub._handle({"type": "video_open", "id": 7, "reveal": True})
    assert opened == [["open", str(filed)], ["open", "-R", str(filed)]]


async def test_cancel_stops_the_video_in_progress(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    job = VideoJob(id=5, source="/x/long.mov", title="long", kind="file", state="transcribing")
    hub.video.jobs[5] = job
    await hub._handle({"type": "video_cancel", "id": 5})
    assert job.stop.is_set()
