"""Settings › Speaking: which voice Jarvis speaks with, chosen in the window.

- Provider: JARVIS (the built-in JARVIS voice), the Mac's own voice, ElevenLabs or Fish
  Audio. Until the owner picks one here, the .env settings (JARVIS_TTS and friends) decide,
  as before; with none, the JARVIS voice speaks. It's a public Fish Audio voice: with the
  owner's own Fish key (saved here, or .env's) it's spoken with that key, unlimited;
  without one, through askeden.com (speech.HOSTED_VOICE_URL), within a daily allowance.
- Voice: a Mac voice for each language (Enhanced and Premium ones included), or a cloud
  voice, listed from the owner's account with their key when they ask, or pasted by id.
- API keys: pasted in the pane, kept in the Keychain (connectors.Vault, entry
  "voice:<provider>" / "api_key"; a MemoryVault in tests), never in a file or .env. The
  window only ever sees the last four characters. A key from .env still works.
- Model, speed, and a preview of the voice picked.
- When the cloud voice fails, the best Enhanced or Premium Mac voice installed for the
  language speaks instead of the plain default (voices.best_fallback); or JARVIS's own
  offline voice, once it's downloaded.
- "JARVIS (on this Mac)": the offline neural voice (local_voice.py), English only,
  downloaded when the owner presses Download here.

Cost policy: no Claude model is called. Listing voices is one free request to the provider's
voice list, and a preview one short sentence of speech (a few dozen characters of the
owner's TTS quota), both only when the owner presses the button.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from . import lang, local_voice, personas, voices
from .providers import clean_key, mask
from .speech import EFFECT_RATE, JARVIS_VOICE_ID, CloudVoice, Speaker, read_wav

log = logging.getLogger("jarvis")

PROVIDERS = ("jarvis", "say", "elevenlabs", "fish", "local")
CLOUD = ("elevenlabs", "fish")
LOCAL_NAME = "JARVIS (on this Mac)"
PROVIDER_NAMES = {
    "jarvis": "JARVIS",
    "say": "Mac",
    "elevenlabs": "ElevenLabs",
    "fish": "Fish Audio",
    "local": LOCAL_NAME,
}
JARVIS_MODEL = "s2.1-pro"  # the model the JARVIS voice speaks with on the owner's own key
# Models offered for each (any other id can be typed).
MODELS = {
    "elevenlabs": ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2", "eleven_v3"],
    "fish": ["s2.1-pro", "s1", "speech-1.6", "speech-1.5"],
}
VAULT_PREFIX = "voice:"
KEY_NAME = "api_key"
SPEED_MIN, SPEED_MAX, SPEED_DEFAULT = 50, 250, 100  # percent: people who listen all day (a screen reader's users) go fast
CLOUD_SPEED = (0.7, 1.3)  # what the cloud and offline voices take; the system voice (say, Windows SAPI) takes the whole range
PREVIEW = "Hello. This is how I'll sound when I answer you."
lang.ZH_TEXTS.setdefault(PREVIEW, "你好。我回答你的时候，就是这个声音。")

_VOICE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
_MODEL = re.compile(r"[A-Za-z0-9._-]{1,64}")
_MAC_NAME = re.compile(r"[^\x00-\x1f]{1,80}")


# ── what prefs.features keeps (each read back defensively) ──


def clean_provider(value: Any) -> str | None:
    return value if value == "" or value in PROVIDERS else None


def clean_mac(value: Any) -> dict[str, str] | None:
    """{"en": "Daniel (Enhanced)", "zh": "Tingting"}: a Mac voice for each language."""
    if not isinstance(value, dict):
        return None
    return {
        k: v.strip()
        for k, v in value.items()
        if k in lang.LANGUAGES and isinstance(v, str) and _MAC_NAME.fullmatch(v.strip())
    }


def _clean_voice(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict) or not isinstance(value.get("id"), str):
        return None
    voice_id = value["id"].strip()
    if not _VOICE_ID.fullmatch(voice_id):
        return None
    name = re.sub(r"\s+", " ", str(value.get("name") or "")).strip()[:80]
    return {"id": voice_id, "name": name or voice_id}


def clean_cloud(value: Any) -> dict[str, dict[str, str]] | None:
    """{"elevenlabs": {"id", "name"}, "fish": {…}}: the voice picked on each service."""
    if not isinstance(value, dict):
        return None
    kept = {p: _clean_voice(value.get(p)) for p in CLOUD}
    return {p: v for p, v in kept.items() if v is not None}


def clean_models(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    return {
        p: value[p].strip()
        for p in CLOUD
        if isinstance(value.get(p), str) and _MODEL.fullmatch(value[p].strip())
    }


def clean_speed(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or value != value:
        return None
    return int(round(min(SPEED_MAX, max(SPEED_MIN, value))))


def clean_hints(value: Any) -> dict[str, str] | None:
    """How each saved key shows: "…abcd" (the Keychain has the key itself)."""
    if not isinstance(value, dict):
        return None
    return {
        p: value[p][:12]
        for p in CLOUD
        if isinstance(value.get(p), str) and re.fullmatch(r"(?:sk-)?(?:…\S{4}|••••)", value[p])
    }


def clean_local(value: Any) -> str | None:
    """The offline voice picked ("bm_george")."""
    return value if isinstance(value, str) and value in local_voice.VOICES else None


def clean_muted(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def clean_persona_voice(value: Any) -> dict[str, str] | None:
    """A custom persona's own voice (personas.register_field "voice"): {"provider": "say",
    "name": a Mac voice} or {"provider": "elevenlabs" | "fish", "id", "name"}; {} for the
    usual voice (kept, so choosing it undoes an earlier pick); or {"provider": "local",
    "id", "name"}: one of the offline voices."""
    if value in ("", None) or value == {}:
        return {}
    if not isinstance(value, dict):
        return None
    provider = value.get("provider")
    if provider == "say":
        name = value.get("name")
        if isinstance(name, str) and _MAC_NAME.fullmatch(name.strip()):
            return {"provider": "say", "name": name.strip()}
        return None
    if provider in CLOUD:
        voice = _clean_voice(value)
        return {"provider": provider, **voice} if voice is not None else None
    if provider == "local" and clean_local(value.get("id")):
        return {"provider": "local", "id": value["id"], "name": local_voice.VOICES[value["id"]][0]}
    return None


personas.register_field("voice", clean_persona_voice)


PREFS = {
    "voice_provider": ("", clean_provider),
    "voice_mac": ({}, clean_mac),
    "voice_cloud": ({}, clean_cloud),
    "voice_models": ({}, clean_models),
    "voice_speed": (SPEED_DEFAULT, clean_speed),
    "voice_muted": (False, clean_muted),
    "voice_local": (local_voice.DEFAULT_VOICE, clean_local),
    "voice_key_hints": ({}, clean_hints),
}


async def mac_audio(text: str, voice: str, rate: int) -> tuple[Any, int]:
    """A sentence in a Mac voice, as audio (`say -o`; nothing plays)."""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "preview.wav"
        args = [
            "say",
            "-r",
            str(rate),
            "-v",
            voice,
            f"--data-format=LEI16@{EFFECT_RATE}",
            "-o",
            str(path),
        ]
        proc = await asyncio.create_subprocess_exec(*args, stdin=asyncio.subprocess.PIPE)
        await proc.communicate(text.encode())
        if proc.returncode or not path.exists():
            raise ValueError(f"The Mac couldn't speak with {voice}.")
        return read_wav(path)


def _same(a: Any, b: Any) -> bool:
    """Two cloud voices that would say things the same way."""
    if not isinstance(a, CloudVoice) or not isinstance(b, CloudVoice):
        return False
    fields = ("provider", "api_key", "voice_id")
    return (
        all(getattr(a, f) == getattr(b, f) for f in fields)
        and (a.model or "") == (b.model or "")
        and abs(a.speed - b.speed) < 0.005
    )


class Speaking:
    def __init__(self, hub: Any) -> None:
        self.hub = hub
        self.mac_voices: list[voices.MacVoice] | None = None  # `say -v ?`, once listed
        self.cloud_voices: dict[str, list[dict[str, str]]] = {}  # listed when asked
        self.error = ""  # the pane's last problem, shown once
        self.busy = ""  # "list" or "preview" while one runs (the feature sets and clears it)
        # A speed for now only, never saved: long reading's own (features/accessibility_reading.py),
        # held until the reply that reads is over. None: the speed in Settings.
        self.held: int | None = None

    # ── the settings as they are now ──

    def _pref(self, key: str) -> Any:
        return self.hub.prefs.feature(key)

    @property
    def language(self) -> str:
        return getattr(self.hub.prefs, "language", "en")

    def provider(self) -> str:
        """The provider speaking: the pane's pick, else .env's, else the JARVIS voice."""
        chosen = self._pref("voice_provider")
        settings = self.hub.settings
        if chosen:
            return chosen
        if getattr(settings, "tts_set", False) and settings.tts in PROVIDERS:
            return settings.tts
        return "jarvis"

    def install_id(self) -> str:
        """This install's own id, for askeden.com's daily allowance (made once; not a
        secret, and nothing about the owner is in it)."""
        import secrets

        path = self.hub.prefs_store.path.with_name("install_id")
        try:
            found = path.read_text().strip()
            if re.fullmatch(r"[0-9a-f]{32}", found):
                return found
        except OSError:
            pass
        made = secrets.token_hex(16)
        with contextlib.suppress(OSError):
            path.write_text(made)
        return made

    async def jarvis_voice(self, speed: float) -> CloudVoice:
        """The JARVIS voice: on the owner's own Fish key when there is one, else hosted."""
        key = await self._key("fish")
        if key:
            return CloudVoice("fish", key, JARVIS_VOICE_ID, JARVIS_MODEL, speed)
        return CloudVoice(
            "hosted", self.install_id(), JARVIS_VOICE_ID, "", speed, bearer=self._account_token
        )

    def _account_token(self) -> str:
        """The Jarvis account's token while the Mac is linked (features.account), else ""."""
        account = getattr(self.hub, "account", None)
        return account.token if account is not None and account.linked else ""

    def _env(self, provider: str) -> dict[str, str]:
        """.env's voice and model for a provider (only the one .env picked)."""
        s = self.hub.settings
        if getattr(s, "tts", "say") != provider:
            return {"voice": "", "model": "", "key": ""}
        return {
            "voice": s.tts_voice_id or "",
            "model": s.tts_model or "",
            "key": s.tts_api_key or "",
        }

    def cloud_voice(self, provider: str) -> dict[str, str]:
        picked = (self._pref("voice_cloud") or {}).get(provider)
        if picked:
            return picked
        env = self._env(provider)["voice"]
        return {"id": env, "name": env} if env else {"id": "", "name": ""}

    def model(self, provider: str) -> str:
        return (self._pref("voice_models") or {}).get(provider) or self._env(provider)["model"]

    def speed(self) -> int:
        return clean_speed(self._pref("voice_speed")) or SPEED_DEFAULT

    def speaking_speed(self) -> int:
        """The speed the voice uses now: one held for long reading, else the one in Settings."""
        return clean_speed(self.held) or self.speed()

    def mac_voice_for(self, language: str) -> str:
        """The Mac voice picked for a language ("" for the default), while it's installed.
        The hub asks as it sets the voice for a language (at start and when the language
        changes), so the fallback voice moves to that language's best one here too."""
        name = self.persona_mac(language)  # the persona in use speaks with its own
        name = name or (self._pref("voice_mac") or {}).get(
            "zh" if lang.is_zh(language) else "en", ""
        )
        if name and self.mac_voices is not None and voices.find(self.mac_voices, name) is None:
            name = ""  # uninstalled since: the default speaks
        speaker = self.hub.speaker
        if self.mac_voices and isinstance(speaker, Speaker):
            speaking = name or lang.mac_voice(language, self.hub.settings.voice)
            speaker.fallback_voice = voices.best_fallback(self.mac_voices, language, speaking)
        return name

    # ── the persona in use, when it has a voice of its own ──

    def persona_voice(self) -> dict[str, str] | None:
        """The voice the owner gave the persona in use (one of their own), None for the
        usual voice."""
        persona = personas.KNOWN.get(getattr(self.hub.prefs, "persona", ""))
        own = persona.extra.get("voice") if persona is not None else None
        return own if isinstance(own, dict) and own.get("provider") in PROVIDERS else None

    def persona_mac(self, language: str) -> str:
        """The persona's Mac voice, while it's installed and speaks this language ("" when
        not: the usual voice speaks, never an English voice reading Chinese)."""
        own = self.persona_voice()
        if not own or own["provider"] != "say" or not self.mac_voices:
            return ""
        found = voices.find(voices.for_language(self.mac_voices, language), own["name"])
        return found.name if found is not None else ""

    # ── the Keychain ──

    def _vault(self) -> Any:
        return self.hub.connectors.vault

    async def _key(self, provider: str) -> str:
        """The provider's key: the one pasted here (Keychain), else .env's."""
        try:
            saved = await asyncio.to_thread(self._vault().get, VAULT_PREFIX + provider, KEY_NAME)
        except Exception:  # a locked or unavailable Keychain
            saved = None
            self.error = "I couldn't read the voice key from the Keychain. Unlock it and try again."
        return saved or self._env(provider)["key"]

    async def set_key(self, provider: str, key: Any) -> None:
        if provider not in CLOUD:
            return
        try:
            key = clean_key(key)
        except ValueError as exc:
            self.error = str(exc)
            return
        try:
            await asyncio.to_thread(self._vault().set, VAULT_PREFIX + provider, KEY_NAME, key)
        except Exception:
            self.error = "I couldn't save the key in the Keychain, so nothing changed."
            return
        hints = dict(self._pref("voice_key_hints") or {})
        hints[provider] = mask(key)
        self.hub.set_feature_prefs({"voice_key_hints": hints})
        self.cloud_voices.pop(provider, None)  # another account's voices
        await self.apply()

    async def forget_key(self, provider: str) -> None:
        if provider not in CLOUD:
            return
        try:
            await asyncio.to_thread(self._vault().delete, VAULT_PREFIX + provider, KEY_NAME)
        except Exception:
            self.error = "I couldn't take the key out of the Keychain. Try again."
            return
        hints = {p: h for p, h in (self._pref("voice_key_hints") or {}).items() if p != provider}
        self.hub.set_feature_prefs({"voice_key_hints": hints})
        self.cloud_voices.pop(provider, None)
        await self.apply()

    # ── putting it to work ──

    async def apply(self, refresh: bool = True) -> bool:
        """Set the speaker to the settings: its cloud voice (kept, connection and all,
        when nothing about it changed), Mac voice, rate and fallback voice. True when the
        voice changed. A test's stand-in speaker is left alone."""
        speaker = self.hub.speaker
        if not isinstance(speaker, Speaker):
            return False
        provider, full = self.provider(), self.speaking_speed() / 100
        speaker.rate = max(80, min(500, round(self.hub.settings.speech_rate * full)))
        speed = min(CLOUD_SPEED[1], max(CLOUD_SPEED[0], full))
        cloud = None
        own = self.persona_voice()
        if own is not None and own["provider"] in CLOUD:  # the persona's cloud voice
            key = await self._key(own["provider"])
            if key:
                cloud = CloudVoice(
                    own["provider"], key, own["id"], self.model(own["provider"]), speed
                )
                provider = ""  # (without a key: the usual voice)
        elif own is not None and self.persona_mac(self.language):
            provider = ""  # the persona's Mac voice: no cloud voice over it
        store = local_voice.store_for(self.hub)
        own_local = own is not None and own["provider"] == "local" and store.ready()
        if own_local:
            provider = ""  # the persona's offline voice: no cloud voice over it
        if provider in CLOUD:
            key, voice = await self._key(provider), self.cloud_voice(provider)["id"]
            if key and voice:
                cloud = CloudVoice(provider, key, voice, self.model(provider), speed)
        elif provider == "jarvis":
            cloud = await self.jarvis_voice(speed)
        if cloud is not None and _same(speaker.cloud, cloud):
            cloud = speaker.cloud  # nothing changed: its warm connection stays
        local = fallback = None
        if store.ready():
            if own_local and own is not None:
                local = store.voice(own["id"], speed)
            elif provider == "local":
                local = store.voice(self.local_voice(), speed)
            fallback = store.voice(self.local_voice(), speed)  # when a cloud voice fails
        changed = self._set_local(speaker, local, fallback) or speaker.cloud is not cloud
        if speaker.cloud is not cloud:
            old, speaker.cloud, speaker.cloud_error = speaker.cloud, cloud, ""
            client = getattr(old, "_client", None)
            if client is not None and not client.is_closed:
                self.hub._spawn(client.aclose())
        before = speaker.voice
        speaker.voice = self.mac_voice_for(self.language) or lang.mac_voice(
            self.language, self.hub.settings.voice
        )
        changed = changed or speaker.voice != before
        speaker.fallback_voice = (
            voices.best_fallback(self.mac_voices, self.language, speaker.voice)
            if self.mac_voices
            else ""
        )
        if changed and refresh and self.hub.poll:  # the "One moment." fillers, re-voiced
            self.hub._fillers = []
            self.hub._spawn(self.hub._prepare_fillers())
        return changed

    def local_voice(self) -> str:
        return clean_local(self._pref("voice_local")) or local_voice.DEFAULT_VOICE

    @staticmethod
    def _set_local(speaker: Speaker, local: Any, fallback: Any) -> bool:
        """The offline voice, kept (model and all) when nothing about it changed. True
        when the voice speaking changed."""
        before = getattr(speaker, "local", None)
        before_fallback = getattr(speaker, "local_fallback", None)
        if local is not None and local.same(before):
            local = before
        if fallback is not None and fallback.same(before_fallback):
            fallback = before_fallback
        if local is not before or fallback is not before_fallback:
            speaker._local_told = False  # set up anew: a failure is said again
        speaker.local, speaker.local_fallback = local, fallback
        return local is not before

    async def warm_local(self) -> None:
        """Load the offline voice's model now, not on the first reply (the app only)."""
        speaker = self.hub.speaker
        local = getattr(speaker, "local", None) or getattr(speaker, "local_fallback", None)
        if local is None:
            return
        try:
            await asyncio.to_thread(local.engine.load, local.voice)
        except Exception as exc:  # said when it's first used (Speaker._local_pcm)
            log.warning("offline voice didn't load: %s", exc)

    async def setup(self) -> None:
        """At startup (the app only): list the Mac's voices, then speak as Settings say."""
        self.mac_voices = await asyncio.to_thread(voices.list_mac_voices)
        await self.apply()
        await self.warm_local()

    def change(self, changes: dict[str, Any]) -> bool:
        """The pane's changes to the voice; True when any was taken."""
        provider = self.provider()
        wanted: dict[str, Any] = {}
        if "voice_provider" in changes and clean_provider(changes["voice_provider"]) is not None:
            wanted["voice_provider"] = changes["voice_provider"]
            provider = changes["voice_provider"] or provider
        if isinstance(changes.get("voice_mac"), str):
            mine = dict(self._pref("voice_mac") or {})
            mine["zh" if lang.is_zh(self.language) else "en"] = changes["voice_mac"]
            wanted["voice_mac"] = mine
        if provider in CLOUD and "voice_cloud" in changes:
            voice = _clean_voice(changes["voice_cloud"])
            if voice is None:
                self.error = "That doesn't look like a voice id (letters, digits, - and _)."
            else:
                wanted["voice_cloud"] = {**(self._pref("voice_cloud") or {}), provider: voice}
        if provider in CLOUD and isinstance(changes.get("voice_model"), str):
            model = changes["voice_model"].strip()
            models = {p: m for p, m in (self._pref("voice_models") or {}).items() if p != provider}
            if model and not _MODEL.fullmatch(model):
                self.error = "That doesn't look like a model id."
            else:
                wanted["voice_models"] = {**models, **({provider: model} if model else {})}
        if "voice_local" in changes and clean_local(changes["voice_local"]) is not None:
            wanted["voice_local"] = changes["voice_local"]
        if "voice_speed" in changes and clean_speed(changes["voice_speed"]) is not None:
            wanted["voice_speed"] = changes["voice_speed"]
        if wanted:
            self.hub.set_feature_prefs(wanted)
        return bool(wanted)

    # ── the pane's buttons ──

    async def list(self, provider: str) -> None:
        """List a provider's voices: the Mac's, or the account's with its key."""
        if provider == "say":
            self.mac_voices = await asyncio.to_thread(voices.list_mac_voices)
            await self.apply(refresh=False)
            return
        if provider not in CLOUD:
            return
        key = await self._key(provider)
        if not key:
            self.error = f"Paste your {PROVIDER_NAMES[provider]} API key first."
            return
        import httpx

        try:
            async with httpx.AsyncClient() as client:
                self.cloud_voices[provider] = await voices.list_cloud_voices(client, provider, key)
        except ValueError as exc:
            self.error = str(exc)
        except httpx.HTTPError:
            self.error = f"I couldn't reach {PROVIDER_NAMES[provider]}. Check the connection."

    async def preview(self, provider: str, voice: Any) -> None:
        """Say the preview sentence in a voice (the one picked, or `voice`)."""
        speaker = self.hub.speaker
        if getattr(speaker, "muted", False):
            self.error = "Spoken replies are off: turn them on to hear a preview."
            return
        provider = provider if provider in PROVIDERS else self.provider()
        text = lang.tr(PREVIEW, self.language)
        try:
            if provider == "say":
                name = voice if isinstance(voice, str) and voice else speaker.voice
                if self.mac_voices is None:
                    self.mac_voices = await asyncio.to_thread(voices.list_mac_voices)
                if voices.find(self.mac_voices, name) is None:
                    self.error = "That voice isn't installed on this Mac."
                    return
                audio, rate = await mac_audio(text, name, getattr(speaker, "rate", 190))
            elif provider == "jarvis":
                cloud = await self.jarvis_voice(self.speed() / 100)
                try:
                    audio, rate = await cloud.synthesize(text)
                finally:
                    if cloud._client is not None:
                        with contextlib.suppress(Exception):
                            await cloud._client.aclose()
            elif provider == "local":
                audio, rate = await self._local_preview(text, voice)
                if audio is None:
                    return
            else:
                key = await self._key(provider)
                voice_id = voice if isinstance(voice, str) and voice else ""
                voice_id = voice_id or self.cloud_voice(provider)["id"]
                if not key or not _VOICE_ID.fullmatch(voice_id or ""):
                    self.error = f"{PROVIDER_NAMES[provider]} needs an API key and a voice first."
                    return
                cloud = CloudVoice(
                    provider, key, voice_id, self.model(provider), self.speed() / 100
                )
                try:
                    audio, rate = await cloud.synthesize(text)
                finally:
                    if cloud._client is not None:
                        with contextlib.suppress(Exception):
                            await cloud._client.aclose()
            await speaker.play(audio, rate)
        except ValueError as exc:
            self.error = str(exc)
        except Exception as exc:  # the service said no (a bad key, no credit), offline
            log.warning("voice preview failed: %s", type(exc).__name__)
            self.error = (
                "The preview didn't play: the voice service turned it down or is unreachable."
            )

    async def _local_preview(self, text: str, voice: Any) -> tuple[Any, int]:
        store = local_voice.store_for(self.hub)
        if not store.ready():
            self.error = "Download JARVIS’s offline voice first."
            return None, 0
        picked = clean_local(voice) or self.local_voice()
        local = store.voice(picked, self.speed() / 100)
        if not local.speaks(text):  # the preview in Chinese: the Mac voice says it
            self.error = "JARVIS’s offline voice speaks English; Chinese uses the Mac voice."
            return None, 0
        parts = [audio async for kind, audio in local.pieces(text) if kind == "audio"]
        if not parts or local.engine.error:
            self.error = "JARVIS’s offline voice couldn’t load. Download it again."
            return None, 0
        return np.concatenate(parts), local_voice.LOCAL_RATE

    # ── what the pane shows ──

    def public(self) -> dict[str, Any]:
        speaker = self.hub.speaker
        provider = self.provider()
        hints = self._pref("voice_key_hints") or {}
        mine = voices.for_language(self.mac_voices, self.language) if self.mac_voices else None
        clouds = {}
        for p in CLOUD:
            env = self._env(p)
            clouds[p] = {
                "voice": self.cloud_voice(p),
                "voice_from_env": not (self._pref("voice_cloud") or {}).get(p)
                and bool(env["voice"]),
                "model": self.model(p),
                "models": MODELS[p],
                "key": hints.get(p, ""),
                "env_key": bool(env["key"]),
                "voices": self.cloud_voices.get(p),
            }
        return {
            "provider": provider,
            "provider_set": bool(self._pref("voice_provider")),
            "env_provider": (
                self.hub.settings.tts if getattr(self.hub.settings, "tts_set", False) else "jarvis"
            ),
            # the JARVIS voice on the owner's own Fish key (unlimited), else askeden.com's
            "jarvis_own_key": getattr(getattr(speaker, "cloud", None), "provider", "") == "fish"
            and getattr(getattr(speaker, "cloud", None), "voice_id", "") == JARVIS_VOICE_ID,
            "mac_voice": getattr(speaker, "voice", ""),
            "mac_voices": [v.public() for v in mine] if mine is not None else None,
            "fallback_voice": getattr(speaker, "fallback_voice", ""),
            "clouds": clouds,
            "speed": self.speed(),
            "cloud_on": getattr(speaker, "cloud", None) is not None,
            "cloud_error": getattr(speaker, "cloud_error", ""),
            "local": {
                **local_voice.store_for(self.hub).public(),
                "voice": self.local_voice(),
                "on": getattr(speaker, "local", None) is not None,
                "fallback": getattr(speaker, "local_fallback", None) is not None,
            },
            "speaking_error": self.error,
            "busy": self.busy,
        }
