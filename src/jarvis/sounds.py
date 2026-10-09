"""The short sounds JARVIS makes on its own: the chime before a heads-up and when it starts
listening for an answer, the timer and the alarm.

macOS has them as system sounds. Windows has no such files, so they are made here (a few
sine tones with a soft attack and release, written once as WAV files in the app's folder) and
played with winsound. Nothing here ever raises: a sound that can't play is just not heard.
"""

from __future__ import annotations

import logging
import math
import struct
import subprocess
import wave

from . import osplat

log = logging.getLogger("jarvis")

MAC = {
    "chime": "/System/Library/Sounds/Tink.aiff",
    "timer": "/System/Library/Sounds/Glass.aiff",
    "alarm": "/System/Library/Sounds/Sosumi.aiff",
}

RATE = 22050
# name -> [(frequency Hz, seconds)] ; 0 Hz is a rest. Played one after the other.
TONES = {
    "chime": [(1568.0, 0.07), (2093.0, 0.12)],
    "timer": [(880.0, 0.12), (1175.0, 0.12), (1568.0, 0.22)],
    "alarm": [
        (988.0, 0.16),
        (0.0, 0.06),
        (988.0, 0.16),
        (0.0, 0.06),
        (988.0, 0.16),
        (0.0, 0.06),
        (1319.0, 0.3),
    ],
}


def _wave(tones: list[tuple[float, float]], volume: float = 0.5) -> bytes:
    frames = bytearray()
    for freq, seconds in tones:
        n = int(RATE * seconds)
        for i in range(n):
            if freq <= 0:
                frames += struct.pack("<h", 0)
                continue
            edge = min(1.0, i / (RATE * 0.008), (n - i) / (RATE * 0.03))  # soft attack and release
            frames += struct.pack(
                "<h", int(32767 * volume * edge * math.sin(2 * math.pi * freq * i / RATE))
            )
    return bytes(frames)


def path_of(name: str) -> str:
    """A sound file for `name` (chime, timer, alarm); "" where there is none."""
    if not osplat.IS_WIN:
        return MAC.get(name, "")
    target = osplat.app_support() / "sounds" / f"{name}.wav"
    if not target.exists() and name in TONES:
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with wave.open(str(target), "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(RATE)
                out.writeframes(_wave(TONES[name]))
        except OSError as exc:
            log.warning("couldn't make the %s sound (%s)", name, exc)
            return ""
    return str(target) if target.exists() else ""


def play(sound: str) -> None:
    """One sound, not waited for. `sound` is a name (chime…) or a file; nothing to play
    (no such file, no player): nothing."""
    path = path_of(sound) if sound in MAC else sound
    if not path:
        return
    try:
        if osplat.IS_WIN:
            import winsound

            winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC)
        else:
            subprocess.Popen(  # noqa: S603
                ["afplay", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
    except (OSError, RuntimeError):
        pass
