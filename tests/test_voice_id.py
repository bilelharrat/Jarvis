"""Owner voice recognition (voiceprint.py, features/voice_id.py and the hub's check):
enrollment, the model download, the check in both scopes, the fallbacks. Canned audio
arrays and a fake embedder only: no microphone, no model, no network."""

import asyncio
import hashlib
import json
import threading
import time

import numpy as np
import pytest
from test_hub import Listener, make_hub

from jarvis import voiceprint
from jarvis.features import voice_id

DIM = 64
OWNER = np.eye(DIM, dtype=np.float32)[0]
GUEST = np.eye(DIM, dtype=np.float32)[1]


def speech(who: str, seconds: float = 1.5) -> np.ndarray:
    """Canned 16 kHz "speech": its first sample says whose voice it is (to the fake)."""
    audio = np.full(int(voiceprint.SAMPLE_RATE * seconds), 0.01, dtype=np.float32)
    audio[0] = {"owner": 0.5, "guest": -0.5}[who]
    return audio


class FakeEmbedder:
    """Stands in for the ONNX model: a realistic ~30 ms, and a vector near the speaker's."""

    def __init__(self, delay: float = 0.03):
        self.delay, self.calls = delay, 0
        self.rng = np.random.default_rng(7)

    def __call__(self, audio):
        self.calls += 1
        time.sleep(self.delay)
        base = OWNER if audio[0] > 0 else GUEST
        return voiceprint.unit(base + 0.15 * self.rng.standard_normal(DIM).astype(np.float32))


class Words:
    """A transcriber that takes a while, like Whisper, and hears the given words."""

    def __init__(self, text: str, delay: float = 0.0):
        self.text, self.delay = text, delay

    def transcribe(self, _audio, _hints=None):
        time.sleep(self.delay)
        return self.text


def enrolled_guard(hub, scope="risky", delay=0.03):
    guard = voice_id.guard_for(hub)
    hub.set_feature_prefs({"voice_id_on": True, "voice_id_scope": scope})
    guard.embedder = FakeEmbedder(delay)
    embedder = FakeEmbedder(0)
    guard.print = voiceprint.enroll([embedder(speech("owner")) for _ in range(5)])
    guard.loaded = True
    return guard


async def hands_free(hub):
    hub.listener_factory = Listener
    await hub.start()
    hub.set_prefs({"hands_free": True})
    return hub


async def hear(hub, who, settle=0.3):
    hub._heard.put_nowait(("full", time.monotonic(), speech(who)))
    await asyncio.sleep(settle)


