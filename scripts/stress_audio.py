"""Audio torture test: the hands-free mic stays open while replies start and get cut off
hundreds of times. It's the pattern that crashed PortAudio. Plays silence only.

    uv run python scripts/stress_audio.py
"""

from __future__ import annotations

import asyncio
import random
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jarvis.listen import ContinuousListener  # noqa: E402
from jarvis.speech import Speaker  # noqa: E402


async def main(rounds: int = 300) -> None:
    heard = []
    listener = ContinuousListener(heard.append, None, 0.7)
    listener.start()
    speaker = Speaker.__new__(Speaker)
    speaker.voice, speaker.rate, speaker.muted, speaker.effect = "", 190, False, False
    speaker.cloud, speaker.cloud_error, speaker._proc, speaker._playing, speaker._cut = None, "", None, False, False
    silence = np.zeros(int(22050 * 0.25), dtype=np.float32)
    rng = random.Random(1)
    t0 = time.monotonic()
    for i in range(rounds):
        play = asyncio.create_task(speaker.play(silence, 22050))
        await asyncio.sleep(rng.choice([0, 0.01, 0.05, 0.1, 0.3]))
        if rng.random() < 0.6:
            speaker.stop()  # barge-in mid-reply
        await play
    listener.stop()
    await asyncio.sleep(0.5)
    print(f"{rounds} play/stop rounds with the mic open in {time.monotonic() - t0:.1f}s: no crash; mic thread alive until stop: {listener._thread is not None}")


if __name__ == "__main__":
    asyncio.run(main())
