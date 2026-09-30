"""Settings › Speaking (speaking.py, voices.py, features/voice.py): the provider, voice,
key, model and speed the owner picks, over .env's defaults (never written); keys in the
Keychain (a MemoryVault here); mute kept across restarts; and a failed cloud voice falling
back to the best Enhanced or Premium Mac voice. No network, `say` or audio: all faked."""

import asyncio
import json
from dataclasses import replace

import numpy as np
import pytest
from conftest import FakeClient

from jarvis import speaking, voices
from jarvis.features import voice as voice_feature
from jarvis.hub import Hub
from jarvis.speech import CloudVoice, Speaker

SAY_LIST = """\
Albert              en_US    # Hello! My name is Albert.
Daniel (English (UK)) en_GB    # Hello! My name is Daniel.
Daniel (English (UK)) en_GB    # Hello! My name is Daniel.
Daniel (Enhanced)   en_GB    # Hello! My name is Daniel.
Ava (Premium)       en_US    # Hello! My name is Ava.
Zoe (Enhanced)      en_US    # Hello! My name is Zoe.
Bubbles             en_US    # Hello! My name is Bubbles.
Samantha            en_US    # Hello! My name is Samantha.
Tingting            zh_CN    # 你好！我叫婷婷。
Lilian (Premium)    zh_CN    # 你好！我叫莉莲。
Meijia              zh_TW    # 你好，我叫美佳。
Amélie              fr_CA    # Bonjour! Je m’appelle Amélie.
"""


# ── the Mac's voices ──


def test_say_voices_are_read_once_each_without_the_novelty_ones():
    found = voices.parse_say_voices(SAY_LIST)
    names = [v.name for v in found]
    assert names.count("Daniel (English (UK))") == 1
    assert "Albert" not in names and "Bubbles" not in names
    ava = voices.find(found, "Ava (Premium)")
    assert (ava.family, ava.locale, ava.quality) == ("Ava", "en_US", "premium")
    assert voices.find(found, "Daniel").name == "Daniel (English (UK))"


def test_voices_for_a_language_best_first():
    found = voices.parse_say_voices(SAY_LIST)
    english = [v.name for v in voices.for_language(found, "en")]
    assert english[0] == "Ava (Premium)" and "Tingting" not in english and "Amélie" not in english
    chinese = [v.name for v in voices.for_language(found, "zh")]
    assert chinese == ["Lilian (Premium)", "Tingting", "Meijia"]  # mainland before Taiwan


def test_the_fallback_is_the_best_voice_of_the_same_family_then_accent():
    found = voices.parse_say_voices(SAY_LIST)
    # Daniel's own Enhanced voice beats a Premium one with another accent
    assert voices.best_fallback(found, "en", "Daniel") == "Daniel (Enhanced)"
    assert voices.best_fallback(found, "en", "Samantha") == "Ava (Premium)"  # en_US, Premium
    assert voices.best_fallback(found, "zh", "Tingting") == "Lilian (Premium)"
    plain = voices.parse_say_voices("Daniel              en_GB    # Hello!\n")
    assert voices.best_fallback(plain, "en", "Daniel") == "Daniel"  # nothing better installed


async def test_a_failed_cloud_voice_speaks_in_the_fallback_voice(quiet_speaker):
    ran = []

    async def run(args, _spoken):
        ran.append(args)

    quiet_speaker.cloud = CloudVoice("fish", "k", "voice")
    quiet_speaker.voice, quiet_speaker.fallback_voice = "Daniel", "Daniel (Enhanced)"
    quiet_speaker._run, quiet_speaker._streams = run, asyncio.Semaphore(3)

    async def down(_text):
        raise RuntimeError("no credit")
        yield b""  # an async generator

    quiet_speaker.cloud.stream = down
    src = quiet_speaker.open("Hello there.")
    await src.task
    assert ran[0][ran[0].index("-v") + 1] == "Daniel (Enhanced)"
    quiet_speaker.cloud = None  # the Mac voice picked: its own voice, not the fallback
    await quiet_speaker.open("Hello there.").task
    assert ran[1][ran[1].index("-v") + 1] == "Daniel"


