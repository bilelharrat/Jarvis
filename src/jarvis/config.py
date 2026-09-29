"""Settings, read once from the environment (and a local .env)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

PROJECT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_PROJECTS_DIR = Path.home() / "Investment agent"
DEFAULT_BSH_DIR = DEFAULT_PROJECTS_DIR / "bsh-research-center"


# The SDK's default 1 MB cap on one message from Claude Code is smaller than a
# full-screen screenshot or a long PDF read; going over it killed the whole turn.
MAX_BUFFER = 96 * 1024 * 1024  # one message from the CLI (a big tool result, an echoed attachment)


@dataclass(frozen=True)
class Settings:
    model: str = "claude-opus-5-5"
    effort: str = "low"
    voice: str = "Daniel"
    speech_rate: int = 190
    whisper_model: str = "base.en"
    silence_seconds: float = 0.55
    address: str = ""
    calendar: str = ""
    bsh_dir: Path | None = DEFAULT_BSH_DIR
    projects_dir: Path = DEFAULT_PROJECTS_DIR
    task_effort: str = "high"
    tts: str = "say"  # say | elevenlabs | fish
    tts_api_key: str = ""
    tts_voice_id: str = ""
    tts_model: str = ""


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
        projects_dir=Path(env.get("JARVIS_PROJECTS_DIR", str(DEFAULT_PROJECTS_DIR))).expanduser(),
        task_effort=env.get("JARVIS_TASK_EFFORT", Settings.task_effort),
        **_tts_settings(env),
    )


def _tts_settings(env) -> dict[str, str]:
    provider = env.get("JARVIS_TTS", "say").strip().lower()
    if provider == "elevenlabs":
        return {
            "tts": provider,
            "tts_api_key": env.get("ELEVENLABS_API_KEY", ""),
            "tts_voice_id": env.get("ELEVENLABS_VOICE_ID", ""),
            "tts_model": env.get("ELEVENLABS_MODEL", "eleven_flash_v2_5"),
        }
    if provider == "fish":
        return {
            "tts": provider,
            "tts_api_key": env.get("FISH_AUDIO_API_KEY", ""),
            "tts_voice_id": env.get("FISH_AUDIO_VOICE_ID", ""),
            "tts_model": env.get("FISH_AUDIO_MODEL", "s2.1-pro"),
        }
    return {"tts": "say"}
