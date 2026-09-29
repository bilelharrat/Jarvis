"""Settings, read once from the environment (and a local .env)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

PROJECT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_BSH_DIR = Path.home() / "Investment agent" / "bsh-research-center"


@dataclass(frozen=True)
class Settings:
    model: str = "claude-opus-5-5"
    effort: str = "low"
    voice: str = "Daniel"
    speech_rate: int = 190
    whisper_model: str = "base.en"
    silence_seconds: float = 1.2
    address: str = ""
    calendar: str = ""
    bsh_dir: Path | None = DEFAULT_BSH_DIR


def load_settings(env_file: Path | None = None) -> Settings:
    load_dotenv(env_file or PROJECT_DIR / ".env")
    env = os.environ
    bsh = env.get("JARVIS_BSH_DIR", str(DEFAULT_BSH_DIR)).strip()
    return Settings(
        model=env.get("JARVIS_MODEL", Settings.model),
        effort=env.get("JARVIS_EFFORT", Settings.effort),
        voice=env.get("JARVIS_VOICE", Settings.voice),
        speech_rate=int(env.get("JARVIS_SPEECH_RATE", Settings.speech_rate)),
        whisper_model=env.get("JARVIS_WHISPER_MODEL", Settings.whisper_model),
        silence_seconds=float(env.get("JARVIS_SILENCE_SECONDS", Settings.silence_seconds)),
        address=env.get("JARVIS_ADDRESS", "").strip(),
        calendar=env.get("JARVIS_CALENDAR", "").strip(),
        # An empty JARVIS_BSH_DIR turns the research-desk tools off.
        bsh_dir=Path(bsh).expanduser() if bsh else None,
    )