async def until(condition, seconds=10.0):
    """Whether condition() comes true within seconds (generous: a busy Mac is slow)."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        await asyncio.sleep(0.005)
    return bool(condition())


class Held(FakeEmbedder):
    """A check that answers only once let go: a Mac far too busy to check in time."""

    def __init__(self):
        super().__init__(0)
        self.go = threading.Event()

    def __call__(self, audio):
        self.go.wait(30)
        return super().__call__(audio)


# ── voiceprint.py ──


def test_fbank_has_80_bins_and_is_mean_normalised():
    feats = voiceprint.fbank(np.sin(np.arange(16000) / 5).astype(np.float32))
    assert feats.shape == (98, 80) and abs(float(feats.mean())) < 1e-3
    assert voiceprint.fbank(np.zeros(100, np.float32)).shape == (0, 80)


def test_enroll_tunes_the_threshold_to_the_owners_own_clips(tmp_path):
    e = FakeEmbedder(0)
    owner = voiceprint.enroll([e(speech("owner")) for _ in range(5)])
    assert voiceprint.THRESHOLD_LOW <= owner.threshold <= voiceprint.THRESHOLD_HIGH
    assert owner.matches(e(speech("owner"))) and not owner.matches(e(speech("guest")))
    with pytest.raises(ValueError):
        voiceprint.enroll([e(speech("owner"))])
    path = tmp_path / "voice_id" / "voiceprint.json"
    owner.save(path)
    back = voiceprint.Voiceprint.load(path)
    assert back is not None and back.clips == 5 and abs(back.threshold - owner.threshold) < 1e-3
    assert (path.stat().st_mode & 0o777) == 0o600 and not path.with_name(
        "voiceprint.json.bak"
    ).exists()
    voiceprint.forget(path)
    assert voiceprint.Voiceprint.load(path) is None


@pytest.mark.parametrize(
    "content",
    ["{not json", json.dumps({"vector": ["x"]}), json.dumps({"vector": [0] * 64}), "[]",
     json.dumps({"vector": [1.0] * 64, "threshold": "high"})],
)  # fmt: skip
def test_a_damaged_voiceprint_is_no_voiceprint(tmp_path, content):
    path = tmp_path / "voiceprint.json"
    path.write_text(content)
    assert voiceprint.Voiceprint.load(path) is None


async def test_download_checks_the_checksum_before_the_model_is_kept(tmp_path):
    body = b"onnx" * 1000
    model = {"url": "https://example.test/speaker.onnx", "sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}  # fmt: skip
    urls, seen = [], []

    async def fetch(url):
        urls.append(url)
        for i in range(0, len(body), 1000):
            yield len(body), body[i : i + 1000]

    dest = tmp_path / "speaker.onnx"
    await voiceprint.download(dest, model, lambda d, t: seen.append((d, t)), fetch)
    assert dest.read_bytes() == body and urls == [model["url"]] and seen[-1] == (4000, 4000)
    dest.unlink()
    with pytest.raises(ValueError, match="checksum"):
        await voiceprint.download(dest, {**model, "sha256": "0" * 64}, None, fetch)
    assert not dest.exists() and not list(tmp_path.iterdir())  # no .part left behind
    with pytest.raises(ValueError, match="set up"):  # a build with no model named
        await voiceprint.download(dest, {"url": "", "sha256": "", "size": 0}, None, fetch)
    assert len(urls) == 2  # an unconfigured model never fetches anything


# ── the feature: settings, download, enrollment ──


async def test_turning_it_on_shows_why_its_off_until_it_can_check(
    settings, quiet_speaker, isolated, monkeypatch
):
    # A build with no model named first (the shipped one names WeSpeaker's).
    monkeypatch.setattr(voiceprint, "SPEAKER_MODEL", {"url": "", "sha256": "", "size": 0})
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    guard = voice_id.guard_for(hub)
    q = hub.subscribe()
    await hub.handle({"type": "voice_id_status"})
    state = [e for e in drain(q) if e["type"] == "voice_id"][-1]
    assert not state["on"] and state["why"] == "" and state["scope"] == "risky"
    await hub.handle({"type": "voice_id_settings", "changes": {"voice_id_on": True}})
    state = [e for e in drain(q) if e["type"] == "voice_id"][-1]
    assert state["on"] and not state["configured"] and "isn’t set up" in state["why"]
    # A build with a model set up: the size is shown, and pressing Download fetches it.
    body = b"model"
    guard.model = {"url": "https://example.test/m.onnx", "sha256": hashlib.sha256(body).hexdigest(), "size": 5}  # fmt: skip
    await hub.handle({"type": "voice_id_status"})
    state = [e for e in drain(q) if e["type"] == "voice_id"][-1]
    assert state["size"] == 5 and not state["model"] and "Download" in state["why"]

    async def fetch(_url):
        yield 5, body

    guard.fetch = fetch
    guard.embedder_factory = lambda _path: FakeEmbedder(0)
    await hub.handle({"type": "voice_id_download"})
    for _ in range(50):
        await asyncio.sleep(0.01)
        if guard.model_path.is_file() and guard.embedder is not None:
            break
    state = [e for e in drain(q) if e["type"] == "voice_id"][-1]
    assert state["model"] and state["downloading"] is None and "Teach Jarvis" in state["why"]
    await hub.handle({"type": "voice_id_settings", "changes": {"voice_id_scope": "bogus"}})
    assert hub.prefs.feature("voice_id_scope") == "risky"


def drain(queue):
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


async def test_enrollment_reads_five_sentences_retries_a_short_one_and_saves(
    settings, quiet_speaker, isolated
):
    clips = [speech("owner"), speech("owner", 0.3), *[speech("owner") for _ in range(4)]]
    recorded = []

    def recorder(silence, _level):
        recorded.append(silence)
        return clips.pop(0)

    hub = make_hub(settings, quiet_speaker, recorder=recorder, isolated=isolated)
    guard = voice_id.guard_for(hub)
    hub.set_feature_prefs({"voice_id_on": True})
    guard.model_path.parent.mkdir(parents=True)
    guard.model_path.write_bytes(b"fake")
    guard.embedder_factory = lambda _path: FakeEmbedder(0)
    q = hub.subscribe()
    await hub.handle({"type": "voice_id_enroll", "action": "start"})
    for _ in range(100):
        await asyncio.sleep(0.01)
        if guard.enrolling is None:
            break
    steps = [e["enrolling"] for e in drain(q) if e["type"] == "voice_id" and e["enrolling"]]
    assert [s["index"] for s in steps] == [0, 1, 1, 2, 3, 4]
    assert [s["again"] for s in steps] == [False, False, True, False, False, False]
    assert len(recorded) == 6 and guard.print is not None and guard.print.clips == 5
    saved = voiceprint.Voiceprint.load(guard.print_path)
    assert saved is not None and saved.matches(FakeEmbedder(0)(speech("owner")))
    assert guard.why_off() == ""
    # Forget my voice: the file is gone, and it's off again until retrained.
    await hub.handle({"type": "voice_id_forget"})
    assert not guard.print_path.exists() and guard.print is None
    assert "Teach Jarvis" in guard.why_off()


async def test_enrollment_gives_up_on_silence_and_keeps_the_old_voiceprint(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, recorder=lambda *_: None, isolated=isolated)
    guard = enrolled_guard(hub)
    old = guard.print
    q = hub.subscribe()
    await guard.enroll({"action": "start"})
    for _ in range(100):
        await asyncio.sleep(0.01)
        if guard.enrolling is None:
            break
    last = [e for e in drain(q) if e["type"] == "voice_id"][-1]
    assert guard.print is old and "couldn’t hear" in last["error"] and last["enrolling"] is None
    assert guard.public()["error"] == ""  # said once


async def test_enrollment_needs_the_model(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, recorder=lambda *_: speech("owner"), isolated=isolated)
    guard = voice_id.guard_for(hub)
    hub.set_feature_prefs({"voice_id_on": True})
    await guard.enroll({"action": "start"})
    assert guard.enrolling is None and guard.print is None


# ── the check, in hands-free ──


async def test_everything_mode_ignores_anyone_else(settings, quiet_speaker, isolated):
    hub = await hands_free(make_hub(settings, quiet_speaker, isolated=isolated))
    hub.transcriber = Words("Jarvis, what's on tomorrow?", 0.05)
    enrolled_guard(hub, "all")
    q = hub.subscribe()
    await hear(hub, "guest")
    assert hub.client.said == []
    assert not [e for e in drain(q) if e["type"] == "reply" and e.get("text")]
    await hear(hub, "owner")
    assert hub.client.said == ["what's on tomorrow"]


async def test_risky_mode_answers_anyone_but_their_words_arent_the_owners(
    settings, quiet_speaker, isolated
):
    hub = await hands_free(make_hub(settings, quiet_speaker, isolated=isolated))
    hub.transcriber = Words("Jarvis, send Ben the report", 0.05)
    enrolled_guard(hub, "risky")
    words = []
    before = hub._before_query

    async def spy(text, rid):
        words.append(text)
        await before(text, rid)

    hub._before_query = spy
    await hear(hub, "guest")
    await hear(hub, "owner")
    assert hub.client.said == ["send Ben the report"] * 2
    # The guest's request was answered, but the gates see no words of the owner's: a
    # send, a purchase or a delete asks first.
    assert words == ["", "Jarvis, send Ben the report".removeprefix("Jarvis, ")]


async def _card(hub):
    task = asyncio.create_task(hub.request_approval("Send this to Ben?"))
    for _ in range(20):
        await asyncio.sleep(0.005)
        if hub.approvals:
            break
    (aid,) = hub.approvals
    hub._voice_asked[aid] = {"text": "Send this to Ben?", "at": time.monotonic()}
    hub._spoke_until = 0.0
    return task


@pytest.mark.parametrize("scope", ["risky", "all"])
async def test_a_spoken_approval_must_be_the_owners(settings, quiet_speaker, isolated, scope):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    guard = enrolled_guard(hub, scope)
    said = []
    hub.say = lambda text, follow_up=True: said.append(text)
    card = await _card(hub)
    hub._heard_voice = guard.start(speech("guest"))
    await hub.on_heard("yes")
    assert not card.done() and hub.approvals  # the card stays up for the owner
    assert said == ([voice_id.REFUSED] if scope == "risky" else [])
    hub._heard_voice = guard.start(speech("owner"))
    await hub.on_heard("yes")
    assert await asyncio.wait_for(card, 1) == "allow"


async def test_the_refusal_is_said_in_chinese(settings, quiet_speaker, isolated):
    from jarvis import lang

    assert lang.translate(voice_id.REFUSED, "zh") == "抱歉，只有主人的声音才能批准这个。"


# ── fallbacks: as before, never blocking ──


@pytest.mark.parametrize("why", ["off", "not_enrolled", "no_model", "fails", "too_short", "slow"])
async def test_fallbacks_behave_as_before(settings, quiet_speaker, isolated, why, monkeypatch):
    hub = await hands_free(make_hub(settings, quiet_speaker, isolated=isolated))
    hub.transcriber = Words("Jarvis, what's on tomorrow?")
    guard = enrolled_guard(hub, "all")
    # Never blocking: without a check, or with a failed one, the answer comes long before
    # a check could time out; a slow check times out at once, while it's still running.
    monkeypatch.setattr(voice_id, "CHECK_WAIT", 0.05 if why == "slow" else 60.0)
    if why == "off":
        hub.set_feature_prefs({"voice_id_on": False})
    elif why == "not_enrolled":
        guard.print = None
    elif why == "no_model":
        guard.embedder = None
    elif why == "fails":
        guard.embedder = lambda _audio: 1 / 0
    elif why == "slow":
        guard.embedder = Held()
    audio = speech("guest", 0.3 if why == "too_short" else 1.5)
    hub._heard.put_nowait(("full", time.monotonic(), audio))
    try:
        # Answered, as without the check (a guest's voice, with "Everything" chosen).
        assert await until(lambda: hub.client is not None and hub.client.said)
        assert hub.client.said == ["what's on tomorrow"]
        if why == "slow":
            assert guard.embedder.calls == 0  # the check hadn't answered yet
    finally:
        if why == "slow":
            guard.embedder.go.set()
    if why == "slow":  # its verdict, had it come in time: not the owner
        assert await asyncio.wait_for(asyncio.shield(hub._heard_voice), 30) is False


async def test_typed_and_push_to_talk_requests_are_never_checked(settings, quiet_speaker, isolated):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    guard = enrolled_guard(hub, "all")
    guard.embedder = lambda _audio: pytest.fail("a typed request was checked")
    hub._heard_voice = asyncio.ensure_future(asyncio.sleep(0, result=False))  # a stale one
    await hub.handle({"type": "ask", "text": "what's on tomorrow?"})
    await asyncio.sleep(0.05)
    assert hub.client.said == ["what's on tomorrow?"]


async def test_first_utterance_after_turning_on_loads_without_waiting(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    guard = voice_id.guard_for(hub)
    hub.set_feature_prefs({"voice_id_on": True})
    assert guard.start(speech("owner")) is None  # nothing loaded yet: not checked
    await asyncio.sleep(0.05)
    assert guard.loaded


async def test_look_ahead_has_the_verdict_ready_when_the_utterance_ends(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    guard = enrolled_guard(hub, "all")
    listener = Listener()
    guard.attach(listener)
    audio = speech("guest", 2.0)
    for i in range(0, audio.size, 800):
        listener.on_block(audio[i : i + 800], True)
    # One look at a time: the first (0.6 s of speech) runs, and of the ones asked for
    # while it ran (1.1 s, 1.6 s) only the newest follows.
    for _ in range(100):
        if any(heard >= 1.5 and check.done() for _, heard, check in guard._ahead):
            break
        await asyncio.sleep(0.01)
    calls = guard.embedder.calls
    assert calls == 2 and [round(heard, 1) for _, heard, _ in guard._ahead] == [0.6, 1.6]
    check = guard.start(audio)
    assert check.done() and check.result() is False and guard.embedder.calls == calls
    listener.on_block(audio[:800], False)  # the utterance is over: nothing kept
    assert guard._heard == []
    # Another utterance, later and much longer than any look-ahead: checked afresh.
    guard._ahead.clear()
    fresh = guard.start(speech("owner", 3.0))
    assert fresh is not None and await fresh is True


# ── the owner from across the room (measured: live scores 0.31-0.42 against 0.55) ──


class Scored:
    """A fake embedder whose vector sits at a chosen cosine from the owner's: the canned
    audio's first sample is the score."""

    def __init__(self):
        self.calls, self.threads, self.lengths = 0, set(), []

    def __call__(self, audio):
        import threading

        self.calls += 1
        self.threads.add(threading.current_thread().name)
        self.lengths.append(voiceprint.seconds(audio))
        c = float(audio[0])
        return voiceprint.unit(c * OWNER + (1 - c * c) ** 0.5 * GUEST)