def test_a_cloud_voice_sends_a_speed_only_when_one_is_set():
    assert CloudVoice("elevenlabs", "k", "v")._options() == {}
    assert CloudVoice("elevenlabs", "k", "v", speed=1.3)._options() == {
        "voice_settings": {"speed": 1.2}  # ElevenLabs' own limit
    }
    assert CloudVoice("fish", "k", "v", speed=0.8)._options() == {"prosody": {"speed": 0.8}}


# ── on the hub ──


def make_hub(settings, speaker, isolated, **extra):
    return Hub(
        settings, client_factory=FakeClient, speaker=speaker, poll=False, **isolated, **extra
    )


def events(hub):
    sent = []
    hub.emit = lambda kind, **data: sent.append((kind, data))
    return sent


@pytest.fixture
def mac(monkeypatch):
    """The Mac's voices as SAY_LIST, without running `say`."""
    monkeypatch.setattr(voices, "list_mac_voices", lambda: voices.parse_say_voices(SAY_LIST))


@pytest.fixture
def real_speaker(quiet_speaker):
    """A Speaker (the kind the feature drives), silent and with no player."""
    quiet_speaker.rate, quiet_speaker.fallback_voice = 190, ""
    return quiet_speaker


def vault(hub):
    return hub.connectors.vault


async def test_by_default_env_decides_and_nothing_is_written(settings, real_speaker, isolated, mac):
    env = replace(settings, tts="elevenlabs", tts_api_key="env-key-0000", tts_voice_id="Rachel1")
    real_speaker.cloud = CloudVoice("elevenlabs", "env-key-0000", "Rachel1", "")
    hub = make_hub(env, real_speaker, isolated)
    sent = events(hub)
    await hub._handle({"type": "voice_status"})
    state = sent[-1][1]
    assert state["provider"] == "elevenlabs" and not state["provider_set"]
    eleven = state["clouds"]["elevenlabs"]
    assert eleven["voice"] == {"id": "Rachel1", "name": "Rachel1"} and eleven["voice_from_env"]
    assert eleven["env_key"] and eleven["key"] == ""
    assert "env-key-0000" not in json.dumps(state)  # a key never reaches the window
    before = real_speaker.cloud
    await voice_feature.feature_for(hub).speaking.apply()
    assert real_speaker.cloud is before  # nothing changed: the warm connection stays


async def test_a_pasted_key_goes_to_the_keychain_and_the_voice_follows(
    settings, real_speaker, isolated, mac
):
    hub = make_hub(settings, real_speaker, isolated)
    sent = events(hub)
    await hub._handle({"type": "voice_settings", "changes": {"voice_provider": "fish"}})
    assert real_speaker.cloud is None  # no key or voice yet: the Mac voice speaks
    assert "needs" not in json.dumps(sent[-1][1]["speaking_error"])
    await hub._handle({"type": "voice_key", "provider": "fish", "key": "  fish-secret-key-1234 "})
    assert vault(hub).get("voice:fish", "api_key") == "fish-secret-key-1234"
    assert sent[-1][1]["clouds"]["fish"]["key"] == "…1234"
    assert "fish-secret-key-1234" not in isolated["prefs_store"].path.read_text()
    await hub._handle(
        {"type": "voice_settings", "changes": {"voice_cloud": {"id": "abc123", "name": "Ann"}}}
    )
    cloud = real_speaker.cloud
    assert (cloud.provider, cloud.api_key, cloud.voice_id) == (
        "fish",
        "fish-secret-key-1234",
        "abc123",
    )
    await hub._handle(
        {"type": "voice_settings", "changes": {"voice_speed": 120, "voice_model": "s1"}}
    )
    assert real_speaker.cloud.speed == 1.2 and real_speaker.cloud.model == "s1"
    assert real_speaker.rate == 228  # the Mac voice (and the fallback) keep pace
    await hub._handle({"type": "voice_key_forget", "provider": "fish"})
    assert vault(hub).get("voice:fish", "api_key") is None and real_speaker.cloud is None
    assert sent[-1][1]["clouds"]["fish"]["key"] == ""


