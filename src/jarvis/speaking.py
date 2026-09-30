"""Settings › Speaking: which voice Jarvis speaks with, chosen in the window.

- Provider: the Mac's own voice, ElevenLabs or Fish Audio. Until the owner picks one here,
  the .env settings (JARVIS_TTS and friends) decide, as before; they're shown as the
  default and never written.
- Voice: a Mac voice for each language (Enhanced and Premium ones included), or a cloud
  voice, listed from the owner's account with their key when they ask, or pasted by id.
- API keys: pasted in the pane, kept in the Keychain (connectors.Vault, entry
  "voice:<provider>" / "api_key"; a MemoryVault in tests), never in a file or .env. The
  window only ever sees the last four characters. A key from .env still works.
- Model, speed, and a preview of the voice picked.
- When the cloud voice fails, the best Enhanced or Premium Mac voice installed for the
  language speaks instead of the plain default (voices.best_fallback).

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

from . import lang, voices
from .providers import clean_key, mask
from .speech import EFFECT_RATE, CloudVoice, Speaker, read_wav

log = logging.getLogger("jarvis")

PROVIDERS = ("say", "elevenlabs", "fish")
CLOUD = ("elevenlabs", "fish")
PROVIDER_NAMES = {"say": "Mac", "elevenlabs": "ElevenLabs", "fish": "Fish Audio"}
# Models offered for each (any other id can be typed).
MODELS = {
    "elevenlabs": ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2", "eleven_v3"],
    "fish": ["s2.1-pro", "s1", "speech-1.6", "speech-1.5"],
}
VAULT_PREFIX = "voice:"
KEY_NAME = "api_key"
SPEED_MIN, SPEED_MAX, SPEED_DEFAULT = 70, 130, 100
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


def clean_muted(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


PREFS = {
    "voice_provider": ("", clean_provider),
    "voice_mac": ({}, clean_mac),
    "voice_cloud": ({}, clean_cloud),
    "voice_models": ({}, clean_models),
    "voice_speed": (SPEED_DEFAULT, clean_speed),
    "voice_muted": (False, clean_muted),
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

    # ── the settings as they are now ──

    def _pref(self, key: str) -> Any:
        return self.hub.prefs.feature(key)

    @property
    def language(self) -> str:
        return getattr(self.hub.prefs, "language", "en")

    def provider(self) -> str:
        """The provider speaking: the pane's pick, else .env's."""
        chosen = self._pref("voice_provider")
        env = getattr(self.hub.settings, "tts", "say")
        return chosen or (env if env in PROVIDERS else "say")

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

    def mac_voice_for(self, language: str) -> str:
        """The Mac voice picked for a language ("" for the default), while it's installed.
        The hub asks as it sets the voice for a language (at start and when the language
        changes), so the fallback voice moves to that language's best one here too."""
        name = (self._pref("voice_mac") or {}).get("zh" if lang.is_zh(language) else "en", "")
        if name and self.mac_voices is not None and voices.find(self.mac_voices, name) is None:
            name = ""  # uninstalled since: the default speaks
        speaker = self.hub.speaker
        if self.mac_voices and isinstance(speaker, Speaker):
            speaking = name or lang.mac_voice(language, self.hub.settings.voice)
            speaker.fallback_voice = voices.best_fallback(self.mac_voices, language, speaking)
        return name

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
        provider, speed = self.provider(), self.speed() / 100
        speaker.rate = max(80, min(400, round(self.hub.settings.speech_rate * speed)))
        cloud = None
        if provider in CLOUD:
            key, voice = await self._key(provider), self.cloud_voice(provider)["id"]
            if key and voice:
                cloud = CloudVoice(provider, key, voice, self.model(provider), speed)
                if _same(speaker.cloud, cloud):
                    cloud = speaker.cloud  # nothing changed: its warm connection stays
        changed = speaker.cloud is not cloud
        if changed:
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

    async def setup(self) -> None:
        """At startup (the app only): list the Mac's voices, then speak as Settings say."""
        self.mac_voices = await asyncio.to_thread(voices.list_mac_voices)
        await self.apply()

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
            "env_provider": getattr(self.hub.settings, "tts", "say"),
            "mac_voice": getattr(speaker, "voice", ""),
            "mac_voices": [v.public() for v in mine] if mine is not None else None,
            "fallback_voice": getattr(speaker, "fallback_voice", ""),
            "clouds": clouds,
            "speed": self.speed(),
            "cloud_on": getattr(speaker, "cloud", None) is not None,
            "cloud_error": getattr(speaker, "cloud_error", ""),
            "speaking_error": self.error,
            "busy": self.busy,
        }