def at_score(score: float, seconds: float = 1.5) -> np.ndarray:
    audio = np.full(int(voiceprint.SAMPLE_RATE * seconds), 0.01, dtype=np.float32)
    audio[0] = score
    return audio


def close_clips_guard(hub, scope):
    """Enrolled from clips read in one sitting, so alike that they'd set a high bar."""
    guard = voice_id.guard_for(hub)
    hub.set_feature_prefs({"voice_id_on": True, "voice_id_scope": scope})
    guard.embedder = Scored()
    guard.print = voiceprint.enroll([OWNER + 0.01 * GUEST] * 5)
    guard.loaded = True
    return guard


def test_the_bars_leave_room_for_the_owners_live_voice(tmp_path):
    owner = voiceprint.enroll([OWNER + 0.01 * GUEST] * 5)
    assert owner.threshold == pytest.approx(voiceprint.THRESHOLD_HIGH)  # not 0.55 any more
    judged = {s: owner.judge(s) for s in (0.42, 0.31, 0.25, 0.1)}
    assert judged == {0.42: "owner", 0.31: "owner", 0.25: "unsure", 0.1: "other"}
    # A voiceprint saved at the old ceiling is read at the new one: no new enrollment.
    path = tmp_path / "voiceprint.json"
    path.write_text(json.dumps({"vector": [1.0] + [0.0] * 63, "threshold": 0.55, "clips": 5}))
    back = voiceprint.Voiceprint.load(path)
    assert back is not None and back.threshold == pytest.approx(voiceprint.THRESHOLD_HIGH)


