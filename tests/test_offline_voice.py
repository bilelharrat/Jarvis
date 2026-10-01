"""JARVIS's offline voice at work (the Speaker's local path, Settings › Speaking,
features/offline_voice.py and the pane's Chinese). A fake ONNX session, fake lexicons and
a fake download (test_local_voice.py's): no model, no network, no audio."""

import asyncio
import re

import pytest
from conftest import FakeClient
from test_local_voice import FakeSession, fake_engine, fake_fetch, voice_files

from jarvis import local_voice, personas, speaking, speech
from jarvis.features import voice as voice_feature
from jarvis.hub import Hub
from jarvis.speech import CloudVoice

# ── the Speaker ──


@pytest.fixture
def engine(tmp_path):
    return fake_engine(tmp_path)


@pytest.fixture
def local_speaker(quiet_speaker, engine):
    ran = []

    async def run(args, spoken):
        ran.append((args, spoken))

    quiet_speaker._run, quiet_speaker._streams = run, asyncio.Semaphore(3)
    quiet_speaker.voice, quiet_speaker.fallback_voice = "Daniel", "Daniel (Enhanced)"
    quiet_speaker.local = local_voice.LocalVoice(engine)
    quiet_speaker.local_fallback, quiet_speaker._local_told = None, False
    quiet_speaker.ran = ran
    return quiet_speaker


async def drained(src):
    parts = []
    while (chunk := await src.chunks.get()) is not None:
        parts.append(chunk)
    return parts


async def test_the_offline_voice_streams_its_audio_at_its_own_rate(local_speaker):
    src = local_speaker.open("Hello, this is Jarvis. Yes.")
    parts = await drained(src)
    assert src.rate == speech.LOCAL_RATE and len(parts) == 2 and local_speaker.ran == []
    assert all(len(p) % 2 == 0 for p in parts)


async def test_chinese_is_said_by_the_mac_voice(local_speaker):
    await drained(local_speaker.open("你好，我是贾维斯。"))
    assert local_speaker.ran[0][1] == "你好，我是贾维斯。"


async def test_an_unknown_word_is_said_by_the_mac_voice_at_the_same_rate(local_speaker):
    src = local_speaker.open("Hello Bilel. Yes.")
    parts = await drained(src)
    assert [spoken for _args, spoken in local_speaker.ran] == ["Hello Bilel."]
    assert src.rate == speech.LOCAL_RATE and len(parts) == 2


async def test_a_broken_model_is_said_once_and_the_mac_voice_speaks(local_speaker, engine):
    engine.fake.fail = True
    await drained(local_speaker.open("Hello."))
    await drained(local_speaker.open("Yes."))
    (args, first), (_, second) = local_speaker.ran
    assert first == f"{speech.LOCAL_FAILED} Hello." and second == "Yes."
    assert args[args.index("-v") + 1] == "Daniel (Enhanced)"


async def test_a_failed_cloud_voice_falls_back_to_the_offline_voice(local_speaker):
    async def down(_text):
        raise RuntimeError("offline")
        yield b""

    local_speaker.cloud = CloudVoice("fish", "k", "v")
    local_speaker.cloud.stream = down
    local_speaker.local_fallback, local_speaker.local = local_speaker.local, None
    src = local_speaker.open("Hello.")
    parts = await drained(src)
    assert parts and src.rate == speech.LOCAL_RATE and local_speaker.ran == []
    assert local_speaker.cloud_error == "offline"


async def test_the_clip_path_bakes_in_the_ai_effect(local_speaker, monkeypatch):
    baked = []
    monkeypatch.setattr(speech, "ai_voice_effect", lambda a, r: baked.append(r) or a)
    local_speaker.effect = True
    audio, rate = await local_speaker.synthesize("Hello.")
    assert rate == speech.LOCAL_RATE and audio.size and baked == [speech.LOCAL_RATE]


# ── Settings › Speaking ──


@pytest.fixture
def real_speaker(quiet_speaker):
    quiet_speaker.rate, quiet_speaker.fallback_voice = 190, ""
    return quiet_speaker


def events(hub):
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    return sent


def put_files(store, tmp_path):
    contents, _ = voice_files(tmp_path / "src")
    store.folder.mkdir(parents=True, exist_ok=True)
    for name, data in contents.items():
        (store.folder / name).write_bytes(data)


@pytest.fixture
def hub_with_store(settings, real_speaker, isolated, tmp_path):
    hub = Hub(settings, client_factory=FakeClient, speaker=real_speaker, poll=False, **isolated)
    contents, files = voice_files(tmp_path / "src")
    store = local_voice.Store(tmp_path / "voice", files)
    store.fetch = fake_fetch(contents)
    store.session_factory = lambda _path: FakeSession()
    hub.offline_voice = store
    return hub, store


async def test_picking_it_before_the_download_keeps_the_mac_voice(hub_with_store):
    hub, _store = hub_with_store
    sent = events(hub)
    await hub._handle({"type": "voice_settings", "changes": {"voice_provider": "local"}})
    state = sent[-1][1]
    assert state["provider"] == "local" and hub.speaker.local is None
    local = state["local"]
    assert local["configured"] and not local["ready"] and local["size"] > 0
    assert [v["id"] for v in local["voices"]] == ["bm_george", "af_heart", "am_michael"]