async def test_bad_input_is_refused_in_words(settings, real_speaker, isolated, mac):
    hub = make_hub(settings, real_speaker, isolated)
    sent = events(hub)
    await hub._handle({"type": "voice_settings", "changes": {"voice_provider": "fish"}})
    await hub._handle({"type": "voice_key", "provider": "fish", "key": "has spaces in it"})
    assert "unusual characters" in sent[-1][1]["speaking_error"]
    assert vault(hub).get("voice:fish", "api_key") is None
    await hub._handle({"type": "voice_settings", "changes": {"voice_cloud": {"id": "../etc"}}})
    assert "voice id" in sent[-1][1]["speaking_error"]
    await hub._handle({"type": "voice_status"})
    assert sent[-1][1]["speaking_error"] == ""  # said once
    await hub._handle({"type": "voice_settings", "changes": {"voice_provider": "bark"}})
    assert hub.prefs.feature("voice_provider") == "fish"


async def test_a_mac_voice_per_language_and_the_fallback(settings, real_speaker, isolated, mac):
    hub = make_hub(settings, real_speaker, isolated)
    feature = voice_feature.feature_for(hub)
    await feature.speaking.setup()
    assert real_speaker.voice == "Daniel" and real_speaker.fallback_voice == "Daniel (Enhanced)"
    await hub._handle({"type": "voice_settings", "changes": {"voice_mac": "Ava (Premium)"}})
    assert real_speaker.voice == "Ava (Premium)"
    hub.prefs.language = "zh"
    hub._speak_language()  # what a language switch does
    assert real_speaker.voice == "Tingting"  # English's pick isn't a Mandarin voice
    assert real_speaker.fallback_voice == "Lilian (Premium)"  # nor is its fallback
    await hub._handle({"type": "voice_settings", "changes": {"voice_mac": "Lilian (Premium)"}})
    hub.prefs.language = "en"
    hub._speak_language()
    assert real_speaker.voice == "Ava (Premium)"
    assert hub.prefs.feature("voice_mac") == {"en": "Ava (Premium)", "zh": "Lilian (Premium)"}


async def test_an_uninstalled_voice_is_not_used(settings, real_speaker, isolated, monkeypatch):
    isolated["prefs_store"].prefs.features["voice_mac"] = {"en": "Zoe (Enhanced)"}
    monkeypatch.setattr(voices, "list_mac_voices", lambda: voices.parse_say_voices(SAY_LIST[:200]))
    hub = make_hub(settings, real_speaker, isolated)
    assert real_speaker.voice == "Zoe (Enhanced)"  # not listed yet: trusted
    await voice_feature.feature_for(hub).speaking.setup()
    assert real_speaker.voice == "Daniel"  # listed, and gone: the default speaks