@pytest.mark.parametrize("score", [0.31, 0.36, 0.42])
async def test_everything_mode_answers_the_owner_at_their_measured_scores(
    settings, quiet_speaker, isolated, score
):
    hub = await hands_free(make_hub(settings, quiet_speaker, isolated=isolated))
    hub.transcriber = Words("Jarvis, what's on tomorrow?", 0.05)
    close_clips_guard(hub, "all")
    hub._heard.put_nowait(("full", time.monotonic(), at_score(score)))
    await asyncio.sleep(0.3)
    assert hub.client.said == ["what's on tomorrow"]


async def test_an_unsure_voice_is_answered_but_risky_steps_ask(settings, quiet_speaker, isolated):
    hub = await hands_free(make_hub(settings, quiet_speaker, isolated=isolated))
    hub.transcriber = Words("Jarvis, send Ben the report", 0.05)
    close_clips_guard(hub, "all")
    words = []
    before = hub._before_query

    async def spy(text, rid):
        words.append(text)
        await before(text, rid)

    hub._before_query = spy
    hub._heard.put_nowait(("full", time.monotonic(), at_score(0.25)))
    await asyncio.sleep(0.3)
    hub._heard.put_nowait(("full", time.monotonic(), at_score(0.05)))
    await asyncio.sleep(0.3)
    # Unsure: answered (never silence for the owner across the room), but its words aren't
    # the owner's, so a send asks first. Clearly someone else, with "Everything": ignored.
    assert hub.client.said == ["send Ben the report"] and words == [""]