async def test_downloading_it_puts_it_to_work(hub_with_store):
    hub, store = hub_with_store
    sent = events(hub)
    await hub._handle({"type": "voice_settings", "changes": {"voice_provider": "local"}})
    await hub._handle({"type": "voice_local_download"})
    for _ in range(100):
        if store.downloading is None and hub.speaker.local is not None:
            break
        await asyncio.sleep(0.01)
    assert hub.speaker.local is not None and hub.speaker.local.voice == "bm_george"
    assert sent[-1][1]["local"]["ready"] and sent[-1][1]["local"]["on"]
    await hub._handle({"type": "voice_settings", "changes": {"voice_local": "af_heart"}})
    assert hub.speaker.local.voice == "af_heart"
    await hub._handle({"type": "voice_settings", "changes": {"voice_local": "zz_nobody"}})
    assert hub.speaker.local.voice == "af_heart"
    await hub._handle({"type": "voice_local_remove"})
    assert hub.speaker.local is None and not store.ready()


async def test_without_checksums_the_download_is_refused_in_words(hub_with_store):
    hub, store = hub_with_store
    store.files = dict(store.files, **{"us_gold.json": {"url": "https://x.test/g", "sha256": ""}})
    sent = events(hub)
    await hub._handle({"type": "voice_local_download"})
    assert sent[-1][1]["local"]["error"] == "The offline voice isn’t set up in this build."
    assert not sent[-1][1]["local"]["configured"] and store.downloading is None


async def test_with_a_cloud_voice_it_is_the_fallback(hub_with_store, tmp_path):
    hub, store = hub_with_store
    put_files(store, tmp_path)
    hub.connectors.vault.set("voice:fish", "api_key", "fish-key-1234")
    await hub._handle({"type": "voice_settings", "changes": {"voice_provider": "fish"}})
    await hub._handle({"type": "voice_settings", "changes": {"voice_cloud": {"id": "abc"}}})
    assert hub.speaker.cloud is not None and hub.speaker.local is None
    assert hub.speaker.local_fallback is not None


async def test_the_jarvis_voice_falls_back_to_the_offline_voice(hub_with_store, tmp_path):
    """The chain: the JARVIS voice (own Fish key or askeden.com), then the offline voice for
    English, then the Mac voice."""
    hub, store = hub_with_store
    put_files(store, tmp_path)
    sent = events(hub)
    await hub._handle({"type": "voice_settings", "changes": {"voice_provider": "jarvis"}})
    assert hub.speaker.cloud is not None and hub.speaker.cloud.provider == "hosted"
    assert hub.speaker.local is None and hub.speaker.local_fallback is not None
    assert sent[-1][1]["local"]["fallback"]


async def test_a_persona_can_speak_with_an_offline_voice(hub_with_store, tmp_path, monkeypatch):
    hub, store = hub_with_store
    assert speaking.clean_persona_voice({"provider": "local", "id": "am_michael"}) == {
        "provider": "local",
        "id": "am_michael",
        "name": "Michael · American",
    }
    assert speaking.clean_persona_voice({"provider": "local", "id": "../x"}) is None
    put_files(store, tmp_path)
    persona = personas.Persona(id="friday", name="Friday", description="")
    persona.extra["voice"] = {"provider": "local", "id": "am_michael", "name": "Michael"}
    monkeypatch.setitem(personas.KNOWN, "friday", persona)
    hub.prefs.persona = "friday"
    await voice_feature.feature_for(hub).speaking.apply()
    assert hub.speaker.local.voice == "am_michael"


async def test_its_preview_plays_the_offline_voice(hub_with_store, tmp_path, monkeypatch):
    hub, store = hub_with_store
    sent = events(hub)
    hub.speaker.muted = False
    played = []

    async def play(audio, rate):
        played.append((audio.size, rate))

    monkeypatch.setattr(hub.speaker, "play", play)
    await hub._handle({"type": "voice_preview", "provider": "local", "voice": ""})
    assert "Download" in sent[-1][1]["speaking_error"] and not played
    put_files(store, tmp_path)
    monkeypatch.setattr(speaking, "PREVIEW", "Hello, this is Jarvis.")
    await hub._handle({"type": "voice_preview", "provider": "local", "voice": "af_heart"})
    assert played and played[0][1] == local_voice.LOCAL_RATE


# ── Chinese for what the pane shows ──


def _offline_strings():
    from test_voice_i18n import WEB, _js_literals, _messages

    from jarvis.features import offline_voice

    source = (WEB / "features" / "voice_offline.js").read_text(encoding="utf-8")
    shown = {s for s in _js_literals(source) if re.match(r"[A-Z“]", s) and "_" not in s}
    names = {name for name, _british in local_voice.VOICES.values()}
    sent = _messages(local_voice) | _messages(offline_voice) | _messages(speaking)
    built = {
        "The voice is 111 MB and stays on this Mac. It downloads once.",
        "Downloading… 42%",
        "The offline voice didn’t download: the voice model download didn't match its checksum",
        "If ElevenLabs fails, JARVIS (on this Mac) speaks instead.",
        "Speaking as JARVIS. If it can’t be reached, JARVIS (on this Mac) speaks.",
        "The JARVIS voice wasn't available last time (its daily allowance may be used up);"
        " JARVIS (on this Mac) spoke instead.",
        speaking.LOCAL_NAME,
    }
    return sorted((shown | names | sent | built) - {speaking.PREVIEW})


@pytest.fixture(scope="module")
def zh():
    from jarvis.server import zh_strings

    merged = zh_strings()
    patterns = [re.compile(p) for p, _r in merged["patterns"]]
    return lambda key: key in merged["strings"] or any(p.search(key) for p in patterns)


@pytest.mark.parametrize("text", _offline_strings())
def test_each_offline_voice_string_has_chinese(zh, text):
    assert zh(" ".join(text.split())), f"no Chinese for {text!r}"