async def test_listing_voices_uses_the_key_and_only_on_request(
    settings, real_speaker, isolated, mac, monkeypatch
):
    import httpx

    calls = []

    class Client:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None, params=None, timeout=None):
            calls.append((url, headers))
            body = {"voices": [{"voice_id": "Rachel1", "name": "Rachel", "category": "premade"}]}
            return httpx.Response(200, json=body, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    hub = make_hub(settings, real_speaker, isolated)
    sent = events(hub)
    await hub._handle({"type": "voice_settings", "changes": {"voice_provider": "elevenlabs"}})
    assert calls == []  # nothing is listed until asked
    await hub._handle({"type": "voice_list", "provider": "elevenlabs"})
    assert "Paste your ElevenLabs API key first" in sent[-1][1]["speaking_error"]
    vault(hub).set("voice:elevenlabs", "api_key", "el-key-5678")
    await hub._handle({"type": "voice_list", "provider": "elevenlabs"})
    assert calls == [("https://api.elevenlabs.io/v1/voices", {"xi-api-key": "el-key-5678"})]
    assert sent[-1][1]["clouds"]["elevenlabs"]["voices"] == [
        {"id": "Rachel1", "name": "Rachel", "about": "premade"}
    ]
    assert [kind for kind, data in sent if data.get("busy") == "list"]  # "Listing…" meanwhile


async def test_a_rejected_key_or_odd_answer_is_said(settings, real_speaker, isolated, monkeypatch):
    import httpx

    answers = [httpx.Response(401), httpx.Response(200, json={"items": "nope"})]

    class Client:
        async def get(self, url, **_kw):
            answer = answers.pop(0)
            answer.request = httpx.Request("GET", url)
            return answer

    for why in ("didn't accept that key", "wasn't a voice list"):
        with pytest.raises(ValueError, match=why):
            await voices.list_cloud_voices(Client(), "fish", "k")


async def test_preview_plays_the_voice_picked_or_says_why_not(
    settings, real_speaker, isolated, mac, monkeypatch
):
    played, said = [], []

    async def fake_mac_audio(text, voice, rate):
        said.append((text, voice, rate))
        return np.zeros(10, np.float32), 22050

    async def play(audio, rate):
        played.append(rate)

    monkeypatch.setattr(speaking, "mac_audio", fake_mac_audio)
    real_speaker.play = play
    hub = make_hub(settings, real_speaker, isolated)
    sent = events(hub)
    await hub._handle({"type": "voice_preview", "provider": "say", "voice": "Ava (Premium)"})
    assert "turn them on" in sent[-1][1]["speaking_error"] and played == []  # muted
    real_speaker.muted = False
    await hub._handle({"type": "voice_preview", "provider": "say", "voice": "Ava (Premium)"})
    assert said == [("Hello. This is how I'll sound when I answer you.", "Ava (Premium)", 190)]
    assert played == [22050]
    await hub._handle({"type": "voice_preview", "provider": "say", "voice": "Nobody"})
    assert "isn't installed" in sent[-1][1]["speaking_error"]
    hub.prefs.language = "zh"
    await hub._handle({"type": "voice_preview", "provider": "say", "voice": "Tingting"})
    assert said[-1][0] == "你好。我回答你的时候，就是这个声音。"
    await hub._handle({"type": "voice_preview", "provider": "fish", "voice": "abc"})
    assert "needs an API key" in sent[-1][1]["speaking_error"]


async def test_mute_is_remembered_across_restarts(settings, isolated):
    class Quiet:
        muted, effect, cloud, cloud_error, player_path = False, False, None, "", None

        def stop(self):
            pass

    hub = make_hub(settings, Quiet(), isolated)
    await hub._handle({"type": "mute", "value": True})
    assert hub.prefs.feature("voice_muted") is True
    from jarvis.prefs import PrefsStore

    again = dict(isolated, prefs_store=PrefsStore(isolated["prefs_store"].path))
    later = make_hub(settings, Quiet(), again)
    assert later.speaker.muted is True and later.snapshot()["muted"] is True
    await later._handle({"type": "mute", "value": False})
    assert PrefsStore(isolated["prefs_store"].path).prefs.feature("voice_muted") is False


async def test_the_app_sets_up_its_voice_at_start(settings, isolated, mac, monkeypatch):
    """With poll on (the app), the voice_setup loop lists the Mac's voices and applies the
    choice, fillers re-voiced; tests never run it (poll is off)."""
    speaker = Speaker.__new__(Speaker)
    speaker.voice, speaker.rate, speaker.muted, speaker._procs = "Daniel", 190, True, set()
    speaker.effect, speaker.cloud, speaker.cloud_error, speaker._playing = False, None, "", False
    speaker._player, speaker.player_path, speaker._live, speaker._live_lock = None, None, None, None
    speaker.fallback_voice = ""
    hub = make_hub(settings, speaker, isolated)
    assert ("voice_setup", voice_feature.feature_for(hub).speaking.setup) in hub._loops
    prepared = []

    async def prepare():
        prepared.append(1)

    hub._prepare_fillers = prepare
    hub.poll = True
    isolated["prefs_store"].prefs.features["voice_mac"] = {"en": "Ava (Premium)"}
    await voice_feature.feature_for(hub).speaking.setup()
    await asyncio.sleep(0)
    assert speaker.voice == "Ava (Premium)" and speaker.fallback_voice == "Ava (Premium)"
    assert prepared == [1]


async def test_listing_the_macs_voices_ends_busy(settings, real_speaker, isolated, mac):
    hub = make_hub(settings, real_speaker, isolated)
    sent = events(hub)
    await hub._handle({"type": "voice_list", "provider": "say"})
    assert sent[0][1]["busy"] == "list" and sent[-1][1]["busy"] == ""
    assert [v["name"] for v in sent[-1][1]["mac_voices"]][:2] == [
        "Ava (Premium)",
        "Daniel (Enhanced)",
    ]


# ── a persona of the owner's with its own voice ──


def test_a_personas_voice_is_one_speaking_offers():
    clean = speaking.clean_persona_voice
    assert clean({"provider": "say", "name": " Daniel (Enhanced) "}) == {
        "provider": "say",
        "name": "Daniel (Enhanced)",
    }
    assert clean({"provider": "fish", "id": "abc123", "name": "Ann"}) == {
        "provider": "fish",
        "id": "abc123",
        "name": "Ann",
    }
    assert clean({}) == {} and clean("") == {}  # the usual voice (undoes an earlier pick)
    assert clean({"provider": "fish", "id": "../x"}) is None
    assert clean({"provider": "say", "name": "a\nb"}) is None
    assert clean({"provider": "openai", "id": "x"}) is None
    assert clean("Daniel") is None
    assert speaking.personas.FIELDS["voice"] is clean


@pytest.fixture
def alfred(monkeypatch):
    from jarvis import personas

    def give(voice):
        persona = personas.Persona(id="alfred", name="Alfred", description="A butler.")
        persona.extra["voice"] = voice
        monkeypatch.setitem(personas.KNOWN, "alfred", persona)
        return persona

    return give


async def test_the_persona_in_use_speaks_with_its_own_voice(
    settings, real_speaker, isolated, mac, alfred, monkeypatch
):
    from jarvis import prefs

    monkeypatch.setitem(prefs.PERSONAS, "alfred", ("Alfred", "A butler."))
    hub = make_hub(settings, real_speaker, isolated)
    feature = voice_feature.feature_for(hub)
    await feature.speaking.setup()
    usual = real_speaker.voice
    persona = alfred({"provider": "say", "name": "Daniel (Enhanced)"})
    hub.set_prefs({"persona": "alfred"})
    await asyncio.sleep(0.01)  # (the switch re-voices in the background)
    assert real_speaker.voice == "Daniel (Enhanced)"
    # Chinese: an English voice never reads it; the usual Chinese voice does.
    hub.set_prefs({"language": "zh"})
    await feature.speaking.apply()
    assert real_speaker.voice != "Daniel (Enhanced)"
    hub.set_prefs({"language": "en"})
    # A cloud voice needs its service's key; without one the usual voice speaks.
    persona.extra["voice"] = {"provider": "fish", "id": "abc123", "name": "Ann"}
    await feature.speaking.apply()
    assert real_speaker.cloud is None and real_speaker.voice == usual
    vault(hub).set("voice:fish", "api_key", "fish-test-key-1234")
    await feature.speaking.apply()
    assert (real_speaker.cloud.provider, real_speaker.cloud.voice_id) == ("fish", "abc123")
    hub.set_prefs({"persona": "jarvis"})  # back to JARVIS: the usual voice
    await asyncio.sleep(0.01)
    assert real_speaker.cloud is None and real_speaker.voice == usual
