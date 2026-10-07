"""The voices Jarvis can speak with: the Mac's own (`say -v ?`, Enhanced and Premium ones
included), and ElevenLabs' or Fish Audio's, listed with the owner's key when they ask.

Also which Mac voice to fall back on when the cloud voice fails: the best Enhanced or
Premium one installed for the language (Settings › Speaking shows it), since the plain
default ("Daniel") sounds much flatter next to a cloud voice.

Cost policy: nothing here calls a model. Listing cloud voices is one request to the
provider's voice list (free), and only when the owner presses "List my voices".
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import asdict, dataclass
from typing import Any

from .lang import is_zh

# The Mac's novelty voices ("Bubbles", "Zarvox"): never offered, never a fallback.
NOVELTY = {
    "albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos", "good news", "jester",
    "organ", "superstar", "trinoids", "whisper", "wobble", "zarvox", "deranged", "hysterical",
    "pipe organ",
}  # fmt: skip
QUALITY_RANK = {"premium": 3, "enhanced": 2, "standard": 1}
MAX_LISTED = 300  # voices a list may hold (a big cloud account has thousands)
LIST_TIMEOUT = 15.0  # seconds for a provider's voice list

_LINE = re.compile(r"^(?P<name>.+?)\s+(?P<locale>[a-z]{2,3}_[A-Z0-9]{2,4})\s+#")
_QUALITY = re.compile(r"\((Enhanced|Premium)\)", re.IGNORECASE)


@dataclass(frozen=True)
class MacVoice:
    name: str  # as `say -v` takes it: "Daniel (English (UK))", "Ava (Premium)"
    family: str  # "Daniel", "Ava"
    locale: str  # "en_GB"
    quality: str  # "standard" | "enhanced" | "premium"

    def public(self) -> dict[str, str]:
        return asdict(self)


def parse_say_voices(text: str) -> list[MacVoice]:
    """`say -v ?`'s lines as voices, each once, the novelty ones left out."""
    found: dict[str, MacVoice] = {}
    for line in (text or "").splitlines()[:2000]:
        m = _LINE.match(line.strip())
        if not m:
            continue
        name = m.group("name").strip()
        quality = _QUALITY.search(name)
        family = name.split(" (")[0].strip()
        if not family or family.lower() in NOVELTY or name in found:
            continue
        found[name] = MacVoice(
            name, family, m.group("locale"), quality.group(1).lower() if quality else "standard"
        )
    return list(found.values())


def list_mac_voices() -> list[MacVoice]:
    """The installed Mac voices (runs `say -v ?`: call it off the event loop)."""
    try:
        out = subprocess.run(
            ["say", "-v", "?"], capture_output=True, text=True, timeout=10, check=False
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return parse_say_voices(out)


def for_language(voices: list[MacVoice], language: str) -> list[MacVoice]:
    """The voices that speak this language: English ones for English, Mandarin (mainland
    first) for Chinese; best first, then by name."""
    zh = is_zh(language)
    mine = [v for v in voices if v.locale.startswith("zh_" if zh else "en_")]
    if zh:
        mine = [v for v in mine if v.locale in ("zh_CN", "zh_TW")]
    mainland_last = (lambda v: v.locale != "zh_CN") if zh else (lambda _v: False)
    return sorted(mine, key=lambda v: (-QUALITY_RANK.get(v.quality, 0), mainland_last(v), v.name))


def best_fallback(voices: list[MacVoice], language: str, current: str) -> str:
    """The Mac voice to speak with when the cloud voice fails: the best Enhanced or
    Premium voice for the language, the current voice's own family first ("Daniel
    (Enhanced)" for Daniel), then its accent (en_GB for Daniel), then Premium over
    Enhanced. The current voice when nothing better is installed."""
    mine = for_language(voices, language)
    now = next((v for v in voices if v.name == current or v.family == current), None)
    better = [v for v in mine if v.quality in ("enhanced", "premium")]
    if not better:
        return current
    family = now.family if now else current.split(" (")[0]
    locale = now.locale if now else ("zh_CN" if is_zh(language) else "en_US")
    best = max(
        better,
        key=lambda v: (v.family == family, v.locale == locale, QUALITY_RANK[v.quality]),
    )
    return best.name


def find(voices: list[MacVoice], name: str) -> MacVoice | None:
    return next((v for v in voices if v.name == name or v.family == name), None)


# ── cloud voices ──


def _clip(text: Any, limit: int = 80) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()[:limit]


async def list_cloud_voices(client: Any, provider: str, key: str) -> list[dict[str, str]]:
    """The provider's voices for this key: [{"id", "name", "about"}]. `client` is an
    httpx.AsyncClient. Raises ValueError with words to show when it can't."""
    if provider == "elevenlabs":
        response = await client.get(
            "https://api.elevenlabs.io/v1/voices",
            headers={"xi-api-key": key},
            timeout=LIST_TIMEOUT,
        )
    elif provider == "fish":
        response = await client.get(
            "https://api.fish.audio/model",
            params={"self": "true", "page_size": 100, "page_number": 1},
            headers={"Authorization": f"Bearer {key}"},
            timeout=LIST_TIMEOUT,
        )
    else:
        raise ValueError("Pick ElevenLabs or Fish Audio first.")
    if response.status_code in (401, 403):
        raise ValueError("The provider didn't accept that key.")
    if response.status_code >= 400:
        raise ValueError(f"The provider answered {response.status_code}; try again later.")
    try:
        data = response.json()
    except ValueError:
        raise ValueError("The provider's answer wasn't a voice list.") from None
    if not isinstance(data, dict):  # a list or a number has no voices to look up
        raise ValueError("The provider's answer wasn't a voice list.")
    items = data.get("voices") if provider == "elevenlabs" else data.get("items")
    if not isinstance(items, list):
        raise ValueError("The provider's answer wasn't a voice list.")
    voices = []
    for item in items[:MAX_LISTED]:
        if not isinstance(item, dict):
            continue
        if provider == "elevenlabs":
            voice_id, name = item.get("voice_id"), item.get("name")
            about = item.get("category") or ""
        else:
            voice_id, name = item.get("_id"), item.get("title")
            languages = item.get("languages")
            about = ", ".join(map(str, languages[:3])) if isinstance(languages, list) else ""
        if isinstance(voice_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", voice_id):
            voices.append(
                {"id": voice_id, "name": _clip(name) or voice_id, "about": _clip(about, 40)}
            )
    return voices
