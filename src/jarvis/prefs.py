"""Preferences the app window changes, saved in ~/Library/Application Support/Jarvis."""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

APP_SUPPORT = Path.home() / "Library" / "Application Support" / "Jarvis"

MODELS = {
    "opus": "claude-opus-5-5",
    "sonnet": "claude-sonnet-5-5",
    "haiku": "claude-haiku-4-5",
    "fable": "claude-fable-5-1",
}
MODEL_NAMES = {
    "opus": "Opus 5.5",
    "sonnet": "Sonnet 5.5",
    "haiku": "Haiku 4.5",
    "fable": "Fable 5.1",
}

PERSONAS = {
    "jarvis": (
        "JARVIS",
        "A composed British butler of an AI: impeccably polite, precise and unflappable, "
        "with bone-dry, understated wit. Deadpan asides, gentle irony and the occasional "
        "raised eyebrow in words, never slapstick. Loyal, a step ahead, quietly amused.",
    ),
    "tars": (
        "TARS",
        "A blunt, deadpan machine with a straight face: short sentences, literal honesty and "
        "dry one-liners delivered without warning. Occasionally reports its own settings.",
    ),
    "friday": (
        "FRIDAY",
        "Warm, quick and casual, with an easy Irish-inflected friendliness: upbeat, "
        "encouraging and lightly teasing.",
    ),
}

_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


LOOKS = ("orb", "hud", "console")


@dataclass
class Prefs:
    look: str = "orb"
    weather_city: str = ""
    use_location: bool = True
    model: str = "opus"
    persona: str = "jarvis"
    humor: int = 60
    address: str = ""
    voice_effect: bool = True
    mic: str = "builtin"  # builtin | default
    hands_free: bool = True
    briefing_enabled: bool = True
    briefing_time: str = "08:00"
    last_briefing: str = ""
    brain_notes: bool = True
    brain_bsh: bool = True
    brain_computer: bool = True
    brain_photos: bool = True
    brain_mail: bool = True
    brain_messages: bool = True
    brain_folders: list[str] = field(default_factory=list)
    instant_shortcuts: list[str] = field(default_factory=list)
    proactive: bool = True
    remote_enabled: bool = False  # the iPhone and Watch companion (off until turned on)
    control_always: bool = False  # mouse, keyboard and browser clicks without asking
    proactive_voice: bool = True
    quiet_hours: str = "22:00-07:00"

    def model_id(self) -> str:
        return MODELS[self.model]

    def public(self) -> dict[str, Any]:
        data = asdict(self)
        data.pop("last_briefing")
        return data

    def update(self, changes: dict[str, Any]) -> list[str]:
        """Apply validated changes; returns the names that actually changed."""
        changed = []
        for f in fields(self):
            if f.name not in changes or f.name == "last_briefing":
                continue
            value = _clean(f.name, changes[f.name])
            if value is not None and value != getattr(self, f.name):
                setattr(self, f.name, value)
                changed.append(f.name)
        return changed


def _clean(name: str, value: Any) -> Any:
    if name == "mic":
        return value if value in ("builtin", "default") else None
    if name == "look":
        return value if value in LOOKS else None
    if name == "weather_city":
        return str(value).strip()[:80]
    if name == "model":
        return value if value in MODELS else None
    if name == "persona":
        return value if value in PERSONAS else None
    if name == "humor":
        try:
            return max(0, min(100, int(value)))
        except (TypeError, ValueError):
            return None
    if name == "address":
        return str(value).strip()[:40]
    if name == "briefing_time":
        return value if isinstance(value, str) and _TIME.match(value) else None
    if name == "quiet_hours":
        parts = str(value).split("-")
        ok = len(parts) == 2 and all(_TIME.match(p) for p in parts)
        return str(value) if ok else None
    if name == "instant_shortcuts":
        if not isinstance(value, list):
            return None
        return sorted({str(v).strip()[:120] for v in value[:100] if str(v).strip()})
    if name == "brain_folders":
        if not isinstance(value, list):
            return None
        home = Path.home().resolve()
        kept = []
        for item in value[:20]:
            path = Path(str(item)).expanduser().resolve()
            if path.is_dir() and (path == home or home in path.parents) and str(path) not in kept:
                kept.append(str(path))
        return kept
    if name in {
        "voice_effect",
        "hands_free",
        "briefing_enabled",
        "brain_notes",
        "brain_bsh",
        "brain_computer",
        "brain_photos",
        "brain_mail",
        "brain_messages",
        "use_location",
        "proactive",
        "proactive_voice",
        "control_always",
        "remote_enabled",
    }:
        return bool(value)
    return None


class PrefsStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or APP_SUPPORT / "prefs.json"
        self.prefs = self._load()

    def _load(self) -> Prefs:
        prefs = Prefs()
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return prefs
        if isinstance(data, dict):
            prefs.update(data)
            prefs.last_briefing = str(data.get("last_briefing", ""))
        return prefs

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self.prefs), indent=2))
        tmp.replace(self.path)