async def test_checks_run_on_their_own_thread_and_only_on_the_first_seconds(
    settings, quiet_speaker, isolated
):
    hub = make_hub(settings, quiet_speaker, isolated=isolated)
    await hub.start()
    guard = close_clips_guard(hub, "all")
    listener = Listener()
    guard.attach(listener)
    long = at_score(0.36, 12.0)  # a long utterance (a monologue, a TV)
    for i in range(0, long.size, 800):
        listener.on_block(long[i : i + 800], True)
    for _ in range(100):
        await asyncio.sleep(0.01)
        if guard._ahead and all(c.done() for _, _, c in guard._ahead) and not guard._next_look:
            break
    looks = guard.embedder.calls
    # Looked at only over its first LOOK_SECONDS, never more than one at a time: two checks,
    # where every half second of all twelve used to start one (twenty-three).
    assert looks == 2 and max(guard.embedder.lengths) == pytest.approx(voice_id.LOOK_SECONDS)
    full = guard.start(long)
    assert full is not None and await full is True and guard.embedder.calls == looks
    fresh = guard._check(at_score(0.36, 12.0))
    assert await fresh is True
    assert guard.embedder.lengths[-1] == pytest.approx(voiceprint.MAX_CHECK_SECONDS)
    assert {name.split("_")[0] for name in guard.embedder.threads} == {"jarvis-voice-check"}
